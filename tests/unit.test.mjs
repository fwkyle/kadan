// 유닛 시험 — tmux 없이도 검증되는 순수 함수와 원장.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.TZ = "Asia/Seoul";
process.env.KADAN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-lite-test-"));
process.env.KADAN_SOCKET = "kadan-unittest";

const {
  buildOrcaCreateArgv,
  resolveWindowChoice,
  sessionName,
  stripAnsi,
  tailLines,
  findDoneMarkers,
  diffDoneMarkers,
  appendLedger,
  readLedger,
  ledgerBy,
  resolveLedgerBy,
  parseFlags,
  digest,
  buildTree,
  renderTree,
  renderLogEntry,
  renderWallHtml,
  createWallServer,
  recentSends,
  confirmDone,
  guardedSend,
  buildStartLedgerEntry,
  buildStopLedgerEntry,
  buildTmuxCreateArgv,
  buildRottieCreateArgv,
  buildRottieFloorCreateArgv,
  parseRottieCreateResult,
  openWindow,
  tmuxConfText,
  tmux,
  tmuxConfPath,
  assessRoles,
  assessResources,
  collectResources,
  routeAlert,
  dedupAlerts,
  buildJudgeInput,
  parseJudgeVerdict,
  applyJudgeVerdict,
  judgeDue,
  assessSupervisorIdle,
  wakeDue,
  buildWakeMessage,
  formatAlertBody,
  deliverResolution,
  executeJudge,
  disconnectKind,
  pendingCardsFor,
} = await import("../src/cli.mjs");

test("원장 role은 kind마다 뜻이 다르다 — send는 받는 사람, done은 한 사람(2026-08-31 card-27 뿌리)(card-28)", () => {
  // Given: 감독이 작업자에게 보낸 기록, 역할 시작·종료 기록, 작업자 완료 기록이 있다.
  const fakeFloor = {
    name: "fake",
    alive: () => true,
    pid: () => "111",
    send: () => null,
  };
  const sent = guardedSend({
    floor: fakeFloor,
    session: "kadan-b1-작업자",
    role: "b1-작업자",
    message: "card-t 실행",
    taskId: "card-t",
    recordedPid: "111",
    env: { KADAN_ROLE: "b1-감독" },
    record: () => null,
    readEntries: () => [
      { kind: "start", role: "b1-작업자", session: "kadan-b1-작업자", panePid: "111", cmd: "codex --model test-model" },
    ],
  });
  const started = buildStartLedgerEntry({
    floorName: "tmux",
    role: "b1-작업자",
    session: "kadan-b1-작업자",
    evidence: { panePid: "111" },
    window: "hidden",
    env: {},
  });
  const stopped = buildStopLedgerEntry({
    role: "b1-작업자",
    session: "kadan-b1-작업자",
    env: { KADAN_ROLE: "b1-감독" },
  });
  const done = {
    kind: "done",
    role: "b1-작업자",
    session: "kadan-b1-작업자",
    taskId: "card-t",
    result: "ok",
  };

  // When: kind별 role과 by를 표로 읽는다.
  const meanings = [sent, started, stopped, done].map((entry) => ({
    kind: entry.kind,
    role: entry.role,
    by: entry.by,
  }));

  // Then: send의 role은 수신자, start·stop은 대상, done은 완료한 사람이며 done만 by가 없다.
  assert.deepEqual(meanings, [
    { kind: "send", role: "b1-작업자", by: "b1-감독" },
    { kind: "start", role: "b1-작업자", by: "사람" },
    { kind: "stop", role: "b1-작업자", by: "b1-감독" },
    { kind: "done", role: "b1-작업자", by: undefined },
  ]);
});

test("by는 watch → KADAN_ROLE → 사람 순서로 하나만 정해진다(card-28)", () => {
  // Given: watch 표식과 세션 역할이 함께 있거나 각각만 있는 세 경우다.
  const env = { KADAN_ROLE: "b1-감독" };

  // When: 한 곳의 결정 함수로 발신자를 정한다.
  const values = [
    resolveLedgerBy({ source: "watch", env }),
    resolveLedgerBy({ env }),
    resolveLedgerBy({ env: {} }),
  ];

  // Then: 먼저 맞는 값 하나만 사용한다.
  assert.deepEqual(values, ["watch", "b1-감독", "사람"]);
});

test("옛 기록에 by가 없으면 모름이다 — 사람으로 추측하지 않는다(card-28)", () => {
  // Given: by가 없는 옛 send와 by가 있는 새 send가 있다.
  const oldEntry = {
    t: "2026-08-30T20:01:00.000Z",
    kind: "send",
    role: "b1-작업자",
    session: "kadan-b1-작업자",
    taskId: "card-old",
    bytes: 3,
    digest: "old",
  };
  const newEntry = { ...oldEntry, taskId: "card-new", by: "b1-감독" };

  // When: 읽기 표시와 tree·log 출력을 만든다.
  const tree = buildTree([oldEntry, newEntry]);
  const oldLog = renderLogEntry(oldEntry);

  // Then: 옛 줄은 사람으로 추측하지 않고 모름으로 드러난다.
  assert.equal(ledgerBy(oldEntry), "모름");
  assert.equal(ledgerBy(newEntry), "b1-감독");
  assert.equal(tree[0].roles[0].cards[0].by, "모름");
  assert.match(renderTree(tree), /card-old\s+← 모름/);
  assert.match(oldLog, /모름 → b1-작업자\s+card-old/);
});

test("kadan start는 세션에 KADAN_ROLE을 심는다 — tmux -e와 Rottie env 감싸기(card-28)", () => {
  // Given: 역할·세션·작업 폴더·원래 명령이 각각 한 요소인 시작 입력이다.
  const input = {
    role: "b1-감독",
    session: "kadan-b1-감독",
    cwd: "/home/te ster/Dev/kadan lite",
    cmd: "codex --resume",
  };

  // When: tmux와 Rottie가 실제로 받을 argv를 만든다.
  const tmuxArgv = buildTmuxCreateArgv(input);
  const rottieArgv = buildRottieFloorCreateArgv({
    ...input,
    idempotencyKey: "kadan-kadan-b1-감독-123",
  });

  // Then: tmux는 -e 한 요소, Rottie는 env 명령 인자 배열을 보존한다.
  assert.deepEqual(tmuxArgv, [
    "new-session",
    "-d",
    "-s",
    "kadan-b1-감독",
    "-c",
    "/home/te ster/Dev/kadan lite",
    "-e",
    "KADAN_ROLE=b1-감독",
    "codex --resume",
  ]);
  assert.deepEqual(rottieArgv.slice(6, 9), [
    "--command",
    "env KADAN_ROLE=b1-감독 codex --resume",
    "--idempotency-key",
  ]);
  const sanitizedRottieArgv = buildRottieFloorCreateArgv({
    role: '감독 "위조"',
    session: "kadan-감독-위조",
    cwd: input.cwd,
    cmd: "/bin/zsh",
    idempotencyKey: "kadan-safe-role",
  });
  assert.equal(
    sanitizedRottieArgv[7],
    "env KADAN_ROLE=감독-위조 /bin/zsh"
  );
  assert.ok([...tmuxArgv, ...rottieArgv].every((arg) => typeof arg === "string"));
});

test("watch가 보낸 것은 by=watch다 — 감독이 일한 것으로 세지 않는다(2026-08-31 card-27 결함)(card-28)", () => {
  // Given: 감독 세션 환경에서 watch가 작업자에게 보내는 전달이다.
  const records = [];
  const fakeFloor = {
    name: "fake",
    alive: () => true,
    pid: () => "111",
    send: () => null,
  };

  // When: watch 내부 표식을 붙여 실제 send 원장 항목을 만든다.
  guardedSend({
    floor: fakeFloor,
    session: "kadan-b1-작업자",
    role: "b1-작업자",
    message: "상신",
    source: "watch",
    env: { KADAN_ROLE: "b1-감독" },
    recordedPid: "111",
    record: (entry) => records.push(entry),
  });

  // Then: 환경 역할보다 watch가 우선하고 예전 source 칸은 남기지 않는다.
  assert.equal(records[0].by, "watch");
  assert.equal(Object.hasOwn(records[0], "source"), false);
});

test("정체 후보만 모델에 간다 — 죽음·자원은 코드가 즉시 처리한다(card-24)", () => {
  const stall = {
    id: "stall:kadan-j1-작업자",
    kind: "정체",
    level: "AMBER",
    role: "j1-작업자",
    session: "kadan-j1-작업자",
    count: 2,
  };
  const death = {
    id: "death:kadan-j1-감독",
    kind: "죽음",
    level: "RED",
    role: "j1-감독",
    session: "kadan-j1-감독",
  };
  const resource = {
    id: "resource",
    kind: "자원",
    level: "AMBER",
    signals: ["memory"],
  };

  const applied = applyJudgeVerdict(
    [stall, death, resource],
    new Map([[stall.session, "입력대기"]])
  );

  assert.deepEqual(applied, [death, resource]);
});

test("낱말 밖 응답·호출 실패·시간 초과는 모름 — 모름은 조용이 아니다(relay-patrol.py:151)(card-24)", () => {
  const calls = [];
  const failed = executeJudge("fake-judge", "judge input", (command, options) => {
    calls.push({ command, options });
    return { status: 1, stdout: "정체", stderr: "failed" };
  });
  const timedOut = executeJudge("fake-judge", "judge input", () => ({
    status: null,
    stdout: "",
    stderr: "",
    error: { code: "ETIMEDOUT" },
  }));

  assert.equal(parseJudgeVerdict("정체라고 생각합니다"), "모름");
  assert.equal(parseJudgeVerdict(""), "모름");
  assert.equal(failed, "모름");
  assert.equal(timedOut, "모름");
  assert.equal(calls[0].command, "fake-judge");
  assert.equal(calls[0].options.input, "judge input");
  assert.equal(calls[0].options.shell, true);
  assert.equal(calls[0].options.timeout, 90_000);

  const unknown = applyJudgeVerdict(
    [
      {
        id: "stall:kadan-j1-작업자",
        kind: "정체",
        level: "AMBER",
        role: "j1-작업자",
        session: "kadan-j1-작업자",
        count: 2,
      },
    ],
    new Map([["kadan-j1-작업자", "모름"]])
  );
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].kind, "모름");
  assert.equal(unknown[0].judgeVerdict, "모름");
});

