import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { splitGhostText } from "../src/ghost-text.mjs";
import { assessIdleStop, readStatusLine } from "../src/watch-status-line.mjs";
import { queuedInputBanner } from "../src/watch-queue-resume.mjs";
import { currentErrorBlock, currentStopPhrases } from "../src/watch-stop-phrases.mjs";

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
  (input.includes("›")
    ? [HISTORY, "", ...body, input, "", "  GPT-6.1-Sol default · /tmp/example"]
    : [HISTORY, "", ...body, RULE, input, RULE, "  Haiku 5.5 | effort:low"]).join("\n");
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
  const build = (input) => splitGhostText(screen(input, [E + "[0m" + banner])).judge;
  assert.equal(queuedInputBanner(build(CLAUDE_GHOST)).unsafe, null);
  assert.equal(queuedInputBanner(build(CLAUDE_TYPED)).unsafe, "입력창에 미완성 텍스트가 있음");
});

test("실측 -e/-p 사본 7쌍: 입력칸 외 모든 바이트와 줄 수를 보존한다", () => {
  const { fixtures } = JSON.parse(fs.readFileSync(
    new URL("./fixtures/ghost-text-screens.json", import.meta.url), "utf8"));
  for (const { name, ansi, plain } of fixtures) {
    const expected = plain.split("\n");
    const input = expected.findLastIndex(line => /^\s*[❯›>]/u.test(line));
    const withoutInput = text => text.split("\n").filter((_, i) => i !== input).join("\n");
    const { judge, view, ghost } = splitGhostText(ansi);
    for (const text of [judge, view]) {
      assert.equal(text.split("\n").length, expected.length, name);
      assert.deepEqual(Buffer.from(withoutInput(text)), Buffer.from(withoutInput(plain)), name);
    }
    if (!ghost) assert.equal(judge, plain, name);
  }
});

test("#200 현재 오류 판정: 추천 입력칸이면 오류, 실제 입력 중이면 제외", () => {
  for (const [ghostInput, typedInput] of [[CLAUDE_GHOST, CLAUDE_TYPED], [CODEX_GHOST, CODEX_TYPED]]) {
    const build = input => splitGhostText(screen(input, ["■ 502 Bad Gateway", ""])).judge;
    assert.equal(currentErrorBlock(build(ghostInput))?.head, "■ 502 Bad Gateway");
    assert.equal(currentStopPhrases(build(ghostInput)).size, 1);
    assert.equal(currentErrorBlock(build(typedInput)), null);
    assert.equal(currentStopPhrases(build(typedInput)).size, 0);
  }
});

test("PR-A (b): 같은 추천 화면이 계속되면 멈춤 경보, 실제 입력이면 경보 없음", () => {
  for (const input of [CLAUDE_GHOST, CODEX_GHOST, CLAUDE_TYPED, CODEX_TYPED]) {
    const text = splitGhostText(screen(input)).judge;
    const observations = new Map([["kadan-ghost-fixture", {
      role: "ghost-fixture", alive: true, screen: text, digest: text,
    }]]);
    const options = { elapsedMs: 1_000, intervalMs: 1_000, afterMs: 1_000,
      tasks: [{ role: "ghost-fixture", t: "2026-10-19T00:00:00Z" }] };
    const first = assessIdleStop(new Map(), observations, options);
    const second = assessIdleStop(first.states, observations, options);
    assert.equal(second.alerts.length, [CLAUDE_GHOST, CODEX_GHOST].includes(input) ? 1 : 0);
  }
});

test("흐린 조각 사이의 실제 입력과 입력 기호는 지우지 않는다", () => {
  const input = `${E}[2m› hint${E}[22m 실제 입력 ${E}[2mtail${E}[0m`;
  const { judge, view } = splitGhostText(screen(input));
  assert.equal(judge.split("\n").at(-3), "›  실제 입력");
  assert.ok(view.includes("실제 입력"));
  assert.ok(view.split("\n").at(-3).startsWith("› "));
});

