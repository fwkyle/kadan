import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { makeHerdrFloor, herdrRpc, herdrInputFrame } from "../src/floor-herdr.mjs";
import { buildStartLedgerEntry } from "../src/cli.mjs";
import { selectFloorName } from "../src/floor.mjs";

function fixture() {
  const env = { KADAN_HOME: "/tmp/kadan-herdr-test", KADAN_HERDR_SOCKET: path.join(os.homedir(), ".config/herdr/sessions/test/herdr.sock") };
  const start = { kind: "start", floor: "herdr", session: "kadan-판-작업자", panePid: "123",
    harness: "codex", model: "fixture-model", herdrSocket: env.KADAN_HERDR_SOCKET,
    herdrWorkspaceId: "opaque-workspace", herdrPaneId: "old-pane", herdrTerminalId: "opaque-terminal" };
  const pane = { pane_id: "moved-pane", workspace_id: start.herdrWorkspaceId,
    terminal_id: start.herdrTerminalId, scroll: { offset_from_bottom: 0, viewport_rows: 58 } };
  const state = { panes: [pane], pid: 123, argv: ["codex", "--model", "fixture-model"],
    status: "idle", output: "\n› Ask Codex to do anything\n\nstatus", truncated: false, calls: [] };
  const rpc = (_socket, method, params) => {
    state.calls.push({ method, params });
    if (method === "session.snapshot") return { snapshot: { panes: state.panes } };
    if (method === "pane.process_info") return { process_info: { shell_pid: state.pid,
      foreground_processes: [{ pid: state.pid, argv: state.argv }] } };
    if (method === "agent.get") return { agent: { terminal_id: pane.terminal_id, agent_status: state.status } };
    if (method === "pane.read") return { read: { text: state.output, revision: 7, truncated: state.truncated } };
    if (method === "agent.prompt") { if (state.promptError) throw state.promptError; return { type: "ok" }; }
    if (method === "workspace.close") return { type: "ok" };
    throw new Error(`Unexpected request ${method}`);
  };
  const floor = makeHerdrFloor({ env, entries: () => [start], rpc,
    inputFrame: (...args) => { state.frameArgs = args; return { row: 1, width: 120 }; },
    argsForPid: () => state.localArgs || "" });
  return { floor, state, env, start, pane };
}

test("herdr는 명시 선택이며 기본 tmux와 기존 rottie를 바꾸지 않는다", () => {
  assert.equal(selectFloorName().name, "tmux");
  assert.equal(selectFloorName("rottie").name, "rottie");
  assert.equal(selectFloorName("herdr").name, "herdr");
  assert.throws(() => makeHerdrFloor({ env: {}, entries: () => [] }).list(), /KADAN_HERDR_SCOPE/);
});

test("한글 역할은 원문 주소로 유지하고 터미널 ID로 현재 pane을 찾는다", () => {
  const f = fixture(); const receipt = f.floor.send(f.start.session, "왕복 질문");
  assert.equal(receipt.keyDelivery, "sent");
  assert.equal(receipt.inputAcceptance, "unconfirmed");
  assert.equal(receipt.baselineText, f.state.output);
  assert.equal(f.state.calls.at(-1).params.target, "moved-pane");
  assert.equal(f.floor.list()[0].session, f.start.session);
  assert.match(f.floor.attach(f.start.session), /terminal attach 'opaque-terminal'/);
});

for (const [name, change, code] of [
  ["죽은 pane", f => { f.state.panes = []; }, "KADAN_SESSION_MISSING"],
  ["터미널 ID 재사용 착각", f => { f.pane.terminal_id = "another-terminal"; }, "KADAN_SESSION_MISSING"],
  ["서버 주소 변경", f => { f.env.KADAN_HERDR_SOCKET = "/tmp/sessions/other/herdr.sock"; }, "KADAN_HERDR_SCOPE_CHANGED"],
  ["PID 변경", f => { f.state.pid = 456; }, "KADAN_PID_MISMATCH"],
  ["AI가 셸로 바뀜", f => { f.state.argv = ["zsh"]; }, "KADAN_AI_PROCESS_UNVERIFIED"],
  ["명시 모델 변경", f => { f.state.argv[2] = "other-model"; }, "KADAN_AI_PROCESS_UNVERIFIED"],
  ["승인 대기", f => { f.state.status = "blocked"; }, "KADAN_HERDR_NOT_READY"],
  ["상태 미확인", f => { f.state.status = "unknown"; }, "KADAN_HERDR_NOT_READY"],
  ["미제출 입력", f => { f.state.output = "\n› 남아 있는 글\n\nstatus"; }, "KADAN_PANE_INPUT_PENDING"],
  ["기록보기 중", f => { f.pane.scroll.offset_from_bottom = 4; }, "KADAN_HERDR_SCROLLED"],
  ["출력 유실", f => { f.state.truncated = true; }, "KADAN_HERDR_INPUT_UNKNOWN"],
]) test(`${name}이면 본문 요청이 발생하지 않는다`, () => {
  const f = fixture(); change(f);
  assert.throws(() => f.floor.send(f.start.session, "카드 본문"), { code });
  assert.equal(f.state.calls.filter(c => c.method === "agent.prompt").length, 0);
});

