import test from "node:test";
import assert from "node:assert/strict";
import {
  RELOAD_WINDOW_MS, autoReloadOnChunkError, isChunkLoadError, reloadAllowed,
} from "../src/chunk-reload.ts";

const CHROME = "Failed to fetch dynamically imported module: http://127.0.0.1:8790/assets/StrategyMap-CMSXuMbD.js";
const SAFARI = "Importing a module script failed.";
const FIREFOX = "error loading dynamically imported module: http://127.0.0.1:8790/assets/StrategyMap-CMSXuMbD.js";

function memoryStore(initial: string | null = null) {
  const box = { value: initial, writes: 0 };
  return { box, store: { get: () => box.value, set: (v: string) => { box.value = v; box.writes += 1; } } };
}

test("조각 못 읽음 꼴: 크롬·사파리·파이어폭스 문구만 새로 읽기 대상", () => {
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

test("상한: 표시가 없거나 상한이 지났으면 허용, 상한 안이면 거절", () => {
  const now = 1_000_000;
  assert.equal(reloadAllowed(now, null), true);
  assert.equal(reloadAllowed(now, String(now - RELOAD_WINDOW_MS + 1)), false);
  assert.equal(reloadAllowed(now, String(now - RELOAD_WINDOW_MS)), true);
  assert.equal(reloadAllowed(now, String(now - RELOAD_WINDOW_MS - 1)), true);
  assert.equal(reloadAllowed(now, String(now + 5_000)), false, "미래 시각 표시는 시계 어긋남이라 반복 쪽으로 기울지 않는다");
  assert.equal(reloadAllowed(now, "깨진 값"), true, "읽을 수 없는 표시는 없는 것으로 보고 새 표시로 덮는다");
});

test("자동 새로 읽기: 처음엔 표시를 남기고 한 번 새로 읽는다", () => {
  const { box, store } = memoryStore();
  let reloads = 0;
  assert.equal(autoReloadOnChunkError(CHROME, store, 5_000, () => { reloads += 1; }), true);
  assert.equal(reloads, 1);
  assert.equal(box.value, "5000");
});

test("자동 새로 읽기: 상한 안에 다시 실패하면 새로 읽지 않고 오류를 보이게 둔다", () => {
  const { store, box } = memoryStore("5000");
  let reloads = 0;
  assert.equal(autoReloadOnChunkError(CHROME, store, 5_000 + RELOAD_WINDOW_MS - 1, () => { reloads += 1; }), false);
  assert.equal(reloads, 0);
  assert.equal(box.writes, 0);
  assert.equal(autoReloadOnChunkError(CHROME, store, 5_000 + RELOAD_WINDOW_MS, () => { reloads += 1; }), true);
  assert.equal(reloads, 1, "상한이 지나면 다시 한 번");
});

test("자동 새로 읽기: 조각 못 읽음이 아닌 오류는 건드리지 않는다", () => {
  const { store, box } = memoryStore();
  let reloads = 0;
  assert.equal(autoReloadOnChunkError("TypeError: x is undefined", store, 5_000, () => { reloads += 1; }), false);
  assert.equal(reloads, 0);
  assert.equal(box.writes, 0);
});

test("자동 새로 읽기: 저장소를 읽거나 쓰지 못하면 새로 읽지 않는다(무한 반복 쪽으로 실패하지 않는다)", () => {
  let reloads = 0;
  const reload = () => { reloads += 1; };
  const boom = () => { throw new Error("SecurityError"); };
  assert.equal(autoReloadOnChunkError(CHROME, { get: boom, set: () => {} }, 5_000, reload), false);
  assert.equal(autoReloadOnChunkError(CHROME, { get: () => null, set: boom }, 5_000, reload), false);
  assert.equal(reloads, 0);
});
