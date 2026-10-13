// Why: 같은 역할 이름을 새 세션이 다시 쓰면, 이름만 보고 예전 세션 앞으로 쌓인 미확인 우편이 새 세션에게 넘어갔다.
// 우편은 지우거나 읽음으로 바꾸지 않고, 계산 단계에서 "받는 이름의 어느 세대 소속인가"만 가른다.
// 세대는 원장의 start 사건으로 시작한다. 같은 정체로 이어가는 start(복원·살아 있는 세션 재사용·--inherit-mail)는
// 새 세대가 아니다. 한 역할의 첫 start는 이전 세대가 없으므로 경계가 아니다(그 전에 쌓인 우편은 첫 세대 몫).
const roleOf = e => e.role ?? String(e.session ?? '').replace(/^kadan-/, '');
const pidOf = e => e.panePid ?? e.rottiePid;

export function createMailGenerations() {
  const live = new Map(), seen = new Set(), bounds = new Map();
  const apply = (e, index) => {
    if (e?.kind === 'stop') { live.delete(e.session); return; }
    if (e?.kind !== 'start') return;
    const role = roleOf(e), previous = live.get(e.session), pid = pidOf(e);
    live.set(e.session, e);
    // 같은 pane PID로 다시 기록된 start는 살아 있는 세션 재사용이다(watch-roles.mjs 세대 판정과 같은 기준).
    const sameProcess = previous && pid != null && String(pid).trim() !== '' && String(pid) === String(pidOf(previous))
      && previous.role === e.role;
    if (e.inheritMail === true) bounds.delete(role); // 이전 세대 미확인을 명시적으로 이어받는다.
    else if (!sameProcess && !e.restoredFrom && !e.secretaryResumeSource && seen.has(role)) {
      bounds.set(role, [...(bounds.get(role) ?? []), index]);
    }
    seen.add(role);
  };
  // at 이후에 이 역할의 새 세대가 시작됐으면 그 편지는 이전 세대 소속이다.
  const isPrevious = (role, at) => (bounds.get(role) ?? []).some(index => index > at);
  return {apply, isPrevious, hasStarted: role => seen.has(role)};
}

// 이전 세대 미확인: 읽음 미확인이면서 기록용 알림이 아니고 새 세대가 시작되기 전의 편지.
export const isPreviousGenerationUnread = e => e.previousGeneration === true && e.read === false
  && !(e.notificationOnly === true || e.systemGenerated === 'task-completion');

// start 직전에 이 역할 앞으로 남은 미확인(기록용 알림 제외). 새 세대가 시작되면 이만큼이 이전 세대로 넘어간다.
export function unreadForRole(letters, role) {
  return letters.filter(e => e.currentRecipient === role && e.read === false
    && !(e.notificationOnly === true || e.systemGenerated === 'task-completion')).length;
}
