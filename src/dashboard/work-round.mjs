// 업무 목록·현황의 업무 줄에 싣는 "지금 라운드" 칸.
// 라운드 번호와 단계 문구는 상세 라운드 표가 쓰는 같은 flow 객체에서 그대로 옮긴다(여기서 다시 판정하지 않는다).
// 업무의 실행을 최근에 연결한 것부터 보며 flow에 속한 첫 실행의 flow를 쓴다. 실행 키로 맵만 찾고 모든 flow를 훑지 않는다.
// 끝난 업무와 라운드가 없는 업무는 null이다. 경과 시간 글자는 행이 캐시되므로 화면이 openedAt으로 만든다.
const ENDED = new Set(["done", "cancelled"]);

export function workRoundNow(work, reviewByCard) {
  if (ENDED.has(work.status)) return null;
  let flow;
  for (let i = work.executions.length - 1; i >= 0 && !flow; i--)
    flow = reviewByCard.get(work.executions[i].key);
  const round = flow?.rounds.at(-1)?.number;
  if (!round) return null;
  // openedAt은 `work show`의 timing.openedAt 그대로다(마지막으로 열거나 다시 연 시각).
  return Object.freeze({ round, label: flow.label, openedAt: work.timing?.openedAt ?? null });
}
