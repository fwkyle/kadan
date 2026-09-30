import test from "node:test";
import assert from "node:assert/strict";
import { ownPart } from "../src/runner-draft.ts";

const settings = (over: Record<string, unknown> = {}) => ({
  activePreset: "A",
  presets: {
    A: {
      roles: {
        worker: { runner: "claude", model: "claude-opus-5-5", effort: "high" },
        reviewer: { runner: "codex", model: "gpt-6-sol", effort: "high" },
      },
      fallback: { worker: [{ runner: "codex", model: "gpt-6-sol" }] },
    },
    B: {
      roles: {
        worker: { runner: "claude", model: "claude-opus-5-5", effort: "high" },
      },
    },
  },
  ...over,
});

test("다른 역할·즐겨찾기가 바뀌어도 작업자 칸의 몫은 같다", () => {
  const before = settings();
  const after = settings();
  after.presets.A.roles.reviewer = { runner: "codex", model: "gpt-6-sol", effort: "max" };
  Object.assign(after, { favorites: [{ runner: "codex", model: "x" }] });
  assert.equal(ownPart(before, "worker", false), ownPart(after, "worker", false));
  assert.equal(ownPart(before, "worker", true), ownPart(after, "worker", true));
});

test("작업자 값이나 대체 후보가 바뀌면 몫이 달라진다", () => {
  const before = settings();
  const after = settings();
  after.presets.A.roles.worker = { runner: "claude", model: "claude-sonnet-5-5", effort: "xhigh" };
  assert.notEqual(ownPart(before, "worker", false), ownPart(after, "worker", false));
  after.presets.A.fallback.worker = [];
  assert.notEqual(ownPart(before, "worker", true), ownPart(after, "worker", true));
});

test("프리셋이 바뀌어도 값이 같으면 같은 몫이고, 대체 후보가 없으면 빈 목록이다", () => {
  assert.equal(
    ownPart(settings(), "worker", false),
    ownPart(settings({ activePreset: "B" }), "worker", false),
  );
  assert.equal(ownPart(settings({ activePreset: "B" }), "worker", true), "[]");
  assert.equal(ownPart(settings(), "super", false), "null");
});
