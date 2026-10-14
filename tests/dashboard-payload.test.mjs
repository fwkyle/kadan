import "./helpers/isolated-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { dashboardFixture } from "./helpers/dashboard-fixture.mjs";
import { DecisionStore } from "../src/decisions.mjs";
import { dashboardData } from "../src/dashboard-api.mjs";

// 대시보드 응답 줄이기(2026-10-14): 결정은 열린 것만 기본으로 보내고, 목록을 쓰지 않는 주소는 결정 저장소를 읽지 않는다.
const listen = async (f) => {
  await new Promise((resolve) => f.server.listen(0, "127.0.0.1", resolve));
  return "http://127.0.0.1:" + f.server.address().port;
};

test("결정 기본 응답은 열린 결정과 건수만, 지난 결정은 ?past=1 페이지로 받는다", async (t) => {
  const f = dashboardFixture({ count: 2 });
  t.after(() => f.server.close());
  const [first] = f.decisions.list();
  f.decisions.answer(first.id, { revision: first.revision, text: "적용", choice: "적용" }, "사람");
  const base = await listen(f);
  const get = async (route) => (await fetch(base + "/api/dashboard/" + route)).json();

  const open = await get("decisions");
  assert.equal(open.items.length, 1);
  assert.ok(open.items.every((d) => d.status === "open"));
  assert.equal(open.answered, 1);
  assert.equal(open.past, 1);

  const past = await get("decisions?past=1");
  assert.equal(past.total, 1);
  assert.equal(past.items[0].id, first.id);
  assert.equal(past.items[0].status, "answered");
  assert.ok(past.items[0].questionTitle && past.items[0].reasonHtml, "지난 결정도 본문 가공을 거친다");
  assert.deepEqual([past.page, past.pages], [1, 1]);
});

test("지난 결정은 50건씩 나뉘고 정렬 순서를 따른다", () => {
  const f = dashboardFixture({ count: 2 });
  const snapshot = f.snapshot(), at = (n) => new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString();
  snapshot.decisions = Array.from({ length: 120 }, (_, n) => ({
    ...snapshot.decisions[0], id: "d" + n, status: n % 2 ? "cancelled" : "answered", at: at(n),
    answer: n % 2 ? undefined : { by: "사람", text: "답", at: at(n) },
  }));
  const read = (query) => dashboardData(snapshot, new URL("http://local/api/dashboard/decisions?past=1&" + query));
  const first = read("page=1");
  assert.equal(first.items.length, 50);
  assert.deepEqual([first.total, first.pages], [120, 3]);
  assert.equal(first.items[0].id, "d0", "기본은 오래된 순");
  assert.equal(read("page=3").items.length, 20);
  assert.equal(read("page=1&sort=newest").items[0].id, "d119");
  assert.equal(dashboardData(snapshot, new URL("http://local/api/dashboard/decisions")).items.length, 0);
});

test("결정 목록을 쓰지 않는 주소는 결정 저장소를 읽지 않는다", async (t) => {
  const f = dashboardFixture({ count: 2 });
  t.after(() => f.server.close());
  const base = await listen(f);
  const original = DecisionStore.prototype.list;
  let wallReads = 0;
  DecisionStore.prototype.list = function () {
    // 호출한 쪽이 wall.mjs일 때만 센다(시험 자료의 loadSnapshot도 목록을 읽는다).
    if (new Error().stack.split("\n")[2].includes("/src/wall.mjs")) wallReads++;
    return original.call(this);
  };
  t.after(() => { DecisionStore.prototype.list = original; });
  const reads = async (path) => {
    wallReads = 0;
    assert.equal((await fetch(base + path)).status, 200, path);
    return wallReads;
  };
  for (const path of ["/api/cards", "/api/dashboard/workspace", "/api/dashboard/mail", "/api/dashboard/ledger",
    "/api/dashboard/runs", "/api/dashboard/sessions", "/api/dashboard/runners", "/api/dashboard/worktime",
    "/api/dashboard/flow-unconfirmed"])
    assert.equal(await reads(path), 0, path + "는 결정 저장소를 읽지 않는다");
  for (const path of ["/api/dashboard/status", "/api/dashboard/decisions", "/api/dashboard/summary",
    "/api/dashboard/detail?card=demo/card-1"])
    assert.equal(await reads(path), 1, path + "는 결정 저장소를 한 번 읽는다");
});

test("/api/cards는 카드 전체가 아니라 kadan tree와 같은 요약을 돌려준다", async (t) => {
  const f = dashboardFixture({ count: 2 });
  t.after(() => f.server.close());
  const base = await listen(f);
  const body = await (await fetch(base + "/api/cards")).json();
  for (const key of ["summary", "executionSummary", "boards", "pendingCards", "liveRoles", "unregisteredRuns"])
    assert.ok(key in body.center, key);
  for (const key of ["cards", "rallies", "roles", "models"])
    assert.ok(!(key in body.center), key + "는 싣지 않는다");
  assert.ok(body.center.pendingCards.length > 0);
});

test("현황 응답은 화면이 읽지 않는 행 칸을 싣지 않고 화면이 읽는 칸은 남긴다", async (t) => {
  const f = dashboardFixture({ count: 2 });
  t.after(() => f.server.close());
  const base = await listen(f);
  const status = await (await fetch(base + "/api/dashboard/status")).json();
  assert.ok(status.rows.length > 0 && status.works.length > 0);
  for (const row of [...status.rows, ...status.works]) {
    for (const key of ["workKey", "workType", "scope", "reworks", "workMs", "parentWorkKey", "reviewLabel"])
      assert.ok(!(key in row), key);
    for (const key of ["key", "title", "owner", "bucket", "state", "healthLabel", "signalAt", "board"])
      assert.ok(key in row, key);
  }
  assert.deepEqual(status.flow, { total: 0, unconfirmedCount: 0, unconfirmed: [] });
  assert.equal(status.decisions.length, 2);
  const flows = await (await fetch(base + "/api/dashboard/flow-unconfirmed")).json();
  assert.deepEqual([flows.items, flows.total, flows.page], [[], 0, 1]);
});
