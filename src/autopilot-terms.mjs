// Autopilot(자리를 비울 때 맡기는 장치)의 저장 값과 화면·문구 표기. 이름은 여기 한 곳에서만 정하고 다른 파일은 가져다 쓴다
// (2026-11-10 kyle 결정: 나이트런 → Autopilot, 당번 → Wingman). 대시보드(gui/src, TypeScript)는 이 파일을 가져올 수 없어
// gui/src/autopilot-repos.ts의 LEVEL_LABEL이 같은 표기를 따로 맞춘다.

export const MODE = 'Autopilot';

// 단계. 저장 값은 소문자 영어, 화면 표기는 LEVEL_LABEL. `--level`을 안 주면 cruise다.
export const LEVEL_CRUISE = 'cruise';
export const LEVEL_AUTOPILOT = 'autopilot';
// 아직 만들지 않은 최상위 단계. 받으면 종료 코드 2로 거절한다.
export const LEVEL_FULL = 'full';
export const LEVELS = [LEVEL_CRUISE, LEVEL_AUTOPILOT];
export const LEVEL_LABEL = {[LEVEL_CRUISE]: 'Cruise', [LEVEL_AUTOPILOT]: 'Autopilot', [LEVEL_FULL]: '완전자율'};

// 경보를 사용자 대신 받는 슈퍼감독.
export const WINGMAN = 'Wingman';
export const NO_WINGMAN = '없음';
// 경보 route.basis에 적는 값.
export const WINGMAN_BASIS = 'wingman';

// 우편·기록 머리말.
export const HELD_PREFIX = `[${MODE} 보류]`;
export const DECISION_PREFIX = `[${MODE} 결정]`;

// `--allow`의 화면·문구 표기(플래그 이름은 그대로).
export const ALLOW_LABEL = '머지 허용';
