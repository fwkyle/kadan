// 넘어간 실행 표시(2026-10-19). 확인 필요 실행이 '지금 막힘'이 아니라 오래된 미확정으로 가야 하는 두 경우를 가린다.
//   role  — 실패·세션 소실로 끝난 실행의 역할이, 그 뒤 다른 실행을 받았다(역할이 다음 일로 넘어감).
//   round — 같은 업무에 더 뒤 라운드가 실제로 발령됐다.
// 애매하면 표시하지 않는다. 지금 맡은 실행의 진짜 막힘을 숨기는 쪽이 더 위험하다.
const time = value => Date.parse(value) || 0;
// 그 실행이 지금 담당에게 붙은 시각. 인계받았으면 인계 시각이고(모르면 0=모름), 아니면 발령 시각이다.
const heldAt = r => Object.hasOwn(r, 'ownedAt') ? time(r.ownedAt) : time(r.sentAt);
const ownRuns = card => (card.runs ?? []).filter(r => r.role === card.role);
const heldSince = card => Math.max(0, ...ownRuns(card).map(heldAt));
// 아직 발령 전이거나 접힌 카드는 뒤 라운드로 세지 않는다.
const NOT_STARTED = new Set(['draft', 'ready', 'cancelled', 'archived', 'hold', 'superseded']);
const started = card => !NOT_STARTED.has(card.status) && (card.runs ?? []).some(r => time(r.sentAt));
// 끝났다고 볼 근거: 지금 담당의 실행이 실패했거나 세션이 사라졌다. 결과 없이 진행 중일 수 있는 실행은 넘기지 않는다.
const ended = card => ownRuns(card).some(r => r.state === 'failed' || r.state === 'orphaned');

export function movedOnReasons(cards) {
  const executions = cards.filter(c => c.workType !== 'coordination');
  const newest = new Map();
  for (const c of executions) {
    const at = heldSince(c);
    if (at && c.role && at > (newest.get(c.role)?.at ?? 0)) newest.set(c.role, {at, key: c.key});
  }
  const topRound = new Map();
  for (const c of executions) {
    const round = Number(c.rallyRound);
    if (c.rallyId && Number.isFinite(round) && started(c)) {
      const group = `${c.repo}/${c.rallyId}`;
      topRound.set(group, Math.max(round, topRound.get(group) ?? -Infinity));
    }
  }
  const reasons = new Map();
  for (const c of executions) {
    const at = heldSince(c), top = newest.get(c.role);
    if (at && top && top.key !== c.key && top.at > at && ended(c)) { reasons.set(c.key, 'role'); continue; }
    const round = Number(c.rallyRound);
    if (c.rallyId && Number.isFinite(round) && topRound.get(`${c.repo}/${c.rallyId}`) > round) reasons.set(c.key, 'round');
  }
  return reasons;
}
