// Why: 감시가 RAM에 이어 붙인 상태가 처음부터 다시 만든 상태와 같은지 가끔 확인한다. 증분 상태의 안전망이다.
// 원장 배열과 감시 투영·완료·우편·역할·업무 상태를 비교한다. 원본을 고정된 읽기 시점에서 읽고,
// 기존 감시 투영을 공유하지 않는 임시 메모리 DB에 정식 reducer를 처음부터 적용한다.
// 원장 사건만 본다. tmux·PID·화면은 읽지 않는다. 사이마다 이벤트 루프에 양보해 감시 한 바퀴를 막지 않는다.
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase, databaseIdentity} from './storage.mjs';
import {domainProjector, createUniqueDone, completionTaskShortId} from './ledger-domains.mjs';
import {sourceViewValues} from './ledger-view.mjs';
import {isWatchRoutine} from './ledger-table.mjs';
import {isMailTransfer} from './mail-routing.mjs';
import {mailboxView} from './mail-view.mjs';
import {applyWatchRoleState} from './watch-role-state.mjs';
import {applyWatchWorkState} from './watch-work-state.mjs';

const yieldLoop = () => new Promise(resolve => setImmediate(resolve));
export const ARRAY_KEY = 'ledger-array';
export const ROLE_STATE_KEY = 'role-state';
export const WATCH_STATE_KEYS = ['projection-state', 'completion-state', 'mail-state', ROLE_STATE_KEY, 'work-state'];

export function resetWatchSweep(reader, keys) {
  if (keys.includes(ARRAY_KEY)) reader.resetIncremental();
  if (keys.some(key => WATCH_STATE_KEYS.includes(key) && key !== ROLE_STATE_KEY)) {
    reader.sweepAccess.states.reset();
  } else if (keys.includes(ROLE_STATE_KEY)) reader.sweepAccess.roleState.reset();
}

const addresses = cards => JSON.stringify(cards.map(card => ({key: card.key, id: card.id})));
const metadata = (db, table, where = 'id=1') => {
  const row = db.prepare(`SELECT value FROM ${table} WHERE ${where}`).get();
  return row ? JSON.parse(row.value) : null;
};
const baseInfo = db => Object.fromEntries(db.prepare(
  "SELECT key,value FROM meta WHERE key IN ('generation','position')",
).all().map(row => [row.key, row.key === 'position' ? Number(row.value) : row.value]));

// 두 읽기 연결을 pass가 끝날 때까지 고정한다. 현재 투영/하위 reducer를 먼저 실행하지 않는다.
export function openWatchStateSnapshot(home, file, readCards) {
  const cards = readCards();
  if (!Array.isArray(cards)) return null;
  const sourceIdentity = databaseIdentity(home);
  const db = new DatabaseSync(file, {readOnly: true});
  let source;
  const close = () => {
    try { source?.close(); } finally { db.close(); }
  };
  try {
    db.exec('BEGIN');
    const base = baseInfo(db);
    const projection = metadata(db, 'watch_mail_projection');
    if (!projection) throw new Error('감시 투영 메타가 없어 전체 대조를 확정할 수 없습니다');
    if (!Number.isSafeInteger(projection.position) || projection.position < 0 ||
        projection.position > base.position) throw new Error('감시 투영 대조 위치가 손상됐습니다');
    // 원문 캐시는 다음 순회의 사건까지 앞서 있을 수 있다. 비교 prefix는 감시 투영의 적용 위치다.
    const info = {...base, position: projection.position};
    source = openDatabase(home, {readOnly: true});
    source.exec('BEGIN');source.prepare('SELECT 1 FROM events LIMIT 1').get();
    const cardsKey = addresses(cards), revision = projection.revision;
    const signature = createHash('sha256').update(cardsKey).digest('hex');
    return {
      db, source, info, cards: cards.map(card => ({key: card.key, id: card.id})), close,
      // 새 사건은 같은 prefix의 비교를 무효로 하지 않는다. 주소/세대/투영 교체는 무효다.
      current() {
        if (addresses(readCards()) !== cardsKey || projection.signature !== signature ||
            projection.generation !== base.generation || databaseIdentity(home) !== sourceIdentity) return false;
        const current = new DatabaseSync(file, {readOnly: true});
        try {
          current.exec('BEGIN');
          return baseInfo(current).generation === info.generation &&
            metadata(current, 'watch_mail_projection')?.revision === revision;
        } finally { current.close(); }
      },
    };
  } catch (error) { close();throw error; }
}

const stateGroups = [
  {key: 'projection-state', tables: ["views WHERE domain='watch'"],
    meta: 'watch_mail_projection', fields: ['version', 'signature', 'position', 'count']},
  {key: 'completion-state', tables: ['watch_mail_completions'],
    meta: 'watch_mail_projection', fields: ['completed']},
  {key: 'mail-state', tables: ['mail_current', 'mail_refs', 'mail_ids', 'mail_sender_roles',
    'mail_transfers', 'mail_reminders', 'mail_done_refs', 'mail_generation', 'mail_cards', 'mail_role_counts']
    .map(table => `${table} WHERE domain='watch'`), meta: 'mail_view_meta', where: "domain='watch'",
    fields: ['version', 'actors', 'position', 'count', 'stateVersion']},
  {key: ROLE_STATE_KEY, tables: ['watch_role_sessions', 'watch_role_dispatches'],
    meta: 'watch_role_meta', fields: ['version', 'position', 'stateVersion', 'sessionCount',
      'dispatchCount', 'nextRank', 'legacyRequired']},
  {key: 'work-state', tables: ['watch_work_last', 'watch_work_sent', 'watch_work_transfers'],
    meta: 'watch_work_meta', fields: ['version', 'position', 'stateVersion', 'lastCount',
      'sentCount', 'transferCount', 'legacyRequired']},
];

