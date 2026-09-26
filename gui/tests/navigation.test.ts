import test from "node:test";
import assert from "node:assert/strict";

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
});