test("앞 줄에서 이어진 흐림 상태도 입력칸에서만 제거한다", () => {
  const { judge } = splitGhostText(screen(`› 안내문${E}[0m`, [`${E}[2m흐린 본문`]));
  assert.ok(judge.includes("흐린 본문\n›\n"));
});

test("입력 기호만 있거나 바닥글이 불확실하면 흐린 본문을 보존한다", () => {
  const quote = `${E}[2m› 본문 인용${E}[0m`;
  for (const ansi of [quote, `• 답변 출력 중\n${quote}\nREADY-END`,
    `${quote}\n  사람이 쓴 초안\n  ? for shortcuts`,
    screen(quote) + "\n  SECOND_PENDING",
    screen(quote).replace("\n\n  GPT-", "\n  GPT-"),
    screen(quote).replace("  GPT-6.1-Sol default · /tmp/example", "  알 수 없는 바닥글"),
    `${RULE}\n${CLAUDE_GHOST}\n${RULE}`,
    screen(CLAUDE_GHOST).replace(RULE, "본문"),
    screen(CLAUDE_GHOST).replaceAll("❯", ">")]) {
    const out = splitGhostText(ansi);
    assert.equal(out.judge, plainOf(ansi), ansi);
    assert.equal(out.view, out.judge);
    assert.equal(out.ghost, "");
  }
});

test("잘린 제어 순서와 해석 불명 색 매개변수는 추천 제거를 보류한다", () => {
  const base = screen(CODEX_GHOST);
  for (const control of [`${E}[38:2::`, `${E}]8;;https://example.com/`, `${E}Popaque`]) {
    const out = splitGhostText(base + "\n" + control);
    assert.equal(out.judge, plainOf(base) + "\n");
    assert.equal(out.ghost, "");
  }
  for (const control of [`${E}[38;3m`, `${E}[38:3:2m`, `${E}[2:9m`]) {
    const out = splitGhostText(control + base);
    assert.equal(out.judge, plainOf(base));
    assert.equal(out.ghost, "");
  }
});

test("확장 SGR의 색 채널 2·0·22를 흐림/해제로 오인하지 않는다", () => {
  for (const color of ["38;2;2;0;22", "48;5;2", "58;2;2;0;22",
    "38:2::2:0:22", "48:2:0:2:0:22", "58:5:2", "4:3"]) {
    for (const reset of ["m", "22m", "0m"]) {
      const input = `› ${E}[2mhint${E}[${color}m tail${E}[${reset}실제 글`;
      const out = splitGhostText(screen(input));
      assert.equal(out.judge.split("\n").at(-3), "› 실제 글", `${color}/${reset}`);
      const typed = screen(`› ${E}[${color}m실제 글${E}[0m`);
      assert.equal(splitGhostText(typed).ghost, "", color);
    }
  }
});

test("CSI 전체 문법·미지 ESC는 글자로 새지 않고 추천 제거를 보류한다", () => {
  const base = screen(CODEX_GHOST);
  for (const control of [`${E}[?25h`, `${E}[>0m`, `${E}[<1;2;3M`, `${E}[=1h`,
    `${E}[1 q`, `${E}(B`, `${E}Popaque${E}\\`, `${E}^private${E}\\`]) {
    const out = splitGhostText(control + base);
    assert.equal(out.judge, plainOf(base), JSON.stringify(control));
    assert.equal(out.view, out.judge);
    assert.equal(out.ghost, "");
  }
});