test("명령 인자가 생략되면 그 foreground PID만 조회하며 모델 신원을 완화하지 않는다", () => {
  const f = fixture(); f.state.argv = undefined;
  assert.throws(() => f.floor.send(f.start.session, "질문"), { code: "KADAN_AI_PROCESS_UNVERIFIED" });
  f.state.localArgs = "codex --model fixture-model";
  assert.equal(f.floor.send(f.start.session, "질문").keyDelivery, "sent");
});

test("본문 요청 뒤 응답 유실이면 전달 불명확으로 끝내고 재시도하지 않는다", () => {
  const f = fixture(); f.state.promptError = Object.assign(new Error("response lost"), { delivery: "unknown" });
  assert.throws(() => f.floor.send(f.start.session, "질문"), /자동 재전송 금지/);
  assert.equal(f.state.calls.filter(c => c.method === "agent.prompt").length, 1);
});

test("남의 터미널이 추가된 작업공간은 전체 종료하지 않는다", () => {
  const f = fixture(); f.state.panes.push({ ...f.pane, terminal_id: "extra-terminal" });
  assert.throws(() => f.floor.stop(f.start.session), { code: "KADAN_HERDR_OWNERSHIP" });
  assert.equal(f.state.calls.filter(c => c.method === "workspace.close").length, 0);
});

test("시작 장부가 서버와 세 개의 불투명 주소를 보존한다", () => {
  const f = fixture(); const e = buildStartLedgerEntry({ floorName: "herdr", role: "판-작업자",
    session: f.start.session, evidence: f.start, window: "manual", cmd: "codex --model fixture-model", env: {} });
  for (const key of ["herdrSocket", "herdrWorkspaceId", "herdrPaneId", "herdrTerminalId", "panePid"]) assert.equal(e[key], f.start[key]);
});

test("확인되지 않은 자동 알림과 Enter 경로는 비활성이다", () => {
  const f = fixture();
  assert.throws(() => f.floor.send(f.start.session, "알림", { notificationGuard: {} }), { code: "KADAN_HERDR_NOTIFY_UNVERIFIED" });
  assert.throws(() => f.floor.sendEnter(f.start.session), { code: "KADAN_HERDR_ENTER_UNVERIFIED" });
  assert.equal(f.state.calls.length, 0);
});

test("생성 응답의 교체된 tab/pane ID를 사용하고 자식에게 시험 CLI 절대경로를 준다", () => {
  const f = fixture(); let applied;
  const rpc = (_socket, method, params) => {
    if (method === "workspace.create") return { workspace: { workspace_id: "new-workspace" }, tab: { tab_id: "old-tab" } };
    if (method === "layout.apply") { applied = params; return { layout: { tab_id: "new-tab", root: { pane_id: "new-pane" } } }; }
    if (method === "session.snapshot") return { snapshot: { panes: [{ workspace_id: "new-workspace", tab_id: "new-tab", pane_id: "new-pane", terminal_id: "new-terminal", cwd: "/tmp/project" }] } };
    if (method === "pane.process_info") return { process_info: { shell_pid: 789 } };
    throw new Error(method);
  };
  const floor = makeHerdrFloor({ env: f.env, rpc, entries: () => [] });
  const e = floor.create({ session: "kadan-판-작업자", role: "판-작업자", cwd: "/tmp/project", cmd: 'codex --model "fixture-model"' });
  assert.equal(e.herdrPaneId, "new-pane");
  assert.equal(e.herdrTerminalId, "new-terminal");
  assert.equal(applied.tab_id, "old-tab");
  assert.equal(applied.workspace_id, undefined);
  assert.equal(applied.focus, false);
  assert.equal(applied.root.env.KADAN_ROLE, "판-작업자");
  assert.equal(applied.root.env.KADAN_HOME, f.env.KADAN_HOME);
  assert(path.isAbsolute(applied.root.env.KADAN_CLI));
  assert.equal(path.basename(applied.root.env.KADAN_CLI), "cli.mjs");
  assert.deepEqual(applied.root.command, ["codex", "--model", "fixture-model"]);
});

test("별도 경로 소켓을 기본 named server로 잘못 attach하지 않는다", () => {
  const f = fixture(); f.env.KADAN_HERDR_SOCKET = "/tmp/sessions/test/herdr.sock"; f.start.herdrSocket = f.env.KADAN_HERDR_SOCKET;
  assert.throws(() => f.floor.attach(f.start.session), { code: "KADAN_HERDR_ATTACH_SCOPE" });
});

