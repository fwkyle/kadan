import test from "node:test";
import assert from "node:assert/strict";
import "../../tests/helpers/isolated-home.mjs";

// 워크·카드 화면의 두 버튼(작업 종류 전환·필터 초기화)이 쓰는 주소 조각을 실제 patchLocation으로 적용해 본다(PR2 검수 F1).
// Workspace.tsx의 버튼은 같은 collectionSwitchPatch·filterResetPatch를 그대로 부른다.
test("작업 종류 전환(양방향)은 ?repo=를 유지하고 필터 초기화는 푼다", async () => {
  let current = new URL("http://local/?repo=kadan&collection=work&q=검수&board=판&state=draft&page=3#dashboard");
  const history = {
    state: {},
    replaceState(state: object, _t: string, url: string | URL) { this.state = state; current = new URL(url, current); },
    pushState(state: object, t: string, url: string | URL) { this.replaceState(state, t, url); },
  };
  Object.defineProperties(globalThis, {
    location: { configurable: true, get: () => current },
    history: { configurable: true, value: history },
    window: { configurable: true, value: new EventTarget() },
  });
  const { patchLocation } = await import("../src/navigation.ts");
  const { collectionSwitchPatch, filterResetPatch } = await import("../src/workspace-labels.ts");
  const press = (values: Record<string, string | null>) => patchLocation({ bucket: null, ...values, page: null });
  press(collectionSwitchPatch("executions"));
  assert.equal(current.searchParams.get("repo"), "kadan", "워크 → 카드");
  assert.equal(current.searchParams.get("collection"), "executions");
  assert.equal(current.searchParams.get("q"), null, "거르기 조건은 비운다");
  press(collectionSwitchPatch("work"));
  assert.equal(current.searchParams.get("repo"), "kadan", "카드 → 워크");
  assert.equal(current.searchParams.get("collection"), "work");
  press(filterResetPatch());
  assert.equal(current.searchParams.get("repo"), null, "필터 초기화는 의도적으로 전체로 푼다");
});
