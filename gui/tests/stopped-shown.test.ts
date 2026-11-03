import test from "node:test";
import assert from "node:assert/strict";
import { ALERT_SHOWN, STOP_SHOWN, headRest } from "../src/stopped.ts";

const list = (n: number) => Array.from({ length: n }, (_, i) => i);
test("막힘 묶음 3장·4장 경계: 앞 3장은 늘 보이고 나머지만 접힘", () => {
  assert.deepEqual(headRest(list(3), STOP_SHOWN), { head: [0, 1, 2], rest: [] });
  assert.deepEqual(headRest(list(4), STOP_SHOWN), { head: [0, 1, 2], rest: [3] });
});
test("경보 5건·6건 경계: 앞 5건은 늘 보이고 나머지만 접힘", () => {
  assert.equal(headRest(list(5), ALERT_SHOWN).rest.length, 0);
  const six = headRest(list(6), ALERT_SHOWN);
  assert.deepEqual([six.head.length, six.rest.length], [5, 1]);
});