test("화면 조각은 하단 60줄·3,000자 상한 — 옛 relay 실측 값 재사용(card-24)", () => {
  const screen = Array.from(
    { length: 70 },
    (_, index) => `L${String(index + 1).padStart(3, "0")}:${"x".repeat(80)}`
  ).join("\n");

  const input = buildJudgeInput(screen);
  const fragment = input
    .split("--- 화면 조각 ---\n")[1]
    .split("\n--- 끝 ---")[0];

  assert.ok(input.startsWith("너는 터미널 화면 조각을 보고 에이전트 상태를 판정한다."));
  assert.ok(input.endsWith("--- 끝 ---"));
  assert.ok(!fragment.includes("L010:"));
  assert.ok(fragment.includes("L070:"));
  assert.ok(fragment.split("\n").length <= 60);
  assert.ok(fragment.length <= 3_000);
  assert.equal(fragment, screen.split("\n").slice(-60).join("\n").slice(-3_000));
});

test("같은 역할 판정은 쿨다운에 한 번 — 옛 kicker 5분 순찰(card-24)", () => {
  const cooldownMs = 5 * 60 * 1_000;

  assert.equal(judgeDue(null, 1_000, cooldownMs), true);
  assert.equal(judgeDue(1_000, 300_999, cooldownMs), false);
  assert.equal(judgeDue(1_000, 301_000, cooldownMs), true);
});

test("진행중·입력대기는 침묵, 정체·죽음·모름은 알림 — 애매하면 무조건 모델(2026-08-10 kyle)(card-24)", () => {
  const verdicts = ["진행중", "입력대기", "정체", "죽음", "모름"];
  const alerts = verdicts.map((verdict, index) => ({
    id: `stall:kadan-j1-${index}`,
    kind: "정체",
    level: "AMBER",
    role: `j1-${index}`,
    session: `kadan-j1-${index}`,
    count: 2,
  }));
  const verdictBySession = new Map(
    alerts.map((alert, index) => [alert.session, verdicts[index]])
  );

  const applied = applyJudgeVerdict(alerts, verdictBySession);

  assert.deepEqual(
    applied.map((alert) => ({
      session: alert.session,
      kind: alert.kind,
      level: alert.level,
      judgeVerdict: alert.judgeVerdict,
    })),
    [
      {
        session: "kadan-j1-2",
        kind: "정체",
        level: "AMBER",
        judgeVerdict: "정체",
      },
      {
        session: "kadan-j1-3",
        kind: "죽음",
        level: "RED",
        judgeVerdict: "죽음",
      },
      {
        session: "kadan-j1-4",
        kind: "모름",
        level: "AMBER",
        judgeVerdict: "모름",
      },
    ]
  );
});

test("메모리 1차·스왑 2차·CPU 3차 — 2026-08-09 스왑 22.5GB로 기계가 죽었다(card-23)", () => {
  const assessed = assessResources(
    { swapHistory: [100, 110] },
    { memory: "warning", swapUsed: 120, load5: 13 },
    12
  );

  assert.deepEqual(assessed.alerts, [
    {
      id: "resource",
      kind: "자원",
      level: "RED",
      signals: ["memory", "swap", "cpu"],
    },
  ]);
  assert.deepEqual(assessed.state.swapHistory, [100, 110, 120]);

  const beforeThirdIncrease = assessResources(
    { swapHistory: [100] },
    { memory: "normal", swapUsed: 110, load5: 1 },
    12
  );
  assert.deepEqual(beforeThirdIncrease.alerts, []);
});

test("메모리 관문 25%/15% — 2026-08-09 사망과 2026-08-11 오탐을 함께 검토한 값(card-26)", () => {
  const memoryLevel = (freePercent) =>
    collectResources((command, args) => {
      if (command === "memory_pressure") {
        return {
          status: 0,
          stdout: `System-wide memory free percentage: ${freePercent}%`,
        };
      }
      if (args.includes("vm.swapusage")) {
        return { status: 0, stdout: "total = 0.00M used = 0.00M free = 0.00M" };
      }
      if (args.includes("vm.loadavg")) {
        return { status: 0, stdout: "{ 0.00 0.00 0.00 }" };
      }
      return { status: 0, stdout: "12" };
    }, { platform: "darwin" }).current.memory;

  assert.deepEqual(
    [26, 25, 16, 15, 14].map(memoryLevel),
    ["normal", "warning", "warning", "critical", "critical"]
  );
});

test("절전 구간은 정체로 세지 않는다 — 2026-08-07 맥 절전 오탐(card-23)", () => {
  const previous = new Map([
    [
      "kadan-w1-작업자",
      {
        role: "w1-작업자",
        alive: true,
        pid: "111",
        digest: "same",
        stallCount: 1,
      },
    ],
  ]);
  const current = new Map([
    [
      "kadan-w1-작업자",
      {
        role: "w1-작업자",
        alive: true,
        pid: "111",
        expectedPid: "111",
        digest: "same",
      },
    ],
  ]);

  const assessed = assessRoles(previous, current, 3_001, 1_000, 2);

  assert.deepEqual(assessed.alerts, []);
  assert.equal(assessed.states.get("kadan-w1-작업자").stallCount, 0);
});

test("감독·검수자도 무변화 후보를 만들고 죽음도 감시한다 — 2026-09-07 정책", () => {
  const roles = ["r1-감독", "r1-검수자", "r1-작업자"];
  const previous = new Map(
    roles.map((role) => [
      `kadan-${role}`,
      {
        role,
        alive: true,
        pid: role,
        expectedPid: role,
        digest: "same",
        stallCount: 1,
      },
    ])
  );
  const current = new Map(
    roles.map((role) => [
      `kadan-${role}`,
      {
        role,
        alive: true,
        pid: role,
        expectedPid: role,
        digest: "same",
      },
    ])
  );

  const stalled = assessRoles(previous, current, 1_000, 1_000, 2);
  assert.deepEqual(
    stalled.alerts.map((alert) => alert.session),
    ["kadan-r1-감독", "kadan-r1-검수자", "kadan-r1-작업자"]
  );
  assert.equal(stalled.states.get("kadan-r1-감독").stallCount, 2);
  assert.equal(stalled.states.get("kadan-r1-검수자").stallCount, 2);
  assert.equal(stalled.states.get("kadan-r1-감독").unchangedMs, 1_000);
  assert.equal(stalled.states.get("kadan-r1-검수자").unchangedMs, 1_000);

  const disappeared = new Map(current);
  disappeared.set("kadan-r1-감독", {
    ...current.get("kadan-r1-감독"),
    alive: false,
    pid: null,
  });
  disappeared.set("kadan-r1-검수자", {
    ...current.get("kadan-r1-검수자"),
    alive: false,
    pid: null,
  });
  const died = assessRoles(stalled.states, disappeared, 1_000, 1_000, 2);
  assert.deepEqual(
    died.alerts
      .filter((alert) => alert.kind === "죽음")
      .map((alert) => alert.session),
    ["kadan-r1-감독", "kadan-r1-검수자"]
  );
  assert.deepEqual(
    assessSupervisorIdle(
      [
        {
          t: "2026-08-31T12:00:00.000Z",
          kind: "send",
          role: "r1-작업자",
          taskId: "card-a",
        },
      ],
      died.states,
      Date.parse("2026-08-31T13:00:00.000Z"),
      30 * 60 * 1_000
    ),
    []
  );
});

test("끊김은 정체가 아니다 — 2026-08-31 502/ENOTFOUND를 정체로 봤다(card-31)", () => {
  const session = "kadan-c31-작업자";
  const baseline = assessRoles(
    new Map(),
    new Map([
      [session, { role: "c31-작업자", alive: true, pid: "111", expectedPid: "111", digest: "before", screen: "작업 중" }],
    ]),
    1_000,
    1_000,
    1
  );
  const errorLine = "502 Bad Gateway: Provider unreachable: getaddrinfo ENOTFOUND chatgpt.com";

  const assessed = assessRoles(
    baseline.states,
    new Map([
      [session, { role: "c31-작업자", alive: true, pid: "111", expectedPid: "111", digest: "error", screen: `앞 1\n앞 2\n${errorLine}\n뒤 1\n뒤 2\n뒤 3` }],
    ]),
    1_000,
    1_000,
    1
  );

  assert.deepEqual(
    assessed.alerts.map(({ kind, session: alertSession, line }) => ({ kind, session: alertSession, line })),
    [{ kind: "끊김", session, line: errorLine }]
  );
  assert.equal(assessed.alerts.some((alert) => alert.kind === "정체"), false);
});

test("한도·설정은 끊김이 아니다 — 429에 '이어서 해'를 보내 즉사(2026-07-23 ×2, 08-06 5시간)(card-41)", () => {
  assert.equal(disconnectKind("429 Too Many Requests"), "한도");
  assert.equal(disconnectKind("rate limit reached, exceeded retry limit"), "한도");
  assert.equal(disconnectKind("Error: No API key found"), "설정");
  assert.equal(disconnectKind("502 Bad Gateway"), "끊김");
  assert.equal(disconnectKind("getaddrinfo ENOTFOUND chatgpt.com"), "끊김");

  const session = "kadan-c41-작업자";
  const baseline = assessRoles(
    new Map(),
    new Map([
      [session, { role: "c41-작업자", alive: true, pid: "111", expectedPid: "111", digest: "before", screen: "작업 중" }],
    ]),
    1_000,
    1_000,
    1
  );
  const assessed = assessRoles(
    baseline.states,
    new Map([
      [session, { role: "c41-작업자", alive: true, pid: "111", expectedPid: "111", digest: "error", screen: "앞\n429 Too Many Requests\n뒤" }],
    ]),
    1_000,
    1_000,
    1
  );
  assert.deepEqual(
    assessed.alerts.map(({ kind, level }) => ({ kind, level })),
    [{ kind: "한도", level: "AMBER" }]
  );
  assert.match(formatAlertBody(assessed.alerts[0], {}), /^한도 kadan-c41-작업자 \(429 Too Many Requests\)/u);
});

