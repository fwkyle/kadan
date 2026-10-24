// 대시보드 화면들이 함께 쓰는 도우미와 캐시(DS-1-impl: dashboard-api.mjs에서 옮김).
// WeakMap 캐시는 이 파일에만 있어서 화면 파일이 여럿이어도 하나로 유지된다.
import { prepareCenterWall, registeredCenterWorks } from "../center-wall.mjs";
import { buildReviewFlows } from "../review-flow.mjs";
import { buildHumanBrief } from "../human-brief.mjs";
import { workspaceModel } from "../dashboard-workspace.mjs";
import { executionBucket } from "../dashboard-execution.mjs";
import { readActiveHierarchy } from "../hierarchy-register.mjs";
import { taskIdentity } from "../task-identity.mjs";
import { readMailBody } from "../ledger.mjs";
import { mailboxLetters } from "../mailbox.mjs";
import { mailStatus, listPageSize } from "../dashboard-inbox.mjs";
import { buildCardWorktimes, modelUnknownLabel } from "../card-worktime.mjs";

const modelCache = new WeakMap();
const executionModelCache = new WeakMap();
export const pick = (value, keys) =>
  Object.fromEntries(keys.map((key) => [key, value[key] ?? null]));
const rowFields =
  "key workKey workType id kind repo title originalTitle state stateLabel stored board owner at reportAt reportLabel model modelTitle effort purpose scope summary next turnLabel turnReason turnSource flowLabel flowTitle flowPhase rallyStep healthKind healthLabel healthReason signalAt signalLabel revision parentWorkKey bucket workMs workBasis waitMs closeMs reworks profile modelState".split(
    " ",
  );
// 카드별 작업 시간·실제 모델. 원장 색인을 수집당 한 번만 만든다(요청·화면마다 다시 계산하지 않는다).
const worktimeCache = new WeakMap();
export function worktimes(snapshot) {
  let value = worktimeCache.get(snapshot);
  if (!value) {
    value = buildCardWorktimes(snapshot.center.cards, snapshot.entries || []);
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
  const { works, workError } = includeWorks ? prepareCenterWall(snapshot) : registeredCenterWorks(snapshot),
    briefs = buildHumanBrief(snapshot.center, snapshot.home, snapshot.briefInputs);
  const cards = snapshot.center.cards,
    byKey = new Map(cards.map((c) => [c.key, c])),
    times = worktimes(snapshot);
  const parent = new Map(
    (works || []).flatMap((w) => w.executions.map((e) => [e.key, includeWorks ? w.key : "work:" + w.key])),
  );
  const rows = [
    ...(includeWorks ? works || [] : []).map((w) => pick(w, rowFields)),
    ...workspaceModel(snapshot.center, briefs).map((r) =>
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

  const reviewFlows = buildReviewFlows(cards);
  const reviewByCard = new Map(reviewFlows.flatMap(flow => flow.cardKeys.map(key => [key, flow])));
  for (const row of rows) row.reviewLabel = reviewByCard.get(row.key)?.summary || "";
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
    hierarchy: readActiveHierarchy(snapshot.entries || []),
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
