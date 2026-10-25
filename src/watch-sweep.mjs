// Why: 감시가 RAM에 이어 붙인 상태가 처음부터 다시 만든 상태와 같은지 가끔 확인한다. 증분 상태의 안전망이다.
// 대상 둘: (1) 원장 배열 (2) 역할·발령 상태표(watch_role_*). 사건을 쌓지 않는다: 들고 있는 배열은 조각으로 지문을 만들고,
// 원본은 하나의 고정 읽기 snapshot에서 조각씩 흘려 읽어 같은 지문을 만든다. 상태표는 정식 reducer를 임시 DB에 처음부터 적용한 지문과 비교한다.
// 원장 사건만 본다. tmux·PID·화면은 읽지 않는다. 사이마다 이벤트 루프에 양보해 감시 한 바퀴를 막지 않는다.
import {createHash} from 'node:crypto';

const yieldLoop = () => new Promise(resolve => setImmediate(resolve));
export const ARRAY_KEY = 'ledger-array';
export const ROLE_STATE_KEY = 'role-state';

export function createLedgerArraySweep({access, chunkRows = 500, yieldNow = yieldLoop}) {
  async function digestArray(entries) {
    const hash = createHash('sha256');
    for (let index = 0; index < entries.length; index += chunkRows) {
      for (const entry of entries.slice(index, index + chunkRows)) hash.update(JSON.stringify(entry)).update('\n');
      await yieldNow();
    }
    return {digest: hash.digest('hex'), count: entries.length};
  }
  async function digestSource(upTo, generation, snapshot) {
    // 처음부터 새 투영기: 증분 읽기가 쌓은 투영기 상태(첫 완료 판정 등)와 독립이다.
    const projector = access.newProjector();
    const hash = createHash('sha256');
    let after = 0, count = 0, skipped = 0;
    while (true) {
      const chunk = snapshot.readChunk(after, upTo, projector, chunkRows);
      if (!chunk.rows) break;
      for (const entry of chunk.entries) hash.update(JSON.stringify(entry)).update('\n');
      count += chunk.entries.length;skipped += chunk.skipped;after = chunk.last;
      await yieldNow();
      if (access.info().generation !== generation) return null;   // 읽는 도중 원본 세대가 바뀜
    }
    return {digest: hash.digest('hex'), count, skipped};
  }

  // 원장 배열 대조. 결과: match | diff | moved | error.
  async function ledgerArray() {
    const snapshot = access.peek();
    if (!snapshot) return {status: 'match', diffs: [], note: '증분 상태 없음'};
    const array = await digestArray(snapshot.entries);
    // 원본은 하나의 고정 snapshot에서만 읽는다. 같은 prefix를 보장하지 못하면 교체하지 않는다.
    const pinned = access.openSnapshot();
    if (pinned === null) return {status: 'match', diffs: [], note: '저장소 없음'};
    let source;
    try { source = await digestSource(snapshot.position, snapshot.generation, pinned); }
    finally { pinned.close(); }
    if (source === null) return {status: 'moved', position: snapshot.position};
    const after = access.info();
    if (after.generation !== snapshot.generation) return {status: 'moved', position: after.position};
    const evidence = {position: snapshot.position, generation: snapshot.generation, arrayDigest: array.digest,
      sourceDigest: source.digest, arrayCount: array.count, sourceCount: source.count};
    if (array.digest === source.digest && array.count === source.count && snapshot.skipped === source.skipped) {
      return {status: 'match', diffs: [], count: array.count, ...evidence};
    }
    // 비교는 고정 prefix(snapshot.position)와 고정 읽기 snapshot에서 했으므로, 그 사이 새 사건이 붙어도 비교는 유효하다.
    const fingerprint = createHash('sha256').update(`${array.digest}|${source.digest}`).digest('hex').slice(0, 12);
    return {status: 'diff', ...evidence, diffs: [{key: ARRAY_KEY, fingerprint,
      detail: `배열 ${array.count}건(제외 ${snapshot.skipped}) / 처음부터 ${source.count}건(제외 ${source.skipped})`}]};
  }

  // 역할·발령 상태표 대조(독립검수 F7). 현재 상태표 지문 vs 정식 reducer를 처음부터 적용한 지문, 같은 위치·세대·카드 주소로 비교한다.
  async function roleState() {
    if (!access.roleState) return {status: 'match', diffs: [], note: '상태표 접근 없음'};
    const live = access.roleState.live();
    if (!live) return {status: 'match', diffs: [], note: '상태표 없음'};
    const replayed = await access.roleState.replay({upTo: live.position, generation: live.generation, cards: live.cards, yieldNow});
    if (!replayed) return {status: 'error', error: '역할 상태 재생 결과 없음', errorKey: ROLE_STATE_KEY, diffs: []};
    const again = access.roleState.live();
    if (!again || again.generation !== live.generation) return {status: 'moved', position: live.position};
    const evidence = {roleStatePosition: live.position, roleStateDigest: live.digest, roleStateReplayDigest: replayed.digest};
    if (live.digest === replayed.digest) return {status: 'match', diffs: [], ...evidence};
    // 비교 동안 카드 주소 목록이 바뀌면 같은 입력이 아니다. 교체하지 않고 다음 기회에 다시 본다.
    if (again.cardsKey !== live.cardsKey) return {status: 'moved', position: live.position};
    const fingerprint = createHash('sha256').update(`${live.digest}|${replayed.digest}`).digest('hex').slice(0, 12);
    return {status: 'diff', ...evidence, diffs: [{key: ROLE_STATE_KEY, fingerprint,
      detail: `역할·발령 상태표 지문이 처음부터 다시 적용한 값과 다름(위치 ${live.position})`}]};
  }

  // 같은 pass 결과 모양으로 합친다: error > moved > diff > match. diff는 키별로 모두 담는다.
  function merge(results) {
    const diffs = results.flatMap(result => result.diffs ?? []);
    const first = status => results.find(result => result.status === status);
    const status = first('error') ? 'error' : first('moved') ? 'moved' : diffs.length ? 'diff' : 'match';
    return {...Object.assign({}, ...results), status, diffs,
      ...(status === 'error' ? {error: first('error').error, errorKey: first('error').errorKey} : {})};
  }

  return {
    // 매 바퀴 호출해도 되는 가벼운 대조. 이름 붙인 불변식 목록을 돌려준다(불일치만 mismatches).
    light() {
      const snapshot = access.peek(), info = access.info(), total = access.total();
      const items = [];
      if (snapshot && snapshot.position === info.position) {
        items.push({name: '배열 건수 대 원본 총건수', incremental: snapshot.entries.length + snapshot.skipped, sql: total});
      }
      const streams = access.streamCursors();
      for (const [stream, cursor] of Object.entries(streams.cursor)) {
        items.push({name: `커서 대 최대 순번 ${stream}`, incremental: cursor, sql: streams.max[stream] ?? 0});
      }
      const open = access.openCards?.();
      if (open) items.push({name: '열린 카드 수 대 카드 끝 사건 상태 수', incremental: open.incremental, sql: open.sql});
      // 상태 행 유실을 잡는 저렴한 수 대조: 기록된 계수 대 실제 행 수(규칙을 다시 쓰지 않는다).
      const counts = access.roleState?.counts();
      if (counts) {
        items.push({name: '역할 상태표 세션 수 대 기록', incremental: counts.metaSessions, sql: counts.sessions});
        items.push({name: '역할 상태표 발령 수 대 기록', incremental: counts.metaDispatches, sql: counts.dispatches});
      }
      return {items, mismatches: items.filter(item => item.incremental !== item.sql)};
    },
    // 전체 대조. 결과: match | diff(교체 가능) | moved(비교 중 바뀜) | error(구분 불가).
    async full() {
      const results = [];
      for (const check of [ledgerArray, roleState]) {
        try { results.push(await check()); }
        catch (error) {
          results.push({status: 'error', error: error?.message ?? String(error),
            errorKey: check === roleState ? ROLE_STATE_KEY : 'ledger-source', diffs: []});
        }
      }
      return merge(results);
    },
  };
}
