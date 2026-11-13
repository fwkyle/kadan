// 대시보드 화면들이 함께 쓰는 도우미와 캐시(DS-1-impl: dashboard-api.mjs에서 옮김).
// WeakMap 캐시는 이 파일에만 있어서 화면 파일이 여럿이어도 하나로 유지된다.
import fs from "node:fs";
import { prepareCenterWall, registeredCenterWorks } from "../center-wall.mjs";
import { buildReviewFlows } from "../review-flow.mjs";
import { buildHumanBrief } from "../human-brief.mjs";
import { workspaceModel } from "../dashboard-workspace.mjs";
import { executionBucket, STALE_MS } from "../dashboard-execution.mjs";
import { activeHierarchyPath } from "../hierarchy-register.mjs";
import { parseHierarchy } from "../hierarchy.mjs";
import { nextTimeBoundary } from "../wall-snapshot-cache.mjs";
import { taskIdentity } from "../task-identity.mjs";
import { readMailBody } from "../ledger.mjs";
import { mailboxLetters } from "../mailbox.mjs";
import { mailStatus, listPageSize } from "../dashboard-inbox.mjs";
import { buildCardWorktimes, modelUnknownLabel } from "../card-worktime.mjs";
import { listFactsClockHigh } from "../card-list-facts.mjs";

const modelCache = new WeakMap();
const executionModelCache = new WeakMap();

// ── 조각 기억 ──
// 화면 재료의 조각마다 "직전 계산과 입력이 같으면 다시 계산하지 않는다"(이름 하나에 최신 한 벌, wallCache.memo와 같은 꼴).
// 입력은 조각이 실제로 읽는 상류 결과 객체 그 자체다(카드 목록·원장 사건 배열·업무 목록 등). 상류 기억(wallCache)은 내용이
// 같은 동안 같은 객체를 돌려주고, 키가 없어(저장소 없는 홈·시험) 매번 새로 만든 객체는 늘 빗나가 매번 계산한다.
// 수집 종류(listOnly·summaryBodies)나 업무 포함 여부가 달라도, 읽는 객체가 같을 때만 같은 값을 받는다.
// until(계산 시각, 값): 값이 달라질 수 있는 가장 이른 시각(ms). 그 시각부터는 입력이 같아도 다시 계산한다.
// 시계가 계산 시각보다 앞으로 돌아가도 다시 계산한다. 원장 밖 입력(역할 생존 목록·감시 현황·설정·결과 파일)을 읽는
// 계산은 조각에 넣지 않는다. 한 조각이 기억하는 것은 최신 한 벌뿐이라 원장이 커져도 기억 크기는 한 세대 몫이다.
// 시계 역행 구간: 지금 시계가 이 프로세스에서 카드 사실을 적용한 시계의 최고점(listFactsClockHigh)보다 앞이면
// 기억을 읽지도 쓰지도 않는다(기억을 끈 계산과 같은 길). 카드의 "지금보다 뒤인 시각" 목록은 적용 시각 기준이라
// 그 구간에서는 다음 시각 경계를 믿을 수 없다. 최고점은 조각을 부른 시각이 아니라 사실을 적용한 쪽에서 얻는다:
// 수집은 조각 없이도 돌기 때문이다(미리 수집·화면 재료 없는 주소). 시계가 최고점을 다시 지나면 평소대로 돈다.
const pieces = new Map();
const pieceCounts = {};
let piecesOn = true;
const sameInputs = (a, b, same) =>
  a.length === b.length && a.every((value, i) => (same?.[i] ?? Object.is)(value, b[i]));
