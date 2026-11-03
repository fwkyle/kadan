// kadan board (PR4): 어느 터미널에서든 슈퍼감독들을 한 화면에 모아 보고, 고른 세션을 실시간으로 보다가 Enter로 들어가 입력한다.
// 이 명령은 새 tmux 세션·창을 만들지 않고, 키를 보내지 않고, 세션을 끄지 않는다. 읽기(capture-pane)와 붙기(attach)만 한다.
// 비용(상주 화면): 틱마다 고른 세션 하나의 capture 1회(줄 수 상한), 대시보드 summary는 15초 이상 간격,
// 현황(슈퍼감독 목록)·나이트런 정책은 시작과 r 키 때만 읽는다. 원장·카드는 (대시보드가 꺼졌을 때의 시작·r 한 번 말고는) 읽지 않는다.
import { spawnSync } from "node:child_process";
import { floor } from "../floor.mjs";
import { captureTail, currentSocket, hasSession } from "../floor-tmux.mjs";
import { assertNotLiveFloor } from "../live-floor-guard.mjs";
import { ledgerHome } from "../ledger.mjs";
import { readLedgerIncremental } from "../ledger-incremental.mjs";
import { readActiveHierarchy } from "../hierarchy-register.mjs";
import { isSuperRole, superProfiles } from "../super-role.mjs";
import { DEFAULT_PORT, readConfig } from "../quickstart.mjs";
import { die, sessionName } from "../cli-basics.mjs";
import { attachArgv, attachEnv, buildEntries, parseKeys, reduceKey, renderFrame, tailOf } from "../board-model.mjs";
import { createTerminal } from "../board-tui.mjs";

export const TICK_MS = 1500;
export const SUMMARY_MIN_MS = 15_000;
const HTTP_TIMEOUT_MS = 8_000;

export const BOARD_USAGE = "사용법: kadan board [--port 8790]  (슈퍼감독 목록 + 고른 세션 실시간 보기. Enter 들어가 입력 · v 읽기 전용 · r 새로 읽기 · q 끝)";

export function boardPort(flags, home = ledgerHome()) {
  const port = String(flags.port ?? readConfig(home).port ?? DEFAULT_PORT);
  if (!/^\d+$/.test(port) || Number(port) > 65535) die("--port는 0부터 65535까지의 정수여야 한다");
  return port;
}