test("stop은 미확정 카드를 세어 알린다 — 판을 접자 카드 6건이 미아가 됐다(2026-09-01)(card-41)", () => {
  const entries = [
    { t: "1", kind: "send", role: "c41-작업자", taskId: "card-a" },
    { t: "2", kind: "send", role: "c41-작업자", taskId: "card-b" },
    { t: "3", kind: "done", role: "c41-작업자", taskId: "card-a", result: "ok" },
    { t: "4", kind: "send", role: "c41-검수자", taskId: "card-c" },
    { t: "5", kind: "send", role: "c41-작업자" },
    { t: "6", kind: "send", role: "c41-작업자", taskId: "card-d" },
  ];
  assert.deepEqual(pendingCardsFor(entries, "c41-작업자"), ["card-b", "card-d"]);
  assert.deepEqual(pendingCardsFor(entries, "c41-검수자"), ["card-c"]);
  assert.deepEqual(pendingCardsFor(entries, "c41-감독"), []);
});

test("감시 시작 때 이미 있던 오류엔 울리지 않는다 — baseline(옛 watch-terminals.sh)(card-31)", () => {
  const session = "kadan-c31-기준선";
  const errorLine = "stream disconnected: Provider unreachable";
  const current = new Map([
    [session, { role: "c31-기준선", alive: true, pid: "222", expectedPid: "222", digest: "same", screen: errorLine }],
  ]);

  const first = assessRoles(new Map(), current, 1_000, 1_000, 2);
  const second = assessRoles(first.states, current, 1_000, 1_000, 2);
  const freshLine = "stream error: 새로 생긴 오류";
  const fresh = assessRoles(
    second.states,
    new Map([
      [session, { role: "c31-기준선", alive: true, pid: "222", expectedPid: "222", digest: "fresh", screen: `${errorLine}\n${freshLine}` }],
    ]),
    1_000,
    1_000,
    2
  );

  assert.deepEqual(first.alerts, []);
  assert.deepEqual(second.alerts, []);
  assert.deepEqual(
    fresh.alerts.map(({ kind, line }) => ({ kind, line })),
    [{ kind: "끊김", line: freshLine }]
  );
});

test("완료 마커는 알림일 뿐 판정이 아니다 — 입력 에코 오판(2026-08-30)(card-31)", () => {
  const session = "kadan-c31-완료";
  const beforeDoneCount = readLedger().filter((entry) => entry.kind === "done").length;

  const assessed = assessRoles(
    new Map(),
    new Map([
      [session, { role: "c31-완료", alive: true, pid: "333", expectedPid: "333", digest: "done", screen: "KADAN:DONE card-31 ok" }],
    ]),
    1_000,
    1_000,
    1
  );

  assert.deepEqual(
    assessed.alerts.map(({ kind, taskId, result }) => ({ kind, taskId, result })),
    [{ kind: "완료후보", taskId: "card-31", result: "ok" }]
  );
  assert.equal(readLedger().filter((entry) => entry.kind === "done").length, beforeDoneCount);
});

test("완료 마커 뒤 유휴를 정체로 알리지 않는다 — card-30 실측 과민 동작(card-31)", () => {
  const session = "kadan-c31-유휴";
  const observation = (digest, screen) => new Map([
    [session, { role: "c31-유휴", alive: true, pid: "444", expectedPid: "444", digest, screen }],
  ]);
  const doneScreen = "KADAN:DONE card-31 ok\n› Ask Codex to do anything";

  const first = assessRoles(new Map(), observation("done", doneScreen), 1_000, 1_000, 1);
  const idleAfterDone = assessRoles(first.states, observation("done", doneScreen), 1_000, 1_000, 1);
  const changed = assessRoles(idleAfterDone.states, observation("changed", "새 작업"), 1_000, 1_000, 1);
  const stalledAgain = assessRoles(changed.states, observation("changed", "새 작업"), 1_000, 1_000, 1);

  assert.equal(idleAfterDone.alerts.some((alert) => alert.kind === "정체"), false);
  assert.equal(stalledAgain.alerts.some((alert) => alert.kind === "정체"), true);
});

test("감독이 놀면 슈퍼에게 올린다 — 2026-08-07 감독 1시간 30분 동결을 18번 일기에만 적었다(card-27)", () => {
  // Given: 미완료 카드가 있고 감독 화면이 32분 동안 그대로다.
  const now = Date.parse("2026-08-31T12:32:00.000Z");
  const entries = [
    {
      t: "2026-08-31T12:00:00.000Z",
      kind: "send",
      role: "p-작업자",
      session: "kadan-p-작업자",
      taskId: "card-a",
    },
    {
      t: "2026-08-31T12:00:00.000Z",
      kind: "send",
      role: "p-작업자",
      session: "kadan-p-작업자",
      taskId: "card-b",
    },
  ];
  const roleStates = new Map([
    [
      "kadan-p-감독",
      {
        role: "p-감독",
        alive: true,
        digest: "same",
        unchangedMs: 32 * 60 * 1_000,
      },
    ],
  ]);

  // When: 미완료 카드와 감독 자신의 화면 지문을 함께 판정한다.
  const alerts = assessSupervisorIdle(
    entries,
    roleStates,
    now,
    30 * 60 * 1_000
  );

  // Then: 미완료 카드 수와 무활동 분을 담은 이상 하나가 슈퍼 한 곳으로 간다.
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "놀고 있음");
  assert.equal(alerts[0].session, "kadan-p-감독");
  assert.equal(alerts[0].openCards, 2);
  assert.equal(alerts[0].idleMinutes, 32);
  assert.equal(
    formatAlertBody(alerts[0], {}),
    "놀고 있음 kadan-p-감독 (안 끝난 카드 2장, 32분간 화면 변화 없음)"
  );
  assert.equal(
    routeAlert(
      alerts[0],
      new Map([["p", "p-지휘자"]]),
      new Set(["kadan-p-감독", "kadan-슈퍼"]),
      "슈퍼"
    ),
    "슈퍼"
  );
});

test("우편함에 편지가 와도 감독이 일한 것이 아니다 — 2026-08-07 동결을 배달이 가렸다(card-27 수리)", () => {
  // Given: 미완료 카드 뒤 감독 화면은 그대로인데 watch 편지만 감독에게 도착했다.
  const now = Date.parse("2026-08-31T12:32:00.000Z");
  const entries = [
    {
      t: "2026-08-31T12:00:00.000Z",
      kind: "send",
      role: "p-작업자",
      session: "kadan-p-작업자",
      taskId: "card-a",
    },
    {
      t: "2026-08-31T12:31:00.000Z",
      kind: "send",
      role: "p-감독",
      session: "kadan-p-감독",
    },
  ];
  const roleStates = assessRoles(
    new Map([
      [
        "kadan-p-감독",
        {
          role: "p-감독",
          alive: true,
          digest: "after-delivery",
          unchangedMs: 31 * 60 * 1_000,
        },
      ],
    ]),
    new Map([
      [
        "kadan-p-감독",
        {
          role: "p-감독",
          alive: true,
          digest: "after-delivery",
        },
      ],
    ]),
    60 * 1_000,
    60 * 1_000,
    999
  ).states;

  // When: 배달 뒤에도 감독 무활동을 판정한다.
  const alerts = assessSupervisorIdle(
    entries,
    roleStates,
    now,
    30 * 60 * 1_000
  );

  // Then: 받은 편지는 감독 활동이 아니므로 동결 상신을 가리지 않는다.
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "놀고 있음");
  assert.equal(alerts[0].idleMinutes, 32);
});

test("감독이 실제로 지시하면 상신하지 않는다 — 거짓 '지시 없음' 금지(card-27 수리)", () => {
  // Given: 미완료 카드 뒤 감독 화면에서 작업자에게 실제 지시를 보냈다.
  const now = Date.parse("2026-08-31T12:32:00.000Z");
  const entries = [
    {
      t: "2026-08-31T12:00:00.000Z",
      kind: "send",
      role: "p-작업자",
      session: "kadan-p-작업자",
      taskId: "card-a",
    },
    {
      t: "2026-08-31T12:31:00.000Z",
      kind: "send",
      role: "p-작업자",
      session: "kadan-p-작업자",
    },
  ];
  const roleStates = assessRoles(
    new Map([
      [
        "kadan-p-감독",
        {
          role: "p-감독",
          alive: true,
          digest: "before-instruction",
          unchangedMs: 31 * 60 * 1_000,
        },
      ],
    ]),
    new Map([
      [
        "kadan-p-감독",
        {
          role: "p-감독",
          alive: true,
          digest: "after-instruction",
        },
      ],
    ]),
    60 * 1_000,
    60 * 1_000,
    999
  ).states;

  // When: 수신자 원장이 아니라 감독 화면 변화를 판정한다.
  const alerts = assessSupervisorIdle(
    entries,
    roleStates,
    now,
    30 * 60 * 1_000
  );

  // Then: 감독 자신의 화면 변화가 있었으므로 상신하지 않아야 한다.
  assert.deepEqual(alerts, []);
});

