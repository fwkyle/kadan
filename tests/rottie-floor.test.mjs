// 로티 바닥 회귀 — 2026-08-30 card-18 사고 조건을 가짜 바닥으로 잠근다.
import './helpers/isolated-home.mjs';
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildStartLedgerEntry,
  findDoneMarkers,
  formatWaitSnapshot,
  guardedSend,
  runWaitLoop,
  stripAnsi,
  waitSnapshotPath,
} from "../src/cli.mjs";
import { selectFloorName } from "../src/floor.mjs";
import {
  buildRottieSendArgv,
  parseRottieCreateEvidence,
  sendRottieText,
} from "../src/floor-rottie.mjs";

test("입력 에코에 완성 마커가 있고 새 출력이 없으면 ok가 아니라 사람 확인이다 — 2026-08-30 에코 오판", () => {
  let now = 0;
  const floor = {
    read: () => "KADAN:DONE card-echo ok",
    waitForChange: () => {
      now += 1_000;
    },
  };

  const result = runWaitLoop({
    floor,
    session: "kadan-echo",
    role: "echo",
    intervalMs: 1_000,
    quietMs: 1_000,
    timeoutMs: 10_000,
    now: () => now,
    record: () => assert.fail("에코만으로 done을 기록하면 안 된다"),
  });

  assert.deepEqual(result, { code: 2, reason: "quiet" });
});

test("죽은 터미널에는 send를 거부하고 원장에 send를 남기지 않는다 — 2026-08-30 규칙 2", () => {
  let sends = 0;
  let records = 0;
  const floor = {
    alive: () => false,
    pid: () => "222",
    send: () => {
      sends++;
    },
  };

  assert.throws(
    () =>
      guardedSend({
        floor,
        session: "kadan-dead",
        role: "dead",
        message: "보내면 안 됨",
        recordedPid: "222",
        record: () => {
          records++;
        },
      }),
    /세션 없음/
  );
  assert.equal(sends, 0);
  assert.equal(records, 0);
});

test("Rottie 출력 gap은 마커 유실 가능성이라 exit 2로 닫는다 — 2026-08-30 자동 재시도 금지", () => {
  let reads = 0;
  const floor = {
    read: () => {
      reads++;
      if (reads === 1) {
        return { text: "", cursor: "c:10", gap: null, incremental: true };
      }
      return {
        text: "KADAN:DONE card-gap ok",
        cursor: "c:30",
        gap: { from: "c:10", to: "c:20" },
        incremental: true,
      };
    },
    waitForChange: () => null,
  };

  const result = runWaitLoop({
    floor,
    session: "kadan-gap",
    role: "gap",
    intervalMs: 1,
    quietMs: 10,
    timeoutMs: 10,
    now: (() => {
      let value = 0;
      return () => value++;
    })(),
    record: () => assert.fail("gap 뒤 완료를 기록하면 안 된다"),
  });

  assert.deepEqual(result, {
    code: 2,
    reason: "gap",
    gap: { from: "c:10", to: "c:20" },
  });
});

test("Rottie send argv는 셸 문자열 없이 body-file 절대경로를 한 요소로 쓴다", () => {
  const argv = buildRottieSendArgv({
    terminalId: "term_123",
    bodyFile: "/tmp/kadan send/본문.txt",
    idempotencyKey: "kadan-send-kadan-worker-1",
  });

  assert.deepEqual(argv, [
    "terminal",
    "send",
    "--terminal",
    "term_123",
    "--body-file",
    "/tmp/kadan send/본문.txt",
    "--idempotency-key",
    "kadan-send-kadan-worker-1",
    "--json",
  ]);
  assert.equal(argv.some((arg) => arg === "--body"), false);
});

test("KADAN_FLOOR 오타는 자동 감지나 폴백 없이 typed exit 2 오류다", () => {
  assert.throws(
    () => selectFloorName("rotite"),
    (error) =>
      error.code === "KADAN_FLOOR_INVALID" &&
      error.exitCode === 2 &&
      /tmux\|rottie/.test(error.message)
  );
});

test("Codex가 마커 뒤 커서를 입력창으로 옮겨도 줄 경계를 보존한다 — 2026-08-30 Rottie 원시 스트림", () => {
  const raw =
    "  KADAN:DONE card18-cursor ok\x1b[r\x1b[30;3H› Ask Codex to do anything";
  assert.deepEqual(findDoneMarkers(stripAnsi(raw)), [
    { taskId: "card18-cursor", result: "ok" },
  ]);
});