async function stateDigests(db, chunkRows, yieldNow) {
  const result = {};
  for (const group of stateGroups) {
    const hash = createHash('sha256'), meta = metadata(db, group.meta, group.where);
    hash.update(JSON.stringify(group.fields.map(field => meta?.[field])));
    let count = 0, chunk = 0;
    for (const table of group.tables) {
      hash.update(table);
      const name = table.split(' ')[0];
      const order = db.prepare(`PRAGMA table_info(${name})`).all().filter(col => col.pk)
        .sort((a, b) => a.pk - b.pk).map(col => col.name).join(',');
      for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).iterate()) {
        hash.update(JSON.stringify(row)).update('\n');count++;
        if (++chunk === chunkRows) { chunk = 0;await yieldNow(); }
      }
    }
    result[group.key] = {digest: hash.digest('hex'), count};
    await yieldNow();
  }
  return result;
}

// 원장이 10배면 시간·임시 DB도 N에 비례한다. 원문은 복사하지 않고 위치만 저장하며 조각마다 양보한다.
export async function replayWatchStates(snapshot, chunkRows, yieldNow) {
  const db = new DatabaseSync(':memory:');
  const home = '#watch-sweep-independent';
  try {
    db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE source_rows (position INTEGER PRIMARY KEY,stream TEXT,seq INTEGER,payload TEXT,
        short_task TEXT,transfer INTEGER);
      CREATE INDEX source_task ON source_rows(short_task,position);
      CREATE INDEX source_transfer ON source_rows(transfer,position);
      CREATE TABLE views (domain TEXT,position INTEGER,routine INTEGER,PRIMARY KEY(domain,position));`);
    const insertSource = db.prepare('INSERT INTO source_rows VALUES(?,?,?,NULL,?,?)');
    const insertView = db.prepare("INSERT INTO views VALUES('',?,?)");
    const projector = domainProjector(null), unique = createUniqueDone();
    const query = snapshot.db.prepare(`SELECT position,stream,seq FROM source_rows
      WHERE position>? AND position<=? ORDER BY position LIMIT ?`);
    let position = 0;
    do {
      const rows = query.all(position, snapshot.info.position, chunkRows);
      const values = sourceViewValues(snapshot.source, rows);
      for (const [index, row] of rows.entries()) {
        const value = values[index];
        insertSource.run(row.position, row.stream, row.seq, completionTaskShortId(value),
          Number(isMailTransfer(value) && Array.isArray(value.taskIds)));
        const entry = (row.stream === 'ledger.jsonl' ? projector.legacy([value]) : projector.rows([value]))[0];
        if (entry && unique(entry)) insertView.run(row.position, Number(isWatchRoutine(value)));
      }
      position = rows.at(-1)?.position ?? snapshot.info.position;
      const info = {...snapshot.info, position};
      // 모든 reducer는 새 DB의 원본 기반 views만 읽는다. 운영의 projected.store는 넘기지 않는다.
      const projected = mailboxView(home, db, info, snapshot.source, 'watch', snapshot.cards);
      applyWatchRoleState(home, projected.store, projected.info, snapshot.cards);
      applyWatchWorkState(home, projected.store, projected.info, snapshot.cards);
      await yieldNow();
    } while (position < snapshot.info.position);
    return await stateDigests(db, chunkRows, yieldNow);
  } finally { db.close(); }
}

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

  async function watchStates() {
    const snapshot = access.states.open();
    if (!snapshot) return {status: 'match', diffs: [], note: '감시 투영 상태 없음'};
    try {
      const live = await stateDigests(snapshot.db, chunkRows, yieldNow);
      const replayed = await replayWatchStates(snapshot, chunkRows, yieldNow);
      if (!snapshot.current()) return {status: 'moved', position: snapshot.info.position};
      const diffs = stateGroups.filter(group => live[group.key].digest !== replayed[group.key].digest)
        .map(({key}) => ({key, fingerprint: createHash('sha256')
          .update(`${live[key].digest}|${replayed[key].digest}`).digest('hex').slice(0, 12),
        detail: `저장 상태 ${live[key].count}행 / 원본 독립 재생 ${replayed[key].count}행`}));
      return {status: diffs.length ? 'diff' : 'match', diffs, statePosition: snapshot.info.position,
        stateDigests: {live, replayed}, roleStateDigest: live[ROLE_STATE_KEY].digest,
        roleStateReplayDigest: replayed[ROLE_STATE_KEY].digest};
    } finally { snapshot.close(); }
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
      for (const check of [ledgerArray, access.states ? watchStates : roleState]) {
        try { results.push(await check()); }
        catch (error) {
          results.push({status: 'error', error: error?.message ?? String(error),
            errorKey: check === watchStates ? 'watch-state' : check === roleState ? ROLE_STATE_KEY : 'ledger-source',
            diffs: []});
        }
      }
      return merge(results);
    },
  };
}
