import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import {
  attachArgv, attachEnv, badgesOf, buildEntries, cellWidth, fit, nightFor, nightWord, parseKeys, reduceKey,
  renderFrame, tailOf,
} from "../src/board-model.mjs";
import { createTerminal, SCREEN_SEQUENCES } from "../src/board-tui.mjs";
import { attachNow, loadDashboard, loadSupers, httpJson } from "../src/commands/board.mjs";

const strip = (text) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
const toSession = (role) => `kadan-${role}`;
const line = (repo, reason, exceptBranch = null) => ({ github: `o/${repo}`, repo, verdict: { action: "x", reason, exceptBranch } });
const summary = {
  night: { on: true },
  sidebar: [{ repo: "a", decisions: 2, merges: 1 }, { repo: "b", decisions: 0, merges: 3 }, { repo: "c", decisions: null, merges: null }],
};

test("문자 폭: 한글·이모지는 2칸, 결합 문자는 0칸이고 fit이 폭에 정확히 맞춘다", () => {
  assert.equal(cellWidth("abc"), 3);
  assert.equal(cellWidth("슈퍼감독"), 8);
  assert.equal(cellWidth("🌙함"), 4);
  assert.equal(cellWidth("é"), 1);
  for (const text of ["슈퍼감독-kadan", "짧음", "a🌙b한글한글한글한글", ""]) {
    for (const width of [1, 5, 10, 11]) assert.equal(cellWidth(fit(text, width)), width, `${text}/${width}`);
  }
  assert.equal(fit("가나다라마", 7), "가나다…");
  assert.equal(fit("a\tb\nc", 5), "a b c");
});

test("🌙 판정 문구는 화면(night-repos.ts badgeOf)과 같다", () => {
  assert.equal(nightWord(line("a", "allowed")), "함");
  assert.equal(nightWord(line("a", "allowed", "main")), "안 함(배포 브랜치 main)");
  assert.equal(nightWord(line("a", "night-merge-forbidden")), "금지");
  assert.equal(nightWord(line("a", "setup-needed")), "설정 필요");
  assert.equal(nightWord(line("a", "뭔가 새 판정")), "판정 모름");
});

test("🌙 합산: 모르면 ?, 줄이 없으면 -, 같으면 그 글자, 다르면 섞임", () => {
  const night = { repos: [line("a", "allowed"), line("b", "allowed"), line("c", "night-merge-forbidden")] };
  assert.equal(nightFor(null, ["a"]), "?");
  assert.equal(nightFor(night, null), "?");
  assert.equal(nightFor(night, ["zzz"]), "-");
  assert.equal(nightFor(night, ["a", "b"]), "함");
  assert.equal(nightFor(night, ["a", "c"]), "섞임");
});

test("목록: 저장소 뱃지를 슈퍼감독 단위로 더하고, 모르면 0이 아니라 ?, 세션 없음은 alive false", () => {
  const supers = [{ role: "x", repos: ["a", "b"] }, { role: "y", repos: null }, { role: "z", repos: ["a", "c"] }, { role: "w", repos: ["nope"] }];
  const entries = buildEntries({ supers, sessions: new Set(["kadan-x", "kadan-y"]), summary, nightRepos: null, toSession });
  assert.deepEqual(entries.map((e) => [e.role, e.alive, e.decisions, e.merges]),
    [["x", true, 2, 4], ["y", true, null, null], ["z", false, null, null], ["w", false, null, null]]);
  assert.equal(entries[0].nightOn, true);
  assert.equal(badgesOf(entries[0]), "⚑2 ⇡4 🌙?");
  assert.equal(badgesOf(entries[1]), "⚑? ⇡? 🌙?");
});

test("대시보드가 꺼져 있으면(summary null) 뱃지는 전부 ?이고 목록·세션 표시는 그대로", () => {
  const entries = buildEntries({ supers: [{ role: "x", repos: ["a"] }], sessions: new Set(["kadan-x"]), summary: null, nightRepos: null, toSession });
  assert.equal(entries[0].alive, true);
  assert.equal(entries[0].decisions, null);
  assert.equal(entries[0].nightOn, false);
});

