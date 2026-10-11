// 격리 왕복 실험. 기본 서버/현재 포커스로 주소를 추측하거나 tmux로 폴백하지 않는다.
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { commandWords, matchesAiProcess } from "./ai-identity.mjs";
import { readLedger } from "./ledger.mjs";
import { checkEmptyInput } from "./floor-tmux.mjs";

function deny(code, message, delivery = "not-sent") {
  const error = new Error(`${code}: ${message}`);
  Object.assign(error, { code, delivery, exitCode: 2, inputAcceptance: "unconfirmed" });
  throw error;
}

// 바닥 API는 동기식이다. 자식의 로컬 소켓 조회만 기다리며 응답 유실을 재시도하지 않는다.
const SOCKET_CLIENT = `
import net from 'node:net';
const [socket,method,params]=process.argv.slice(1);
const client=net.createConnection(socket); let data='';
client.setEncoding('utf8');
client.setTimeout(5000,()=>client.destroy(new Error('Herdr socket timeout')));
client.on('connect',()=>client.write(JSON.stringify({id:'kadan',method,params:JSON.parse(params)})+'\\n'));
client.on('data',chunk=>{data+=chunk; if(data.length>8*1024*1024)client.destroy(new Error('Herdr response too large'));
 const end=data.indexOf('\\n'); if(end>=0){process.stdout.write(data.slice(0,end));client.destroy();}});
client.on('error',()=>{process.stderr.write('Herdr socket unavailable or response incomplete');process.exitCode=1;});
client.on('end',()=>{if(!data.includes('\\n'))process.exitCode=1;});
`;

export function herdrRpc(socket, method, params = {}) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", SOCKET_CLIENT,
    socket, method, JSON.stringify(params)], { encoding: "utf8", timeout: 6000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) deny("KADAN_HERDR_CONNECTION", "서버 응답 미확인; 자동 재전송 금지", "unknown");
  let envelope;
  try { envelope = JSON.parse(result.stdout); }
  catch { deny("KADAN_HERDR_RESPONSE", "JSON 응답 미확인", "unknown"); }
  if (envelope.error) {
    const beforeInput = ["empty_agent_prompt", "agent_blocked", "agent_not_ready", "agent_not_found", "invalid_target"];
    deny(envelope.error.code || "KADAN_HERDR_ERROR", envelope.error.message || "서버 요청 거절",
      method === "agent.prompt" && !beforeInput.includes(envelope.error.code) ? "unknown" : "not-sent");
  }
  if (!envelope.result) deny("KADAN_HERDR_RESPONSE", "결과가 없는 응답", "unknown");
  return envelope.result;
}

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

function serverName(socket) {
  const server = path.basename(path.dirname(socket));
  const expected = path.join(os.homedir(), ".config", "herdr", "sessions", server, "herdr.sock");
  if (socket !== expected || !/^[a-zA-Z0-9_-]+$/.test(server)) {
    deny("KADAN_HERDR_ATTACH_SCOPE", "CLI로 명확히 지정할 수 있는 named session 소켓이 필요하다");
  }
  return server;
}

function localArgs(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  const result = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "args="], { encoding: "utf8", timeout: 2000 });
  return result.status === 0 ? result.stdout.trim() : "";
}

const OBSERVE_FRAME = `
import {spawn} from 'node:child_process';
const [session,terminal,rows]=process.argv.slice(1); let data='';
const child=spawn('herdr',['--session',session,'terminal','session','observe',terminal,'--rows',rows],{stdio:['ignore','pipe','ignore']});
const timer=setTimeout(()=>{child.kill();process.exitCode=1;},3000);
child.stdout.on('data',chunk=>{data+=chunk;const end=data.indexOf('\\n');
 if(end>=0){process.stdout.write(data.slice(0,end));child.kill();clearTimeout(timer);}});
child.on('error',()=>{clearTimeout(timer);process.exitCode=1;});
`;

