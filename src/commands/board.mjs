// kadan board: 어느 터미널에서든 한 화면 세 칸(사이드바 / 현재 세션 설명 / 터미널)으로 슈퍼감독들을 모아 보고,
// 고른 세션 창에 같은 화면에서 바로 입력한다. 새 tmux 세션·창·제어 client를 만들지 않고(붙기·분할·크기 조절·종료 길 없음) 세션을 끄지 않는다.
// 키 전달은 floor-tmux의 sendHumanKeys 하나로만 한다(board는 tmux 키 전송 명령을 직접 만들지 않는다).
// 비용(상주 화면): 터미널 칸 포커스 중 tick 200ms에 읽기 2번(약 초당 10번), 포커스 밖은 1.5초에 2번, 칸이 꺼지면 그 칸의 조회는 0.
//   설명 칸은 켜진 때만 고를 때(0.4초 가라앉은 뒤)와 15초 이상 간격으로 GET 1번. 사이드바 summary는 켜진 때만 15초 이상 간격.
//   슈퍼감독 현황·나이트런 정책은 시작과 r 때만. 원장·카드는 (대시보드가 꺼졌을 때의 시작·r 한 번 말고는) 읽지 않으므로 데이터가 10배여도 tick 비용은 같다.
import { floor } from "../floor.mjs";
import { sendHumanKeys } from "../floor-tmux.mjs";
import { DEFAULT_PORT, readConfig } from "../quickstart.mjs";
import { ledgerHome } from "../ledger.mjs";
import { die, sessionName } from "../cli-basics.mjs";
import { buildEntries, reduceKey } from "../board-model.mjs";
import { createInputParser, listKeys, toSendTokens } from "../board-input.mjs";
import { renderFrame } from "../board-view.mjs";
import { createTerminal } from "../board-tui.mjs";
import { httpJson, loadDashboard, loadSuperStatus, loadSupers, localSupers, readPanePid, readScreen } from "../board-data.mjs";

export { httpJson, loadDashboard, loadSupers, localSupers };

export const TICK_LIST_MS = 1500;
export const TICK_TERM_MS = 200;
export const SUMMARY_MIN_MS = 15_000;
export const DESC_MIN_MS = 15_000;
export const DESC_SETTLE_MS = 400;
export const INPUT_FLUSH_MS = 50;

export const BOARD_USAGE = "사용법: kadan board [--port 8790]  (한 화면 세 칸: 사이드바 · 현재 세션 설명 · 터미널. 1 2 3 칸 켜고 끄기 · Enter/Tab 터미널 입력 · Ctrl-] 목록으로 · r 새로 읽기 · q 끝)";

export function boardPort(flags, home = ledgerHome()) {
  const port = String(flags.port ?? readConfig(home).port ?? DEFAULT_PORT);
  if (!/^\d+$/.test(port) || Number(port) > 65535) die("--port는 0부터 65535까지의 정수여야 한다");
  return port;
}