test("키 파싱: 화살표·jk·Enter·v·r·q·Ctrl-C만 인식하고 나머지는 버린다", () => {
  assert.deepEqual(parseKeys("\x1b[A\x1b[Bjk\rvrq\x03"), ["up", "down", "down", "up", "enter", "v", "r", "q", "ctrl-c"]);
  assert.deepEqual(parseKeys("hello\x1b[Cxyz"), []);
  assert.deepEqual(parseKeys("한글🌙"), []);
});

test("키 상태 전이: 선택은 범위 안에 머물고, Enter·v는 살아 있는 줄에서만 동작", () => {
  const entries = [{ role: "a", alive: true }, { role: "b", alive: false }];
  let r = reduceKey({ sel: 0, notice: "" }, "up", entries);
  assert.equal(r.state.sel, 0);
  r = reduceKey(r.state, "down", entries); assert.equal(r.state.sel, 1);
  r = reduceKey(r.state, "down", entries); assert.equal(r.state.sel, 1);
  r = reduceKey(r.state, "enter", entries);
  assert.equal(r.action, null);
  assert.match(r.state.notice, /세션이 없어/);
  r = reduceKey({ sel: 1, notice: "" }, "v", entries); assert.equal(r.action, null);
  r = reduceKey({ sel: 0, notice: "남은 안내" }, "enter", entries);
  assert.deepEqual([r.action, r.state.notice], ["attach", ""]);
  assert.equal(reduceKey({ sel: 0, notice: "" }, "v", entries).action, "view");
  assert.equal(reduceKey({ sel: 0, notice: "" }, "r", entries).action, "refresh");
  assert.equal(reduceKey({ sel: 0, notice: "" }, "q", entries).action, "quit");
  assert.equal(reduceKey({ sel: 0, notice: "" }, "ctrl-c", entries).action, "quit");
  assert.equal(reduceKey({ sel: 0, notice: "" }, "enter", []).action, null);
  assert.equal(reduceKey({ sel: 9, notice: "" }, "down", entries).state.sel, 1);
});

test("붙기 명령: 정확 대상 =세션:, 읽기 전용은 -r, TMUX는 지우고 창 선택 값도 뺀다", () => {
  assert.deepEqual(attachArgv({ session: "kadan-x", socket: "s1" }), ["-u", "-L", "s1", "attach", "-t", "=kadan-x:"]);
  assert.deepEqual(attachArgv({ session: "kadan-x", socket: "s1", readOnly: true }), ["-u", "-L", "s1", "attach", "-r", "-t", "=kadan-x:"]);
  const env = attachEnv({ TMUX: "/tmp/tmux-1/kadan,1,0", KADAN_WINDOW: "rottie", KADAN_ROTTIE_BIN: "/x", PATH: "/bin" });
  assert.deepEqual(env, { PATH: "/bin" });
});

test("attachNow: has-session이 거짓이면 붙지 않고, 참이면 tmux attach만 부른다(새 세션·키 전송 없음)", () => {
  const calls = [];
  const out = { write: (t) => calls.push(["out", t]) };
  const gone = attachNow({ session: "kadan-x", readOnly: false, has: () => false, spawn: () => assert.fail("붙으면 안 됨"), out, pause() {} });
  assert.equal(gone.attached, false);
  assert.match(gone.notice, /사라져/);
  const spawn = (bin, argv, opts) => { calls.push(["spawn", bin, argv, opts.stdio, opts.env.TMUX]); return { status: 0 }; };
  const ok = attachNow({ session: "kadan-x", readOnly: true, has: () => true, spawn, guard() {}, socket: "s1", env: { TMUX: "in" }, out, pause: (ms) => calls.push(["pause", ms]) });
  assert.deepEqual(ok, { attached: true, notice: "" });
  assert.deepEqual(calls.map((c) => c[0]), ["out", "pause", "spawn"]);
  assert.match(calls[0][1], /kadan-x에 들어갑니다 \(읽기 전용\) · 빠져나오기: prefix d/);
  assert.deepEqual(calls[2].slice(1), ["tmux", ["-u", "-L", "s1", "attach", "-r", "-t", "=kadan-x:"], "inherit", undefined]);
  const failed = attachNow({ session: "kadan-x", readOnly: false, has: () => true, spawn: () => ({ status: 1 }), guard() {}, out, pause() {} });
  assert.match(failed.notice, /종료 코드 1/);
});