test("안 끝난 카드가 0장이면 조용한 감독은 정상이다(card-27)", () => {
  // Given: 카드 발령과 같은 카드의 완료가 모두 원장에 있다.
  const entries = [
    {
      t: "2026-08-31T12:00:00.000Z",
      kind: "send",
      role: "p-작업자",
      session: "kadan-p-작업자",
      taskId: "card-a",
    },
    {
      t: "2026-08-31T12:01:00.000Z",
      kind: "done",
      role: "p-작업자",
      session: "kadan-p-작업자",
      taskId: "card-a",
      result: "ok",
    },
  ];

  // When: 한 시간이 지나 조용한 감독을 판정한다.
  const alerts = assessSupervisorIdle(
    entries,
    new Map(),
    Date.parse("2026-08-31T13:00:00.000Z"),
    30 * 60 * 1_000
  );

  // Then: 할 일이 없으므로 이상이 아니다.
  assert.deepEqual(alerts, []);
});

test("원장을 못 읽으면 모름으로 올린다 — 조회 실패를 0장으로 읽지 않는다(card-27)", () => {
  // Given: 원장 읽기가 실패했다.
  const error = new Error("EACCES");

  // When: 실패 닫힘 판정을 만든다.
  const alerts = assessSupervisorIdle(
    null,
    new Map(),
    Date.parse("2026-08-31T13:00:00.000Z"),
    30 * 60 * 1_000,
    error
  );

  // Then: 조용으로 접지 않고 모름 하나를 슈퍼로 올린다.
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "모름");
  assert.equal(alerts[0].ledgerError, "EACCES");
  assert.equal(routeAlert(alerts[0], new Map(), new Set(), "슈퍼"), "슈퍼");

  const screenAlerts = assessSupervisorIdle(
    [
      {
        t: "2026-08-31T12:00:00.000Z",
        kind: "send",
        role: "p-작업자",
        session: "kadan-p-작업자",
        taskId: "card-a",
      },
    ],
    new Map(),
    Date.parse("2026-08-31T13:00:00.000Z"),
    30 * 60 * 1_000
  );
  assert.equal(screenAlerts.length, 1);
  assert.equal(screenAlerts[0].kind, "모름");
  assert.match(formatAlertBody(screenAlerts[0], {}), /화면 읽기 실패/u);
  assert.equal(
    routeAlert(screenAlerts[0], new Map(), new Set(), "슈퍼"),
    "슈퍼"
  );
});

test("상신은 감독 자신에게 가지 않는다 — card-26 감독 자기 신고", () => {
  // Given: 판 감독이 살아 있고 별도 route도 있다.
  const alert = {
    id: "idle:p",
    kind: "놀고 있음",
    role: "p-감독",
    session: "kadan-p-감독",
  };

  // When: 상신 수신자를 고른다.
  const recipient = routeAlert(
    alert,
    new Map([["p", "p-감독"]]),
    new Set(["kadan-p-감독", "kadan-슈퍼"]),
    "슈퍼"
  );

  // Then: 감독 자신이 아니라 슈퍼 한 곳이다.
  assert.equal(recipient, "슈퍼");
  assert.notEqual(recipient, "p-감독");
});

test("깨움은 이상할 때만 하지 않는다, 기본 30분 — 2026-08-09 감독 11시간 정지(card-27)", () => {
  // Given: 기본 30분 주기와 정상·이상 두 상태가 있다.
  const everyMs = 30 * 60 * 1_000;
  const dueAt = Date.parse("2026-08-31T12:30:00.000Z");
  const lastWakeAt = Date.parse("2026-08-31T12:00:00.000Z");

  // When: 상태와 무관하게 주기만 판정한다.
  const normalDue = wakeDue("p-감독", lastWakeAt, dueAt, everyMs);
  const abnormalDue = wakeDue("p-감독", lastWakeAt, dueAt, everyMs);
  const disabled = wakeDue(null, lastWakeAt, dueAt, everyMs);

  // Then: 정상·이상 모두 깨우고 --wake가 없으면 0건이며 정상은 침묵하라는 문구로 끝난다.
  assert.equal(normalDue, true);
  assert.equal(abnormalDue, true);
  assert.equal(disabled, false);
  assert.equal(wakeDue("p-감독", lastWakeAt, dueAt - 1, everyMs), false);
  assert.ok(
    buildWakeMessage().endsWith("이상 없으면 보고하지 말고 계속하라.")
  );
});

test("판정과 알림은 별개 고리 — 같은 이상은 해소 전 재전송하지 않는다(2026-08-07)(card-23)", () => {
  const stall = {
    id: "stall:kadan-w1-작업자",
    kind: "정체",
    level: "AMBER",
    session: "kadan-w1-작업자",
  };

  const repeated = dedupAlerts([stall], [{ ...stall }]);
  assert.deepEqual(repeated.notify, []);
  assert.deepEqual(repeated.resolved, []);

  const changed = dedupAlerts([stall], [{ ...stall, level: "RED" }]);
  assert.deepEqual(changed.notify, [{ ...stall, level: "RED" }]);

  const cleared = dedupAlerts([stall], []);
  assert.deepEqual(cleared.resolved, [stall]);
});

test("과거 자원 경고는 해소 우편·알림 기록을 새로 만들지 않는다", () => {
 for (const level of ["RED", "AMBER"]) for (const recipient of ["슈퍼감독", "@user"]) {
  const sent = [];
  const printed = [];
  const records = [];
  const recipients = new Map([["resource", recipient]]);

  const delivered = deliverResolution({
    alert: { id: "resource", kind: "자원", level },
    recipients,
    cycleAt: Date.parse("2026-09-01T05:30:00.000Z"),
    sendAlert: (role, message) => sent.push({ role, message }),
    print: (line) => printed.push(line),
    record: (entry) => records.push(entry),
  });

  assert.equal(delivered, null);
  assert.equal(recipients.size, 0);
  assert.deepEqual(sent, []);
  assert.deepEqual(printed, []);
  assert.deepEqual(records, []);
 }
});

test("해소는 이상을 받은 그 역할에게만 간다 — 두 사람이 다른 그림을 갖지 않는다(2026-07-23)(card-34)", () => {
  const sent = [];
  const recipients = new Map([["stall:kadan-p-작업자", "p-감독"]]);

  deliverResolution({
    alert: {
      id: "stall:kadan-p-작업자",
      kind: "정체",
      session: "kadan-p-작업자",
    },
    recipients,
    cycleAt: Date.parse("2026-09-01T05:31:00.000Z"),
    sendAlert: (role) => sent.push(role),
    print: () => null,
  });

  assert.deepEqual(sent, ["p-감독"]);
  assert.equal(recipients.size, 0);
});

test("자원 이상은 연속 3주기 정상이어야 해소한다 — 경계 깜빡임 차단(card-34)", () => {
  let assessment = assessResources(
    { swapHistory: [] },
    { memory: "normal", swapUsed: 0, load5: 13 },
    12
  );
  assert.equal(assessment.alerts.length, 1);

  for (const expectedNormalCycles of [1, 2]) {
    assessment = assessResources(
      assessment.state,
      { memory: "normal", swapUsed: 0, load5: 1 },
      12
    );
    assert.equal(assessment.state.normalCycles, expectedNormalCycles);
    assert.equal(assessment.alerts.length, 1);
  }

  assessment = assessResources(
    assessment.state,
    { memory: "normal", swapUsed: 0, load5: 1 },
    12
  );
  assert.equal(assessment.state.normalCycles, 3);
  assert.deepEqual(assessment.alerts, []);
});

test("해소는 이상당 한 번만 보낸다 — 해소 폭주 금지(card-34)", () => {
  const sent = [];
  const id = "stall:kadan-p-작업자";
  const recipients = new Map([[id, "슈퍼감독"]]);
  const input = {
    alert: { id, kind: "정체", session: "kadan-p-작업자" },
    recipients,
    cycleAt: Date.parse("2026-09-01T05:32:00.000Z"),
    sendAlert: (role) => sent.push(role),
    print: () => null,
  };

  deliverResolution(input);
  deliverResolution(input);

  assert.deepEqual(sent, ["슈퍼감독"]);
  assert.equal(recipients.size, 0);

  const failedRecipients = new Map([[id, "죽은-감독"]]);
  let failedAttempts = 0;
  const failedInput = {
    ...input,
    recipients: failedRecipients,
    sendAlert: () => {
      failedAttempts += 1;
      throw new Error("세션 없음");
    },
  };
  deliverResolution(failedInput);
  deliverResolution(failedInput);
  assert.equal(failedAttempts, 1);
  assert.equal(failedRecipients.size, 0);
});

test("죽음은 살았다가 없어진 것 — 처음부터 없던 세션은 이상이 아니다(card-23)", () => {
  const missing = new Map([
    [
      "kadan-w1-작업자",
      {
        role: "w1-작업자",
        alive: false,
        pid: null,
        expectedPid: "111",
        digest: null,
      },
    ],
  ]);
  const firstObservation = assessRoles(new Map(), missing, 1_000, 1_000, 2);
  assert.deepEqual(firstObservation.alerts, []);

  const alive = new Map([
    [
      "kadan-w1-작업자",
      {
        role: "w1-작업자",
        alive: true,
        pid: "111",
        digest: "before",
        stallCount: 0,
      },
    ],
  ]);
  const died = assessRoles(alive, missing, 1_000, 1_000, 2);
  assert.equal(died.alerts[0].kind, "죽음");

  const replaced = new Map([
    [
      "kadan-w1-작업자",
      {
        role: "w1-작업자",
        alive: true,
        pid: "222",
        expectedPid: "111",
        digest: "after",
      },
    ],
  ]);
  const pidMismatch = assessRoles(alive, replaced, 1_000, 1_000, 2);
  assert.equal(pidMismatch.alerts[0].kind, "죽음");
});

