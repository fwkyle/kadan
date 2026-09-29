import test from "node:test";
import assert from "node:assert/strict";
import { durationLabel, kindLabel, modelLabel, profileLabel, unknownReasonLabel, workTitle } from "../src/worktime.ts";

test("작업 시간은 초·분·시간으로 읽기 쉽게 줄이고 값이 없으면 줄표다", () => {
  assert.equal(durationLabel(null), "—");
  assert.equal(durationLabel(undefined), "—");
  assert.equal(durationLabel(-1), "—");
  assert.equal(durationLabel(0), "0초");
  assert.equal(durationLabel(32_233), "32초");
  assert.equal(durationLabel(59_700), "1분", "60초로 올림되면 분으로 넘어간다");
  assert.equal(durationLabel(11.3 * 60_000), "11분");
  assert.equal(durationLabel(60 * 60_000), "1시간");
  assert.equal(durationLabel(68.1 * 60_000), "1시간 8분");
  assert.equal(durationLabel(3_599_600), "1시간", "59분 60초로 보이지 않는다");
});

test("종류·프로필·모델 이름은 화면 말로 바꾸고 모르는 값은 그대로 보인다", () => {
  assert.equal(kindLabel("all"), "전체");
  assert.equal(kindLabel("fix"), "수정");
  assert.equal(kindLabel(""), "종류 없음");
  assert.equal(kindLabel("other"), "other");
  assert.equal(profileLabel("reviewer"), "검수자");
  assert.equal(profileLabel("conductor"), "conductor");
  assert.equal(modelLabel("claude-sonnet-5-5", "xhigh"), "claude-sonnet-5-5 (xhigh)");
  assert.equal(modelLabel("gpt-6-sol"), "gpt-6-sol");
  assert.equal(modelLabel(null, ""), "모름");
  assert.equal(unknownReasonLabel("no-launch"), "실행 명령 기록 없음");
  assert.equal(unknownReasonLabel("x"), "x");
});

test("작업 시간 근거는 기준·대기·마감 대기·재작업을 밝히고 없는 값은 지어내지 않는다", () => {
  const full = workTitle({ workMs: 600_000, workBasis: "start", waitMs: 30_000, closeMs: 120_000, reworks: 1 });
  assert.match(full, /첫 '작업 중' 보고 → 결과 등록/);
  assert.match(full, /대기\(배정 → 시작\) 30초/);
  assert.match(full, /마감 대기\(결과 → 완료 확정\) 2분/);
  assert.match(full, /재작업 1회/);
  const bare = workTitle({ workMs: 600_000, workBasis: "assigned", waitMs: null, closeMs: null, reworks: null });
  assert.match(bare, /시작 보고가 없어 배정 → 결과 등록으로 계산/);
  assert.match(bare, /완료 확정 전/);
  assert.doesNotMatch(bare, /대기\(|재작업/);
  assert.match(workTitle({ workMs: null }), /결과 등록 전/);
});
