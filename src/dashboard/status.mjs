// 현황 화면과 ?super= 거름망(DS-1-impl: dashboard-api.mjs에서 옮김).
import { registeredCenterWorks } from "../center-wall.mjs";
import { isExecution } from "../human-brief.mjs";
import { boardProgressCounts } from "../board-progress.mjs";
import { renderWatchVerdict, renderWatchOverview } from "../watch-overview-wall.mjs";
import { executionBucket } from "../dashboard-execution.mjs";
import { isEnded } from "../status-labels.mjs";
import {
  failureReason,
  recentExecutionEvents,
  staleCleanupRequest,
} from "../dashboard-status.mjs";
import { isWatchRoutine } from "../ledger-table.mjs";
import {
  liveSessions,
  flowSummary,
  openAlerts,
  supervisorSummary,
  roleActivity,
} from "../dashboard-band.mjs";
import { effectiveWorkOwner, withEffectiveOwner } from "../handover-state.mjs";
import { previousGenerationExecutions, previousGenerationWorks } from "../watch-scope.mjs";
import { isDescendant } from "../hierarchy.mjs";
import { superProfiles } from "../super-role.mjs";
import { letters, pick, compact } from "./shared.mjs";

// 같은 이름을 새 대화가 다시 쓰기 전에 그 이름에 붙은 열린 업무·발령. 놀고 있음 할 일에서는 빠지지만 여기서 건수로 보인다.
// 관계표나 원장을 모르면 null(모름). 새 세대가 넘겨받으려면 기존 재배정·인계 명령을 쓴다(docs/hierarchy.md).
function previousGenerationItems(snapshot, m) {
  if (!m.hierarchy || snapshot.ledgerLines === null) return null;
  try {
    const parents = new Map(Object.entries(m.hierarchy)), entries = snapshot.entries ?? [];
    const works = (registeredCenterWorks(snapshot).works ?? []).map((w) => withEffectiveOwner(w, entries));
    return [...previousGenerationWorks(works, entries, parents), ...previousGenerationExecutions(m.cards, entries, parents, works)];
  } catch { return null; }
}
const previousSummary = (items) => items && ({
  works: items.filter((i) => i.kind === "work").length, executions: items.filter((i) => i.kind === "execution").length, items: items.slice(0, 20),
});

