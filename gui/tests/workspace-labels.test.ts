import test from "node:test";
import assert from "node:assert/strict";
import { collectionHint, columnLabel, showDoneButOpen } from "../src/workspace-labels.ts";

test("워크 표에서만 실행 흐름 열을 안쪽 카드 상황으로 부른다", () => {
  assert.equal(columnLabel("healthLabel", "실행 흐름", "work"), "안쪽 카드 상황");
  assert.equal(columnLabel("healthLabel", "실행 흐름", "executions"), "실행 흐름");
  assert.equal(columnLabel("title", "카드 · 목적", "work"), "워크 · 목적");
  assert.equal(columnLabel("title", "카드 · 목적", "executions"), "카드 · 목적");
  assert.equal(columnLabel("turnLabel", "현재 차례", "work"), "현재 차례");
});

test("탭 안내는 워크 미연결 카드를 빼고 워크 안의 카드 수를 센다", () => {
  assert.equal(
    collectionHint({ work: 18, executions: 1225, unlinked: 1000 }),
    "워크 하나에 카드 여러 장이 들어갑니다 · 카드 1225장 중 225장은 워크 안, 1000장은 워크 미연결",
  );
  assert.equal(collectionHint(undefined), "워크 하나에 카드 여러 장이 들어갑니다.");
});

test("닫을 카드는 카드 표에서만 보인다", () => {
  assert.equal(showDoneButOpen("work", 221), false);
  assert.equal(showDoneButOpen("executions", 221), true);
  assert.equal(showDoneButOpen("unlinked", 3), true);
  assert.equal(showDoneButOpen("executions", 0), false);
});
