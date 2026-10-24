import {waitingLetters} from './mailbox-queries.mjs';
import { effectiveCardRole, effectiveWorkOwner } from './handover-state.mjs';
import { isDescendant } from './hierarchy.mjs';
import { isSuperRole, superProfiles } from './super-role.mjs';

// 이름 접두사·cwd로 책임을 추측하지 않는다. start에 기록된 슈퍼 프로필을 쓰고, 프로필 기록이 없는 옛 역할만 사용자 직속 관계를 쓴다.
export function isPeerSuperMail(entries, parents, from, to) {
  if (!from || !to || from === to || ['사람', '@user', 'watch', '비서'].includes(from)
    || ['사람', '@user', 'watch', '비서'].includes(to)) return false;
  const table = parents instanceof Map ? parents : new Map(Object.entries(parents ?? {}));
  const profiles = superProfiles(entries);
  const isSuper = role => isSuperRole(role, table, profiles);
  return isSuper(from) && isSuper(to);
}

// 우편의 답변 대기를 임시 책임으로 계산한다. 실행 카드·업무 owner는 옮기거나 생성하지 않는다.
export function peerResponsibilities(entries, parents, works = [], cards = []) {
  const questions = waitingLetters(entries);
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
      peerRequest: true, mailId: q.mailId, asker: q.currentSender, activityRoles,
      linkedWorkIds: linked.map(w => `work:${w.key}`) }];
  });
}
