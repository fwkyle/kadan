// Autopilot(자리를 비울 때 맡기는 장치)의 저장 값과 화면·문구 표기. 이름은 여기 한 곳에서만 정하고 다른 파일은 가져다 쓴다
// (2026-11-10 kyle 결정: 나이트런 → Autopilot, 당번 → Wingman). 대시보드(gui/src, TypeScript)는 이 파일을 가져올 수 없어
// gui/src/autopilot-repos.ts의 LEVEL_LABEL이 같은 표기를 따로 맞춘다.

export const MODE = 'Autopilot';

// 단계. 저장 값은 소문자 영어, 화면 표기는 LEVEL_LABEL. `--level`을 안 주면 cruise다.
export const LEVEL_CRUISE = 'cruise';
export const LEVEL_AUTOPILOT = 'autopilot';
export const LEVEL_FULL = 'full';
// 단계는 순서다(cruise < autopilot < full). 위 단계는 아래 단계가 하는 것을 모두 한다: 기능 분기는 `level === …`가 아니라 atLeast로 한다.
export const LEVELS = [LEVEL_CRUISE, LEVEL_AUTOPILOT, LEVEL_FULL];
const RANK = {[LEVEL_CRUISE]: 0, [LEVEL_AUTOPILOT]: 1, [LEVEL_FULL]: 2};
// 모르는 값(없음 포함)은 가장 낮은 단계(권한이 늘지 않는 쪽).
export const levelRank = level => (Object.hasOwn(RANK, level) ? RANK[level] : 0);
export const atLeast = (level, min) => levelRank(level) >= levelRank(min);
// 답 없는 결정을 추천대로 진행하기까지의 기본 대기와 허용 범위(완전자율 `--decide-after`).
export const DECIDE_AFTER_DEFAULT_MS = 2 * 60 * 60 * 1000;
export const DECIDE_AFTER_MIN_MS = 30 * 60 * 1000;
export const DECIDE_AFTER_MAX_MS = 24 * 60 * 60 * 1000;
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
