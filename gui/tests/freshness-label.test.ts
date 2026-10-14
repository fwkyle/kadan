import test from "node:test";
import assert from "node:assert/strict";
import { lastReadLabel } from "../src/freshness-label.ts";
test("마지막 조회 문구는 60초 미만은 초, 이후는 분으로 말한다", () => {
  const now = 1_000_000_000;
  assert.equal(lastReadLabel(now - 8_000, now), "8초 전");
  assert.equal(lastReadLabel(now - 59_999, now), "59초 전");
  assert.equal(lastReadLabel(now - 125_000, now), "2분 전");
  assert.equal(lastReadLabel(now + 5_000, now), "0초 전");
});
