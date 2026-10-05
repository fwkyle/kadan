import test from "node:test";
import assert from "node:assert/strict";
import { radioChecked } from "../src/form-state.ts";

test("빈 값 선택지는 사용자가 고르기 전에는 선택되지 않는다 — 결정 폼의 '메모로 답변'이 기본 선택됐다(2026-10-05)", () => {
  const values = { choice: "" };
  assert.equal(radioChecked(values, {}, "choice", ""), false);
  assert.equal(radioChecked(values, {}, "choice", "5회로 늘림"), false);
  assert.equal(radioChecked(values, { choice: true }, "choice", ""), true);
});

test("값이 있는 선택지는 값이 같을 때만 선택된다", () => {
  assert.equal(radioChecked({ choice: "3회 유지" }, {}, "choice", "3회 유지"), true);
  assert.equal(radioChecked({ choice: "3회 유지" }, {}, "choice", "5회로 늘림"), false);
  assert.equal(radioChecked({}, {}, "choice", ""), false);
});
