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

// TODO 18행(2026-11-20): 비서 복원·재시작이 쓰는 따옴표 친 명령에서 실행기 이름과 모델을 못 읽어
// `kadan status`에 `'codex' · 모름 · 모름`으로 보였다. 기록용 칸만 고친다 — 카단은 이 값으로 판단하지 않는다.
test("따옴표 친 비서 명령도 실행기 이름(따옴표 없이)과 --model 값을 원장 start 칸에 남긴다 — TODO 18행", () => {
  const cmd = `'codex' 'resume' 'conv-1' '--model' 'gpt-x' '-c' 'model_reasoning_effort="high"' --no-alt-screen`;
  const entry = buildStartLedgerEntry({
    floorName: "tmux", role: "비서", session: "kadan-비서", evidence: { panePid: "444" }, window: "hidden", cmd, env: {},
  });

  assert.equal(entry.harness, "codex");
  assert.equal(entry.model, "gpt-x");
  assert.equal(entry.cmd, cmd, "명령 원문은 그대로 보존한다");
  // 새 비서의 첫 시작 명령 꼴(resume 없음)도 같다.
  const fresh = describeStartCmd(`'codex' '--model' 'gpt-x' '-c' 'model_reasoning_effort="medium"'`);
  assert.equal(fresh.harness, "codex");
  assert.equal(fresh.model, "gpt-x");
  // 큰따옴표·한 낱말 꼴·절대경로 실행기도 따옴표 없이 남는다.
  assert.deepEqual(
    [describeStartCmd(`"codex" "--model" "gpt-x"`), describeStartCmd(`'--model=gpt-x'`), describeStartCmd(`'/opt/bin/codex' '--model=gpt-x'`)]
      .map(({ harness, model }) => [harness, model]),
    [["codex", "gpt-x"], ["--model=gpt-x", "gpt-x"], ["codex", "gpt-x"]],
  );
});

test("따옴표 없는 기존 명령의 describeStartCmd 결과는 글자 하나 달라지지 않는다 — TODO 18행 회귀 0", () => {
  // 기준값은 이 수정을 넣기 전 코드가 같은 입력에 낸 실제 출력이다(2026-11-20 수정 전 코드로 뽑아 옮겼다).
  const before = {
    "codex": {"harness": "codex", "conversationMode": "new", "cmd": "codex"},
    "codex -p lite --model gpt-6-astra -c model_reasoning_effort=\"medium\"": {"harness": "codex", "model": "gpt-6-astra", "conversationMode": "new", "cmd": "codex -p lite --model gpt-6-astra -c model_reasoning_effort=\"medium\""},
    "codex --model=gpt-6-sol": {"harness": "codex", "model": "gpt-6-sol", "conversationMode": "new", "cmd": "codex --model=gpt-6-sol"},
    "LC_ALL=C /opt/homebrew/bin/claude --model claude-fable-5-1": {"harness": "claude", "model": "claude-fable-5-1", "conversationMode": "new", "cmd": "LC_ALL=C /opt/homebrew/bin/claude --model claude-fable-5-1"},
    "omo --model openai-codex/gpt-6-astra --thinking high": {"harness": "omo", "model": "openai-codex/gpt-6-astra", "conversationMode": "new", "cmd": "omo --model openai-codex/gpt-6-astra --thinking high"},
    "claude": {"harness": "claude", "conversationMode": "new", "cmd": "claude"},
    "codex resume abc --model gpt-6-luna": {"harness": "codex", "model": "gpt-6-luna", "conversationMode": "resume", "conversationRef": "abc", "cmd": "codex resume abc --model gpt-6-luna"},
    "codex -p lite --model 'kimi/k3[1m]'": {"harness": "codex", "model": "kimi/k3[1m]", "conversationMode": "new", "cmd": "codex -p lite --model 'kimi/k3[1m]'"},
  };
  for (const [cmd, expected] of Object.entries(before)) assert.deepEqual(describeStartCmd(cmd), expected, cmd);
});

// 검수(exec-adb719cf) 중요 1건: 따옴표 친 프롬프트 끝의 `--model`을 옵션으로 읽어 원장 model이 `--model`로 적혔다.
test("따옴표 친 프롬프트 끝이 --model이어도 실제 --model 옵션 값을 남긴다 — 검수 재현 명령", () => {
  const cmd = 'codex "please describe --model" --model fixture-old';
  const entry = buildStartLedgerEntry({
    floorName: "tmux", role: "review-fixture-quoted-prompt", session: "kadan-review-fixture-quoted-prompt",
    evidence: { panePid: "555" }, window: "hidden", cmd, env: {},
  });

  assert.equal(entry.harness, "codex");
  assert.equal(entry.model, "fixture-old");
  assert.equal(entry.cmd, cmd);
  // 따옴표 친 옵션 낱말 뒤가 다시 옵션이면 그것을 모델로 읽지 않는다.
  assert.equal(describeStartCmd('codex "--model" --model y').model, "y");
});

