// 입력 보호·tmux 복사 모드 때문에 본문을 보내기 전에 멈춘 경우만 다음 감시 주기에 다시 확인한다.
// 서버 응답 유실·PID 변경·기록 실패는 재전송 근거가 아니다.
export const HUMAN_IDLE_MS = 30_000;

// KADAN_PANE_INPUT_PENDING·KADAN_PANE_INPUT_UNKNOWN은 화면 모양 판정을 없애기(2026-10-17) 전 옛 원장 기록을 표시하는 용도로만 남긴다.
const holdCodes = new Set([
  'KADAN_HUMAN_ACTIVE', 'KADAN_HUMAN_ACTIVITY_UNKNOWN',
  'KADAN_PANE_INPUT_PENDING', 'KADAN_PANE_INPUT_UNKNOWN', 'KADAN_PANE_STATE_UNKNOWN',
  'KADAN_HERDR_NOT_READY', 'KADAN_HERDR_INPUT_UNKNOWN', 'KADAN_HERDR_SCROLLED',
  'KADAN_HERDR_TRUST_PROMPT', 'KADAN_PANE_IN_MODE', 'KADAN_PANE_MODE_UNKNOWN',
]);

export function isNotificationHold(error) {
  return error?.delivery === 'not-sent' && holdCodes.has(error.code);
}

// 바로 넣지 못한 우편을 실패 대신 보관할 수 있는 경우(2026-10-21 우편 단순화): 붙이기 전에 멈춘 입력 보호 보류에
// 받는 세션 없음·PID 다름을 더한다. 역할 지침 오류·수신자 변경 같은 not-sent는 설정·주소 문제라 보관으로 덮지 않는다.
const storableMissCodes = new Set(['KADAN_SESSION_MISSING', 'KADAN_PID_MISMATCH']);

export function isStorableMailHold(error) {
  return isNotificationHold(error) || (error?.delivery === 'not-sent' && storableMissCodes.has(error.code));
}