// 관찰 창은 기본 120x40이라, 세로가 더 큰 터미널이면 실제 커서가 프레임 밖(숨김)으로 밀려 행 좌표가 어긋난다
// (2026-10-12 LBR-1 결함 1: 58행 Codex 창에서 프레임 마지막 이동이 커서 아닌 그리기 위치 40행이었다).
// 터미널의 실제 세로 줄 수로 관찰해야 프레임 행 = 화면 행이 된다.
export function herdrInputFrame(socket, terminal, rows) {
  if (!Number.isInteger(rows) || rows <= 0) deny("KADAN_HERDR_INPUT_UNKNOWN", "터미널 세로 줄 수 미확인");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", OBSERVE_FRAME,
    serverName(socket), terminal, String(rows)], { encoding: "utf8", timeout: 4000, maxBuffer: 1024 * 1024 });
  let frame;
  try { frame = JSON.parse(result.stdout); } catch { deny("KADAN_HERDR_INPUT_UNKNOWN", "입력 커서 조회 실패"); }
  if (result.status !== 0 || frame.type !== "terminal.frame" || !frame.full || frame.encoding !== "ansi") {
    deny("KADAN_HERDR_INPUT_UNKNOWN", "전체 터미널 화면이 아닌 응답");
  }
  if (frame.height !== rows) deny("KADAN_HERDR_INPUT_UNKNOWN", `관찰 화면 세로(${frame.height})가 터미널(${rows})과 달라 커서 행을 믿을 수 없다`);
  const ansi = Buffer.from(frame.bytes, "base64").toString("utf8");
  const cursor = [...ansi.matchAll(/\x1b\[(\d+);(\d+)H/g)].at(-1);
  if (!cursor) deny("KADAN_HERDR_INPUT_UNKNOWN", "현재 입력 커서 미확인");
  // frame.width는 접속 창 크기와 어긋난 값이 올 수 있어(120 대 실제 212) 입력창 판정에 쓰지 않는다.
  return { row: Number(cursor[1]) - 1, width: frame.width };
}

// 새 폴더의 첫 실행은 AI 도구가 "이 폴더를 믿느냐"를 묻고 사람이 답할 때까지 멈춘다(2026-10-12 LBR-1 실측).
// 자동으로 수락하지 않는다: 폴더를 믿는 일은 사람의 결정이다. 막힘을 알리고 정확한 통과 명령만 보여 준다.
// Claude 기본 선택은 `No, exit`라 Enter만 보내면 종료된다 → 아래로 한 칸 내린 뒤 Enter. Codex 기본은 `Yes, continue`.
const TRUST_SCREENS = [
  { runner: "claude", pattern: /Quick safety check: Is this a project you created or one you trust/u, keys: ["down", "enter"] },
  { runner: "codex", pattern: /Do you trust the contents of this directory\?/u, keys: ["enter"] },
];
export function trustPromptHelp(socket, pane, screenText) {
  const plain = String(screenText).replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, "");
  const hit = TRUST_SCREENS.find(t => t.pattern.test(plain));
  if (!hit) return null;
  const server = serverName(socket);
  return `${hit.runner} 신뢰 확인 화면에서 멈춰 있다 — 자동으로 수락하지 않는다. 폴더를 믿는다면 사람이 직접 통과: ` +
    `herdr --session ${quote(server)} terminal attach ${quote(pane.terminal_id)} 로 접속해 Yes를 고르거나, ` +
    `herdr --session ${quote(server)} pane send-keys ${quote(pane.pane_id)} ${hit.keys.join(" ")}`;
}

