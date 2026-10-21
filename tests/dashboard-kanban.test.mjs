import "./helpers/isolated-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { buildKanban, kanbanLine, DONE_LIMIT, UNLINKED } from "../src/dashboard-kanban.mjs";
import { executionBucket, RECENT_MS } from "../src/dashboard-execution.mjs";
import { dashboardFixture } from "./helpers/dashboard-fixture.mjs";

// 감독별 칸반: 한 카드는 정확히 한 줄. 고정된 작은 입력만 쓴다.
const now = Date.parse("2026-10-21T12:00:00Z");
const ago = (ms) => new Date(now - ms).toISOString();
const row = (key, patch = {}) => ({ key, title: key, owner: "작업자", repo: "r", state: "running", bucket: "running", signalAt: ago(60_000), at: ago(60_000), ...patch });
const hierarchy = { 작업자: "감독A", 검수자: "감독A", 감독A: "슈퍼", 슈퍼: "@user", 고아: "없음" };
const works = [{ key: "r/work-1", title: "업무1", owner: "감독B", executions: [{ key: "r/c-w" }] }];
const lineOf = (result, key) => {
  const hits = result.boards.flatMap((b) => b.lines.flatMap((l) => l.cards.filter((c) => c.key === key).map(() => `${b.label}/${l.key}`)));
  assert.ok(hits.length <= 1, `${key}는 한 줄에만: ${hits}`);
  return hits[0];
};

test("줄 우선순위: 결정이 걸린 검수 카드는 kyle 확인 필요로 간다", () => {
  const rows = [row("r/rev", { rallyStep: "review" }), row("r/rev2", { rallyStep: "review" }), row("r/prof", { profile: "reviewer" })];
  const result = buildKanban({ rows, hierarchy, now, decisions: [{ id: "d", status: "open", card: "r/rev" }] });
  assert.equal(lineOf(result, "r/rev"), "감독A/decision");
  assert.equal(lineOf(result, "r/rev2"), "감독A/review");
  assert.equal(lineOf(result, "r/prof"), "감독A/review");
  assert.deepEqual(result.boards[0].lines[0].cards[0].marks.map((m) => m.kind), ["decision"]);
});

test("업무에 걸린 결정도 그 업무의 카드를 kyle 확인 필요로 보낸다. 닫힌 결정은 무시한다", () => {
  const rows = [row("r/c-w")];
  const open = buildKanban({ rows, works, hierarchy, now, decisions: [{ id: "d", status: "open", work: "work:r/work-1" }] });
  assert.equal(lineOf(open, "r/c-w"), "감독B/decision");
  const closed = buildKanban({ rows, works, hierarchy, now, decisions: [{ id: "d", status: "answered", work: "r/work-1" }] });
  assert.equal(lineOf(closed, "r/c-w"), "감독B/working");
  const unknown = buildKanban({ rows, works, hierarchy, now, decisions: null });
  assert.equal(lineOf(unknown, "r/c-w"), "감독B/working", "결정을 읽지 못하면 결정으로 추측하지 않는다");
});

test("막힘 판정은 전체 현황의 executionBucket을 그대로 따른다", () => {
  const card = { status: "running", displayState: "running", role: "작업자", runs: [{ role: "작업자", sentAt: ago(3_600_000), sessionState: "alive" }] };
  const bucket = executionBucket(card, now);
  assert.equal(bucket, "stuck", "시작 보고 없이 세션만 살아 있으면 지금 막힌 것");
  const result = buildKanban({ rows: [row("r/s", { bucket }), row("r/old", { bucket: "stale" })], hierarchy, now });
  assert.equal(lineOf(result, "r/s"), "감독A/decision");
  assert.equal(result.boards[0].lines[0].cards[0].marks[0].label, "막힘");
  assert.equal(lineOf(result, "r/old"), "감독A/working", "오래된 미확정은 막힘이 아니라 작업중 표시");
});

test("hold는 작업중에 일시정지로, archived는 발령 전에 보류로 간다", () => {
  const rows = [row("r/h", { state: "hold", bucket: "hold", rallyStep: "review" }), row("r/a", { state: "archived", bucket: "planned" }),
    row("r/d", { state: "draft", bucket: "planned" }), row("r/y", { state: "ready", bucket: "planned" }), row("r/w", { state: "waiting" }), row("r/n", { state: "assigned", bucket: "planned" })];
  const result = buildKanban({ rows, hierarchy, now });
  assert.equal(lineOf(result, "r/h"), "감독A/working");
  assert.equal(lineOf(result, "r/a"), "감독A/before");
  assert.equal(lineOf(result, "r/d"), "감독A/before");
  assert.equal(lineOf(result, "r/y"), "감독A/before");
  assert.equal(lineOf(result, "r/w"), "감독A/working");
  const cards = Object.fromEntries(result.boards[0].lines.flatMap((l) => l.cards).map((c) => [c.key, c.marks.map((m) => m.label)]));
  assert.deepEqual(cards["r/h"], ["일시정지"]);
  assert.deepEqual(cards["r/a"], ["보류"]);
});