test("Rottie는 붙여넣기 직후 Enter를 삼킨다 — 2026-08-30 card-18 실측", () => {
  const previousBin = process.env.KADAN_ROTTIE_BIN;
  process.env.KADAN_ROTTIE_BIN = "/fake/rottie";
  const calls = [];
  const spawnFn = (_bin, argv) => {
    calls.push(argv);
    if (argv[0] === "terminal" && argv[1] === "wait") {
      return {
        status: 0,
        stdout: JSON.stringify({
          ok: true,
          result: { reached: true, reason: "output", cursor: "c:11" },
        }),
      };
    }
    const sequence = calls.filter(
      (call) => call[0] === "terminal" && call[1] === "send"
    ).length;
    return {
      status: 0,
      stdout: JSON.stringify({
        ok: true,
        result: {
          delivery: {
            id: `delivery-${sequence}`,
            sequence,
            bodySha256: `sha-${sequence}`,
            outputCursor: `c:${sequence * 10}`,
          },
        },
      }),
    };
  };

  try {
    sendRottieText({
      terminalId: "term-order",
      session: "kadan-order",
      text: "본문",
      baselineText: "",
      spawnFn,
      now: () => 123,
    });
  } finally {
    if (previousBin === undefined) delete process.env.KADAN_ROTTIE_BIN;
    else process.env.KADAN_ROTTIE_BIN = previousBin;
  }

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].slice(0, 5), [
    "terminal",
    "send",
    "--terminal",
    "term-order",
    "--body-file",
  ]);
  assert.ok(calls[0][5].endsWith("/body.txt"));
  assert.deepEqual(calls[0].slice(6), [
    "--no-enter",
    "--idempotency-key",
    "kadan-send-kadan-order-123",
    "--json",
  ]);
  assert.deepEqual(calls[1], [
    "terminal",
    "wait",
    "--terminal",
    "term-order",
    "--until",
    "output",
    "--since",
    "c:10",
    "--timeout-seconds",
    "2",
    "--json",
  ]);
  assert.deepEqual(calls[2].slice(0, 5), [
    "terminal",
    "send",
    "--terminal",
    "term-order",
    "--body-file",
  ]);
  assert.ok(calls[2][5].endsWith("/enter.txt"));
  assert.deepEqual(calls[2].slice(6), [
    "--no-enter",
    "--idempotency-key",
    "kadan-send-kadan-order-123-enter",
    "--json",
  ]);
});

test("Rottie create 가짜 응답의 runtime build를 start 원장에 남긴다 — 2026-08-30 build 불일치", () => {
  const evidence = parseRottieCreateEvidence({
    ok: true,
    result: {
      terminal: {
        id: "term-build",
        pid: 4321,
        state: "running",
        workspaceId: "ws-build",
      },
    },
    runtime: { build: "build-from-response" },
  });
  const entry = buildStartLedgerEntry({
    floorName: "rottie",
    role: "worker",
    session: "kadan-worker",
    evidence,
    window: "rottie",
  });

  assert.equal(entry.rottieBuild, "build-from-response");
  assert.equal(entry.rottieTerminalId, "term-build");
  assert.equal(entry.rottiePid, "4321");
});

test("wait가 마커 없이 끝나면 화면을 남긴다 — card-19 dev 11번은 화면이 없어 원인을 못 가렸다(2026-08-31)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-wait-snapshot-"));
  const at = new Date("2026-08-31T01:02:03.000Z");
  let now = 0;
  const screen = Array.from({ length: 35 }, (_, index) => `화면-${index + 1}`).join("\n");
  const floor = {
    name: "fake",
    read: () => screen,
    waitForChange: () => {
      now += 1_000;
    },
  };

  const result = runWaitLoop({
    floor,
    session: "kadan-snapshot",
    role: "snapshot",
    intervalMs: 1_000,
    quietMs: 1_000,
    timeoutMs: 10_000,
    now: () => now,
    snapshotHome: home,
    snapshotAt: () => at,
    record: () => assert.fail("마커 없는 wait가 원장을 쓰면 안 된다"),
  });

  assert.deepEqual(result, { code: 2, reason: "quiet" });
  const file = waitSnapshotPath("kadan-snapshot", "quiet", at, home);
  assert.equal(fs.existsSync(file), true);
  const content = fs.readFileSync(file, "utf8");
  assert.equal(
    content,
    formatWaitSnapshot({
      session: "kadan-snapshot",
      reason: "quiet",
      at,
      screen: Array.from({ length: 30 }, (_, index) => `화면-${index + 6}`).join("\n"),
    })
  );
  assert.deepEqual(content.split("\n").slice(0, 3), [
    "session: kadan-snapshot",
    "reason: quiet",
    "at: 2026-08-31T01:02:03.000Z",
  ]);
  assert.ok(content.split("\n").slice(3).length <= 30);
});

test("wait exit 0은 마지막 화면 파일을 만들지 않는다", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-wait-success-"));
  const floor = {
    name: "fake",
    read: () => "KADAN:DONE card20-ok ok",
    waitForChange: () => null,
  };

  const result = runWaitLoop({
    floor,
    session: "kadan-success",
    role: "success",
    intervalMs: 1,
    quietMs: 10,
    timeoutMs: 10,
    baselineMarkers: [],
    snapshotHome: home,
    snapshotAt: () => new Date("2026-08-31T01:02:03.000Z"),
    record: () => null,
  });

  assert.equal(result.code, 0);
  assert.deepEqual(fs.readdirSync(home), []);
});