export function httpJson(port, fetchFn = fetch) {
  return async (path) => {
    const res = await fetchFn(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  };
}

// 대시보드가 꺼졌을 때만: 관계표와 시작 기록의 프로필로 슈퍼감독을 정한다(이름으로 추측하지 않는다). 저장소는 모른다.
export function localSupers(home = ledgerHome()) {
  const entries = readLedgerIncremental(home);
  const parents = readActiveHierarchy(entries);
  if (!parents) return [];
  const profiles = superProfiles(entries);
  return Object.keys(parents).filter((role) => isSuperRole(role, parents, profiles))
    .sort((a, b) => a.localeCompare(b, "ko")).map((role) => ({ role, repos: null }));
}

// 슈퍼감독 목록의 출처: 대시보드 현황(/api/dashboard/status)의 supervisors.items(프로필 기준, 저장소 포함). 실패하면 localSupers.
export async function loadSupers({ fetchJson, local }) {
  try {
    const items = (await fetchJson("/api/dashboard/status"))?.supervisors?.items;
    if (Array.isArray(items))
      return { supers: items.map((i) => ({ role: i.super, repos: i.repos?.length ? i.repos : null })), source: "dashboard" };
  } catch {}
  try { return { supers: local(), source: "local" }; } catch { return { supers: [], source: "none" }; }
}

// 대시보드 값 읽기. 하나라도 실패하면 그 값만 null(뱃지 ?)이고 나머지는 그대로 쓴다.
export async function loadDashboard({ fetchJson, night = true }) {
  const settle = async (path) => { try { return await fetchJson(path); } catch { return null; } };
  const [summary, nightRepos] = await Promise.all([settle("/api/dashboard/summary"), night ? settle("/api/night/repos") : null]);
  return { summary, nightRepos };
}

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// 붙기: 지금 터미널에서 tmux client를 자식으로 실행한다(stdio 물려받음). 붙기 직전 has-session으로 다시 확인한다.
// 돌려주는 값: 붙었다가 나왔으면 {attached:true}, 안 붙었으면 {attached:false, notice}.
export function attachNow({ session, readOnly, spawn = spawnSync, has = hasSession, guard = assertNotLiveFloor,
  socket = currentSocket(), env = process.env, out = process.stdout, pause = sleepMs }) {
  if (!has(session)) return { attached: false, notice: `${session}: 세션이 사라져 들어가지 않았습니다` };
  guard();
  out.write(`${session}에 들어갑니다${readOnly ? " (읽기 전용)" : ""} · 빠져나오기: prefix d\n`);
  pause(700);
  const result = spawn("tmux", attachArgv({ session, socket, readOnly }), { stdio: "inherit", env: attachEnv(env) });
  if (result.error || result.status) return { attached: true, notice: `tmux 종료 코드 ${result.status ?? result.error?.message}` };
  return { attached: true, notice: "" };
}

export async function cmdBoard(_argv, flags) {
  if (flags.help) { console.log(BOARD_USAGE); return; }
  if (floor.name !== "tmux") { console.log("kadan board는 tmux 바닥에서만 지원합니다 (herdr 바닥은 미지원)"); return; }
  if (!process.stdin.isTTY || !process.stdout.isTTY) die("kadan board는 터미널에서 직접 실행해야 한다 (입력이 터미널이 아님)");
  const port = boardPort(flags);
  const fetchJson = httpJson(port);
  const term = createTerminal();
  const data = { supers: [], summary: null, nightRepos: null, sessions: new Set(), dashboard: "확인 중" };
  let state = { sel: 0, notice: "" }, entries = [], preview = [], busy = false, lastSummaryAt = 0, timer = null, done = null;
  const toSession = (role) => sessionName(role);

  const rebuild = () => { entries = buildEntries({ supers: data.supers, sessions: data.sessions, summary: data.summary, nightRepos: data.nightRepos, toSession }); };
  const readSessions = () => { try { data.sessions = new Set(floor.list().map((s) => s.session)); } catch { data.sessions = new Set(); } };
  const draw = () => {
    if (!term.active) return;
    const { cols, rows } = term.size();
    term.write(renderFrame({ entries, state, cols, rows, preview, dashboard: data.dashboard }));
  };
  const readPreview = () => {
    const entry = entries[Math.min(state.sel, entries.length - 1)];
    if (!entry?.alive) { preview = []; return; }
    const height = Math.max(term.size().rows - 4, 1);
    preview = tailOf(captureTail(entry.session, height), height);
  };
  async function refresh({ full }) {
    if (busy) return;
    busy = true;
    try {
      if (full) { const loaded = await loadSupers({ fetchJson, local: () => localSupers() }); data.supers = loaded.supers; }
      const dash = await loadDashboard({ fetchJson, night: full });
      data.summary = dash.summary;
      if (full) data.nightRepos = dash.nightRepos;
      data.dashboard = dash.summary ? "연결됨" : "연결 안 됨 (뱃지 ?)";
      readSessions();
      lastSummaryAt = Date.now();
      rebuild(); readPreview(); draw();
    } finally { busy = false; }
  }
  const tick = () => {
    readSessions(); rebuild(); readPreview(); draw();
    if (Date.now() - lastSummaryAt >= SUMMARY_MIN_MS) refresh({ full: false }).catch(() => {});
  };

  const onData = (chunk) => {
    for (const key of parseKeys(chunk)) {
      const next = reduceKey(state, key, entries);
      state = next.state;
      if (next.action === "quit") return shutdown();
      if (next.action === "refresh") refresh({ full: true }).catch(() => {});
      if (next.action === "attach" || next.action === "view") return enter(entries[state.sel], next.action === "view");
    }
    readPreview(); draw();
  };
  function listen() { process.stdin.on("data", onData); timer = setInterval(tick, TICK_MS); }
  function unlisten() { process.stdin.off("data", onData); clearInterval(timer); timer = null; }
  function enter(entry, readOnly) {
    unlisten(); term.restore();
    try {
      const result = attachNow({ session: entry.session, readOnly });
      state = { ...state, notice: result.notice };
    } catch (error) { state = { ...state, notice: error.message }; }
    term.enter(); listen(); readSessions(); rebuild(); readPreview(); draw();
    lastSummaryAt = 0;
  }
  function shutdown() { unlisten(); term.restore(); process.off("SIGTERM", shutdown); process.off("SIGHUP", shutdown); process.off("SIGINT", shutdown); done?.(); }

  process.once("exit", () => term.restore());
  process.on("SIGTERM", shutdown); process.on("SIGHUP", shutdown); process.on("SIGINT", shutdown);
  process.stdout.on("resize", draw);
  const finished = new Promise((resolve) => { done = resolve; });
  try {
    term.enter();
    readSessions(); draw();
    listen();
    await refresh({ full: true });
    await finished;
  } catch (error) {
    unlisten(); term.restore();
    throw error;
  } finally {
    process.stdout.off("resize", draw);
    term.restore();
  }
}