export function piece(name, inputs, compute, { until = null, same = null } = {}) {
  // hit: 재사용, miss: 기억을 켠 채 계산, off: 기억 없이 계산(끈 경우와 시계 역행 구간).
  const counts = (pieceCounts[name] ??= { hit: 0, miss: 0, off: 0 });
  const now = Date.now();
  if (!piecesOn || now < listFactsClockHigh()) {
    counts.off++;
    return compute();
  }
  const hit = pieces.get(name);
  if (hit && now >= hit.at && (hit.until === null || now < hit.until) && sameInputs(hit.inputs, inputs, same)) {
    counts.hit++;
    return hit.value;
  }
  counts.miss++;
  const value = compute();
  pieces.set(name, { inputs, value, at: now, until: until ? until(now, value) : null });
  return value;
}
// 시험·측정용: 기억을 끄고 켜거나(끄면 기억을 읽지도 쓰지도 않고 매번 계산한다) 조각별 재사용 횟수를 본다.
// 운영 설정으로 내보내지 않는다.
export const dashboardPieces = {
  enable(on) { piecesOn = Boolean(on); },
  clear() { pieces.clear(); },
  counts: () => JSON.parse(JSON.stringify(pieceCounts)),
  values: () => new Map([...pieces].map(([name, slot]) => [name, slot.value])),
};
// 두 시각 경계 중 이른 쪽(null은 경계 없음).
export const earlier = (a, b) => (a === null ? b : b === null ? a : Math.min(a, b));
// 실행 묶음(executionBucket)은 확인 필요 실행의 마지막 신호(signalAt)가 24시간(STALE_MS)이 되는 순간
// '지금 막힌 것'에서 '오래된 미확정'으로 바뀐다. 행 목록에서 그 다음 시각을 구한다(업무 행도 넣어 넉넉히 잡는다).
export function staleBoundary(rows, now) {
  let next = Infinity;
  for (const row of rows) {
    if (row.healthKind !== "attention") continue;
    const t = Date.parse(row.signalAt) + STALE_MS;
    if (t > now && t < next) next = t;
  }
  return next === Infinity ? null : next;
}
// 설명 입력은 수집마다 새 Map이다. 바뀌지 않은 설명 줄·결정 줄은 판독기가 같은 객체로 돌려주므로
// (dashboard-brief-reader.mjs·dashboard-decisions.mjs) 줄 객체가 모두 같은지로 견준다.
const sameStored = (a, b) => {
  if (a === b) return true;
  if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
  for (const [key, value] of a) {
    const other = b.get(key);
    if (!other || other.brief !== value.brief || other.error !== value.error) return false;
  }
  return true;
};
const sameDecisions = (a, b) => {
  if (a === b) return true;
  if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
  for (const [key, list] of a) {
    const other = b.get(key);
    if (!other || other.length !== list.length || list.some((row, i) => row !== other[i])) return false;
  }
  return true;
};
// 관계표. 경로는 원장의 마지막 hierarchy-loaded 사건이 정하고(원장이 같으면 같다), 내용은 원장 밖 파일이라 매번 읽는다.
// 파일 글이 직전과 같으면 같은 객체를 돌려줘, 관계표를 입력으로 쓰는 조각이 관계표가 바뀐 때만 다시 계산한다.
// 결과는 readActiveHierarchy와 같다(읽기·해석 실패는 null).
function activeHierarchy(entries) {
  const file = piece("hierarchy-path", [entries, entries.length], () => activeHierarchyPath(entries));
  if (!file) return null;
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  return piece("hierarchy", [text], () => {
    try { return Object.freeze(Object.fromEntries(parseHierarchy(JSON.parse(text)))); } catch { return null; }
  });
}
export const pick = (value, keys) =>
  Object.fromEntries(keys.map((key) => [key, value[key] ?? null]));
const rowFields =
  "key workKey workType id kind repo title originalTitle state stateLabel stored board owner at reportAt reportLabel model modelTitle effort purpose scope summary next turnLabel turnReason turnSource flowLabel flowTitle flowPhase rallyStep difficulty healthKind healthLabel healthReason signalAt signalLabel revision parentWorkKey bucket workMs workBasis waitMs closeMs reworks profile modelState".split(
    " ",
  );