test("이상 1건은 수신자 정확히 1명 — 두 지휘자 이중 개입 차단(2026-07-23)(card-23)", () => {
  const alert = {
    id: "stall:kadan-w1-작업자",
    kind: "정체",
    level: "AMBER",
    role: "w1-작업자",
    session: "kadan-w1-작업자",
  };
  const live = new Set(["kadan-w1-감독", "kadan-슈퍼"]);

  assert.equal(
    routeAlert(alert, new Map([["w1", "w1-지휘자"]]), live, "슈퍼"),
    "w1-지휘자"
  );
  assert.equal(routeAlert(alert, new Map(), live, "슈퍼"), "w1-감독");
  assert.equal(routeAlert(alert, new Map(), new Set(["kadan-슈퍼"]), "슈퍼"), "슈퍼");
  assert.equal(routeAlert(alert, new Map(), new Set(), null), null);
  assert.equal(
    routeAlert(
      { id: "resource", kind: "자원", level: "AMBER" },
      new Map([["w1", "w1-지휘자"]]),
      live,
      "슈퍼"
    ),
    "슈퍼"
  );
});

test("판·역할·카드 구성이 원장만으로 그려진다 — kyle 2026-08-30 '구성이 눈에 들어오면 좋겠어'(card-21)", () => {
  const entries = [
    { t: "2026-08-30T20:00:00.000Z", kind: "start", role: "c15-작업자", session: "kadan-c15-작업자", panePid: "111", window: "rottie" },
    { t: "2026-08-30T20:01:00.000Z", kind: "send", role: "c15-작업자", session: "kadan-c15-작업자", taskId: "card-15-1" },
    { t: "2026-08-30T20:55:00.000Z", kind: "done", role: "c15-작업자", session: "kadan-c15-작업자", taskId: "card-15-1", result: "ok" },
    { t: "2026-08-30T21:00:00.000Z", kind: "send", role: "c15-작업자", session: "kadan-c15-작업자", taskId: "card-x" },
    { t: "2026-08-30T21:01:00.000Z", kind: "send", role: "c15-작업자", session: "kadan-c15-작업자" },
    { t: "2026-08-30T20:00:00.000Z", kind: "start", role: "c15-검수자", session: "kadan-c15-검수자", panePid: "222" },
    { t: "2026-08-30T20:59:00.000Z", kind: "done", role: "c15-검수자", session: "kadan-c15-검수자", taskId: "card-15-1-review", result: "failed" },
    { t: "2026-08-30T22:00:00.000Z", kind: "stop", role: "c15-검수자", session: "kadan-c15-검수자" },
    { t: "2026-08-30T23:00:00.000Z", kind: "start", role: "rt-worker11", session: "kadan-rt-worker11", panePid: "333" },
  ];
  const tree = buildTree(entries, {
    "kadan-c15-작업자": { session: "kadan-c15-작업자", alive: true, pid: "111" },
    "kadan-rt-worker11": { session: "kadan-rt-worker11", alive: true, pid: "999" },
  });

  assert.equal(tree.length, 2);
  assert.deepEqual(tree.map((board) => board.name), ["c15", "rt"]);
  assert.equal(tree[0].roles.length, 2);
  assert.deepEqual(tree[0].roles[0].life, {
    state: "alive",
    pidState: "match",
    recordedPid: "111",
    currentPid: "111",
  });
  assert.equal(tree[0].roles[0].window, "rottie");
  assert.equal(tree[0].roles[0].untrackedSends, 1);
  assert.deepEqual(tree[0].roles[0].cards, [
    { taskId: "card-15-1", state: "done", result: "ok", at: "2026-08-30T20:55:00.000Z", by: "모름" },
    { taskId: "card-x", state: "sent", at: "2026-08-30T21:00:00.000Z", by: "모름" },
  ]);
  assert.deepEqual(tree[0].roles[1].life, {
    state: "dead",
    stoppedAt: "2026-08-30T22:00:00.000Z",
  });
  assert.equal(tree[0].roles[1].cards[0].result, "failed");
  assert.equal(tree[1].roles[0].life.pidState, "changed");
});

test("send --task는 taskId를 원장에 남기고 옵션이 없으면 예전 send 형식을 지킨다", () => {
  const records = [];
  const fakeFloor = {
    name: "fake",
    alive: () => true,
    pid: () => "111",
    send: () => null,
  };

  guardedSend({
    floor: fakeFloor,
    session: "kadan-c21",
    role: "c21",
    message: "카드 발령",
    taskId: "card-21-demo",
    recordedPid: "111",
    record: (entry) => records.push(entry),
    readEntries: () => [
      { kind: "start", role: "c21", session: "kadan-c21", panePid: "111", cmd: "codex --model test-model" },
    ],
  });
  guardedSend({
    floor: fakeFloor,
    session: "kadan-c21",
    role: "c21",
    message: "무표 발령",
    recordedPid: "111",
    record: (entry) => records.push(entry),
  });

  assert.equal(records[0].taskId, "card-21-demo");
  assert.equal(Object.hasOwn(records[1], "taskId"), false);
  assert.throws(
    () =>
      guardedSend({
        floor: fakeFloor,
        session: "kadan-c21",
        role: "c21",
        message: "잘못된 카드",
        taskId: "card 21",
        recordedPid: "111",
        record: () => assert.fail("공백 taskId는 원장에 남기면 안 된다"),
      }),
    /taskId/
  );
});

test("완료는 원장에 남아야 화면에 보인다 — wait를 안 걸면 done이 영영 안 찍혔다(2026-09-01)(card-35)", () => {
  const records = [];
  const entry = confirmDone({
    entries: [
      {
        kind: "start",
        floor: "tmux",
        role: "c35-작업자",
        session: "kadan-c35-작업자",
      },
    ],
    role: "c35-작업자",
    taskId: "card-35-work",
    result: "ok",
    env: { KADAN_ROLE: "c35-감독" },
    record: (value) => records.push(value),
  });

  assert.deepEqual(records, [entry]);
  assert.deepEqual(entry, {
    kind: "done",
    floor: "tmux",
    role: "c35-작업자",
    session: "kadan-c35-작업자",
    by: "c35-감독",
    taskId: "card-35-work",
    result: "ok",
  });
});

test("kadan done은 기록기이지 판정기가 아니다 — 화면을 읽어 자동 확정하지 않는다(2026-08-30 에코)(card-35)", () => {
  let readCount = 0;
  const records = [];
  confirmDone({
    entries: [
      {
        kind: "start",
        floor: "tmux",
        role: "c35-종료된작업자",
        session: "kadan-c35-종료된작업자",
      },
    ],
    role: "c35-종료된작업자",
    taskId: "card-35-stopped",
    result: "failed",
    env: {},
    record: (value) => records.push(value),
    floor: {
      alive: () => false,
      read: () => {
        readCount++;
        return "KADAN:DONE card-35-stopped failed";
      },
    },
  });

  assert.equal(readCount, 0);
  assert.equal(records[0].result, "failed");
  assert.equal(records[0].by, "사람");
});

test("같은 역할·카드에 두 번 확정하지 않는다(card-35)", () => {
  assert.throws(
    () =>
      confirmDone({
        entries: [
          {
            kind: "start",
            role: "c35-작업자",
            session: "kadan-c35-작업자",
          },
          {
            kind: "done",
            role: "c35-작업자",
            taskId: "card-35-work",
            result: "ok",
          },
        ],
        role: "c35-작업자",
        taskId: "card-35-work",
        result: "ok",
        record: () => assert.fail("중복 done은 원장에 남기면 안 된다"),
      }),
    (error) => error.exitCode === 2 && /이미 완료 확정/.test(error.message)
  );
});

test("역할 이름이 정확히 같아야 확정한다 — 세션 이름이 같은 다른 역할을 확정했다(card-35r)", () => {
  assert.throws(
    () =>
      confirmDone({
        entries: [
          {
            kind: "start",
            role: "review35-worker",
            session: "kadan-review35-worker",
          },
        ],
        role: "review35 worker",
        taskId: "card-alias-collision",
        result: "ok",
        record: () => assert.fail("정확한 역할 start가 없으면 done을 남기면 안 된다"),
      }),
    (error) => error.exitCode === 2 && /시작 기록 없음/.test(error.message)
  );
});

test("동시에 확정해도 같은 역할·카드는 하나로 읽는다 — 20개 동시 실행에서 2개가 통과했다(card-35r)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-lite-done-race-"));
  appendLedger(
    {
      kind: "start",
      floor: "tmux",
      role: "review35-race",
      session: "kadan-review35-race",
    },
    home
  );
  const cli = path.resolve("src/cli.mjs");
  const runs = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [cli, "done", "review35-race", "card-race", "ok"],
          {
            cwd: path.resolve("."),
            env: {
              ...process.env,
              KADAN_HOME: home,
              KADAN_ROLE: `race-reviewer-${index}`,
              KADAN_WINDOW: "none",
            },
            stdio: ["ignore", "pipe", "pipe"],
          }
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      })
    )
  );

  const successes = runs.filter((run) => run.code === 0).length;
  const firstDone = fs
    .readFileSync(path.join(home, "tasks", "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find(
      (entry) =>
        entry.kind === "done" &&
        entry.role === "review35-race" &&
        entry.taskId === "card-race"
    );
  assert.ok(successes >= 1);
  assert.ok(firstDone);
  appendLedger(
    {
      kind: "done",
      role: firstDone.role,
      session: firstDone.session,
      by: "늦게 쓴 중복",
      taskId: firstDone.taskId,
      result: "failed",
    },
    home
  );
  const rawDoneLines = fs
    .readFileSync(path.join(home, "tasks", "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter(
      (entry) =>
        entry.kind === "done" &&
        entry.role === "review35-race" &&
        entry.taskId === "card-race"
    );
  assert.equal(rawDoneLines.length, successes + 1);
  assert.deepEqual(rawDoneLines[0], firstDone);
  assert.equal(rawDoneLines.at(-1).result, "failed");
  assert.equal(rawDoneLines.at(-1).by, "늦게 쓴 중복");
  assert.equal(
    readLedger(home).filter(
      (entry) =>
        entry.kind === "done" &&
        entry.role === "review35-race" &&
        entry.taskId === "card-race"
    ).length,
    1
  );
  assert.equal(
    readLedger(home).find(
      (entry) =>
        entry.kind === "done" &&
        entry.role === "review35-race" &&
        entry.taskId === "card-race"
    ).result,
    "ok"
  );
});

