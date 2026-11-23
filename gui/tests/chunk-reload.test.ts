import test from "node:test";
import assert from "node:assert/strict";
import {
  TRIED_MAX, autoReloadOnChunkError, causeKey, isChunkLoadError, parseTried,
} from "../src/chunk-reload.ts";

const CHROME = "Failed to fetch dynamically imported module: http://127.0.0.1:8790/assets/StrategyMap-CMSXuMbD.js";
const CHROME_NEW = "Failed to fetch dynamically imported module: http://127.0.0.1:8790/assets/StrategyMap-Zq81aPxw.js";
const SAFARI = "Importing a module script failed.";
const FIREFOX = "error loading dynamically imported module: http://127.0.0.1:8790/assets/StrategyMap-CMSXuMbD.js";

// 탭 저장소 대역: 새로 읽어도 저장소(탭 단위)는 남는다는 점을 같은 상자를 계속 쓰는 것으로 흉내 낸다.
function memoryStore(initial: string | null = null) {
  const box = { value: initial, writes: 0 };
  return { box, store: { get: () => box.value, set: (v: string) => { box.value = v; box.writes += 1; } } };
}
function counter() {
  const c = { n: 0 };
  return { c, reload: () => { c.n += 1; } };
}

test("조각 못 읽음 꼴: 크롬·사파리·파이어폭스 문구와 Vite 미리 읽기 실패만 새로 읽기 대상", () => {
  assert.equal(isChunkLoadError(CHROME), true);
  assert.equal(isChunkLoadError(SAFARI), true);
  assert.equal(isChunkLoadError(FIREFOX), true);
  assert.equal(isChunkLoadError("Unable to preload CSS for /assets/StrategyMap-CMSXuMbD.css"), true, "Vite 미리 읽기 실패");
  assert.equal(isChunkLoadError("Cannot read properties of undefined (reading 'map')"), false);
  assert.equal(isChunkLoadError("Failed to fetch"), false, "일반 네트워크 오류는 조각 못 읽음이 아니다");
  assert.equal(isChunkLoadError(""), false);
  assert.equal(isChunkLoadError(null), false);
  assert.equal(isChunkLoadError(undefined), false);
});

test("1행: 옛 조각 404 → 처음엔 원인을 적고 한 번 새로 읽는다(새 조각 200이면 그 뒤 실패가 없다)", () => {
  const { box, store } = memoryStore();
  const { c, reload } = counter();
  assert.equal(autoReloadOnChunkError(CHROME, store, reload, "#strategy-map"), true);
  assert.equal(c.n, 1);
  assert.deepEqual(parseTried(box.value), [causeKey(CHROME, "#strategy-map")]);
});

test("2행: 새로 읽은 뒤에도 같은 조각이 바로 또 404면 새로 읽지 않고 오류를 보이게 둔다", () => {
  const { store, box } = memoryStore();
  const { c, reload } = counter();
  assert.equal(autoReloadOnChunkError(CHROME, store, reload, "#strategy-map"), true);
  const written = box.writes;
  assert.equal(autoReloadOnChunkError(CHROME, store, reload, "#strategy-map"), false);
  assert.equal(c.n, 1);
  assert.equal(box.writes, written, "거절한 호출은 저장소를 쓰지 않는다");
});

test("3행: 같은 조각이 시간이 얼마나 지나도 계속 404면 다시 새로 읽지 않는다(수정 전엔 31초 간격이면 반복)", () => {
  const { store } = memoryStore();
  const { c, reload } = counter();
  for (let i = 0; i < 10; i += 1) autoReloadOnChunkError(CHROME, store, reload, "#strategy-map");
  assert.equal(c.n, 1, "시각을 보지 않으므로 몇 번이든 처음 한 번뿐");
  // 같은 조각을 파이어폭스 문구·사파리 문구로 받는 탭도 같은 원인은 한 번뿐이다.
  const safari = memoryStore();
  const s = counter();
  for (let i = 0; i < 10; i += 1) autoReloadOnChunkError(SAFARI, safari.store, s.reload, "#strategy-map");
  assert.equal(s.c.n, 1);
});

