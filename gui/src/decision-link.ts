import type { Decision } from "./types";
// 알림 링크(#decision-<id>)가 가리키는 결정을 화면에서 어떻게 보일지 정한다.
// form: 열린 결정이라 답하기 양식으로 바로 간다. lookup: 열린 목록에 없어 상태를 따로 조회한다.
export const linkTarget = (hash: string) =>
  hash.startsWith("#decision-") ? decodeURIComponent(hash.slice(10)) : "";
export const linkMode = (target: string, openIds: string[]): "none" | "form" | "lookup" =>
  !target ? "none" : openIds.includes(target) ? "form" : "lookup";
export const linkOutcome = (item: Decision | null | undefined): "loading" | "unknown" | "answered" | "cancelled" | "open" =>
  item === undefined ? "loading" : item === null ? "unknown" : item.status === "answered" ? "answered" : item.status === "cancelled" ? "cancelled" : "open";

// 링크 대상의 답하기 양식에 초점을 준다. 돌려주는 값은 '초점을 준 링크 대상'이다. 숨겨진(접힌) 양식은 focus()가 먹지 않으니
// activeElement가 실제로 그 칸일 때만 target을 돌려주고, 아니면 이전 값을 그대로 돌려줘 펼쳐진 뒤 다시 시도하게 한다.
export const linkFieldSelector = "input[type=radio]:checked, textarea";
type Focusable = { focus: (options?: { preventScroll: boolean }) => void };
export function focusLinkedField(
  element: { querySelector: (selector: string) => Focusable | null } | null,
  target: string,
  focusedFor: string,
  active: () => unknown,
): string {
  if (!element || !target || focusedFor === target) return focusedFor;
  const field = element.querySelector(linkFieldSelector);
  if (!field) return focusedFor;
  field.focus({ preventScroll: true });
  return active() === field ? target : focusedFor;
}
