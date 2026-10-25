// Why: 화면 관측에 쓰는 세대·발령을 새 사건만으로 갱신한다. 원본과 완료 판단은 그대로 둔다.
// 10배 과거: 최초/주소 변경 재생은 N, 정상 적용은 새 사건, 읽기는 현재 세대의 발령 수다.
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {taskIdentity} from './task-identity.mjs';
import {encodeMailValue, decodeMailValue} from './mail-view-store.mjs';

const verified = new Map();
const schema = `
  CREATE TABLE watch_role_meta (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
  CREATE TABLE watch_role_sessions (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, rank INTEGER NOT NULL,
    start_position INTEGER, generation_position INTEGER, dispatch_ready INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE watch_role_dispatches (
    session_key TEXT NOT NULL, task_key TEXT NOT NULL, task_value TEXT NOT NULL,
    position INTEGER NOT NULL, rank INTEGER NOT NULL, overlay TEXT,
    PRIMARY KEY(session_key,task_key)
  ) WITHOUT ROWID;
`;

export function loadRoleDispatch(store, row) {
  const entry = store.load(row.position);
  return row.overlay ? {...entry, ...Object.fromEntries(Object.entries(JSON.parse(row.overlay))
    .map(([key, value]) => [key, decodeMailValue(value)]))} : entry;
}

const sessionRow = (store, session) => store.prepare('SELECT * FROM watch_role_sessions WHERE key=?')
  .get(store.key(session));
const dispatchRow = (store, session, task) => store.prepare(`SELECT * FROM watch_role_dispatches
  WHERE session_key=? AND task_key=?`).get(store.key(session), store.key(task));

function putDispatch(store, meta, session, task, position, row = null, changes = null) {
  const existing = dispatchRow(store, session, task);
  if (!existing) meta.dispatchCount++;
  let overlay = row?.overlay ? JSON.parse(row.overlay) : {};
  for (const [key, value] of Object.entries(changes ?? {})) overlay[key] = encodeMailValue(value);
  store.prepare(`INSERT INTO watch_role_dispatches VALUES(?,?,?,?,?,?)
    ON CONFLICT(session_key,task_key) DO UPDATE SET position=excluded.position,overlay=excluded.overlay`)
    .run(store.key(session), store.key(task), encodeMailValue(task), position,
      existing?.rank ?? ++meta.nextRank, Object.keys(overlay).length ? JSON.stringify(overlay) : null);
}

function applyStart(store, meta, entry, position) {
  const previous = sessionRow(store, entry.session);
  const generation = previous?.generation_position ? store.load(previous.generation_position) : null;
  const pid = entry.panePid ?? entry.rottiePid;
  const reused = generation && pid != null && String(pid).trim() !== '' &&
    String(pid) === String(generation.panePid ?? generation.rottiePid) && generation.role === entry.role &&
    (generation.floor ?? 'tmux') === (entry.floor ?? 'tmux') &&
    (entry.floor !== 'rottie' || generation.rottieTerminalId === entry.rottieTerminalId);
  const visible = typeof entry.session === 'string' && entry.session.startsWith('kadan-');
  if (!previous) meta.sessionCount++;
  store.prepare(`INSERT INTO watch_role_sessions VALUES(?,?,?,?,?,1)
    ON CONFLICT(key) DO UPDATE SET start_position=excluded.start_position,
      generation_position=excluded.generation_position,dispatch_ready=1`)
    .run(store.key(entry.session), encodeMailValue(entry.session), previous?.rank ?? position,
      visible ? position : null, reused ? previous.generation_position : position);
  if (!reused && !(entry.restartOf && previous?.dispatch_ready)) {
    meta.dispatchCount -= store.prepare('DELETE FROM watch_role_dispatches WHERE session_key=?')
      .run(store.key(entry.session)).changes;
  }
}

