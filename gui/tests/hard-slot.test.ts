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

test("어려운 일 줄에는 폴백 목록이 생기지 않는다. 다른 역할의 폴백 초안은 그대로다", () => {
  assert.throws(() => stagePreset(fixture.settings.filled, "worker-hard", true, { runner: "codex", model: "x" }, "add"), /대체 후보가 없/);
  const draft = stagePreset(fixture.settings.filled, "worker", true, { runner: "codex", model: "gpt-fb" }, "add");
  assert.deepEqual(Object.keys(draft.presets.A.fallback ?? {}), ["worker"]);
  assert.equal(draft.presets.A.fallback?.["worker-hard"], undefined);
  assert.equal(Object.hasOwn(draft.presets.A.roles, "worker-hard"), true);
});

test("강도가 있는 값은 그대로 담기고, 강도가 비면 effort 키를 만들지 않는다", () => {
  const withEffort = stagePreset(fixture.settings.empty, "worker-hard", false, { runner: "codex", model: "gpt-hard", effort: "high" }, "add");
  assert.deepEqual(withEffort.presets.A.roles["worker-hard"], { runner: "codex", model: "gpt-hard", effort: "high" });
  const noEffort = stagePreset(fixture.settings.empty, "worker-hard", false, { runner: "codex", model: "gpt-hard", effort: "" }, "add");
  assert.deepEqual(noEffort.presets.A.roles["worker-hard"], { runner: "codex", model: "gpt-hard" });
});
