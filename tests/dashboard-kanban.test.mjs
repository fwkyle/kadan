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
  assert.equal(lineOf(result, "r/in"), "감독A/decision", "열린 결정이 걸린 끝난 카드는 24시간 안이어도 kyle 확인 필요");
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

test("F1: 끝난 카드에 걸린 열린 카드 결정은 kyle 확인 필요(24시간 밖이어도)", () => {
  const rows = [row("r/done", { state: "done", signalAt: ago(RECENT_MS + 1) })];
  const result = buildKanban({ rows, hierarchy, now, decisions: [{ id: "d", status: "open", card: "r/done" }] });
  assert.equal(lineOf(result, "r/done"), "감독A/decision");
  assert.deepEqual(result.boards[0].lines[0].cards[0].marks.map((m) => m.label), ["결정 대기(카드)"]);
  const closed = buildKanban({ rows, hierarchy, now, decisions: [{ id: "d", status: "answered", card: "r/done" }] });
  assert.equal(closed.boards.length, 0, "닫힌 결정이면 24시간 밖 완료는 지금처럼 제외");
});

test("F1: 24시간+1ms 지난 완료 카드뿐인 업무에 열린 업무 결정이 있으면 판이 생기고 최근 1장만 kyle 확인", () => {
  const w = [{ key: "r/work-2", title: "업무2", owner: "감독C", executions: [{ key: "r/old1" }, { key: "r/old2" }] }];
  const rows = [row("r/old1", { state: "done", signalAt: ago(RECENT_MS + 5000) }), row("r/old2", { state: "done", signalAt: ago(RECENT_MS + 1) })];
  const result = buildKanban({ rows, works: w, hierarchy, now, decisions: [{ id: "d", status: "open", work: "r/work-2" }] });
  assert.equal(lineOf(result, "r/old2"), "감독C/decision", "가장 최근 실행");
  assert.equal(lineOf(result, "r/old1"), undefined, "나머지 옛 카드는 올리지 않는다");
  assert.deepEqual(result.boards[0].lines[0].cards[0].marks.map((m) => m.label), ["결정 대기(업무)"]);
  const closed = buildKanban({ rows, works: w, hierarchy, now, decisions: [{ id: "d", status: "closed", work: "r/work-2" }] });
  assert.equal(closed.boards.length, 0);
});

test("F1: 끝나지 않은 카드가 있는 업무의 업무 결정은 그 카드로 간다(끝난 카드를 따로 올리지 않는다)", () => {
  const w = [{ key: "r/work-3", title: "업무3", owner: "감독C", executions: [{ key: "r/live" }, { key: "r/fin" }] }];
  const rows = [row("r/live"), row("r/fin", { state: "done", signalAt: ago(1000) })];
  const result = buildKanban({ rows, works: w, hierarchy, now, decisions: [{ id: "d", status: "open", work: "work:r/work-3" }] });
  assert.equal(lineOf(result, "r/live"), "감독C/decision");
  assert.equal(lineOf(result, "r/fin"), "감독C/done");
});

test("F1: 완료 11장 중 가장 오래된 카드에 열린 결정이 있어도 완료 상한과 무관하게 kyle 확인", () => {
  const rows = Array.from({ length: DONE_LIMIT + 1 }, (_, i) => row(`r/${i}`, { state: "done", signalAt: ago(1000 * (i + 1)) }));
  const oldest = `r/${DONE_LIMIT}`;
  const result = buildKanban({ rows, hierarchy, now, decisions: [{ id: "d", status: "open", card: oldest }] });
  assert.equal(lineOf(result, oldest), "감독A/decision");
  const done = result.boards[0].lines.find((l) => l.key === "done");
  assert.equal(done.count, DONE_LIMIT, "결정으로 올라간 카드는 완료 줄에서 빠진다");
  assert.equal(done.hidden, 0);
});

test("F1: 막힘은 끝나지 않은 카드에만 적용한다", () => {
  const result = buildKanban({ rows: [row("r/d", { state: "done", bucket: "stuck" })], hierarchy, now });
  assert.equal(lineOf(result, "r/d"), "감독A/done");
});

// 열린 결정 id → 칸반 어디에 보이는가. 불변식: 열린 결정은 최소 한 장에 보인다.
const shownDecisions = (result) => new Set(result.boards.flatMap((b) => b.lines.flatMap((l) => l.cards.flatMap((c) => c.decisionIds ?? []))));
const openIds = (decisions) => new Set(decisions.filter((d) => d.status === "open").map((d) => d.id));

