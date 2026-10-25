import test from "node:test";
import assert from "node:assert/strict";
import "../../tests/helpers/isolated-home.mjs";

test("업무 미연결 필터에서 상세를 열고 닫아도 조건과 미저장 이동 보호를 유지한다", async () => {
  let current = new URL("http://local/?collection=unlinked&q=검수&state=draft#dashboard");
  const history = {
    state: {},
    replaceState(state: object, _title: string, url: string | URL) {
      this.state = state;
      current = new URL(url, current);
    },
    pushState(state: object, title: string, url: string | URL) {
      this.replaceState(state, title, url);
    },
  };
  Object.defineProperties(globalThis, {
    location: { configurable: true, get: () => current },
    history: { configurable: true, value: history },
    window: { configurable: true, value: new EventTarget() },
  });
  const { cardUrl, navigate, patchLocation, setNavigationGuard, viewOf } = await import("../src/navigation.ts");
  const detail = cardUrl("demo/card-2");
  const previous = current.href;
  setNavigationGuard(() => false);
  assert.equal(navigate(detail), false);
  assert.equal(current.href, previous);
  setNavigationGuard(() => true);
  assert.equal(navigate(detail), true);
  assert.equal(current.searchParams.get("collection"), "unlinked");
  assert.equal(current.searchParams.get("q"), "검수");
  assert.equal(current.searchParams.get("state"), "draft");
  assert.equal(current.searchParams.get("card"), "demo/card-2");
  assert.equal(viewOf(current), "dashboard");
  patchLocation({card: null, detail: "0"}, "dashboard");
  assert.equal(current.searchParams.get("collection"), "unlinked");
  assert.equal(new URL(cardUrl("work:demo/work-1"), current).searchParams.get("collection"), "work");
  navigate("#mailbox");
  assert.equal(new URL(cardUrl("demo/card-2"), current).searchParams.get("collection"), "executions");
  setNavigationGuard(() => false);
  assert.equal(navigate("#runner-settings"), false);
  assert.equal(viewOf(current), "mailbox");
  assert.equal(viewOf(new URL("http://local/?alive=1#sessions")), "strategy-map", "옛 담당자 상태 주소는 전략 맵으로");
  assert.equal(viewOf(new URL("http://local/#runner-settings")), "runner-settings", "설정 주소는 그대로");
});

test("실행 상세와 업무 상세의 진행 이력 링크가 실제 API에서 열린다", async (t) => {
  const { workFlowUrl } = await import("../src/navigation.ts");
  const { dashboardFixture } = await import("../../tests/helpers/dashboard-fixture.mjs");
  const f = dashboardFixture({ count: 2 });
  t.after(() => f.server.close());
  await new Promise<void>((resolve) => f.server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + f.server.address().port;
  for (const card of ["demo/card-1", "work:demo/dashboard"]) {
    const response = await fetch(base + "/api/dashboard/detail?card=" + encodeURIComponent(card));
    assert.equal(response.status, 200);
    const detail = await response.json();
    const key = detail.kind === "work" ? detail.key : detail.row.parentWorkKey;
    assert.equal(key, "work:demo/dashboard", "관계도의 행 주소는 그대로 유지한다");
    const link = new URL(workFlowUrl(key), base);
    assert.equal(link.searchParams.get("flowWork"), "demo/dashboard");
    assert.equal(link.hash, "#operations-flow");
    const flow = await fetch(base + "/api/operations-flow?work=" + link.searchParams.get("flowWork"));
    assert.equal(flow.status, 200, await flow.text());
  }
  assert.equal(workFlowUrl("demo/dashboard"), "/?flowWork=demo%2Fdashboard#operations-flow");
});
