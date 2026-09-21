// tmux 바닥 — 만들기·생존·PID·전달·읽기·종료·목록·변화 대기를 전담한다.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ledgerHome } from "./ledger.mjs";

export const SOCKET = process.env.KADAN_SOCKET || process.env.KADAN_LITE_SOCKET || "kadan";

function currentSocket() {
  return process.env.KADAN_SOCKET || process.env.KADAN_LITE_SOCKET || SOCKET;
}

export function tmuxConfText() {
  return [
    "set -g status off",
    "set -g prefix None",
    "set -g mouse on",
    "set -sg escape-time 0",
    "set -g history-limit 50000",
    "",
  ].join("\n");
}

export function tmuxConfPath(home = ledgerHome()) {
  return path.join(home, "tmux.conf");
}

export function ensureTmuxConf(home = ledgerHome()) {
  const conf = tmuxConfPath(home);
  if (!fs.existsSync(conf)) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(conf, tmuxConfText());
  }
  return conf;
}

export function tmux(args, input = undefined) {
  const conf = tmuxConfPath();
  const prefixArgs = fs.existsSync(conf) ? ["-f", conf] : [];
  return spawnSync("tmux", ["-L", currentSocket(), ...prefixArgs, ...args], {
    input,
    encoding: "utf8",
  });
}

function tmuxOut(args, input) {
  const result = tmux(args, input);
  if (result.status !== 0) {
    throw new Error(`tmux ${args.join(" ")} 실패: ${(result.stderr || "").trim()}`);
  }
  return result.stdout;
}

export function hasSession(session) {
  return tmux(["has-session", "-t", `=${session}`]).status === 0;
}

function panePid(session) {
  const result = tmux(["display-message", "-p", "-t", `=${session}:`, "#{pane_pid}"]);
  return result.status === 0 ? result.stdout.trim() : null;
}

export function capturePane(session) {
  const result = tmux(["capture-pane", "-p", "-t", session]);
  return result.status === 0 ? result.stdout : "";
}

export function outputLogPath(session, home = ledgerHome()) {
  return path.join(home, "out", `${session}.log`);
}

