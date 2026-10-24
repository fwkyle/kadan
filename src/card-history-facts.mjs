// Why: 감시의 상태·질문·완료 뒤 변경 판정에 필요한 과거 사실만 보관한다.
// 원래 인접 행을 비교한다. 요약 행을 이어 붙여 새로운 전환을 만들어서는 안 된다.
export function advanceCardHistoryFacts(previousFacts, previousRow, row) {
  const facts = {...(previousFacts ?? {transition:null, question:null, answer:null, changedAt:null})};
  if (previousRow && previousRow.status !== row.status) facts.transition = {at:row.at};
  if (previousRow && (previousRow.status !== row.status || previousRow.role !== row.role)) {
    const at = Date.parse(row.at) || 0;
    facts.changedAt = facts.changedAt === null ? at : Math.max(facts.changedAt, at);
  }
  if (row.noteKind === 'question') facts.question = {revision:row.revision};
  if (row.noteKind === 'answer') facts.answer = {revision:row.revision};
  return facts;
}
