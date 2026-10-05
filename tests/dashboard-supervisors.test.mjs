import test from "node:test";
import assert from "node:assert/strict";
import { supervisorSummary } from "../src/dashboard-band.mjs";

// 사용자가 여러 슈퍼감독에게 위임해도 묻지 않고 진행을 보게, 슈퍼감독(상위가 @user)마다 한 줄로 묶는다(2026-10-05 [kyle]).
const hierarchy = {
  "a-작업자": "a-감독", "a-검수자": "a-감독", "a-감독": "a-슈퍼감독", "a-슈퍼감독": "@user",
  "b-작업자": "b-슈퍼감독", "b-슈퍼감독": "@user",
  "고아-작업자": "없는-감독",
};
const rows = [
  { key: "repoA/1", owner: "a-작업자", repo: "repoA", bucket: "running", signalAt: "2026-10-05T01:00:00Z" },
  { key: "repoA/2", owner: "a-검수자", repo: "repoA", bucket: "waiting", signalAt: "2026-10-05T02:00:00Z" },
  { key: "repoA2/3", owner: "a-감독", repo: "repoA2", bucket: "stuck", signalAt: "2026-10-05T00:30:00Z" },
  { key: "repoB/4", owner: "b-작업자", repo: "repoB", bucket: "stale", signalAt: "bad-date" },
  { key: "repoB/5", owner: "b-작업자", repo: "repoB", bucket: "planned" },
  { key: "x/6", owner: "고아-작업자", repo: "x", bucket: "running" },
  { key: "x/7", owner: "", repo: "x", bucket: "running" },
];
const works = [
  { key: "w1", state: "running", owner: "a-감독" }, { key: "w2", state: "running", owner: "a-슈퍼감독" },
  { key: "w3", state: "done", owner: "a-감독" }, { key: "w4", state: "running", owner: "b-슈퍼감독" }, { key: "w5", state: "running", owner: "모르는" },
];
const decisions = [{ id: "d1", requestedBy: "a-슈퍼감독" }, { id: "d2", requestedBy: "b-슈퍼감독" }, { id: "d3", requestedBy: "a-슈퍼감독" }];
const alerts = { count: 3, items: [{ id: "x1", recipient: "a-감독" }, { id: "x2", recipient: "@user" }, { id: "x3", recipient: "b-슈퍼감독" }] };
const live = [{ role: "a-슈퍼감독", harness: "codex", model: "gpt-5-mini", effort: "low", pidState: "match" }, { role: "a-작업자", model: "sonnet" }];

test("슈퍼감독마다 실행·워크·결정·경보를 사슬 끝으로 묶고, 관계표에 없는 담당은 따로 센다", () => {
  const result = supervisorSummary({ hierarchy, rows, works, decisions, alerts, live });
  assert.equal(result.unassigned, 2, "관계표에 없는 담당·빈 담당");
  assert.deepEqual(result.items, [
    { super: "a-슈퍼감독", repos: ["repoA", "repoA2"], running: 1, waiting: 1, stuck: 1, openWorks: 2, decisions: 2, alerts: 1,
      lastSignal: "2026-10-05T02:00:00Z", alive: true, model: "gpt-5-mini" },
    { super: "b-슈퍼감독", repos: ["repoB"], running: 0, waiting: 0, stuck: 1, openWorks: 1, decisions: 1, alerts: 1,
      lastSignal: null, alive: false, model: null },
  ]);
});

test("관계표를 모르면 null, 결정·경보·세션을 모르면 그 칸만 null, 사용자 바로 아래 역할이 없으면 빈 목록", () => {
  assert.equal(supervisorSummary({ hierarchy: null, rows }), null);
  const unknown = supervisorSummary({ hierarchy, rows, works, decisions: null, alerts: null, live: null });
  assert.deepEqual(unknown.items.map((s) => [s.decisions, s.alerts, s.alive, s.model]), [[null, null, null, null], [null, null, null, null]]);
  assert.deepEqual(supervisorSummary({ hierarchy: { "w": "boss" }, rows }), { items: [], unassigned: rows.length });
});

test("관계표의 순환은 묶지 않고 멈춘다", () => {
  const result = supervisorSummary({ hierarchy: { a: "b", b: "a", s: "@user" }, rows: [{ owner: "a", bucket: "running" }] });
  assert.deepEqual(result.items.map((s) => [s.super, s.running]), [["s", 0]]);
  assert.equal(result.unassigned, 1);
});
