// HW-4-impl2: cmdSend → guardedSend → herdr 바닥까지 일반 우편의 busyMail 표시가 이어지는지 지킨다.
// HW-6의 busyMail 3곳(cli-guarded-send.mjs 매개변수·바닥 호출, commands/send.mjs의 busyMail: true)을 병합·리팩터링에서
// 놓치면 응답 중인 herdr 감독에게 완료 보고·질문이 안 가는데, 바닥 직접 호출 시험만으로는 못 잡는다(HW-4-review R1).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-busymail-send-"));
Object.assign(process.env, { KADAN_HOME: home, KADAN_NOTIFY: "off" });
delete process.env.KADAN_ROLE;
delete process.env.KADAN_LITE_HOME;

const { makeHerdrFloor } = await import("../src/floor-herdr.mjs");
const { floor } = await import("../src/floor.mjs");
const { appendLedger } = await import("../src/ledger.mjs");
const { cmdSend } = await import("../src/commands/send.mjs");

const role = "판-작업자", session = `kadan-${role}`;
const socket = path.join(os.homedir(), ".config/herdr/sessions/busymail-test/herdr.sock");
const start = { kind: "start", floor: "herdr", role, session, panePid: "123", harness: "codex",
  model: "fixture-model", cmd: "codex --model fixture-model", herdrSocket: socket,
  herdrWorkspaceId: "ws", herdrPaneId: "p", herdrTerminalId: "term" };
appendLedger(start);

// 실제 herdr 바닥(makeHerdrFloor)에 모의 소켓만 붙이고, cmdSend가 쓰는 바닥 하나에 연결한다.
const state = { status: "working", calls: [], seenOptions: [] };
const herdr = makeHerdrFloor({
  env: { KADAN_HOME: home, KADAN_HERDR_SOCKET: socket },
  entries: () => [start],
  rpc: (_s, method, params) => {
    state.calls.push(method);
    if (method === "session.snapshot") return { snapshot: { panes: [{ pane_id: "p", workspace_id: "ws", terminal_id: "term",
      scroll: { offset_from_bottom: 0, viewport_rows: 58 } }] } };
    if (method === "pane.process_info") return { process_info: { shell_pid: 123,
      foreground_processes: [{ pid: 123, argv: ["codex", "--model", "fixture-model"] }] } };
    if (method === "agent.get") return { agent: { terminal_id: "term", agent_status: state.status } };
    if (method === "pane.read") return { read: { text: "\n› Ask Codex to do anything\n\nstatus", revision: 1, truncated: false } };
    if (method === "agent.prompt") return { type: "ok" };
    throw new Error(`Unexpected request ${method}`);
  },
});
Object.assign(floor, { name: "herdr", alive: () => true, pid: () => "123",
  send: (s, m, options) => { state.seenOptions.push(options); return herdr.send(s, m, options); } });

const prompts = () => state.calls.filter(m => m === "agent.prompt").length;
const reset = (status) => { state.status = status; state.calls = []; state.seenOptions = []; };
const quiet = (fn) => {
  const log = console.log, err = console.error, exit = process.exit;
  console.log = console.error = () => {};
  process.exit = (code) => { throw Object.assign(new Error(`exit ${code}`), { exitCode: code }); };
  try { return fn(); } finally { console.log = log; console.error = err; process.exit = exit; }
};

test("cmdSend 일반 우편은 busyMail: true로 바닥에 도착하고 응답 중 herdr에 전달된다", () => {
  reset("working");
  quiet(() => cmdSend([role, "완료 통지 시험"], { raw: true }));
  assert.equal(state.seenOptions.length, 1);
  assert.equal(state.seenOptions[0].busyMail, true);
  assert.equal(state.seenOptions[0].cardIdentity, undefined, "일반 우편은 카드 신원을 붙이지 않는다");
  assert.equal(prompts(), 1);
});

test("같은 cmdSend 경로의 --task 카드 발령은 응답 중이면 거절되고 본문 요청이 없다", () => {
  reset("working");
  assert.throws(() => quiet(() => cmdSend([role, "카드 발령 시험"], { raw: true, task: "BM-1" })), /exit|입력 대기|NOT_READY/);
  assert.equal(state.seenOptions.at(-1)?.busyMail, true, "표시가 있어도 cardIdentity가 있으면 거절한다");
  assert.ok(state.seenOptions.at(-1)?.cardIdentity, "발령은 카드 신원을 바닥까지 넘긴다");
  assert.equal(prompts(), 0);
});

test("같은 cmdSend 경로의 발령은 입력 대기(idle)면 전달된다", () => {
  reset("idle");
  quiet(() => cmdSend([role, "카드 발령 시험2"], { raw: true, task: "BM-2" }));
  assert.equal(prompts(), 1);
});

test("busyMail 표시가 없는 호출(감시 경보 경로)은 응답 중이면 거절된다", async () => {
  const { guardedSend } = await import("../src/cli-guarded-send.mjs");
  reset("working");
  assert.throws(() => guardedSend({ floor, session, role, message: "감시 경보", source: "watch",
    recordedPid: "123", notificationOnly: true, env: process.env }), { code: "KADAN_HERDR_NOT_READY" });
  assert.equal(state.seenOptions[0].busyMail, false, "guardedSend 기본값은 busyMail 아님");
  assert.equal(prompts(), 0);
});
