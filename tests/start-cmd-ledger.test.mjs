// start 원장에 실행기·모델·명령 원문을 남긴다 (2026-09-06 [kyle] 결정).
// 이전에는 세션이 죽으면 "어느 실행기·어느 모델이었나"를 아무도 못 밝혔다 —
// 원장에는 PID와 창 종류만 있었고, 실제 명령줄은 ps로만 보였다.
import test from "node:test";
import assert from "node:assert/strict";
import { buildStartLedgerEntry, describeStartCmd } from "../src/cli.mjs";

test("codex 명령이면 실행기와 모델을 원장에 남기고 명령 원문도 보존한다 — 2026-09-06", () => {
  const entry = buildStartLedgerEntry({
    floorName: "tmux",
    role: "b1-작업자",
    session: "kadan-b1-작업자",
    evidence: { panePid: "111" },
    window: "rottie",
    cmd: 'codex -p lite --model gpt-6-astra -c model_reasoning_effort="medium"',
    env: {},
  });

  assert.equal(entry.harness, "codex");
  assert.equal(entry.model, "gpt-6-astra");
  // 강도는 실행기마다 플래그가 달라 따로 읽지 않는다. 명령 원문에 그대로 남는다.
  assert.match(entry.cmd, /model_reasoning_effort="medium"/);
});

test("codex인 줄 알았는데 omo였던 경우를 원장이 가른다 — 실행기 착각(2026-08-10 실측)", () => {
  const entry = buildStartLedgerEntry({
    floorName: "tmux",
    role: "b1-검수자",
    session: "kadan-b1-검수자",
    evidence: { panePid: "222" },
    window: "rottie",
    cmd: "omo --model openai-codex/gpt-6-astra --thinking high --no-recommended-models",
    env: {},
  });

  assert.equal(entry.harness, "omo");
  assert.equal(entry.model, "openai-codex/gpt-6-astra");
});

test("절대경로와 환경변수 접두가 붙어도 실행기 이름만 읽는다", () => {
  assert.equal(
    describeStartCmd('LC_ALL=C /opt/homebrew/bin/claude --model claude-fable-5-1').harness,
    "claude"
  );
  assert.equal(
    describeStartCmd('LC_ALL=C /opt/homebrew/bin/claude --model claude-fable-5-1').model,
    "claude-fable-5-1"
  );
});

test("--cmd 없이 띄운 세션과 이미 살아 있어 재사용한 세션에는 아무것도 적지 않는다 — 회귀 0", () => {
  const entry = buildStartLedgerEntry({
    floorName: "tmux",
    role: "b1-감독",
    session: "kadan-b1-감독",
    evidence: { panePid: "333" },
    window: "hidden",
    env: {},
  });

  assert.equal("cmd" in entry, false);
  assert.equal("harness" in entry, false);
  assert.equal("model" in entry, false);
  assert.deepEqual(describeStartCmd(undefined), {});
  assert.deepEqual(describeStartCmd("   "), {});
});

test("모델을 안 고정한 명령은 실행기만 남는다 — 없는 값을 지어내지 않는다", () => {
  const described = describeStartCmd("codex -p lite");

  assert.equal(described.harness, "codex");
  assert.equal("model" in described, false);
  assert.equal(described.cmd, "codex -p lite");
});

test("따옴표로 감싼 모델 이름은 벗겨서 남긴다 — 2026-09-12 kimi 발령 실측", () => {
  const described = describeStartCmd(`codex -p lite --model 'kimi/k3[1m]' -c model_reasoning_effort='"max"'`);

  assert.equal(described.harness, "codex");
  assert.equal(described.model, "kimi/k3[1m]");
});
