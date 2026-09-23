import test from "node:test";
import assert from "node:assert/strict";
import { currentRottieWindow, planRestore, runRestore } from "../src/restore.mjs";
import { buildRottieCreateArgv, showRottieWindow } from "../src/floor-tmux.mjs";

const start = (session, extra = {}) => ({ kind: "start", session, role: session.slice(6), cwd: "/w", ...extra });

test("현재 로티 탭: 마지막 start의 탭을 쓰고 뒤이은 window 기록이 갈아 끼운다", () => {
  const entries = [
    start("kadan-a", { rottieTerminalId: "t1" }),
    { kind: "window", session: "kadan-a", rottieTerminalId: "t2" },
    start("kadan-b", { rottieTerminalId: "x1" }),
  ];
  assert.deepEqual(currentRottieWindow(entries, "kadan-a"), { role: "a", cwd: "/w", rottieTerminalId: "t2" });
  assert.equal(currentRottieWindow(entries, "kadan-b").rottieTerminalId, "x1");
  assert.equal(currentRottieWindow(entries, "kadan-c"), null);
});

test("현재 로티 탭: 탭 없이 다시 띄운 세션은 옛 탭을 물려받지 않는다", () => {
  const entries = [start("kadan-a", { rottieTerminalId: "t1" }), start("kadan-a", { window: "hidden" })];
  assert.equal(currentRottieWindow(entries, "kadan-a"), null);
});

test("복구 대상: 죽은 탭·지워진 탭만 고르고 살아 있는 탭과 창 기록 없는 세션은 건너뛴다", () => {
  const entries = [
    start("kadan-live", { rottieTerminalId: "t-live" }),
    start("kadan-dead", { rottieTerminalId: "t-dead" }),
    start("kadan-gone", { rottieTerminalId: "t-gone" }),
    start("kadan-closed", { rottieTerminalId: "t-closed" }),
    start("kadan-watch", { window: "hidden" }),
  ];
  const states = { "t-live": "running", "t-dead": "unknown", "t-closed": "closed" };
  const sessions = ["kadan-live", "kadan-dead", "kadan-gone", "kadan-closed", "kadan-watch"].map((session, i) => ({ session, pid: String(100 + i) }));
  const { items, error } = planRestore({
    sessions,
    entries,
    show: (id) => (states[id] ? { ok: true, state: states[id] } : { ok: false, code: "ROTTIE_TERMINAL_NOT_FOUND" }),
  });
  assert.equal(error, undefined);
  const bySession = Object.fromEntries(items.map((item) => [item.session, item]));
  assert.equal(bySession["kadan-live"].action, "skip");
  assert.equal(bySession["kadan-watch"].reason, "로티 창 기록 없음");
  assert.equal(bySession["kadan-dead"].action, "restore");
  assert.equal(bySession["kadan-dead"].oldState, "unknown");
  assert.equal(bySession["kadan-dead"].pid, "101");
  assert.equal(bySession["kadan-gone"].oldState, "없음");
  assert.equal(bySession["kadan-closed"].action, "restore");
});

test("복구 대상: 탭 조회가 하나라도 실패하면 아무것도 고르지 않는다", () => {
  const entries = [start("kadan-a", { rottieTerminalId: "t1" }), start("kadan-b", { rottieTerminalId: "t2" })];
  const result = planRestore({
    sessions: [{ session: "kadan-a", pid: "1" }, { session: "kadan-b", pid: "2" }],
    entries,
    show: (id) => (id === "t1" ? { ok: true, state: "unknown" } : { ok: false, code: "ROTTIE_APP_NOT_RUNNING" }),
  });
  assert.equal(result.items, undefined);
  assert.match(result.error, /ROTTIE_APP_NOT_RUNNING/);
});

test("복구 대상: 역할을 고르면 그 세션만 보고 없는 세션은 알린다", () => {
  const entries = [start("kadan-a", { rottieTerminalId: "t1" }), start("kadan-b", { rottieTerminalId: "t2" })];
  const shown = [];
  const { items } = planRestore({
    sessions: [{ session: "kadan-a", pid: "1" }, { session: "kadan-b", pid: "2" }],
    entries,
    only: ["kadan-b", "kadan-z"],
    show: (id) => {
      shown.push(id);
      return { ok: true, state: "unknown" };
    },
  });
  assert.deepEqual(shown, ["t2"]);
  assert.deepEqual(items.map((item) => [item.session, item.action]), [["kadan-z", "skip"], ["kadan-b", "restore"]]);
  assert.equal(items[0].reason, "세션 없음");
});

