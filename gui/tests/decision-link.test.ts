import test from "node:test";
import assert from "node:assert/strict";
import { focusLinkedField, linkMode, linkOutcome, linkTarget } from "../src/decision-link.ts";
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

// 검수 재현: 결정 A 링크로 연 뒤 같은 화면에서 해시를 접힌 결정 B로 바꾼다. 숨겨진 B에는 초점이 가지 않으니 기록하지 않고,
// 펼쳐진 뒤 다시 시도할 때 초점이 간다.
test("해시가 접힌 결정으로 바뀌면 초점이 실제로 간 뒤에야 기록한다", () => {
  let activeElement: unknown = null;
  const field = (hidden: () => boolean) => ({ focus() { if (!hidden()) activeElement = this; } });
  let bHidden = true;
  const bField = field(() => bHidden), aField = field(() => false);
  const bElement = { querySelector: () => bField };
  const aElement = { querySelector: () => aField };
  const active = () => activeElement;
  let focusedFor = focusLinkedField(aElement, "A", "", active);
  assert.equal(focusedFor, "A", "A는 보이는 양식이라 초점이 간다");
  focusedFor = focusLinkedField(bElement, "B", focusedFor, active);
  assert.equal(focusedFor, "A", "B가 접혀 있는 동안은 B에 초점을 줬다고 기록하지 않는다");
  assert.notEqual(activeElement, bField);
  bHidden = false;
  focusedFor = focusLinkedField(bElement, "B", focusedFor, active);
  assert.equal(focusedFor, "B", "펼쳐진 뒤 다시 시도하면 초점이 가고 기록된다");
  assert.equal(activeElement, bField);
  assert.equal(focusLinkedField(bElement, "B", focusedFor, () => null), "B", "이미 줬으면 다시 건드리지 않는다");
  assert.equal(focusLinkedField({ querySelector: () => null }, "C", "B", active), "B", "양식이 아직 없으면 기록하지 않는다");
  assert.equal(focusLinkedField(null, "C", "B", active), "B");
});
