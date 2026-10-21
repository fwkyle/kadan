import {taskIdentity,taskConnectionError} from './task-identity.mjs';
import {effectiveCardRole, workEntries, responsibilityTargets} from './handover-state.mjs';
import {peerResponsibilities} from './peer-mail.mjs';
import {ownerGenerations,isPreviousOwner} from './owner-generation.mjs';

// previous를 주면 이전 세대 소속이라 거른 발령을 거기 담는다(대시보드 "이전 세대 업무" 건수, owner-generation.mjs).
function activeExecutions(cards, entries, parents, works, excludeWaiting, previous = null) {
  if (entries.some(entry => entry?.broken)) throw new Error('감시 대상 원장 읽기 실패');
  const identity=taskIdentity(cards);
  const projected = workEntries(entries,identity);
  const pending = new Map();
  for (const entry of projected) {
    if (!entry.role || !entry.taskId || entry.transport === 'mailbox' || taskConnectionError(entry)) continue;
    const key = `${entry.role}\0${entry.taskId}`;
    if (entry.kind === 'send') pending.set(key, entry);
    if (entry.kind === 'done') pending.delete(key);
  }
  const tasks = [];
  const generations = ownerGenerations(entries);
  const supervisors = new Set(parents.values());
  const inactive = new Set(works.filter(w => w.status !== 'open').flatMap(w => w.executions.map(e => e.key)));
  for (const card of cards) {
    if (card.status !== 'assigned' || card.workType === 'coordination' || inactive.has(card.key)) continue;
    const role = effectiveCardRole(card, entries,identity);
    // 이름을 추측하지 않고 실제 하위 역할을 관리하는 상위를 제외한다.
    if (!role || role === '@user' || supervisors.has(role)) continue;
    const sent = pending.get(`${role}\0${identity.taskIdFor(card)}`);
    if (!sent || !['resolved','unregistered'].includes(sent.taskConnection?.state)) continue;
    // 새 세대가 시작되기 전에 이 이름에 붙은 책임은 새 세션의 할 일이 아니다. 인계·재배정으로 새 세대 뒤에 붙었으면 현재 세대다.
    if (isPreviousOwner(generations, role, Object.hasOwn(sent, 'ownedAt') ? sent.ownedAt : sent.t)) { previous?.push({kind:'execution', key:card.key, role}); continue; }
    if (excludeWaiting && card.activity === 'waiting' && card.activityRole === role && Date.parse(card.activityAt) >= Date.parse(sent.t)) continue;
    tasks.push({kind:'send', role, taskId:identity.taskIdFor(card), ...(card.key?{executionKey:card.key}:{}), t:sent.t, ...(Object.hasOwn(sent,'ownedAt')?{ownedAt:sent.ownedAt}:{})});
  }
  return tasks;
}

// 작업자 화면 감시와 감독의 정기 응답 점검은 대기 조건이 다르다.
export function buildWatchScope(cards, entries, parents = new Map(), works = []) {
  const tasks = activeExecutions(cards, entries, parents, works, true);
  return {sessions:new Set(tasks.map(e => `kadan-${e.role}`)), entries:tasks};
}

export function buildSupervisorScope(cards, entries, parents = new Map(), works = []) {
  const active = activeExecutions(cards, entries, parents, works, false);
  const tasks = [];
  const generations = ownerGenerations(entries);
  // 사슬의 끝(상위가 @user인 최상위 감독)까지 포함한다. 최상위를 빼면 그 세션의 죽음·정체는 누구도
  // 알리지 않는 사각이 된다(2026-10-05 점검). 활성 실행이 아래에 있을 때만 대상인 규칙은 다른 감독과 같다.
  const add = (role, entry) => {
    const visited = new Set();
    while (role && role !== '@user' && !visited.has(role)) {
      visited.add(role);
      const parent = parents.get(role);
      if (!parent) break; // 관계를 모르면 옛 전역 슈퍼감독을 임의로 붙이지 않는다.
      tasks.push({...entry, subject:entry.role, role});
      if (parent === '@user') break;
      role = parent;
    }
  };
  for (const entry of active) add(parents.get(entry.role), entry);
  for (const request of peerResponsibilities(entries, parents, works, cards)) add(request.role, request);
  const sent = new Set(workEntries(entries,cards).filter(e => e.kind === 'send' && e.taskId && e.transport !== 'mailbox' && !taskConnectionError(e)).map(e => e.executionKey || e.taskId));
  for (const work of works) {
    if (work.status !== 'open' || !work.executions.some(e => sent.has(e.key))) continue;
    // 실행을 모두 끝내도 업무 최종 확인이 남으면 책임 감독은 응답 가능해야 한다.
    const opened = work.history?.findLast(e => e.action === 'reopen' || e.action === 'create');
    // 책임 대상(역할, 시각)은 이전 세대 목록과 같은 responsibilityTargets로 구한다.
    for (const {role, since} of responsibilityTargets(work, parents, cards)) {
      if (since && isPreviousOwner(generations, role, since)) continue;
      add(role, {role, taskId:`work:${work.key}`, t:opened?.at ?? null, workKey:work.key});
    }
  }
  return {sessions:new Set(tasks.map(e => `kadan-${e.role}`)), entries:tasks};
}

// 이전 세대 소속이라 할 일 계산에서 빠진 발령(대시보드에 건수로 보인다). 원장·카드는 그대로다.
export function previousGenerationExecutions(cards, entries, parents = new Map(), works = []) {
  const previous = [];
  activeExecutions(cards, entries, parents, works, false, previous);
  return previous;
}

// 이전 세대 소속이라 할 일에서 빠진 열린 업무. works는 withEffectiveOwner로 현재 책임과 ownedAt을 얹은 것이다.
// 감시 범위와 같은 책임 대상 목록을 쓴다: 대상이 모두 이전 세대일 때만 여기에 나오고, 하나라도 현재면 감시 범위에 남는다.
export function previousGenerationWorks(works, entries, parents = new Map(), cards = null) {
  const generations = ownerGenerations(entries);
  return (works ?? []).filter(w => {
    if (w?.status !== 'open') return false;
    const targets = responsibilityTargets(w, parents, cards).filter(t => parents.has(t.role));
    return targets.length > 0 && targets.every(t => t.since && isPreviousOwner(generations, t.role, t.since));
  }).map(w => ({kind: 'work', key: w.key, role: w.owner}));
}
