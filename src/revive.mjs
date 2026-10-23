// 기반 프로세스 4개(비서·대시보드·디코 다리·감시기)를 launchd 주기 `kadan up --auto`가 되살린다(2026-10-16 [kyle] 결정 f66a5b60).
// 작업자·검수자·감독 같은 AI 역할은 대상이 아니다. 대상 목록은 아래 TARGETS 하나뿐이다.
// 멈춤 상태($KADAN_HOME/revive-state.json): 사람이 `kadan stop`으로 끈 대상('stopped')과 1시간 상한에 걸린 대상('capped')은 --auto가 건너뛴다.
// 사람이 친 `kadan up`(--auto 없음)이 모든 멈춤을 푼다. 감시기·다리는 역할이 아니라 start 기록이 없으므로 원장만으로는 수동 정지를 알 수 없다.
// 다시 띄운 기록은 start가 아니라 `revive` 사건이다(start로 적으면 역할로 읽혀 감시 대상과 역할 사망 판정에 오른다).
import fs from 'node:fs';
import path from 'node:path';
import { scrubSecrets } from './user-notify.mjs';
import { pidAlive } from './pid-alive.mjs';

export const TARGETS = ['비서', '대시보드', '디코', 'watch'];
export const REVIVE_LABELS = { 비서: '비서', 대시보드: '대시보드', 디코: '디코 다리', watch: '감시기' };
export const REVIVE_CAP = 3;
export const REVIVE_WINDOW_MS = 60 * 60 * 1000;
const SCREEN_LINES = 200;

const stateFile = (home) => path.join(home, 'revive-state.json');
const emptyState = () => ({ targets: {}, history: {}, blocked: {}, lastResult: {}, lastOutput: '' });

