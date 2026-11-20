// 넘어간 실행 표시(2026-10-19). 확인 필요 실행이 '지금 막힘'이 아니라 오래된 미확정으로 가야 하는 두 경우를 가린다.
//   role  — 실패·세션 소실로 끝난 실행의 역할이, 그 뒤 다른 실행을 받았다(역할이 다음 일로 넘어감).
//   round — 같은 업무에 더 뒤 라운드가 이 실행이 담당에게 붙은 뒤에 실제로 발령됐다(2026-11-20).
//           더 큰 라운드가 먼저 발령된 뒤 새로 발령한 실행은, 번호만 작을 뿐 넘어간 것이 아니다.
// 애매하면 표시하지 않는다. 지금 맡은 실행의 진짜 막힘을 숨기는 쪽이 더 위험하다.
const time = value => Date.parse(value) || 0;
// 그 실행이 지금 담당에게 붙은 시각. 인계받았으면 인계 시각이고(모르면 0=모름), 아니면 발령 시각이다.
const heldAt = r => Object.hasOwn(r, 'ownedAt') ? time(r.ownedAt) : time(r.sentAt);
const ownRuns = card => (card.runs ?? []).filter(r => r.role === card.role);
const heldSince = card => Math.max(0, ...ownRuns(card).map(heldAt));
// 그 발령 행의 첫 발령 시각(0=모름). 재발령이 sentAt을 덮어도 firstSentAt은 처음 값이 남는다. 이 칸이 없는 행은 sentAt으로 본다.
const firstOf = r => Object.hasOwn(r, 'firstSentAt') ? time(r.firstSentAt) : time(r.sentAt);
// 아직 발령 전이거나 접힌 카드는 뒤 라운드로 세지 않는다. 첫 발령 시각이 하나라도 알려진 카드만 발령된 것으로 본다.
const NOT_STARTED = new Set(['draft', 'ready', 'cancelled', 'archived', 'hold', 'superseded']);
const started = card => !NOT_STARTED.has(card.status) && (card.runs ?? []).some(firstOf);
// 발령 사건이 있는 행인가. 완료(done)만 있는 행(수동 완료 등)은 sentAt·firstSentAt 칸이 아예 없다. 발령인데 시각만 모르면 칸은 있고 값이 비었다.
const dispatched = r => Object.hasOwn(r, 'firstSentAt') || Object.hasOwn(r, 'sentAt');
// 그 카드의 첫 발령 시각: 발령 행들의 첫 발령 중 가장 이른 것. 완료만 있는 행은 세지 않는다.
// 실제 발령인데 시각을 모르는 행이 하나라도 있으면 먼저인지 알 수 없으니 0(모름).
const firstSent = card => {
  const firsts = (card.runs ?? []).filter(dispatched).map(firstOf);
  return firsts.length && firsts.every(Boolean) ? Math.min(...firsts) : 0;
};
// 끝났다고 볼 근거: 지금 담당의 실행이 실패했거나 세션이 사라졌다. 결과 없이 진행 중일 수 있는 실행은 넘기지 않는다.
const ended = card => ownRuns(card).some(r => r.state === 'failed' || r.state === 'orphaned');

export function movedOnReasons(cards) {
  const executions = cards.filter(c => c.workType !== 'coordination');
  const newest = new Map();
  for (const c of executions) {
    const at = heldSince(c);
    if (at && c.role && at > (newest.get(c.role)?.at ?? 0)) newest.set(c.role, {at, key: c.key});
  }
  // 묶음별 라운드 → 그 라운드 실행들 중 가장 늦은 첫 발령 시각.
  const rounds = new Map();
  for (const c of executions) {
    const round = Number(c.rallyRound);
    if (c.rallyId && Number.isFinite(round) && started(c)) {
      const group = `${c.repo}/${c.rallyId}`;
      const byRound = rounds.get(group) ?? rounds.set(group, new Map()).get(group);
      byRound.set(round, Math.max(firstSent(c), byRound.get(round) ?? 0));
    }
  }
  // 이 실행이 담당에게 붙은 시각(at)보다 뒤에 발령된 더 큰 라운드가 있는가. at을 모르면(0) 없다고 본다.
  const laterRound = (c, round, at) => at > 0 && [...(rounds.get(`${c.repo}/${c.rallyId}`) ?? [])]
    .some(([r, first]) => r > round && first > at);
  const reasons = new Map();
  for (const c of executions) {
    const at = heldSince(c), top = newest.get(c.role);
    if (at && top && top.key !== c.key && top.at > at && ended(c)) { reasons.set(c.key, 'role'); continue; }
    const round = Number(c.rallyRound);
    if (c.rallyId && Number.isFinite(round) && laterRound(c, round, at)) reasons.set(c.key, 'round');
  }
  return reasons;
}
