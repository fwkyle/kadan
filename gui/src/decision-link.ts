import type { Decision } from "./types";
// 알림 링크(#decision-<id>)가 가리키는 결정을 화면에서 어떻게 보일지 정한다.
// form: 열린 결정이라 답하기 양식으로 바로 간다. lookup: 열린 목록에 없어 상태를 따로 조회한다.
export const linkTarget = (hash: string) =>
  hash.startsWith("#decision-") ? decodeURIComponent(hash.slice(10)) : "";
export const linkMode = (target: string, openIds: string[]): "none" | "form" | "lookup" =>
  !target ? "none" : openIds.includes(target) ? "form" : "lookup";
export const linkOutcome = (item: Decision | null | undefined): "loading" | "unknown" | "answered" | "cancelled" | "open" =>
  item === undefined ? "loading" : item === null ? "unknown" : item.status === "answered" ? "answered" : item.status === "cancelled" ? "cancelled" : "open";
