// Why: 대시보드에서 업무를 마감한 사람이 닫지 못한 실행 카드를 알 수 있어야 한다(2026-11-26 검수).
// 저장 뒤 알림의 문구와, 그 알림을 '닫기'까지 남길지를 한 곳에서 정한다.
import type { SaveResult } from "./resource";

type CardClose = { closed: number; failed: { key: string; reason: string }[] };

const CLOSE_FAILED = "실행 카드 닫기 실패";
const LIST_MAX = 10;

export function saveNotice(result: SaveResult["result"] & { cardClose?: CardClose }): string {
  const failed = result.cardClose?.failed ?? [];
  if (!failed.length) return "저장했습니다.";
  // 같은 이유의 카드는 한 번만 이유를 적는다. 알림 창은 줄바꿈 없이 한 문단이다.
  const byReason = new Map<string, string[]>();
  for (const { key, reason } of failed.slice(0, LIST_MAX)) byReason.set(reason, [...(byReason.get(reason) ?? []), key]);
  const listed = [...byReason].map(([reason, keys]) => `${keys.join(", ")} (${reason})`).join(" / ");
  const more = failed.length > LIST_MAX ? ` 외 ${failed.length - LIST_MAX}장` : "";
  return `업무는 저장했습니다. ${CLOSE_FAILED} ${failed.length}장: ${listed}${more}. 이유를 확인한 뒤 카드를 정리하세요.`;
}

// 닫기 실패 안내는 시간이 지나도 지우지 않는다. 마감 폼은 저장 뒤 사라져 다시 볼 곳이 없다.
export const keepsNotice = (notice: string) => notice.includes(`${CLOSE_FAILED} `);
