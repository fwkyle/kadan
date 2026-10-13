// 대시보드 JSON 응답의 진입점. 화면별 계산은 src/dashboard/ 아래 파일에 있다(DS-1-impl).
// 확인 순서는 나누기 전과 같다: 카드 상태가 필요 없는 화면 -> 카드 상태 확인 -> 작업 시간·요약
// -> 화면 재료(model) 계산(없는 화면 이름이어도 계산하다 실패할 수 있다) -> 나머지 -> 404.
import { model } from "./dashboard/shared.mjs";
import { createData, decisionsData, runnersData } from "./dashboard/settings.mjs";
import { mailBodyData, mailData, ledgerData } from "./dashboard/mail.mjs";
import {
  worktimeData,
  summaryData,
  sessionsData,
  visibleSessionRoles,
} from "./dashboard/summary.mjs";
import { reviewResultData, workspaceData, runsData } from "./dashboard/workspace.mjs";
import { statusData } from "./dashboard/status.mjs";
import { detailData } from "./dashboard/detail.mjs";

export { visibleSessionRoles };

// 카드 상태를 읽지 못해도 답하는 화면
const STANDALONE = new Map([
  ["create", createData],
  ["decisions", decisionsData],
  ["mail-body", mailBodyData],
  ["mail", mailData],
  ["ledger", ledgerData],
  ["runners", runnersData],
]);
// 카드 상태가 있어야 하지만 화면 재료(model)는 필요 없는 화면
const CENTER_ONLY = new Map([
  ["worktime", worktimeData],
  ["summary", summaryData],
]);
// 화면 재료(model)를 먼저 계산한 뒤 답하는 화면
const WITH_MODEL = new Map([
  ["review-result", reviewResultData],
  ["workspace", workspaceData],
  ["status", statusData],
  ["sessions", sessionsData],
  ["runs", runsData],
  ["detail", detailData],
]);

export function dashboardData(snapshot, url) {
  const route = url.pathname.slice("/api/dashboard/".length),
    stamp = {
      collectedAt: snapshot.collectedAt,
      runtime: snapshot.runtime ?? null,
    };
  if (STANDALONE.has(route)) return STANDALONE.get(route)(snapshot, url, stamp);
  if (snapshot.centerError || !snapshot.center)
    throw new Error(snapshot.centerError || "카드 상태를 읽을 수 없습니다");
  if (CENTER_ONLY.has(route)) return CENTER_ONLY.get(route)(snapshot, url, stamp);
  const includeWorks = route !== "workspace" ||
    (url.searchParams.get("collection") || "work") === "work" ||
    url.searchParams.get("layout") === "map";
  const m = model(snapshot, includeWorks);
  if (WITH_MODEL.has(route)) return WITH_MODEL.get(route)(snapshot, url, stamp, m);
  throw Object.assign(new Error("대시보드 API 없음"), { status: 404 });
}

export function sendDashboardData(snapshot, url, response) {
  const body = JSON.stringify(dashboardData(snapshot, url));
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}
