// Why: 감시가 해석한 카드 주소로 답장을 판정하며 과거 사건 배열을 다시 보관하지 않는다.
// 10배 과거에도 안전한 주소 추가는 카드 목록 비교와 참조 색인 조회 뒤 새 사건만 읽는다.
import path from 'node:path';
import {beginWatchReplay, watchMetric} from './watch-replay-metrics.mjs';
import {createHash, randomUUID} from 'node:crypto';
import {domainProjector} from './ledger-domains.mjs';
import {sourceViewValues} from './ledger-view.mjs';
import {taskIdentity, taskConnectionError, projectedCompletionKey} from './task-identity.mjs';

const DOMAIN = 'watch';
const verified = new Map();
const schema = `
  CREATE TABLE watch_mail_projection (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
  CREATE TABLE watch_mail_completions (key TEXT PRIMARY KEY) WITHOUT ROWID;
`;
const addressSchema = `CREATE TABLE IF NOT EXISTS watch_mail_addresses
  (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)`;
const addressesOf = cards => cards.map(({key, id}) => ({key, id}));
const signatureOf = addresses => createHash('sha256').update(JSON.stringify(addresses)).digest('hex');

// 원본 모든 행의 taskId/executionKey/completionTaskId/taskIds를 참조 색인에 저장한다.
// 정식 주소 끝 조각=id인 카드만 허용하므로 short_refs(id)는 정식 주소의 과거 참조도 포함한다.
function canRetainAddresses(db, signature, cards, position) {
  const saved = db.prepare('SELECT value FROM watch_mail_addresses WHERE id=1').get();
  let previous;
  try { previous = saved && JSON.parse(saved.value); } catch { return false; }
  const valid = list => Array.isArray(list) && list.every(card =>
    typeof card?.key === 'string' && typeof card.id === 'string' && card.id.length > 0 &&
    card.key.includes('/') && card.key.split('/').at(-1) === card.id);
  if (!valid(previous) || !valid(cards) || signatureOf(previous) !== signature) return false;
  const old = new Map(previous.map(card => [card.key, card.id]));
  const next = new Map(cards.map(card => [card.key, card.id]));
  if (old.size !== previous.length || next.size !== cards.length ||
      previous.some(card => next.get(card.key) !== card.id)) return false;
  const ids = new Set(previous.map(card => card.id));
  const added = cards.filter(card => !old.has(card.key));
  // 기존 ID와 충돌하면 참조 유무와 무관하게 보수적으로 전체 재생한다.
  if (added.some(card => ids.has(card.id))) return false;
  if (!added.length) return true;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='short_refs'").get()) {
    return false;
  }
  const referenced = db.prepare('SELECT 1 FROM short_refs WHERE card=? AND position<=? LIMIT 1');
  return !added.some(card => referenced.get(card.id, position));
}

export function applyWatchMailProjection(home, db, source, info, cards, metrics = null) {
  if (!Array.isArray(cards)) throw new Error('감시 우편의 카드 주소 수집이 필요합니다');
  const identity = taskIdentity(cards), projector = domainProjector(null);
  const signature = signatureOf(addressesOf(cards));
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='watch_mail_projection'").get()) {
    db.exec(schema);
  }
  db.exec(addressSchema);
  const saved = db.prepare('SELECT value FROM watch_mail_projection WHERE id=1').get();
  let meta;
  try {meta = saved ? JSON.parse(saved.value) : null;} catch {meta = null;}
  const key = path.resolve(home);
  const stamp = value => JSON.stringify([info.generation, signature, value?.revision]);
  const addressChanged = meta?.signature !== signature;
  let rebuilt = !meta || meta.version !== 1 || meta.generation !== info.generation ||
    typeof meta.revision !== 'string' || !meta.revision ||
    !Number.isSafeInteger(meta.position) || meta.position < 0 || meta.position > info.position ||
    !Number.isSafeInteger(meta.count) || meta.count < 0 ||
    !Number.isSafeInteger(meta.completed) || meta.completed < 0;
  const invalid = rebuilt || addressChanged;
  if (!rebuilt && (addressChanged || verified.get(key) !== stamp(meta))) {
    rebuilt = db.prepare('SELECT count(*) AS n FROM views WHERE domain=?').get(DOMAIN).n !== meta.count ||
      db.prepare('SELECT count(*) AS n FROM watch_mail_completions').get().n !== meta.completed;
  }
  const skipped = !rebuilt && addressChanged && canRetainAddresses(db, meta.signature, cards, meta.position);
  rebuilt ||= addressChanged && !skipped;
  const finishReplay = rebuilt ? beginWatchReplay(metrics, 'projection',
    !invalid ? 'count' : typeof meta?.generation === 'string' && meta.generation !== info.generation
      ? 'generation' : typeof meta?.signature === 'string' && meta.signature !== signature
        ? 'address' : 'invalid') : null;
  try {
    if (rebuilt) {
      db.prepare('DELETE FROM views WHERE domain=?').run(DOMAIN);
      db.exec('DELETE FROM watch_mail_completions');
      meta = {version:1, generation:info.generation, signature, revision:randomUUID(),
        position:0, count:0, completed:0};
    }
    if (rebuilt || skipped) {
      // 주소 근거와 투영은 같은 바깥 트랜잭션에서 저장한다. 실패 때 한쪽만 앞서 가지 않는다.
      db.prepare(`INSERT INTO watch_mail_addresses VALUES(1,?)
        ON CONFLICT(id) DO UPDATE SET value=excluded.value`).run(JSON.stringify(addressesOf(cards)));
      meta.signature = signature;
      if (skipped) watchMetric(metrics, 'count', 'projection', 'skipped');
    }
    const previous = meta.position;
    const query = db.prepare(`SELECT r.stream,r.seq,v.position,v.routine
      FROM views v JOIN source_rows r USING(position)
      WHERE v.domain='' AND v.position>? AND v.position<=? ORDER BY v.position LIMIT 256`);
    const done = db.prepare('INSERT OR IGNORE INTO watch_mail_completions VALUES(?)');
    const insert = db.prepare('INSERT INTO views VALUES(?,?,?)');
    let applied = 0;
    while (true) {
      const rows = query.all(meta.position, info.position);
      if (!rows.length) break;
      const values = sourceViewValues(source, rows);
      for (const [index, row] of rows.entries()) {
        const value = values[index];
        const raw = (row.stream === 'ledger.jsonl' ? projector.legacy([value]) : projector.rows([value]))[0];
        const entry = identity.projectEntry(raw), completion = projectedCompletionKey(entry);
        const duplicate = completion !== null && !done.run(completion).changes;
        if (completion !== null && !duplicate) meta.completed++;
        if (!duplicate && !taskConnectionError(entry)) {
          insert.run(DOMAIN, row.position, row.routine);meta.count++;
        }
        meta.position = row.position;applied++;
      }
    }
    meta.position = info.position;
    if (rebuilt || skipped || applied || previous !== meta.position) {
      db.prepare(`INSERT INTO watch_mail_projection VALUES(1,?)
        ON CONFLICT(id) DO UPDATE SET value=excluded.value`).run(JSON.stringify(meta));
    }
    verified.delete(key);verified.set(key, stamp(meta));
    while (verified.size > 8) verified.delete(verified.keys().next().value);
    return {projector, projectEntry:identity.projectEntry,
      info:{...info, generation:meta.revision, projectionApplied:applied, projectionRebuilt:rebuilt}};
  } finally { finishReplay?.(); }
}
