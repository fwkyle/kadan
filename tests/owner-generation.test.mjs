import "./helpers/isolated-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { assessSupervisorIdle } from "../src/watch-supervisor.mjs";
import { effectiveWorkOwnership, withEffectiveOwner } from "../src/handover-state.mjs";
import { previousGenerationWorks, previousGenerationExecutions, buildWatchScope } from "../src/watch-scope.mjs";
import { ownerGenerations, isPreviousOwner } from "../src/owner-generation.mjs";

const parents = new Map(Object.entries({ "r-슈퍼": "@user", "r-감독": "r-슈퍼", "r-작업자": "r-감독" }));
const at = (min) => new Date(Date.parse("2026-10-14T00:00:00Z") + min * 60_000).toISOString();
const now = Date.parse(at(60)), idleMs = 15 * 60_000;
const start = (role, min, extra = {}) => ({ kind: "start", role, session: `kadan-${role}`, t: at(min), cmd: "claude --model sonnet", ...extra });
const send = (role, min, extra = {}) => ({ kind: "send", role, taskId: "task-1", t: at(min), ...extra });
const states = () => new Map(["r-슈퍼", "r-감독", "r-작업자"].map((r) => [`kadan-${r}`, { alive: true, digest: "same", unchangedMs: 50 * 60_000 }]));
const idle = (entries, works = []) => assessSupervisorIdle(entries, states(), now, idleMs, null, parents, { works, cards: [], waits: [] })
  .filter((a) => a.kind === "놀고 있음").map((a) => a.role).sort();

test("옛 세대 작업자의 열린 발령은 새 세대 start(new) 뒤 감독의 놀고 있음 할 일에서 빠진다", () => {
  const before = [start("r-작업자", 0), send("r-작업자", 5)];
  assert.deepEqual(idle(before), ["r-감독", "r-슈퍼"], "새 세대 전에는 할 일");
  assert.deepEqual(idle([...before, start("r-작업자", 10)]), [], "new start 뒤에는 옛 세대 소속");
});

test("resume 이어가기·같은 대화 재사용 뒤에는 그대로 할 일, 새 세대 뒤에 받은 발령은 할 일", () => {
  const base = [start("r-작업자", 0), send("r-작업자", 5)];
  assert.deepEqual(idle([...base, start("r-작업자", 10, { cmd: "claude --resume abc" })]), ["r-감독", "r-슈퍼"]);
  assert.deepEqual(idle([...base, start("r-작업자", 10, { inheritMail: true })]), ["r-감독", "r-슈퍼"], "--inherit-mail은 바로 앞 세대를 이어받는다");
  assert.deepEqual(idle([...base, start("r-작업자", 10), send("r-작업자", 20, { taskId: "task-2" })]), ["r-감독", "r-슈퍼"], "새 세대가 받은 발령");
});

test("감시 범위: 옛 세대 발령은 빠지고 previous로 센다. resume 이어가기·인계로 새 세대 뒤에 받은 발령은 남는다", () => {
  const card = { id: "c", key: "r/c", role: "r-작업자", board: "r", status: "assigned", workType: "execution", at: at(0) };
  const sent = send("r-작업자", 5, { taskId: "c" });
  const scope = (entries) => buildWatchScope([card], entries, parents).sessions.size;
  assert.equal(scope([start("r-작업자", 0), sent]), 1);
  assert.equal(scope([start("r-작업자", 0), sent, start("r-작업자", 10)]), 0, "new start 뒤 옛 세대");
  assert.deepEqual(previousGenerationExecutions([card], [start("r-작업자", 0), sent, start("r-작업자", 10)], parents), [{ kind: "execution", key: "r/c", role: "r-작업자" }]);
  assert.equal(scope([start("r-작업자", 0), sent, start("r-작업자", 10, { cmd: "claude --resume x" })]), 1, "resume은 이어감");
  const handover = { kind: "handover", phase: "transferred", from: "r-작업자", to: "r-후임", taskIds: ["c"], t: at(12), handoverId: "h1" };
  const handed = [start("r-후임", 0), start("r-후임", 10), sent, handover];
  assert.equal(buildWatchScope([{ ...card, role: "r-작업자" }], handed, new Map([...parents, ["r-후임", "r-감독"]])).sessions.has("kadan-r-후임"), true, "새 세대(10분) 뒤(12분) 인계받은 발령");
  const early = [start("r-후임", 0), sent, { ...handover, t: at(8) }, start("r-후임", 10)];
  assert.equal(buildWatchScope([card], early, new Map([...parents, ["r-후임", "r-감독"]])).sessions.size, 0, "인계받은 뒤 새 세대가 시작되면 이전 세대");
  const generations = ownerGenerations([start("r-작업자", 0), start("r-작업자", 10)]);
  assert.equal(isPreviousOwner(generations, "r-작업자", "시각아님"), false, "시각을 모르면 이전 세대로 보지 않는다");
});

test("업무 책임 시각: 생성·재배정·확정 인계 중 마지막. 이전 세대 소속 열린 업무는 건수로 센다", () => {
  const work = { key: "r/w1", status: "open", owner: "r-감독", at: at(50), history: [{ owner: "r-감독", at: at(1) }, { owner: "r-감독", at: at(50) }], executions: [] };
  assert.deepEqual(effectiveWorkOwnership(work, []), { owner: "r-감독", at: at(1) }, "owner가 안 바뀐 개정은 책임 시각을 올리지 않는다");
  const handed = [{ kind: "handover", phase: "transferred", from: "r-감독", to: "r-감독2", t: at(30), taskIds: [] }];
  assert.deepEqual(effectiveWorkOwnership(work, handed), { owner: "r-감독2", at: at(30) });
  const entries = [start("r-감독", 0), start("r-감독", 20)];
  const hier = new Map([["r-감독", "r-슈퍼"], ["r-슈퍼", "@user"]]);
  assert.deepEqual(previousGenerationWorks([withEffectiveOwner(work, entries)], entries, hier), [{ kind: "work", key: "r/w1", role: "r-감독" }]);
  const reassigned = { ...work, history: [{ owner: "다른", at: at(1) }, { owner: "r-감독", at: at(25) }] };
  assert.deepEqual(previousGenerationWorks([withEffectiveOwner(reassigned, entries)], entries, hier), [], "새 세대 뒤에 재배정받은 업무");
});

test("이전 세대 소속 열린 업무는 책임 감독의 놀고 있음 할 일에서 빠지고 현재 세대 업무는 남는다", () => {
  const entries = [start("r-감독", 0), start("r-감독", 20)];
  const work = (owner, ownedAt) => ({ key: "r/w1", status: "open", owner, ownedAt, at: at(1), executions: [] });
  const run = (w) => assessSupervisorIdle(entries, states(), now, idleMs, null, parents, { works: [w], cards: [], waits: [], peerEntries: entries })
    .filter((a) => a.kind === "놀고 있음").map((a) => a.role);
  assert.deepEqual(run(work("r-감독", at(1))), [], "새 세대(20분) 전에 붙은 책임");
  assert.ok(run(work("r-감독", at(25))).includes("r-감독"), "새 세대 뒤에 붙은 책임");
});
