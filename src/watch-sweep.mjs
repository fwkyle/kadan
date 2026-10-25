// Why: 감시가 RAM에 이어 붙인 원장 배열이 처음부터 다시 만든 배열과 같은지 가끔 확인한다. 증분 상태의 안전망이다.
// 비교는 사건을 쌓지 않는다: 들고 있는 배열은 조각으로 지문을 만들고, 원본은 조각씩 흘려 읽어 같은 지문을 만든다.
// 원장 사건만 본다. tmux·PID·화면은 읽지 않는다. 사이마다 이벤트 루프에 양보해 감시 한 바퀴를 막지 않는다.
import {createHash} from 'node:crypto';

const yieldLoop = () => new Promise(resolve => setImmediate(resolve));

export function createLedgerArraySweep({access, chunkRows = 2000, yieldNow = yieldLoop}) {
  async function digestArray(entries) {
    const hash = createHash('sha256');
    for (let index = 0; index < entries.length; index += chunkRows) {
      for (const entry of entries.slice(index, index + chunkRows)) hash.update(JSON.stringify(entry)).update('\n');
      await yieldNow();
    }
    return {digest: hash.digest('hex'), count: entries.length};
  }
  async function digestSource(upTo, generation) {
    // 처음부터 새 투영기: 증분 읽기가 쌓은 투영기 상태(첫 완료 판정 등)와 독립이다.
    const projector = access.newProjector();
    const hash = createHash('sha256');
    let after = 0, count = 0, skipped = 0;
    while (true) {
      const chunk = access.readChunk(after, upTo, projector, chunkRows);
      if (!chunk.rows) break;
      for (const entry of chunk.entries) hash.update(JSON.stringify(entry)).update('\n');
      count += chunk.entries.length;skipped += chunk.skipped;after = chunk.last;
      await yieldNow();
      if (access.info().generation !== generation) return null;   // 읽는 도중 원본 세대가 바뀜
    }
    return {digest: hash.digest('hex'), count, skipped};
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
      return {items, mismatches: items.filter(item => item.incremental !== item.sql)};
    },
    // 전체 대조. 결과: match | diff(교체 가능) | moved(비교 중 바뀜) | error(구분 불가).
    async full() {
      let snapshot;
      try {
        snapshot = access.peek();
        if (!snapshot) return {status: 'match', diffs: [], note: '증분 상태 없음'};
        const before = access.info();
        const [array, source] = [await digestArray(snapshot.entries), await digestSource(snapshot.position, snapshot.generation)];
        if (source === null) return {status: 'moved', position: snapshot.position};
        const after = access.info();
        if (after.generation !== snapshot.generation) return {status: 'moved', position: after.position};
        const same = array.digest === source.digest && array.count === source.count &&
          snapshot.skipped === source.skipped;
        if (same) return {status: 'match', diffs: [], position: snapshot.position, count: array.count};
        // 비교 중 적용 위치가 바뀌면 교체하지 않고 다음 기회에 같은 방식으로 다시 본다.
        if (after.position !== before.position || access.peek()?.entries !== snapshot.entries) {
          return {status: 'moved', position: after.position};
        }
        const fingerprint = createHash('sha256').update(`${array.digest}|${source.digest}`).digest('hex').slice(0, 12);
        return {status: 'diff', position: snapshot.position, diffs: [{key: 'ledger-array', fingerprint,
          detail: `배열 ${array.count}건(제외 ${snapshot.skipped}) / 처음부터 ${source.count}건(제외 ${source.skipped})`}]};
      } catch (error) {
        return {status: 'error', error: error?.message ?? String(error), errorKey: 'ledger-source', diffs: []};
      }
    },
  };
}