test("복구 실행: 새 멱등 키로 탭을 열고 window 기록을 남기며 죽은 옛 탭만 지운다", () => {
  const opened = [];
  const removed = [];
  const records = [];
  const lines = [];
  const items = [
    { session: "kadan-a", role: "a", cwd: "/w", pid: "10", oldTerminalId: "t1", oldState: "unknown", action: "restore" },
    { session: "kadan-b", role: "b", cwd: "/w", pid: "11", oldTerminalId: "t2", oldState: "없음", action: "restore" },
    { session: "kadan-c", action: "skip", reason: "탭 살아 있음(running)" },
  ];
  const { failed } = runRestore({
    items,
    open: (item) => {
      opened.push(item);
      return { method: "rottie", rottieTerminalId: `new-${item.session}` };
    },
    remove: (id) => {
      removed.push(id);
      return { removed: true };
    },
    record: (entry) => records.push(entry),
    print: (line) => lines.push(line),
    now: () => 42,
  });
  assert.equal(failed, 0);
  // 데몬을 다시 켜도 로티는 멱등 키를 기억한다 — 옛 키(kadan-<세션>-<PID>)면 죽은 탭을 돌려준다.
  assert.deepEqual(opened.map((item) => item.idempotencyKey), ["kadan-kadan-a-10-restore-42", "kadan-kadan-b-11-restore-42"]);
  assert.notEqual(opened[0].idempotencyKey, "kadan-kadan-a-10");
  assert.deepEqual(removed, ["t1"]);
  assert.deepEqual(records[0], {
    kind: "window", role: "a", session: "kadan-a", rottieTerminalId: "new-kadan-a", restoredFrom: "t1", oldState: "unknown", panePid: "10",
  });
  assert.equal(records.length, 2);
  assert.match(lines.at(-1), /건너뜀: kadan-c/);
});

test("복구 실행: 탭을 못 붙이면 기록 없이 실패로 센다", () => {
  const records = [];
  const { failed } = runRestore({
    items: [{ session: "kadan-a", role: "a", pid: "10", oldTerminalId: "t1", oldState: "unknown", action: "restore" }],
    open: () => null,
    remove: () => assert.fail("옛 탭을 지우면 안 된다"),
    record: (entry) => records.push(entry),
    print: () => {},
  });
  assert.equal(failed, 1);
  assert.deepEqual(records, []);
});

test("로티 탭 생성 인자: 멱등 키를 주면 그 키를, 없으면 세션·PID 키를 쓴다", () => {
  const base = { role: "a", session: "kadan-a", cwd: "/w", socket: "kadan", panePid: "10" };
  const keyOf = (argv) => argv[argv.indexOf("--idempotency-key") + 1];
  assert.equal(keyOf(buildRottieCreateArgv(base)), "kadan-kadan-a-10");
  assert.equal(keyOf(buildRottieCreateArgv({ ...base, idempotencyKey: "k2" })), "k2");
});

test("로티 탭 상태 조회: 상태·없는 탭·JSON 아닌 실패를 구분한다", () => {
  const reply = (stdout, status = 0) => () => ({ stdout, status });
  const ok = showRottieWindow({ bin: "/r", terminalId: "t", spawnFn: reply(JSON.stringify({ ok: true, result: { terminal: { state: "unknown" } } })) });
  assert.deepEqual(ok, { ok: true, state: "unknown" });
  const missing = showRottieWindow({ bin: "/r", terminalId: "t", spawnFn: reply(JSON.stringify({ ok: false, error: { code: "ROTTIE_TERMINAL_NOT_FOUND" } }), 3) });
  assert.deepEqual(missing, { ok: false, code: "ROTTIE_TERMINAL_NOT_FOUND" });
  const broken = showRottieWindow({ bin: "/r", terminalId: "t", spawnFn: reply("boom", 4) });
  assert.deepEqual(broken, { ok: false, code: 4 });
});