function applyEntry(store, meta, entry, position, taskKey) {
  if (entry.kind === 'start') {
    applyStart(store, meta, entry, position);return true;
  }
  if (entry.kind === 'stop') {
    return Boolean(store.prepare('UPDATE watch_role_sessions SET generation_position=NULL WHERE key=?')
      .run(store.key(entry.session)).changes);
  }
  if (entry.kind === 'done' && entry.role) {
    const session = `kadan-${entry.role}`, key = taskKey(entry.taskId, entry.executionKey);
    const row = dispatchRow(store, session, key);
    if (row && Date.parse(entry.t) >= Date.parse(store.load(row.position).t)) {
      putDispatch(store, meta, session, key, row.position, row, {confirmedResult:entry.result});
      return true;
    }
    return false;
  }
  if (entry.kind === 'handover' && entry.phase === 'transferred') {
    // 잘못된 옛 목록의 정상/예외 경계는 기존 계산으로 판단한다.
    if (entry.taskIds != null && !Array.isArray(entry.taskIds)) {
      meta.legacyRequired = true;return true;
    }
    const from = `kadan-${entry.from}`, to = `kadan-${entry.to}`;
    const source = sessionRow(store, from), target = sessionRow(store, to);
    if (from === to || !source?.dispatch_ready || !target?.dispatch_ready || !target.generation_position) {
      return false;
    }
    let changed = false;
    for (const id of entry.taskIds ?? []) {
      const key = taskKey(id), row = dispatchRow(store, from, key);
      if (!key || !row) continue;
      putDispatch(store, meta, to, key, row.position, row,
        {role:entry.to, session:to, handoverId:entry.handoverId, handoverAt:entry.t});
      meta.dispatchCount -= store.prepare(`DELETE FROM watch_role_dispatches
        WHERE session_key=? AND task_key=?`).run(store.key(from), store.key(key)).changes;
      changed = true;
    }
    return changed;
  }
  if (entry.kind !== 'send' || !entry.taskId || entry.transport === 'mailbox' || entry.notificationOnly) {
    return false;
  }
  const key = taskKey(entry.taskId, entry.executionKey), session = sessionRow(store, entry.session);
  const generation = session?.generation_position ? store.load(session.generation_position) : null;
  if (key && entry.role === generation?.role && session?.dispatch_ready) {
    putDispatch(store, meta, entry.session, key, position);return true;
  }
  return false;
}

export function applyWatchRoleState(home, store, info, cards) {
  if (!store) return null;
  if (store.scope !== 'watch') throw new Error('감시 역할 상태는 주소 해석 후 조회가 필요합니다');
  if (!store.prepare("SELECT 1 FROM sqlite_master WHERE name='watch_role_meta'").get()) store.db.exec(schema);
  const saved = store.prepare('SELECT value FROM watch_role_meta WHERE id=1').get();
  let meta;
  try {meta = saved ? JSON.parse(saved.value) : null;} catch {meta = null;}
  const key = path.resolve(home), stamp = value => JSON.stringify([info.generation, value?.revision]);
  let rebuilt = !meta || meta.version !== 1 || meta.generation !== info.generation ||
    typeof meta.revision !== 'string' || !meta.revision || typeof meta.legacyRequired !== 'boolean' ||
    !['position','stateVersion','sessionCount','dispatchCount','nextRank']
      .every(name => Number.isSafeInteger(meta[name]) && meta[name] >= 0) ||
    meta.position > info.position || meta.stateVersion > meta.position;
  if (!rebuilt && verified.get(key) !== stamp(meta)) {
    rebuilt = store.prepare('SELECT count(*) AS n FROM watch_role_sessions').get().n !== meta.sessionCount ||
      store.prepare('SELECT count(*) AS n FROM watch_role_dispatches').get().n !== meta.dispatchCount;
  }
  if (rebuilt) {
    store.db.exec('DELETE FROM watch_role_sessions; DELETE FROM watch_role_dispatches');
    meta = {version:1, generation:info.generation, revision:randomUUID(), position:0,
      stateVersion:0, sessionCount:0, dispatchCount:0, nextRank:0, legacyRequired:false};
  }
  let identity;
  const taskKey = (id, executionKey) => {
    const found = (identity ??= taskIdentity(cards)).resolve(id, executionKey);
    return found.state === 'resolved' ? found.key : found.state === 'unregistered' ? id : null;
  };
  const before = meta.position;let applied = 0;
  while (true) {
    const rows = store.prepare(`SELECT position FROM views WHERE domain='watch'
      AND position>? AND position<=? ORDER BY position LIMIT 256`).all(meta.position, info.position);
    if (!rows.length) break;
    for (const {position} of rows) {
      const entry = store.load(position);
      if (entry == null || entry.broken) throw new Error('원장 손상: 감시 역할 상태 조회 불가');
      if (applyEntry(store, meta, entry, position, taskKey)) meta.stateVersion = position;
      meta.position = position;applied++;
    }
    store.clear();
  }
  meta.position = info.position;
  if (rebuilt || applied || before !== meta.position) {
    store.prepare(`INSERT INTO watch_role_meta VALUES(1,?)
      ON CONFLICT(id) DO UPDATE SET value=excluded.value`).run(JSON.stringify(meta));
  }
  verified.delete(key);verified.set(key, stamp(meta));
  while (verified.size > 8) verified.delete(verified.keys().next().value);
  return {...meta, applied, rebuilt};
}
