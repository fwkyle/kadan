// 일시정지 중 작업 감지 (kadan/work-dori-lessons 항목 2).
// 배정된 미완료 실행 카드가 모두 hold인 역할의 화면이 연속 2순회 '일하는 중(시계가 움직임)'이면 직속 상위에게 경보 1회.
// 감시sh만 쓴다(AI 호출 없음). 화면은 collectRoles가 이미 읽어 둔 것을 쓰므로 화면 읽기는 늘지 않는다.
// 판정은 새로 만들지 않는다: statusProgress(시계가 직전 순회와 달라야 '일하는 중') + 알림 보류(입력 보호) 여부.
// 여기서 hold는 카드 상태다. watch-notify-hold의 '알림 보류'와 섞지 않는다.
import {statusProgress} from './watch-status-line.mjs';
import {listFactsOf} from './card-list-facts.mjs';

// hold로 바꾼 직후에는 hold 우편이 그 창에 들어가며 화면이 바뀐다. 그 동안은 보지 않는다.
export const HOLD_WORKING_GRACE_MS = 3 * 60_000;
// 연속 순회 수. 시계가 직전 순회와 달라야 세므로, 처음 본 순회는 근거가 아니다.
export const HOLD_WORKING_CYCLES = 2;

const at = value => { const t = Date.parse(value); return Number.isFinite(t) ? t : 0; };

// 역할별로 '배정된 미완료 실행 카드가 모두 hold'인 역할만 고른다. 값은 가장 최근에 hold로 들어간 카드다.
// holdKey는 `카드키@역할@hold진입시각`이다. 배정 역할이 바뀌면 다른 hold라 옛 경보는 닫히고 새 역할은 처음부터 센다.
// 역할 없는 옛 형식(`카드키@시각`)은 어떤 holdKey와도 같지 않아 복원돼도 이어 붙지 않고 첫 순회에 닫힌다.
export function holdOnlyRoles(cards, supervisors = new Set()) {
  const open = new Map();
  for (const card of cards ?? []) {
    if (!card.role || card.workType === 'coordination' || supervisors.has(card.role)) continue;
    if (!['assigned', 'hold'].includes(card.status)) continue;
    open.set(card.role, [...(open.get(card.role) ?? []), card]);
  }
  const roles = new Map();
  for (const [role, list] of open) {
    if (list.some(card => card.status === 'assigned')) continue;
    let newest = null;
    for (const card of list) {
      const holdAt = at(listFactsOf(card).lastHoldEntry?.at ?? card.at);
      if (!newest || holdAt > newest.holdAt) newest = {card, holdAt};
    }
    roles.set(role, {cardKey: newest.card.key, holdAt: newest.holdAt, holdKey: `${newest.card.key}@${role}@${newest.holdAt}`});
  }
  return roles;
}

// previous: 지난 순회의 states. alerted: 경보를 낸 holdKey 집합(호출한 쪽이 순회 사이에 들고 있고, 여기서 채운다).
// observations: collectRoles의 전체 관찰(hold 역할은 작업자 범위 밖이라 workerObservations가 아니다).
export function assessHoldWorking(previous, observations, cards, {
  now, graceMs = HOLD_WORKING_GRACE_MS, isHeld = () => false, alerted = new Set(), supervisors = new Set(),
} = {}) {
  const states = new Map();
  const alerts = [];
  const targets = holdOnlyRoles(cards, supervisors);
  const active = new Set([...targets.values()].map(target => target.holdKey));
  for (const key of alerted) if (!active.has(key)) alerted.delete(key);
  for (const [role, target] of targets) {
    const session = `kadan-${role}`;
    const seen = observations.get(session);
    const emit = () => alerts.push({id: `hold-working:${target.holdKey}`, kind: '일시정지중작업', level: 'AMBER',
      role: seen?.role ?? role, session, taskId: target.cardKey, cardKey: target.cardKey, streak: HOLD_WORKING_CYCLES});
    // 세션이 사라졌으면 그 hold는 끝난 것이다. 화면만 못 읽은 순회는 끝이 아니므로 이미 낸 경보를 그대로 내보낸다.
    if (seen && seen.alive === false) { alerted.delete(target.holdKey); continue; }
    if (!seen || seen.alive !== true || seen.screen == null) {
      if (alerted.has(target.holdKey)) emit();
      continue;
    }
    const before = previous.get(session)?.holdKey === target.holdKey ? previous.get(session) : null;
    const {status, moving} = statusProgress(seen.screen, before?.clockSec ?? null);
    const skipped = now - target.holdAt < graceMs || isHeld(role);
    const streak = !skipped && moving ? (before?.streak ?? 0) + 1 : 0;
    states.set(session, {holdKey: target.holdKey, clockSec: status?.kind === 'working' ? status.clockSec : null, streak});
    // 한 번 낸 경보는 그 hold가 끝날 때까지 계속 내보낸다. 같은 id라 감시기의 중복 제거가 다시 알리지 않고,
    // hold가 끝나거나 열리면 그때 해소로 닫힌다. 새 hold(열림 → 다시 hold)는 holdKey가 달라 새 경보가 된다.
    if (streak >= HOLD_WORKING_CYCLES) alerted.add(target.holdKey);
    if (alerted.has(target.holdKey)) emit();
  }
  return {states, alerts};
}
