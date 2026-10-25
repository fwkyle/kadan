// Why: 업무 목록도 업무마다 전체 이력 객체를 보관했다(실측 업무 443개·6,494행, 한 업무 최대 469행).
// 업무 소비자가 이력에서 읽는 유한한 사실만 사건 하나씩 적용해 갱신한다. 카드 사실(card-list-facts)과 같은 규칙이다.
// 임의 시각·담당에 대한 조회(자동 왕복 종결 뒤 첫 갱신)는 사실로 들 수 없어 읽기 snapshot 안에서 따로 정한다(operations-flow).
const OPENING = ['create', 'reopen'], ENDING = ['complete', 'cancel'];

export function emptyWorkFacts() {
  return {n: 0, ownerChange: null, ownerAssignedAt: null, nextActionChange: null, opened: null, ended: null};
}

export function advanceWorkFacts(previous, previousRow, row) {
  const facts = {...(previous ?? emptyWorkFacts())};
  facts.n += 1;
  // handover-state: 마지막 담당 전환(첫 행 포함)과 마지막 명시 재지정 시각
  if (!previousRow || previousRow.owner !== row.owner) facts.ownerChange = {at: row.at};
  if (row.ownerAssignedAt) facts.ownerAssignedAt = row.ownerAssignedAt;
  // work-followup: 다음 행동 또는 차례가 실제로 바뀐 마지막 행
  if (row.nextAction && (!previousRow || row.nextAction !== previousRow.nextAction || row.turnOwner !== previousRow.turnOwner)) {
    facts.nextActionChange = {at: row.at};
  }
  // operations-flow: 마지막 열기·마지막 닫기
  if (OPENING.includes(row.action)) facts.opened = {at: row.at};
  if (ENDING.includes(row.action)) facts.ended = {at: row.at};
  return facts;
}

export function workFactsFromHistory(history) {
  let facts = null, previous = null;
  for (const row of history ?? []) {facts = advanceWorkFacts(facts, previous, row);previous = row;}
  return facts ?? emptyWorkFacts();
}

const derived = new WeakMap();
export function workFactsOf(work) {
  if (work.workFacts) return work.workFacts;
  const history = work.history ?? [];
  let facts = derived.get(history);
  if (!facts) {facts = workFactsFromHistory(history);derived.set(history, facts);}
  return facts;
}
