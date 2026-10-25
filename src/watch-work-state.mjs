// Why: 감시 책임 계산의 발령·완료·확정 인계를 같은 SQL 적용 위치에서 유지한다.
// 정상 적용은 새 사건만 읽는다. 인계는 해당 담당/실행의 마지막 사실만 합치며 원본은 보존한다.
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {taskIdentity} from './task-identity.mjs';
import {encodeMailValue, decodeMailValue} from './mail-view-store.mjs';

const verified = new Map();
const schema = `
  CREATE TABLE watch_work_meta (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
  CREATE TABLE watch_work_last (
    role_key TEXT NOT NULL, task_key TEXT NOT NULL, pending_key TEXT NOT NULL,
    position INTEGER NOT NULL, kind TEXT NOT NULL, overlay TEXT,
    PRIMARY KEY(role_key,task_key)
  ) WITHOUT ROWID;
  CREATE INDEX watch_work_pending ON watch_work_last(pending_key,position DESC);
  CREATE TABLE watch_work_sent (task_key TEXT PRIMARY KEY) WITHOUT ROWID;
  CREATE TABLE watch_work_transfers (
    task_key TEXT NOT NULL, source TEXT NOT NULL, position INTEGER NOT NULL,
    target TEXT NOT NULL, has_time INTEGER NOT NULL, time REAL,
    PRIMARY KEY(task_key,source,position)
  ) WITHOUT ROWID;
`;

export const workPendingKey = (role, taskId) => `${role}\0${taskId}`;

export function loadWorkEntry(store, row) {
  const entry = store.load(row.position);
  if (!row.overlay) return entry;
  const overlay = JSON.parse(row.overlay);
  return {...entry, ...overlay, handoverId:decodeMailValue(overlay.handoverId)};
}

function putLast(store, meta, entry, position, overlay = null) {
  const role = store.key(entry.role), task = store.key(entry.taskId);
  const previous = store.prepare(`SELECT position FROM watch_work_last
    WHERE role_key=? AND task_key=?`).get(role, task);
  if (previous && previous.position > position) return;
  if (!previous) meta.lastCount++;
  store.prepare(`INSERT INTO watch_work_last VALUES(?,?,?,?,?,?)
    ON CONFLICT(role_key,task_key) DO UPDATE SET pending_key=excluded.pending_key,
    position=excluded.position,kind=excluded.kind,overlay=excluded.overlay`)
    .run(role, task, workPendingKey(entry.role, entry.taskId), position, entry.kind,
      overlay ? JSON.stringify(overlay) : null);
}

function transfer(store, meta, entry, position, identity) {
  // workEntries는 같은 handoverId의 재등장도 적용한다. 우편의 중복 제외를 재사용하지 않는다.
  for (const id of new Set(entry.taskIds)) {
    const row = store.prepare(`SELECT position,overlay FROM watch_work_last
      WHERE role_key=? AND task_key=?`).get(store.key(entry.from), store.key(id));
    if (row) {
      const previous = loadWorkEntry(store, row);
      const overlay = {role:entry.to, session:`kadan-${entry.to}`,
        inheritedFrom:previous.inheritedFrom ?? entry.from,
        handoverId:encodeMailValue(entry.handoverId), ownedAt:entry.t ?? null};
      store.prepare('DELETE FROM watch_work_last WHERE role_key=? AND task_key=?')
        .run(store.key(entry.from), store.key(id));
      meta.lastCount--;
      putLast(store, meta, {...previous, role:entry.to}, row.position, overlay);
    }
    const found = identity.resolve(id);
    if (found.state !== 'resolved') continue;
    const time = Date.parse(entry.t);
    meta.transferCount += store.prepare('INSERT OR IGNORE INTO watch_work_transfers VALUES(?,?,?,?,?,?)')
      .run(store.key(found.key), entry.from, position, entry.to, Number(Boolean(entry.t)),
        Number.isFinite(time) ? time : null).changes;
  }
}