test("재사용 시작은 같은 서버·터미널·PID의 신원만 이어받는다", () => {
  const f = fixture(); const launch = { ...f.start };
  delete f.start.harness; delete f.start.model;
  let records = [launch, f.start];
  const successful = fixture();
  const reused = makeHerdrFloor({ env: f.env, entries: () => records,
    rpc: (_socket, method, params) => {
      if (method === "session.snapshot") return { snapshot: { panes: [f.pane] } };
      if (method === "pane.process_info") return { process_info: { shell_pid: 123, foreground_processes: [{ pid: 123, argv: ["codex", "--model", "fixture-model"] }] } };
      if (method === "agent.get") return { agent: { terminal_id: f.pane.terminal_id, agent_status: "idle" } };
      if (method === "pane.read") return { read: { text: successful.state.output, revision: 1, truncated: false } };
      if (method === "agent.prompt") return { type: "ok" };
      throw new Error(method);
    }, inputFrame: () => ({ row: 1, width: 120 }) });
  assert.equal(reused.send(f.start.session, "왕복").keyDelivery, "sent");
  records = [{ ...launch, panePid: "old-generation" }, f.start];
  assert.throws(() => reused.send(f.start.session, "왕복"), { code: "KADAN_AI_PROCESS_UNVERIFIED" });
});

test("소켓 응답의 한글 글자가 패킷 경계에서 나뉘어도 보존된다", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-herdr-utf8-"));
  const socket = path.join(dir, "herdr.sock");
  const server = spawn(process.execPath, ["--input-type=module", "-e", `
    import net from 'node:net';
    const response=Buffer.from(JSON.stringify({id:'kadan',result:{text:'작업자 왕복'}})+'\\n');
    const cut=response.indexOf(Buffer.from('작'))+1;
    const server=net.createServer(client=>client.once('data',()=>{
      client.write(response.subarray(0,cut));setTimeout(()=>client.end(response.subarray(cut)),25);
    }));server.listen(process.argv[1],()=>process.stdout.write('ready\\n'));
  `, socket], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await once(server.stdout, "data");
    assert.equal(herdrRpc(socket, "session.snapshot").text, "작업자 왕복");
  } finally { server.kill(); await once(server, "exit"); }
});

test("입력 커서는 터미널의 실제 세로 줄 수로 관찰한다 (LBR-1 결함 1)", () => {
  const f = fixture(); f.floor.send(f.start.session, "왕복 질문");
  assert.equal(f.state.frameArgs[1], "opaque-terminal");
  assert.equal(f.state.frameArgs[2], 58);
  // 세로 줄 수를 모르면 기본 관찰 창(120x40)으로 추측하지 않고 거절한다.
  assert.throws(() => herdrInputFrame(f.env.KADAN_HERDR_SOCKET, "opaque-terminal", undefined),
    { code: "KADAN_HERDR_INPUT_UNKNOWN" });
});

for (const [runner, screen, keys] of [
  ["claude", " Quick safety check: Is this a project you created or one you trust? (Like your own code)\n\n ❯ No, exit\n   Yes, I trust this folder", "down enter"],
  ["codex", "> You are in /tmp/p\n\n  Do you trust the contents of this directory? Working with untrusted contents\n\n› 1. Yes, continue", "enter"],
]) {
  test(`${runner} 신뢰 확인 화면은 자동 수락 없이 정확한 해결 명령과 함께 거절한다 (LBR-1 결함 4)`, () => {
    const f = fixture(); f.state.status = "blocked"; f.state.output = screen;
    assert.throws(() => f.floor.send(f.start.session, "왕복"), error => {
      assert.equal(error.code, "KADAN_HERDR_TRUST_PROMPT");
      assert.match(error.message, new RegExp(`pane send-keys 'moved-pane' ${keys}$`));
      assert.match(error.message, /terminal attach 'opaque-terminal'/);
      return true;
    });
    assert.equal(f.state.calls.some(call => ["agent.prompt", "pane.send_keys", "pane.send_text"].includes(call.method)), false);
  });
}

test("신뢰 화면이 아닌 blocked는 기존처럼 입력 대기 실패다", () => {
  const f = fixture(); f.state.status = "blocked"; f.state.output = "권한을 허용할까요?";
  assert.throws(() => f.floor.send(f.start.session, "왕복"), { code: "KADAN_HERDR_NOT_READY" });
});

test("응답 중인 실행기에도 우편은 들어가 실행기 대기열에서 처리된다 (LBR-1 결함 2)", () => {
  const f = fixture(); f.state.status = "working";
  assert.equal(f.floor.send(f.start.session, "완료 통지").keyDelivery, "sent");
  assert.equal(f.state.calls.filter(call => call.method === "agent.prompt").length, 1);
});

test("카드 발령은 일하는 역할에 얹지 않고, 응답 중이어도 미제출 입력 보호는 같다", () => {
  const f = fixture(); f.state.status = "working";
  const identity = { currentPid: 123, harness: "codex", model: "fixture-model" };
  assert.throws(() => f.floor.send(f.start.session, "카드", { cardIdentity: identity }), { code: "KADAN_HERDR_NOT_READY" });
  f.state.output = "\n› 사람이 쓰던 글\n\nstatus";
  assert.throws(() => f.floor.send(f.start.session, "우편"), { code: "KADAN_PANE_INPUT_PENDING" });
  assert.equal(f.state.calls.some(call => call.method === "agent.prompt"), false);
});