test("4행: 정상 화면에 닿은 뒤 다시 빌드해 생긴 별도 조각 실패는 한 번 더 새로 읽을 수 있다", () => {
  const { store } = memoryStore();
  const { c, reload } = counter();
  assert.equal(autoReloadOnChunkError(CHROME, store, reload, "#strategy-map"), true);
  assert.equal(autoReloadOnChunkError(CHROME_NEW, store, reload, "#strategy-map"), true, "조각 주소가 다르면 다른 원인");
  assert.equal(autoReloadOnChunkError(CHROME_NEW, store, reload, "#strategy-map"), false, "그 원인도 한 번뿐");
  assert.equal(c.n, 2);
  // 주소가 문구에 없는 사파리는 보던 화면(주소 해시)으로 원인을 나눈다.
  const safari = memoryStore();
  const s = counter();
  assert.equal(autoReloadOnChunkError(SAFARI, safari.store, s.reload, "#status"), true);
  assert.equal(autoReloadOnChunkError(SAFARI, safari.store, s.reload, "#strategy-map"), true);
  assert.equal(autoReloadOnChunkError(SAFARI, safari.store, s.reload, "#strategy-map"), false);
  assert.equal(s.c.n, 2);
});

test("두 경로가 서로 다른 문구로 같은 실패를 알려도 새로 읽은 뒤에는 둘 다 한 번씩만 센다", () => {
  const { store } = memoryStore();
  const { c, reload } = counter();
  const preload = "Unable to preload CSS for /assets/StrategyMap-CMSXuMbD.css";
  autoReloadOnChunkError(preload, store, reload, "#strategy-map");
  autoReloadOnChunkError(CHROME, store, reload, "#strategy-map"); // 같은 문서 안의 두 번째 경로
  const before = c.n;
  // 새로 읽은 문서에서 같은 두 문구가 다시 와도 더는 새로 읽지 않는다.
  autoReloadOnChunkError(preload, store, reload, "#strategy-map");
  autoReloadOnChunkError(CHROME, store, reload, "#strategy-map");
  assert.equal(c.n, before);
});

test("조각 못 읽음이 아닌 오류는 건드리지 않는다", () => {
  const { store, box } = memoryStore();
  const { c, reload } = counter();
  assert.equal(autoReloadOnChunkError("TypeError: x is undefined", store, reload), false);
  assert.equal(autoReloadOnChunkError(undefined, store, reload), false);
  assert.equal(c.n, 0);
  assert.equal(box.writes, 0);
});

test("저장소를 읽거나 쓰지 못하거나 표시가 손상됐으면 새로 읽지 않는다(무한 반복 쪽으로 실패하지 않는다)", () => {
  const { c, reload } = counter();
  const boom = () => { throw new Error("SecurityError"); };
  assert.equal(autoReloadOnChunkError(CHROME, { get: boom, set: () => {} }, reload), false);
  assert.equal(autoReloadOnChunkError(CHROME, { get: () => null, set: boom }, reload), false);
  assert.equal(autoReloadOnChunkError(CHROME, memoryStore("깨진 값").store, reload), false);
  assert.equal(autoReloadOnChunkError(CHROME, memoryStore('{"a":1}').store, reload), false);
  assert.equal(autoReloadOnChunkError(CHROME, memoryStore("[1,2]").store, reload), false);
  assert.equal(c.n, 0);
});

test("한 탭에서 기억하는 원인 수가 상한에 닿으면 더는 자동으로 새로 읽지 않는다", () => {
  const { store } = memoryStore();
  const { c, reload } = counter();
  for (let i = 0; i < TRIED_MAX + 5; i += 1) {
    autoReloadOnChunkError(CHROME.replace("CMSXuMbD", "h" + i), store, reload);
  }
  assert.equal(c.n, TRIED_MAX);
});