test("attachNow: 운영 구획 가드가 던지면 붙지 않는다", () => {
  assert.throws(() => attachNow({ session: "kadan-x", readOnly: false, has: () => true, guard() { throw new Error("막힘"); },
    spawn: () => assert.fail("붙으면 안 됨"), out: { write() {} }, pause() {} }), /막힘/);
});

test("터미널 복구: enter 뒤 restore가 raw 모드·커서·원래 화면을 돌려놓고 여러 번 불러도 안전하다", () => {
  const writes = [];
  const stdin = Object.assign(new EventEmitter(), { isRaw: false, raws: [], paused: 0, resumed: 0,
    setRawMode(v) { this.raws.push(v); this.isRaw = v; }, resume() { this.resumed++; }, pause() { this.paused++; }, setEncoding() {} });
  const stdout = { columns: 100, rows: 30, write: (t) => writes.push(t) };
  const term = createTerminal({ stdin, stdout });
  term.write("무시됨"); // 활성 전에는 쓰지 않는다
  term.enter(); term.enter();
  assert.deepEqual(stdin.raws, [true]);
  assert.equal(writes[0], SCREEN_SEQUENCES.ENTER);
  term.restore(); term.restore();
  assert.deepEqual(stdin.raws, [true, false]);
  assert.equal(stdin.paused, 1);
  assert.deepEqual(writes, [SCREEN_SEQUENCES.ENTER, SCREEN_SEQUENCES.LEAVE]);
  assert.match(SCREEN_SEQUENCES.LEAVE, /\?25h.*\?1049l/);
  assert.deepEqual(term.size(), { cols: 100, rows: 30 });
});

test("터미널 복구: 원래 raw였다면 raw로 돌려놓는다", () => {
  const stdin = Object.assign(new EventEmitter(), { isRaw: true, raws: [], setRawMode(v) { this.raws.push(v); }, resume() {}, pause() {}, setEncoding() {} });
  const term = createTerminal({ stdin, stdout: { write() {} } });
  term.enter(); term.restore();
  assert.deepEqual(stdin.raws, [true, true]);
});

