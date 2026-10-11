import test from "node:test";
import assert from "node:assert/strict";
import { checkEmptyInput } from "../src/floor-tmux.mjs";

// LBR-1 결함 1: 출력이 많이 쌓인 Codex 창(세로 58)의 실제 화면 모양(2026-10-12 실측).
// 입력 줄은 55행(0부터)이다. 옛 관찰 창(세로 40)의 마지막 이동은 39행이라 프롬프트가 아니었다.
const history = Array.from({ length: 51 }, (_, i) => (i === 49 ? "  └ line 1" : i === 50 ? "    … +146 lines" : `  output ${i}`));
const screen = (input = "› Ask Codex to do anything", ...extra) =>
  [...history, "  done 1:18 AM", "", input, ...extra, "", "  gpt-6.1-sol high · ~/proj · main · Context 7% used"].join("\n");
const result = (text, row) => {
  try { checkEmptyInput("test", () => text, row, null, "lbr1"); return "pass"; }
  catch (error) { return error.code; }
};
const inputRow = 53;

test("스크롤백이 쌓인 빈 Codex 입력창은 실제 커서 행에서 통과한다", () => {
  const text = screen();
  assert.equal(text.split("\n")[inputRow], "› Ask Codex to do anything");
  assert.equal(result(text, inputRow), "pass");
});

test("옛 관찰 창의 어긋난 행(40행 안쪽)은 프롬프트로 속지 않고 거절된다", () => {
  assert.equal(result(screen(), 39), "KADAN_PANE_INPUT_UNKNOWN");
});

test("스크롤백이 쌓여도 미제출 입력 보호는 그대로다", () => {
  assert.equal(result(screen("› 사람이 쓰던 글"), inputRow), "KADAN_PANE_INPUT_PENDING");
  assert.equal(result(screen("› first", "  second"), inputRow + 1), "KADAN_PANE_INPUT_PENDING");
  assert.equal(result(screen("› ", "  second"), inputRow), "KADAN_PANE_INPUT_PENDING");
});
