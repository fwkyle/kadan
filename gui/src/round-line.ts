import type { Row } from "./types";
import { durationLabel } from "./worktime.ts";

// 업무 줄 한 줄: "2라운드째 · 2시간 10분 · 검수 대기".
// 라운드와 단계 문구는 서버가 준 값 그대로이고, 경과 시간만 지금 시각으로 만든다. 시작 시각을 모르면 그 칸을 뺀다.
// 보는 기기의 시계가 서버보다 늦으면 음수가 될 수 있어 0으로 올린다.
export const roundLine = (value: NonNullable<Row["roundNow"]>, now = Date.now()): string => {
  const opened = Date.parse(value.openedAt ?? "");
  const elapsed = Number.isFinite(opened) ? durationLabel(Math.max(0, now - opened)) : null;
  return [`${value.round}라운드째`, elapsed, value.label].filter(Boolean).join(" · ");
};
