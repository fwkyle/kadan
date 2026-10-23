// tmux 바닥 — 만들기·생존·PID·전달·읽기·종료·목록·변화 대기를 전담한다.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { matchesAiProcess } from "./ai-identity.mjs";
import { splitGhostText } from "./ghost-text.mjs";
import { inlineScreenEnv } from "./inline-screen.mjs";
import { ledgerHome } from "./ledger.mjs";
import { assertNotLiveFloor } from "./live-floor-guard.mjs";
import { assertRottieArgv } from "./rottie-cli.mjs";
import { HUMAN_IDLE_MS, forcedIdleMsFor } from "./notification-guard.mjs";

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
  assertNotLiveFloor();
  const conf = tmuxConfPath();
  const prefixArgs = fs.existsSync(conf) ? ["-f", conf] : [];
  // -u: LANG 없는 서버·컨테이너에서도 한글 세션 이름과 탭 구분자를 '_'로 바꾸지 않게 한다.
  return spawnSync("tmux", ["-u", "-L", currentSocket(), ...prefixArgs, ...args], {
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

// 세션의 모든 창·화면 상태. 'dead'(전부 프로세스 없음) | 'live'(전부 살아 있음) | 'mixed'(일부만 죽음) | 'unknown'(조회 실패·세션 없음).
// 살아 있는 화면이 하나라도 있으면 세션을 지우면 안 되므로, 첫 화면만 보지 않고 -s로 세션 전체를 본다.
export function paneState(session) {
  const result = tmux(["list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_dead}"]);
  if (result.status !== 0) return "unknown";
  const flags = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!flags.length || flags.some((flag) => flag !== "0" && flag !== "1")) return "unknown";
  const dead = flags.filter((flag) => flag === "1").length;
  return dead === flags.length ? "dead" : dead === 0 ? "live" : "mixed";
}

// 죽은 창의 마지막 화면(스크롤 기록 포함 뒤쪽 lines줄).
export function captureTail(session, lines = 200) {
  const result = tmux(["capture-pane", "-p", "-S", `-${lines}`, "-t", `=${session}:`]);
  return result.status === 0 ? result.stdout : "";
}

// 화면을 -e(색 포함)로 한 번만 떠서 판정용·표시용 글자를 함께 낸다(ghost-text.mjs). 조회 실패는 null.
function captureSplit(session) {
  const result = tmux(["capture-pane", "-e", "-p", "-t", `=${session}:`]);
  return result.status === 0 ? splitGhostText(result.stdout) : null;
}

// 판정용: 입력칸의 흐린 추천 문구를 뺀 화면. 감시기·완료 판정은 모두 이것만 읽는다.
export function capturePane(session) {
  return captureSplit(session)?.judge ?? "";
}

// 표시용(kadan read): 입력칸의 흐린 추천 문구를 `(추천 문구: …)`로 보인다.
export function capturePaneView(session) {
  return captureSplit(session)?.view ?? "";
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
  const result = tmux(["pipe-pane", "-t", `=${session}:`, `${compressed?'gzip -1c':'cat'} >> '${quoted}'`]);
  if (result.status !== 0) {
    console.error(`경고: 출력 로그 설정 실패: ${(result.stderr || "").trim()}`);
    return null;
  }
  return outLog;
}

export function buildRottieCreateArgv({ role, session, cwd, socket, panePid: pid, command, idempotencyKey }) {
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
    idempotencyKey ?? `kadan-${session}-${pid}`,
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

// 탭 상태를 묻는다. 데몬에 없는 탭은 로티가 unknown으로, 지운 탭은 ROTTIE_TERMINAL_NOT_FOUND로 돌려준다
// (로티 CLI terminal show, 2026-09-23 실측).
export function showRottieWindow({ bin, terminalId, spawnFn = spawnSync }) {
  try {
    const result = spawnFn(bin, ["terminal", "show", "--terminal", terminalId, "--json"], { encoding: "utf8" });
    let reply;
    try {
      reply = JSON.parse(result.stdout || "{}");
    } catch {
      // Non-JSON failures still carry the process exit status.
    }
    const state = reply?.result?.terminal?.state;
    if (reply?.ok === true && typeof state === "string") return { ok: true, state };
    return { ok: false, code: reply?.error?.code || result.error?.code || result.status || "ROTTIE_SHOW_FAILED" };
  } catch (error) {
    return { ok: false, code: error.code || "ROTTIE_SHOW_FAILED" };
  }
}

function rottieCreate(bin, argv, spawnFn) {
  const run = (args) => { assertRottieArgv(args); return spawnFn(bin, args, { encoding: "utf8" }); };
  let result = run(argv);
  let parsed = parseRottieCreateResult((result.stdout || "").trim());
  if (!parsed.ok && parsed.code === "ROTTIE_WORKSPACE_NOT_OPEN") {
    run(["workspace", "add", "--path", argv[argv.indexOf("--workspace") + 1] ?? process.cwd(), "--json"]);
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

// 창을 연 뒤 "탭이 붙었나"만 본다. 제어 모드(`tmux -C`) 연동 client도 일부러 센다: Rottie 연동 탭은 중계(제어 client)만 붙는다.
// 사람 입력 판정은 이것이 아니라 checkHumanIdle이고, 제어 client는 거기서 입력으로 세지 않는다(tests/control-client-attach.test.mjs).
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
    const create = (idempotencyKey) => rottieCreate(
      deps.rottieBin ?? process.env.KADAN_ROTTIE_BIN,
      buildRottieCreateArgv({
        role: deps.role ?? session,
        session,
        cwd: deps.cwd ?? process.cwd(),
        socket: deps.socket ?? SOCKET,
        panePid: deps.panePid ?? "unknown",
        idempotencyKey,
      }),
      spawnFn
    );
    let result = create(deps.idempotencyKey);
    // 로티는 지운 탭의 키도 기억한다. 같은 세션을 다른 인자로 다시 열면 키 충돌이라 새 키로 한 번만 다시 연다.
    if (!result.ok && result.code === "ROTTIE_IDEMPOTENCY_CONFLICT" && deps.conflictKeySuffix) {
      result = create(`kadan-${session}-${deps.panePid ?? "unknown"}-${deps.conflictKeySuffix}`);
    }
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

// home: 역할 프로세스가 KADAN_HOME을 물려받게 한다(Stop 훅이 감시기와 같은 spool 폴더를 쓰도록). 없으면 넣지 않는다.
export function buildTmuxCreateArgv({ session, role, cwd, cmd, home }) {
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
    ...(home ? ["-e", `KADAN_HOME=${home}`] : []),
    ...inlineScreenEnv(cmd).flatMap(value => ["-e", value]),
    ...(cmd ? [cmd] : []),
  ];
}

function create({ session, role, cwd, cmd }) {
  ensureTmuxConf();
  const result = tmux(buildTmuxCreateArgv({ session, role, cwd, cmd, home: process.env.KADAN_HOME }));
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

// release: 감시기 알림의 5번째 강제 차례만 쓴다. 복사 모드에서 키를 보내면 tmux가 복사 모드 명령으로 읽으므로
// 먼저 빠져나온 뒤 다시 확인해, 그래도 모드면 넣지 않는다. 해제했으면 true를 돌려준다.
function checkPaneMode(session, run, {release = false} = {}) {
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
    if (release) {
      // 모드 종류가 달라 cancel이 실패해도 아래 재확인이 모드를 보고 넣을지 정한다.
      try { run(["send-keys", "-t", `=${session}:`, "-X", "cancel"]); } catch { /* 재확인에서 판정 */ }
      checkPaneMode(session, run);
      return true;
    }
    const error = new Error("전송 보류: 기록보기(복사모드 등) 중 — 선택·스크롤을 유지합니다");
    error.code = "KADAN_PANE_IN_MODE";
    throw error;
  }
}

// 본문 없이 Enter 한 키만 보낸다 — 입력 큐 배너의 대기 메시지 전송에만 쓴다.
export function sendTmuxEnter(session, {run = tmuxOut} = {}) {
  checkPaneMode(session, run);
  run(["send-keys", "-t", `=${session}:`, "Enter"]);
  return {keyDelivery:"sent", inputAcceptance:"unconfirmed"};
}

// 사람 보호는 이것 하나다(2026-10-17 [kyle] 결정). 화면 모양(프롬프트·자리표시자·테두리·바닥글)을 읽어
// 미제출 글을 판정하던 장치는 실행기 업데이트마다 빈 입력창을 오판해 발령과 알림을 막아 없앴다.
// 창에 붙은 사람이 humanIdleMs 안에 키를 눌렀으면 보류한다. 붙은 client가 없으면 통과한다.
// 붙기만 한 client는 사람 입력이 아니다: tmux는 붙는 순간 client_activity를 client_created와 같게 두고
// (격리 소켓 실측 2026-10-17: 크기 바꾸기·paste-buffer·send-keys로는 안 변하고 그 client의 키 입력으로만 변한다),
// 제어 모드 client는 명령을 보내도 변하지 않는다. 그래서 활동이 생성 시각보다 뒤일 때(`activity > created`, 초 단위라 차이 1초 이상)만 입력으로 센다.
// 받아들인 손해: 사람이 글을 치다 그 시간 넘게 손을 떼면 그 글 뒤에 우편이 붙어 제출될 수 있고,
// 붙은 바로 그 초 안에 누른 키는 놓친다. 반대로 붙은 뒤 터미널 응답 같은 입력이 다음 초에 들어와 활동이 바뀌면 그 창은 입력 보호 시간(기본 30초, 슈퍼감독 창은 2분)만큼 보류된다. kadan의 붙여넣기(paste-buffer)는 client_activity를 바꾸지 않는다.
function checkHumanIdle(session, run, {humanIdleMs = HUMAN_IDLE_MS, now} = {}) {
  const deny = (code, message) => { const error = new Error(message); error.code = code; throw error; };
  const clients = run(["list-clients", "-t", `=${session}`, "-F", "#{client_created} #{client_activity}"]).split("\n").filter(Boolean);
  if (clients.some(value => !/^\d+ \d+$/.test(value))) deny("KADAN_HUMAN_ACTIVITY_UNKNOWN", "전송 보류: 사람 입력 시각 미확인 — 잠시 뒤 다시 보내라");
  const at = now ?? Date.now();
  const typed = clients.map(value => value.split(" ").map(Number)).filter(([created, activity]) => activity > created);
  if (typed.some(([, activity]) => at - activity * 1000 < humanIdleMs)) deny("KADAN_HUMAN_ACTIVE", "전송 보류: 사람이 이 창에서 최근 입력함 — 잠시 뒤 다시 보내라");
  if (relayedHumanInputRecent(session, run, at, humanIdleMs)) deny("KADAN_HUMAN_ACTIVE", "전송 보류: 사람이 이 창에서 최근 입력함 — 잠시 뒤 다시 보내라");
}

// 중계(Rottie H3 탭)가 사람 바이트를 받을 때 세션 옵션 `@kadan_human_input`(epoch 초)을 남긴다. 중계가 붙인 client의
// client_activity는 사람 키로 바뀌지 않으므로 같은 창(humanIdleMs)으로 합산한다. 옵션이 없거나 숫자가 아니거나
// 지금보다 60초 넘게 앞선 값(시계 오류)은 무시해 오늘과 같게 동작한다. 읽기는 show-options -qv다(없으면 빈 출력, 오류 아님):
// 세션 옵션 명령은 `=세션`을 거부하고 `=세션:`만 받는다. display-message는 쓰지 않는다 — 복사모드 시험이 그 호출 횟수를 센다(tmux 3.6a 격리 소켓 실측 2026-10-19).
const HUMAN_INPUT_FUTURE_SKEW_MS = 60_000;
let humanInputReadWarned = false; // 경고는 프로세스당 한 줄(감시 순회마다 쌓이지 않게)
function relayedHumanInputRecent(session, run, at, humanIdleMs) {
  // 부가 표시라 읽기 실패가 전송·알림을 막지 않는다(검수 TP-R P2-3). 표시 없음으로 보고 기존 client_activity 판정만 따른다.
  let raw;
  try { raw = String(run(["show-options", "-t", `=${session}:`, "-qv", "@kadan_human_input"]) ?? "").trim(); }
  catch (error) {
    if (!humanInputReadWarned) { humanInputReadWarned = true; process.stderr.write(`kadan: @kadan_human_input 읽기 실패 — 표시 없음으로 처리: ${error.message}\n`); }
    return false;
  }
  if (!/^\d{1,12}$/.test(raw)) return false;
  const ms = Number(raw) * 1000;
  return ms - at <= HUMAN_INPUT_FUTURE_SKEW_MS && at - ms < humanIdleMs;
}

// 카드는 pane 종료·PID·AI 프로세스를 확인하고 사람 입력 시각을 본다. 기존 복사모드 검사는 그대로 둔다.
function checkCardPane(session, identity, run, spawn, humanIdleMs) {
  const deny = (code, message) => { const error = new Error(message); error.code = code; throw error; };
  const state = run(["display-message", "-p", "-t", `=${session}:`, "#{pane_pid}|#{pane_dead}"]).trim();
  if (!/^\d+\|[01]$/.test(state)) deny("KADAN_PANE_STATE_UNKNOWN", "카드 전송 불가: pane 상태 미확인");
  const [pid, dead] = state.split("|");
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
  checkHumanIdle(session, run, {humanIdleMs});
}

// 감시기 알림도 사람의 입력을 덮지 않는다(2026-09-23 미확인 우편 알림이 kyle의 입력 중 문장에 붙어 제출된 사고).
function checkNotificationPane(session, guard, run) {
  // 감시기가 5번 연속 밀린 알림을 넣는 차례다(2026-10-13). 기록보기 확인은 sendTmux가 따로 한다.
  // 보호가 30초보다 긴 창(슈퍼감독)은 마지막 입력 뒤 30초는 기다리고, 30초인 창은 입력 보호를 건너뛴다(2026-10-22 [kyle] 결정 B).
  if (guard.force === true) {
    const idle = forcedIdleMsFor(guard.humanIdleMs);
    if (idle === null) return;
    return checkHumanIdle(session, run, {...guard, humanIdleMs: idle});
  }
  checkHumanIdle(session, run, guard);
}

// 붙여넣지 않고 알림 보류 사유만 돌려준다. 감시기가 예약 기록 전에 확인해 순회마다 기록이 쌓이지 않게 한다.
export function notificationHold(session, guard, {run = tmuxOut} = {}) {
  // 강제 차례는 복사 모드를 해제하고 넣으므로 복사 모드 때문에 미리 밀지 않는다. 사람 입력 확인은 그대로 한다.
  try { if (guard.force !== true) checkPaneMode(session, run); checkNotificationPane(session, guard, run); return null; }
  catch (error) { return {code: error.code ?? "KADAN_NOTIFY_CHECK_FAILED", message: error.message}; }
}

// Claude Code의 '폴더 신뢰' 확인 창은 기본 선택이 "No, exit"라, 우리가 보내는 Enter가 그걸 눌러 역할이 종료된다
// (2026-10-23 rottie 작업자 3명 소실). 문구만 보면 대화에 문구를 인용한 정상 화면도 막히고(검수 F1), '정상 입력창이 있나'를
// 찾는 방식은 감시기의 상태 판정과 얽혀 경계가 계속 나왔다(F4·F5). 그래서 기준점을 '화면의 맨 끝'으로 둔다.
// 근거: 사고 원본 화면은 `Enter to confirm · Esc to cancel`이 마지막 줄이고 그 아래는 빈 줄뿐이다. 모달은 화면 맨 끝에 그려지고,
// 문구를 인용한 정상 화면은 언제나 그 아래에 다른 글(입력창·상태 줄·진행 표시)이 이어진다.
// 판정(모두 참일 때만): (1) 끝의 빈 줄(공백만 있는 줄 포함)을 걷는다. (2) 비지 않은 마지막 줄이 확인 안내 `Enter to confirm`이다
// (좁은 폭에서 안내가 여러 줄로 감기면 그 뒤에 `· Esc to cancel`의 나머지만 남을 수 있다). (3) 확인 안내에서 위로 가장 가까운
// `Yes, I trust this folder` → `No, exit` → 질문 `Is this a project you created or one you trust`가 이 순서(질문 → No → Yes → 안내)로 있다.
// 첫 질문이 아니라 안내에 가장 가까운 묶음을 쓰므로, 위쪽의 인용이나 옛 창이 판정을 바꾸지 못한다.
// 범위는 비지 않은 마지막 60줄이다: 폭 10글자로 줄이 감기면 사고 화면이 비지 않은 57줄이 된다(검수 F6). 높이가 큰 창의 아래 빈 줄은
// 먼저 걷으므로 줄 수에 들지 않는다(F2). 줄바꿈으로 낱말이 갈리거나 화면 기록에서 공백이 빠진 꼴이 있어 문구는 공백을 모두 걷고 비교한다.
// Yes가 위에 오는 옛 배치는 기본 선택이 Yes라 Enter가 해롭지 않아 막지 않는다.
const TRUST_QUESTION = "Isthisaprojectyoucreatedoroneyoutrust";
const TRUST_NO = "No,exit", TRUST_YES = "Yes,Itrustthisfolder", TRUST_CONFIRM = "Entertoconfirm";
const TRUST_CONFIRM_REST = /^[·•\-–—]*(?:esc(?:to(?:cancel)?)?)?$/iu;
const TRUST_PROMPT_TAIL_LINES = 60;
// capture-pane -p는 제어 시퀀스를 내지 않지만, 재생·기록 화면 끝에는 터미널 응답 찌꺼기(`ESC[?1;2;4c` 등)가 줄 하나로 붙어 있었다(사고 화면 파일).
// 그런 줄이 '맨 끝 줄'을 가로채 모달을 놓치지 않게 제어 시퀀스를 먼저 걷는다.
const CONTROL_SEQUENCES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|P[\s\S]*?\x1b\\|[()][A-Za-z0-9]|[78=>])|[\x00-\x08\x0b-\x1f\x7f]/gu;
export function hasTrustPrompt(screen) {
  if (typeof screen !== "string") return false;
  const flat = screen.replace(CONTROL_SEQUENCES, "").split("\n").filter(line => line.trim() !== "").slice(-TRUST_PROMPT_TAIL_LINES).join("").replace(/\s+/gu, "");
  const confirm = flat.lastIndexOf(TRUST_CONFIRM);
  if (confirm < 0 || !TRUST_CONFIRM_REST.test(flat.slice(confirm + TRUST_CONFIRM.length))) return false;
  const yes = flat.lastIndexOf(TRUST_YES, confirm);
  const no = yes < 0 ? -1 : flat.lastIndexOf(TRUST_NO, yes);
  return no >= 0 && flat.lastIndexOf(TRUST_QUESTION, no) >= 0;
}

// 보내기 직전 화면을 한 번 읽는다(비용: tmux capture-pane 1회). 읽기에 실패하면 지금까지처럼 보낸다 —
// 이 검사가 새 전송 실패 원인이 되지 않게 하려는 것이다(실패 닫힘은 '확인 창이 보일 때'에만 적용한다).
function checkTrustPrompt(session, run) {
  let screen;
  try { screen = run(["capture-pane", "-p", "-J", "-t", `=${session}:`]); }
  catch { return; }
  if (!hasTrustPrompt(screen)) return;
  const error = new Error("전송 보류: 받는 Claude가 폴더 신뢰 확인 창에 멈춰 있다 — 보내면 Enter가 \"No, exit\"를 눌러 역할이 종료된다. " +
    "사람이 창에서 직접 고르거나, 역할을 작업 저장소 폴더에서 다시 시작하라");
  error.code = "KADAN_TRUST_PROMPT";
  throw error;
}

export function sendTmux(session, text, {run = tmuxOut, spawn = spawnSync, pid = process.pid, hrtime = process.hrtime.bigint, cardIdentity, notificationGuard, humanIdleMs} = {}) {
  const buffer = `kadan-send-${pid}-${hrtime().toString(36)}`;
  let stage = "not-started";
  let loaded = false;
  const checkMode = () => checkPaneMode(session, run);
  // 카드·알림·일반 우편이 같은 사람 입력 시각 기준을 쓴다. 알림 보호 객체가 없는 카드·일반 우편은
  // 호출자(guardedSend)가 받는 역할에 맞춰 넘긴 humanIdleMs를 쓴다. 안 넘기면 기본 30초다(슈퍼감독 2분, 2026-10-22).
  const checkSendPane = () => {
    if (cardIdentity) checkCardPane(session, cardIdentity, run, spawn, humanIdleMs);
    else if (notificationGuard) checkNotificationPane(session, notificationGuard, run);
    else checkHumanIdle(session, run, {humanIdleMs});
  };
  let released = false;
  try {
    checkTrustPrompt(session, run);
    // 감시기 알림이 5번 밀린 강제 차례에 한해 복사 모드를 해제하고 넣는다(2026-10-14).
    if (notificationGuard?.force === true && !cardIdentity) {
      // 사람 입력으로 밀릴 차례면 복사 모드를 건드리기 전에 먼저 멈춘다.
      checkSendPane();
      released = checkPaneMode(session, run, {release: true});
    } else checkMode();
    checkSendPane();
    run(["load-buffer", "-b", buffer, "-"], text);
    loaded = true;
    checkMode();
    checkSendPane();
    stage = "paste-attempted";
    // -p: 괄호 붙여넣기. 없으면 Claude Code가 본문 줄바꿈과 뒤따르는 Enter를 구분하지 못해
    // 짧은 본문에서 Enter가 먹힌다(2026-09-23 실측: 2초 뒤 Enter도 누락, -p면 0.4초도 제출).
    run(["paste-buffer", "-p", "-d", "-b", buffer, "-t", `=${session}:`]);
    loaded = false;
    stage = "body-pasted";
    spawn("sleep", ["1"]);
    checkMode();
    // 붙여넣기와 Enter 사이 1초에 사람이 치면 그 글과 함께 제출된다. Enter 직전에 같은 사람 입력 검사를 한 번 더 한다.
    // 거부되면 본문은 이미 붙었으므로 지우지 않고 Enter만 보내지 않는다(stage가 body-pasted라 아래 catch가 delivery=unknown을 붙인다).
    // 5번째 강제 알림은 앞 검사와 같은 기준이다: 보호가 30초인 창은 건너뛰고, 슈퍼감독 창은 30초를 다시 본다.
    try {
      if (cardIdentity || !notificationGuard) checkHumanIdle(session, run, {humanIdleMs});
      else checkNotificationPane(session, notificationGuard, run);
    } catch (error) { error.enterWithheld = true; throw error; }
    stage = "enter-attempted";
    run(["send-keys", "-t", `=${session}:`, "Enter"]);
  } catch (error) {
    error.delivery = stage === "not-started" ? "not-sent" : "unknown";
    error.sendStage = stage;
    error.inputAcceptance = "unconfirmed";
    if (error.enterWithheld) error.message += " — 본문은 붙었고 Enter는 보내지 않음; 본문/Enter 자동 재전송 금지";
    else if (stage !== "not-started") error.message += " — 본문 전송을 시도했으나 입력 제출 미확인; 본문/Enter 자동 재전송 금지";
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
  return {keyDelivery:"sent", inputAcceptance:"unconfirmed", ...(released ? {copyModeReleased:true} : {})};
}

function stop(session) {
  const result = tmux(["kill-session", "-t", `=${session}`]);
  if (result.status !== 0) {
    throw new Error(`종료 실패: ${(result.stderr || "").trim()}`);
  }
}

function list({ strict = false } = {}) {
  const result = tmux([
    "list-sessions",
    "-F",
    "#{session_name}\t#{session_attached}\t#{session_created}",
  ]);
  if (result.status !== 0) {
    if (strict) throw new Error('tmux 세션 목록 조회 실패: 생존 상태 모름');
    return [];
  }
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
  readView: capturePaneView,
  stop,
  list,
  waitForChange,
  attach(session) {
    return `tmux -L ${currentSocket()} attach -t ${session}`;
  },
};
