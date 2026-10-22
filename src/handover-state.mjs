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
            inheritedFrom: e.inheritedFrom ?? entry.from, handoverId: entry.handoverId,
            // 인계 시각을 모르면 모름(null)으로 남긴다. 원래 발령 시각으로 돌아가지 않는다(모르면 이전 세대로 보지 않음).
            ownedAt: entry.t ?? null };
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
// 업무마다 원장 전체(약 7만 건)를 훑으면 업무 수×원장 길이가 든다(2026-10-22 실측: 업무 340개에 1.4~2.5초).
// 쓰는 사건은 확정된 인계뿐이라 같은 entries 배열이면 한 번만 거르고, 원래 순서를 지켜 업무별로 재사용한다.
// 길이가 달라지면 다시 만든다(같은 배열에 사건이 덧붙은 경우).
const transferredCache = new WeakMap();
const isTransferred = e => e?.kind === 'handover' && e.phase === 'transferred';
function transferredHandovers(entries) {
  if (!Array.isArray(entries)) return [...entries].filter(isTransferred);
  const hit = transferredCache.get(entries);
  if (hit && hit.length === entries.length) return hit.transferred;
  const transferred = entries.filter(isTransferred);
  transferredCache.set(entries, { length: entries.length, transferred });
  return transferred;
}
export function effectiveWorkOwnership(work, entries) {
  const history = work.history ?? [];
  const changed = history.findLast((h, i) => i === 0 || history[i - 1].owner !== h.owner)?.at ?? work.at;
  // owner 값이 같아도 명시 재지정(ownerAssignedAt)이 있었으면 그 시각부터 책임이 다시 붙었다.
  const assigned = history.findLast(h => h.ownerAssignedAt)?.ownerAssignedAt;
  const since = assigned && (!changed || Date.parse(assigned) > Date.parse(changed)) ? assigned : changed;
  let owner = work.owner, at = since ?? null;
  const sinceMs = since ? Date.parse(since) : 0;
  for (const e of transferredHandovers(entries)) if (e.from === owner &&
    (!since || !e.t || Date.parse(e.t) >= sinceMs)) { owner = e.to; at = e.t ?? null; }
  return { owner, at };
}
export function effectiveWorkOwner(work, entries) {
  return effectiveWorkOwnership(work, entries).owner;
}
// 현재 책임 감독과 "그 이름에 책임이 마지막으로 붙은 시각"(ownedAt)을 업무에 얹는다. 이름의 세대 판정이 쓴다(owner-generation.mjs).
export function withEffectiveOwner(work, entries) {
  const { owner, at } = effectiveWorkOwnership(work, entries);
  return { ...work, owner, ownedAt: at };
}

// 열린 업무가 지금 누구 몫이고 언제부터인가(2026-10-16). 판정(watch-supervisor)과 관찰 범위(watch-scope)와
// 대시보드 이전 세대 목록(previousGenerationWorks)이 같은 답을 쓴다(2026-10-17 묶음2).
// 차례(turnOwner)가 감독 역할이면 그 역할이 몫이다. 시각은 차례가 넘어간 시각(turnAt)이고, owner와 같은 이름이면
// 책임이 마지막으로 붙은 시각이어야 하므로 turnAt과 ownedAt(같은 이름 재배정·인계) 중 늦은 쪽이다.
// 차례가 작업자면 응답 책임은 owner에게 둔다: 감독 응답 점검은 감독만 보고, 작업자는 작업자 감시가 따로 본다(잠긴 규칙 8).
// 시각 값이 없으면 업무 시각(차례) 또는 null(owner)이다.
const laterOf = (a, b) => (!b || (a && Date.parse(a) >= Date.parse(b)) ? a : b) ?? null;
// 차례 기록(turnOwner·turnAt)이 아직 유효한가(2026-10-21 같은 개념 감사 5번). 기록 뒤에 하위 실행(카드 at·runs[].at)이
// 움직였으면 지난 기록이다. 대시보드(work-dashboard)와 감시(currentResponsibility)가 같은 기준을 쓴다.
// cards를 안 주면 하위 실행을 모르는 것이라 시각만 본다.
export function lastChildAt(work, cards) {
  const byKey = new Map((cards ?? []).map(c => [c.key, c]));
  return Math.max(0, ...(work.executions ?? []).flatMap(x => {
    const card = byKey.get(x.key);
    return [Date.parse(card?.at) || 0, ...(card?.runs ?? []).map(r => Date.parse(r.at) || 0)];
  }));
}
// 'current' = 기록이 마지막 하위 실행 이후, 'stale' = 그 앞, 'unknown' = turnOwner나 유효한 turnAt이 없다.
export function turnState(work, cards) {
  if (!work.turnOwner || !Number.isFinite(Date.parse(work.turnAt))) return 'unknown';
  return Date.parse(work.turnAt) >= lastChildAt(work, cards) ? 'current' : 'stale';
}
// 대시보드는 'current'일 때만 차례 기록을 보인다(turnLabel).
export function isTurnCurrent(work, cards) {
  return turnState(work, cards) === 'current';
}

// 감시는 시각이 없는 옛 기록(unknown)은 지금처럼 turnOwner를 따르고, 지난 기록(stale)은 역할 선택에서만 무효로 본다.
// turnOwner가 owner 자신이면 무효화해도 같은 역할이라 main과 같게 둔다(since가 owner 생성 시각으로 되돌아가면 세대 판정이 바뀐다).
export function currentResponsibility(work, parents, cards = null) {
  const stale = turnState(work, cards) === 'stale' && work.turnOwner !== work.owner;
  const turn = stale ? undefined : work.turnOwner;
  if (parents?.has(turn) && (turn === work.owner || [...parents.values()].includes(turn))) {
    const turned = work.turnAt ?? work.at ?? null;
    return { role: turn, since: turn === work.owner ? laterOf(turned, work.ownedAt) : turned };
  }
  return { role: work.owner, since: work.ownedAt ?? null };
}

// 이 업무의 책임 대상 목록(역할, 시각). 지금 몫인 역할이 owner와 다르면 owner도 따로 본다.
// 감독 응답 감시 범위와 이전 세대 목록이 같은 목록으로 세대를 가른다.
export function responsibilityTargets(work, parents, cards = null) {
  const holder = currentResponsibility(work, parents, cards);
  return holder.role === work.owner ? [holder] : [{ role: work.owner, since: work.ownedAt ?? null }, holder];
}

// 중앙 카드의 담당도 과거 인계 기록을 따라간다. 이후 명시 재배정은 우선한다.
export function effectiveCardRole(card, entries, cards = null) {
  const identity = Array.isArray(cards) ? taskIdentity(cards) : cards;
  let role=card.role;
  for(const e of entries) if(e?.kind==='handover'&&e.phase==='transferred'&&e.from===role&&
    card.key&&e.taskIds?.some(id=>{const found=identity?.resolve(id);return identity?found.state==='resolved'&&found.key===card.key:id===card.key;})&&(!card.at||!e.t||Date.parse(e.t)>=Date.parse(card.at))) role=e.to;
  return role;
}
