import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { runWatch } from "./helpers/watch-runner.mjs";

// 2026-09-15 실사고: 감독 입력이 작업자 큐에 쌓인 채 멈췄는데 감시가 못 잡았다.
// 실행기별 대기 문구는 설치본에서 확인한 것만 쓴다(card-watch-queued-input).
const DEVIN_QUEUED = "Press Enter to send queued messages now";
const CODEX_QUEUED = "Messages to be submitted at end of turn";
const CODEX_HINT =
  "Press Tab to queue a message when a task is running; otherwise it sends immediately";
const IDLE = "› 입력 대기";
const session = "kadan-p-작업자";
const start = {
  kind: "start",
  role: "p-작업자",
  session,
  panePid: 1,
  t: "2026-09-15T00:00:00.000Z",
};

async function exercise({ entries, screens, cycles = 5, queuedAfterMs = 2000, cards }) {
  let cycle = 0;
  const records = [], sent = [], lines = [];
  const sentinel = new Error("cycle boundary");
  const oldLoad = os.loadavg;
  os.loadavg = () => [0, 0, 0];
  const screen = () => screens[Math.min(cycle, screens.length - 1)];
  try {
    await assert.rejects(
      () =>
        runWatch({
          floor: { list: () => [{ session, pid: 1 }], read: screen },
          readEntries: () => entries,
          ...(cards ? { readCards: () => cards, readWorks: () => [] } : {}),
          record: (e) => {
            if (e.kind !== "watch-cycle") records.push(e);
          },
          sendAlert: (role, message) => sent.push({ role, message }),
          intervalMs: 1000,
          stallN: 100,
          queuedAfterMs,
          routes: { p: "p-감독" },
          superRole: "qa-슈퍼감독",
          now: () => Date.parse(start.t) + cycle * 1000,
          print: (line) => lines.push(line),
          spawn: (command) => {
            if (command === "sleep" && ++cycle === cycles) throw sentinel;
            if (command === "memory_pressure")
              return { status: 0, stdout: "System-wide memory free percentage: 80%" };
            if (command === "sysctl")
              return { status: 0, stdout: "total = 0M used = 0M free = 0M" };
            return { status: 0, stdout: "" };
          },
        }),
      (error) => error === sentinel
    );
  } finally {
    os.loadavg = oldLoad;
  }
  return { records, sent, lines };
}

const queuedRecords = (records) =>
  records.filter((e) => e.alertKind === "큐대기");

test("문구가 기준 시간 전에 사라지면 알리지 않는다", async () => {
  const { records, sent } = await exercise({
    entries: [start],
    screens: [DEVIN_QUEUED, IDLE, IDLE, IDLE, IDLE],
  });
  assert.equal(queuedRecords(records).length, 0);
  assert.equal(sent.length, 0);
});

test("문구가 기준을 넘기면 감독에게 알리고 같은 상태면 반복하지 않는다", async () => {
  const { records, sent } = await exercise({
    entries: [start],
    screens: Array(5).fill(DEVIN_QUEUED),
    cycles: 5,
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].role, "p-감독");
  assert.match(sent[0].message, /큐에 쌓여 대기/);
  assert.match(sent[0].message, /Enter/);
  assert.match(sent[0].message, /kadan-p-작업자/);
  const alerts = queuedRecords(records);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].delivered, true);
  assert.equal(alerts[0].recipient, "p-감독");
});

test("풀리면 해소 우편 없이 경보만 조용히 닫는다", async () => {
  const { records, sent } = await exercise({
    entries: [start],
    screens: [DEVIN_QUEUED, DEVIN_QUEUED, DEVIN_QUEUED, IDLE, IDLE, IDLE],
    cycles: 6,
  });
  assert.equal(sent.length, 1);
  assert.ok(!sent.some((s) => s.message.includes("해소됨")));
  const resolved = queuedRecords(records).filter((e) => e.resolved);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].delivered, false);
});

test("카드 발령이 없어 감시 대상이 아닌 세션도 잡는다 — 오늘 사고의 사각", async () => {
  const { records, sent } = await exercise({
    entries: [start],
    cards: [],
    screens: Array(4).fill(DEVIN_QUEUED),
    cycles: 4,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /큐에 쌓여 대기 kadan-p-작업자/);
  assert.equal(queuedRecords(records).length, 1);
});

test("codex의 큐 헤더도 같은 경보로 잡는다", async () => {
  const { sent } = await exercise({
    entries: [start],
    screens: Array(4).fill(`작업 중\n${CODEX_QUEUED}\n› Ask Codex`),
    cycles: 4,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /큐에 쌓여 대기/);
});

test("codex의 작업 중 큐 안내 문구는 경보 근거가 아니다", async () => {
  const { records, sent } = await exercise({
    entries: [start],
    screens: Array(5).fill(`작업 중\n${CODEX_HINT}`),
    cycles: 5,
  });
  assert.equal(queuedRecords(records).length, 0);
  assert.equal(sent.length, 0);
});