// 2026-11-10 사건(쉬는 역할의 restart 거절): 입력칸 아래 바닥글을 못 알아봐 흐린 제안 문구가 판정용 화면에 남았다.
// 아래 화면은 실물의 줄 배치·이스케이프 구조만 옮긴 것이고 글자는 지어낸 것이다.
//  - 모델 표시는 Claude Code가 주는 글자라 계열 이름이 고정이 아니다(`Fable 5.2`, 모델 ID 그대로인 꼴).
//  - 좁은 화면: 권한 줄 아래에 오른쪽 정렬 알림 줄이 따로 붙는다.
//  - 상태 줄 두 줄(경로·모델)이 사라지고 권한 줄(끝에 알림이 붙기도 함)만 남은 화면.
const PATH_LINE = "  ~/Dev/example[main]";
const MODE_LINE = "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents";
const UPDATE_NOTICE = "✔ Update installed · /restart to apply";
const COMPACT_NOTICE = "Conversation compacted (ctrl+o for the summary)";
const right = text => " ".repeat(40) + text;
const OPUS_STATUS = "  Opus 5.5 | effort:medium | ctx:26%";
// 모델 표시: 새 계열 이름, 모델 ID 원문, 지어낸 이름, 공백·괄호가 든 이름, effort가 없는 상태 줄.
const NEW_MODEL_FOOTERS = ["Fable 5.2 | effort:high | ctx:37%", "claude-fable-5-2 | effort:medium",
  "Zorvex Nine | effort:xhigh | 2h 10m left | ctx:91%", "Zorvex 9 (wide window) | effort:low",
  "my-team/zorvex-9[beta]", "조르벡스 9 · 높음"].map(status => [PATH_LINE, `  ${status}`, MODE_LINE]);
const OLD_MODEL_FOOTERS = [OPUS_STATUS, "  Sonnet 5.5 | effort:medium", "  Haiku 5.5 | effort:low"]
  .map(status => [PATH_LINE, status, MODE_LINE]);
const NOTICE_FOOTERS = [
  [PATH_LINE, OPUS_STATUS, MODE_LINE, right(UPDATE_NOTICE), right(COMPACT_NOTICE)],
  [PATH_LINE, OPUS_STATUS, MODE_LINE, right(COMPACT_NOTICE)],
  [`${PATH_LINE}${right(UPDATE_NOTICE)}`, OPUS_STATUS, MODE_LINE, right(COMPACT_NOTICE)],
  // 목록에 없던 알림 줄(지어낸 문구)도 같은 결과여야 한다.
  [PATH_LINE, OPUS_STATUS, MODE_LINE, right("✔ 지어낸 새 알림 · /something to apply")],
];
const MANY_NOTICES = [right(UPDATE_NOTICE), right(COMPACT_NOTICE),
  ...[1, 2, 3, 4].map(n => right(`✔ 지어낸 알림 ${n} · /something to apply`))];
const MODE_ONLY_FOOTERS =[[`${MODE_LINE}   ${UPDATE_NOTICE}`], [MODE_LINE], [MODE_LINE, right(COMPACT_NOTICE)]];
const DIM_BODY = `${E}[2m  도구 출력의 흐린 줄${E}[0m`;
const claudeScreen = (input, footer, body = ["⏺ ok", DIM_BODY]) =>
  [HISTORY, "", ...body, RULE, input, RULE, ...footer].join("\n");
const inputOf = (text, footer) => text.split("\n").at(-(footer.length + 2));

function assertGhostRemoved(footers) {
  for (const footer of footers) {
    const label = footer.join(" / ");
    const { judge, view, ghost } = splitGhostText(claudeScreen(CLAUDE_GHOST, footer));
    assert.equal(inputOf(judge, footer), "❯ ", label);
    assert.equal(inputOf(view, footer), '❯ (추천 문구: Try "write a test for <filepath>")', label);
    assert.equal(ghost, 'Try "write a test for <filepath>"', label);
    assert.equal(readStatusLine(judge).kind, "idle", label);
    // 입력칸 밖(본문의 흐린 글자·바닥글)은 색만 벗긴 글자 그대로다.
    const expected = plainOf(claudeScreen(CLAUDE_GHOST, footer)).split("\n");
    judge.split("\n").forEach((line, i, all) => {
      if (i !== all.length - footer.length - 2) assert.equal(line, expected[i], label);
    });
  }
}

test("모델 표시가 무엇이든(새 계열·모델 ID 원문·지어낸 이름·공백·괄호): 추천 문구만 판정용에서 빠진다", () => {
  assertGhostRemoved(NEW_MODEL_FOOTERS);
});

test("권한 줄 아래 오른쪽 정렬 알림 줄(관찰한 두 가지와 모르는 알림): 추천 문구만 빠진다", () => {
  assertGhostRemoved(NOTICE_FOOTERS);
});

