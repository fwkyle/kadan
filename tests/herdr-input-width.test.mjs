import test from "node:test";
import assert from "node:assert/strict";
import { checkEmptyInput } from "../src/floor-tmux.mjs";

// herdr는 observe frame의 width(120)와 실제 화면 줄 길이(212)가 어긋난 채로 올 수 있다.
// 그래서 herdr 바닥은 width에 null을 주고, 화면 안의 테두리만으로 판정한다.
const RULE = "─".repeat(212);
const screen = (...lines) => lines.join("\n");
const header = [" ▐▛███▛█   Claude Code", "", RULE];
const footer = ["  ~/project[main]", "  ⏵⏵ bypass permissions on"];
const check = (text, row, width = null) => checkEmptyInput("s", () => text, row, width, "herdr 전송 보류");

test("폭 숫자와 다른 길이의 빈 Claude 상자는 화면 안 테두리로 통과한다", () => {
  const text = screen(...header, '❯ Try "how does style.css work?"', RULE, ...footer);
  assert.doesNotThrow(() => check(text, 3));
});

test("같은 조건의 한 줄 미제출 입력은 거절한다", () => {
  const text = screen(...header, "❯ 남아 있는 글", RULE, ...footer);
  assert.throws(() => check(text, 3), { code: "KADAN_PANE_INPUT_PENDING" });
});

test("같은 조건의 여러 줄 미제출 입력은 거절한다", () => {
  const text = screen(...header, "❯ 첫 줄", "  둘째 줄", RULE, ...footer);
  assert.throws(() => check(text, 4), { code: "KADAN_PANE_INPUT_PENDING" });
  assert.throws(() => check(text, 3), { code: "KADAN_PANE_INPUT_PENDING" });
});

test("본문 속 ──── 인용은 입력창 테두리로 보지 않는다", () => {
  const quote = "─".repeat(8);
  const text = screen(RULE, "본문 인용입니다", quote, '❯ Try "x"', quote, ...footer);
  assert.throws(() => check(text, 3), { code: "KADAN_PANE_INPUT_PENDING" });
});

test("위 테두리만 맞고 아래가 다르면 거절한다", () => {
  const text = screen(...header, '❯ Try "x"', "─".repeat(100), ...footer);
  assert.throws(() => check(text, 3), { code: "KADAN_PANE_INPUT_PENDING" });
});

test("위 테두리가 화면에서 가장 긴 줄보다 짧으면 거절한다", () => {
  const text = screen("─".repeat(100), '❯ Try "x"', "─".repeat(100), "x".repeat(150));
  assert.throws(() => check(text, 1), { code: "KADAN_PANE_INPUT_PENDING" });
});

test("상자 없는 Codex 화면은 기존 판정을 유지한다", () => {
  assert.doesNotThrow(() => check("\n› Ask Codex to do anything\n\nstatus", 1));
  assert.throws(() => check("\n› 남아 있는 글\n\nstatus", 1), { code: "KADAN_PANE_INPUT_PENDING" });
});

test("codex 0.163 두 줄 바닥글은 폭 없는 경로에서도 빈 입력으로 본다", () => {
  const status = "  GPT-6-Astra high · ~/Dev/kadan · main · Context 0% used · weekly 36% left";
  const hint = "  ← for agents · ? for shortcuts" + " ".repeat(100) + "⚠ 1 warning · f2 to view";
  assert.doesNotThrow(() => check(`\n› Ask Codex to do anything\n\n${status}\n${hint}`, 1));
  assert.throws(() => check(`\n› Ask Codex to do anything\n\n${status}\n${hint}\n  THIRD`, 1), { code: "KADAN_PANE_INPUT_PENDING" });
});

test("폭 숫자를 주는 tmux 경로는 기존처럼 정확히 같은 길이만 통과한다", () => {
  const text = screen(...header, '❯ Try "x"', RULE, ...footer);
  assert.doesNotThrow(() => check(text, 3, 212));
  assert.throws(() => check(text, 3, 120), { code: "KADAN_PANE_INPUT_PENDING" });
});
