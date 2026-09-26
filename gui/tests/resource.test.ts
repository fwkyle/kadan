import test from "node:test";
import assert from "node:assert/strict";
import { Resource } from "../src/resource-core.ts";
const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
test("같은 요청은 공유하고 늦은 옛 응답은 새 상태를 덮지 않는다", async () => {
  const first = deferred<number>(),
    second = deferred<number>();
  let count = 0;
  const resource = new Resource(() =>
    ++count === 1 ? first.promise : second.promise,
  );
  const a = resource.refresh(),
    b = resource.refresh();
  assert.equal(a, b);
  await wait();
  assert.equal(count, 1);
  const fresh = resource.refresh(true);
  await wait();
  second.resolve(2);
  await fresh;
  first.resolve(1);
  await a;
  assert.equal(resource.getSnapshot().data, 2);
  assert.equal(resource.getSnapshot().refreshing, false);
});
test("응답이 끝나지 않아도 제한 시간 뒤 다시 읽을 수 있고 이전 자료는 유지한다", async () => {
  let count = 0;
  const resource = new Resource(
    () =>
      ++count === 2 ? new Promise<number>(() => {}) : Promise.resolve(count),
    { deadlineMs: 15 },
  );
  await resource.refresh();
  assert.equal(resource.getSnapshot().data, 1);
  await resource.refresh();
  assert.match(resource.getSnapshot().error!, /초과/);
  assert.equal(resource.getSnapshot().data, 1);
  assert.equal(resource.getSnapshot().refreshing, false);
  await resource.refresh();
  assert.equal(resource.getSnapshot().data, 3);
  assert.equal(resource.getSnapshot().error, null);
});
test("숨긴 화면·구독 종료는 취소하고 다시 열면 갱신한다", async () => {
  let count = 0;
  const signals: AbortSignal[] = [];
  const resource = new Resource(
    (signal) => {
      signals.push(signal);
      return Promise.resolve(++count);
    },
    { pollMs: 10, staleMs: 1000 },
  );
  const a = resource.subscribe(() => {}),
    b = resource.subscribe(() => {});
  await wait();
  assert.equal(count, 1);
  resource.setVisible(false);
  const hidden = count;
  await wait(35);
  assert.equal(count, hidden);
  resource.setVisible(true);
  await wait();
  assert.equal(count, hidden + 1);
  a();
  assert.equal(resource.subscribed, true);
  b();
  await wait(35);
  assert.equal(resource.subscribed, false);
  assert.equal(count, hidden + 1);
});
test("구독 취소 후 살아난 요청도 새 요청과 섞이지 않는다", async () => {
  const old = deferred<number>();
  let count = 0;
  const resource = new Resource(() =>
    ++count === 1 ? old.promise : Promise.resolve(9),
  );
  const unsubscribe = resource.subscribe(() => {});
  await wait();
  unsubscribe();
  const next = resource.subscribe(() => {});
  await wait();
  old.resolve(1);
  await wait();
  assert.equal(resource.getSnapshot().data, 9);
  next();
});
