import './helpers/isolated-home.mjs';
import {runWatch} from './helpers/watch-runner.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import * as runner from "../src/watch-runner.mjs";
import { dedupAlerts } from "../src/watch.mjs";
import { assessSupervisorIdle } from "../src/watch-supervisor.mjs";
import { guardedSend } from "../src/cli.mjs";
import os from "node:os";

const session = "kadan-p-작업자";
const entry = { kind: "start", role: "p-작업자", session, panePid: 1,
  t: "2026-09-05T00:00:00.000Z" };
const expected = { id: `screen-read:${session}`, kind: "모름", level: "AMBER",
  role: entry.role, session, screenError: "읽기 오류" };
const floorWith = (read, start = entry) => ({
  list: () => [{ session: start.session, pid: 1, alive: true }], read,
});

test("작업자 화면 읽기 실패는 watch를 죽이지 않고 한 번만 알린다 — 알림 0개로 예외가 빠졌다(2026-09-05)(card-51)", () => {
  let reads = 0;
  const floor = floorWith(() => {
    if (++reads <= 2) throw new Error("읽기 오류");
    return "recovered";
  });
  let active = [];
  const changes = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    const roles = runner.collectRoles(floor, [entry]);
    if (cycle < 2) {
      assert.deepEqual(roles.screenAlerts, [expected]);
      assert.equal(roles.observations.get(session).digest, null);
      assert.equal(roles.observations.get(session).screenError, "읽기 오류");
    }
    const change = dedupAlerts(active, roles.screenAlerts);
    changes.push(change);
    active = change.active;
  }
  assert.deepEqual(changes.map(c => c.notify.length), [1, 0, 0]);
  assert.deepEqual(changes.map(c => c.resolved.map(a => a.id)), [[], [], [expected.id]]);
  assert.equal(reads, 3);
  assert.equal(runner.formatAlertBody(expected), "상태 확인 필요 kadan-p-작업자 (화면 읽기 실패: 읽기 오류)");
});

test("알림 뒤 화면 흡수 실패도 다시 던지지 않는다 — 배달 기준선 갱신이 watch를 죽였다(card-51)", () => {
  const state = { role: entry.role, alive: true, digest: "before", unchangedMs: 42 };
  let reads = 0;
  const result = runner.absorbDeliveredScreens(floorWith(() => {
    reads++;
    throw new Error("읽기 오류");
  }), new Map([[session, state]]), new Set([entry.role, "missing"]));
  assert.deepEqual(result.screenAlerts, [expected]);
  assert.deepEqual(result.states.get(session), { ...state, digest: null, screenError: "읽기 오류" });
  assert.equal(reads, 1);
});

test("감독 화면 읽기 실패는 그대로 idle:screen 한 경로다(card-51)", () => {
  const start = { ...entry, role: "p-감독", session: "kadan-p-감독" };
  const floor = floorWith(() => { throw new Error("읽기 오류"); }, start);
  const roles = runner.collectRoles(floor, [start]);
  assert.deepEqual(roles.screenAlerts, []);
  const absorbed = runner.absorbDeliveredScreens(floor, roles.observations, new Set([start.role]));
  assert.deepEqual(absorbed.screenAlerts, []);
  const alerts = assessSupervisorIdle([
    start, { ...entry, kind: "send", taskId: "card-51" },
  ], absorbed.states, Date.parse(entry.t), 60_000);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].id, "idle:screen:p");
  assert.equal(alerts[0].screenError, "읽기 오류");
});

test("흡수 오류는 다음 주기 비교에 보존되고 재배달하지 않는다(card-51)", async () => {
  let cycle = 0;
  let reads = 0;
  const printed = [];
  const sent = [];
  const stop = new Error("test cycle boundary");
  const floor = floorWith(() => {
    reads++;
    if (reads === 2 || cycle === 1) throw new Error("읽기 오류");
    return "healthy";
  });
  floor.alive = () => true;
  await assert.rejects(() => runWatch({
    floor, readEntries: () => [entry], sendAlert: (...args) => sent.push(args),
    intervalMs: 1000, stallN: 100, routes: {}, superRole: null,
    wakeRole: entry.role, wakeEveryMs: 100_000,
    now: () => Date.parse(entry.t) + cycle * 1000,
    print: line => printed.push(line),
    spawn: (command) => {
      if (command === "sleep") { if (++cycle === 4) throw stop; }
      if (command === "memory_pressure") return { status: 0, stdout: "System-wide memory free percentage: 80%" };
      if (command === "sysctl") return { status: 0, stdout: "total = 0.00M used = 0.00M free = 0.00M" };
      return { status: 0, stdout: "" };
    },
  }), error => error === stop);
  assert.equal(sent.length, 1);
  assert.equal(printed.filter(line => line.includes(`상태 확인 필요 - 해소됨 ${session}`)).length, 1);
  assert.equal(printed.filter(line => line.includes("화면 읽기 실패")).length, 0);
  assert.equal(cycle, 4);
});

