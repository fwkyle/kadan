// Why: 감시가 해석한 카드 주소로 답장을 판정하며 과거 사건 배열을 다시 보관하지 않는다.
// 10배 과거에도 정상 적용은 새 사건만 읽는다. 주소 집합 변화·복구 때는 전체를 다시 재생한다.
import path from 'node:path';
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

export function applyWatchMailProjection(home, db, source, info, cards) {
  if (!Array.isArray(cards)) throw new Error('감시 우편의 카드 주소 수집이 필요합니다');
  const identity = taskIdentity(cards), projector = domainProjector(null);
  const signature = createHash('sha256').update(JSON.stringify(
    cards.map(card => ({key:card.key, id:card.id})),
  )).digest('hex');
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='watch_mail_projection'").get()) {
    db.exec(schema);
  }
  const saved = db.prepare('SELECT value FROM watch_mail_projection WHERE id=1').get();
  let meta;
  try {meta = saved ? JSON.parse(saved.value) : null;} catch {meta = null;}
  const key = path.resolve(home);
  const stamp = value => JSON.stringify([info.generation, signature, value?.revision]);
  let rebuilt = !meta || meta.version !== 1 || meta.generation !== info.generation ||
    meta.signature !== signature || typeof meta.revision !== 'string' || !meta.revision ||
    !Number.isSafeInteger(meta.position) || meta.position < 0 || meta.position > info.position ||
    !Number.isSafeInteger(meta.count) || meta.count < 0;
  if (!rebuilt && verified.get(key) !== stamp(meta)) {
    rebuilt = db.prepare('SELECT count(*) AS n FROM views WHERE domain=?').get(DOMAIN).n !== meta.count;
  }
  if (rebuilt) {
    db.prepare('DELETE FROM views WHERE domain=?').run(DOMAIN);
    db.exec('DELETE FROM watch_mail_completions');
    meta = {version:1, generation:info.generation, signature, revision:randomUUID(), position:0, count:0};
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
      if (!duplicate && !taskConnectionError(entry)) {
        insert.run(DOMAIN, row.position, row.routine);meta.count++;
      }
      meta.position = row.position;applied++;
    }
  }
  meta.position = info.position;
  if (rebuilt || applied || previous !== meta.position) {
    db.prepare(`INSERT INTO watch_mail_projection VALUES(1,?)
      ON CONFLICT(id) DO UPDATE SET value=excluded.value`).run(JSON.stringify(meta));
  }
  verified.delete(key);verified.set(key, stamp(meta));
  while (verified.size > 8) verified.delete(verified.keys().next().value);
  return {projector, projectEntry:identity.projectEntry,
    info:{...info, generation:meta.revision, projectionApplied:applied, projectionRebuilt:rebuilt}};
}
