// 감독별 칸반(보기 전용, 1단계). 실행 카드 한 장을 감독 판 하나의 세로 줄 하나에 놓는다.
// 같은 개념을 다시 정의하지 않는다: 막힘은 executionBucket의 stuck(현황 '지금 막힌 것'),
// 열린 결정은 결정 화면과 같은 status==='open', 24시간은 RECENT_MS, 상태 묶음은 statusBucket,
// 판 주인(업무 owner)은 effectiveWorkOwner를 부른 쪽에서 넘긴다. 이 파일은 순수 함수라 파일·시계를 읽지 않는다.
import { isSuperRole, nearestSuper } from "./super-role.mjs";
import { statusBucket, statusLabel } from "./status-labels.mjs";
import { RECENT_MS } from "./dashboard-execution.mjs";

export const KANBAN_LINES = [
  ["decision", "kyle 확인 필요"],
  ["review", "검수"],
  ["working", "작업중"],
  ["before", "발령 전"],
  ["done", "완료"],
];
// 완료 줄은 최신 몇 건만 보이고 나머지는 개수로 말한다(전체 현황의 접힘 규칙과 같은 크기).
export const DONE_LIMIT = 10;
export const UNLINKED = "미연결";

const bareWork = (key) => String(key ?? "").replace(/^work:/, "");
const sinceOf = (row) => row.signalAt || row.at || null;
const time = (value) => (Number.isFinite(Date.parse(value)) ? Date.parse(value) : null);

// 먼저 맞는 줄. 결정·막힘 > 검수 > 작업중 > 발령 전 > 완료. 끝난 카드는 결정이 걸려 있어도 완료다.
export function kanbanLine(row, { decided = false, now = Date.now() } = {}) {
  const bucket = statusBucket(row.state);
  if (bucket === "end") {
    const at = time(sinceOf(row));
    return at !== null && at <= now && now - at <= RECENT_MS ? "done" : null;
  }
  if (decided || row.bucket === "stuck") return "decision";
  if (bucket === "before") return "before";
  const review = row.rallyStep === "review" || row.profile === "reviewer";
  return review && row.state !== "hold" ? "review" : "working";
}

function marksOf(row, { decided }) {
  const marks = [];
  if (decided) marks.push({ kind: "decision", label: "결정 대기" });
  if (row.bucket === "stuck") marks.push({ kind: "stuck", label: "막힘" });
  if (row.bucket === "stale") marks.push({ kind: "stale", label: "오래된 미확정" });
  if (row.state === "hold") marks.push({ kind: "hold", label: "일시정지" });
  if (row.state === "archived") marks.push({ kind: "archived", label: "보류" });
  return marks;
}

// rows: 실행 카드 행(model().rows 중 실행) · works: 업무(owner는 이미 현재 책임 감독) · decisions: 결정 목록 또는 null
// hierarchy: 역할 → 상위 역할 · profiles: superProfiles() 결과 또는 null
export function buildKanban({ rows = [], works = [], decisions = [], hierarchy = null, profiles = null, now = Date.now() }) {
  const workOf = new Map();
  for (const w of works ?? []) for (const e of w.executions ?? []) workOf.set(e.key, w);
  const open = decisions === null ? [] : decisions.filter((d) => d.status === "open");
  const decidedCards = new Set(open.map((d) => d.card).filter(Boolean));
  const decidedWorks = new Set(open.map((d) => (d.work ? bareWork(d.work) : "")).filter(Boolean));
  const parents = hierarchy && typeof hierarchy === "object" ? new Map(Object.entries(hierarchy)) : null;

  const boards = new Map();
  const boardFor = (owner) => {
    const id = owner || UNLINKED;
    if (!boards.has(id)) {
      boards.set(id, {
        owner: owner || null,
        label: id,
        super: owner && parents ? nearestSuper(owner, parents, profiles) : null,
        isSuper: Boolean(owner && parents && isSuperRole(owner, parents, profiles)),
        lines: Object.fromEntries(KANBAN_LINES.map(([key]) => [key, []])),
      });
    }
    return boards.get(id);
  };

  for (const row of rows) {
    const work = workOf.get(row.key) ?? null;
    const decided = decidedCards.has(row.key) || (work !== null && decidedWorks.has(bareWork(work.key)));
    const line = kanbanLine(row, { decided, now });
    if (line === null) continue;
    // 판: 연결된 업무의 owner → 담당 역할의 관계표 부모 → 미연결. 조용히 빼지 않는다.
    const parent = row.owner && parents ? parents.get(row.owner) : null;
    const owner = work?.owner || (parent && parent !== "@user" ? parent : null);
    boardFor(owner).lines[line].push({
      key: row.key,
      title: row.title,
      role: row.owner || "",
      repo: row.repo || "",
      board: row.board || "",
      state: row.state,
      stateLabel: statusLabel(row.state),
      healthLabel: row.healthLabel || "",
      workKey: work?.key ?? null,
      workTitle: work?.title ?? null,
      marks: marksOf(row, { decided }),
      signalAt: row.signalAt || null,
      at: row.at || null,
      since: sinceOf(row),
    });
  }

  const newest = (a, b) => (time(b.since) ?? 0) - (time(a.since) ?? 0);
  const result = [...boards.values()].map((board) => {
    const lines = KANBAN_LINES.map(([key, label]) => {
      const all = board.lines[key].sort(newest);
      const cap = key === "done" ? DONE_LIMIT : Infinity;
      return { key, label, count: all.length, hidden: Math.max(0, all.length - cap), cards: all.slice(0, cap) };
    });
    return { owner: board.owner, label: board.label, super: board.super, isSuper: board.isSuper, lines };
  });
  // 감독 이름순, 미연결은 맨 아래.
  result.sort((a, b) => (a.owner === null) - (b.owner === null) || String(a.owner).localeCompare(String(b.owner), "ko"));
  return { boards: result, lines: KANBAN_LINES.map(([key, label]) => ({ key, label })), doneWindowMs: RECENT_MS, doneLimit: DONE_LIMIT };
}
