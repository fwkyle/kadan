// 카드 일시정지(hold)가 실제로 멈췄는지 화면으로 확인한다 (kadan/work-dori-lessons 항목 2).
// 코드의 알림 보류(watch-notify-hold.mjs의 held)와 다른 말이다: 여기서 hold는 카드 상태다.
// 판정은 새로 만들지 않고 감시기의 화면 읽기(readStatusLine: 일하는 표시 / 빈 입력창)를 그대로 쓴다.
// 읽기만 한다 — 세션에 아무것도 보내지 않고, hold 전환을 막지도 않는다.
import {readStatusLine} from './watch-status-line.mjs';

export const HOLD_CHECK_WORDS = Object.freeze({
  stopped: '멈춤 확인',
  working: '미확인(아직 작업 중)',
  noSession: '미확인(세션 없음)',
  unreadable: '미확인(화면 못 읽음)',
});

// floor: {list(), read(session)}. 같은 낱말 넷 중 하나를 돌려준다. 던지지 않는다.
// 입력 대기 화면도 일하는 표시도 아닌 화면(unknown)은 판단 근거가 없어 '화면 못 읽음'으로 둔다.
export function checkHoldStopped(floor, role) {
  const session = `kadan-${role}`;
  try {
    const live = floor.list().some(item => item.session === session && item.alive !== false);
    if (!live) return HOLD_CHECK_WORDS.noSession;
    const screen = floor.read(session);
    if (typeof screen !== 'string' || !screen.trim()) return HOLD_CHECK_WORDS.unreadable;
    const kind = readStatusLine(screen).kind;
    if (kind === 'idle') return HOLD_CHECK_WORDS.stopped;
    if (kind === 'working') return HOLD_CHECK_WORDS.working;
    return HOLD_CHECK_WORDS.unreadable;
  } catch {
    return HOLD_CHECK_WORDS.unreadable;
  }
}
