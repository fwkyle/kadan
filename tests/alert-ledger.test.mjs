import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { runWatch } from "./helpers/watch-runner.mjs";

const withoutRoute=({route,...entry})=>entry;
const session = "kadan-p-작업자";
const start = { kind: "start", role: "p-작업자", session, panePid: 1, t: "2026-09-05T00:00:00.000Z" };
const death = { kind: "alert", id: `death:${session}`, alertKind: "죽음", level: "RED", role: start.role,
  session, taskId: undefined, recipient: "p-감독", delivered: true, by: "watch" };
async function exercise({ failure, superFails = false, stdout = false, recordFails = false,
  resolutionFails = false, screen = "healthy" } = {}) {
  let cycle = 0;
  const records = [], sent = [], lines = [], errors = [], events = [];
  const sentinel = new Error("card-64 cycle boundary");
  const oldLoad = os.loadavg, oldError = console.error;
  os.loadavg = () => [0, 0, 0];
  console.error = line => errors.push(line);
  try {
    await assert.rejects(() => runWatch({completionGraceMs:0,
      floor: { list: () => cycle === 1 || cycle === 2 ? [] : [{ session, pid: 1 }], read: () => screen },
      readEntries: () => [start],
      record: entry => {
        if (entry.kind === "watch-cycle") return; // 주기 기록은 경보 원장 규칙과 별개다(watch-cycle.test.mjs)
        records.push(entry); events.push(["record", entry.recipient, entry.resolved ?? false]);
        if (recordFails) throw new Error("controlled append failure");
      },
      sendAlert: (role, message) => {
        sent.push({ role, message }); events.push(["send", role, message.includes("세션 종료 의심 - 해소됨")]);
        if ((failure && role === "p-감독" && !message.includes("세션 종료 의심 - 해소됨")) ||
            (superFails && role === "qa-슈퍼감독") || (resolutionFails && message.includes("세션 종료 의심 - 해소됨"))) {
          const error = new Error("controlled send failure");
          if (failure !== "unknown") error.delivery = failure;
          throw error;
        }
      },
      intervalMs: 1000, stallN: 100, routes: stdout ? {} : { p: "p-감독" },
      superRole: stdout ? null : "qa-슈퍼감독", now: () => Date.parse(start.t) + cycle * 1000,
      print: line => lines.push(line),
      spawn: command => {
        if (command === "sleep" && ++cycle === 5) throw sentinel;
        if (command === "memory_pressure") return { status: 0, stdout: "System-wide memory free percentage: 80%" };
        if (command === "sysctl") return { status: 0, stdout: "total = 0M used = 0M free = 0M" };
        return { status: 0, stdout: "" };
      },
    }), error => error === sentinel);
  } finally { os.loadavg = oldLoad; console.error = oldError; }
  assert.equal(cycle, 5);
  return { records, sent, lines, errors, events };
}

test("watch의 알림은 원장에도 남는다 — 화면에만 있어 관제 화면이 못 보였다(2026-09-05)(card-64)", async () => {
  const result = await exercise();
  assert.deepEqual(result.records.map(withoutRoute), [death, { ...death, resolved: true }]);
  assert.deepEqual(result.events, [["send", "p-감독", false], ["record", "p-감독", false],
    ["send", "p-감독", true], ["record", "p-감독", true]]);
  assert.equal(result.lines.length, result.records.length);
});

test("전달 실패 알림도 원장에 남는다 — 실패는 delivered:false다(card-64)", async () => {
  for (const superFails of [false, true]) {
    const result = await exercise({ failure: "not-sent", superFails });
    const escalation = { kind: "alert", id: `delivery-failed:death:${session}:p-감독`, alertKind: "전달실패", level: "RED", role: undefined,
      session: undefined, taskId: undefined, recipient: "qa-슈퍼감독", delivered: !superFails, by: "watch" };
    assert.deepEqual(result.records.map(withoutRoute), [escalation, { ...death, delivered: false },
      { ...death, recipient: superFails ? null : "qa-슈퍼감독", delivered: !superFails, resolved: true }]);
    assert.equal(result.sent.length, superFails ? 2 : 3);
    assert.equal(result.lines.length, result.records.length);
  }
  for (const failure of ["unknown", "sent"]) {
    const result = await exercise({ failure });
    assert.deepEqual(result.records.map(withoutRoute), [{ ...death, delivered: false },
      { ...death, recipient: failure === "sent" ? "p-감독" : null, delivered: failure === "sent", resolved: true }]);
  }
});

test("원장 쓰기 실패가 watch를 죽이지 않는다 — 기록이 감시보다 앞서지 않는다(card-64)", async () => {
  for (const options of [{}, { failure: "not-sent" }, { stdout: true }]) {
    const result = await exercise({ ...options, recordFails: true });
    assert.ok(result.records.length >= 2);
    assert.deepEqual(result.errors, result.records.map(() => "원장 기록 실패: controlled append failure"));
    assert.equal(result.lines.length, result.records.length);
    assert.equal(result.sent.length, options.stdout ? 0 : options.failure ? 3 : 2);
  }
});

test("해소는 resolved:true로 남는다 — 같은 규칙의 다른 줄이다(card-64)", async () => {
  const stdout = await exercise({ stdout: true });
  assert.deepEqual(stdout.records.map(withoutRoute), [{ ...death, recipient: null, delivered: false },
    { ...death, recipient: null, delivered: false, resolved: true }]);
  const failed = await exercise({ resolutionFails: true });
  assert.deepEqual(failed.records.map(withoutRoute), [death, { ...death, delivered: false, resolved: true }]);
});

test("완료후보의 카드 id와 AMBER 수준도 그대로 기록한다(card-64)", async () => {
  const result = await exercise({ screen: "KADAN:DONE card-64 ok" });
  const completed = result.records.filter(e => e.alertKind === "완료후보");
  assert.ok(completed.length > 0);
  for (const entry of completed) {
    assert.deepEqual(withoutRoute(entry), { ...death, id: `complete-candidate:${session}:card-64|ok`, alertKind: "완료후보", level: "AMBER", taskId: "card-64" });
  }
});

test('새 경보는 선택 당시 경로를 보존하고 해소 경로를 현재 관계로 소급 추정하지 않는다',async()=>{
 const result=await exercise();
 assert.deepEqual(result.records[0].route,{recipient:'p-감독',basis:'board-route',skipped:[]});
 assert.equal(result.records[1].route,undefined);
 const stdout=await exercise({stdout:true});
 assert.deepEqual(stdout.records[0].route,{recipient:null,basis:'none',skipped:[]});
});
