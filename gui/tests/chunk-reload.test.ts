import test from "node:test";
import assert from "node:assert/strict";
import { autoReloadOnChunkError, buildIdOf, isChunkLoadError } from "../src/chunk-reload.ts";

const CHROME = "Failed to fetch dynamically imported module: http://127.0.0.1:8790/assets/StrategyMap-CMSXuMbD.js";
const SAFARI = "Importing a module script failed.";
const FIREFOX = "error loading dynamically imported module: http://127.0.0.1:8790/assets/StrategyMap-CMSXuMbD.js";
const BUILD_A = "index-A1b2C3d4.js";
const BUILD_B = "index-Zq81aPxw.js";

// 탭 저장소 대역: 새로 읽어도 탭 저장소는 남는다는 점을 같은 상자를 계속 쓰는 것으로 흉내 낸다.
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

test("빌드 표시: 주소의 파일 이름, 파일 이름이 없으면 주소 그대로", () => {
  assert.equal(buildIdOf("http://127.0.0.1:8790/dashboard-assets/assets/index-A1b2C3d4.js"), "index-A1b2C3d4.js");
  assert.equal(buildIdOf("http://127.0.0.1:8790/dashboard-assets/assets/index-A1b2C3d4.js?t=1#x"), "index-A1b2C3d4.js");
  assert.equal(buildIdOf("http://127.0.0.1:5173/src/chunk-reload.ts"), "chunk-reload.ts");
  assert.equal(buildIdOf("http://127.0.0.1:5173/"), "http://127.0.0.1:5173/");
});

test("1행: 옛 조각 404 → 처음엔 지금 빌드 표시를 적고 한 번 새로 읽는다", () => {
  const { box, store } = memoryStore();
  const { c, reload } = counter();
  assert.equal(autoReloadOnChunkError(CHROME, store, reload, BUILD_A), true);
  assert.equal(c.n, 1);
  assert.equal(box.value, BUILD_A, "저장 값은 문자열 하나");
});

test("2행: 새로 읽은 뒤에도 같은 빌드에서 조각이 바로 또 404면 새로 읽지 않고 오류를 보이게 둔다", () => {
  const { store, box } = memoryStore();
  const { c, reload } = counter();
  assert.equal(autoReloadOnChunkError(CHROME, store, reload, BUILD_A), true);
  const written = box.writes;
  assert.equal(autoReloadOnChunkError(CHROME, store, reload, BUILD_A), false);
  assert.equal(c.n, 1);
  assert.equal(box.writes, written, "거절한 호출은 저장소를 쓰지 않는다");
});

test("3행: 같은 빌드에서 시간이 얼마나 지나도 같은 조각이 계속 404면 다시 새로 읽지 않는다", () => {
  const { store } = memoryStore();
  const { c, reload } = counter();
  // 시각을 보지 않는다: 호출 사이에 몇 초가 지났든 같은 빌드면 처음 한 번뿐이다.
  for (let i = 0; i < 10; i += 1) autoReloadOnChunkError(CHROME, store, reload, BUILD_A);
  assert.equal(c.n, 1);
});

test("4행: 복구 뒤 다른 배포(빌드 표시 다름)의 조각 실패는 문구와 화면이 같아도(사파리) 다시 한 번 복구한다", () => {
  const { store } = memoryStore();
  const { c, reload } = counter();
  assert.equal(autoReloadOnChunkError(SAFARI, store, reload, BUILD_A), true);
  assert.equal(autoReloadOnChunkError(SAFARI, store, reload, BUILD_A), false, "같은 빌드는 멈춘다");
  assert.equal(autoReloadOnChunkError(SAFARI, store, reload, BUILD_B), true, "새 배포의 빌드 표시는 다르다");
  assert.equal(autoReloadOnChunkError(SAFARI, store, reload, BUILD_B), false);
  assert.equal(c.n, 2);
});

test("두 경로(Vite 사건·화면 오류 상자)가 다른 문구로 같은 실패를 알려도 같은 빌드에서는 한 번만 센다", () => {
  const { store } = memoryStore();
  const { c, reload } = counter();
  autoReloadOnChunkError("Unable to preload CSS for /assets/StrategyMap-CMSXuMbD.css", store, reload, BUILD_A);
  autoReloadOnChunkError(CHROME, store, reload, BUILD_A);
  assert.equal(c.n, 1);
});

test("5행: 조각 못 읽음이 아닌 오류는 건드리지 않는다", () => {
  const { store, box } = memoryStore();
  const { c, reload } = counter();
  assert.equal(autoReloadOnChunkError("TypeError: x is undefined", store, reload, BUILD_A), false);
  assert.equal(autoReloadOnChunkError(undefined, store, reload, BUILD_A), false);
  assert.equal(c.n, 0);
  assert.equal(box.writes, 0);
});

test("5행: 저장소를 읽거나 쓰지 못하면 새로 읽지 않는다(무한 반복 쪽으로 실패하지 않는다)", () => {
  const { c, reload } = counter();
  const boom = () => { throw new Error("SecurityError"); };
  assert.equal(autoReloadOnChunkError(CHROME, { get: boom, set: () => {} }, reload, BUILD_A), false);
  assert.equal(autoReloadOnChunkError(CHROME, { get: () => null, set: boom }, reload, BUILD_A), false);
  assert.equal(c.n, 0);
});

test("6행: 저장 값이 손상·다른 모양이면 최대 한 번 새로 읽고 지금 표시로 덮은 뒤 같은 빌드 실패는 0회", () => {
  for (const odd of ["깨진 값", '["old-list"]', '{"a":1}', "", "1700000000000"]) {
    const { store, box } = memoryStore(odd);
    const { c, reload } = counter();
    assert.equal(autoReloadOnChunkError(CHROME, store, reload, BUILD_A), true, `다른 모양 ${JSON.stringify(odd)}는 다름`);
    assert.equal(box.value, BUILD_A);
    for (let i = 0; i < 5; i += 1) assert.equal(autoReloadOnChunkError(CHROME, store, reload, BUILD_A), false);
    assert.equal(c.n, 1);
  }
});