test("빈 화면 응답은 모름, 정상 흡수는 지문만 갱신한다(card-51)", async () => {
  const roles = runner.collectRoles(floorWith(() => ({})), [entry]);
  assert.deepEqual(roles.screenAlerts, [{ ...expected, screenError: "빈 응답" }]);
  const result = runner.absorbDeliveredScreens(floorWith(() => ({ text: "ok" })),
    roles.observations, new Set([entry.role]));
  assert.deepEqual(result.screenAlerts, []);
  assert.match(result.states.get(session).digest, /^[a-f0-9]{12}$/);
  assert.equal(result.states.get(session).screenError, null);
});

async function deliveryRun({ delivery, superRole = "qa-슈퍼감독", superFails = false,
  deaths = [false, true, true, true, false, false], omitDelivery = false } = {}) {
  let cycle = 0;
  const sent = [];
  const printed = [];
  const stop = new Error("card-52 cycle sentinel");
  const times = [0, ...deaths.map((_, i) => i * 1000)].map(t => Date.parse(entry.t) + t);
  const originalLoad = os.loadavg;
  os.loadavg = () => [0, 0, 0]; // controlled external resource input, not host quietness
  try {
    await assert.rejects(() => runWatch({
      floor: { list: () => deaths[cycle] ? [] : [{ session, pid: 1 }], read: () => "healthy" },
      readEntries: () => [entry],
      sendAlert: (role, message) => {
        sent.push({ cycle, role, message });
        if ((role === "p-감독" && !message.includes("세션 종료 의심 - 해소됨")) || superFails) {
          const error = new Error("controlled delivery error");
          if (!omitDelivery) error.delivery = delivery;
          throw error;
        }
      },
      intervalMs: 1000, stallN: 100, routes: { p: "p-감독" }, superRole,
      now: () => { assert.ok(times.length); return times.shift(); },
      print: line => printed.push(line),
      spawn: command => {
        if (command === "sleep" && ++cycle === deaths.length) throw stop;
        if (command === "memory_pressure") return { status: 0, stdout: "System-wide memory free percentage: 80%" };
        if (command === "sysctl") return { status: 0, stdout: "total = 0M used = 0M free = 0M" };
        return { status: 0, stdout: "" };
      },
    }), error => error === stop);
    assert.equal(times.length, 0);
    return { sent, printed };
  } finally { os.loadavg = originalLoad; }
}

test("기준선: 모호한 실패는 stdout에 남고 원 수신자는 재시도하지 않는다(card-52)", async () => {
  const { sent, printed } = await deliveryRun({ delivery: "unknown" });
  assert.deepEqual(sent.map(s => [s.cycle, s.role]), [[1, "p-감독"]]);
  assert.equal(printed.filter(s => s.includes("전달 실패")).length, 1);
  assert.equal(printed.filter(s => s.includes("세션 종료 의심 - 해소됨") && !s.includes("→")).length, 1);
});

test("죽은 수신자 전달 실패는 슈퍼 한 명에게 한 번만 올린다 — 실패가 감시 터미널에만 남았다(2026-09-05)(card-52)", async () => {
  const { sent, printed } = await deliveryRun({ delivery: "not-sent" });
  assert.deepEqual(sent.map(s => [s.cycle, s.role]), [[1, "p-감독"], [1, "qa-슈퍼감독"], [4, "qa-슈퍼감독"]]);
  assert.match(sent[1].message, /전달실패.*세션 종료 의심.*수신자 p-감독 없음/);
  assert.match(sent[2].message, /세션 종료 의심 - 해소됨 kadan-p-작업자/);
  assert.equal(printed.filter(s => s.includes("세션 종료 의심 - 해소됨")).length, 1);
});

test("모호한 전달 실패는 상신하지 않는다 — 수신자 2명 금지(2026-07-23 흉터)(card-52)", async () => {
  for (const options of [{ delivery: "unknown" }, { omitDelivery: true }]) {
    const { sent, printed } = await deliveryRun(options);
    assert.deepEqual(sent.map(s => s.role), ["p-감독"]);
    assert.equal(printed.filter(s => s.includes("전달 실패")).length, 1);
    assert.equal(printed.filter(s => s.includes("세션 종료 의심 - 해소됨") && !s.includes("→")).length, 1);
  }
});

test("원장 실패는 이미 받은 수신자에게 해소하고 슈퍼 부재·실패는 재상신하지 않는다(card-52)", async () => {
  const delivered = await deliveryRun({ delivery: "sent" });
  assert.deepEqual(delivered.sent.map(s => [s.cycle, s.role]), [[1, "p-감독"], [4, "p-감독"]]);
  const noSuper = await deliveryRun({ delivery: "not-sent", superRole: null });
  assert.deepEqual(noSuper.sent.map(s => s.role), ["p-감독"]);
  const failedSuper = await deliveryRun({ delivery: "not-sent", superFails: true });
  assert.deepEqual(failedSuper.sent.map(s => s.role), ["p-감독", "qa-슈퍼감독"]);
  assert.equal(failedSuper.printed.filter(s => s.includes("전달 실패")).length, 2);
  const directSuper = await deliveryRun({ delivery: "not-sent", superRole: "p-감독" });
  assert.deepEqual(directSuper.sent.map(s => s.role), ["p-감독"]);
});