// 파일이 없으면 빈 상태. 있는데 깨졌으면 빈 상태에 corrupt:true를 붙인다 — 빈 상태로 읽으면 kyle의 멈춤 표시를 잃고 끈 것을 되살린다.
export function readReviveState(home) {
  let text;
  try { text = fs.readFileSync(stateFile(home), 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    return { ...emptyState(), corrupt: true };
  }
  try {
    const v = JSON.parse(text);
    if (!validShape(v)) throw new Error('bad shape');
    return { ...emptyState(), ...v };
  } catch { return { ...emptyState(), corrupt: true }; }
}
// 이름으로 찾는 필드는 모두 일반 객체여야 하고, 값은 쓰는 곳이 기대하는 모양이어야 한다. 필드가 아예 없으면 빈 기본값이라 정상이다.
// 배열 같은 틀린 모양을 통과시키면 멈춤 표시를 저장하지 못해(배열에 이름 키는 직렬화되지 않는다) 끈 것이 되살아난다.
const isPlain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
function validShape(v) {
  if (!isPlain(v)) return false;
  for (const key of ['targets', 'history', 'blocked', 'lastResult']) if (key in v && !isPlain(v[key])) return false;
  if ('lastOutput' in v && typeof v.lastOutput !== 'string') return false;
  if ('targets' in v && !Object.values(v.targets).every((t) => isPlain(t) && typeof t.state === 'string')) return false;
  if ('history' in v && !Object.values(v.history).every((h) => Array.isArray(h) && h.every(Number.isFinite))) return false;
  if ('blocked' in v && !Object.values(v.blocked).every(isPlain)) return false;
  return true;
}
export function writeReviveState(home, state) {
  if (state.corrupt) throw new Error('손상된 revive-state.json 위에 쓰지 않는다');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = stateFile(home), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// 사람이 친 명령(up·stop)에서만 쓴다: 깨진 상태 파일을 지우지 않고 .trash로 옮기고 새로 시작한다. 옮긴 경로를 돌려준다(없으면 null).
export function recoverCorruptState(home, now = Date.now()) {
  if (!readReviveState(home).corrupt) return null;
  const dir = path.join(home, '.trash');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `revive-state-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`);
  fs.renameSync(stateFile(home), dest);
  fs.rmSync(path.join(home, 'revive-corrupt.notified'), { force: true });
  return dest;
}

// 사람이 `kadan stop <대상>`으로 끈 것. `kadan restart`의 stop은 이 경로를 지나지 않는다(restart.mjs가 직접 기록한다).
// 반환: 표시 전 상태(unmarkStopped로 되돌릴 때 쓴다) 또는 null(대상 아님).
export function markStopped(home, role, { by = 'user', now = Date.now() } = {}) {
  if (!TARGETS.includes(role)) return null;
  recoverCorruptState(home, now);
  const state = readReviveState(home);
  const previous = state.targets[role] ?? null;
  state.targets[role] = { state: 'stopped', at: new Date(now).toISOString(), by };
  writeReviveState(home, state);
  return { previous };
}
// 끄기가 실패했을 때: 표시를 이전 상태로 되돌린다(세션은 그대로 살아 있고, 사람은 오류를 본다).
export function unmarkStopped(home, role, token) {
  const state = readReviveState(home);
  if (state.corrupt) return;
  if (token?.previous) state.targets[role] = token.previous; else delete state.targets[role];
  writeReviveState(home, state);
}
// 사람이 친 `kadan up`: 모든 멈춤을 풀고 상한 집계도 새로 센다(사람이 확인했다는 뜻이다).
export function clearForUp(home) {
  const recovered = recoverCorruptState(home);
  const state = readReviveState(home);
  if (!Object.keys(state.targets).length && !Object.keys(state.history).length && !Object.keys(state.blocked).length) return Boolean(recovered);
  state.targets = {}; state.history = {}; state.blocked = {}; state.lastResult = {};
  writeReviveState(home, state);
  return true;
}

// 동시 실행 잠금: 폴더 + pid. 1분마다 도는 일이라 멈춘 잠금이 영원히 남으면 안 되므로 주인이 없는 잠금은 되찾는다.
//   - pid 주인이 죽었다(좀비 포함)
//   - pid 파일이 없거나 깨졌는데 잠금이 STALE_LOCK_MS보다 오래됐다
// 막 만든 잠금(pid 쓰기 직전)과 살아 있는 주인의 잠금은 그대로 둔다. 되찾으면 onReclaim(이유)을 부른다.
// 사람이 친 명령이 잠금을 기다리는 시간(시험이 줄일 수 있다).
export const lockWaitMs = (fallback = 15000) => {
  const v = Number(process.env.KADAN_REVIVE_LOCK_WAIT_MS);
  return Number.isFinite(v) && v >= 0 && process.env.KADAN_REVIVE_LOCK_WAIT_MS !== undefined ? v : fallback;
};
export const reclaimLog = (reason) => console.log(`[${new Date().toISOString()}] 낡은 revive.lock을 되찾음: ${reason}`);
export const STALE_LOCK_MS = 2 * 60 * 1000;
export function acquireReviveLock(home, { waitMs = 0, sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  isAlive = pidAlive, now = Date.now, onReclaim = () => {} } = {}) {
  const lock = path.join(home, 'revive.lock'), pidFile = path.join(lock, 'pid');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      // mkdir 성공 뒤 pid를 쓰기 전에 다른 쪽이 낡은 잠금으로 보고 이 폴더를 옮길 수 있다(ENOENT). 원인이 식별된 경쟁
      // ('잠금을 빼앗김')이라 던지지 않고 처음부터 다시 얻는다. 그 밖의 오류는 원인을 모르므로 그대로 던진다.
      try { fs.writeFileSync(pidFile, String(process.pid)); }
      catch (writeError) { if (writeError.code === 'ENOENT') continue; throw writeError; }
      // 쓴 뒤 다시 읽어 자기 pid일 때만 얻은 것으로 본다. 아니면 그 사이 빼앗긴 것이므로 다시 돈다.
      try { if (Number(fs.readFileSync(pidFile, 'utf8')) !== process.pid) continue; } catch { continue; }
      // 해제는 pid 파일이 자기 pid일 때만 한다 — 되찾기로 치워진 뒤 다른 프로세스가 새로 잡은 잠금을 지우지 않는다.
      return () => {
        try {
          if (Number(fs.readFileSync(pidFile, 'utf8')) !== process.pid) return;
          fs.rmSync(pidFile, { force: true }); fs.rmdirSync(lock);
        } catch { /* 이미 없음 */ }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid = NaN;
      try { pid = Number(fs.readFileSync(pidFile, 'utf8')); } catch { /* pid가 아직 없음 */ }
      let reason = null;
      if (Number.isInteger(pid) && pid > 0) { if (!isAlive(pid)) reason = `주인(pid ${pid})이 죽었다`; }
      else {
        let age = 0;
        try { age = now() - fs.statSync(lock).mtimeMs; } catch { continue; }
        if (age > STALE_LOCK_MS) reason = `pid 파일이 없거나 깨진 채 ${Math.round(age / 1000)}초 지났다`;
      }
      if (reason) {
        // 되찾기는 rename 하나로 한다: 두 프로세스가 같이 시도해도 한 쪽만 이기고, 진 쪽은 ENOENT를 받아 mkdir부터 다시 한다.
        // (지우기로 하면 늦은 쪽이 이긴 쪽이 막 만든 새 잠금을 지운다.) 옮긴 폴더는 우리 잠금 내부 폴더라 그 뒤에 지운다.
        const stale = `${lock}.stale-${process.pid}-${Date.now()}`;
        const readPid = file => { try { return Number(fs.readFileSync(file, 'utf8')); } catch { return NaN; } };
        // 옮기기 직전에 다시 읽는다: 그 사이 다른 쪽이 이미 되찾아 새로 잡았다면(주인이 달라졌다) 건드리지 않는다.
        if (readPid(pidFile) !== pid && !(Number.isNaN(pid) && Number.isNaN(readPid(pidFile)))) continue;
        let moved = false;
        try { fs.renameSync(lock, stale); moved = true; } catch { /* 다른 쪽이 먼저 치웠다 */ }
        if (moved) {
          // 옮긴 폴더가 우리가 낡았다고 본 그 잠금인지 확인한다. 다시 읽은 뒤 옮기기 전에 다른 쪽이 새 잠금을 만들었다면
          // (pid가 다르거나, pid 파일을 쓰기 전이라 막 만든 폴더) 지우지 않고 제자리로 돌려놓는다.
          const owner = readPid(path.join(stale, 'pid'));
          let same;
          if (Number.isInteger(pid) && pid > 0) same = owner === pid;
          else { let age = 0; try { age = now() - fs.statSync(stale).mtimeMs; } catch { /* 없음 */ } same = !(owner > 0) && age > STALE_LOCK_MS; }
          if (same) { fs.rmSync(stale, { recursive: true, force: true }); onReclaim(reason); }
          else { try { fs.renameSync(stale, lock); } catch { /* 이미 다른 잠금이 있다 */ } }
        }
        continue;
      }
      if (Date.now() >= deadline) return null;
      sleep(200);
    }
  }
}

