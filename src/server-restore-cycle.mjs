// Why: 감독 복원의 판단·저장 실패가 기존 기반 프로세스 되살리기를 막지 않게 한다.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {serverState, prepareServerRestore, finishServerRestore} from './server-restore.mjs';
import {writeServerSessions} from './server-sessions.mjs';

export function runServerRestoreCycle({listSessions, runBase, warn = console.error, ...options}, ops) {
  options.now ??= Date.now();
  let observation;
  try { observation = listSessions(); } catch { observation = null; }
  const state = serverState(observation);
  // 서버 관찰 외 모든 복원 준비는 기존 기반 실행 뒤다. 기반 오류는 원래대로 전달한다.
  const result = runBase({serverLoss: state === 'missing'});
  if (state === 'unknown') {
    warn('tmux 서버 존재 조회 실패 — 기반 실행만 수행, 감독 복원·세션 저장 건너뜀');
    return result;
  }
  if (state === 'present') {
    try {
      writeServerSessions(options.home, String(observation.stdout ?? '').split('\n'), options.now);
    } catch { warn('서버 세션 목록 저장 실패 — 기존 기반 실행 결과 유지'); }
    return result;
  }
  try { finishServerRestore(prepareServerRestore(options), ops); }
  catch (error) {
    // 오류 원문에는 명령·비밀값이 섞일 수 있다. 알려진 사유와 시스템 코드만 통지한다.
    const reason = error?.restoreReason ?? (error?.code ? `복원 처리 실패 (${error.code})` : '복원 처리 실패');
    const key = 'server-restore-error-' + createHash('sha256').update(reason).digest('hex');
    try {
      ops.record({kind: 'revive', reason: 'server-restore-error', by: 'autostart',
        t: new Date(options.now ?? Date.now()).toISOString(), result: 'skipped', detail: reason});
    } catch { warn('서버 복원 실패 사유 원장 기록 실패'); }
    let notify = true;
    try { notify = claimErrorNotice(options.home, key, options.now); }
    catch { warn('서버 복원 오류 알림 중복 방지 저장 실패'); }
    if (notify) {
      try { ops.notify(`감독 자동 복원 건너뜀: ${reason}. 수동 확인 필요`, {ring: true, key}); }
      catch { warn('서버 복원 실패 알림 전달 실패'); }
    }
  }
  return result;
}

// 기존 notifyUser의 키 중복 제거는 디코 전송에만 적용된다. OS 알림도 한 시간 한 번으로 제한한다.
// revive 잠금 안에서 예약하며 한 시간 안의 오류 키만 보존한다. 실패한 알림도 자동 재전송하지 않는다.
function claimErrorNotice(home, key, now) {
  const file = path.join(home, 'server-restore-errors.json');
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 첫 기록 또는 손상 */ }
  const recent = Object.fromEntries(Object.entries(previous ?? {}).filter(([name, at]) =>
    /^server-restore-error-[a-f0-9]{64}$/.test(name) && Number.isFinite(at) && now - at < 3600_000));
  if (Object.hasOwn(recent, key)) return false;
  recent[key] = now;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(home, {recursive: true, mode: 0o700});
  fs.writeFileSync(tmp, JSON.stringify(recent) + '\n', {mode: 0o600});
  fs.renameSync(tmp, file);
  return true;
}