test("프롬프트·옵션·복원 명령 꼴별 모델 칸: 따옴표 없는 꼴은 원래 코드(4176552)와 같고 따옴표 친 옵션만 새로 읽는다", () => {
  // 앞 6줄의 기대값은 이 묶음을 넣기 전 코드(4176552)가 같은 입력에 낸 실제 출력이다(프롬프트 안의 `--model x`를 값으로 읽는
  // 기존 한계도 그대로다). 뒤 4줄은 따옴표 친 꼴로, 원래 코드는 대부분 모델을 못 읽었고 harness에 따옴표가 남았다(2026-11-20 TODO 18행).
  const cases = [
    ['codex "describe --model x" --model fixture-old', "x"],
    ['codex "describe --model x"', "x"],
    ['codex --model="gpt-x" -c a=b', "gpt-x"],
    ["codex --model='gpt-x'", "gpt-x"],
    ["codex -p 'a --model b' --model=gpt-z", "b"],
    ["codex --model=gpt-x", "gpt-x"],
    [`'codex' '--model' 'gpt-x' '-c' 'k=v'`, "gpt-x"],
    [`'codex' '--model=gpt-x'`, "gpt-x"],
    [`'codex' 'resume' 'c1' '--model' 'gpt-x'`, "gpt-x"],
    [`"codex" "--model" "gpt-x"`, "gpt-x"],
  ];
  for (const [cmd, model] of cases) {
    const described = describeStartCmd(cmd);
    assert.equal(described.model, model, cmd);
    assert.equal(described.harness, "codex", cmd);
  }
});

// 수정 2(재검수 exec-bc4f1434): 정규식을 반례마다 고치면 다음 반례가 나온다. 그래서 기준을 "원래 코드(main 4176552)의 결과"로
// 고정한다 — 원래 읽던 값은 그대로 쓰고, 원래 못 읽던 따옴표 친 낱말(`'--model' 'x'`)만 새로 읽는다.
test("기대 결과 표: 모델·실행기 칸 — 재검수 반례 포함", () => {
  const table = [
    [`codex --cd="--model" "inspect project" --model fixture-old`, "fixture-old", "codex"],
    [`codex "please describe --model" --model fixture-old`, "fixture-old", "codex"],
    [`codex "--model" --model y`, "y", "codex"],
    [`'codex' 'resume' 'conv-1' '--model' 'gpt-x'`, "gpt-x", "codex"],
    [`"codex" "--model" "gpt-x"`, "gpt-x", "codex"],
    [`codex "describe --model x"`, "x", "codex"], // 알려진 한계: 원래 코드와 같다
  ];
  for (const [cmd, model, harness] of table) {
    const described = describeStartCmd(cmd);
    assert.deepEqual([described.model, described.harness], [model, harness], cmd);
  }
});

test("main 동치: 4176552의 모델 읽기가 값을 내는 입력은 새 함수도 같은 값을 낸다", () => {
  // 4176552 src/cli-start-support.mjs의 모델 읽기 원문(사본).
  const mainModel = text => text.match(/--model[=\s]+["']*([^\s"']+)["']*/)?.[1];
  const commands = [
    "codex", "claude", 'codex -p lite --model gpt-6-astra -c model_reasoning_effort="medium"', "codex --model=gpt-6-sol",
    "LC_ALL=C /opt/homebrew/bin/claude --model claude-fable-5-1", "omo --model openai-codex/gpt-6-astra --thinking high",
    "codex resume abc --model gpt-6-luna", `codex -p lite --model 'kimi/k3[1m]'`,
    `codex --cd="--model" "inspect project" --model fixture-old`, `codex "please describe --model" --model fixture-old`,
    `codex "--model" --model y`, `codex "describe --model x" --model fixture-old`, `codex "describe --model x"`,
    `codex --model="gpt-x" -c a=b`, `codex --model='gpt-x'`, `codex -p 'a --model b' --model=gpt-z`,
    `codex --cd '--model' 'inspect' --model fixture-old`, `codex 'x --model' --model=fixture-old`,
    `codex "a" "--model" --model y`, `codex --config 'p="--model z"' --model fixture-old`,
    `codex "--model=" --model fixture-old`, `codex -m a "--model b"`, `FOO="--model" codex --model m1`,
    `'codex' '--model=gpt-x'`, `'codex' '--model' 'gpt-x' '-c' 'k=v'`,
  ];
  for (const cmd of commands) {
    const expected = mainModel(cmd.trim());
    if (expected !== undefined) assert.equal(describeStartCmd(cmd).model, expected, cmd);
  }
  // 원래 못 읽던 따옴표 친 낱말만 새로 읽는다.
  assert.equal(mainModel(`'codex' '--model' 'gpt-x'`), undefined);
  assert.equal(describeStartCmd(`'codex' '--model' 'gpt-x'`).model, "gpt-x");
  // 실행기: 낱말 전체가 따옴표로 감싸인 경우에만 벗기고, 따옴표 없는 낱말은 원래대로다.
  assert.equal(describeStartCmd(`'/opt/bin/codex' 'resume' 'c1'`).harness, "codex");
  assert.equal(describeStartCmd("/opt/bin/codex resume c1").harness, "codex");
  assert.equal(describeStartCmd(`LC_ALL=C 'claude' '--model' 'm'`).harness, "claude");
});
