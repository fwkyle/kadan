// Why: "몇 시간 쉬면 정리 후보인가"를 사람이 바꿀 수 있게 값 하나로 둔다. 같은 값이 같은 후보를 다시 알리는 간격이다.
// 새 저장소를 만들지 않는다: 실행 모델 설정 파일(runner-settings.json)의 칸 하나로 두고, 그 파일의 공통 변경 경로(change)를
// 그대로 써서 revision 대조·잠금·원장 사건(kind runner-settings, action idle-hours, 바꾼 사람·이유)을 얻는다.
// 읽기는 던지지 않는다: 설정 파일이 없거나 깨졌거나 값이 범위 밖이면 기본값이다(이 값 때문에 자동 주기가 멈추면 안 된다).
import {change, readSettings} from './runner-settings.mjs';

export const DEFAULT_IDLE_HOURS = 12;
export const MIN_IDLE_HOURS = 1;
export const MAX_IDLE_HOURS = 168;
export const IDLE_HOURS_ACTION = 'idle-hours';

const valid = value => Number.isInteger(value) && value >= MIN_IDLE_HOURS && value <= MAX_IDLE_HOURS;

// {hours, source: 'setting'|'default', revision}. revision은 설정 파일을 읽었을 때만 숫자다.
export function readIdleHours(home, {read = readSettings} = {}) {
  try {
    const settings = read(home);
    const value = settings?.idleRoleHours;
    return {hours: valid(value) ? value : DEFAULT_IDLE_HOURS, source: valid(value) ? 'setting' : 'default',
      revision: Number.isInteger(settings?.revision) ? settings.revision : null};
  } catch { return {hours: DEFAULT_IDLE_HOURS, source: 'default', revision: null}; }
}

// 글자("12")와 숫자를 받는다. 1~168의 정수가 아니면 거절한다.
export function parseIdleHours(raw) {
  const value = typeof raw === 'string' && /^\d{1,3}$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  if (!valid(value)) {
    throw Object.assign(new Error(`기준 시간은 ${MIN_IDLE_HOURS}~${MAX_IDLE_HOURS} 사이의 정수(시간)만 받는다: ${raw ?? '(없음)'}`), {exitCode: 2});
  }
  return value;
}

// meta: {revision, by, reason, record}. revision이 지금 값과 다르면 change가 거절한다.
export function setIdleHours(home, {hours, ...meta}) {
  const value = parseIdleHours(hours);
  return change(home, {...meta, action: IDLE_HOURS_ACTION}, next => {
    const before = valid(next.idleRoleHours) ? next.idleRoleHours : null;
    next.idleRoleHours = value;
    return {before, after: value};
  });
}
