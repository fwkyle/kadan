// 감독별 칸반(보기 전용, 1단계). 실행 카드 한 장을 감독 판 하나의 세로 줄 하나에 놓는다.
// 같은 개념을 다시 정의하지 않는다: 막힘은 executionBucket의 stuck(현황 '지금 막힌 것'),
// 열린 결정은 결정 화면과 같은 status==='open', 24시간은 RECENT_MS, 상태 묶음은 statusBucket,
// 판 주인(업무 owner)은 effectiveWorkOwner를 부른 쪽에서 넘긴다. 이 파일은 순수 함수라 파일·시계를 읽지 않는다.
import { isSuperRole, nearestSuper } from "./super-role.mjs";
import { statusBucket, statusLabel } from "./status-labels.mjs";
import { RECENT_MS } from "./dashboard-execution.mjs";

export const KANBAN_LINES = [
  ["decision", "kyle 확인 필요"],
  ["merge", "머지 요청"],
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

// 머지 요청 결정: 열린 결정이고, kyle 앞이고, 질문이나 이유에 GitHub PR 주소가 있다.
// 결정 기록에 따로 필드를 두지 않고 이 세 조건으로만 가른다(우편 글에서 추측하지 않는다).
const PR_URL = /github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/g;
export function prNumbers(decision) {
  const text = `${decision?.question ?? ""}\n${decision?.reason ?? ""}`;
  return [...new Set([...text.matchAll(PR_URL)].map((m) => m[1]))];
}
export const isMergeRequest = (decision) =>
  decision?.status === "open" && decision.to === "@user" && prNumbers(decision).length > 0;
const allMerge = (list) => list.length > 0 && list.every(isMergeRequest);
const prMarks = (list) => [...new Set(list.flatMap(prNumbers))].map((n) => ({ kind: "merge", label: `PR #${n}` }));

// 먼저 맞는 줄. 열린 결정 > (끝나지 않은 카드의) 막힘 > 검수 > 작업중 > 발령 전 > 완료.
// 열린 결정은 상태·24시간·완료 상한보다 먼저다. 끝난 카드에 걸려도 kyle 확인 필요에 둔다(2라운드 F1).
// 걸린 열린 결정이 모두 머지 요청(mergeOnly)이면 kyle 확인 필요 대신 머지 요청 줄이다. 하나라도 다르면 kyle 확인 필요.
export function kanbanLine(row, { decided = false, mergeOnly = false, now = Date.now() } = {}) {
  const bucket = statusBucket(row.state);
  if (decided) return mergeOnly ? "merge" : "decision";
  if (bucket === "end") {
    const at = time(sinceOf(row));
    return at !== null && at <= now && now - at <= RECENT_MS ? "done" : null;
  }
  if (row.bucket === "stuck") return "decision";
  if (bucket === "before") return "before";
  const review = row.rallyStep === "review" || row.profile === "reviewer";
  return review && row.state !== "hold" ? "review" : "working";
}

function marksOf(row, { byCard, byWork }) {
  const marks = [];
  // 카드 결정과 업무 결정이 겹치면 두 표시를 모두 보인다(어느 결정이 걸렸는지 숨기지 않는다).
  if (byCard) marks.push({ kind: "decision", label: "결정 대기(카드)" });
  if (byWork) marks.push({ kind: "decision", label: "결정 대기(업무)" });
  if (row.bucket === "stuck") marks.push({ kind: "stuck", label: "막힘" });
  if (row.bucket === "stale") marks.push({ kind: "stale", label: "오래된 미확정" });
  if (row.state === "hold") marks.push({ kind: "hold", label: "일시정지" });
  if (row.state === "archived") marks.push({ kind: "archived", label: "보류" });
  return marks;
}

// rows: 실행 카드 행(model().rows 중 실행) · works: 업무(owner는 이미 현재 책임 감독) · decisions: 결정 목록 또는 null
// hierarchy: 역할 → 상위 역할 · profiles: superProfiles() 결과 또는 null
// lookup: 판에 올리지 않지만 결정의 출처 카드를 찾는 데 쓰는 행(조율 카드 포함). 모르면 rows만 쓴다.
export function buildKanban({ rows = [], works = [], decisions = [], hierarchy = null, profiles = null, now = Date.now(), lookup = rows }) {
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

  // 업무에 열린 결정이 걸렸는데 끝나지 않은 카드가 없으면, 가장 최근 실행 1장을 올려 판에 나타나게 한다.
  const rowsOfWork = new Map();
  for (const row of rows) {
    const w = workOf.get(row.key);
    if (w) rowsOfWork.set(w.key, [...(rowsOfWork.get(w.key) ?? []), row]);
  }
  const elevated = new Set();
  for (const [key, list] of rowsOfWork) {
    if (!decidedWorks.has(bareWork(key)) || list.some((r) => statusBucket(r.state) !== "end")) continue;
    elevated.add([...list].sort((a, b) => (time(sinceOf(b)) ?? 0) - (time(sinceOf(a)) ?? 0))[0].key);
  }

  for (const row of rows) {
    const work = workOf.get(row.key) ?? null;
    const ended = statusBucket(row.state) === "end";
    const workDecided = work !== null && decidedWorks.has(bareWork(work.key)) && (!ended || elevated.has(row.key));
    const byCard = decidedCards.has(row.key);
    const decided = byCard || workDecided;
    const attached = open.filter((d) => d.card === row.key || (workDecided && bareWork(d.work) === bareWork(work.key)));
    const line = kanbanLine(row, { decided, mergeOnly: allMerge(attached), now });
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
      marks: [...marksOf(row, { byCard, byWork: workDecided }), ...prMarks(attached)],
      decisionIds: attached.map((d) => d.id),
      signalAt: row.signalAt || null,
      at: row.at || null,
      since: sinceOf(row),
    });
  }

  // 불변식: 열린 결정은 칸반에 최소 한 장으로 보인다. 위에서 어떤 카드에도 걸리지 않은 결정은 대신 보이는 카드를 만든다.
  //  - 업무가 있으면 업무 자체(제목=업무 제목, 담당=owner, 경과=결정 요청 시각, 판=owner).
  //  - 업무가 없으면 출처 카드(조율 카드 포함)를 카드 판 규칙(관계표 부모 → 미연결)으로. 출처도 못 찾으면 키만 가진 자리표시 카드.
  const shown = new Set(rows.map((r) => r.key));
  const workByKey = new Map((works ?? []).map((w) => [bareWork(w.key), w]));
  const lookupByKey = new Map(lookup.map((r) => [r.key, r]));
  const stand = new Map();
  for (const d of open) {
    const w = d.work ? workByKey.get(bareWork(d.work)) ?? null : null;
    if (shown.has(d.card) || (w && rowsOfWork.has(w.key))) continue;
    const src = lookupByKey.get(d.card) ?? null;
    const key = w ? "work:" + bareWork(w.key) : d.card;
    if (!stand.has(key)) {
      const parent = src?.owner && parents ? parents.get(src.owner) : null;
      const owner = w ? w.owner || null : parent && parent !== "@user" ? parent : null;
      stand.set(key, {
        owner,
        card: {
          key,
          title: w ? w.title || bareWork(w.key) : src?.title || d.card,
          role: w ? w.owner || "" : src?.owner || "",
          repo: src?.repo || "",
          board: src?.board || "",
          state: w ? "work" : src?.state ?? "",
          stateLabel: w ? "업무" : src ? statusLabel(src.state) : "카드 기록 없음",
          healthLabel: "",
          workKey: w?.key ?? null,
          workTitle: w?.title ?? null,
          marks: [{ kind: "decision", label: w ? "결정 대기(업무)" : "결정 대기(카드)" }],
          decisionIds: [],
          signalAt: null,
          at: d.at || null,
          since: d.at || null,
        },
        decided: [],
      });
    }
    const entry = stand.get(key);
    entry.card.decisionIds.push(d.id);
    entry.decided.push(d);
    if (time(d.at) !== null && (time(entry.card.since) === null || time(d.at) > time(entry.card.since))) entry.card.since = entry.card.at = d.at;
  }
  for (const { owner, card, decided } of stand.values()) {
    card.marks.push(...prMarks(decided));
    boardFor(owner).lines[allMerge(decided) ? "merge" : "decision"].push(card);
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