test("화면: 모든 줄이 터미널 폭에 정확히 맞고(한글·이모지 포함), 선택·회색 줄이 구분된다", () => {
  const entries = buildEntries({
    supers: [{ role: "kadan-슈퍼감독", repos: ["a", "b"] }, { role: "긴-이름-".repeat(8), repos: ["c"] }, { role: "z", repos: null }],
    sessions: new Set(["kadan-kadan-슈퍼감독"]), summary, nightRepos: { repos: [line("a", "allowed"), line("b", "allowed")] }, toSession,
  });
  for (const cols of [40, 80, 120]) {
    const frame = renderFrame({ entries, state: { sel: 0, notice: "" }, cols, rows: 12, preview: ["첫 줄", "둘째 줄 🌙".repeat(20)], dashboard: "연결됨" });
    const lines = strip(frame).split("\r\n");
    assert.equal(lines.length, 12);
    for (const l of lines) assert.equal(cellWidth(l), cols, `${cols}: ${l}`);
  }
  const frame = renderFrame({ entries, state: { sel: 0, notice: "" }, cols: 80, rows: 12, preview: [] });
  assert.match(frame, /\x1b\[7m▶ kadan-슈퍼감독/);
  assert.match(frame, /\x1b\[2m.*긴-이름/); // 세션 없음은 흐리게
  const second = renderFrame({ entries, state: { sel: 2, notice: "" }, cols: 80, rows: 12, preview: [] });
  assert.match(second, /\x1b\[1;33m🌙함/); // 나이트런 켜짐이면(선택 아닌 살아 있는 줄) 강조
  assert.match(strip(frame), /Enter 들어가 입력 · v 읽기 전용 · r 새로 읽기 · q 끝/);
});

test("화면: 목록이 비어도 깨지지 않는다", () => {
  const frame = strip(renderFrame({ entries: [], state: { sel: 0, notice: "안내" }, cols: 60, rows: 8 }));
  assert.match(frame, /슈퍼감독 0명/);
  assert.match(frame, /안내/);
});

test("미리보기 꼬리: 색 코드를 지우고 끝의 빈 줄을 빼고 마지막 N줄만 남긴다", () => {
  assert.deepEqual(tailOf("a\n\x1b[31mb\x1b[0m  \n\n\n", 5), ["a", "b"]);
  assert.deepEqual(tailOf("1\n2\n3\n4\n\n", 2), ["3", "4"]);
  assert.deepEqual(tailOf("x", 0), []);
});

test("슈퍼감독 출처: 대시보드 현황의 supervisors를 쓰고, 실패하면 로컬 계산으로 돌아간다", async () => {
  const status = { supervisors: { items: [{ super: "s1", repos: ["a"] }, { super: "s2", repos: [] }] } };
  const ok = await loadSupers({ fetchJson: async (p) => { assert.equal(p, "/api/dashboard/status"); return status; }, local: () => assert.fail("로컬 금지") });
  assert.deepEqual(ok, { supers: [{ role: "s1", repos: ["a"] }, { role: "s2", repos: null }], source: "dashboard" });
  const down = await loadSupers({ fetchJson: async () => { throw new Error("refused"); }, local: () => [{ role: "L", repos: null }] });
  assert.deepEqual(down, { supers: [{ role: "L", repos: null }], source: "local" });
  const nullTable = await loadSupers({ fetchJson: async () => ({ supervisors: null }), local: () => [{ role: "L", repos: null }] });
  assert.equal(nullTable.source, "local");
  const none = await loadSupers({ fetchJson: async () => { throw new Error("x"); }, local: () => { throw new Error("y"); } });
  assert.deepEqual(none, { supers: [], source: "none" });
});

test("대시보드 값: 실패한 것만 null이고, night 정책은 요청할 때만 읽는다", async () => {
  const seen = [];
  const fetchJson = async (p) => { seen.push(p); if (p === "/api/night/repos") throw new Error("down"); return { ok: p }; };
  assert.deepEqual(await loadDashboard({ fetchJson }), { summary: { ok: "/api/dashboard/summary" }, nightRepos: null });
  seen.length = 0;
  await loadDashboard({ fetchJson, night: false });
  assert.deepEqual(seen, ["/api/dashboard/summary"]);
});

test("httpJson: 127.0.0.1 주소로 GET만 하고, 오류 코드는 던진다", async () => {
  const urls = [];
  const fake = async (url, opts) => { urls.push([url, opts.method]); return { ok: url.includes("good"), status: 500, json: async () => ({ a: 1 }) }; };
  assert.deepEqual(await httpJson("8790", fake)("/good"), { a: 1 });
  await assert.rejects(httpJson("8790", fake)("/bad"), /HTTP 500/);
  assert.equal(urls[0][0], "http://127.0.0.1:8790/good");
  assert.equal(urls[0][1], undefined);
});

test("board 코드는 새 세션·창 만들기, 키 보내기, 세션 끄기 길이 없다", () => {
  for (const file of ["src/board-model.mjs", "src/board-tui.mjs", "src/commands/board.mjs"]) {
    const text = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    for (const word of ["send-keys", "new-session", "new-window", "kill-session", "kill-server", "sendTmux", "sendTmuxKey", "floor.send", "floor.stop", "floor.create", "paste-buffer"])
      assert.ok(!text.includes(word), `${file}에 ${word}`);
  }
});
