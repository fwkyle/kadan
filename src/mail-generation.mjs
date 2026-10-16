// Why: 같은 역할 이름을 새 세션이 다시 쓰면, 이름만 보고 예전 세션 앞으로 쌓인 미확인 우편이 새 세션에게 넘어갔다.
// 우편은 지우거나 읽음으로 바꾸지 않고, 계산 단계에서 "받는 이름의 어느 세대 소속인가"만 가른다.
// 세대는 원장의 start 사건으로 시작한다. 같은 정체로 이어가는 start(복원·살아 있는 세션 재사용·--inherit-mail)는
// 새 세대가 아니다. 한 역할의 첫 start는 이전 세대가 없으므로 경계가 아니다(그 전에 쌓인 우편은 첫 세대 몫).
import {conversationOf} from './conversation-ref.mjs';
const roleOf = e => e.role ?? String(e.session ?? '').replace(/^kadan-/, '');
const pidOf = e => e.panePid ?? e.rottiePid;
// 기록 필드가 없는 옛 start는 cmd 원문에 같은 파싱을 적용한다. 원장은 고치지 않는다.
export const conversationModeOf = e => e.conversationMode ?? conversationOf(e.cmd).conversationMode;

export function createMailGenerations() {
  const live = new Map(), seen = new Set(), bounds = new Map(), boundTimes = new Map();
  const apply = (e, index) => {
    if (e?.kind === 'stop') { live.delete(e.session); return; }
    if (e?.kind !== 'start') return;
    const role = roleOf(e), previous = live.get(e.session), pid = pidOf(e);
    live.set(e.session, e);
    // 같은 pane PID로 다시 기록된 start는 살아 있는 세션 재사용이다(watch-roles.mjs 세대 판정과 같은 기준).
    const sameProcess = previous && pid != null && String(pid).trim() !== '' && String(pid) === String(pidOf(previous))
      && previous.role === e.role;
    // resume은 바로 앞 세대를 이어가고, --inherit-mail은 바로 앞 세대 하나만 이어받는다(둘 다 경계를 새로 만들지 않는다).
    // 그 앞 세대의 경계는 그대로라 두 세대 이전 우편은 끊긴 채 남는다. new·fork는 새 대화라 경계다.
    const continues = sameProcess || e.inheritMail === true || e.restoredFrom || e.secretaryResumeSource || e.restartOf
      || conversationModeOf(e) === 'resume';
    if (!continues && seen.has(role)) {
      bounds.set(role, [...(bounds.get(role) ?? []), index]);
      boundTimes.set(role, [...(boundTimes.get(role) ?? []), Date.parse(e.t)]);
    }
    seen.add(role);
  };
  // at 이후에 이 역할의 새 세대가 시작됐으면 그 편지는 이전 세대 소속이다.
  const isPrevious = (role, at) => (bounds.get(role) ?? []).some(index => index > at);
  // 책임(업무·카드 owner)은 원장 순번이 아니라 시각으로 붙는다. 같은 경계를 시각으로 비교한다(owner-generation.mjs).
  // 시각을 모르면(파싱 불가) 이전 세대로 단정하지 않는다.
  const isPreviousAt = (role, at) => {
    const ms = typeof at === 'number' ? at : Date.parse(at);
    return Number.isFinite(ms) && (boundTimes.get(role) ?? []).some(bound => bound > ms);
  };
  return {apply, isPrevious, isPreviousAt, hasStarted: role => seen.has(role), generationOf: role => (bounds.get(role) ?? []).length};
}

// 이전 세대 미확인: 읽음 미확인이면서 기록용 알림이 아니고 새 세대가 시작되기 전의 편지.
export const isPreviousGenerationUnread = e => e.previousGeneration === true && e.read === false
  && !(e.notificationOnly === true || e.systemGenerated === 'task-completion');

// start 직전에 이 역할 앞으로 남은 미확인(기록용 알림 제외). 새 세대가 시작되면 이만큼이 이전 세대로 넘어가고,
// 이어가는 start면 current=true로 지금 세대 몫만 센다(이미 끊긴 예전 세대는 이어지지 않는다).
export function unreadForRole(letters, role, {current = false} = {}) {
  return letters.filter(e => e.currentRecipient === role && e.read === false && !(current && e.previousGeneration === true)
    && !(e.notificationOnly === true || e.systemGenerated === 'task-completion')).length;
}