test("해소 뒤 다시 죽으면 새 수명으로 한 번 상신한다(card-52)", async () => {
  const { sent } = await deliveryRun({ delivery: "not-sent", deaths: [false, true, true, true, false, true, true, false] });
  assert.deepEqual(sent.map(s => [s.cycle, s.role]), [[1, "p-감독"], [1, "qa-슈퍼감독"], [4, "qa-슈퍼감독"],
    [5, "p-감독"], [5, "qa-슈퍼감독"], [7, "qa-슈퍼감독"]]);
});

test("guardedSend 오류는 delivery를 밝힌다(card-52)", () => {
  const options = { session, role: entry.role, message: "card-52", recordedPid: 1,
    floor: { name: "fake", alive: () => true, pid: () => "1", send: () => ({}) }, record: () => {} };
  assert.throws(() => guardedSend({ ...options, floor: { ...options.floor, alive: () => false } }),
    e => e.code === "KADAN_SESSION_MISSING" && e.delivery === "not-sent");
  assert.throws(() => guardedSend({ ...options, floor: { ...options.floor, pid: () => "2" } }),
    e => e.code === "KADAN_PID_MISMATCH" && e.delivery === "not-sent");
  for (const phase of ["send", "record", "alive", "pid"]) {
    const error = new Error(`controlled ${phase}`);
    const stack = error.stack;
    const fail = () => { throw error; };
    const input = phase === "record" ? { ...options, record: fail }
      : { ...options, floor: { ...options.floor, [phase]: fail } };
    assert.throws(() => guardedSend(input), caught => {
      assert.strictEqual(caught, error);
      assert.equal(caught.stack, stack);
      assert.equal(caught.message, `controlled ${phase}`);
      assert.equal(caught.delivery, phase === "send" ? "unknown" : phase === "record" ? "sent" : undefined);
      return true;
    });
  }
  assert.throws(() => guardedSend({ ...options, taskId: "bad id" }), e => e.delivery === undefined);
});

test("09-24 원장 잠금 오류는 그 주기만 건너뛰고 계속, 3주기 연속이면 멈추고 보고한다", async () => {
  assert.equal(runner.isDatabaseBusy(Object.assign(new Error("database is locked"), {errcode: 5})), true);
  assert.equal(runner.isDatabaseBusy(new Error("다른 오류")), false);
  const busy = () => Object.assign(new Error("database is locked"), {code: "ERR_SQLITE_ERROR", errcode: 5});
  const run = async plan => {
    const printed = [];let cycle = 0, calls = 0;
    const stop = new Error("test cycle boundary");
    const floor = floorWith(() => "healthy");floor.alive = () => true;
    const result = await runWatch({
      floor, readEntries: () => [entry], sendAlert: () => {},
      intervalMs: 1000, stallN: 100, routes: {}, superRole: null,
      // 첫 호출은 반복 전 초기화(lastCycleAt)라 건너뛴다. 이후 각 주기 첫머리에서 잠금 오류를 낸다.
      now: () => { if (calls++ > 0 && plan[cycle] === "busy") throw busy(); return Date.parse(entry.t) + cycle * 1000; },
      print: line => printed.push(line),
      spawn: command => {
        if (command === "sleep") { if (++cycle === plan.length) throw stop; }
        if (command === "memory_pressure") return { status: 0, stdout: "System-wide memory free percentage: 80%" };
        if (command === "sysctl") return { status: 0, stdout: "total = 0.00M used = 0.00M free = 0.00M" };
        return { status: 0, stdout: "" };
      },
    }).then(() => "done", error => error === stop ? "stopped-by-test" : error);
    return {result, printed, cycle};
  };
  // 잠금 오류 두 번(연속 아님 포함)은 건너뛰고 끝까지 돈다.
  const ok = await run(["busy", "ok", "busy", "busy", "ok"]);
  assert.equal(ok.result, "stopped-by-test");
  assert.equal(ok.printed.filter(line => line.includes("원장 잠금으로 이번 주기를 건너뜀")).length, 3);
  assert.ok(ok.printed.some(line => line.includes("(2/3)")));
  // 세 번 연속이면 멈추고 그 오류를 올린다.
  const stopped = await run(["busy", "busy", "busy", "ok"]);
  assert.match(String(stopped.result?.message), /database is locked/);
  assert.ok(stopped.printed.some(line => line.includes("(3/3)")));
});
