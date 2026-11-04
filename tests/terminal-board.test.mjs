import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { badgesOf, buildEntries, cellWidth, fit, nightFor, nightWord, reduceKey } from "../src/board-model.mjs";
import { cropAnsi, describeLines, layoutPanes, renderFrame, termWindow } from "../src/board-view.mjs";
import { createTerminal, SCREEN_SEQUENCES } from "../src/board-tui.mjs";
import { loadDashboard, loadSuperStatus, loadSupers, readPanePid, readScreen } from "../src/board-data.mjs";
import { createBoard, httpJson } from "../src/commands/board.mjs";

const strip = (text) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
const toSession = (role) => `kadan-${role}`;
const line = (repo, reason, exceptBranch = null) => ({ github: `o/${repo}`, repo, verdict: { action: "x", reason, exceptBranch } });
const summary = {
  night: { on: true },
  sidebar: [{ repo: "a", decisions: 2, merges: 1 }, { repo: "b", decisions: 0, merges: 3 }, { repo: "c", decisions: null, merges: null }],
};

test("문자 폭: 한글·이모지는 2칸, 결합 문자는 0칸이고 fit이 폭에 정확히 맞춘다", () => {
  assert.equal(cellWidth("슈퍼감독"), 8);
  assert.equal(cellWidth("🌙함"), 4);
  for (const text of ["슈퍼감독-kadan", "짧음", "a🌙b한글한글한글한글", ""]) {
    for (const width of [1, 5, 10, 11]) assert.equal(cellWidth(fit(text, width)), width, `${text}/${width}`);
  }
  assert.equal(fit("가나다라마", 7), "가나다…");
});

test("🌙 판정 문구·합산: 화면(night-repos.ts badgeOf)과 같고 모르면 ?, 줄이 없으면 -, 다르면 섞임", () => {
  assert.equal(nightWord(line("a", "allowed")), "함");
  assert.equal(nightWord(line("a", "allowed", "main")), "안 함(배포 브랜치 main)");
  assert.equal(nightWord(line("a", "night-merge-forbidden")), "금지");
  assert.equal(nightWord(line("a", "뭔가 새 판정")), "판정 모름");
  const night = { repos: [line("a", "allowed"), line("b", "allowed"), line("c", "night-merge-forbidden")] };
  assert.equal(nightFor(null, ["a"]), "?");
  assert.equal(nightFor(night, null), "?");
  assert.equal(nightFor(night, ["zzz"]), "-");
  assert.equal(nightFor(night, ["a", "b"]), "함");
  assert.equal(nightFor(night, ["a", "c"]), "섞임");
});

test("슈퍼감독 판정·합산: 저장소 뱃지를 슈퍼감독 단위로 더하고 모르면 0이 아니라 ?, 세션 없음은 alive false", () => {
  const supers = [{ role: "x", repos: ["a", "b"] }, { role: "y", repos: null }, { role: "z", repos: ["a", "c"] }, { role: "w", repos: ["nope"] }];
  const entries = buildEntries({ supers, sessions: new Set(["kadan-x", "kadan-y"]), summary, nightRepos: null, toSession });
  assert.deepEqual(entries.map((e) => [e.role, e.alive, e.decisions, e.merges]),
    [["x", true, 2, 4], ["y", true, null, null], ["z", false, null, null], ["w", false, null, null]]);
  assert.equal(badgesOf(entries[0]), "⚑2 ⇡4 🌙?");
  assert.equal(badgesOf(entries[1]), "⚑? ⇡? 🌙?");
  const down = buildEntries({ supers: [{ role: "x", repos: ["a"] }], sessions: new Set(["kadan-x"]), summary: null, nightRepos: null, toSession });
  assert.deepEqual([down[0].alive, down[0].decisions, down[0].nightOn], [true, null, false]);
});

