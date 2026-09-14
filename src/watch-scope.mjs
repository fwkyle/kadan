import {taskIdentity,taskConnectionError} from './task-identity.mjs';
import {effectiveCardRole, workEntries} from './handover-state.mjs';

function activeExecutions(cards, entries, parents, works, excludeWaiting) {
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
  const supervisors = new Set(parents.values());
  const inactive = new Set(works.filter(w => w.status !== 'open').flatMap(w => w.executions.map(e => e.key)));
  for (const card of cards) {
    if (card.status !== 'assigned' || card.workType === 'coordination' || inactive.has(card.key)) continue;
    const role = effectiveCardRole(card, entries,identity);
    // 이름을 추측하지 않고 실제 하위 역할을 관리하는 상위를 제외한다.
    if (!role || role === '@user' || supervisors.has(role)) continue;
    const sent = pending.get(`${role}\0${identity.taskIdFor(card)}`);
    if (!sent || !['resolved','unregistered'].includes(sent.taskConnection?.state)) continue;
    if (excludeWaiting && card.activity === 'waiting' && card.activityRole === role && Date.parse(card.activityAt) >= Date.parse(sent.t)) continue;
    tasks.push({kind:'send', role, taskId:identity.taskIdFor(card), ...(card.key?{executionKey:card.key}:{}), t:sent.t});
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
  const add = (role, entry) => {
    const visited = new Set();
    while (role && role !== '@user' && !visited.has(role)) {
      visited.add(role);
      const parent = parents.get(role);
      if (parent === '@user') break;
      if (!parent) break; // 관계를 모르면 옛 전역 슈퍼감독을 임의로 붙이지 않는다.
      tasks.push({...entry, subject:entry.role, role});
      role = parent;
    }
  };
  for (const entry of active) add(parents.get(entry.role), entry);
  const sent = new Set(workEntries(entries,cards).filter(e => e.kind === 'send' && e.taskId && e.transport !== 'mailbox' && !taskConnectionError(e)).map(e => e.executionKey || e.taskId));
  for (const work of works) {
    if (work.status !== 'open' || !work.executions.some(e => sent.has(e.key))) continue;
    // 실행을 모두 끝내도 업무 최종 확인이 남으면 책임 감독은 응답 가능해야 한다.
    const opened = work.history?.findLast(e => e.action === 'reopen' || e.action === 'create');
    add(work.owner, {role:work.owner, taskId:`work:${work.key}`, t:opened?.at ?? null, workKey:work.key});
  }
  return {sessions:new Set(tasks.map(e => `kadan-${e.role}`)), entries:tasks};
}