test("renderTree는 살아있음·죽음·PID변경을 사람이 한눈에 구분하게 찍는다", () => {
  const output = renderTree([
    {
      name: "c21",
      roles: [
        {
          role: "c21-작업자",
          session: "kadan-c21-작업자",
          window: "rottie",
          untrackedSends: 1,
          life: { state: "alive", pidState: "match", recordedPid: "111", currentPid: "111" },
          cards: [{ taskId: "card-ok", state: "done", result: "ok", at: "2026-08-30T20:55:00.000Z" }],
        },
        {
          role: "c21-검수자",
          session: "kadan-c21-검수자",
          window: null,
          untrackedSends: 0,
          life: { state: "dead", stoppedAt: "2026-08-30T20:00:00.000Z" },
          cards: [{ taskId: "card-review", state: "sent", at: "2026-08-30T14:03:00.000Z" }],
        },
        {
          role: "c21-작업자-2",
          session: "kadan-c21-작업자-2",
          window: null,
          untrackedSends: 0,
          life: { state: "alive", pidState: "changed", recordedPid: "333", currentPid: "999" },
          cards: [],
        },
      ],
    },
  ]);

  assert.match(output, /^판 c21/m);
  assert.match(output, /역할 c21-작업자\s+살아있음 PID일치\s+창 rottie\s+무표 send 1건/);
  assert.match(output, /card-ok\s+← 모름\s+done ok \(05:55\)/);
  assert.match(output, /역할 c21-검수자\s+죽음\(stop 05:00\)/);
  assert.match(output, /card-review\s+← 모름\s+보냄 23:03 \(완료 없음\)/);
  assert.match(output, /역할 c21-작업자-2\s+살아있음 PID변경\(333→999\)/);
});

test("관제 화면은 수집 시각을 항상 표시하고 못 읽음은 모름으로 — 2026-08-10 board-dashboard 교훈(card-22)", () => {
  const html = renderWallHtml({
    tree: [
      {
        name: "c22",
        roles: [
          {
            role: "c22-작업자",
            session: "kadan-c22-작업자",
            window: "rottie",
            lastActivityAt: "2026-08-30T20:55:00.000Z",
            life: { state: "alive", pidState: "match" },
            cards: [
              { taskId: "card-ok", state: "done", result: "ok", at: "2026-08-30T20:55:00.000Z" },
              { taskId: "card-failed", state: "done", result: "failed", at: "2026-08-30T20:56:00.000Z" },
              { taskId: "card-sent", state: "sent", at: "2026-08-30T20:57:00.000Z" },
            ],
            waitSnapshot: {
              fileName: "kadan-c22-작업자.wait-2026-08-31T01-02-03.000Z.txt",
              tail: "첫째\n둘째\n셋째",
            },
          },
        ],
      },
    ],
    collectedAt: new Date("2026-08-31T00:00:00.000Z"),
    ledgerPath: "/tmp/kadan/ledger.jsonl",
    ledgerLines: 7,
    error: null,
  });

  // 새로고침은 meta가 아니라 reload다 — meta는 #탭을 버려 항상 개요로 돌아갔다 (2026-09-06).
  assert.match(html, /setTimeout\(\(\)=>location\.reload\(\),10000\)/);
  assert.doesNotMatch(html, /http-equiv="refresh"/);
  assert.match(html, /수집 시각\(로컬\)/);
  assert.match(html, /2026\. 08\. 31\. 09:00:00/);
  assert.match(html, /\/tmp\/kadan\/ledger\.jsonl/);
  assert.match(html, /7줄/);
  assert.match(html, /판 c22/);
  assert.match(html, /c22-작업자/);
  assert.match(html, /살아있음/);
  assert.match(html, /card-ok/);
  assert.match(html, /완료 ok/);
  assert.match(html, /완료 failed/);
  assert.match(html, /보냄\(완료 없음\)/);
  assert.match(html, /05:55/);
  assert.match(html, /kadan-c22-작업자\.wait-2026-08-31T01-02-03\.000Z\.txt/);
  assert.match(html, /첫째\n둘째\n셋째/);
});

test("역할 표는 한 줄에 상태·창·마지막 활동·안 끝난 카드를 담는다 — 박스 그리드는 훑을 수 없었다(card-47)", () => {
  const html = renderWallHtml({
    tree: [
      {
        name: "c47",
        roles: [
          {
            role: "c47-작업자",
            session: "kadan-c47-작업자",
            window: "orca",
            lastActivityAt: "2026-09-05T02:10:00.000Z",
            life: { state: "alive", pidState: "match" },
            cards: [
              { taskId: "card-47-a", state: "sent", at: "2026-09-05T02:09:00.000Z" },
              { taskId: "card-47-b", state: "done", result: "ok", at: "2026-09-05T02:10:00.000Z" },
            ],
            waitSnapshot: { fileName: "kadan-c47.wait.txt", tail: "대기 화면" },
          },
        ],
      },
    ],
    mailbox: [],
    collectedAt: new Date("2026-09-05T03:00:00.000Z"),
    ledgerPath: "/tmp/kadan/ledger.jsonl",
    ledgerLines: 4,
    error: null,
  });

  assert.match(html, /<table class="role-table">/);
  assert.match(html, /<th>역할<\/th>\s*<th>상태<\/th>\s*<th>창<\/th>\s*<th>마지막 활동<\/th>\s*<th>안 끝난 카드<\/th>\s*<th>실행기 · 모델 · 계열<\/th>/);
  assert.match(html, /<tr>\s*<td class="role-name">c47-작업자<\/td>\s*<td><span class="dot alive"[^>]*><\/span><span class="state alive">살아있음<\/span><\/td>\s*<td>orca<\/td>\s*<td><time title="[^"]+">09-05 11:10<\/time><\/td>/);
  assert.match(html, /<summary>1장 · card-47-a<\/summary>/);
  assert.match(html, /card-47-b/);
  assert.match(html, /kadan-c47\.wait\.txt/);
});

test("우편함은 보낸이(by)와 받는이(role)를 구분한다 — send의 role은 받는 사람이다(2026-08-31 card-28)", () => {
  const entries = Array.from({ length: 21 }, (_, index) => ({
    t: `2026-09-05T02:${String(index).padStart(2, "0")}:00.000Z`,
    kind: "send",
    by: index === 20 ? "c47-감독" : undefined,
    role: index === 20 ? "c47-작업자" : `c47-받는이-${index}`,
    taskId: index === 20 ? "card-47" : undefined,
    bytes: index === 20 ? 123 : index,
  }));
  const mailbox = recentSends([
    { kind: "start", role: "c47-감독" },
    ...entries,
  ]);
  const html = renderWallHtml({
    tree: [],
    mailbox,
    collectedAt: new Date("2026-09-05T03:00:00.000Z"),
    ledgerPath: "/tmp/kadan/ledger.jsonl",
    ledgerLines: 22,
    error: null,
    all: true,
  });

  assert.equal(mailbox.length, 20);
  assert.equal(mailbox[0].role, "c47-작업자");
  assert.equal(mailbox.at(-1).role, "c47-받는이-1");
  assert.match(html, /<th>시각<\/th>\s*<th>보낸이<\/th>\s*<th>받는이<\/th>\s*<th>카드<\/th>\s*<th>크기<\/th>/);
  assert.match(html, /<td><time title="[^"]+">09-05 11:20<\/time><\/td>\s*<td>c47-감독<\/td>\s*<td>c47-작업자<\/td>\s*<td>card-47<div class="about">전달 기록 · 읽음 모름<\/div><\/td>\s*<td>123바이트<\/td>/);
  assert.match(html, /<td>모름<\/td>\s*<td>c47-받는이-1<\/td>\s*<td>-<div class="about">전달 기록 · 읽음 모름<\/div><\/td>\s*<td>1바이트<\/td>/);
  assert.doesNotMatch(html, /c47-받는이-0/);
});

test("원장을 못 읽으면 역할 표와 우편함도 모름이다 — 같은 화면에서 모름과 0을 함께 말했다(card-35r)", () => {
  const html = renderWallHtml({
    tree: [
      {
        name: "c47",
        roles: [
          {
            role: "c47-작업자",
            session: "kadan-c47-작업자",
            window: null,
            lastActivityAt: null,
            life: { state: "alive", pidState: "changed" },
            cards: [],
          },
        ],
      },
    ],
    mailbox: null,
    collectedAt: new Date("2026-09-05T03:00:00.000Z"),
    ledgerPath: "/읽기-실패/ledger.jsonl",
    ledgerLines: null,
    error: "원장 못 읽음(0개가 아니라 모름): EACCES",
  });

  assert.match(html, /살아있는 역할 모름 · 도는 판 모름 · 안 끝난 카드 모름/);
  assert.match(html, /<tbody class="mailbox-unknown">\s*<tr><td colspan="5">모름<\/td><\/tr>/);
  assert.match(html, /<tbody class="role-unknown">\s*<tr><td colspan="6">모름<\/td><\/tr>/);
  assert.doesNotMatch(html, />0개|>0장|>0줄/);
});

