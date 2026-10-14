// 카드 상태(center) 요약. `kadan tree`와 `GET /api/cards`가 같은 모양을 쓴다.
// 카드·판·역할 전체(2026-10-14 운영 실측 65MB)는 싣지 않는다. 감시기 상세는 monitoring, 카드 하나는 `kadan card show`로 본다.
export function centerSummary(c) {
  return {
    summary: c.summary,
    executionSummary: c.executionSummary,
    monitoring: c.monitoring,
    boards: c.boards.map((b) => ({ name: b.name, state: b.state, cards: b.cards.length, unregisteredRuns: b.runs.length, monitoring: b.monitoring })),
    pendingCards: c.cards
      .filter((card) => !["done", "cancelled", "superseded", "archived"].includes(card.displayState))
      .map((card) => ({ key: card.key, state: card.displayState, workType: card.workType || "execution", board: card.board, role: card.role })),
    liveRoles: c.roles.filter((r) => r.life.state === "alive").map((r) => ({ role: r.role, life: r.life })),
    unregisteredRuns: c.unregistered.length,
  };
}
