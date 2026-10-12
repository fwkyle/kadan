import test from "node:test";
import assert from "node:assert/strict";
import { formatAlertBody } from "../src/watch-runner.mjs";

test("진행조정 경보 문구는 제목의 verdict를 먼저, 설명의 verdict를 나중에 읽는다 (HW-3-impl2)", () => {
  let reads = 0;
  const alert = {
    kind: "진행조정", role: "qa-worker", taskId: "HW-check", consecutive: 2,
    get verdict() { return ++reads === 1 ? "모름" : "조정"; },
  };
  assert.equal(
    formatAlertBody(alert),
    "진행 판단 불가 qa-worker / HW-check (반복 조정 판정. 직속 감독은 상위 감독에게 범위·담당 조정 요청; 자동 중지 아님)",
  );
  assert.equal(reads, 2);
});