test("원장을 못 읽으면 요약도 모름이다 — 같은 화면에서 모름과 0을 함께 말했다(card-35r)", () => {
  const html = renderWallHtml({
    tree: [],
    collectedAt: new Date("2026-08-31T00:00:00.000Z"),
    ledgerPath: "/읽기-실패/ledger.jsonl",
    ledgerLines: null,
    error: "원장 못 읽음(0개가 아니라 모름): EACCES",
  });

  assert.match(html, /class="collection-error"/);
  assert.match(html, /원장 못 읽음\(0개가 아니라 모름\): EACCES/);
  assert.doesNotMatch(html, />0줄</);
  assert.match(html, /살아있는 역할 모름 · 도는 판 모름 · 안 끝난 카드 모름/);
  assert.doesNotMatch(html, /살아있는 역할 0개 · 도는 판 0개 · 안 끝난 카드 0장/);
});

test("wall 서버는 127.0.0.1의 임시 포트에서 HTML 한 장만 200으로 돌려준다", async (t) => {
  const server = createWallServer(() => ({
    tree: [{ name: "server-test", roles: [] }],
    collectedAt: new Date("2026-08-31T00:00:00.000Z"),
    ledgerPath: "/tmp/kadan/ledger.jsonl",
    ledgerLines: 1,
    error: null,
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const address = server.address();
  assert.equal(address.address, "127.0.0.1");
  const response = await fetch(`http://127.0.0.1:${address.port}/?all=1`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /판 server-test/);
});

test("화면 기본은 지금 도는 판만 — 죽은 것 85%가 살아있는 것을 덮었다(2026-09-01 실측)(card-35)", async (t) => {
  const server = createWallServer(() => ({
    tree: [
      {
        name: "산판",
        roles: [
          {
            role: "산판-작업자",
            session: "kadan-산판-작업자",
            lastActivityAt: "2026-08-29T00:00:00.000Z",
            life: { state: "alive", pidState: "match" },
            cards: [
              {
                taskId: "아직-하는-카드",
                state: "sent",
                at: "2026-08-29T00:00:00.000Z",
              },
            ],
          },
        ],
      },
      {
        name: "최근판",
        roles: [
          {
            role: "최근판-작업자",
            session: "kadan-최근판-작업자",
            lastActivityAt: "2026-09-01T02:30:00.000Z",
            life: { state: "dead" },
            cards: [],
          },
        ],
      },
      {
        name: "죽은옛판",
        roles: [
          {
            role: "죽은옛판-작업자",
            session: "kadan-죽은옛판-작업자",
            lastActivityAt: "2026-08-30T00:00:00.000Z",
            life: { state: "dead" },
            cards: [],
          },
        ],
      },
    ],
    collectedAt: new Date("2026-09-01T03:00:00.000Z"),
    ledgerPath: "/tmp/kadan/ledger.jsonl",
    ledgerLines: 3,
    error: null,
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const address = server.address();
  const basic = await (
    await fetch(`http://127.0.0.1:${address.port}/`)
  ).text();
  const all = await (
    await fetch(`http://127.0.0.1:${address.port}/?all=1`)
  ).text();

  assert.match(basic, /판 산판/);
  assert.match(basic, /판 최근판/);
  assert.doesNotMatch(basic, /판 죽은옛판/);
  assert.match(all, /판 죽은옛판/);
  assert.match(basic, /살아있는 역할 1개 · 도는 판 2개 · 안 끝난 카드 1장/);
});

test("판은 마지막 활동 내림차순 — 지금 도는 판이 맨 위다(card-35)", () => {
  const html = renderWallHtml({
    tree: [
      {
        name: "어제판",
        roles: [
          {
            role: "어제판-작업자",
            session: "kadan-어제판-작업자",
            lastActivityAt: "2026-08-31T01:00:00.000Z",
            life: { state: "alive", pidState: "match" },
            cards: [
              {
                taskId: "어제카드",
                state: "sent",
                at: "2026-08-31T01:00:00.000Z",
              },
            ],
          },
        ],
      },
      {
        name: "오늘판",
        roles: [
          {
            role: "오늘판-작업자",
            session: "kadan-오늘판-작업자",
            lastActivityAt: "2026-09-01T02:30:00.000Z",
            life: { state: "alive", pidState: "match" },
            cards: [
              {
                taskId: "오늘카드",
                state: "sent",
                at: "2026-09-01T02:30:00.000Z",
              },
            ],
          },
        ],
      },
    ],
    collectedAt: new Date("2026-09-01T03:00:00.000Z"),
    ledgerPath: "/tmp/kadan/ledger.jsonl",
    ledgerLines: 2,
    error: null,
  });

  assert.ok(html.indexOf("판 오늘판") < html.indexOf("판 어제판"));
  assert.match(html, /오늘카드[\s\S]*<time title="[^"]+">09-01 11:30<\/time>/);
  assert.match(html, /어제카드[\s\S]*<time title="[^"]+">08-31 10:00<\/time>/);
});

test("플래그 값은 다음 스위치를 삼키지 않고 값 없는 스위치는 true가 된다", () => {
  assert.deepEqual(parseFlags(["--cmd", "codex", "--hidden"]), {
    flags: { cmd: "codex", hidden: true },
    rest: [],
  });
  assert.deepEqual(parseFlags(["--wait", "--timeout", "300"]), {
    flags: { wait: true, timeout: "300" },
    rest: [],
  });
  assert.deepEqual(parseFlags(["--hidden"]), {
    flags: { hidden: true },
    rest: [],
  });
});

test("세션 이름은 kadan- 접두사와 공백·콜론·점 치환 규칙을 따른다", () => {
  assert.equal(sessionName("작업자-A"), "kadan-작업자-A");
  assert.equal(sessionName("  일반 감독  "), "kadan-일반-감독");
  assert.equal(sessionName("a.b:c"), "kadan-a-b-c");
});

test("세션 이름은 다양한 유니코드를 보존하고 연속 구분자를 하이픈으로 바꾼다", () => {
  assert.equal(sessionName("작업자-α"), "kadan-작업자-α");
  assert.equal(sessionName("🚀-1"), "kadan-🚀-1");
  assert.equal(sessionName("a...b:::c"), "kadan-a-b-c");
  assert.equal(sessionName("\t  일반\t감독  \t"), "kadan-일반-감독");
});

test("세션 이름은 셸·AppleScript에 넣어도 안전한 문자만 남긴다 — 역할 이름이 sh -lc와 osascript 문자열에 그대로 들어간다(2026-08-30 card-13 검수)", () => {
  assert.equal(sessionName("작업자;echo pwned"), "kadan-작업자-echo-pwned"); // ;와 공백이 명령 구분자가 되지 않는다
  assert.equal(sessionName('a"b$c\'d'), "kadan-a-b-c-d"); // 따옴표·달러가 AppleScript/shell을 깨지 않는다
  assert.equal(sessionName("x`y|z"), "kadan-x-y-z"); // 백틱·파이프가 명령 치환이 되지 않는다
  assert.equal(sessionName("🚀-1"), "kadan-🚀-1"); // 화이트리스트 안의 그림 문자는 보존된다
});

test("전달 지문은 같은 문자열에 안정적이고 12자로 서로를 구별한다", () => {
  const first = digest("같은 메시지");
  const repeated = digest("같은 메시지");
  const different = digest("다른 메시지");

  assert.equal(first, repeated);
  assert.notEqual(first, different);
  assert.equal(first.length, 12);
  assert.equal(different.length, 12);
});

test("ANSI 제거가 OSC·CSI·리드로우 노이즈를 걷어낸다", () => {
  const noisy = "\x1b]0;제목\x07작업중…\x1b[2K\r\x1b[32m완료\x1b[0m KADAN:DONE card-1 ok";
  const clean = stripAnsi(noisy);
  assert.ok(clean.includes("KADAN:DONE card-1 ok"));
  assert.ok(!clean.includes("\x1b"));
});

test("감독이 사람 눈 없이 발령 전 화면을 판정한다 — card-15 실측에서 깨진 창을 확인했다고 적었다(2026-08-30 검수): 마지막 N줄과 짧은 전체 출력", () => {
  assert.equal(tailLines("첫째\n둘째\n셋째\n넷째", 2), "셋째\n넷째");
  assert.equal(tailLines("첫째\n둘째", 5), "첫째\n둘째");
  assert.equal(tailLines("첫째\n둘째\n프롬프트\n\n\n", 2), "둘째\n프롬프트");
});

test("DONE 마커는 한 줄짜리 ok|failed 형식만 인정한다", () => {
  const markers = findDoneMarkers("KADAN:DONE card-1 ok\n에코 KADAN:DONE card-1 ok\nKADAN:DONE card-2 failed");
  assert.equal(markers.length, 2);
  assert.deepEqual(markers[0], { taskId: "card-1", result: "ok" });
  assert.deepEqual(markers[1], { taskId: "card-2", result: "failed" });
  assert.deepEqual(findDoneMarkers("KADAN:DONE card-1 대충"), []);
});

test("기준선에 있던 같은 마커가 응답으로 한 번 더 나오면 새 완료로 센다", () => {
  const baseline = [{ taskId: "card-2", result: "ok" }];
  const current = [...baseline, { taskId: "card-2", result: "ok" }];
  assert.deepEqual(diffDoneMarkers(baseline, current), [{ taskId: "card-2", result: "ok" }]);
  assert.deepEqual(diffDoneMarkers(baseline, baseline), []);
  assert.deepEqual(diffDoneMarkers([], current), current);
});

test("원장은 append-only로 쌓이고 순서대로 읽힌다", () => {
  appendLedger({ kind: "start", role: "작업자", session: "kadan-작업자", panePid: "123", window: "hidden" });
  appendLedger({ kind: "send", role: "작업자", session: "kadan-작업자", bytes: 5, digest: "abc" });
  const rows = readLedger();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, "start");
  assert.equal(rows[1].digest, "abc");
  assert.ok(rows.every((r) => typeof r.t === "string"));
  appendLedger({ kind: "plan", board: "시험판", taskId: "order" });
  const streams = [
    { domain: "system", kinds: ["start", "stop"], order: [1, 4] },
    { domain: "mail", kinds: ["send", "mail-read"], order: [2, 5] },
    { domain: "tasks", kinds: ["plan", "done"], order: [3, 6] },
  ];
  const rawStream = domain => fs.readFileSync(path.join(process.env.KADAN_HOME, domain, "events.jsonl"), "utf8");
  const before = streams.map(({ domain }) => rawStream(domain));
  appendLedger({ kind: "stop", role: "작업자", session: "kadan-작업자" });
  appendLedger({ kind: "mail-read", role: "작업자", mailId: rows[1].mailId });
  appendLedger({ kind: "done", role: "작업자", taskId: "order", result: "ok" });
  for (const [index, { domain, kinds, order }] of streams.entries()) {
    const raw = rawStream(domain);
    assert.equal(raw.startsWith(before[index]), true, `${domain}: 기존 원문 보존`);
    assert.equal(raw.endsWith("\n"), true);
    const events = raw.trimEnd().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(events.map(entry => entry.kind), kinds);
    assert.deepEqual(events.map(entry => entry._ledgerOrder), order);
  }
  assert.deepEqual(readLedger().map(entry => entry.kind), ["start", "send", "plan", "stop", "mail-read", "done"]);
});

test("원장의 깨진 JSON 줄은 원본을 broken 속성으로 보존한다", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-lite-broken-ledger-test-"));
  const file = path.join(home, "ledger.jsonl");
  await fs.promises.appendFile(file, '{"kind":"start"}\n');
  await fs.promises.appendFile(file, "not-json\n");

  const rows = readLedger(home);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, "start");
  assert.equal(rows[1].broken, "not-json");
});

test("Rottie create argv는 한글·이모지·공백 경로를 요소에 그대로 보존한다 — 셸 인용으로 잇지 않는다(2026-08-30 card-13)", () => {
  const argv = buildRottieCreateArgv({
    role: "작업자-🚀 α",
    session: "kadan-작업자-🚀-α",
    cwd: "/home/te ster/Dev kadan lite",
    socket: "kadan",
    panePid: "12345",
  });
  assert.equal(argv[0], "terminal");
  assert.equal(argv[1], "create");
  assert.equal(argv[3], "/home/te ster/Dev kadan lite"); // 공백 있는 경로가 하나의 요소로 유지됨
  assert.equal(argv[5], "작업자-🚀 α"); // 제목은 역할 원문 그대로
  assert.equal(argv[7], "tmux -L kadan attach -t kadan-작업자-🚀-α");
  assert.equal(argv[9], "kadan-kadan-작업자-🚀-α-12345"); // 멱등 키 = 세션+PID
  assert.equal(argv[10], "--json");
  assert.ok(argv.every((a) => typeof a === "string"));
});

test("Rottie create 응답 판정은 성공·앱 꺼짐·워크스페이스 안 열림·깨진 JSON을 구별한다(2026-08-30 card-13)", () => {
  const ok = parseRottieCreateResult(
    JSON.stringify({
      schemaVersion: 1,
      ok: true,
      command: "terminal create",
      result: { terminal: { id: "t-1", workspaceId: "w-1", state: "running", pid: 4321 }, created: true },
      runtime: {},
    })
  );
  assert.deepEqual(ok, { ok: true, id: "t-1", pid: 4321 });

  const appDown = parseRottieCreateResult(
    JSON.stringify({ schemaVersion: 1, ok: false, command: "terminal create", error: { code: "ROTTIE_APP_NOT_RUNNING" }, runtime: {} })
  );
  assert.deepEqual(appDown, { ok: false, code: "ROTTIE_APP_NOT_RUNNING" });

  const wsClosed = parseRottieCreateResult(
    JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "ROTTIE_WORKSPACE_NOT_OPEN" }, runtime: {} })
  );
  assert.deepEqual(wsClosed, { ok: false, code: "ROTTIE_WORKSPACE_NOT_OPEN" });

  const broken = parseRottieCreateResult("not-json {");
  assert.deepEqual(broken, { ok: false, code: "ROTTIE_JSON_PARSE" });
});

