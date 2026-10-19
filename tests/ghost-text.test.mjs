import test from "node:test";
import assert from "node:assert/strict";
import { splitGhostText } from "../src/ghost-text.mjs";
import { readStatusLine } from "../src/watch-status-line.mjs";
import { queuedInputBanner } from "../src/watch-queue-resume.mjs";

// 2026-10-19 격리 tmux 실측 사본(claude 2.1.303 Haiku, codex): `capture-pane -e` 입력칸 줄.
// 추천 문구만 `ESC[2m`(흐림). 친 글·빈 칸은 흐림 없음. ❯ 뒤는 U+00A0.
const E = "\x1b";
const RULE = "─".repeat(20);
const dim = (word) => `${E}[2m${word}${E}[0m`;
const CLAUDE_GHOST = `${E}[39m❯ ${dim("Try")} ${dim('"write')} ${dim("a")} ${dim("test")} ${dim("for")} ${E}[2m<filepath>"`;
const CLAUDE_CLEARED = `${E}[39m❯ ${E}[2mTry "write a test for <filepath>"`;
const CLAUDE_TYPED = `${E}[39m❯ hello typed`;
const CLAUDE_EMPTY = `${E}[39m❯ `;
const CODEX_GHOST = `${E}[1m›${E}[0m ${E}[2mAsk Codex to do anything${E}[0m`;
const CODEX_TYPED = `${E}[1m›${E}[0m typed text`;
const HISTORY = `${E}[38;5;246m${E}[48;5;237m❯ ${E}[38;5;231mreply with only the word ok${E}[39m`;

const screen = (input, body = ["⏺ ok", `${E}[2m  도구 출력의 흐린 줄${E}[0m`]) =>
  [HISTORY, "", ...body, RULE, input, RULE, "  Haiku 5.5 | effort:low"].join("\n");
const plainOf = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

test("추천 문구만 있는 입력칸: 판정용은 빈 입력칸, 표시용은 (추천 문구: …)", () => {
  for (const input of [CLAUDE_GHOST, CLAUDE_CLEARED]) {
    const { judge, view, ghost } = splitGhostText(screen(input));
    assert.equal(judge.split("\n").at(-3), "❯ ");
    assert.equal(view.split("\n").at(-3), '❯ (추천 문구: Try "write a test for <filepath>")');
    assert.equal(ghost, 'Try "write a test for <filepath>"');
  }
});

test("실제로 친 글과 빈 입력칸은 판정용·표시용 모두 그대로", () => {
  for (const [input, line] of [[CLAUDE_TYPED, "❯ hello typed"], [CLAUDE_EMPTY, "❯ "]]) {
    const { judge, view, ghost } = splitGhostText(screen(input));
    assert.equal(judge.split("\n").at(-3), line);
    assert.equal(view, judge);
    assert.equal(ghost, "");
  }
});

test("codex 안내문 흐림도 같은 기준, 친 글은 그대로", () => {
  const ghost = splitGhostText(screen(CODEX_GHOST));
  assert.equal(ghost.judge.split("\n").at(-3), "›");
  assert.equal(ghost.view.split("\n").at(-3), "› (추천 문구: Ask Codex to do anything)");
  const typed = splitGhostText(screen(CODEX_TYPED));
  assert.equal(typed.judge.split("\n").at(-3), "› typed text");
  assert.equal(typed.view, typed.judge);
});

test("입력칸 줄 외에는 색만 벗긴 글자와 바이트 단위로 같다(흐린 본문 포함)", () => {
  const ansi = screen(CLAUDE_GHOST);
  const { judge, view } = splitGhostText(ansi);
  const expected = plainOf(ansi).split("\n");
  for (const out of [judge, view]) {
    const lines = out.split("\n");
    lines.forEach((line, i) => { if (i !== lines.length - 3) assert.equal(line, expected[i]); });
  }
  assert.ok(judge.includes("도구 출력의 흐린 줄"));
});

test("OSC 하이퍼링크는 글자만 남기고, 38;2·38;5 색의 숫자 2를 흐림으로 보지 않는다", () => {
  const link = `⏺ Write(${E}]8;id=x;file:///a/hello.py${E}\\hello.py${E}]8;;${E}\\)`;
  const truecolor = `${E}[38;2;10;20;30m❯ typed${E}[0m`;
  const { judge } = splitGhostText([link, truecolor].join("\n"));
  assert.equal(judge, "⏺ Write(hello.py)\n❯ typed");
});

test("입력칸이 없는 화면은 색만 벗긴다", () => {
  const { judge, view, ghost } = splitGhostText(`${E}[2m흐린 본문${E}[0m\n끝`);
  assert.equal(judge, "흐린 본문\n끝");
  assert.equal(view, judge);
  assert.equal(ghost, "");
});

test("감시 판정: 추천 문구 화면은 빈 입력창(멈춤 판정 대상), 친 글은 입력창에 글이 있다", () => {
  const ghost = splitGhostText(screen(CLAUDE_GHOST)).judge;
  assert.equal(readStatusLine(ghost).kind, "idle");
  const codex = splitGhostText(screen(CODEX_GHOST)).judge;
  assert.equal(readStatusLine(codex).kind, "idle");
  assert.equal(readStatusLine(splitGhostText(screen(CLAUDE_TYPED)).judge).kind, "unknown");
  assert.equal(readStatusLine(splitGhostText(screen(CODEX_TYPED)).judge).kind, "unknown");
});

test("큐 재개: 추천 문구는 미완성 글이 아니고 실제 친 글은 불안전", () => {
  const banner = "❭ Press Enter to send queued messages now";
  const build = (input) => splitGhostText([E + "[0m" + banner, "", input].join("\n")).judge;
  assert.equal(queuedInputBanner(build(CLAUDE_GHOST)).unsafe, null);
  assert.equal(queuedInputBanner(build(CLAUDE_TYPED)).unsafe, "입력창에 미완성 텍스트가 있음");
});
