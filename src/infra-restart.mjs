// `kadan restart watch|대시보드`: 기반 프로세스 둘을 끄고 같은 명령 안에서 다시 띄워 살아났는지 확인한다.
// 맨 `kadan stop`과 다르다: "사람이 끔" 표시(markStopped)를 남기지 않으므로 중간에 죽어도 launchd 주기 `kadan up --auto`가 평소대로 되살린다.
// 시작은 되살리기와 같은 함수(deps.start)를 쓰고, `up --auto`와 같은 잠금 안에서 돈다(겹쳐 두 번 뜨지 않는다).
// 디코 다리·비서는 대상이 아니다(디코 '일어남'이 Autopilot을 끄는 길이라 재시작 실패가 곧 원격 끄기 상실이다).
import { readReviveState, writeReviveState, recoverCorruptState, acquireReviveLock, lockWaitMs, reclaimLog, legacyLog,
  REVIVE_LABELS, REVIVE_WINDOW_MS } from './revive.mjs';

export const INFRA_RESTART_TARGETS = ['watch', '대시보드'];
// 역할 세션이 부른 재시작은 대상마다 1시간에 이만큼까지. 되살리기의 1시간 3번 상한(history)과 따로 센다(restarts).
export const ROLE_RESTART_CAP = 3;
export const RESTART_VERIFY_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// deps: stop(target) · start(target) → 'started'|'restored'|'reused'|… · verify(target, sinceMs) → boolean · notify(message, opts) · record(entry) · lock(opts)
// byRole: 부른 역할 이름(역할 세션이면) 또는 null(사람). now: 시각 함수.
// 반환 {ok, code, result, message}. 던지지 않는다. 재시도하지 않는다.
export async function restartInfra({ home, target, byRole = null, deps, now = Date.now, waitMs = RESTART_VERIFY_MS, pollMs = 500 }) {
  const label = REVIVE_LABELS[target];
  if (!INFRA_RESTART_TARGETS.includes(target)) return { ok: false, code: 2, result: 'refused', message: `재시작은 감시기(watch)와 대시보드만 합니다(받은 대상: ${target})` };
  const release = (deps.lock ?? acquireReviveLock)(home, { waitMs: lockWaitMs(), onReclaim: reclaimLog, onLegacy: legacyLog });
  if (!release) return { ok: false, code: 1, result: 'refused', message: `자동 되살리기(kadan up --auto)가 실행 중이라 재시작하지 않았습니다. 잠시 뒤 다시 kadan restart ${target}를 치세요` };
  try {
    const refuse = (message) => ({ ok: false, code: 1, result: 'refused', message });
    if (!byRole) recoverCorruptState(home, now());   // 사람이 친 명령: 깨진 상태 파일은 .trash로 옮기고 새로 시작(up과 같다)
    const state = readReviveState(home);
    if (state.corrupt) return refuse(`자동 되살리기 상태 파일(revive-state.json)이 손상돼 ${label}를 재시작하지 않았습니다. kyle이 kadan up으로 확인하세요`);
    const mark = state.targets[target];
    if (byRole) {
      if (mark) return refuse(`${label}는 ${mark.state === 'stopped' ? '사람이 끈' : '1시간 상한에 걸려 멈춘'} 상태라 역할 세션이 다시 띄울 수 없습니다. kyle이 kadan up으로 푼 뒤에 하세요`);
      const recent = (state.restarts[target] ?? []).filter((t) => now() - t < REVIVE_WINDOW_MS);
      if (recent.length >= ROLE_RESTART_CAP) return refuse(`${label} 재시작은 역할 세션에서 1시간에 ${ROLE_RESTART_CAP}번까지입니다(이미 ${recent.length}번). 원인을 먼저 확인하세요`);
      state.restarts[target] = [...recent, now()];   // 실패해도 센다
    } else if (mark) {
      delete state.targets[target];                  // 사람이 친 재시작은 up처럼 그 대상의 멈춤을 푼다
    }
    delete state.blocked[target];
    writeReviveState(home, state);

    const by = byRole ?? '사람';
    const entry = (result, extra = {}) => ({ kind: 'revive', target, reason: 'restart', result, by, ...extra, t: new Date(now()).toISOString() });
    const fail = (result, message) => {
      let alerted = true;
      try { deps.notify(`${label} 재시작이 ${result === 'unverified' ? '살아났는지 확인하지 못했습니다' : '실패했습니다'}(${message}). 다음 자동 되살리기 주기(약 1분)가 살립니다. 안 살아나면 kadan up.`, { ring: true, key: `infra-restart:${target}` }); }
      catch { alerted = false; }
      try { deps.record(entry(result, { message: String(message).slice(0, 200), ...(alerted ? {} : { notified: false }) })); } catch { /* 기록 실패는 결과를 바꾸지 않는다 */ }
      return { ok: false, code: 1, result, message: `${label} 재시작 ${result === 'unverified' ? '확인 시간 초과(모름)' : '실패'}: ${message}` };
    };

    try { deps.stop(target); } catch (error) { return fail('failed', `끄지 못함: ${error.message}`); }
    const sinceMs = now();
    let started;
    try { started = deps.start(target); } catch (error) { return fail('failed', `시작 실패: ${error.message}`); }
    if (!['started', 'restored'].includes(started)) return fail('failed', `이전 프로세스가 아직 남아 있거나 시작하지 못함(${started})`);
    const deadline = Date.now() + waitMs;
    let alive = false;
    for (;;) {
      try { alive = await deps.verify(target, sinceMs); } catch { alive = false; }
      if (alive || Date.now() >= deadline) break;
      await sleep(pollMs);
    }
    if (!alive) return fail('unverified', `${Math.round(waitMs / 1000)}초 안에 살아난 것을 보지 못함`);
    try { deps.record(entry('started')); } catch (error) { return { ok: true, code: 0, result: 'started', message: `${label} 다시 띄움(원장 기록 실패: ${error.message})` }; }
    return { ok: true, code: 0, result: 'started', message: `${label} 다시 띄움` };
  } finally { release(); }
}
