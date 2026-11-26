import test from "node:test";
import assert from "node:assert/strict";
import { bandChips, liveLabel, supervisorLife, supervisorLine, isIdleSuper, shownSupervisors } from "../src/status-band.ts";

const base = { decisions: 0, stopped: 0, running: 0, alerts: { count: 0, items: [] }, flow: { total: 0, unconfirmedCount: 0, unconfirmed: [] }, live: [] };

test("다섯 칩의 순서와 숫자: 결정·막힘(+경보)·작업 중·흐름 확인·살아 있는 담당", () => {
  const chips = bandChips({
    decisions: 2, stopped: 1, running: 3,
    alerts: { count: 2, items: [] },
    flow: { total: 4, unconfirmedCount: 1, unconfirmed: [{ id: "a", title: "A", label: "연결 확인 필요", warnings: [] }] },
    live: [
      { role: "p-작업자", harness: "claude", model: "sonnet", effort: "high", pidState: "match" },
      { role: "p-검수자", harness: "codex", model: "gpt-5", effort: null, pidState: "match" },
      { role: "p-감독", harness: "claude", model: "sonnet", effort: null, pidState: "match" },
    ],
  });
  assert.deepEqual(chips.map((c) => [c.kind, c.num, c.label, c.on]), [
    ["decision", 2, "내 결정 대기", true],
    ["attn", 3, "지금 막힌 것 · 경보 2", true],
    ["run", 3, "작업중", true],
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

test("슈퍼감독 한 줄: 숫자 칸 순서와 모름, 생존 칸", () => {
  const s = { super: "a-슈퍼감독", repos: ["repoA", "repoB"], running: 2, stuck: 0, openWorks: 3, decisions: 1, alerts: 0, lastSignal: null, alive: true, model: "gpt-5-mini" };
  assert.equal(supervisorLine(s), "저장소 repoA, repoB · 열린 워크 3 · 작업중 2 · 막힘 0 · 내 결정 1 · 경보 0");
  assert.equal(supervisorLine({ ...s, repos: [], decisions: null, alerts: null }), "저장소 없음 · 열린 워크 3 · 작업중 2 · 막힘 0 · 내 결정 모름 · 경보 모름");
  assert.equal(supervisorLife(s), "살아 있음 · gpt-5-mini");
  assert.equal(supervisorLife({ ...s, model: null }), "살아 있음");
  assert.equal(supervisorLife({ ...s, alive: false }), "세션 사라짐");
  assert.equal(supervisorLife({ ...s, alive: false, stopped: true }), "꺼짐 · 인계 필요");
  // 일부러 껐고 전략 맵에도 없고 숫자도 전부 0인 슈퍼감독만 줄에서 뺀다. 사라진 세션·지도에 남은 꺼진 역할·세션 모름은 남긴다.
  // 결정·하위의 열린 워크처럼 지도에 역할을 올리지 않는 것이 남은 줄(숫자가 0이 아님)과 모르는 칸이 있는 줄은 숨기지 않는다.
  const none = { ...s, repos: [], running: 0, stuck: 0, openWorks: 0, decisions: 0, alerts: 0, alive: false, stopped: true };
  assert.equal(isIdleSuper(none), true);
  const items = [{ ...s, super: "살아" }, { ...none, super: "끈-빈손" }, { ...none, super: "끈-인계" }, { ...none, super: "끈-결정", decisions: 1 },
    { ...none, super: "끈-하위워크", openWorks: 2 }, { ...none, super: "끈-결정모름", decisions: null },
    { ...none, super: "사라짐", stopped: false }, { ...none, super: "모름", alive: null, stopped: false }];
  assert.deepEqual(shownSupervisors(items, new Set(["살아", "끈-인계"])).map((x) => x.super),
    ["살아", "끈-인계", "끈-결정", "끈-하위워크", "끈-결정모름", "사라짐", "모름"]);
  assert.equal(supervisorLife({ ...s, alive: null }), "세션 모름");
});

test("담당 한 줄 라벨", () => {
  assert.equal(liveLabel({ role: "r", harness: "claude", model: "sonnet", effort: "high", pidState: null }), "claude · sonnet · high");
  assert.equal(liveLabel({ role: "r", harness: null, model: null, effort: null, pidState: null }), "모델 기록 없음");
});
