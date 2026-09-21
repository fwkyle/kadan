// 작업자와 검수자가 같은 계열이면 경고·원장만 남기고 send는 막지 않는다.
import test from "node:test";
import assert from "node:assert/strict";
import {
  dutyHead,
  familyConflictAlerts,
  guardedSend,
  modelFamily,
} from "../src/cli.mjs";

function floorAlive() {
  return {
    name: "fake",
    alive: () => true,
    pid: () => "111",
    send: () => ({}),
  };
}

function start(role, model) {
  return {
    kind: "start",
    role,
    session: `kadan-${role}`,
    panePid: "111",
    ...(model ? { model } : {}),
  };
}

test("openai-codex 접두가 있어도 gpt로 읽고, 모르는 이름은 모름이다", () => {
  assert.equal(modelFamily("openai-codex/gpt-6-astra"), "gpt");
  assert.equal(modelFamily("gpt-6-astra"), "gpt");
  assert.equal(modelFamily("anthropic/claude-opus-5"), "claude");
  assert.equal(modelFamily("claude-fable-5-1"), "claude");
  // claude 실행기의 짧은 별명 (claude --model fable / --model opus)
  assert.equal(modelFamily("fable"), "claude");
  assert.equal(modelFamily("opus"), "claude");
  assert.equal(modelFamily("zai/glm-5.3-flash"), "glm");
  assert.equal(modelFamily("kimi/k3[1m]"), "kimi");
  assert.equal(modelFamily("xai/grok-4.6"), "grok");
  assert.equal(modelFamily("command-code/deepseek-deepseek-v4-flash"), "deepseek");
  assert.equal(modelFamily("google/gemini-2.5-pro"), "gemini");
  // devin 실행기 (devin --model swe-2-max)
  assert.equal(modelFamily("swe-2-max"), "swe");
  assert.equal(modelFamily("swe-2-high"), "swe");
  assert.equal(modelFamily("mystery-model"), "모름");
  assert.equal(modelFamily(undefined), "모름");
  assert.equal(modelFamily(""), "모름");
});

test("판 접두사를 뺀 첫 직무 조각이 검수자면 비교하고, 후임 -2도 검수자다", () => {
  assert.equal(dutyHead("p-검수자"), "검수자");
  assert.equal(dutyHead("p-검수자-2"), "검수자");
  assert.equal(dutyHead("card47-검수자-2"), "검수자");
  assert.equal(dutyHead("p-작업자"), "작업자");
  assert.equal(dutyHead("p-작업자-감독보조"), "작업자");
  assert.equal(dutyHead("p-감독"), "감독");
});

test("정상 경로: 작업자 gpt / 검수자 claude → 경고 없음, 원장 alert 0줄, send 성공", () => {
  const records = [];
  const warnings = [];
  const previous = console.error;
  console.error = (line) => warnings.push(String(line));
  try {
    const sent = guardedSend({
      floor: floorAlive(),
      session: "kadan-p-검수자",
      role: "p-검수자",
      message: "검수해라",
      recordedPid: "111",
      env: { KADAN_ROLE: "p-감독" },
      record: (entry) => records.push(entry),
      readEntries: () => [
        start("p-작업자", "gpt-6-astra"),
        start("p-검수자", "anthropic/claude-opus-5"),
      ],
    });
    assert.equal(sent.kind, "send");
    assert.equal(sent.role, "p-검수자");
    assert.equal(records.length, 1);
    assert.equal(records[0].kind, "send");
    assert.equal(warnings.length, 0);
  } finally {
    console.error = previous;
  }
});

test("작업자와 검수자가 같은 계열이어도 조용히 통과하던 것 — 2026-09-06", () => {
  const records = [];
  const warnings = [];
  const previous = console.error;
  console.error = (line) => warnings.push(String(line));
  try {
    const sent = guardedSend({
      floor: floorAlive(),
      session: "kadan-p-검수자",
      role: "p-검수자",
      message: "검수해라",
      recordedPid: "111",
      env: { KADAN_ROLE: "p-감독" },
      record: (entry) => records.push(entry),
      readEntries: () => [
        start("p-작업자", "gpt-6-astra"),
        start("p-검수자", "openai-codex/gpt-6-astra"),
      ],
    });
    assert.equal(sent.kind, "send");
    assert.equal(records.filter((entry) => entry.kind === "send").length, 1);
    const alerts = records.filter((entry) => entry.kind === "alert");
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].alertKind, "계열겹침");
    assert.equal(alerts[0].level, "AMBER");
    assert.equal(alerts[0].role, "p-검수자");
    assert.equal(alerts[0].counterpart, "p-작업자");
    assert.equal(alerts[0].model, "openai-codex/gpt-6-astra");
    assert.equal(alerts[0].counterpartModel, "gpt-6-astra");
    assert.equal(alerts[0].by, "p-감독");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /계열겹침/);
    assert.match(warnings[0], /p-작업자/);
    assert.match(warnings[0], /p-검수자/);
    assert.match(warnings[0], /gpt/);
  } finally {
    console.error = previous;
  }
});

test("옛 원장 줄(model 없음)은 모름으로 읽고 알리되 send를 막지 않는다", () => {
  const records = [];
  const sent = guardedSend({
    floor: floorAlive(),
    session: "kadan-p-검수자",
    role: "p-검수자",
    message: "검수해라",
    recordedPid: "111",
    env: { KADAN_ROLE: "p-감독" },
    record: (entry) => records.push(entry),
    readEntries: () => [start("p-작업자"), start("p-검수자", "anthropic/claude-opus-5")],
  });
  assert.equal(sent.kind, "send");
  const alerts = records.filter((entry) => entry.kind === "alert");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].alertKind, "계열겹침");
  assert.equal(alerts[0].counterpartFamily, "모름");
  assert.equal("counterpartModel" in alerts[0], false);
});

test("검수자가 아닌 역할에게 보낼 때는 비교 자체를 하지 않는다", () => {
  const worker = familyConflictAlerts({
    role: "p-작업자",
    session: "kadan-p-작업자",
    entries: [start("p-작업자", "gpt-6-astra"), start("p-검수자", "gpt-6-astra")],
  });
  const supervisor = familyConflictAlerts({
    role: "p-감독",
    session: "kadan-p-감독",
    entries: [start("p-작업자", "gpt-6-astra"), start("p-검수자", "gpt-6-astra")],
  });
  assert.deepEqual(worker, []);
  assert.deepEqual(supervisor, []);

  const records = [];
  guardedSend({
    floor: floorAlive(),
    session: "kadan-p-작업자",
    role: "p-작업자",
    message: "일해라",
    recordedPid: "111",
    record: (entry) => records.push(entry),
    readEntries: () => [start("p-작업자", "gpt-6-astra"), start("p-검수자", "gpt-6-astra")],
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "send");
});
