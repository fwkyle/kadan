import test from "node:test";
import assert from "node:assert/strict";
import { chatAge } from "../src/chat-age.ts";

test("채팅 질문이 안 닫힌 채 흐른 시간을 분·시간·일로 보인다", () => {
  const at = "2026-10-23T00:00:00.000Z", base = Date.parse(at);
  assert.equal(chatAge(at, base + 20_000), "방금");
  assert.equal(chatAge(at, base + 5 * 60_000), "5분 경과");
  assert.equal(chatAge(at, base + 3 * 3_600_000), "3시간 경과");
  assert.equal(chatAge(at, base + 72 * 3_600_000), "3일 경과");
  assert.equal(chatAge(undefined, base), "");
  assert.equal(chatAge(at, base - 1), "", "시계가 어긋나면 지어내지 않는다");
});
