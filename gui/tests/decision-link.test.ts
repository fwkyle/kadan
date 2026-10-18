import test from "node:test";
import assert from "node:assert/strict";
import { linkMode, linkOutcome, linkTarget } from "../src/decision-link.ts";
import { writeAllowed } from "../src/write-policy.ts";
import type { Decision } from "../src/types.ts";

test("알림 링크: 열린 결정이면 양식, 아니면 상태 조회, 링크 없으면 아무것도 안 한다", () => {
  assert.equal(linkTarget("#decision-abc%20d"), "abc d");
  assert.equal(linkTarget("#decisions"), "");
  assert.equal(linkMode("", ["a"]), "none");
  assert.equal(linkMode("a", ["a", "b"]), "form");
  assert.equal(linkMode("z", ["a"]), "lookup");
});
test("알림 링크 상태: 답함·취소는 상태만, 모르는 id는 안내, 불러오는 중은 비움", () => {
  const d = (status: string) => ({ status }) as Decision;
  assert.equal(linkOutcome(undefined), "loading");
  assert.equal(linkOutcome(null), "unknown");
  assert.equal(linkOutcome(d("answered")), "answered");
  assert.equal(linkOutcome(d("cancelled")), "cancelled");
  assert.equal(linkOutcome(d("open")), "open");
});
test("원격 보기 쓰기: 결정 token을 든 /decisions/answer만 열린다", () => {
  assert.equal(writeAllowed("/decisions/answer", "t", true), true);
  assert.equal(writeAllowed("/decisions/answer", "", true), false);
  assert.equal(writeAllowed("/works/create", "t", true), false);
  assert.equal(writeAllowed("/cards/update", "t", true), false);
  assert.equal(writeAllowed("/works/create", "t", false), true);
});