test("codex도 모델 이름에 기대지 않는다: 지어낸 모델 이름에서 같은 결과", () => {
  for (const status of ["  zorvex-9-turbo high · ~/Dev/example", "  my-team/zorvex[beta] xhigh · /tmp/example · Context 32% used"]) {
    const build = input => [HISTORY, "", "⏺ ok", input, "", status].join("\n");
    const ghost = splitGhostText(build(CODEX_GHOST));
    assert.equal(ghost.judge.split("\n").at(-3), "›", status);
    assert.equal(ghost.ghost, "Ask Codex to do anything", status);
    assert.equal(readStatusLine(ghost.judge).kind, "idle", status);
    const typed = splitGhostText(build(CODEX_TYPED));
    assert.equal(typed.judge.split("\n").at(-3), "› typed text", status);
    assert.equal(typed.ghost, "", status);
  }
});

test("상태 줄 없이 권한 줄만 남은 바닥글: 추천 문구만 빠진다", () => {
  assertGhostRemoved(MODE_ONLY_FOOTERS);
});

test("알림 줄이 더 붙어 바닥글이 6·7·8줄이어도 추천 문구만 빠진다(9줄부터는 보존)", () => {
  const base = [PATH_LINE, OPUS_STATUS, MODE_LINE];
  assertGhostRemoved([3, 4, 5].map(extra => [...base, ...MANY_NOTICES.slice(0, extra)]));
  const nine = [...base, ...MANY_NOTICES.slice(0, 6)];
  const ansi = claudeScreen(CLAUDE_GHOST, nine);
  const out = splitGhostText(ansi);
  assert.equal(out.judge, plainOf(ansi));
  assert.equal(out.ghost, "");
});

test("기존 상태 줄(Opus·Sonnet·Haiku)은 그대로 통과한다", () => {
  assertGhostRemoved(OLD_MODEL_FOOTERS);
});

test("새 바닥글 꼴 모두에서 사람이 친 글(흐리지 않음)은 그대로 남는다", () => {
  for (const footer of [...NEW_MODEL_FOOTERS, ...NOTICE_FOOTERS, ...MODE_ONLY_FOOTERS, ...OLD_MODEL_FOOTERS]) {
    const label = footer.join(" / ");
    const ansi = claudeScreen(CLAUDE_TYPED, footer);
    const { judge, view, ghost } = splitGhostText(ansi);
    assert.equal(inputOf(judge, footer), plainOf(CLAUDE_TYPED), label);
    assert.equal(judge, plainOf(ansi), label);
    assert.equal(view, judge, label);
    assert.equal(ghost, "", label);
    assert.equal(readStatusLine(judge).kind, "unknown", label);
  }
});

test("새 바닥글 꼴에서도 응답 생성 중 화면(회전 줄·도구 실행 줄)은 idle이 되지 않는다", () => {
  const working = [
    ["✢ Grooving… (32s · ↓ 1.7k tokens)", ""],
    ["  Bash(<오래 걸리는 명령>)", "  ⎿  Running… (4s)", "     (ctrl+b ctrl+b (twice) to run in background)", ""],
  ];
  for (const footer of [...NEW_MODEL_FOOTERS, ...NOTICE_FOOTERS, ...MODE_ONLY_FOOTERS]) {
    for (const body of working) {
      for (const input of [CLAUDE_GHOST, CLAUDE_EMPTY]) {
        const { judge } = splitGhostText(claudeScreen(input, footer, body));
        assert.equal(readStatusLine(judge).kind, "working", `${footer.join(" / ")} · ${body[0]}`);
      }
    }
  }
});

