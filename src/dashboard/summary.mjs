// 요약·작업 시간·담당 세션 화면(DS-1-impl: dashboard-api.mjs에서 옮김).
import { registeredCenterWorks } from "../center-wall.mjs";
import {
  summarizeWorktimes,
  WORKTIME_PERIODS,
} from "../card-worktime.mjs";
import { liveSessions } from "../dashboard-band.mjs";
import { letters, pick, worktimes } from "./shared.mjs";

// 담당자 상태에는 창이 열려 있거나 아직 안 닫힌 카드를 맡은 담당만 보인다(2026-10-02 [kyle]).
// 창도 닫히고 맡은 카드도 끝난 담당은 숨긴다. 세션 상태를 모르면 거르지 않는다.
const CLOSED_CARD_STATES = ["done", "cancelled", "superseded", "archived"];
export function visibleSessionRoles(center) {
  if (!center.runtimeKnown) return center.roles;
  const owners = new Set(
    center.cards
      .filter((c) => c.role && !CLOSED_CARD_STATES.includes(c.displayState))
      .map((c) => c.role),
  );
  return center.roles.filter(
    (r) => r.life?.state === "alive" || owners.has(r.role),
  );
}

// 전략 맵 옆 칸의 '마지막 실행'(2026-10-25 담당자 상태 표에서 옮김). 옛 표와 같은 자료(역할의 마지막 start 줄)를,
// 옛 표가 보이던 담당 가운데 창이 닫혔거나 세션 상태를 모르는 역할에 싣는다. 살아 있는 창은 live가 이미 싣는다.
// 세션 상태를 몰라도 열린 카드를 맡은 담당으로 줄인다 — 현황은 15초마다 읽으므로 원장의 모든 역할을 싣지 않는다.
export function lastRuns(center) {
  if (!center) return {};
  const owners = new Set(
    (center.cards ?? []).filter((c) => c.role && !CLOSED_CARD_STATES.includes(c.displayState)).map((c) => c.role),
  );
  const out = {};
  for (const r of center.roles ?? []) {
    const alive = center.runtimeKnown && r.life?.state === "alive";
    if (alive || !owners.has(r.role)) continue;
    const harness = r.harness && r.harness !== "모름" ? r.harness : null;
    const model = r.model && r.model !== "모름" ? r.model : null;
    if (harness || model) out[r.role] = { harness, model };
  }
  return out;
}

export function worktimeData(snapshot, url, stamp) {
  const period = url.searchParams.get("period") || "today";
  if (!WORKTIME_PERIODS.includes(period))
    throw Object.assign(new Error("기간은 today·7d·all 중 하나입니다"), {status: 400});
  return { ...stamp, ...summarizeWorktimes(worktimes(snapshot).values(), { period }) };
}

export function summaryData(snapshot, url, stamp) {
  const { works, workError } = registeredCenterWorks(snapshot),
    cards = snapshot.center.cards,
    linked = new Set((works || []).flatMap((work) => work.executions.map((e) => e.key)));
  let waiting = null;
  try {
    waiting = letters(snapshot).filter(
      (m) => m.replyStatus === "waiting",
    ).length;
  } catch {}
  // 비서가 살아 있는지(2026-10-06 [kyle] 비서 항상 1개). 세션 상태를 모르면 null — 꺼짐으로 꾸미지 않는다.
  const live = liveSessions(snapshot.center);
  return {
    ...stamp,
    secretary: live === null ? null : live.some((s) => s.role === "비서"),
    decisions: snapshot.decisionError
      ? null
      : (snapshot.decisions || []).filter((d) => d.status === "open").length,
    waiting,
    counts: {
      work: works === null ? null : works.length,
      executions: cards.length,
      unlinked: cards.filter((card) => !linked.has(card.key)).length,
    },
    errors: [
      snapshot.error,
      snapshot.resourceError,
      workError,
      snapshot.decisionError,
    ].filter(Boolean),
  };
}

export function sessionsData(snapshot, url, stamp) {
  const roles = visibleSessionRoles(snapshot.center);
  return {
    ...stamp,
    known: snapshot.center.runtimeKnown,
    hidden: snapshot.center.roles.length - roles.length,
    roles: roles.map((r) => ({
      role: r.role,
      harness: r.harness || null,
      model: r.model || null,
      // recordedPid는 '다시 띄우기' 버튼의 세대 표시다 — 화면이 본 최근 start의 pane PID를 서버가 restart 직전 원장과 대조한다.
      life: pick(r.life || {}, ["state", "pidState", "recordedPid"]),
    })),
  };
}
