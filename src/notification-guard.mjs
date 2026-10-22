// 입력 보호·tmux 복사 모드 때문에 본문을 보내기 전에 멈춘 경우만 다음 감시 주기에 다시 확인한다.
// 서버 응답 유실·PID 변경·기록 실패는 재전송 근거가 아니다.
// 사람 입력 보호 시간의 이력(근거는 git log):
//  - 2026-09-23 [kyle] c4749bb: 10분 → 30초. 계속 대화하는 창의 질문 알림이 너무 늦어서였다.
//  - 2026-10-17 5f68368: 입력창 글 모양 판정을 없애고 최근 키 입력 시각 하나로 통일했다.
//  - 2026-10-22 사고: 다른 저장소의 슈퍼감독 창에서 kyle이 한글을 쓰다 30초 넘게 멈춘 틈(01:46:55)에 미확인 우편 재알림이 끼어들었다.
//  - 2026-10-22 [kyle]: `--profile super`로 시작한 역할 창만 2분. 작업자·일반감독은 30초 그대로다.
//  - 2026-10-22 [kyle] 결정 B: 5번 연속 밀린 강제 넣기도 슈퍼감독 창은 마지막 입력 뒤 30초는 기다린다(60초마다 치면 강제가 2분 보호를 넘어서).
export const HUMAN_IDLE_MS = 30_000;
export const SUPER_HUMAN_IDLE_MS = 120_000;

// 입력 보호 시간을 고르는 곳은 여기 하나다. 기준은 start 기록의 roleProfile이다(관계표 위치로 넓히지 않는다).
// 시작 기록이 없거나 프로필을 모르면 30초다.
export function humanIdleMsFor(start) {
  return start?.roleProfile === 'super' ? SUPER_HUMAN_IDLE_MS : HUMAN_IDLE_MS;
}

// 5번 연속 밀려 강제로 넣는 차례에도 슈퍼감독 창(보호가 30초보다 긴 창)은 마지막 사람 입력 뒤 30초는 기다린다
// (2026-10-22 [kyle] 결정 B). 보호가 30초인 창(작업자·일반감독·모름)은 지금처럼 입력 보호를 건너뛰므로 null이다.
// 강제 차례의 입력 보호 시간은 이 함수만 고른다(감시 사전 확인·tmux 두 검사·herdr가 모두 여기를 거친다).
export function forcedIdleMsFor(humanIdleMs) {
  return Number.isFinite(humanIdleMs) && humanIdleMs > HUMAN_IDLE_MS ? HUMAN_IDLE_MS : null;
}

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