// PR #374 검수 F1: 바닥글이 길면 회전 줄이 화면 끝 14줄 밖으로 밀려, 추천 문구만 지워진 화면이 idle로 읽혔다.
// 검수자 표(회전 줄과 입력칸 사이 빈 줄 1~4개 × 바닥글 5·8줄 × 추천·친 글·섞인 입력)를 그대로 옮긴다.
test("검수 F1: 바닥글이 길어도 회전 줄이 보이는 화면은 working이다(빈 줄 1~4 × 바닥글 5·8줄 × 입력 3종)", () => {
  const spinner = "✢ Grooving… (32s · ↓ 1.7k tokens)";
  const tip = "  ⎿  Tip: 지어낸 도움말 줄";
  const mixed = `${E}[39m❯ 실제입력${E}[2m추천${E}[0m`;
  const footers = [5, 8].map(count => Array.from({ length: count }, (_, i) => `  알림 ${i + 1}`));
  for (const footer of footers) {
    for (const blanks of [1, 2, 3, 4]) {
      for (const body of [[spinner, ...Array(blanks).fill("")], [spinner, tip, ...Array(blanks).fill("")]]) {
        for (const input of [CLAUDE_GHOST, CLAUDE_EMPTY, CLAUDE_TYPED, mixed]) {
          const ansi = [...body, RULE, input, RULE, ...footer].join("\n");
          const { judge } = splitGhostText(ansi);
          const label = `바닥글 ${footer.length}줄 · 빈 줄 ${blanks} · ${body.length - blanks}줄 본문 · ${plainOf(input)}`;
          assert.deepEqual(readStatusLine(judge), { kind: "working", tool: "claude", clockSec: 32 }, label);
          // 친 글은 지워지지 않는다.
          if (input === CLAUDE_TYPED) assert.ok(judge.includes("hello typed"), label);
          if (input === mixed) assert.ok(judge.includes("실제입력"), label);
        }
      }
    }
  }
});

test("검수 F1 반대 방향: 회전 줄이 없는 쉬는 화면은 바닥글 1·3·5·8줄 모두 idle 그대로다", () => {
  const done = "✻ Cogitated for 3m 44s";
  for (const count of [1, 3, 5, 8]) {
    const footer = Array.from({ length: count }, (_, i) => `  알림 ${i + 1}`);
    for (const blanks of [1, 4]) {
      const { judge } = splitGhostText([done, ...Array(blanks).fill(""), RULE, CLAUDE_GHOST, RULE, ...footer].join("\n"));
      assert.equal(readStatusLine(judge).kind, "idle", `바닥글 ${count}줄 · 빈 줄 ${blanks}`);
    }
  }
  // 사건 세 시점의 바닥글 꼴도 그대로 idle이다.
  for (const footer of [NOTICE_FOOTERS[0], ...MODE_ONLY_FOOTERS]) {
    assert.equal(readStatusLine(splitGhostText(claudeScreen(CLAUDE_GHOST, footer)).judge).kind, "idle", footer.join(" / "));
  }
});

// PR #374 검수 F2: codex 상태 줄은 "모델 낱말 + 강도 낱말 + ` · ` + 경로" 구조만 본다(강도 낱말 목록 없음).
test("검수 F2: codex 상태 줄의 강도 낱말이 무엇이든 같은 결과이고, 구조가 다른 줄은 상태 줄이 아니다", () => {
  const build = (input, status) => [HISTORY, "", "⏺ ok", input, "", status].join("\n");
  for (const status of ["  unknown-model future-effort · /tmp/example", "  zorvex-9 ultra · ~/Dev/example · Context 32% used",
    "  GPT-6.1-Sol default · /tmp/example", "  gpt-6.1-sol xhigh · ~/Dev/example"]) {
    const ghost = splitGhostText(build(CODEX_GHOST, status));
    assert.equal(ghost.judge.split("\n").at(-3), "›", status);
    assert.equal(ghost.ghost, "Ask Codex to do anything", status);
    assert.equal(readStatusLine(ghost.judge).kind, "idle", status);
    const typed = splitGhostText(build(CODEX_TYPED, status));
    assert.equal(typed.judge, plainOf(build(CODEX_TYPED, status)), status);
    assert.equal(typed.ghost, "", status);
    // 단축키 줄이 붙은 두 줄 바닥글도 같다.
    const two = splitGhostText(`${build(CODEX_GHOST, status)}\n  ? for shortcuts`);
    assert.equal(two.ghost, "Ask Codex to do anything", status);
  }
  const quote = `${E}[2m› 본문 인용${E}[0m`;
  for (const line of ["  한낱말 · /tmp/example", "  세 낱말 이상 줄 · /tmp/example", "  model effort · 경로아님",
    "  model effort /tmp/example", "model effort · /tmp/example", "  model  effort · /tmp/example"]) {
    const ansi = build(quote, line);
    const out = splitGhostText(ansi);
    assert.equal(out.judge, plainOf(ansi), line);
    assert.equal(out.ghost, "", line);
  }
  // 상태 줄 꼴이어도 codex 입력칸의 다른 조건(다음 줄 빈 줄, 바닥글 1~2줄)이 어긋나면 보존한다.
  for (const ansi of [[quote, "  model effort · /tmp/example"].join("\n"),
    [quote, "", "  model effort · /tmp/example", "  이어지는 본문"].join("\n"),
    [quote, "", "  model effort · /tmp/example", "  ? for shortcuts", "  한 줄 더"].join("\n")]) {
    const out = splitGhostText(ansi);
    assert.equal(out.judge, plainOf(ansi), ansi);
    assert.equal(out.ghost, "", ansi);
  }
});

