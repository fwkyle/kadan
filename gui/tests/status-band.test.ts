import test from "node:test";
import assert from "node:assert/strict";
import { bandChips, liveLabel } from "../src/status-band.ts";

const base = { decisions: 0, stopped: 0, running: 0, alerts: { count: 0, items: [] }, flow: { total: 0, unconfirmed: [] }, live: [] };

test("다섯 칩의 순서와 숫자: 결정·막힘(+경보)·작업 중·흐름 확인·살아 있는 담당", () => {
  const chips = bandChips({
    decisions: 2, stopped: 1, running: 3,
    alerts: { count: 2, items: [] },
    flow: { total: 4, unconfirmed: [{ id: "a", title: "A", label: "연결 확인 필요", warnings: [] }] },
    live: [
      { role: "p-작업자", harness: "claude", model: "sonnet", effort: "high", pidState: "match" },
      { role: "p-검수자", harness: "codex", model: "gpt-5", effort: null, pidState: "match" },
      { role: "p-감독", harness: "claude", model: "sonnet", effort: null, pidState: "match" },
    ],
  });
  assert.deepEqual(chips.map((c) => [c.kind, c.num, c.label, c.on]), [
    ["decision", 2, "내 결정 대기", true],
    ["attn", 3, "지금 막힌 것 · 경보 2", true],
    ["run", 3, "작업 중", true],
    ["flow", 1, "흐름 확인", true],
    ["live", 3, "살아 있는 담당 · 모델 2종", true],
  ]);
  assert.match(chips[4].title, /sonnet, gpt-5/);
});

test("모르는 값은 '모름'으로 두고 켜지지 않는다", () => {
  const chips = bandChips({ ...base, decisions: null, alerts: null, live: null });
  assert.equal(chips[0].num, "모름");
  assert.equal(chips[0].on, false);
  assert.equal(chips[1].num, 0, "경보를 모르면 멈춘 실행만 센다");
  assert.match(chips[1].title, /모릅니다/);
  assert.equal(chips[4].num, "모름");
  assert.equal(chips[4].label, "살아 있는 담당");
});

test("담당 한 줄 라벨", () => {
  assert.equal(liveLabel({ role: "r", harness: "claude", model: "sonnet", effort: "high", pidState: null }), "claude · sonnet · high");
  assert.equal(liveLabel({ role: "r", harness: null, model: null, effort: null, pidState: null }), "모델 기록 없음");
});