// 마지막 화면에서 비밀값 모양을 가린다(웹훅 주소, 디스코드 봇 토큰 모양, Bot/Bearer 헤더).
export function scrubScreen(text) {
  return scrubSecrets(text)
    .replace(/[\w-]{20,}\.[\w-]{5,}\.[\w-]{25,}/g, '[토큰 가림]')
    .replace(/\b(Bot|Bearer)\s+[\w.~+/=-]{8,}/gi, '$1 [가림]');
}
export function saveScreen(home, target, text, now = Date.now()) {
  const dir = path.join(home, 'revive');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${target}-${stamp}.txt`);
  fs.writeFileSync(file, scrubScreen(String(text ?? '')), { mode: 0o600 });
  return file;
}

const recentCount = (state, target, now) => (state.history[target] ?? []).filter((t) => now - t < REVIVE_WINDOW_MS).length;

// 띄우기 전 단계. 반환 {skip: Set, pending: Map(target → {reason, screenPath, count}), lines: []}.
// ops: sessionOf(target) · exists(session) · paneState(session) · capture(session) · kill(session) · applicable(target) ·
//      (paneState(session) → 'dead'|'live'|'mixed'|'unknown': 세션의 모든 창을 본다)
//      stuck(target)(살아 있는 pane인데 일을 못 하는 진짜 막힘이면 이유 문구, 아니면 null) · notify(message, {ring, key}) · record(entry)
// auto가 아니면(사람이 친 up) 죽은 pane 정리만 하고 상한·멈춤·기록은 건드리지 않는다.
export function prepareRevive({ home, auto, now = Date.now(), ops }) {
  if (!auto) recoverCorruptState(home, now);
  const state = readReviveState(home);
  const skip = new Set(), pending = new Map(), lines = [];
  if (state.corrupt) {
    // 고장 나면 닫는 쪽: 멈춤 표시를 읽을 수 없으니 아무것도 되살리지 않는다. 같은 파일 상태에서는 한 번만 울린다.
    for (const target of TARGETS) skip.add(target);
    const file = stateFile(home), marker = path.join(home, 'revive-corrupt.notified');
    let signature = 'missing';
    try { const st = fs.statSync(file); signature = `${st.size}:${st.mtimeMs}`; } catch { /* 읽기만 실패했을 수 있다 */ }
    let seen = null;
    try { seen = fs.readFileSync(marker, 'utf8'); } catch { /* 처음 */ }
    if (seen !== signature) {
      ops.notify(`자동 되살리기 상태 파일(revive-state.json)이 손상돼 기반 프로세스를 되살리지 않습니다. 확인 뒤 kadan up(깨진 파일은 .trash로 옮기고 새로 시작).`, { ring: true, key: 'revive-corrupt' });
      try { fs.writeFileSync(marker, signature); } catch { /* 표시 실패 시 다음 회차에 다시 알린다 */ }
      lines.push('자동 되살리기 멈춤: 상태 파일 손상');
    }
    return { skip, pending, lines, corrupt: true };
  }
  for (const target of TARGETS) {
    const label = REVIVE_LABELS[target], session = ops.sessionOf(target);
    if (auto && state.targets[target]) { skip.add(target); continue; }
    if (!ops.applicable(target)) { if (auto) skip.add(target); continue; }
    let reason = null, screenPath = null;
    if (ops.exists(session)) {
      const panes = ops.paneState(session);
      if (panes === 'dead') {
        // 모든 창의 프로세스가 이미 없는 카단 소유 세션이다. 마지막 화면을 남기고 치운 뒤 새로 만든다.
        try { screenPath = saveScreen(home, target, ops.capture(session, SCREEN_LINES), now); } catch { /* 화면 저장 실패는 되살리기를 막지 않는다 */ }
        ops.kill(session);
        reason = 'pane 죽음';
        lines.push(`${label}: 프로세스가 죽은 창을 치웠습니다${screenPath ? `(마지막 화면 ${screenPath})` : ''}`);
      } else if (auto) {
        // 살아 있는 화면이 하나라도 있거나 조회에 실패하면 지우지 않는다(사람이 보고 있는 화면일 수 있다).
        const stuck = panes === 'mixed' ? '세션에 죽은 창과 살아 있는 창이 섞여 있습니다'
          : panes === 'unknown' ? '창 상태를 조회하지 못했습니다' : ops.stuck(target);
        if (stuck) {
          state.blocked[target] ??= { since: new Date(now).toISOString(), notified: false };
          // 한 번 보고 알리지 않는다: 막 뜨는 중일 수 있어 다음 회차에도 그대로일 때 한 번만 알린다.
          if (state.blocked[target].seen && !state.blocked[target].notified) {
            state.blocked[target].notified = true;
            ops.notify(`${label}: 창은 살아 있는데 일을 못 하고 있습니다(${stuck}). 자동으로 건드리지 않습니다. 확인 뒤 kadan up.`, { ring: true, key: `revive-stuck:${target}` });
            lines.push(`${label}: 막힘 알림(${stuck})`);
          }
          state.blocked[target].seen = true;
        } else delete state.blocked[target];
        continue;
      } else continue;
    } else reason = '세션 없음';
    delete state.blocked[target];
    if (!auto) continue;
    const count = recentCount(state, target, now);
    if (count >= REVIVE_CAP) {
      state.targets[target] = { state: 'capped', at: new Date(now).toISOString(), by: 'autostart' };
      skip.add(target);
      ops.record({ kind: 'revive', target, reason, screenPath, count, result: 'capped', by: 'autostart' });
      ops.notify(`${label}가 1시간에 ${REVIVE_CAP}번 넘게 꺼져 더 띄우지 않습니다.${screenPath ? ` 마지막 화면 ${screenPath}` : ''} 확인 뒤 kadan up.`, { ring: true, key: `revive-capped:${target}` });
      lines.push(`${label}: 1시간 ${REVIVE_CAP}번 상한 — 멈춤`);
      continue;
    }
    pending.set(target, { reason, screenPath, count: count + 1 });
  }
  writeReviveState(home, state);
  return { skip, pending, lines };
}

// 띄운 뒤 단계. results: target → 'started' | 'reused' | 'blocked' | 'failed' (runUp 결과를 옮긴 것).
export function finishRevive({ home, pending, results, now = Date.now(), ops }) {
  const state = readReviveState(home), lines = [];
  for (const [target, info] of pending) {
    const label = REVIVE_LABELS[target], result = results[target] ?? 'failed';
    if (result === 'started') {
      (state.history[target] ??= []).push(now);
      state.history[target] = state.history[target].filter((t) => now - t < REVIVE_WINDOW_MS);
      delete state.lastResult[target];
      // 조용한 알림은 디코로만 보낸다(맥 알림으로 대신하지 않는다). 못 보냈으면 사건에 남긴다.
      const notice = ops.notify(`${label}가 꺼져 있어 다시 띄웠습니다(이번 1시간 ${info.count}번째).${info.screenPath ? ` 마지막 화면: ${info.screenPath}` : ''}`, { ring: false }) ?? {};
      ops.record({ kind: 'revive', target, reason: info.reason, screenPath: info.screenPath, count: info.count, result: 'started', by: 'autostart',
        ...(notice.via && notice.via !== 'discord' ? { notice: notice.via, ...(notice.reason ? { noticeReason: notice.reason } : {}) } : {}) });
      if (notice.via && notice.via !== 'discord') lines.push(`${label}: 조용한 알림을 디코로 보내지 못했습니다${notice.reason ? `(${notice.reason})` : ''}`);
      lines.push(`${label}: 다시 띄움(이번 1시간 ${info.count}번째)`);
    } else if (state.lastResult[target] !== result) {
      state.lastResult[target] = result;
      ops.record({ kind: 'revive', target, reason: info.reason, screenPath: info.screenPath, count: info.count - 1, result, by: 'autostart' });
      lines.push(`${label}: 다시 띄우지 못함(${result})`);
    }
  }
  writeReviveState(home, state);
  return lines;
}

// 바뀐 것이 있을 때만 로그를 쓴다: 직전과 같은 출력이면 빈 배열, 다르면 그대로. 아무 일 없으면 직전 출력도 비운다.
export function changedOutput(home, lines) {
  const state = readReviveState(home), text = lines.join('\n');
  if (state.lastOutput === text) return [];
  state.lastOutput = text;
  writeReviveState(home, state);
  return lines;
}