test("입력칸이 아닌 곳은 그대로 둔다: 가로줄 없는 인용·들여쓴 인용·선택 메뉴·바닥글 없음·바닥글 6줄 이상", () => {
  const quote = `${E}[2m❯ 본문 인용${E}[0m`;
  const footer = [PATH_LINE, OPUS_STATUS, MODE_LINE];
  const indent = (lines, pad) => lines.map(line => pad + line);
  for (const ansi of [
    // 가로줄 없는 본문 인용 뒤에 상태 줄·권한 줄처럼 생긴 줄
    [quote, ...footer].join("\n"),
    // 위나 아래 한쪽만 가로줄
    [RULE, quote, ...footer].join("\n"),
    [quote, RULE, ...footer].join("\n"),
    // 본문·도구 출력 속 화면 인용은 들여쓰기가 있다(입력칸은 첫 칸에서 시작한다)
    indent([RULE, quote, RULE, ...footer], "  ").join("\n"),
    ["⏺ 화면 인용", ...indent([RULE, quote, RULE, ...footer], "     ")].join("\n"),
    [RULE, ` ${quote}`, RULE, ...footer].join("\n"),
    [` ${RULE}`, quote, ` ${RULE}`, ...footer].join("\n"),
    // 선택 메뉴: ❯가 두 가로줄 바로 사이에 있지 않다
    [RULE, "  무엇을 할까요?", `${E}[2m❯ 1. 지어낸 선택지${E}[0m`, "  2. 다른 선택지", RULE,
      "  Enter to select · Esc to cancel"].join("\n"),
    [RULE, "  1. 지어낸 선택지", `${E}[2m❯ 2. 다른 선택지${E}[0m`, RULE, "  Enter to select · Esc to cancel"].join("\n"),
    // 바닥글이 한 줄도 없다
    [RULE, quote, RULE].join("\n"),
    [RULE, quote, RULE, "", ""].join("\n"),
    // 바닥글이 8줄을 넘는다(입력칸이 화면 끝에 있지 않다)
    [RULE, quote, RULE, ...footer, ...MANY_NOTICES.slice(0, 6)].join("\n"),
    [RULE, quote, RULE, ...footer, ...MANY_NOTICES.slice(0, 6), "  이어지는 본문", "  더 이어지는 본문"].join("\n"),
  ]) {
    const out = splitGhostText(ansi);
    assert.equal(out.judge, plainOf(ansi), ansi);
    assert.equal(out.view, out.judge, ansi);
    assert.equal(out.ghost, "", ansi);
  }
});

test("OSC의 두 종료 형식은 링크 글자와 확인된 추천 판정을 보존한다", () => {
  for (const end of ["\x07", `${E}\\`]) {
    const link = `${E}]8;;https://example.com/${end}링크${E}]8;;${end}`;
    const out = splitGhostText(screen(CODEX_GHOST, [link]));
    assert.ok(out.judge.includes("링크\n›\n"));
    assert.equal(out.ghost, "Ask Codex to do anything");
  }
});
