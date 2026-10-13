// 입력 보호 때문에 본문을 보내기 전에 멈춘 경우만 다음 감시 주기에 다시 확인한다.
// 서버 응답 유실·PID 변경·기록 실패는 재전송 근거가 아니다.
export const HUMAN_IDLE_MS = 30_000;

const holdCodes = new Set([
  'KADAN_HUMAN_ACTIVE', 'KADAN_HUMAN_ACTIVITY_UNKNOWN',
  'KADAN_PANE_INPUT_PENDING', 'KADAN_PANE_INPUT_UNKNOWN', 'KADAN_PANE_STATE_UNKNOWN',
  'KADAN_HERDR_NOT_READY', 'KADAN_HERDR_INPUT_UNKNOWN', 'KADAN_HERDR_SCROLLED',
  'KADAN_HERDR_TRUST_PROMPT',
]);

export function isNotificationHold(error) {
  return error?.delivery === 'not-sent' && holdCodes.has(error.code);
}
