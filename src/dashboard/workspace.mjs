// 업무 목록·검수 결과·실행 기록 화면(DS-1-impl: dashboard-api.mjs에서 옮김).
import { readReviewResult } from "../review-flow.mjs";
import { renderCardDocument } from "../card-content.mjs";
import { RUN_STATE_LABELS } from "../decision-wall.mjs";
import {
  filterWorkspaceRows,
  sortWorkspaceRows,
  workspacePresetCounts,
} from "../dashboard-workspace.mjs";
import { pick, compact, page } from "./shared.mjs";

export function reviewResultData(snapshot, url, stamp, m) {
  const card = m.byKey.get(url.searchParams.get("card") || "");
  if (!card) throw Object.assign(new Error("카드를 찾을 수 없습니다"), {status: 404});
  const result = readReviewResult(card);
  return {...stamp, ...result, html: result.body ? renderCardDocument(result.body, card) : null};
}

export function workspaceData(snapshot, url, stamp, m) {
  const collection = url.searchParams.get("collection") || "work";
  if (["work", "unlinked"].includes(collection) && m.workError)
    throw new Error(m.workError);
  const all = m.rows.filter((r) =>
    collection === "work"
      ? r.kind === "work"
      : r.kind !== "work" && (collection !== "unlinked" || !r.parentWorkKey),
  );
  const state = { ...Object.fromEntries(url.searchParams), collection };
  const filtered = sortWorkspaceRows(
    filterWorkspaceRows(all, state).filter(
      (r) => !state.bucket || r.bucket === state.bucket,
    ),
    state.sort || "attention",
    state.dir || "desc",
  );
  const selected = page(filtered, url),
    wide = ["wall", "map"].includes(state.layout);
  return {
    ...stamp,
    ...selected,
    items: undefined,
    rows: (wide ? filtered : selected.items).map(compact),
    workRows:
      state.layout === "map"
        ? m.rows.filter((r) => r.kind === "work").map(compact)
        : undefined,
    hierarchy: m.hierarchy,
    workError: m.workError,
    presets: workspacePresetCounts(all, state),
    facets: Object.fromEntries(
      ["board", "repo", "healthLabel", "flowTitle"].map((key) => [
        key,
        [...new Set(all.map((r) => r[key]).filter(Boolean))].sort(),
      ]),
    ),
    doneButOpen: (snapshot.center.doneButOpen || []).map((c) =>
      pick(c, ["key", "title", "revision", "role", "doneAt", "doneBy"]),
    ),
  };
}

export function runsData(snapshot, url, stamp, m) {
  const rows = m.cards
    .flatMap((c) =>
      (c.runs || []).map((r) => ({ ...r, key: c.key, title: c.title })),
    )
    .concat(snapshot.center.unregistered || [])
    .sort(
      (a, b) =>
        (Date.parse(b.at || b.sentAt) || 0) -
        (Date.parse(a.at || a.sentAt) || 0),
    );
  const q = (url.searchParams.get("q") || "").toLowerCase(),
    state = url.searchParams.get("runState") || "",
    runState = Object.hasOwn(RUN_STATE_LABELS, state) ? state : "",
    searched = rows.map((r) => ({
      ...r,
      stateLabel: Object.hasOwn(RUN_STATE_LABELS, r.state) ? RUN_STATE_LABELS[r.state] : r.state || r.result || "모름",
    })).filter((r) => !q || JSON.stringify(r).toLowerCase().includes(q));
  return {
    ...stamp,
    states: Object.entries(RUN_STATE_LABELS).map(([value, label]) => ({
      value, label, count: searched.filter((r) => r.state === value).length,
    })),
    all: searched.length,
    ...page(
      searched.filter((r) => !runState || r.state === runState),
      url,
      url.searchParams.has("runPage") ? "runPage" : "page",
    ),
  };
}
