import type { Row } from "./types";

// 멈춘 실행을 이유별로 묶는 순수 함수 모음이다.
// 같은 원인(예: 담당 세션 죽음)이 여러 장이면 한 그룹으로 보여 주기 위함이다.

export type StopGroup = {
  key: string;
  label: string;
  desc: string;
  rows: Row[];
  firstAt?: string;
  lastAt?: string;
};

// 표시 순서: 실패가 가장 급하고, 오래된 미정리는 정리 대상이라 마지막이다.
const ORDER: Record<string, number> = {
  failed: 0,
  session: 1,
  other: 2,
  stale: 3,
};

const META: Record<string, { label: string; desc: string }> = {
  failed: {
    label: "실패 기록 있음",
    desc: "실패 기록과 후속 조치를 확인해야 합니다.",
  },
  session: {
    label: "담당 세션이 없음",
    desc: "담당 창이 확인되지 않습니다. 감독에게 일괄 확인을 요청하세요.",
  },
  stale: {
    label: "오래된 미정리",
    desc: "담당 세션이 없고 24시간 이상 신호가 없습니다. 감독이 대체·취소·일시정지로 정리해야 목록에서 빠집니다.",
  },
};

function keyOf(row: Row): string {
  if (row.bucket === "stale") return "stale";
  if ((row.healthLabel || "").includes("실패")) return "failed";
  if ((row.healthLabel || "").includes("세션")) return "session";
  return "other:" + (row.healthLabel || "모름");
}

export function groupStopped(rows: Row[]): StopGroup[] {
  const map = new Map<string, Row[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  return [...map.entries()]
    .map(([key, groupRows]) => {
      const base = key.split(":")[0];
      const meta = META[key] || {
        label: key.replace(/^other:/, ""),
        desc: "",
      };
      const times = groupRows
        .map((row) => Date.parse(row.signalAt || ""))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      return {
        key,
        label: meta.label,
        desc: meta.desc,
        rows: groupRows,
        firstAt: times.length ? new Date(times[0]).toISOString() : undefined,
        lastAt: times.length
          ? new Date(times[times.length - 1]).toISOString()
          : undefined,
        order: ORDER[base] ?? 2,
      };
    })
    .sort(
      (a, b) =>
        a.order - b.order ||
        b.rows.length - a.rows.length ||
        a.label.localeCompare(b.label, "ko"),
    )
    .map(({ order: _order, ...group }) => group);
}

// "a · b · c · d" 같은 차례 나열을 앞 max개 + "외 N"으로 줄인다.
export function shortenTurn(
  label: string | undefined,
  max = 2,
): { text: string; rest: number } {
  const parts = (label || "")
    .split(" · ")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= max + 1) return { text: parts.join(" · "), rest: 0 };
  return {
    text: parts.slice(0, max).join(" · ") + " 외 " + (parts.length - max),
    rest: parts.length - max,
  };
}

// 긴 사유 문구의 첫 줄만 최대 max자까지 보여 준다.
export function firstLine(text: string | undefined, max = 80): string {
  const line = (text || "")
    .split("\n")
    .map((s) => s.trim())
    .find(Boolean);
  if (!line) return "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

export function groupAskText(group: StopGroup): string {
  const keys = group.rows.map((row) => row.key).join(", ");
  return (
    "[대시보드 확인 요청] " +
    group.label +
    " " +
    group.rows.length +
    "건: " +
    keys +
    ". 후속 처리 방향과 근거를 확인해주세요."
  );
}
