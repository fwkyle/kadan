import type { Row } from "./types";

// 카드 목록의 '작업 시간' 칸과 모델별 요약 표가 쓰는 표시 규칙이다. 계산은 서버(card-worktime.mjs)가 하고 여기는 글자만 만든다.

export const durationLabel = (ms?: number | null): string => {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}분`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)}시간 ${rest}분` : `${minutes / 60}시간`;
};

export const kindLabel = (step: string): string =>
  ({ all: "전체", implementation: "구현", fix: "수정", review: "검수", research: "조사", "": "종류 없음" })[step] ?? step;
export const profileLabel = (profile: string): string =>
  ({ worker: "작업자", reviewer: "검수자" })[profile] ?? profile;
export const periodLabels = [
  ["today", "오늘"],
  ["7d", "7일"],
  ["all", "전체"],
] as const;
export const unknownReasonLabel = (reason: string): string =>
  ({
    "no-anchor": "시작·배정 기록 없음",
    "no-launch": "실행 명령 기록 없음",
    restarted: "다른 모델로 재시작",
    "no-model": "명령에서 모델 못 읽음",
  })[reason] ?? reason;

export const modelLabel = (model: string | null, effort?: string): string =>
  model ? (effort ? `${model} (${effort})` : model) : "모름";

// 작업 시간 칸에 마우스를 올렸을 때 보이는 근거. 대기·마감 대기·재작업은 표를 넓히지 않고 여기서 본다.
export const workTitle = (
  row: Pick<Row, "workMs" | "workBasis" | "waitMs" | "closeMs" | "reworks">,
): string =>
  row.workMs == null
    ? "결과 등록 전이거나 시각을 계산할 수 없습니다"
    : [
        row.workBasis === "assigned"
          ? "시작 보고가 없어 배정 → 결과 등록으로 계산"
          : "첫 '작업 중' 보고 → 결과 등록",
        row.waitMs != null && `대기(배정 → 시작) ${durationLabel(row.waitMs)}`,
        row.closeMs != null
          ? `마감 대기(결과 → 완료 확정) ${durationLabel(row.closeMs)}`
          : "완료 확정 전",
        row.reworks != null && `재작업 ${row.reworks}회(앞선 라운드 수)`,
      ]
        .filter(Boolean)
        .join("\n");
