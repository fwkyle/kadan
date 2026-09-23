import {taskIdentity,taskConnectionError} from './task-identity.mjs';
// 원장 원문은 보존하고 카드 책임을 계산할 때만 확정된 인계를 반영한다.
export function workEntries(entries, cards = null) {
  const identity = Array.isArray(cards) ? taskIdentity(cards) : cards;
  if (identity) entries = identity.project(entries);
  const projected = [];
  for (const entry of entries) {
    if (entry?.kind === 'handover' && entry.phase === 'transferred') {
      const tasks = new Set(entry.taskIds);
      for (let i = 0; i < projected.length; i++) {
        const e = projected[i];
        if (!taskConnectionError(e) && e.role === entry.from && tasks.has(e.taskId) && ['send', 'done'].includes(e.kind)) {
          projected[i] = { ...e, role: entry.to, session: `kadan-${entry.to}`,
            inheritedFrom: e.inheritedFrom ?? entry.from, handoverId: entry.handoverId };
        }
      }
    }
    projected.push(entry);
  }
  return projected;
}

export function openTaskIds(entries, role, cards = null) {
  const pending = new Set();
  for (const e of workEntries(entries, cards)) {
    if (e?.role !== role || !e.taskId || taskConnectionError(e)) continue;
    if (e.kind === 'send') pending.add(e.taskId);
    if (e.kind === 'done') pending.delete(e.taskId);
  }
  return [...pending].sort();
}

// 업무 owner도 확정된 역할 인계를 따라간다. 원장의 owner 원문은 그대로 두고,
// owner를 정한 뒤에 확정된 인계만 이어서 현재 책임 감독을 계산한다(2026-09-23 감독-3→4 사고).
export function effectiveWorkOwner(work, entries) {
  const history = work.history ?? [];
  const since = history.findLast((h, i) => i === 0 || history[i - 1].owner !== h.owner)?.at ?? work.at;
  let owner = work.owner;
  for (const e of entries) if (e?.kind === 'handover' && e.phase === 'transferred' && e.from === owner &&
    (!since || !e.t || Date.parse(e.t) >= Date.parse(since))) owner = e.to;
  return owner;
}

// 중앙 카드의 담당도 과거 인계 기록을 따라간다. 이후 명시 재배정은 우선한다.
export function effectiveCardRole(card, entries, cards = null) {
  const identity = Array.isArray(cards) ? taskIdentity(cards) : cards;
  let role=card.role;
  for(const e of entries) if(e?.kind==='handover'&&e.phase==='transferred'&&e.from===role&&
    card.key&&e.taskIds?.some(id=>{const found=identity?.resolve(id);return identity?found.state==='resolved'&&found.key===card.key:id===card.key;})&&(!card.at||!e.t||Date.parse(e.t)>=Date.parse(card.at))) role=e.to;
  return role;
}
