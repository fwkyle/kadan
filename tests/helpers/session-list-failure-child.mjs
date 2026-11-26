// tests/dashboard-review-fixes.test.mjs의 자식 프로세스: 가짜 tmux(PATH)로 세션 목록 조회 결과를 바꾼 채 실제 현황 수집기를 돌리고,
// 현황 응답의 생존 칸과 그 응답으로 그린 지도를 JSON 한 줄로 낸다. 가짜 tmux를 물려받게 하려고 따로 띄운다.
import { loadWallSnapshot } from "../../src/commands/tree-wall.mjs";
import { dashboardData } from "../../src/dashboard-api.mjs";
import { buildMap, STATE_LABEL, recipientGone } from "../../gui/src/strategy-map.ts";

const snapshot = Object.assign(loadWallSnapshot(), { home: process.env.KADAN_HOME });
const data = dashboardData(snapshot, new URL("http://local/api/dashboard/status"));
const map = buildMap({ hierarchy: data.hierarchy, rows: data.rows, live: data.live, alerts: data.alerts, stopped: data.stopped, held: data.held });
const units = Object.fromEntries(map.bases.flatMap((b) => b.units).map((u) => [u.role, STATE_LABEL[u.state]]));
console.log(JSON.stringify({
  error: snapshot.error ?? null, live: data.live, stopped: data.stopped, units,
  // 살아 있는 최상위 역할 자신에게 묻는 질문 칸이 막히는가(받는 사람 = 자기 자신).
  askBlocked: recipientGone(process.argv[2], data.live),
}));