test("F2: 실행 0장 업무 + 조율 카드 출처의 열린 결정은 업무 자체 카드로 kyle 확인 필요에 보인다", () => {
  const w = [{ key: "r/empty", title: "빈 업무", owner: "감독C", status: "open", executions: [] }];
  const coord = row("r/origin", { workType: "coordination" });
  const decisions = [{ id: "d1", status: "open", card: "r/origin", work: "r/empty", at: ago(5000) }];
  const result = buildKanban({ rows: [], lookup: [coord], works: w, hierarchy, now, decisions });
  assert.equal(lineOf(result, "work:r/empty"), "감독C/decision");
  const card = result.boards[0].lines[0].cards[0];
  assert.equal(card.title, "빈 업무");
  assert.equal(card.role, "감독C");
  assert.equal(card.since, ago(5000), "경과 시간은 결정 요청 시각");
  assert.deepEqual(card.marks.map((m) => m.label), ["결정 대기(업무)"]);
  assert.deepEqual(shownDecisions(result), openIds(decisions));
});

test("F2: 업무 없는 조율 카드 출처 결정은 출처 카드를 관계표 부모 판에, 출처도 없으면 미연결에 둔다", () => {
  const coord = row("r/coord", { workType: "coordination", owner: "작업자" });
  const decisions = [{ id: "d1", status: "open", card: "r/coord", at: ago(1) }, { id: "d2", status: "open", card: "r/gone", at: ago(2) }];
  const result = buildKanban({ rows: [], lookup: [coord], hierarchy, now, decisions });
  assert.equal(lineOf(result, "r/coord"), "감독A/decision");
  assert.equal(lineOf(result, "r/gone"), `${UNLINKED}/decision`);
  assert.deepEqual(shownDecisions(result), openIds(decisions));
});

test("F2: 같은 업무의 결정 둘은 업무 카드 한 장, 같은 결정으로 카드가 두 번 나오지 않는다", () => {
  const w = [{ key: "r/empty", title: "빈 업무", owner: "감독C", executions: [] }];
  const decisions = [{ id: "d1", status: "open", work: "r/empty", card: "r/c1", at: ago(9000) }, { id: "d2", status: "open", work: "work:r/empty", card: "r/c2", at: ago(1000) }];
  const result = buildKanban({ rows: [], works: w, hierarchy, now, decisions });
  const cards = result.boards.flatMap((b) => b.lines.flatMap((l) => l.cards));
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].decisionIds, ["d1", "d2"]);
  assert.equal(cards[0].since, ago(1000), "가장 최근 요청 시각");
});

test("F2 불변식: 고정 입력 여러 개에서 열린 결정 수 = 칸반에 걸린 서로 다른 열린 결정 수", () => {
  const w = [
    { key: "r/empty", title: "빈 업무", owner: "감독C", executions: [] },
    { key: "r/finished", title: "끝난 업무", owner: "감독C", executions: [{ key: "r/f1" }, { key: "r/f2" }] },
    { key: "r/live", title: "진행 업무", owner: "감독B", executions: [{ key: "r/l1" }] },
  ];
  const rows = [row("r/f1", { state: "done", signalAt: ago(RECENT_MS + 9) }), row("r/f2", { state: "done", signalAt: ago(RECENT_MS + 1) }),
    row("r/l1"), row("r/free"), row("r/old", { state: "done", signalAt: ago(RECENT_MS * 3) }), row("r/orphan", { owner: "고아" })];
  const lookup = [...rows, row("r/coord", { workType: "coordination" })];
  const inputs = [
    [],
    [{ id: "a", status: "open", card: "r/coord", work: "r/empty", at: ago(1) }],
    [{ id: "a", status: "open", card: "r/coord", at: ago(1) }, { id: "b", status: "open", card: "r/nowhere", at: ago(2) }],
    [{ id: "a", status: "open", work: "r/finished", card: "r/coord", at: ago(1) }, { id: "b", status: "open", card: "r/old", at: ago(2) }],
    [{ id: "a", status: "open", work: "r/live", card: "r/free", at: ago(1) }, { id: "b", status: "answered", card: "r/free" }, { id: "c", status: "cancelled", work: "r/empty" }],
    [{ id: "a", status: "open", card: "r/orphan" }, { id: "b", status: "open", work: "r/missing-work", card: "r/coord" }, { id: "c", status: "open", work: "r/empty", card: "r/free" }],
  ];
  for (const decisions of inputs) for (const h of [hierarchy, null]) {
    const result = buildKanban({ rows, lookup, works: w, hierarchy: h, now, decisions });
    assert.deepEqual([...shownDecisions(result)].sort(), [...openIds(decisions)].sort(), JSON.stringify(decisions));
    const keys = result.boards.flatMap((b) => b.lines.flatMap((l) => l.cards.map((c) => c.key)));
    assert.equal(new Set(keys).size, keys.length, "한 카드는 한 번만");
  }
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