test("linux에서는 창을 열지 않는다 — Linux의 open은 openvt일 수 있다(2026-08-30 card-13)", () => {
  let spawns = 0;
  const countingSpawn = () => {
    spawns++;
    return { status: 0 };
  };
  const r = openWindow("kadan-테스트", "linux", { spawnFn: countingSpawn, choice: { kind: "none" } });
  assert.deepEqual(r, { method: "manual" });
  assert.equal(spawns, 0); // 플랫폼 가드가 spawn 이전에 끊는다
});

test("카단 전용 tmux 설정은 상태줄 숨김·접두사 없음·마우스·지연 0·스크롤백 5줄이다(2026-08-30 card-13)", () => {
  const lines = tmuxConfText().trim().split("\n");
  assert.deepEqual(lines, [
    "set -g status off", // 상태줄을 숨겨 로티 패널 안에서 tmux 티가 나지 않는다
    "set -g prefix None", // C-b를 죽여 패널 안 키 입력이 그대로 에이전트에게 간다
    "set -g mouse on",
    "set -sg escape-time 0",
    "set -g history-limit 50000",
  ]);
});

test("읽기 명령은 홈 폴더와 tmux.conf를 만들지 않는다(2026-08-30 card-13 검수)", () => {
  const prevHome = process.env.KADAN_HOME;
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-lite-empty-home-"));
  process.env.KADAN_HOME = emptyHome;
  try {
    // 시험 소켓(kadan-unittest)에는 서버가 없다 → list-sessions의 exit 1이 정상이다.
    const r = tmux(["list-sessions"]);
    assert.equal(r.status, 1);
    assert.equal(fs.existsSync(tmuxConfPath()), false); // 읽기가 설정을 만들면 안 된다
    assert.deepEqual(fs.readdirSync(emptyHome), []); // 홈 폴더도 비어 있어야 한다
  } finally {
    process.env.KADAN_HOME = prevHome;
  }
});

test("창은 기계당 하나, 폴백 체인은 표면을 늘린다(2026-08-30 card-15 Ghostty 사고): KADAN_WINDOW 선택", () => {
  assert.deepEqual(resolveWindowChoice({}), { kind: "none" });
  assert.deepEqual(resolveWindowChoice({ KADAN_WINDOW: "orca" }), { kind: "orca" });
  assert.deepEqual(resolveWindowChoice({ KADAN_WINDOW: "rottie" }), { kind: "rottie" });
  assert.deepEqual(resolveWindowChoice({ KADAN_WINDOW: "ghostty" }), {
    error: "KADAN_WINDOW_INVALID",
    value: "ghostty",
  });
});

test("Orca terminal create argv는 요소 배열·tmux 절대경로·한글 역할을 보존한다", () => {
  const argv = buildOrcaCreateArgv({
    role: "c17-작업자 한글",
    session: "kadan-c17-작업자-한글",
    cwd: "/home/te ster/Dev/kadan-lite",
    socket: "kadan",
    tmuxBin: "/opt/homebrew/bin/tmux",
  });
  assert.deepEqual(argv, [
    "terminal", "create",
    "--worktree", "path:/home/te ster/Dev/kadan-lite",
    "--title", "c17-작업자 한글",
    "--command", "/opt/homebrew/bin/tmux -L kadan attach -t kadan-c17-작업자-한글",
    "--focus",
    "--json",
  ]);
  assert.ok(argv.every((a) => typeof a === "string"));
});

test("창 하나만 실행한다 — none은 spawn 0회, Orca 미접속은 다음 후보 없이 실패(card-17)", () => {
  let spawns = 0;
  const none = openWindow("kadan-테스트", "darwin", {
    choice: { kind: "none" },
    spawnFn: () => {
      spawns++;
      return { status: 0 };
    },
  });
  assert.deepEqual(none, { method: "manual" });
  assert.equal(spawns, 0);

  const calls = [];
  const orcaSpawn = (bin, argv) => {
    calls.push({ bin, argv });
    if (argv[0] === "terminal" && argv[1] === "list") {
      return { status: 0, stdout: JSON.stringify({ ok: true, result: { terminals: [] } }) };
    }
    if (argv[0] === "repo" && argv[1] === "add") {
      return { status: 0, stdout: JSON.stringify({ ok: true, result: {} }) };
    }
    return {
      status: 0,
      stdout: JSON.stringify({ ok: true, result: { terminal: { handle: "term_c17" } } }),
    };
  };
  const failed = openWindow("kadan-테스트", "darwin", {
    choice: { kind: "orca" },
    role: "c17-작업자",
    orcaBin: "/Applications/Orca.app/orca",
    spawnFn: orcaSpawn,
    waitForClient: () => false,
    cwd: "/tmp/kadan-lite",
    tmuxBin: "/opt/homebrew/bin/tmux",
  });
  assert.equal(failed, null);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.bin === "/Applications/Orca.app/orca"));

  const reusedCalls = [];
  const reused = openWindow("kadan-테스트", "darwin", {
    choice: { kind: "orca" },
    role: "c17-작업자",
    orcaBin: "/Applications/Orca.app/orca",
    spawnFn: (bin, argv) => {
      reusedCalls.push({ bin, argv });
      return {
        status: 0,
        stdout: JSON.stringify({
          ok: true,
          result: {
            terminals: [
              {
                handle: "term_existing",
                title: "/opt/homebrew/bin/tmux",
                connected: true,
                orphaned: false,
              },
            ],
            visualLayouts: [
              {
                root: {
                  tabs: [
                    {
                      title: "c17-작업자",
                      panes: { type: "terminal", handle: "term_existing" },
                    },
                  ],
                },
              },
            ],
          },
        }),
      };
    },
    waitForClient: () => true,
  });
  assert.deepEqual(reused, {
    method: "orca",
    orcaTerminalHandle: "term_existing",
    reused: true,
  });
  assert.equal(reusedCalls.length, 1); // terminal list만, repo add/create 없음
});
