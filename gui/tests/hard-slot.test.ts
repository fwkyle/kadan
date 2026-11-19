import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { clearPreset, presetSaveFields, stagePreset } from "../src/preset-draft.ts";

// 어려운 일 작업자 줄의 화면 초안. 저장 본문은 서버 시험(tests/dashboard-difficulty.test.mjs)과 같은 자료 파일을 쓴다:
// 이 시험은 "초안 함수가 이 본문을 만든다", 서버 시험은 "서버가 이 본문을 받으면 이 설정이 된다".
const fixture = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../tests/fixtures/difficulty-preset-save.json"), "utf8"));

for (const c of fixture.cases) {
  test(`초안 → 저장 본문(고정 자료): ${c.name}`, () => {
    const start = fixture.settings[c.from];
    const before = JSON.stringify(start);
    const draft = c.edit.op === "clear" ? clearPreset(start, c.edit.role) : stagePreset(start, c.edit.role, false, c.edit.choice, "add");
    assert.equal(JSON.stringify(start), before, "원본 설정은 바뀌지 않는다");
    assert.deepEqual(presetSaveFields(draft, c.fields.reason), c.fields);
  });
}

test("비우기는 키를 지운다 — 빈 값·빈 객체를 남기지 않고, 이미 빈 자리를 비워도 키가 생기지 않는다", () => {
  const cleared = clearPreset(fixture.settings.filled, "worker-hard");
  assert.equal(Object.hasOwn(cleared.presets.A.roles, "worker-hard"), false);
  const again = clearPreset(cleared, "worker-hard");
  assert.equal(Object.hasOwn(again.presets.A.roles, "worker-hard"), false);
  assert.deepEqual(Object.keys(again.presets.A.roles), ["worker", "reviewer"]);
  assert.throws(() => clearPreset(fixture.settings.filled, "worker"), /비울 수 없는/);
});

test("어려운 일 대체 후보: 값이 있으면 목록이 생기고(작업자 목록은 그대로), 값이 비면 거절한다", () => {
  const choice = { runner: "codex", model: "gpt-hard-2", effort: "" };
  const draft = stagePreset(fixture.settings.filled, "worker-hard", true, choice, "add");
  assert.deepEqual(draft.presets.A.fallback?.["worker-hard"], [{ runner: "codex", model: "gpt-hard-2" }]);
  assert.equal(draft.presets.A.fallback?.worker, undefined, "작업자 목록은 만들어지지 않는다");
  assert.deepEqual(draft.presets.A.roles["worker-hard"], { runner: "codex", model: "gpt-hard" }, "1순위는 그대로");
  assert.throws(() => stagePreset(fixture.settings.empty, "worker-hard", true, choice, "add"), /값이 비어 있어 대체 후보를 둘 수 없/);
  // 같은 초안에서 자리를 먼저 채우면 대체 후보도 둘 수 있다(저장은 한 번에).
  const filled = stagePreset(fixture.settings.empty, "worker-hard", false, { runner: "codex", model: "gpt-hard" }, "add");
  assert.equal(stagePreset(filled, "worker-hard", true, choice, "add").presets.A.fallback?.["worker-hard"]?.length, 1);
  // 순서·삭제는 다른 역할과 같은 조작이다.
  const two = stagePreset(draft, "worker-hard", true, { runner: "codex", model: "gpt-hard-3" }, "add");
  const moved = stagePreset(two, "worker-hard", true, choice, "up:2");
  assert.deepEqual(moved.presets.A.fallback?.["worker-hard"]?.map((c: { model: string }) => c.model), ["gpt-hard-3", "gpt-hard-2"]);
  assert.equal(stagePreset(moved, "worker-hard", true, choice, "remove:1").presets.A.fallback?.["worker-hard"]?.length, 1);
  // 다른 역할의 폴백 초안은 그대로다.
  const other = stagePreset(fixture.settings.filled, "worker", true, { runner: "codex", model: "gpt-fb" }, "add");
  assert.deepEqual(Object.keys(other.presets.A.fallback ?? {}), ["worker"]);
  assert.equal(other.presets.A.fallback?.["worker-hard"], undefined);
});

test("비우기는 어려운 일 대체 후보 목록도 함께 지우고, 다른 역할의 목록은 남긴다. 목록이 없으면 fallback 칸을 만들지 않는다", () => {
  const withBoth = stagePreset(
    stagePreset(fixture.settings.filled, "worker", true, { runner: "codex", model: "gpt-fb" }, "add"),
    "worker-hard", true, { runner: "codex", model: "gpt-hard-2" }, "add");
  const cleared = clearPreset(withBoth, "worker-hard");
  assert.equal(Object.hasOwn(cleared.presets.A.roles, "worker-hard"), false);
  assert.deepEqual(Object.keys(cleared.presets.A.fallback ?? {}), ["worker"]);
  const onlyHard = stagePreset(fixture.settings.filled, "worker-hard", true, { runner: "codex", model: "gpt-hard-2" }, "add");
  assert.equal(Object.hasOwn(clearPreset(onlyHard, "worker-hard").presets.A, "fallback"), false, "빈 fallback 객체를 남기지 않는다");
  assert.equal(Object.hasOwn(clearPreset(fixture.settings.filled, "worker-hard").presets.A, "fallback"), false);
  assert.equal(JSON.stringify(withBoth.presets.A.fallback?.["worker-hard"]), '[{"runner":"codex","model":"gpt-hard-2"}]', "원본 초안은 바뀌지 않는다");
});

test("강도가 있는 값은 그대로 담기고, 강도가 비면 effort 키를 만들지 않는다", () => {
  const withEffort = stagePreset(fixture.settings.empty, "worker-hard", false, { runner: "codex", model: "gpt-hard", effort: "high" }, "add");
  assert.deepEqual(withEffort.presets.A.roles["worker-hard"], { runner: "codex", model: "gpt-hard", effort: "high" });
  const noEffort = stagePreset(fixture.settings.empty, "worker-hard", false, { runner: "codex", model: "gpt-hard", effort: "" }, "add");
  assert.deepEqual(noEffort.presets.A.roles["worker-hard"], { runner: "codex", model: "gpt-hard" });
});

// 비서 자리(2026-11-19)도 비울 수 있는 선택 칸이다. 대체 후보는 둘 수 없다.
test("비서 자리: 값을 넣고 비우며(키를 지운다), 대체 후보는 거절한다", () => {
  const choice = { runner: "codex", model: "gpt-secretary", effort: "medium" };
  const staged = stagePreset(fixture.settings.empty, "secretary", false, choice, "add");
  assert.deepEqual(staged.presets.A.roles.secretary, choice);
  const cleared = clearPreset(staged, "secretary");
  assert.equal(Object.hasOwn(cleared.presets.A.roles, "secretary"), false);
  assert.equal(Object.hasOwn(cleared.presets.A, "fallback"), false, "fallback 칸을 만들지 않는다");
  assert.deepEqual(cleared.presets.A.roles, fixture.settings.empty.presets.A.roles, "다른 역할은 그대로");
  assert.throws(() => stagePreset(staged, "secretary", true, choice, "add"), /비서 자리에는 대체 후보를 둘 수 없/);
});
