// 기반 프로세스 4개(비서·대시보드·디코 다리·감시기)를 launchd 주기 `kadan up --auto`가 되살린다(2026-10-16 [kyle] 결정 f66a5b60).
// 작업자·검수자·감독 같은 AI 역할은 대상이 아니다. 대상 목록은 아래 TARGETS 하나뿐이다.
// 멈춤 상태($KADAN_HOME/revive-state.json): 사람이 `kadan stop`으로 끈 대상('stopped')과 1시간 상한에 걸린 대상('capped')은 --auto가 건너뛴다.
// 사람이 친 `kadan up`(--auto 없음)이 모든 멈춤을 푼다. 감시기·다리는 역할이 아니라 start 기록이 없으므로 원장만으로는 수동 정지를 알 수 없다.
// 다시 띄운 기록은 start가 아니라 `revive` 사건이다(start로 적으면 역할로 읽혀 감시 대상과 역할 사망 판정에 오른다).
import fs from 'node:fs';
import path from 'node:path';
import { scrubSecrets } from './user-notify.mjs';

export const TARGETS = ['비서', '대시보드', '디코', 'watch'];
export const REVIVE_LABELS = { 비서: '비서', 대시보드: '대시보드', 디코: '디코 다리', watch: '감시기' };
export const REVIVE_CAP = 3;
export const REVIVE_WINDOW_MS = 60 * 60 * 1000;
const SCREEN_LINES = 200;

const stateFile = (home) => path.join(home, 'revive-state.json');
const emptyState = () => ({ targets: {}, history: {}, blocked: {}, lastResult: {}, lastOutput: '' });

export function readReviveState(home) {
  try {
    const v = JSON.parse(fs.readFileSync(stateFile(home), 'utf8'));
    return { ...emptyState(), ...(v && typeof v === 'object' ? v : {}) };
  } catch { return emptyState(); }
}
export function writeReviveState(home, state) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = stateFile(home), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// 사람이 `kadan stop <대상>`으로 끈 것. `kadan restart`의 stop은 이 경로를 지나지 않는다(restart.mjs가 직접 기록한다).
export function markStopped(home, role, { by = 'user', now = Date.now() } = {}) {
  if (!TARGETS.includes(role)) return false;
  const state = readReviveState(home);
  state.targets[role] = { state: 'stopped', at: new Date(now).toISOString(), by };
  writeReviveState(home, state);
  return true;
}
// 사람이 친 `kadan up`: 모든 멈춤을 풀고 상한 집계도 새로 센다(사람이 확인했다는 뜻이다).
export function clearForUp(home) {
  const state = readReviveState(home);
  if (!Object.keys(state.targets).length && !Object.keys(state.history).length && !Object.keys(state.blocked).length) return false;
  state.targets = {}; state.history = {}; state.blocked = {}; state.lastResult = {};
  writeReviveState(home, state);
  return true;
}

// 동시 실행 잠금: 폴더 + pid. 주인이 죽었으면 넘겨받는다(1분마다 도는 일이라 멈춘 잠금이 영원히 남으면 안 된다).
export function acquireReviveLock(home, { waitMs = 0, sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  const lock = path.join(home, 'revive.lock'), pidFile = path.join(lock, 'pid');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(lock); fs.writeFileSync(pidFile, String(process.pid));
      return () => { try { fs.rmSync(pidFile, { force: true }); fs.rmdirSync(lock); } catch { /* 이미 없음 */ } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid = NaN;
      try { pid = Number(fs.readFileSync(pidFile, 'utf8')); } catch { /* pid가 아직 없음 — 막 만든 잠금 */ }
      let alive = true;
      if (Number.isInteger(pid) && pid > 0) try { process.kill(pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
      if (!alive) { try { fs.rmSync(pidFile, { force: true }); fs.rmdirSync(lock); } catch { /* 다른 쪽이 먼저 치웠다 */ } continue; }
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
// ops: sessionOf(target) · exists(session) · paneDead(session) · capture(session) · kill(session) · applicable(target) ·
//      stuck(target)(살아 있는 pane인데 일을 못 하는 진짜 막힘이면 이유 문구, 아니면 null) · notify(message, {ring, key}) · record(entry)
// auto가 아니면(사람이 친 up) 죽은 pane 정리만 하고 상한·멈춤·기록은 건드리지 않는다.
export function prepareRevive({ home, auto, now = Date.now(), ops }) {
  const state = readReviveState(home);
  const skip = new Set(), pending = new Map(), lines = [];
  for (const target of TARGETS) {
    const label = REVIVE_LABELS[target], session = ops.sessionOf(target);
    if (auto && state.targets[target]) { skip.add(target); continue; }
    if (!ops.applicable(target)) { if (auto) skip.add(target); continue; }
    let reason = null, screenPath = null;
    if (ops.exists(session)) {
      if (ops.paneDead(session) === true) {
        // 프로세스가 이미 없는 카단 소유 세션이다. 마지막 화면을 남기고 치운 뒤 새로 만든다.
        try { screenPath = saveScreen(home, target, ops.capture(session, SCREEN_LINES), now); } catch { /* 화면 저장 실패는 되살리기를 막지 않는다 */ }
        ops.kill(session);
        reason = 'pane 죽음';
        lines.push(`${label}: 프로세스가 죽은 창을 치웠습니다${screenPath ? `(마지막 화면 ${screenPath})` : ''}`);
      } else if (auto) {
        const stuck = ops.stuck(target);
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
      ops.record({ kind: 'revive', target, reason: info.reason, screenPath: info.screenPath, count: info.count, result: 'started', by: 'autostart' });
      ops.notify(`${label}가 꺼져 있어 다시 띄웠습니다(이번 1시간 ${info.count}번째).${info.screenPath ? ` 마지막 화면: ${info.screenPath}` : ''}`, { ring: false });
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