test("목록 키 전이: 선택은 범위 안에 머물고 Enter는 살아 있는 줄에서만 터미널 포커스, 1 2 3은 칸 토글", () => {
  const entries = [{ role: "a", alive: true }, { role: "b", alive: false }];
  let r = reduceKey({ sel: 0, notice: "" }, "up", entries); assert.equal(r.state.sel, 0);
  r = reduceKey(r.state, "down", entries); r = reduceKey(r.state, "down", entries); assert.equal(r.state.sel, 1);
  r = reduceKey(r.state, "enter", entries);
  assert.equal(r.action, null);
  assert.match(r.state.notice, /세션이 없어/);
  assert.equal(reduceKey({ sel: 0, notice: "남은 안내" }, "enter", entries).action, "focus-term");
  assert.equal(reduceKey({ sel: 0, notice: "" }, "enter", []).action, null);
  assert.deepEqual(["1", "2", "3"].map((k) => reduceKey({ sel: 0, notice: "" }, k, entries).action), ["toggle-1", "toggle-2", "toggle-3"]);
  assert.equal(reduceKey({ sel: 0, notice: "" }, "q", entries).action, "quit");
  assert.equal(reduceKey({ sel: 0, notice: "" }, "r", entries).action, "refresh");
  assert.equal(reduceKey({ sel: 0, notice: "" }, "v", entries).action, null); // 1차의 읽기 전용 붙기는 없다
});

test("색 유지 자르기: 폭에 정확히 맞추고 색은 남기며 커서 이동 같은 제어는 버린다", () => {
  const cropped = cropAnsi("\x1b[31m빨강\x1b[0m글자 abcdef\x1b[2J\x1b[5;5H", 10);
  assert.equal(cellWidth(strip(cropped)), 10);
  assert.ok(cropped.startsWith("\x1b[31m빨강"));
  assert.ok(!cropped.includes("\x1b[2J") && !cropped.includes("\x1b[5;5H"));
  assert.equal(cellWidth(strip(cropAnsi("가".repeat(20), 7))), 7); // 2칸 글자가 경계에 걸리면 한 칸 비운다
  assert.equal(cropAnsi("abc", 0), "");
});

test("터미널 칸: 커서가 보이는 구간을 고르고 칸보다 넓은 대상은 오른쪽을 잘라 알린다", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `줄${i}`);
  const tall = termWindow({ lines, paneWidth: 80, paneHeight: 10, cursor: { x: 3, y: 9 } }, 4, 20);
  assert.deepEqual(tall.rows.map((r) => strip(r).trim()), ["줄6", "줄7", "줄8", "줄9"]);
  assert.deepEqual(tall.cursor, { row: 3, col: 3 });
  assert.equal(tall.cut, true);
  const wide = termWindow({ lines, paneWidth: 10, paneHeight: 10, cursor: { x: 30, y: 0 } }, 12, 20);
  assert.equal(wide.cursor, null); // 칸 밖 커서는 그리지 않는다
  assert.equal(wide.cut, false);
  assert.equal(termWindow(null, 3, 5).rows.length, 3);
});

test("칸 배치: 켜진 칸만 놓고, 터미널 칸이 너무 좁아지면 설명 → 사이드바 순으로 접는다", () => {
  const all = layoutPanes({ cols: 120, panes: { side: true, desc: true, term: true } });
  assert.deepEqual(all.shown, ["side", "desc", "term"]);
  assert.equal(all.widths.side + all.widths.desc + all.widths.term + 2, 120);
  assert.deepEqual(layoutPanes({ cols: 120, panes: { side: false, desc: false, term: true } }).shown, ["term"]);
  assert.equal(layoutPanes({ cols: 120, panes: { side: true, desc: false, term: false } }).widths.side, 120);
  const narrow = layoutPanes({ cols: 60, panes: { side: true, desc: true, term: true } });
  assert.ok(narrow.hidden.includes("desc") && narrow.widths.term >= 20);
  assert.deepEqual(layoutPanes({ cols: 30, panes: { side: true, desc: true, term: true } }).hidden, ["side", "desc"]);
  assert.deepEqual(layoutPanes({ cols: 80, panes: { side: false, desc: false, term: false } }).shown, []);
});

