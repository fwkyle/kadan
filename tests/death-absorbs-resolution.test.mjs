import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { dedupAlerts } from "../src/watch.mjs";
import { runWatch } from "./helpers/watch-runner.mjs";

const session = "kadan-a-작업자";
const anomaly = { id: `complete-candidate:${session}:a-1|ok`, kind: "완료후보", level: "AMBER", session };
const death = (session) => ({ id: `death:${session}`, kind: "죽음", level: "RED", session });
async function run(cycles, { failFirst = false } = {}) {
  let cycle = 0;
  const sent = [], printed = [], memories = [];
  const stop = new Error("card-56 cycle sentinel");
  const originalSet = Map.prototype.set;
  const originalLoad = os.loadavg;
  // Observe actual private memory without replacing Map behavior or adding a product API.
  Map.prototype.set = function(key, value) {
    if (key === anomaly.id && typeof value === "string") memories.push(this);
    return originalSet.call(this, key, value);
  };
  os.loadavg = () => [0, 0, 0];
  try {
    await assert.rejects(() => runWatch({completionGraceMs:0,
      floor: { list: () => cycles[cycle] === null ? [] : [{ session, pid: 1 }], read: () => cycles[cycle] },
      readEntries: () => [{ kind: "start", role: "a-작업자", session, panePid: 1, t: "2026-09-05T00:00:00Z" }],
      sendAlert: (role, message) => {
        sent.push({ cycle, role, message });
        if (failFirst && cycle === 0 && role === "a-감독") {
          const error = new Error("recipient absent"); error.delivery = "not-sent"; throw error;
        }
      },
      intervalMs: 1000, stallN: 100, routes: { a: "a-감독" }, superRole: "qa-슈퍼감독",
      now: () => Date.parse("2026-09-05T00:00:00Z") + cycle * 1000,
      print: line => printed.push(line),
      spawn: command => {
        if (command === "sleep" && ++cycle === cycles.length) throw stop;
        if (command === "memory_pressure") return { status: 0, stdout: "System-wide memory free percentage: 80%" };
        if (command === "sysctl") return { status: 0, stdout: "total = 0M used = 0M free = 0M" };
        return { status: 0, stdout: "" };
      },
    }), error => error === stop);
  } finally { Map.prototype.set = originalSet; os.loadavg = originalLoad; }
  return { sent, printed, memories };
}

test("기준선: 살아 있는 세션의 이상 소멸은 기억한 수신자에게 해소한다(card-34/card-56)", async () => {
  assert.deepEqual(dedupAlerts([anomaly], []).resolved, [anomaly]);
  const { sent, printed } = await run(["KADAN:DONE a-1 ok", "healthy", "healthy"]);
  assert.deepEqual(sent.map(s => [s.cycle, s.role]), [[0, "a-감독"], [1, "a-감독"]]);
  assert.equal(sent.filter(s => s.message.includes("끝난 것 같음 - 해소됨")).length, 1);
  assert.equal(printed.filter(s => s.includes("해소")).length, 1);
});

test("죽은 세션의 이상은 해소가 아니라 죽음에 흡수한다 — 죽었는데 해소로 읽혔다(2026-09-05 card-54 리허설)(card-56)", () => {
  const idle = { id: "idle:a", kind: "놀고 있음", session: "kadan-a-감독", level: "AMBER" };
  const next = [death(session), death(idle.session)];
  const changes = dedupAlerts([anomaly, idle], next);
  assert.deepEqual(changes.resolved, []);
  assert.deepEqual(changes.absorbed, [anomaly, idle]);
  assert.deepEqual(changes.notify, next);
  assert.strictEqual(changes.active, next);
});

test("죽음 흡수는 해소 배달과 stdout 없이 수신자 기억을 지운다(card-56)", async () => {
  const { sent, printed, memories } = await run(["KADAN:DONE a-1 ok", null, null]);
  assert.equal(sent.filter(s => s.message.includes("해소")).length, 0);
  assert.equal(printed.filter(s => s.includes("해소")).length, 0);
  assert.equal(sent.filter(s => /\] 세션 종료 의심 /.test(s.message)).length, 1);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].has(anomaly.id), false);
});

test("살아 돌아온 세션의 죽음은 기억한 수신자에게 한 번 해소한다(card-56)", async () => {
  const { sent, printed } = await run(["healthy", null, null, "healthy", "healthy"]);
  assert.deepEqual(sent.map(s => [s.cycle, s.role]), [[1, "a-감독"], [3, "a-감독"]]);
  assert.equal(sent.filter(s => s.message.includes("세션 종료 의심 - 해소됨")).length, 1);
  assert.equal(printed.filter(s => s.includes("세션 종료 의심 - 해소됨")).length, 1);
});

test("다른 세션의 죽음과 session 없는 이상은 흡수하지 않는다(card-56)", () => {
  const resource = { id: "resource", kind: "자원" };
  const next = [death("kadan-b-작업자"), death("undefined")];
  const changes = dedupAlerts([anomaly, resource], next);
  assert.deepEqual(changes.resolved, [anomaly, resource]);
  assert.deepEqual(changes.absorbed, []);
  assert.deepEqual(dedupAlerts([death(session)], []).resolved, [death(session)]);
  assert.deepEqual(dedupAlerts([anomaly], [anomaly, death(session)]).absorbed, []);
});

test("흡수된 전달실패 기억도 지워 재등장한 이상을 새로 전달한다(card-56)", async () => {
  const { sent, printed, memories } = await run(["KADAN:DONE a-1 ok", null, "KADAN:DONE a-1 ok", "healthy"], { failFirst: true });
  assert.equal(sent.filter(s => s.cycle === 1 && s.message.includes("해소")).length, 0);
  assert.equal(printed.filter(s => s.includes("끝난 것 같음 - 해소됨")).length, 1);
  assert.equal(sent.filter(s => s.cycle === 2 && s.role === "a-감독" && s.message.includes("끝난 것 같음")).length, 1);
  assert.equal(sent.filter(s => s.cycle === 3 && s.role === "a-감독" && s.message.includes("끝난 것 같음 - 해소됨")).length, 1);
  assert.ok(memories.length >= 1);
  assert.equal(memories[0].has(anomaly.id), false);
});