export function makeHerdrFloor({ env = process.env, rpc = herdrRpc, entries = readLedger,
  argsForPid = localArgs, inputFrame = herdrInputFrame } = {}) {
  const pending = new Map();
  const socket = () => {
    if (!env.KADAN_HOME || !path.isAbsolute(env.KADAN_HERDR_SOCKET || "")) {
      deny("KADAN_HERDR_SCOPE", "명시적인 KADAN_HOME과 절대경로 KADAN_HERDR_SOCKET이 필요하다");
    }
    return env.KADAN_HERDR_SOCKET;
  };
  const call = (method, params) => rpc(socket(), method, params);
  const address = session => {
    const starts = entries().filter(e => e.kind === "start" && e.session === session);
    const start = starts.at(-1);
    // 재사용 start에는 새 실행 명령이 없다. 같은 서버·터미널·PID의 실행 기록만 이어받는다.
    const launch = starts.findLast(e => e.floor === "herdr" && e.herdrSocket === start?.herdrSocket &&
      e.herdrTerminalId === start?.herdrTerminalId && e.panePid === start?.panePid && e.harness && e.model);
    const record = start || pending.has(session) ? { ...launch, ...start, ...pending.get(session) } : null;
    if (!record) return null;
    if ((record.floor && record.floor !== "herdr") || record.herdrSocket !== socket()) {
      deny("KADAN_HERDR_SCOPE_CHANGED", "이 역할의 시작 서버와 현재 서버가 다르다");
    }
    if (!record.herdrTerminalId || !record.herdrWorkspaceId) deny("KADAN_HERDR_ADDRESS", "기록된 터미널 주소가 없다");
    return record;
  };
  const snapshot = () => {
    const data = call("session.snapshot").snapshot;
    if (!Array.isArray(data?.panes)) deny("KADAN_HERDR_RESPONSE", "세션 목록 형식 미확인");
    return data;
  };
  const paneFor = (record, data = snapshot()) => data.panes.find(p =>
    p.terminal_id === record.herdrTerminalId && p.workspace_id === record.herdrWorkspaceId);
  const requirePane = session => {
    const record = address(session);
    if (!record) deny("KADAN_SESSION_MISSING", `시작 기록 없음: ${session}`);
    const pane = paneFor(record);
    if (!pane) deny("KADAN_SESSION_MISSING", `기록된 터미널 없음: ${session}`);
    return { record, pane };
  };
  const processInfo = pane => call("pane.process_info", { pane_id: pane.pane_id }).process_info;
  const readPane = pane => {
    // ANSI 조회는 앱의 스크롤 키로 과거 기록을 수집하지 않는다. 끊긴 출력은 완료로 판정하지 않는다.
    const read = call("pane.read", { pane_id: pane.pane_id, source: "recent_unwrapped",
      format: "ansi", strip_ansi: false, lines: 10000 }).read;
    if (typeof read?.text !== "string" || typeof read.truncated !== "boolean") deny("KADAN_HERDR_RESPONSE", "출력 형식 미확인");
    return { text: read.text, cursor: String(read.revision), incremental: false,
      gap: read.truncated ? "Herdr 출력 일부만 조회됨" : null };
  };
  const checkAgent = (session, identity) => {
    const { record, pane } = requirePane(session);
    const info = processInfo(pane);
    if (String(info?.shell_pid) !== String(identity?.currentPid ?? record.panePid)) deny("KADAN_PID_MISMATCH", "현재 프로세스 세대가 시작 기록과 다르다");
    const harness = identity?.harness ?? record.harness;
    const model = identity?.model ?? record.model;
    if (!harness || !model || !info.foreground_processes?.some(p =>
      matchesAiProcess(p.argv?.map(quote).join(" ") ?? p.cmdline ?? argsForPid(p.pid), harness, model))) {
      deny("KADAN_AI_PROCESS_UNVERIFIED", "현재 AI 실행기·명시 모델이 시작 기록과 다르거나 미확인이다");
    }
    const agent = call("agent.get", { target: pane.pane_id }).agent;
    if (agent?.agent_status === "blocked") {
      const screen = call("pane.read", { pane_id: pane.pane_id, source: "visible", format: "text", strip_ansi: true }).read;
      const help = trustPromptHelp(socket(), pane, screen?.text ?? "");
      if (help) deny("KADAN_HERDR_TRUST_PROMPT", help);
    }
    if (agent?.terminal_id !== pane.terminal_id || agent.launch_pending ||
      !["idle", "done"].includes(agent.agent_status)) {
      deny("KADAN_HERDR_NOT_READY", `입력 대기 확인 실패: ${agent?.agent_status ?? "unknown"}`);
    }
    if (pane.scroll?.offset_from_bottom > 0) deny("KADAN_HERDR_SCROLLED", "과거 기록 조회 중이라 전송을 보류한다");
    const frame = inputFrame(socket(), pane.terminal_id, pane.scroll?.viewport_rows);
    const visible = call("pane.read", { pane_id: pane.pane_id, source: "visible", format: "ansi", strip_ansi: false }).read;
    if (typeof visible?.text !== "string" || visible.truncated) deny("KADAN_HERDR_INPUT_UNKNOWN", "현재 입력 화면 미확인");
    checkEmptyInput(session, () => visible.text.replaceAll("\r\n", "\n"), frame.row, null, "herdr 전송 보류");
    return pane;
  };
  // 시작 직후 몇 초 동안만 본다. 신뢰 화면이면 사람에게 알리고, 입력 대기가 되거나 시간이 지나면 조용히 끝낸다.
  // 실행기가 식별되기 전에는 agent.get이 agent_not_found를 주므로 그동안은 기다린다. 어떤 실패도 시작을 막지 않는다.
  const warnIfTrustPrompt = pane => {
    for (let i = 0; i < 12; i++) {
      try {
        const agent = call("agent.get", { target: pane.pane_id }).agent;
        const status = agent?.agent_status;
        if (status === "blocked") {
          const screen = call("pane.read", { pane_id: pane.pane_id, source: "visible", format: "text", strip_ansi: true }).read;
          const help = trustPromptHelp(socket(), pane, screen?.text ?? "");
          if (help) { console.error(`막힘: ${help}`); return; }
        } else if (status === "idle" || status === "done") return;
      } catch (error) { if (error.code !== "agent_not_found") return; }
      sleep(500);
    }
  };
  return {
    name: "herdr",
    create({ session, role, cwd, cmd }) {
      socket();
      const previous = address(session);
      if (previous && paneFor(previous)) deny("KADAN_HERDR_EXISTING_ADDRESS", "살아 있는 역할 주소를 덮어쓸 수 없다");
      const command = commandWords(cmd || "/bin/zsh");
      if (!command?.length || !path.isAbsolute(cwd)) deny("KADAN_HERDR_COMMAND", "절대 작업 경로와 단일 실행 명령이 필요하다");
      const workspace = call("workspace.create", { cwd, label: role, focus: false });
      const workspaceId = workspace.workspace?.workspace_id;
      const tabId = workspace.tab?.tab_id;
      if (!workspaceId || !tabId) deny("KADAN_HERDR_RESPONSE", "생성 주소 미확인; 서버에서 직접 확인 필요", "unknown");
      try {
        const inherited = Object.fromEntries(Object.entries(env).filter(([k, v]) =>
          (k.startsWith("KADAN_") || ["PATH", "CLAUDE_CONFIG_DIR", "CODEX_HOME"].includes(k)) && typeof v === "string"));
        inherited.KADAN_ROLE = session.startsWith("kadan-") ? session.slice(6) : role;
        // AI 도구의 로그인 셸이 PATH를 다시 만들 수 있다. 설치본과 시험 브랜치를 혼동하지 않는다.
        inherited.KADAN_CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url));
        const applied = call("layout.apply", { tab_id: tabId, focus: false,
          root: { type: "pane", cwd, command, env: inherited, label: role } });
        const pane = snapshot().panes.find(p => p.workspace_id === workspaceId &&
          p.pane_id === applied.layout?.root?.pane_id && p.tab_id === applied.layout?.tab_id);
        if (!pane?.terminal_id || pane.cwd !== cwd) deny("KADAN_HERDR_CWD", "생성 경로·터미널 주소 불일치");
        const pid = processInfo(pane)?.shell_pid;
        if (!Number.isInteger(pid) || pid <= 0) deny("KADAN_HERDR_PROCESS", "실행 프로세스 확인 실패");
        const evidence = { panePid: String(pid), herdrSocket: socket(),
          herdrWorkspaceId: workspaceId, herdrPaneId: pane.pane_id, herdrTerminalId: pane.terminal_id };
        pending.set(session, evidence);
        warnIfTrustPrompt(pane);
        return evidence;
      } catch (error) {
        try { call("workspace.close", { workspace_id: workspaceId, close_group: false }); }
        catch { error.message += " — 방금 만든 작업공간 종료 미확인"; }
        throw error;
      }
    },
    alive(session) { const record = address(session); return record ? Boolean(paneFor(record)) : false; },
    pid(session) { const record = address(session); const pane = record && paneFor(record);
      const pid = pane && processInfo(pane)?.shell_pid; return pid ? String(pid) : null; },
    read(session) { return readPane(requirePane(session).pane); },
    send(session, text, { cardIdentity, notificationGuard } = {}) {
      if (notificationGuard) deny("KADAN_HERDR_NOTIFY_UNVERIFIED", "사람의 미제출 입력 보호 검증 전에는 자동 알림을 보내지 않는다");
      const pane = checkAgent(session, cardIdentity);
      const baseline = readPane(pane);
      if (baseline.gap) deny("KADAN_HERDR_OUTPUT_GAP", baseline.gap);
      checkAgent(session, cardIdentity);
      try { call("agent.prompt", { target: pane.pane_id, text }); }
      catch (error) { if (error.delivery === "unknown") error.message += " — 본문/Enter 자동 재전송 금지"; throw error; }
      return { keyDelivery: "sent", inputAcceptance: "unconfirmed", baselineText: baseline.text,
        herdrTerminalId: pane.terminal_id };
    },
    notificationHold() { return { code: "KADAN_HERDR_NOTIFY_UNVERIFIED", message: "실험 바닥의 자동 알림 보호 미검증" }; },
    sendEnter() { deny("KADAN_HERDR_ENTER_UNVERIFIED", "실험 바닥에서는 Enter만 따로 재전송하지 않는다"); },
    stop(session) {
      const { record } = requirePane(session);
      // 이 역할만을 위해 생성한 작업공간 전체가 여전히 같은 터미널 하나인지 확인한다.
      const panes = snapshot().panes.filter(p => p.workspace_id === record.herdrWorkspaceId);
      if (panes.length !== 1 || panes[0].terminal_id !== record.herdrTerminalId) deny("KADAN_HERDR_OWNERSHIP", "작업공간에 다른 터미널이 있어 종료를 보류한다");
      call("workspace.close", { workspace_id: record.herdrWorkspaceId, close_group: false });
      pending.delete(session);
    },
    list() {
      const data = snapshot(); const starts = new Map();
      for (const e of entries()) if (e.kind === "start") starts.set(e.session, e);
      return [...starts].filter(([, e]) => e.floor === "herdr" && e.herdrSocket === socket())
        .flatMap(([session, e]) => { const pane = paneFor(e, data); return pane ? [{ session,
          pid: String(processInfo(pane)?.shell_pid ?? ""), terminalId: pane.terminal_id,
          state: pane.agent_status, alive: true }] : []; });
    },
    waitForChange(_session, ms) { sleep(ms); },
    attach(session) {
      const { pane } = requirePane(session);
      const server = serverName(socket());
      return `herdr --session ${quote(server)} terminal attach ${quote(pane.terminal_id)}`;
    },
  };
}

export const herdrFloor = makeHerdrFloor();
