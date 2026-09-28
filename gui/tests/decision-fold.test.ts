import test from "node:test";
import assert from "node:assert/strict";
import { foldKey, readFolded, saveFolded, toggleFolded } from "../src/decision-fold.ts";

test("접어 둔 결정은 이 브라우저에 기억하고, 저장할 때 아직 기다리는 결정만 남긴다", () => {
  const data = new Map<string, string>();
  const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
  assert.deepEqual([...readFolded(store)], []);
  let folded = toggleFolded(readFolded(store), "d-interview");
  saveFolded(store, folded, ["d-interview", "d-other"]);
  assert.deepEqual([...readFolded(store)], ["d-interview"], "새로 읽어도 접힌 채로 남는다");
  folded = toggleFolded(toggleFolded(readFolded(store), "d-gone"), "d-other");
  saveFolded(store, folded, ["d-interview", "d-other"]);
  assert.deepEqual([...readFolded(store)].sort(), ["d-interview", "d-other"], "끝난 결정 ID는 지운다");
  saveFolded(store, toggleFolded(readFolded(store), "d-interview"), ["d-interview", "d-other"]);
  assert.deepEqual([...readFolded(store)], ["d-other"], "다시 누르면 펼쳐진다");
});

test("저장 값이 깨졌거나 저장소를 못 쓰면 접힌 것 없이 시작하고 멈추지 않는다", () => {
  assert.deepEqual([...readFolded({ getItem: () => "{깨짐", setItem: () => {} })], []);
  assert.deepEqual([...readFolded({ getItem: () => JSON.stringify([1, "ok", null]), setItem: () => {} })], ["ok"]);
  assert.deepEqual([...readFolded(null)], []);
  assert.doesNotThrow(() => saveFolded({ getItem: () => null, setItem: () => { throw new Error("quota"); } }, new Set(["a"]), ["a"]));
  assert.equal(foldKey, "kadan.decisions.folded");
});