export function applyWatchWorkState(home, store, info, cards) {
  if (!store) return null;
  if (store.scope !== 'watch') throw new Error('감시 책임은 주소 해석 후 조회가 필요합니다');
  if (!store.prepare("SELECT 1 FROM sqlite_master WHERE name='watch_work_meta'").get()) store.db.exec(schema);
  const saved = store.prepare('SELECT value FROM watch_work_meta WHERE id=1').get();
  let meta;
  try {meta = saved ? JSON.parse(saved.value) : null;} catch {meta = null;}
  const key = path.resolve(home), stamp = value => JSON.stringify([info.generation, value?.revision]);
  let rebuilt = !meta || meta.version !== 1 || meta.generation !== info.generation ||
    typeof meta.legacyRequired !== 'boolean' ||
    typeof meta.revision !== 'string' || !meta.revision ||
    !['position','stateVersion','lastCount','sentCount','transferCount']
      .every(name => Number.isSafeInteger(meta[name]) && meta[name] >= 0) ||
    meta.position > info.position || meta.stateVersion > meta.position;
  if (!rebuilt && verified.get(key) !== stamp(meta)) {
    rebuilt = store.prepare('SELECT count(*) AS n FROM watch_work_last').get().n !== meta.lastCount ||
      store.prepare('SELECT count(*) AS n FROM watch_work_sent').get().n !== meta.sentCount ||
      store.prepare('SELECT count(*) AS n FROM watch_work_transfers').get().n !== meta.transferCount;
  }
  if (rebuilt) {
    store.db.exec('DELETE FROM watch_work_last; DELETE FROM watch_work_sent; DELETE FROM watch_work_transfers');
    meta = {version:1, generation:info.generation, revision:randomUUID(), position:0,
      stateVersion:0, lastCount:0, sentCount:0, transferCount:0, legacyRequired:false};
  }
  const before = meta.position;
  let identity = null, applied = 0;
  while (true) {
    const rows = store.prepare(`SELECT position FROM views WHERE domain='watch'
      AND position>? AND position<=? ORDER BY position LIMIT 256`).all(meta.position, info.position);
    if (!rows.length) break;
    for (const {position} of rows) {
      const entry = store.load(position);
      if (entry == null || entry.broken) throw new Error('원장 손상: 감시 책임 조회 불가');
      if (entry.kind === 'handover' && entry.phase === 'transferred') {
        // 옛 잘못된 목록의 오류/적용 범위는 기존 책임 계산에 맡긴다.
        if (entry.taskIds != null && !Array.isArray(entry.taskIds)) meta.legacyRequired = true;
        else {
          identity ??= taskIdentity(cards);
          transfer(store, meta, entry, position, identity);
        }
        meta.stateVersion = position;
      } else if (['send','done'].includes(entry.kind) && entry.role && entry.taskId &&
          entry.transport !== 'mailbox') {
        putLast(store, meta, entry, position);meta.stateVersion = position;
      }
      if (entry.kind === 'send' && entry.taskId && entry.transport !== 'mailbox') {
        meta.sentCount += store.prepare('INSERT OR IGNORE INTO watch_work_sent VALUES(?)')
          .run(store.key(entry.executionKey || entry.taskId)).changes;
        meta.stateVersion = position;
      }
      if (entry.kind === 'start' || entry.kind === 'stop') meta.stateVersion = position;
      meta.position = position;applied++;
    }
    store.clear();
  }
  meta.position = info.position;
  if (rebuilt || applied || before !== meta.position) {
    store.prepare(`INSERT INTO watch_work_meta VALUES(1,?)
      ON CONFLICT(id) DO UPDATE SET value=excluded.value`).run(JSON.stringify(meta));
  }
  verified.delete(key);verified.set(key, stamp(meta));
  while (verified.size > 8) verified.delete(verified.keys().next().value);
  return {...meta, applied, rebuilt};
}