export function statusData(snapshot, url, stamp, m) {
  const recent = recentExecutionEvents(m.cards);
  // 워크 owner는 확정된 역할 인계를 따라 지금 책임 감독으로 센다(옛 감독 이름이면 슈퍼감독별 현황·?super=에서 빠졌다, PR #99 검수 2).
  const currentOwner = new Map((registeredCenterWorks(snapshot).works ?? []).map((w) => [`work:${w.key}`, effectiveWorkOwner(w, snapshot.entries ?? [])]));
  const statusWorks = m.rows.filter((r) => r.kind === "work").map(compact).map((w) => (currentOwner.has(w.key) ? { ...w, owner: currentOwner.get(w.key) } : w));
  const openDecisions = snapshot.decisionError ? null : (snapshot.decisions || []).filter((d) => d.status === "open");
  // 상단 띠의 나머지 세 질문. 세션 상태·원장을 모르면 null이다(dashboard-band.mjs).
  const live = liveSessions(snapshot.center);
  // 화면에는 최근 20건만 보이지만 슈퍼감독별 묶기는 열린 경보 전부로 센다.
  const allAlerts = snapshot.ledgerLines === null ? null : openAlerts(snapshot.entries || [], { limit: Infinity });
  const alerts = allAlerts && { count: allAlerts.count, items: allAlerts.items.slice(0, 20) };
  const statusRows = m.rows
    .filter(
      (r) =>
        r.kind !== "work" &&
        isExecution(r) &&
        // 보류(archived)는 진행 전으로 남긴다. HTML 현황·판 막대와 같은 기준(2026-10-05 [kyle]).
        !isEnded(r.state),
    )
    .map((r) =>
      r.bucket === "stuck" || r.bucket === "stale"
        ? { ...r, failureReason: failureReason(m.byKey.get(r.key) || {}) }
        : r,
    )
    .map(compact);
  // 원장을 못 읽으면 프로필을 모르므로 예전 기준(상위가 @user)으로 돌아간다(super-role.mjs).
  const profiles = snapshot.ledgerLines === null ? null : superProfiles(snapshot.entries || []);
  const supervisors = supervisorSummary({ hierarchy: m.hierarchy, rows: statusRows, works: statusWorks, decisions: openDecisions, alerts: allAlerts, live, profiles });
  // ?super=<역할>: 그 슈퍼감독 몫만. 감독(AI)이 경보를 받고 행동 전에 자기 판의 지금 상태를 작게 읽는 용도(2026-10-05 [kyle]).
  // 사람 화면과 같은 계산을 쓰고, 담당·요청자·수신자를 사슬 끝으로 올려 거른다.
  const previousItems = previousGenerationItems(snapshot, m);
  const superFilter = url.searchParams.get("super");
  if (superFilter) {
    if (!supervisors) throw Object.assign(new Error("관계표를 읽지 못해 슈퍼감독별로 거를 수 없습니다"), { status: 400 });
    const parents = new Map(Object.entries(m.hierarchy));
    const item = supervisors.items.find((s) => s.super === superFilter);
    if (!item) throw Object.assign(new Error(`슈퍼감독(--profile super)으로 시작한 역할이 아님: ${superFilter}`), { status: 400 });
    // 요약 목록의 행은 가장 가까운 슈퍼 조상에 한 번만 묶지만, ?super=는 X 자신과 X 아래 전부(하위 슈퍼감독의 몫 포함)를 돌려준다.
    const mine = (role) => isDescendant(role, superFilter, parents);
    const myAlerts = (allAlerts?.items ?? []).filter((a) => mine(a.recipient));
    return {
      ...stamp,
      super: superFilter,
      supervisor: item,
      // 감독 AI가 경보마다 읽으므로 작게 준다(PR #99 검수 3: 거른 뒤에도 행 32 × 칸 47로 약 81KB였다).
      // 지금 손댈 실행(작업중·막힘)만 판단에 필요한 칸으로, 나머지(오래된 미정리·진행 전·일시정지)는 수만. 결과 대기는 작업중에 합쳐 센다(#102).
      counts: Object.fromEntries(["running", "stuck", "stale", "planned", "hold"].map((b) => [b, statusRows.filter((r) => mine(r.owner) && r.bucket === b).length])),
      rows: statusRows.filter((r) => mine(r.owner) && ["running", "stuck"].includes(r.bucket))
        .map((r) => pick(r, ["key", "title", "owner", "bucket", "healthLabel", "signalAt", "failureReason", "next"])),
      works: statusWorks.filter((w) => mine(w.owner) && ["running", "hold"].includes(w.state))
        .map((w) => pick(w, ["key", "title", "owner", "state", "turnLabel", "next"])),
      decisions: openDecisions === null ? null : openDecisions.filter((d) => mine(d.requestedBy)),
      previousGeneration: previousSummary(previousItems?.filter((i) => mine(i.role)) ?? null),
      alerts: allAlerts === null ? null : { count: myAlerts.length, items: myAlerts.slice(0, 20) },
      recent: recent.filter((e) => mine(e.role)).slice(0, 20).map((e) => ({ ...pick(e, ["at", "kind", "label", "role"]), card: pick(e.card, ["key", "title"]) })),
    };
  }
  return {
    ...stamp,
    works: statusWorks,
    cleanupRequest: staleCleanupRequest(
      m.cards.filter((c) => isExecution(c) && executionBucket(c) === "stale"),
    ),
    rows: statusRows,
    resources: snapshot.resources,
    resourceError: snapshot.resourceError,
    workError: m.workError,
    executionCount: m.cards.filter(isExecution).length,
    waitingQuestions: (() => {
      try { return letters(snapshot).filter(letter => letter.replyStatus === "waiting").length; }
      catch { return null; }
    })(),
    boards: snapshot.center.boards.map((b) => ({
      name: b.name,
      state: b.state,
      ...boardProgressCounts(b, { buckets: true }),
      watchHtml: renderWatchOverview(snapshot.center, b),
    })),
    watchHtml: renderWatchVerdict(snapshot.center, {
      runtime: snapshot.runtime,
    }),
    decisions: openDecisions,
    previousGeneration: previousSummary(previousItems),
    live,
    flow: flowSummary(m.reviewFlows),
    alerts,
    // 슈퍼감독마다 한 줄(관계표 기준). 관계표를 모르면 null.
    supervisors,
    // 전략 맵이 역할을 슈퍼감독 기지로 묶는 데 쓴다(2026-10-05). 관계표를 모르면 null.
    hierarchy: m.hierarchy ?? null,
    // 담당별 최근 1시간 활동(5분 칸 12개). 활동 그래프 재료(2026-10-07).
    activity: roleActivity(snapshot.entries, { skip: isWatchRoutine }),
    recentCounts: Object.fromEntries(["done", "failed", "send"].map(kind => [kind, recent.filter(event => event.kind === kind).length])),
    recent: recent
      .slice(0, 50)
      .map((e) => ({
        ...pick(e, ["at", "kind", "label", "role"]),
        card: pick(e.card, ["key", "title"]),
      })),
  };
}
