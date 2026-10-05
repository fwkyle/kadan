// 현황 상단 띠: 다섯 질문에 숫자 하나씩 답한다. 화면은 이 결과를 그대로 그린다.
// (1) 지금 도는가 → 작업 중, (2) 막혔는가 → 지금 막힌 것 + 열린 경보, (3) 내 결정이 있는가,
// (4) 흐름대로 가는가 → 연결 확인이 필요한 묶음, (5) 어느 모델인가 → 살아 있는 담당과 모델.
export type LiveSession = { role: string; harness: string | null; model: string | null; effort: string | null; pidState: string | null };
export type FlowSummary = { total: number; unconfirmed: { id: string; title: string; label: string; warnings: string[] }[] };
export type OpenAlerts = { count: number; items: { id: string; kind: string; level: string; role: string; session: string; recipient: string; at: string }[] };
export type BandInput = {
  decisions: number | null;
  stopped: number;
  running: number;
  alerts: OpenAlerts | null;
  flow: FlowSummary;
  live: LiveSession[] | null;
};
export type Chip = { kind: "decision" | "attn" | "run" | "flow" | "live"; href: string; num: number | "모름"; label: string; on: boolean; title: string };

export function bandChips(input: BandInput): Chip[] {
  const alertCount = input.alerts?.count ?? 0;
  const attn = input.stopped + alertCount;
  const liveCount = input.live === null ? "모름" : input.live.length;
  const models = input.live === null ? [] : [...new Set(input.live.map((s) => s.model).filter((m): m is string => !!m))];
  return [
    { kind: "decision", href: "#status-decisions", num: input.decisions ?? "모름", label: "내 결정 대기", on: (input.decisions ?? 0) > 0,
      title: "슈퍼감독이 사용자에게 올린 결정. 카드 상태가 아니라 내가 할 일입니다." },
    { kind: "attn", href: "#status-attention", num: attn, label: alertCount ? `지금 막힌 것 · 경보 ${alertCount}` : "지금 막힌 것", on: attn > 0,
      title: input.alerts === null ? "멈춘 실행. 감시 경보는 원장을 읽지 못해 모릅니다." : "멈춘 실행과 아직 해소되지 않은 감시 경보의 합" },
    { kind: "run", href: "#status-executing", num: input.running, label: "작업 중", on: input.running > 0,
      title: "담당이 진행 중이라고 보고했고 담당 창도 살아 있는 실행" },
    { kind: "flow", href: "#status-flow", num: input.flow.unconfirmed.length, label: "흐름 확인", on: input.flow.unconfirmed.length > 0,
      title: `티키타카 묶음 ${input.flow.total}개 중 라운드·구현·검수 연결이 깨져 집계가 안 되는 묶음` },
    { kind: "live", href: "#status-live", num: liveCount, label: models.length ? `살아 있는 담당 · 모델 ${models.length}종` : "살아 있는 담당", on: input.live !== null && input.live.length > 0,
      title: input.live === null ? "세션 상태를 지금 알 수 없습니다." : models.length ? "지금 열린 담당 창과 시작할 때 기록한 모델: " + models.join(", ") : "지금 열린 담당 창" },
  ];
}

// 담당 한 줄: 역할 · 실행기/모델/강도. 모델을 모르면 '모델 기록 없음'.
export function liveLabel(s: LiveSession): string {
  const parts = [s.harness, s.model, s.effort].filter((x): x is string => !!x);
  return parts.length ? parts.join(" · ") : "모델 기록 없음";
}