test("24시간 경계: 안쪽 끝난 카드는 완료, 바깥은 제외한다. 대체·취소도 완료", () => {
  const rows = [row("r/in", { state: "done", signalAt: ago(RECENT_MS) }), row("r/out", { state: "done", signalAt: ago(RECENT_MS + 1) }),
    row("r/sup", { state: "superseded", signalAt: null, at: ago(1000) }), row("r/can", { state: "cancelled" }), row("r/fut", { state: "done", signalAt: ago(-5000) })];
  const result = buildKanban({ rows, hierarchy, now, decisions: [{ id: "d", status: "open", card: "r/in" }] });
  assert.equal(lineOf(result, "r/in"), "감독A/done", "끝난 카드는 결정이 걸려 있어도 완료");
  assert.equal(lineOf(result, "r/out"), undefined);
  assert.equal(lineOf(result, "r/sup"), "감독A/done");
  assert.equal(lineOf(result, "r/can"), "감독A/done");
  assert.equal(lineOf(result, "r/fut"), undefined, "미래 시각은 믿지 않는다");
});

test("판: 업무 owner > 관계표 부모 > 미연결. 감독 판정은 기존 super-role", () => {
  const rows = [row("r/c-w"), row("r/own"), row("r/orphan", { owner: "고아" }), row("r/none", { owner: "" }), row("r/top", { owner: "슈퍼" })];
  const result = buildKanban({ rows, works, hierarchy, now });
  assert.equal(lineOf(result, "r/c-w"), "감독B/working", "업무 owner가 관계표 부모보다 먼저");
  assert.equal(lineOf(result, "r/own"), "감독A/working");
  assert.equal(lineOf(result, "r/orphan"), "없음/working", "관계표 부모는 부모 이름 그대로");
  assert.equal(lineOf(result, "r/none"), `${UNLINKED}/working`);
  assert.equal(lineOf(result, "r/top"), `${UNLINKED}/working`, "부모가 @user면 감독이 없으므로 미연결");
  assert.equal(result.boards.at(-1).label, UNLINKED, "미연결은 맨 아래");
  const a = result.boards.find((b) => b.label === "감독A");
  assert.equal(a.super, "슈퍼");
  assert.equal(a.isSuper, false);
  assert.equal(buildKanban({ rows: [row("r/x")], hierarchy: null, now }).boards[0].label, UNLINKED, "관계표를 모르면 조용히 빼지 않고 미연결");
});

test("완료 줄은 최신 순 상한과 나머지 개수를 낸다", () => {
  const rows = Array.from({ length: DONE_LIMIT + 3 }, (_, i) => row(`r/${i}`, { state: "done", signalAt: ago(1000 * (i + 1)) }));
  const done = buildKanban({ rows, hierarchy, now }).boards[0].lines.find((l) => l.key === "done");
  assert.equal(done.count, DONE_LIMIT + 3);
  assert.equal(done.hidden, 3);
  assert.equal(done.cards.length, DONE_LIMIT);
  assert.equal(done.cards[0].key, "r/0", "가장 최근이 앞");
});

test("kanbanLine: 모르는 상태(실패·세션 확인 필요)는 끝난 것처럼 숨기지 않고 작업중에 둔다", () => {
  for (const state of ["failed", "orphaned", "unconfirmed", "needs-check"]) assert.equal(kanbanLine({ state, bucket: "stale" }, { now }), "working");
});

test("읽기 전용 새 주소 /api/dashboard/kanban: 쓰기 없이 판을 낸다", async (t) => {
  const f = dashboardFixture({ mode: "sqlite" });
  t.after(() => f.server.close());
  await new Promise((resolve) => f.server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + f.server.address().port + "/api/dashboard/";
  const get = async (route) => {
    const r = await fetch(base + route);
    const text = await r.text();
    assert.equal(r.status, 200, text);
    return JSON.parse(text);
  };
  const data = await get("kanban");
  assert.ok(data.boards.length > 0);
  assert.deepEqual(data.lines.map((l) => l.key), ["decision", "review", "working", "before", "done"]);
  assert.ok(data.owners.includes(data.boards[0].label));
  assert.ok(data.boards.reduce((n, b) => n + b.lines.reduce((m, l) => m + l.count, 0), 0) > 0);
  assert.equal(data.decisionError, null);
  const label = data.boards[0].label;
  const one = await get("kanban?owner=" + encodeURIComponent(label));
  assert.deepEqual(one.boards.map((b) => b.label), [label]);
  assert.deepEqual(one.owners, data.owners, "감독 고르기 목록은 거르기 전 전체");
  const post = await fetch(base + "kanban", { method: "POST", body: "{}" });
  assert.notEqual(post.status, 200, "쓰기 요청은 받지 않는다");
  assert.deepEqual((await get("kanban")).boards, data.boards, "읽어도 바뀌지 않는다");
});
