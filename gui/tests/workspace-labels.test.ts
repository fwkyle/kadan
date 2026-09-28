import test from "node:test";
import assert from "node:assert/strict";
import { collectionHint, columnLabel, showDoneButOpen } from "../src/workspace-labels.ts";

test("업무 표에서만 실행 흐름 열을 안쪽 실행 상황으로 부른다", () => {
  assert.equal(columnLabel("healthLabel", "실행 흐름", "work"), "안쪽 실행 상황");
  assert.equal(columnLabel("healthLabel", "실행 흐름", "executions"), "실행 흐름");
  assert.equal(columnLabel("turnLabel", "현재 차례", "work"), "현재 차례");
});

test("탭 안내는 업무 미연결 실행을 빼고 업무 안의 실행 수를 센다", () => {
  assert.equal(
    collectionHint({ work: 18, executions: 1225, unlinked: 1000 }),
    "업무 하나에 실행 여러 건이 들어갑니다 · 실행 1225건 중 225건은 업무 안, 1000건은 업무 미연결",
  );
  assert.equal(collectionHint(undefined), "업무 하나에 실행 여러 건이 들어갑니다.");
});

test("닫을 실행 카드는 실행 표에서만 보인다", () => {
  assert.equal(showDoneButOpen("work", 221), false);
  assert.equal(showDoneButOpen("executions", 221), true);
  assert.equal(showDoneButOpen("unlinked", 3), true);
  assert.equal(showDoneButOpen("executions", 0), false);
});