test("화면: 모든 줄이 터미널 폭에 정확히 맞고, 선택·회색·터미널 포커스 표시가 구분된다", () => {
  const entries = buildEntries({
    supers: [{ role: "kadan-슈퍼감독", repos: ["a", "b"] }, { role: "긴-이름-".repeat(8), repos: ["c"] }, { role: "z", repos: null }],
    sessions: new Set(["kadan-kadan-슈퍼감독"]), summary, nightRepos: { repos: [line("a", "allowed"), line("b", "allowed")] }, toSession,
  });
  const term = { lines: ["첫 줄", "\x1b[32m초록\x1b[0m"], paneWidth: 200, paneHeight: 2, cursor: { x: 2, y: 1 } };
  const panes = { side: true, desc: true, term: true };
  for (const cols of [40, 80, 120]) {
    const frame = renderFrame({ entries, state: { sel: 0, notice: "" }, focus: "list", panes, cols, rows: 14, term, dashboard: "연결됨" });
    const lines = strip(frame).split("\r\n");
    assert.equal(lines.length, 14);
    for (const l of lines) assert.equal(cellWidth(l), cols, `${cols}: ${l}`);
  }
  const frame = renderFrame({ entries, state: { sel: 0, notice: "" }, focus: "list", panes, cols: 120, rows: 14, term });
  assert.match(frame, /\x1b\[7m▶ kadan-슈퍼/);
  assert.match(frame, /\x1b\[2m.*긴-이름/);
  assert.match(frame, /\x1b\[32m초록/); // 대상 화면의 색 유지
  assert.match(frame, /오른쪽 잘림/);
  assert.ok(frame.endsWith("\x1b[?25l")); // 목록 포커스: 커서 숨김
  const typing = renderFrame({ entries, state: { sel: 0, notice: "" }, focus: "term", panes, cols: 120, rows: 14, term });
  assert.match(strip(typing), /입력 중 → kadan-kadan-슈퍼감독 · Ctrl-\] 목록으로/);
  assert.match(typing, /\x1b\[32m┃/); // 초록 테두리
  assert.match(typing, /\x1b\[\d+;\d+H\x1b\[\?25h$/); // 커서를 대상 커서 자리에
  const second = renderFrame({ entries, state: { sel: 2, notice: "" }, focus: "list", panes, cols: 120, rows: 14, term: null });
  assert.match(second, /\x1b\[1;33m🌙함/);
  assert.match(strip(second), /1 사이드바 2 설명 3 터미널/);
  const withDesc = renderFrame({ entries, state: { sel: 0, notice: "" }, focus: "list", panes, cols: 120, rows: 24, term,
    desc: { status: { works: [{ title: "W" }], rows: [], decisions: [], alerts: { count: 0, items: [] }, recent: [] } } });
  assert.ok(!/\[2m|\[0m/.test(strip(withDesc)), "설명 칸의 색 코드가 글자로 새지 않는다");
  assert.match(withDesc, /\x1b\[2m▸ 열린 워크 1/);
});

test("화면: 목록이 비거나 모든 칸이 꺼져도 깨지지 않는다", () => {
  const empty = strip(renderFrame({ entries: [], state: { sel: 0, notice: "안내" }, focus: "list", panes: { side: true, desc: true, term: true }, cols: 60, rows: 8 }));
  assert.match(empty, /슈퍼감독 0명/);
  assert.match(empty, /안내/);
  const off = strip(renderFrame({ entries: [], state: { sel: 0, notice: "" }, focus: "list", panes: { side: false, desc: false, term: false }, cols: 60, rows: 8 }));
  assert.match(off, /모든 칸이 꺼져 있습니다/);
});

test("설명 칸: 워크·작업중 카드·결정·경보·최근 활동을 보이고, 모르는 값은 0이 아니라 모름", () => {
  const entry = { role: "x", alive: true };
  const status = {
    works: [{ title: "대시보드", turnLabel: "구현 차례", next: "검수" }], rows: [{ title: "카드A", healthLabel: "정상" }],
    decisions: [{ question: "머지할까요?" }], alerts: { count: 1, items: [{ kind: "정체", level: "warn", role: "w" }] },
    recent: [{ at: "2026-11-04T01:02:00Z", label: "완료", card: { title: "카드A" } }],
  };
  const text = describeLines(entry, status).join("\n");
  for (const word of ["열린 워크 1", "대시보드 [구현 차례] → 검수", "작업중 카드 1", "⚑ 머지할까요?", "경보 1", "정체 warn w", "최근 활동", "카드A", "최근 우편", "준비 중"])
    assert.ok(text.includes(word), word);
  const unknown = describeLines(entry, { ...status, decisions: null, alerts: null }).join("\n");
  assert.ok(unknown.includes("kyle 결정 대기 모름") && unknown.includes("경보 모름"));
  assert.match(describeLines(entry, null).join("\n"), /모름/);
  assert.match(describeLines(entry, null, { loading: true }).join("\n"), /읽는 중/);
  assert.deepEqual(describeLines(null, null), ["슈퍼감독을 고르세요"]);
});

test("터미널 복구: enter 뒤 restore가 raw 모드·커서·원래 화면·붙여넣기 모드를 돌려놓고 여러 번 불러도 안전하다", () => {
  const writes = [];
  const stdin = Object.assign(new EventEmitter(), { isRaw: false, raws: [], paused: 0,
    setRawMode(v) { this.raws.push(v); this.isRaw = v; }, resume() {}, pause() { this.paused++; }, setEncoding() {} });
  const term = createTerminal({ stdin, stdout: { columns: 100, rows: 30, write: (t) => writes.push(t) } });
  term.write("무시됨");
  term.enter(); term.enter();
  assert.match(SCREEN_SEQUENCES.ENTER, /\?2004h/);
  term.restore(); term.restore();
  assert.deepEqual(stdin.raws, [true, false]);
  assert.equal(stdin.paused, 1);
  assert.deepEqual(writes, [SCREEN_SEQUENCES.ENTER, SCREEN_SEQUENCES.LEAVE]);
  assert.match(SCREEN_SEQUENCES.LEAVE, /\?2004l.*\?25h.*\?1049l/);
  assert.deepEqual(term.size(), { cols: 100, rows: 30 });
  const raw = Object.assign(new EventEmitter(), { isRaw: true, raws: [], setRawMode(v) { this.raws.push(v); }, resume() {}, pause() {}, setEncoding() {} });
  const again = createTerminal({ stdin: raw, stdout: { write() {} } });
  again.enter(); again.restore();
  assert.deepEqual(raw.raws, [true, true]);
});

test("슈퍼감독 출처·대시보드 값·설명 조회: 실패한 것만 null이고 night 정책은 요청할 때만 읽는다", async () => {
  const status = { supervisors: { items: [{ super: "s1", repos: ["a"] }, { super: "s2", repos: [] }] } };
  const ok = await loadSupers({ fetchJson: async (p) => { assert.equal(p, "/api/dashboard/status"); return status; }, local: () => assert.fail("로컬 금지") });
  assert.deepEqual(ok, { supers: [{ role: "s1", repos: ["a"] }, { role: "s2", repos: null }], source: "dashboard" });
  const down = await loadSupers({ fetchJson: async () => { throw new Error("refused"); }, local: () => [{ role: "L", repos: null }] });
  assert.equal(down.source, "local");
  const none = await loadSupers({ fetchJson: async () => { throw new Error("x"); }, local: () => { throw new Error("y"); } });
  assert.deepEqual(none, { supers: [], source: "none" });
  const seen = [];
  const fetchJson = async (p) => { seen.push(p); if (p === "/api/night/repos") throw new Error("down"); return { ok: p }; };
  assert.deepEqual(await loadDashboard({ fetchJson }), { summary: { ok: "/api/dashboard/summary" }, nightRepos: null });
  seen.length = 0;
  await loadDashboard({ fetchJson, night: false });
  assert.deepEqual(seen, ["/api/dashboard/summary"]);
  seen.length = 0;
  assert.deepEqual(await loadSuperStatus({ fetchJson, role: "역할 a" }), { ok: "/api/dashboard/status?super=%EC%97%AD%ED%95%A0%20a" });
  assert.equal(await loadSuperStatus({ fetchJson: async () => { throw new Error("x"); }, role: "a" }), null);
});

test("httpJson: 127.0.0.1 주소로 GET만 하고, 오류 코드는 던진다", async () => {
  const urls = [];
  const fake = async (url, opts) => { urls.push([url, opts.method]); return { ok: url.includes("good"), status: 500, json: async () => ({ a: 1 }) }; };
  assert.deepEqual(await httpJson("8790", fake)("/good"), { a: 1 });
  await assert.rejects(httpJson("8790", fake)("/bad"), /HTTP 500/);
  assert.deepEqual(urls[0], ["http://127.0.0.1:8790/good", undefined]);
});

test("화면 읽기: 크기·커서·PID를 한 번에 읽고 세션이 없으면 null, 읽기 명령 두 가지만 쓴다", () => {
  const calls = [];
  const run = (args) => {
    calls.push(args[0]);
    if (args[0] === "display-message") return { status: 0, stdout: args.at(-1).includes("pane_width") ? "80 24 5 3 1 4321 0\n" : "4321|0\n" };
    return { status: 0, stdout: "줄1\n줄2\n" };
  };
  assert.deepEqual(readScreen("kadan-x", { run }), { lines: ["줄1", "줄2"], paneWidth: 80, paneHeight: 24, cursor: { x: 5, y: 3 }, pid: "4321", dead: false });
  assert.deepEqual(calls, ["display-message", "capture-pane"]);
  assert.equal(readScreen("kadan-x", { run: () => ({ status: 1, stdout: "" }) }), null);
  assert.equal(readPanePid("kadan-x", { run }), "4321");
  assert.equal(readPanePid("kadan-x", { run: () => ({ status: 0, stdout: "4321|1\n" }) }), null);
});

// ---- 컨트롤러: 가짜 터미널·가짜 HTTP·가짜 tmux·가짜 시계 ----
function harness({ alive = true, sendKeys, fetchJson } = {}) {
  const timers = new Map();
  let nextId = 1, clock = 1_000_000;
  const flags = { gone: false };
  const log = { fetch: [], read: [], send: [], pid: [], frames: [] };
  const board = createBoard({
    term: { active: true, write: (t) => log.frames.push(t), size: () => ({ cols: 120, rows: 20 }) },
    fetchJson: fetchJson ?? (async (p) => {
      log.fetch.push(p);
      if (p === "/api/dashboard/status") return { supervisors: { items: [{ super: "a", repos: ["a"] }, { super: "b", repos: ["b"] }] } };
      if (p === "/api/dashboard/summary") return summary;
      if (p === "/api/night/repos") return { repos: [] };
      return { works: [], rows: [], decisions: [], alerts: { count: 0, items: [] }, recent: [] };
    }),
    toSession, local: () => [], listSessions: () => (alive ? ["kadan-a", "kadan-b"] : []),
    readScreen: (s) => { log.read.push(s); if (flags.gone) return null; return { lines: ["화면"], paneWidth: 80, paneHeight: 1, cursor: { x: 1, y: 0 }, pid: "100", dead: false }; },
    panePid: (s) => { log.pid.push(s); return "100"; },
    sendKeys: sendKeys ?? ((session, tokens, opts) => { log.send.push({ session, tokens, opts }); return { sent: 1 }; }),
    now: () => clock,
    schedule: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; },
    cancel: (id) => timers.delete(id),
    onClose: () => { log.closed = true; },
  });
  const fire = async (ms) => { // 지정한 지연의 타이머 하나를 실행한다
    const entry = [...timers].find(([, t]) => t.ms === ms);
    assert.ok(entry, `${ms}ms 타이머 없음: ${[...timers.values()].map((t) => t.ms)}`);
    timers.delete(entry[0]); entry[1].fn(); await new Promise((r) => setImmediate(r));
  };
  return { board, log, timers, flags, advance: (ms) => { clock += ms; }, fire };
}

test("컨트롤러: 시작하면 목록·뱃지를 읽고, 터미널 칸은 고른 살아 있는 세션 화면을 읽는다", async () => {
  const h = harness();
  await h.board.open();
  assert.deepEqual(h.board.state.entries.map((e) => [e.role, e.alive, e.decisions]), [["a", true, 2], ["b", true, 0]]);
  assert.deepEqual(h.log.fetch.filter((p) => p !== "/api/dashboard/status?super=a"), ["/api/dashboard/status", "/api/dashboard/summary", "/api/night/repos"]);
  await h.fire(1500);
  assert.deepEqual(h.log.read, ["kadan-a"]);
  assert.ok(h.timers.size >= 1);
});

test("컨트롤러: 칸을 끄면 그 칸의 조회가 멈춘다(설명 칸·사이드바 summary·터미널 화면)", async () => {
  const h = harness();
  await h.board.open();
  h.log.fetch.length = 0; h.log.read.length = 0;
  h.board.onInput("2"); // 설명 끄기
  h.board.onInput("1"); // 사이드바 끄기
  h.board.onInput("3"); // 터미널 끄기
  assert.deepEqual(h.board.state.panes, { side: false, desc: false, term: false });
  h.log.fetch.length = 0; h.log.read.length = 0;
  h.advance(60_000);
  for (let i = 0; i < 3; i++) { h.board.tick(); h.board.onInput("\x1b[B"); h.board.onInput("\x1b[A"); }
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.log.fetch, [], "꺼진 칸은 HTTP 조회 0");
  assert.deepEqual(h.log.read, [], "꺼진 터미널 칸은 tmux 읽기 0");
  h.board.onInput("2");
  await h.fire(400);
  assert.deepEqual(h.log.fetch, ["/api/dashboard/status?super=a"]); // 다시 켜면 그때 한 번
});

test("컨트롤러: 설명 칸은 고른 뒤 가라앉았을 때 한 번 읽고 같은 역할은 15초 안에 다시 읽지 않는다", async () => {
  const h = harness();
  await h.board.open();
  await h.fire(400);
  const only = () => h.log.fetch.filter((p) => p.includes("?super="));
  assert.deepEqual(only(), ["/api/dashboard/status?super=a"]);
  h.board.onInput("j"); h.board.onInput("k"); h.board.onInput("j"); // 빠르게 훑어도 조회는 가라앉은 뒤 1번
  assert.equal(only().length, 1);
  await h.fire(400);
  assert.deepEqual(only(), ["/api/dashboard/status?super=a", "/api/dashboard/status?super=b"]);
  h.board.onInput("k"); await h.fire(400); // a는 15초 안이라 캐시
  assert.equal(only().length, 2);
  h.advance(16_000);
  h.board.onInput("j"); await h.fire(400);
  assert.equal(only().length, 3);
});

test("컨트롤러: 터미널 포커스에서 글자·Enter·Ctrl-C는 대상 창으로 가고, q는 끝내지 않으며, Ctrl-]만 목록으로 돌아온다", async () => {
  const h = harness();
  await h.board.open();
  h.board.onInput("\r");
  assert.equal(h.board.state.focus, "term");
  assert.deepEqual(h.log.pid, ["kadan-a"]);
  assert.equal(h.board.state.focusInfo.pid, "100");
  h.board.onInput("hi q");
  h.board.onInput("\r"); h.board.onInput("\x03");
  h.board.flush();
  assert.equal(h.log.closed, undefined, "터미널 포커스의 q는 board를 끝내지 않는다");
  assert.deepEqual(h.log.send.map((s) => s.tokens), [[{ text: "hi q" }, { key: "Enter" }, { key: "C-c" }]]);
  assert.equal(h.log.send[0].session, "kadan-a");
  assert.deepEqual([...h.log.send[0].opts.allowed].sort(), ["kadan-a", "kadan-b"]);
  assert.equal(h.log.send[0].opts.expectedPid, "100");
  h.board.onInput("abc\x1dq"); // Ctrl-] 뒤의 q는 버려진다
  assert.equal(h.board.state.focus, "list");
  assert.equal(h.log.closed, undefined);
  assert.deepEqual(h.log.send.at(-1).tokens, [{ text: "abc" }]);
  h.board.onInput("q");
  assert.equal(h.log.closed, true); // 목록 포커스의 q는 끝
});

test("컨트롤러: 입력은 묶음 지연(50ms) 뒤 한 번에 보낸다", async () => {
  const h = harness();
  await h.board.open();
  h.board.onInput("\r");
  h.board.onInput("a"); h.board.onInput("b"); h.board.onInput("c");
  assert.deepEqual(h.log.send, []);
  await h.fire(50);
  assert.equal(h.log.send.length, 1);
  assert.deepEqual(h.log.send[0].tokens, [{ text: "abc" }]);
});

test("컨트롤러: 전송이 거절되면(PID 불일치·다른 창 입력 등) 입력을 버리고 목록 포커스로 돌아와 한 줄 알린다", async () => {
  const sendKeys = () => { throw Object.assign(new Error("입력 거절: pane PID가 포커스 때와 다르거나 죽은 화면"), { code: "KADAN_PID_MISMATCH" }); };
  const h = harness({ sendKeys });
  await h.board.open();
  h.board.onInput("\r");
  h.board.onInput("secret");
  h.board.flush();
  assert.equal(h.board.state.focus, "list");
  assert.equal(h.board.state.focusInfo, null);
  assert.match(h.board.state.notice, /PID가 포커스 때와 다르/);
  h.board.onInput("zzz");
  assert.equal(h.log.closed, undefined);
});

test("컨트롤러: 커다란 붙여넣기는 보내지 않고 알린다, 목록 포커스의 붙여넣기는 무시한다", async () => {
  const h = harness();
  await h.board.open();
  h.board.onInput("\x1b[200~qqq\x1b[201~");
  assert.equal(h.log.closed, undefined);
  h.board.onInput("\r");
  h.board.onInput(`\x1b[200~${"x".repeat(70_000)}\x1b[201~`);
  h.board.flush();
  assert.deepEqual(h.log.send, []);
  assert.match(h.board.state.notice, /64KB/);
  assert.equal(h.board.state.focus, "term");
});

test("컨트롤러: 세션이 없는 줄은 포커스에 들어가지 않고, 포커스 중 세션이 사라지면 입력을 멈춘다", async () => {
  const none = harness({ alive: false });
  await none.board.open();
  none.board.onInput("\r");
  assert.equal(none.board.state.focus, "list");
  assert.match(none.board.state.notice, /세션이 없어/);
  assert.deepEqual(none.log.pid, []);

  const h = harness();
  await h.board.open();
  h.board.onInput("\r");
  assert.equal(h.board.state.focus, "term");
  h.flags.gone = true;
  h.board.tick();
  assert.equal(h.board.state.focus, "list");
  assert.match(h.board.state.notice, /세션이 사라져 입력을 멈췄습니다/);
  h.board.onInput("a"); h.board.flush();
  assert.deepEqual(h.log.send, []);
});

test("board 코드는 새 세션·창·분할·크기 조절·붙기·종료 길이 없고 send-keys는 바닥 함수 한 곳에만 있다", () => {
  const files = ["src/board-model.mjs", "src/board-view.mjs", "src/board-input.mjs", "src/board-tui.mjs", "src/board-data.mjs", "src/commands/board.mjs"];
  for (const file of files) {
    const text = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    for (const word of ["send-keys", "new-session", "new-window", "split-window", "resize-", "attach", "kill-session", "kill-server", "kill-pane", "kill-window",
      "respawn", "set-option", "sendTmux", "sendTmuxKey", "floor.send", "floor.stop", "floor.create", "paste-buffer", "checkHumanIdle", "prefix"])
      assert.ok(!text.includes(word), `${file}에 ${word}`);
  }
  const floor = fs.readFileSync(new URL("../src/floor-tmux.mjs", import.meta.url), "utf8");
  const section = floor.slice(floor.indexOf("kadan board 터미널 칸"), floor.indexOf("// 카드는 pane 종료"));
  assert.ok(section.includes('"send-keys"') && section.includes("@kadan_human_input"));
  for (const word of ["new-session", "split-window", "resize-", "attach", "kill-", "respawn", "paste-buffer"])
    assert.ok(!section.includes(word), `바닥 함수에 ${word}`);
});

test("컨트롤러 F1: ESC가 먼저 오고 붙여넣기가 이어지면 Esc를 보내지 않고 한 덩어리로 보낸다", async () => {
  const h = harness();
  await h.board.open();
  h.board.onInput("\r");
  h.board.onInput("\x1b");
  await h.fire(50); // 이어질 조각을 기다리는 ESC_WAIT_MS 타이머가 걸린다(실제 sleep 없음)
  assert.deepEqual(h.log.send, []);
  assert.ok(h.board.state.focus === "term");
});

test("컨트롤러 F1: 이어지는 조각이 오면 대기 타이머를 취소하고 한 덩어리로 해석한다", async () => {
  const h = harness();
  await h.board.open();
  h.board.onInput("\r");
  h.board.onInput("\x1b");
  assert.ok([...h.timers.values()].some((t) => t.ms === 50));
  h.board.onInput("[200~payload\x1b[201~");
  assert.ok(![...h.timers.values()].some((t) => t.ms === 2000));
  h.board.flush();
  assert.deepEqual(h.log.send.map((s) => s.tokens), [[{ text: "payload" }]]);
});

test("컨트롤러 F1: ESC 단독은 시간이 지난 뒤에만 Esc로 보낸다", async () => {
  const h = harness();
  await h.board.open();
  h.board.onInput("\r");
  h.board.onInput("\x1b");
  h.board.flush();
  assert.deepEqual(h.log.send, []);
  await h.fire(50);
  h.board.flush();
  assert.deepEqual(h.log.send.map((s) => s.tokens), [[{ key: "Escape" }]]);
});

test("컨트롤러 F1: 끝 표시 없는 붙여넣기는 상한 시간 뒤 보내지 않고 한 줄로 알린다", async () => {
  const h = harness();
  await h.board.open();
  h.board.onInput("\r");
  h.board.onInput("\x1b[200~secret");
  await h.fire(2000);
  h.board.flush();
  assert.deepEqual(h.log.send, []);
  assert.match(h.board.state.notice, /끝 표시가 오지 않아/);
  assert.equal(h.board.state.focus, "term");
});

test("컨트롤러 F2: 한글 붙여넣기는 바이트 상한(21,846자)에서 보내지 않고 화면 안내가 같은 상수를 쓴다", async () => {
  const h = harness();
  await h.board.open();
  h.board.onInput("\r");
  h.board.onInput(`\x1b[200~${"가".repeat(21_846)}\x1b[201~`);
  h.board.flush();
  assert.deepEqual(h.log.send, []);
  assert.match(h.board.state.notice, /64KB/);
});
