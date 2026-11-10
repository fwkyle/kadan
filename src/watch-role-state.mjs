// Why: 화면 관측에 쓰는 세대·발령을 새 사건만으로 갱신한다. 원본과 완료 판단은 그대로 둔다.
// 10배 과거: 최초/주소 변경 재생은 N, 정상 적용은 새 사건, 읽기는 현재 세대의 발령 수다.
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {taskIdentity} from './task-identity.mjs';
import {encodeMailValue, decodeMailValue} from './mail-view-store.mjs';
import {startDigest} from './secretary-resume.mjs';

const verified = new Map();

// kadan reopen이 남긴 start가 "바로 앞에 꺼진 그 세대"를 잇는가. 부르는 쪽이 두 가지를 넘긴다:
//   - lastStart: 그 세션의 문자 그대로 마지막 start 사건(이번 start 바로 앞의 것. 살아 있는 세션을 다시 연 start도 포함)
//   - 지금 세대가 없다는 사실(stop으로 꺼진 상태)은 부르는 쪽이 먼저 확인한다
// start의 reopenOf가 그 마지막 start의 지문과 같으면, 그 start와 이번 start 사이에 다른 start가 없었다는 뜻이다
// (있었다면 마지막 start가 달라진다). 지문은 reopen이 원장에서 읽은 사건으로 만든 것(startDigest)과 같은 계산이다.
// 따로 적어 두는 상태가 없다: 저장 상태 경로는 sessions 표의 start_position·generation_position만 읽는다. 이 두 칸은
// reopen을 모르는 옛 프로그램도 같은 규칙으로 갱신하므로(start가 덮고, stop은 세대만 비운다), 옛 프로그램이 사이를 지나가도
// 낡은 근거가 남지 않는다. 틀리는 방향은 "이어받지 않음"뿐이다. 전체 훑기(watch-roles.mjs)도 이 함수를 쓴다.
export function reopenContinues(entry, lastStart) {
  return typeof entry?.reopenOf === 'string' && entry.reopenOf.length > 0 && lastStart?.kind === 'start'
    && lastStart.session === entry.session && lastStart.role === entry.role
    && generationDistinct(lastStart) && startDigest(lastStart) === entry.reopenOf;
}

// 지문은 사건의 본문만 본다. 그래서 근거가 되는 start는 "다른 세대의 start와 본문이 같을 수 없는" 기록이어야 한다.
// 세대를 구분하는 값은 둘뿐이다:
//   - outputLog: 세션을 만들 때 붙는 출력 기록 경로(만들 때마다 새 UUID 폴더). 세션을 실제로 띄운 start에 있다.
//   - reuseOf: 살아 있는 세션을 다시 연 start(명령·출력 기록 경로 없음)가 적는, 그 세대를 띄운 start의 지문.
//     위 outputLog가 있는 start를 가리킬 때만 적는다(role-conversation.mjs reuseOfFor).
// 둘 다 없는 start(이 칸이 생기기 전의 재사용 기록, 출력 기록을 붙이지 못한 세션)는 역할·PID·작업 폴더·기록 시각이 같으면
// 다른 세대의 기록과 본문이 같아질 수 있다. 확신할 수 없으므로 근거로 쓰지 않는다(이어받지 않는다).
// kadan reopen도 같은 함수로 "감시가 이어지는가"를 안내한다.
export function generationDistinct(start) {
  const filled = value => typeof value === 'string' && value.length > 0;
  return filled(start?.outputLog) || filled(start?.reuseOf);
}
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
  // 꺼진 뒤의 새 start일 때만 본다: 지금 세대가 없고(stop이 generation_position을 비웠다) 그 세션의 마지막 start
  // (start_position, stop이 지우지 않는다)가 reopenOf가 가리키는 사건이어야 한다. 살아 있는 세대를 덮어쓴 start는 reopen이 아니다.
  // 추가 SQL은 없다(위에서 읽은 행을 쓴다). 그 사건을 못 읽거나 start가 아니면 이어받지 않을 뿐 적용은 계속한다.
  let reopened = false;
  if (!reused && entry.reopenOf && previous && !previous.generation_position && previous.start_position) {
    let lastStart = null;
    try { lastStart = store.load(previous.start_position); } catch { /* 못 읽으면 이어받지 않는다 */ }
    reopened = reopenContinues(entry, lastStart);
  }
  if (!previous) meta.sessionCount++;
  store.prepare(`INSERT INTO watch_role_sessions VALUES(?,?,?,?,?,1)
    ON CONFLICT(key) DO UPDATE SET start_position=excluded.start_position,
      generation_position=excluded.generation_position,dispatch_ready=1`)
    .run(store.key(entry.session), encodeMailValue(entry.session), previous?.rank ?? position,
      visible ? position : null, reused ? previous.generation_position : position);
  if (!reused && !((entry.restartOf || reopened) && previous?.dispatch_ready)) {
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
