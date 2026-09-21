import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { runWatch } from "./helpers/watch-runner.mjs";

// 2026-09-15 실사고: 감독 입력이 작업자 큐에 쌓인 채 멈췄는데 감시가 못 잡았다.
// 실행기별 대기 문구는 설치본에서 확인한 것만 쓴다(card-watch-queued-input).
// 같은 날 오탐 교훈(card-watch-queued-false-positive): 문구는 입력줄 자리에
// 뜬 것만 근거다 — 본문에 같은 글자가 있는 것과 구분한다.
const DEVIN_QUEUED = "❭ Press Enter to send queued messages now";
const DEVIN_QUEUED_BARE = "Press Enter to send queued messages now";
const CODEX_QUEUED =
  "• Messages to be submitted at end of turn\n  ↳ 감독이 보낸 지시\n\n› Ask Codex to do anything\n  gpt high · ~/Dev/repo · Context 40% used";
const CODEX_HINT =
  "Press Tab to queue a message when a task is running; otherwise it sends immediately";
const IDLE = "› 입력 대기";
// 오탐이 난 실제 화면 형태: 본문에 문구가 있고 입력줄은 정상 자리표시자.
const DEVIN_FALSE_POSITIVE = [
  " │   • 실측 문구: devin `Press Enter to send queued messages now`, codex `Messages to be submitted at end of turn`",
  " │   완료 보고 본문",
  "",
  "⠋  Running tools · 1m 51s (esc twice to interrupt)",
  "──────────────────────────────────────────────── (bypass permissions on) ─",
  "❭ Guide Devin while it works",
  "─────────────────────────────────────────────────────────────────────────",
  "SWE-2 Max                                    Context: 85k / 262k tokens (32%)",
].join("\n");
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

test("오탐 재현: 본문에 문구가 있고 정상 입력 프롬프트가 있으면 알리지 않는다", async () => {
  const { records, sent } = await exercise({
    entries: [start],
    screens: Array(5).fill(DEVIN_FALSE_POSITIVE),
  });
  assert.equal(queuedRecords(records).length, 0);
  assert.equal(sent.length, 0);
});

test("대기 상태 자리표시자(Ask Devin)가 보여도 본문 문구는 걸지 않는다", async () => {
  const idle = DEVIN_FALSE_POSITIVE.replace(
    "❭ Guide Devin while it works",
    "❭ Ask Devin to build features, fix bugs, or work on your code"
  );
  const { records, sent } = await exercise({
    entries: [start],
    screens: Array(5).fill(idle),
  });
  assert.equal(queuedRecords(records).length, 0);
  assert.equal(sent.length, 0);
});

test("입력 영역 밖 본문의 문구는 프롬프트가 없어도 걸지 않는다", async () => {
  const body = Array(20)
    .fill("작업 출력")
    .concat(["Press Enter to send queued messages now"])
    .concat(Array(12).fill("이어지는 출력"))
    .join("\n");
  const { records, sent } = await exercise({
    entries: [start],
    screens: Array(5).fill(body),
  });
  assert.equal(queuedRecords(records).length, 0);
  assert.equal(sent.length, 0);
});

test("devin 보조: ❭ 세션이고 맨 아래 입력 영역에 문구가 있으면 잡는다", async () => {
  const screen = [
    "작업 출력",
    "────────────────────────────────────────────────",
    "❭ 방금 치던 초안",
    DEVIN_QUEUED_BARE,
    "────────────────────────────────────────────────",
    "SWE-2 Max",
  ].join("\n");
  const { sent } = await exercise({
    entries: [start],
    screens: Array(4).fill(screen),
    cycles: 4,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /큐에 쌓여 대기/);
});

test("❭가 없는 화면(다른 실행기·셸)의 하단 문구는 걸지 않는다", async () => {
  const screen = ["로그 출력", DEVIN_QUEUED_BARE, "계속되는 출력", "프롬프트$"].join(
    "\n"
  );
  const { records, sent } = await exercise({
    entries: [start],
    screens: Array(5).fill(screen),
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

test("codex의 큐 블록도 같은 경보로 잡는다 — 입력 프롬프트가 함께 있어도 잡는다", async () => {
  const { sent } = await exercise({
    entries: [start],
    screens: Array(4).fill(`작업 중\n${CODEX_QUEUED}`),
    cycles: 4,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /큐에 쌓여 대기/);
  assert.match(sent[0].message, /자동 제출/);
});

test("codex의 본문 인용 문구는 '• ' 헤더·'↳' 항목이 없으면 걸지 않는다", async () => {
  const quoted = [
    "결과 보고: codex는 `Messages to be submitted at end of turn`로 표시한다",
    "• Messages to be submitted at end of turn", // 글머리까지 있어도
    "다음 문장이 이어진다", // ↳ 항목이 없으면 본문 글자다
    "› Ask Codex to do anything",
  ].join("\n");
  const { records, sent } = await exercise({
    entries: [start],
    screens: Array(5).fill(quoted),
  });
  assert.equal(queuedRecords(records).length, 0);
  assert.equal(sent.length, 0);
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
