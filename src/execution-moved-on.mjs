// 넘어간 실행 표시(2026-10-19). 확인 필요 실행이 '지금 막힘'이 아니라 오래된 미확정으로 가야 하는 두 경우를 가린다.
//   role  — 그 역할의 가장 최근 발령이 다른 실행이다(역할이 다음 일로 넘어감).
//   round — 같은 업무에 더 뒤 라운드의 실행이 있다.
// 담당 세션이 살아 있어도 마찬가지다. 지금 발령된 실행은 어느 쪽도 아니라서 진짜 막힘은 그대로 남는다.
const sentAt = card => Math.max(0, ...(card.runs ?? []).filter(r => r.role === card.role).map(r => Date.parse(r.sentAt) || 0));

export function movedOnReasons(cards) {
  const executions = cards.filter(c => c.workType !== 'coordination');
  const newest = new Map();
  for (const c of executions) {
    const at = sentAt(c);
    if (at && c.role && at > (newest.get(c.role)?.at ?? 0)) newest.set(c.role, {at, key: c.key});
  }
  const topRound = new Map();
  for (const c of executions) {
    const round = Number(c.rallyRound);
    if (c.rallyId && Number.isFinite(round)) {
      const group = `${c.repo}/${c.rallyId}`;
      topRound.set(group, Math.max(round, topRound.get(group) ?? -Infinity));
    }
  }
  const reasons = new Map();
  for (const c of executions) {
    const at = sentAt(c), top = newest.get(c.role);
    if (at && top && top.key !== c.key && top.at > at) { reasons.set(c.key, 'role'); continue; }
    const round = Number(c.rallyRound);
    if (c.rallyId && Number.isFinite(round) && topRound.get(`${c.repo}/${c.rallyId}`) > round) reasons.set(c.key, 'round');
  }
  return reasons;
}