// 화면·입력·조회를 묶는 본체. 터미널·tmux·HTTP·시계는 모두 deps로 받아 가짜로 시험한다.
export function createBoard(deps) {
  const { fetchJson, term, toSession, local, listSessions, now = Date.now, schedule = setTimeout, cancel = clearTimeout } = deps;
  const read = deps.readScreen ?? readScreen, pidOf = deps.panePid ?? readPanePid, send = deps.sendKeys ?? sendHumanKeys;
  const data = { supers: [], summary: null, nightRepos: null, sessions: new Set(), dashboard: "확인 중" };
  const desc = new Map(); // 역할 → {status, at}
  const parser = createInputParser();
  const panes = { side: true, desc: true, term: true };
  let state = { sel: 0, notice: "" }, entries = [], focus = "list", screen = null, loading = false;
  let focusInfo = null, pending = [], flushTimer = null, descTimer = null, tickTimer = null, lastSummaryAt = 0, busy = false, closed = false;
  const selected = () => entries[Math.min(state.sel, entries.length - 1)];
  const notice = (text) => { state = { ...state, notice: text }; };

  const rebuild = () => {
    entries = buildEntries({ supers: data.supers, sessions: data.sessions, summary: data.summary,
      nightRepos: data.nightRepos, toSession });
  };
  const draw = () => {
    if (!term.active || closed) return;
    const { cols, rows } = term.size();
    const entry = selected();
    term.write(renderFrame({ entries, state, focus, panes, cols, rows, term: screen, dashboard: data.dashboard,
      desc: { status: entry ? desc.get(entry.role)?.status ?? null : null, loading } }));
  };
  const readSessions = () => { try { data.sessions = new Set(listSessions()); } catch { data.sessions = new Set(); } };

  function loseTerminal(message) {
    focus = "list"; focusInfo = null; pending = []; parser.reset();
    if (flushTimer) { cancel(flushTimer); flushTimer = null; }
    notice(message);
  }

  async function loadDesc() {
    const entry = selected();
    if (!panes.desc || !entry || loading || closed) return;
    const cached = desc.get(entry.role);
    if (cached && now() - cached.at < DESC_MIN_MS) return;
    loading = true; draw();
    try { desc.set(entry.role, { status: await loadSuperStatus({ fetchJson, role: entry.role }), at: now() }); }
    finally { loading = false; draw(); }
  }
  function settleDesc() {
    if (descTimer) cancel(descTimer);
    descTimer = panes.desc ? schedule(() => { descTimer = null; loadDesc().catch(() => {}); }, DESC_SETTLE_MS) : null;
  }

  async function refresh({ full }) {
    if (busy || closed) return;
    busy = true;
    try {
      if (full) { data.supers = (await loadSupers({ fetchJson, local })).supers; desc.clear(); }
      if (full || panes.side) {
        const dash = await loadDashboard({ fetchJson, night: full });
        data.summary = dash.summary;
        if (full) data.nightRepos = dash.nightRepos;
        data.dashboard = dash.summary ? "연결됨" : "연결 안 됨 (뱃지 ?)";
      }
      readSessions(); lastSummaryAt = now(); rebuild(); draw();
      if (full) settleDesc();
    } finally { busy = false; }
  }

  function tick() {
    tickTimer = null;
    if (closed) return;
    const entry = selected();
    if (panes.term && entry?.alive) {
      screen = read(entry.session);
      if (!screen || screen.dead) { // 세션이 사라졌거나 pane이 죽음
        if (focus === "term") loseTerminal(`${entry.session}: 세션이 사라져 입력을 멈췄습니다`);
        data.sessions.delete(entry.session); rebuild(); screen = null;
      }
    } else screen = null;
    draw();
    if (panes.side && now() - lastSummaryAt >= SUMMARY_MIN_MS) refresh({ full: false }).catch(() => {});
    if (panes.desc && entry && !descTimer) loadDesc().catch(() => {});
    start();
  }
  function start() { if (!closed && !tickTimer) tickTimer = schedule(tick, focus === "term" ? TICK_TERM_MS : TICK_LIST_MS); }

  function flush() {
    flushTimer = null;
    if (focus !== "term" || !focusInfo || !pending.length) { pending = []; return; }
    const { tokens, over } = toSendTokens(pending);
    pending = [];
    if (over) { notice("붙여넣기가 너무 커서(64KB 초과) 보내지 않았습니다"); draw(); return; }
    try {
      send(focusInfo.session, tokens, { allowed: new Set(entries.map((e) => e.session)), expectedPid: focusInfo.pid, guard: focusInfo.guard });
    } catch (error) {
      loseTerminal(error.message); // 입력을 버리고 목록 포커스로 돌아온다
    }
    if (tickTimer) { cancel(tickTimer); tickTimer = null; }
    tick(); // 보낸 키의 결과를 바로 보여 준다
  }

  function focusTerminal() {
    const entry = selected();
    if (!entry?.alive) return;
    const pid = pidOf(entry.session);
    if (!pid) { notice(`${entry.session}: pane PID를 읽지 못해 입력하지 않습니다`); return; }
    panes.term = true;
    focusInfo = { session: entry.session, pid, guard: {} };
    focus = "term"; parser.reset(); pending = [];
    notice("");
  }

  function onInput(chunk) {
    if (closed) return;
    const parsed = parser.feed(chunk);
    if (focus === "term") {
      const leave = parsed.findIndex((t) => t.type === "leave");
      pending.push(...(leave === -1 ? parsed : parsed.slice(0, leave)));
      if (leave !== -1) { flush(); if (focus === "term") loseTerminal(""); draw(); start(); return; }
      if (pending.length && !flushTimer) flushTimer = schedule(flush, INPUT_FLUSH_MS);
      return;
    }
    for (const key of listKeys(parsed)) {
      const next = reduceKey(state, key, entries);
      const moved = next.state.sel !== state.sel;
      state = next.state;
      if (moved) { screen = null; settleDesc(); }
      if (next.action === "quit") { close(); return; }
      if (next.action === "refresh") refresh({ full: true }).catch(() => {});
      if (next.action === "focus-term") focusTerminal();
      if (next.action?.startsWith("toggle-")) {
        const name = { 1: "side", 2: "desc", 3: "term" }[next.action.slice(7)];
        panes[name] = !panes[name];
        if (name === "desc") settleDesc();
        if (name === "side" && panes.side) lastSummaryAt = 0;
        if (name === "term" && !panes.term) screen = null;
      }
    }
    if (tickTimer) { cancel(tickTimer); tickTimer = null; }
    tick();
  }

  function close() {
    closed = true;
    for (const timer of [flushTimer, descTimer, tickTimer]) if (timer) cancel(timer);
    flushTimer = descTimer = tickTimer = null;
    deps.onClose?.();
  }
  async function open() { readSessions(); rebuild(); draw(); start(); await refresh({ full: true }); }

  return { open, onInput, tick, flush, close, draw, refresh,
    get state() { return { ...state, focus, panes: { ...panes }, entries, focusInfo, screen, desc } } };
}

export async function cmdBoard(_argv, flags) {
  if (flags.help) { console.log(BOARD_USAGE); return; }
  if (floor.name !== "tmux") { console.log("kadan board는 tmux 바닥에서만 지원합니다 (herdr 바닥은 미지원)"); return; }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    die("kadan board는 터미널에서 직접 실행해야 한다 (입력이 터미널이 아님)");
  }
  const term = createTerminal();
  let done = null;
  const finished = new Promise((resolve) => { done = resolve; });
  const board = createBoard({
    fetchJson: httpJson(boardPort(flags)), term, local: () => localSupers(), toSession: sessionName,
    listSessions: () => floor.list().map((s) => s.session),
    onClose: () => done(),
  });
  const onData = (chunk) => board.onInput(chunk);
  const shutdown = () => board.close();
  const redraw = () => board.draw();
  process.once("exit", () => term.restore());
  process.on("SIGTERM", shutdown); process.on("SIGHUP", shutdown); process.on("SIGINT", shutdown);
  process.stdout.on("resize", redraw);
  try {
    term.enter();
    process.stdin.on("data", onData);
    await board.open();
    await finished;
  } finally {
    process.stdin.off("data", onData);
    process.stdout.off("resize", redraw);
    process.off("SIGTERM", shutdown); process.off("SIGHUP", shutdown); process.off("SIGINT", shutdown);
    term.restore();
  }
}
