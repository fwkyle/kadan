import { mailboxLetters } from './mailbox-state.mjs';
import { effectiveCardRole, effectiveWorkOwner } from './handover-state.mjs';
import { isDescendant } from './hierarchy.mjs';

// 프로필이 명시되면 윗선보다 우선한다. 향후 통합 슈퍼 아래로 옮겨도 전달 방식은 유지된다.
export function isSuperRole(entries, parents, role) {
  if (role === '비서') return true; // 담당 없는 일·여러 판 조율의 임시 전체 슈퍼감독
  const start = entries.findLast(e => e.kind === 'start' && e.role === role);
  if (start?.roleProfile) return start.roleProfile === 'super';
  const table = parents instanceof Map ? parents : new Map(Object.entries(parents ?? {}));
  // 예전 시작 기록에는 프로필이 없다. 그때만 기존 사용자 직속 기준을 유지한다.
  return table.get(role) === '@user';
}

export function isPeerSuperMail(entries, parents, from, to) {
  if (!from || !to || from === to || ['사람', '@user', 'watch'].includes(from)
    || ['사람', '@user', 'watch'].includes(to)) return false;
  return isSuperRole(entries, parents, from) && isSuperRole(entries, parents, to);
}

// 우편의 답변 대기를 임시 책임으로 계산한다. 실행 카드·업무 owner는 옮기거나 생성하지 않는다.
export function peerResponsibilities(entries, parents, works = [], cards = []) {
  const questions = mailboxLetters(entries, undefined, { view: 'waiting' });
  return questions.filter(q => !q.notificationOnly && !q.systemGenerated && q.mailId
    && isPeerSuperMail(entries, parents, q.currentSender, q.currentRecipient)
    && parents.has(q.currentRecipient)).flatMap(q => {
    const original = works.find(w => w.key === q.workKey
      || (q.executionKey && w.executions?.some(e => e.key === q.executionKey)));
    if (original && original.status !== 'open') return [];
    const linked = works.filter(w => w.mailRefs?.some(ref => ref === q.mailId || ref === q.digest)
      && isDescendant(effectiveWorkOwner(w, entries), q.currentRecipient, parents));
    if (linked.some(w => w.status === 'hold')) return [];
    const activityRoles = linked.filter(w => w.status === 'open').flatMap(w =>
      w.executions.flatMap(e => {
        const card = cards.find(c => c.key === e.key);
        if (!card || card.status !== 'assigned') return [];
        const role = effectiveCardRole(card, entries);
        return role && isDescendant(role, q.currentRecipient, parents) ? [role] : [];
      }));
    return [{ kind: 'send', role: q.currentRecipient, taskId: `mail:${q.mailId}`, t: q.t,
      peerRequest: true, mailId: q.mailId, activityRoles,
      linkedWorkIds: linked.map(w => `work:${w.key}`) }];
  });
}