// 카드별 작업 시간·실제 모델. 원장 색인을 수집당 한 번만 만든다(요청·화면마다 다시 계산하지 않는다).
const worktimeCache = new WeakMap();
export function worktimes(snapshot) {
  let value = worktimeCache.get(snapshot);
  if (!value) {
    const cards = snapshot.center.cards, entries = snapshot.entries || [];
    value = piece("worktimes", [cards, entries, entries.length], () => buildCardWorktimes(cards, entries));
    worktimeCache.set(snapshot, value);
  }
  return value;
}
// 목록 칸에 싣는 값. 모델은 그 카드를 시작한 세션의 실행 명령으로 판정한 값이고, 끝난 카드도 말한다.
// 시작·결과가 아직 없는 카드는 판정하지 않고 기존 값(진행 중 역할의 현재 모델)을 그대로 둔다.
function runFields(w) {
  if (!w) return {};
  const fields = { workMs: w.workMs, workBasis: w.basis, waitMs: w.waitMs, closeMs: w.closeMs, reworks: w.reworks, profile: w.profile };
  const m = w.model;
  if (m.state === "known")
    return { ...fields, modelState: "known", model: m.model.split("/").at(-1), effort: m.effort,
      modelTitle: [m.harness, m.model, m.effort ? "강도 " + m.effort : "", "시작 명령 기준"].filter(Boolean).join(" · ") };
  if (w.startAt == null && w.resultAt == null) return fields;
  return { ...fields, modelState: "unknown", model: "", effort: "", modelTitle: modelUnknownLabel(m.reason) };
}
export function model(snapshot, includeWorks = true) {
  const cache = includeWorks ? modelCache : executionModelCache;
  const cached = modelCache.get(snapshot) || cache.get(snapshot);
  if (cached) return cached;
  if (snapshot.centerError || !snapshot.center)
    throw new Error(snapshot.centerError || "카드 상태를 읽을 수 없습니다");
  // 같은 수집 결과를 다시 쓰는 동안(최대 cacheSec) 이 재료가 언제 것인지. 현황의 시각 조각이 견준다(status.mjs).
  const builtAt = Date.now();
  const { works, workError } = includeWorks ? prepareCenterWall(snapshot) : registeredCenterWorks(snapshot);
  const center = snapshot.center,
    cards = center.cards,
    inputs = snapshot.briefInputs;
  // 설명 요약·실행 목록 재료는 카드에 적힌 시각이 "지금보다 뒤인가"만 본다(보고·발령·배정·활동 시각).
  // 그 시각 가운데 가장 이른 것(nextTimeBoundary)이 지나기 전까지는 값이 같다. 끝난 카드도 같은 규칙이다.
  const cardTimes = { until: (now) => nextTimeBoundary(cards, now) };
  const briefs = inputs
    ? piece("briefs", [cards, inputs.stored, inputs.readError, inputs.decisions],
        () => buildHumanBrief(center, snapshot.home, inputs),
        { ...cardTimes, same: [Object.is, sameStored, Object.is, sameDecisions] })
    : buildHumanBrief(center, snapshot.home, inputs);
  const byKey = piece("by-key", [cards], () => new Map(cards.map((c) => [c.key, c]))),
    times = worktimes(snapshot);
  const base = piece("workspace-rows", [cards, center.models, briefs], () => workspaceModel(center, briefs), cardTimes);
  const review = piece("review-flows", [cards], () => {
    const reviewFlows = buildReviewFlows(cards);
    return { reviewFlows, reviewByCard: new Map(reviewFlows.flatMap(flow => flow.cardKeys.map(key => [key, flow]))) };
  });
  const { reviewFlows, reviewByCard } = review;
  // 행은 만든 뒤 고치지 않는다(얼려 둔다). 화면들은 걸러 낸 사본만 고친다.
  const rows = piece(includeWorks ? "rows" : "rows-executions", [works, base, byKey, times, reviewByCard], () => {
    const parent = new Map(
      (works || []).flatMap((w) => w.executions.map((e) => [e.key, includeWorks ? w.key : "work:" + w.key])),
    );
    const list = [
      ...(includeWorks ? works || [] : []).map((w) => pick(w, rowFields)),
      ...base.map((r) =>
        pick(
          {
            ...r,
            kind: "execution",
            workType: byKey.get(r.key).workType,
            parentWorkKey: parent.get(r.key) || "",
            revision: byKey.get(r.key).revision,
            bucket: executionBucket({ ...byKey.get(r.key), ...r }),
            ...runFields(times.get(r.key)),
          },
          rowFields,
        ),
      ),
    ];
    for (const row of list) {
      row.reviewLabel = reviewByCard.get(row.key)?.summary || "";
      Object.freeze(row);
    }
    return Object.freeze(list);
  }, { until: (now, list) => staleBoundary(list, now) });
  const result = {
    rows,
    works,
    workError,
    briefs,
    cards,
    byKey,
    reviewFlows,
    reviewByCard,
    identity: taskIdentity(cards),
    hierarchy: activeHierarchy(snapshot.entries || []),
    builtAt,
  };
  cache.set(snapshot, result);
  return result;
}
export const compact = (row) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      ["scope", "summary", "purpose", "next"].includes(key) &&
      typeof value === "string"
        ? value.slice(0, 220)
        : value,
    ]),
  );
export const page = (rows, url, key = "page") => {
  const pages = Math.max(1, Math.ceil(rows.length / listPageSize)),
    current = Math.min(
      pages,
      Math.max(1, Number.parseInt(url.searchParams.get(key), 10) || 1),
    );
  return {
    items: rows.slice((current - 1) * listPageSize, current * listPageSize),
    page: current,
    pages,
    total: rows.length,
    pageSize: listPageSize,
  };
};
export function letters(snapshot) {
  if (
    snapshot.ledgerLines === null ||
    (snapshot.entries || []).some((e) => e.broken)
  )
    throw new Error("원장 확인 불가 · 우편 상태 모름");
  return mailboxLetters(snapshot.entries || []);
}
export function mailRow(m, identity) {
  const target = identity.resolve(
    m.completion ? m.completionTaskId || m.executionKey : m.taskId || m.executionKey,
    m.executionKey,
  );
  return {
    ...pick(m, [
      "mailId",
      "digest",
      "t",
      "by",
      "role",
      "currentSender",
      "currentRecipient",
      "preview",
      "replyStatus",
      "read",
      "replyTo",
      "workKey",
      "executionKey",
      "taskId",
      "completionTaskId",
    ]),
    status: mailStatus(m),
    card: target.state === "resolved"
      ? { key: target.key, title: target.card.title || target.key }
      : null,
  };
}
export function bodyOf(snapshot, m) {
  try {
    return snapshot.home && m.digest
      ? readMailBody(m.digest, snapshot.home)
      : null;
  } catch {
    return null;
  }
}