function attachOutputLog(session) {
  const outLog = outputLogPath(session);
  try {
    fs.mkdirSync(path.dirname(outLog), { recursive: true });
  } catch (error) {
    console.error(`경고: 출력 폴더 생성 실패: ${error.message}`);
    return null;
  }
  const quoted = outLog.replace(/'/g, "'\\''");
  const result = tmux(["pipe-pane", "-t", session, `cat >> '${quoted}'`]);
  if (result.status !== 0) {
    console.error(`경고: 출력 로그 설정 실패: ${(result.stderr || "").trim()}`);
    return null;
  }
  return outLog;
}

export function buildRottieCreateArgv({ role, session, cwd, socket, panePid: pid, command }) {
  return [
    "terminal",
    "create",
    "--workspace",
    cwd,
    "--title",
    role,
    "--command",
    command ?? `tmux -L ${socket} attach -t ${session}`,
    "--idempotency-key",
    `kadan-${session}-${pid}`,
    "--json",
  ];
}

export function parseRottieCreateResult(stdoutText) {
  try {
    const value = JSON.parse(stdoutText);
    if (value?.ok === true && value.result?.terminal?.id) {
      return {
        ok: true,
        id: value.result.terminal.id,
        pid: value.result.terminal.pid,
      };
    }
    return { ok: false, code: value?.error?.code || "ROTTIE_UNKNOWN" };
  } catch {
    return { ok: false, code: "ROTTIE_JSON_PARSE" };
  }
}

export function rottieConnectivity({ bin, spawnFn = spawnSync }) {
  try {
    const result = spawnFn(bin, ["status", "--json"], { encoding: "utf8" });
    let reply;
    try {
      reply = JSON.parse(result.stdout || "{}");
    } catch {
      // A non-JSON status failure still reports spawn/stderr evidence below.
    }
    const identity = { bundleId: reply?.runtime?.bundleId, build: reply?.runtime?.build };
    if (reply?.ok === true) return { ok: true, ...identity };
    return {
      ok: false,
      code: reply?.error?.code || result.error?.code || "ROTTIE_STATUS_FAILED",
      ...identity,
      message: reply?.error?.message || result.error?.message || (result.stderr || "").trim() || "Rottie status failed",
    };
  } catch (error) {
    return { ok: false, code: error.code || "ROTTIE_STATUS_FAILED", bundleId: undefined, build: undefined, message: error.message || String(error) };
  }
}

export function closeRottieWindow({ bin, terminalId, spawnFn = spawnSync }) {
  try {
    const result = spawnFn(bin, ["terminal", "close", "--terminal", terminalId, "--json"], { encoding: "utf8" });
    if (result.status === 0) return { closed: true };
    let error;
    try {
      error = JSON.parse(result.stdout || "{}").error;
    } catch {
      // Non-JSON failures still carry the process exit status and stderr.
    }
    return {
      closed: false,
      code: error?.code || result.error?.code || result.status || "ROTTIE_CLOSE_FAILED",
      message: error?.message || result.error?.message || (result.stderr || "").trim() || "Rottie terminal close failed",
    };
  } catch (error) {
    return { closed: false, code: error.code || "ROTTIE_CLOSE_FAILED", message: error.message || String(error) };
  }
}

function rottieCreate(bin, argv, spawnFn) {
  const run = (args) => spawnFn(bin, args, { encoding: "utf8" });
  let result = run(argv);
  let parsed = parseRottieCreateResult((result.stdout || "").trim());
  if (!parsed.ok && parsed.code === "ROTTIE_WORKSPACE_NOT_OPEN") {
    run(["workspace", "add", "--path", process.cwd(), "--json"]);
    result = run(argv);
    parsed = parseRottieCreateResult((result.stdout || "").trim());
  }
  return parsed;
}

const TMUX_BIN = (() => {
  const result = spawnSync("which", ["tmux"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : "tmux";
})();

export function buildOrcaCreateArgv({ role, session, cwd, socket, tmuxBin }) {
  return [
    "terminal",
    "create",
    "--worktree",
    `path:${cwd}`,
    "--title",
    role,
    "--command",
    `${tmuxBin} -L ${socket} attach -t ${session}`,
    "--focus",
    "--json",
  ];
}

function parseOrcaJson(result) {
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse((result.stdout || "").trim());
    return parsed?.ok === true ? parsed : null;
  } catch {
    return null;
  }
}

function orcaWindowCreate({ bin, role, session, cwd, socket, tmuxBin, spawnFn }) {
  const run = (argv) => spawnFn(bin, argv, { encoding: "utf8" });
  const listed = parseOrcaJson(run(["terminal", "list", "--json"]));
  if (!listed) return { ok: false, code: "ORCA_TERMINAL_LIST_FAILED" };
  const terminals = Array.isArray(listed.result?.terminals) ? listed.result.terminals : [];
  const visualLayouts = Array.isArray(listed.result?.visualLayouts)
    ? listed.result.visualLayouts
    : [];
  const visualHandle = visualLayouts
    .flatMap((layout) =>
      layout.root && Array.isArray(layout.root.tabs) ? layout.root.tabs : []
    )
    .find((tab) => tab.title === role)?.panes?.handle;
  const existing = terminals.find(
    (terminal) =>
      (terminal.title === role || terminal.handle === visualHandle) &&
      terminal.connected === true &&
      terminal.orphaned !== true
  );
  if (existing) return { ok: true, handle: existing.handle, reused: true };

  if (!parseOrcaJson(run(["repo", "add", "--path", cwd, "--json"]))) {
    return { ok: false, code: "ORCA_REPO_ADD_FAILED" };
  }
  const created = parseOrcaJson(
    run(buildOrcaCreateArgv({ role, session, cwd, socket, tmuxBin }))
  );
  const handle = created?.result?.terminal?.handle;
  if (!handle) return { ok: false, code: "ORCA_TERMINAL_HANDLE_MISSING" };
  return { ok: true, handle, reused: false };
}

export function clientAttached(session) {
  const result = tmux(["list-clients", "-t", session, "-F", "#{client_pid}"]);
  return result.status === 0 && result.stdout.trim().length > 0;
}

function waitForClientDefault(session, tries = 12) {
  for (let i = 0; i < tries; i++) {
    if (clientAttached(session)) return true;
    spawnSync("sleep", ["0.5"]);
  }
  return false;
}

export function openWindow(session, platform = process.platform, deps = {}) {
  const choice = deps.choice;
  if (choice?.error || platform !== "darwin" || choice?.kind === "none") {
    return { method: "manual" };
  }
  const spawnFn = deps.spawnFn ?? spawnSync;
  const waitForClient = deps.waitForClient ?? waitForClientDefault;
  if (choice?.kind === "rottie") {
    const result = rottieCreate(
      deps.rottieBin ?? process.env.KADAN_ROTTIE_BIN,
      buildRottieCreateArgv({
        role: deps.role ?? session,
        session,
        cwd: deps.cwd ?? process.cwd(),
        socket: deps.socket ?? SOCKET,
        panePid: deps.panePid ?? "unknown",
      }),
      spawnFn
    );
    if (!result.ok) {
      console.error(`창 rottie 실패: ${result.code}`);
      return null;
    }
    if (!waitForClient(session)) {
      console.error("창 rottie: 패널은 만들어졌으나 tmux 클라이언트 미접속");
      return null;
    }
    return { method: "rottie", rottieTerminalId: result.id };
  }

  const result = orcaWindowCreate({
    bin: deps.orcaBin ?? process.env.KADAN_ORCA_BIN,
    role: deps.role ?? session,
    session,
    cwd: deps.cwd ?? process.cwd(),
    socket: deps.socket ?? SOCKET,
    tmuxBin: deps.tmuxBin ?? TMUX_BIN,
    spawnFn,
  });
  if (!result.ok) {
    console.error(`창 orca 실패: ${result.code}`);
    return null;
  }
  if (!waitForClient(session)) {
    console.error("창 orca: 탭은 만들어졌으나 tmux 클라이언트 미접속");
    return null;
  }
  return {
    method: "orca",
    orcaTerminalHandle: result.handle,
    reused: result.reused,
  };
}

export function buildTmuxCreateArgv({ session, role, cwd, cmd }) {
  const environmentRole = session.startsWith("kadan-")
    ? session.slice("kadan-".length)
    : role;
  return [
    "new-session",
    "-d",
    "-s",
    session,
    "-c",
    cwd,
    "-e",
    `KADAN_ROLE=${environmentRole}`,
    ...(cmd ? [cmd] : []),
  ];
}

function create({ session, role, cwd, cmd }) {
  ensureTmuxConf();
  const result = tmux(buildTmuxCreateArgv({ session, role, cwd, cmd }));
  if (result.status !== 0) {
    throw new Error(`세션 생성 실패: ${(result.stderr || "").trim()}`);
  }
  spawnSync("sleep", ["0.3"]);
  if (!hasSession(session)) {
    throw new Error(
      `세션이 만들어지자마자 죽었다 — 명령이 실패한 것 같다: ${cmd ?? "(기본 셸)"}`
    );
  }
  const outputLog = attachOutputLog(session);
  return {
    panePid: panePid(session),
    ...(outputLog ? { outputLog } : {}),
  };
}

function checkPaneMode(session, run) {
  let mode;
  try {
    mode = run(["display-message", "-p", "-t", `=${session}:`, "#{pane_in_mode}"]);
    if (typeof mode !== "string" || !/^\d+$/.test(mode.trim())) throw new Error("pane_in_mode 응답 없음 또는 잘못된 값");
  } catch (cause) {
    const error = new Error(`전송 보류: 기록보기 모드 조회 실패 — ${cause.message}`, {cause});
    error.code = "KADAN_PANE_MODE_UNKNOWN";
    throw error;
  }
  if (Number(mode.trim()) !== 0) {
    const error = new Error("전송 보류: 기록보기(복사모드 등) 중 — 선택·스크롤을 유지합니다");
    error.code = "KADAN_PANE_IN_MODE";
    throw error;
  }
}

// 본문 없이 Enter 한 키만 보낸다 — 입력 큐 배너의 대기 메시지 전송에만 쓴다.
export function sendTmuxEnter(session, {run = tmuxOut} = {}) {
  checkPaneMode(session, run);
  run(["send-keys", "-t", session, "Enter"]);
  return {keyDelivery:"sent", inputAcceptance:"unconfirmed"};
}

export function sendTmux(session, text, {run = tmuxOut, spawn = spawnSync, pid = process.pid, hrtime = process.hrtime.bigint} = {}) {
  const buffer = `kadan-send-${pid}-${hrtime().toString(36)}`;
  let stage = "not-started";
  let loaded = false;
  const checkMode = () => checkPaneMode(session, run);
  try {
    checkMode();
    run(["load-buffer", "-b", buffer, "-"], text);
    loaded = true;
    checkMode();
    stage = "paste-attempted";
    run(["paste-buffer", "-d", "-b", buffer, "-t", session]);
    loaded = false;
    stage = "body-pasted";
    spawn("sleep", ["0.4"]);
    checkMode();
    stage = "enter-attempted";
    run(["send-keys", "-t", session, "Enter"]);
  } catch (error) {
    error.delivery = stage === "not-started" ? "not-sent" : "unknown";
    error.sendStage = stage;
    error.inputAcceptance = "unconfirmed";
    if (stage !== "not-started") error.message += " — 본문 전송을 시도했으나 입력 제출 미확인; 본문/Enter 자동 재전송 금지";
    if (loaded) {
      try {
        run(["delete-buffer", "-b", buffer]);
      } catch (cleanupError) {
        const combined = new AggregateError([error, cleanupError], `${error.message}; 본인 전송 버퍼 정리도 실패`);
        Object.assign(combined, {code:error.code, delivery:error.delivery, sendStage:stage, inputAcceptance:"unconfirmed"});
        throw combined;
      }
    }
    throw error;
  }
  return {keyDelivery:"sent", inputAcceptance:"unconfirmed"};
}

function stop(session) {
  const result = tmux(["kill-session", "-t", `=${session}`]);
  if (result.status !== 0) {
    throw new Error(`종료 실패: ${(result.stderr || "").trim()}`);
  }
}

function list() {
  const result = tmux([
    "list-sessions",
    "-F",
    "#{session_name}\t#{session_attached}\t#{session_created}",
  ]);
  if (result.status !== 0) return [];
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [session, attached, created] = line.split("\t");
      return {
        session,
        alive: true,
        pid: panePid(session),
        attached,
        created: Number(created),
      };
    });
}

function waitForChange(_session, ms) {
  spawnSync("sleep", [String(ms / 1000)]);
  return null;
}

export const tmuxFloor = {
  name: "tmux",
  create,
  alive: hasSession,
  pid: panePid,
  send: sendTmux,
  sendEnter: sendTmuxEnter,
  read: capturePane,
  stop,
  list,
  waitForChange,
  attach(session) {
    return `tmux -L ${currentSocket()} attach -t ${session}`;
  },
};
