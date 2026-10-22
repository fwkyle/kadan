import "./helpers/isolated-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { idleWorkEntries, endedExecutionKeys, assessSupervisorIdle } from "../src/watch-supervisor.mjs";
import { currentResponsibility } from "../src/handover-state.mjs";

// 2026-10-21 절전 중단 사고 모양: 작업자가 원장 done·stop 했는데 카드 status는 assigned로 남아 업무를 붙잡았다.
const parents = new Map(Object.entries({ "r-슈퍼": "@user", "r-감독": "r-슈퍼", "r-작업자": "r-감독" }));
const T = (m) => new Date(Date.UTC(2026, 9, 21, 8, m)).toISOString();
const NOW = Date.parse(T(300));
const card = (status = "assigned") => ({ key: "r/e1", id: "e1", title: "실행", status, workType: "execution", role: "r-작업자",
  revision: 2, at: T(1), history: [], runs: [] });
const work = { key: "r/w1", title: "t", goal: "g", status: "open", owner: "r-감독", ownedAt: T(0), at: T(2), revision: 3, history: [],
  executions: [{ key: "r/e1", phase: "implementation", round: 1 }], turnOwner: "r-작업자", turnAt: T(2) };
const send = (m) => ({ kind: "send", role: "r-작업자", taskId: "e1", executionKey: "r/e1", by: "r-감독", t: T(m) });
const done = (m) => ({ kind: "done", role: "r-작업자", taskId: "e1", executionKey: "r/e1", by: "r-감독", result: "ok", t: T(m) });
const live = (...roles) => new Set(roles.map((r) => `kadan-${r}`));
const idle = (cards, entries, liveSessions) =>
  idleWorkEntries([work], cards, parents, () => endedExecutionKeys({ cards, entries, liveSessions, now: NOW }));

test("사고 모양: assigned 카드 + 원장 done + 담당 stop + 차례=작업자 → owner 감독의 할 일", () => {
  const out = idle([card()], [send(3), done(20)], live("r-감독"));
  assert.deepEqual(out.map((e) => [e.role, e.taskId]), [["r-감독", "work:r/w1"]]);
});

test("살아 있는 담당 + done 없음 → 지금처럼 진행 중(할 일 없음)", () => {
  assert.deepEqual(idle([card()], [send(3)], live("r-감독", "r-작업자")), []);
});

test("done만 있고 담당은 살아 있음 → 끝난 실행이라 할 일", () => {
  assert.equal(idle([card()], [send(3), done(20)], live("r-감독", "r-작업자")).length, 1);
});

test("stop만 있고 done 없음 → 담당 세션이 없는 미완료라 할 일", () => {
  assert.equal(idle([card()], [send(3)], live("r-감독")).length, 1);
});

test("done 뒤 같은 담당에게 다시 발령했고 살아 있으면 진행 중이다", () => {
  assert.deepEqual(idle([card()], [send(3), done(20), send(30)], live("r-감독", "r-작업자")), []);
});

test("생존을 모르면(liveSessions=null) 세션 소실은 판정하지 않는다. done이 있으면 여전히 끝난 실행", () => {
  assert.deepEqual(idle([card()], [send(3)], null), []);
  assert.equal(idle([card()], [send(3), done(20)], null).length, 1);
});

test("hold 실행은 담당이 종료됐어도 지금처럼 진행 중이다(의미를 바꾸지 않는다)", () => {
  assert.deepEqual(idle([card("hold")], [send(3), done(20)], live("r-감독")), []);
  assert.deepEqual(idle([card("hold")], [send(3)], live("r-감독")), []);
});

test("원장을 못 읽으면(손상) 끝난 실행을 가리지 않고 진행 중으로 둔다", () => {
  const keys = endedExecutionKeys({ cards: [card()], entries: [{ broken: true }], liveSessions: live("r-감독"), now: NOW });
  assert.equal(keys.size, 0);
});

test("차례가 종료된 작업자(관계표 밖)여도 owner 차례다: 이미 currentResponsibility가 덮는다", () => {
  assert.equal(currentResponsibility(work, parents, [card("done")]).role, "r-감독");
});

test("전체 경로: 놀고 있음 경보가 owner 감독에게 생긴다. 원장·생존을 모르면 예전처럼 생기지 않는다", () => {
  const states = new Map(["r-슈퍼", "r-감독"].map((r) => [`kadan-${r}`, { alive: true, digest: "same", unchangedMs: 3600e3 }]));
  const entries = [send(3), done(20)];
  const run = (extra) => assessSupervisorIdle(entries, states, NOW, 60e3, null, parents,
    { works: [work], cards: [card()], waits: [], peerEntries: entries, ...extra }).filter((a) => a.kind === "놀고 있음");
  const found = run({ executionEntries: entries, liveRoleSessions: live("r-슈퍼", "r-감독") });
  assert.ok(found.some((a) => a.idleItems?.own?.includes("work:r/w1")), JSON.stringify(found));
  assert.equal(run({}).some((a) => a.idleItems?.own?.includes("work:r/w1")), false);
});
