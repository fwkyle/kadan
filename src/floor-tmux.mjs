// tmux 바닥 — 만들기·생존·PID·전달·읽기·종료·목록·변화 대기를 전담한다.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { matchesAiProcess } from "./ai-identity.mjs";
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

export function outputLogPath(session, home = ledgerHome(), compressed = true) {
  return path.join(home, "out", `${session}.log${compressed?'.gz':''}`);
}

function attachOutputLog(session) {
  // 새 출력만 압축한다. 기존 원문 로그·완료 마커를 읽는 화면 경로는 그대로 둔다.
  const compressed=spawnSync("gzip",["--version"],{stdio:"ignore",timeout:1000}).status===0;
  if(!compressed)console.error("경고: gzip 사용 불가 — 출력은 원문 .log로 보존합니다");
  const outLog = outputLogPath(session,ledgerHome(),compressed);
  try {
    fs.mkdirSync(path.dirname(outLog), { recursive: true });
  } catch (error) {
    console.error(`경고: 출력 폴더 생성 실패: ${error.message}`);
    return null;
  }
  const quoted = outLog.replace(/'/g, "'\\''");
  const result = tmux(["pipe-pane", "-t", session, `${compressed?'gzip -1c':'cat'} >> '${quoted}'`]);
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

// close는 프로세스만 끝내고 탭을 '종료됨'으로 남긴다. 목록·화면에서 지우는 것은 remove다
// (로티 CLI 2026-09-11). 살아 있는 탭은 로티가 ROTTIE_TERMINAL_RUNNING으로 거부하므로 종료 신호 부작용이 없다.
export function removeRottieWindow({ bin, terminalId, spawnFn = spawnSync }) {
  try {
    const result = spawnFn(bin, ["terminal", "remove", "--terminal", terminalId, "--json"], { encoding: "utf8" });
    if (result.status === 0) return { removed: true };
    let error;
    try {
      error = JSON.parse(result.stdout || "{}").error;
    } catch {
      // Non-JSON failures still carry the process exit status and stderr.
    }
    return {
      removed: false,
      code: error?.code || result.error?.code || result.status || "ROTTIE_REMOVE_FAILED",
      message: error?.message || result.error?.message || (result.stderr || "").trim() || "Rottie terminal remove failed",
    };
  } catch (error) {
    return { removed: false, code: error.code || "ROTTIE_REMOVE_FAILED", message: error.message || String(error) };
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

// 카드 입력창 판별. 추측으로 넣지 않고 실제 화면에서 확인한 형태만 둔다(2026-09-23 실측).
// - 빈 입력 자리표시자: devin v3000.11.1, codex v0.155.0. 작업 중 자리표시자(Guide Devin…)는 빈 입력이 아니다.
// - 입력 상자 경계(devin·claude): 0열에서 pane 폭을 꽉 채우는 가로줄. 입력의 이어지는 줄은 들여쓰기되므로
//   사용자 글이 이 모양이 될 수 없다. 윗줄에는 devin처럼 `(bypass permissions on)` 표지가 섞인다.
const PROMPT_LINE = /^\s*[│┃]?[ \t]*[›>❯❭](.*)$/u;
const EMPTY_INPUT_PLACEHOLDERS = new Set(["Ask Devin to build features, fix bugs, or work on your code", "Ask Codex to do anything"]);
// claude-code v2.1.280: 새 창 입력창에 흐린 글씨(SGR 2)로 `Try "…"` 예시가 뜬다. 문구는 매번 바뀌어 모양으로만 맞춘다(2026-09-23 실측).
const CLAUDE_PLACEHOLDER = /^Try "[^"\n]+"$/u;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/gu;
// 입력칸 글이 모두 흐린 글씨(SGR 2)면 실행기가 띄운 예시·추천 문구다. 사람이 친 글은 흐리지 않다.
// claude-code는 새 창의 `Try "…"` 예시와 작업 뒤 "다음 입력 추천"을 흐리게 띄운다(2026-09-23 capture -e 실측).
function allDimAfterPrompt(raw = "") {
  let dim = false, prompt = false, seen = false;
  for (let i = 0; i < raw.length;) {
    const sgr = raw.slice(i).match(/^\x1b\[([0-9;?]*)([A-Za-z])/u);
    if (sgr) {
      if (sgr[2] === "m") for (const code of (sgr[1] || "0").split(";")) {
        if (code === "2") dim = true;
        else if (code === "" || code === "0" || code === "22") dim = false;
      }
      i += sgr[0].length;
      continue;
    }
    const ch = String.fromCodePoint(raw.codePointAt(i));
    i += ch.length;
    if (!prompt) { prompt = /[›>❯❭]/u.test(ch); continue; }
    if (/\s/u.test(ch)) continue;
    if (!dim) return false;
    seen = true;
  }
  return seen;
}
const isInputRule = (line, width, labelled) => [...line].length === width && (labelled ? /^─.*─$/u : /^─+$/u).test(line);

// 화면에 보이는 입력창이 비었는지 확인한다. 카드 전송과 감시기 알림이 같은 기준을 쓴다.
function checkEmptyInput(session, run, row, width, label) {
  const deny = (code, message) => { const error = new Error(message); error.code = code; throw error; };
  // 글자 모양(-e)까지 읽어 흐린 추천 문구와 사람이 친 글을 가른다. 판단은 모양을 뺀 글로 한다.
  const raw = run(["capture-pane", "-e", "-p", "-t", `=${session}:`]).split("\n");
  const lines = raw.map(line => line.replace(ANSI, ""));
  if (row >= lines.length) deny("KADAN_PANE_INPUT_UNKNOWN", `${label}: 입력 줄 미확인`);
  // 입력 줄은 커서가 있는 프롬프트 줄 하나다. 화면 전체를 훑으면 배너(`│ >_ OpenAI Codex`)나
  // 본문 인용까지 후보가 되어 실제 대기 화면을 거부한다(2026-09-23 devin·claude·codex 실측).
  const prompt = lines[row].match(PROMPT_LINE);
  if (!prompt) {
    if (lines.slice(0, row).some(line => PROMPT_LINE.test(line))) deny("KADAN_PANE_INPUT_PENDING", `${label}: 커서가 프롬프트 줄 밖이라 여러 줄 미제출 입력일 수 있음`);
    deny("KADAN_PANE_INPUT_UNKNOWN", `${label}: 현재 입력 영역의 프롬프트 미확인`);
  }
  // 위쪽 가장 가까운 글 줄도 프롬프트 모양이면 여러 줄 입력의 이어지는 줄인지 구별할 수 없다.
  if (PROMPT_LINE.test(lines.slice(0, row).findLast(line => line.trim()) ?? "")) deny("KADAN_PANE_INPUT_UNKNOWN", `${label}: 프롬프트 위 입력 경계 미확인`);
  const boxed = row > 0 && isInputRule(lines[row - 1], width, true);
  const rest = prompt[1].trim();
  if (rest && !EMPTY_INPUT_PLACEHOLDERS.has(rest) && !CLAUDE_PLACEHOLDER.test(rest) && !allDimAfterPrompt(raw[row])) deny("KADAN_PANE_INPUT_PENDING", `${label}: 미제출 입력이 있음`);
  // 상자형(devin·claude)은 바로 아래 닫는 줄 밑을 상태줄로 본다. 상자 없음(codex)은 빈 줄 뒤 상태줄 한 줄만 허용한다.
  const below = lines.slice(row + 1);
  const footer = below.findIndex(line => line.trim());
  const closed = boxed ? isInputRule(below[0] ?? "", width, false)
    : footer < 0 || (footer > 0 && below.slice(footer + 1).every(line => !line.trim()));
  if (!closed) deny("KADAN_PANE_INPUT_PENDING", `${label}: 미제출 입력 또는 빈 입력창으로 확인할 수 없는 화면`);
}

// 카드만 검사한다. 일반 우편/Enter 전용 경로와 기존 복사모드 검사는 그대로 둔다.
function checkCardPane(session, identity, run, spawn) {
  const deny = (code, message) => { const error = new Error(message); error.code = code; throw error; };
  const state = run(["display-message", "-p", "-t", `=${session}:`, "#{pane_pid}|#{pane_dead}|#{cursor_y}|#{cursor_x}|#{pane_width}"]).trim();
  if (!/^\d+\|[01]\|\d+\|\d+\|\d+$/.test(state)) deny("KADAN_PANE_STATE_UNKNOWN", "카드 전송 불가: pane 상태 미확인");
  const [pid, dead, y, , w] = state.split("|");
  if (dead !== "0") deny("KADAN_PANE_DEAD", "카드 전송 불가: 종료된 pane");
  if (pid !== String(identity.currentPid)) deny("KADAN_PID_MISMATCH", "카드 전송 불가: 검사 중 pane 세대 변경");
  const ps = spawn("ps", ["-ww", "-axo", "pid=,ppid=,pgid=,tpgid=,args="], {encoding:"utf8"});
  if (ps.status !== 0 || typeof ps.stdout !== "string") deny("KADAN_AI_PROCESS_UNKNOWN", "카드 전송 불가: 현재 프로세스 조회 실패");
  const rows = ps.stdout.split("\n").map(line => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(.+)$/)).filter(Boolean);
  const descendants = new Set([pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (descendants.has(row[2]) && !descendants.has(row[1])) { descendants.add(row[1]); changed = true; }
  }
  const foreground = rows.find(row => row[1] === pid)?.[4];
  if (!(Number(foreground) > 0) || !rows.some(row => descendants.has(row[1]) && row[3] === foreground && matchesAiProcess(row[5], identity.harness, identity.model))) {
    deny("KADAN_AI_PROCESS_UNVERIFIED", "카드 전송 불가: 현재 pane 프로세스의 AI 실행기·명시 모델이 시작 기록과 다르거나 미확인이다");
  }
  checkEmptyInput(session, run, Number(y), Number(w), "카드 전송 불가");
}

// 감시기 알림은 사람의 입력을 덮지 않는다(2026-09-23 미확인 우편 알림이 kyle의 입력 중 문장에 붙어 제출된 사고).
// 창에 붙은 사람이 최근 키를 눌렀거나 입력창에 글이 있으면 보류한다. kadan 붙여넣기는 client 활동에 잡히지 않는다.
function checkNotificationPane(session, guard, run) {
  const deny = (code, message) => { const error = new Error(message); error.code = code; throw error; };
  const state = run(["display-message", "-p", "-t", `=${session}:`, "#{cursor_y}|#{pane_width}"]).trim();
  if (!/^\d+\|\d+$/.test(state)) deny("KADAN_PANE_STATE_UNKNOWN", "알림 보류: pane 상태 미확인");
  const [y, w] = state.split("|");
  const clients = run(["list-clients", "-t", `=${session}`, "-F", "#{client_activity}"]).split("\n").filter(Boolean);
  if (clients.some(value => !/^\d+$/.test(value))) deny("KADAN_HUMAN_ACTIVITY_UNKNOWN", "알림 보류: 사람 입력 시각 미확인");
  const now = guard.now ?? Date.now();
  if (clients.some(value => now - Number(value) * 1000 < guard.humanIdleMs)) deny("KADAN_HUMAN_ACTIVE", "알림 보류: 사람이 이 창에서 최근 입력함");
  checkEmptyInput(session, run, Number(y), Number(w), "알림 보류");
}

// 붙여넣지 않고 알림 보류 사유만 돌려준다. 감시기가 예약 기록 전에 확인해 순회마다 기록이 쌓이지 않게 한다.
export function notificationHold(session, guard, {run = tmuxOut} = {}) {
  try { checkNotificationPane(session, guard, run); return null; }
  catch (error) { return {code: error.code ?? "KADAN_NOTIFY_CHECK_FAILED", message: error.message}; }
}

export function sendTmux(session, text, {run = tmuxOut, spawn = spawnSync, pid = process.pid, hrtime = process.hrtime.bigint, cardIdentity, notificationGuard} = {}) {
  const buffer = `kadan-send-${pid}-${hrtime().toString(36)}`;
  let stage = "not-started";
  let loaded = false;
  const checkMode = () => checkPaneMode(session, run);
  try {
    checkMode();
    if (cardIdentity) checkCardPane(session, cardIdentity, run, spawn);
    else if (notificationGuard) checkNotificationPane(session, notificationGuard, run);
    run(["load-buffer", "-b", buffer, "-"], text);
    loaded = true;
    checkMode();
    if (cardIdentity) checkCardPane(session, cardIdentity, run, spawn);
    else if (notificationGuard) checkNotificationPane(session, notificationGuard, run);
    stage = "paste-attempted";
    // -p: 괄호 붙여넣기. 없으면 Claude Code가 본문 줄바꿈과 뒤따르는 Enter를 구분하지 못해
    // 짧은 본문에서 Enter가 먹힌다(2026-09-23 실측: 2초 뒤 Enter도 누락, -p면 0.4초도 제출).
    run(["paste-buffer", "-p", "-d", "-b", buffer, "-t", session]);
    loaded = false;
    stage = "body-pasted";
    spawn("sleep", ["1"]);
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
  notificationHold,
  sendEnter: sendTmuxEnter,
  read: capturePane,
  stop,
  list,
  waitForChange,
  attach(session) {
    return `tmux -L ${currentSocket()} attach -t ${session}`;
  },
};
