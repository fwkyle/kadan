import { createHash } from 'node:crypto';
import { HUMAN_IDLE_MS } from './notification-guard.mjs';

// Herdr 0.9.3에는 사람 입력 시각 API가 없다. 빈 입력창·대기 상태의 화면이
// 30초 이상 같을 때만 알린다. 관측 실패나 프로세스 교체 뒤에는 유예를 새로 시작한다.
// 서버의 원자적인 입력 잠금은 아니므로 실제 전송 직전에도 같은 검사를 반복한다.
export function herdrNotificationGuard(observe) {
  const quiet = new Map();
  return (session, guard = {}) => {
    let view;
    try { view = observe(session); }
    catch (error) { quiet.delete(session); throw error; }
    const now = guard.now ?? Date.now();
    const duration = Math.max(HUMAN_IDLE_MS, guard.humanIdleMs ?? HUMAN_IDLE_MS);
    if (!Number.isFinite(now) || !Number.isFinite(duration)) {
      quiet.delete(session);
      throw Object.assign(new Error('알림 미룸: 안정 시간 확인 불가'), {
        code: 'KADAN_HUMAN_ACTIVITY_UNKNOWN', delivery: 'not-sent',
      });
    }
    const signature = createHash('sha256').update(JSON.stringify([
      view.record.herdrSocket, view.pane.terminal_id, view.record.panePid,
      view.pane.pane_id, view.visible.revision, view.visible.text, view.frame.row,
    ])).digest('hex');
    let previous = quiet.get(session);
    if (!previous || previous.signature !== signature || now < previous.at) {
      previous = { signature, at: now };
      quiet.set(session, previous);
    }
    if (now - previous.at < duration) {
      throw Object.assign(new Error('알림 미룸: 빈 입력창과 대기 화면의 30초 안정 확인 중'), {
        code: 'KADAN_HUMAN_ACTIVE', delivery: 'not-sent',
      });
    }
    return view;
  };
}
