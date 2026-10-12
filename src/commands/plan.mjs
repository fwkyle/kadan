// kadan plan (HW-3-impl: cli.mjs에서 옮김)
import { die } from "../cli-basics.mjs";
import { parsePlanCard, planCards } from "../cli-wait-done.mjs";

export function cmdPlan(argv, flags = {}) {
  const [board, ...taskIds] = argv;
  if (!board || taskIds.length === 0) {
    die('사용법: kadan plan <판> [--about "<판 설명>"] <카드id[:제목]>...', 2);
  }
  const about = typeof flags.about === "string" ? flags.about : null;
  planCards({ board, taskIds, about });
  const shown = taskIds
    .map(parsePlanCard)
    .map(card => (card.title ? `${card.taskId}(${card.title})` : card.taskId))
    .join(", ");
  console.log(`계획됨: 판=${board}${about ? ` 설명=${about}` : ""} 카드=${shown}`);
}
