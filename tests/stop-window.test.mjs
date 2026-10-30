import './helpers/isolated-home.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import * as cli from "../src/cli.mjs";
import * as tmux from "../src/floor-tmux.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { floor } from "../src/floor.mjs";

const base = { kind: "stop", role: "c57-작업자", session: "kadan-c57-작업자", by: "사람" };
const entry = () => cli.buildStopLedgerEntry({ role: base.role, session: base.session, env: {} });
const reachable = {existsFn:()=>true, listBinsFn:()=>[], connectFn:()=>({ok:true}), showFn:()=>({ok:true,state:'closed'})};
test("baseline: stop entry retains its existing shape and pending cards", () => {
  assert.deepEqual(entry(), base);
  assert.deepEqual(cli.pendingCardsFor([{ kind: "send", role: base.role, taskId: "pending" }], base.role), ["pending"]);
});

{
  const spawnOk = calls => (...args) => { calls.push(args); return { status: 0 }; };
  test("stop은 start가 연 로티 탭을 한 번 닫고 한 번 제거한다 — close만으로는 탭이 '종료됨'으로 남았다(2026-09-05 card-57, 2026-09-13)", () => {
    const calls = [];
    const fields = cli.closeStartedWindow({ rottieTerminalId: "owned-tab" }, {
      ...reachable,
      env: { KADAN_ROTTIE_BIN: "/fake/rottie" }, print() {},
      closeFn: (options) => tmux.closeRottieWindow({ ...options, spawnFn: spawnOk(calls) }),
      removeFn: (options) => tmux.removeRottieWindow({ ...options, spawnFn: spawnOk(calls) }),
    });
    assert.deepEqual(calls, [
      ["/fake/rottie", ["terminal", "close", "--terminal", "owned-tab", "--json"], { encoding: "utf8" }],
      ["/fake/rottie", ["terminal", "remove", "--terminal", "owned-tab", "--json"], { encoding: "utf8" }],
    ]);
    assert.deepEqual({ ...entry(), ...fields }, { ...base, rottieTerminalId: "owned-tab", rottieWindowClosed: true, rottieWindowRemoved: true });
  });
  test("close failure is recorded without throw, retry, or remove", () => {
    let calls = 0;
    const fields = cli.closeStartedWindow({ rottieTerminalId: "owned-tab" }, {
      ...reachable,
      env: { KADAN_ROTTIE_BIN: "/fake" }, print() {},
      closeFn: (options) => tmux.closeRottieWindow({ ...options, spawnFn: () => { calls++; return { status: 1, stdout: JSON.stringify({ error: { code: "ROTTIE_INTERNAL", message: "failed" } }) }; } }),
      removeFn() { assert.fail("unexpected remove"); },
    });
    assert.equal(calls, 1);
    assert.deepEqual({ ...entry(), ...fields }, { ...base, rottieTerminalId: "owned-tab", rottieWindowClosed: false, rottieWindowError: "ROTTIE_INTERNAL", rottieWindowMessage: "failed" });
  });
  test("remove failure keeps the close receipt and is recorded once without retry", () => {
    let removes = 0;
    const lines = [];
    const fields = cli.closeStartedWindow({ rottieTerminalId: "owned-tab" }, {
      ...reachable,
      env: { KADAN_ROTTIE_BIN: "/fake" }, print: line => lines.push(line),
      closeFn: () => ({ closed: true }),
      removeFn: (options) => tmux.removeRottieWindow({ ...options, spawnFn: () => { removes++; return { status: 5, stdout: JSON.stringify({ ok: false, error: { code: "ROTTIE_TERMINAL_RUNNING", message: "먼저 terminal close로 종료하세요." } }) }; } }),
    });
    assert.equal(removes, 1);
    assert.deepEqual({ ...entry(), ...fields }, { ...base, rottieTerminalId: "owned-tab", rottieWindowClosed: true, rottieWindowRemoved: false, rottieRemoveError: "ROTTIE_TERMINAL_RUNNING", rottieRemoveMessage: "먼저 terminal close로 종료하세요." });
    assert.deepEqual(lines.map(line => line.split(":")[0]), ["창 닫힘", "탭 제거 실패"]);
  });
  test("missing last-start tab leaves entry unchanged and never closes", () => {
    for (const start of [undefined, {}, { window: "orca" }]) {
      assert.deepEqual({ ...entry(), ...cli.closeStartedWindow(start, { env: {}, closeFn() { assert.fail("unexpected close"); }, removeFn() { assert.fail("unexpected remove"); }, print() { assert.fail("unexpected report"); } }) }, base);
    }
  });
  test("unset binary records skipped close", () => {
    const lines = [];
    const fields = cli.closeStartedWindow({ rottieTerminalId: "owned-tab" }, { env: {}, listBinsFn:()=>[], print: line => lines.push(line), closeFn() { assert.fail("unexpected close"); }, removeFn() { assert.fail("unexpected remove"); } });
    assert.equal(lines.length, 1);
    const { rottieWindowMessage, ...rest } = fields;
    assert.deepEqual(rest, { rottieTerminalId: "owned-tab", rottieWindowClosed: false, rottieWindowError: "KADAN_ROTTIE_BIN 없음" });
    assert.match(rottieWindowMessage, /KADAN_ROTTIE_BIN/);
    assert.ok(rottieWindowMessage.length <= 201);
  });
  test("close and remove handle non-JSON, spawn errors and thrown errors once", () => {
    for (const result of [{ status: 7, stderr: "bad" }, { status: null, error: Object.assign(new Error("missing"), { code: "ENOENT" }) }, new Error("thrown")]) {
      let calls = 0;
      const closed = tmux.closeRottieWindow({ bin: "/fake", terminalId: "owned", spawnFn() { calls++; if (result instanceof Error) throw result; return result; } });
      assert.equal(calls, 1);
      assert.equal(closed.closed, false);
      assert.ok(closed.message);
      assert.equal(closed.code, result.status === 7 ? 7 : result.error ? "ENOENT" : "ROTTIE_CLOSE_FAILED");
      let removes = 0;
      const removed = tmux.removeRottieWindow({ bin: "/fake", terminalId: "owned", spawnFn() { removes++; if (result instanceof Error) throw result; return result; } });
      assert.equal(removes, 1);
      assert.equal(removed.removed, false);
      assert.ok(removed.message);
      assert.equal(removed.code, result.status === 7 ? 7 : result.error ? "ENOENT" : "ROTTIE_REMOVE_FAILED");
    }
  });
}


test("cmdStop wires last start after floor stop and appends the close receipt", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-c57-wiring-"));
  const previous = process.env.KADAN_HOME;
  const bin = process.env.KADAN_ROTTIE_BIN;
  const autoAttach = process.env.KADAN_ROTTIE_AUTO_ATTACH;
  const exitCode = process.exitCode;
  process.env.KADAN_HOME = home;
  process.env.KADAN_ROTTIE_AUTO_ATTACH = 'off';
  delete process.env.KADAN_ROTTIE_BIN;
  t.after(() => {
    if (previous === undefined) delete process.env.KADAN_HOME;
    else process.env.KADAN_HOME = previous;
    if (bin === undefined) delete process.env.KADAN_ROTTIE_BIN;
    else process.env.KADAN_ROTTIE_BIN = bin;
    if (autoAttach === undefined) delete process.env.KADAN_ROTTIE_AUTO_ATTACH;
    else process.env.KADAN_ROTTIE_AUTO_ATTACH = autoAttach;
    process.exitCode = exitCode;
  });
  cli.appendLedger({ kind: "start", role: base.role, session: base.session, rottieTerminalId: "stale" });
  cli.appendLedger({ kind: "start", role: base.role, session: base.session, panePid:'11', rottieTerminalId: "latest" });
  let stopped = false;
  t.mock.method(floor, "alive", () => true);
  t.mock.method(floor, "pid", () => '11');
  t.mock.method(floor, "stop", session => { assert.equal(session, base.session); stopped = true; });
  t.mock.method(console, "log", () => { assert.equal(stopped, true); });
  t.mock.method(console, "error", () => { assert.equal(stopped, true); });
  cli.main(["stop", base.role]);
  assert.equal(process.exitCode,1);
  const rows = cli.readLedger();
  assert.equal(rows.length, 3);
  assert.equal(rows.at(-1).kind, "stop");
  assert.equal(rows.at(-1).rottieTerminalId, "latest");
  assert.equal(rows.at(-1).rottieWindowClosed, false);
  assert.equal(Object.hasOwn(rows.at(-1), "window"), false);
});

test("창 정리 실패는 로티가 준 원인 문구를 정리해 원장 필드에 남긴다", () => {
  const run = overrides => cli.closeStartedWindow({ rottieTerminalId: "owned-tab" }, {
    ...reachable, env: { KADAN_ROTTIE_BIN: "/fake" }, print() {}, ...overrides,
  });
  const preflight = run({ connectFn: () => ({ ok: false, code: "ROTTIE_APP_NOT_RUNNING", message: "앱이\n꺼져 있다" }) });
  assert.equal(preflight.rottieWindowError, "ROTTIE_APP_NOT_RUNNING");
  assert.equal(preflight.rottieWindowMessage, "앱이 꺼져 있다");
  const show = run({ showFn: () => ({ ok: false, code: "ROTTIE_TERMINAL_NOT_FOUND", message: "탭 없음" }),
    closeFn() { assert.fail("unexpected close"); } });
  assert.equal(show.rottieWindowMessage, "탭 없음");
  const close = run({ closeFn: () => ({ closed: false, code: "ROTTIE_INTERNAL", message: "내부\t오류" }) });
  assert.equal(close.rottieWindowMessage, "내부 오류");
  const remove = run({ closeFn: () => ({ closed: true }),
    removeFn: () => ({ removed: false, code: "ROTTIE_TERMINAL_RUNNING", message: "먼저 close" }) });
  assert.equal(remove.rottieRemoveMessage, "먼저 close");
  assert.equal(remove.rottieWindowMessage, undefined);
});

test("성공하면 문구 필드가 없고 긴 문구는 200자에서 자르고 …를 붙인다", () => {
  const ok = cli.closeStartedWindow({ rottieTerminalId: "owned-tab" }, {
    ...reachable, env: { KADAN_ROTTIE_BIN: "/fake" }, print() {},
    closeFn: () => ({ closed: true }), removeFn: () => ({ removed: true }),
  });
  assert.deepEqual(Object.keys(ok).sort(), ["rottieTerminalId", "rottieWindowClosed", "rottieWindowRemoved"]);
  const long = cli.closeStartedWindow({ rottieTerminalId: "owned-tab" }, {
    ...reachable, env: { KADAN_ROTTIE_BIN: "/fake" }, print() {},
    closeFn: () => ({ closed: false, code: "X", message: "가".repeat(500) }),
  });
  assert.equal(long.rottieWindowMessage, `${"가".repeat(200)}…`);
  const empty = cli.closeStartedWindow({ rottieTerminalId: "owned-tab" }, {
    ...reachable, env: { KADAN_ROTTIE_BIN: "/fake" }, print() {},
    closeFn: () => ({ closed: false, code: "X", message: " \n " }),
  });
  assert.equal("rottieWindowMessage" in empty, false);
});

test("문구 정리는 글자(grapheme) 200개 기준으로 자르고 글자를 반으로 끊지 않는다", () => {
  const msg = (message) => cli.closeStartedWindow({ rottieTerminalId: "owned-tab" }, {
    ...reachable, env: { KADAN_ROTTIE_BIN: "/fake" }, print() {},
    closeFn: () => ({ closed: false, code: "X", message }),
  }).rottieWindowMessage;
  const count = (s) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].length;
  const emojiEdge = msg("a".repeat(199) + "😀xyz");
  assert.equal(emojiEdge.isWellFormed(), true);
  assert.equal(emojiEdge, `${"a".repeat(199)}😀…`);
  assert.equal(msg("😀".repeat(250)), `${"😀".repeat(200)}…`);
  const jamo = "각";
  assert.equal(msg("a".repeat(199) + jamo + "b"), `${"a".repeat(199)}${jamo}…`);
  const zwj = "👨‍👩‍👧";
  assert.equal(msg("a".repeat(199) + zwj + "b"), `${"a".repeat(199)}${zwj}…`);
  assert.doesNotMatch(msg("before\u0085\u009bafter"), /\p{Cc}/u);
  assert.equal(msg("before\u0085\u009bafter"), "before after");
  assert.equal(msg("a".repeat(200)), "a".repeat(200));
  assert.equal(count(msg("😀".repeat(200))), 200);
  assert.equal(msg("a".repeat(201)), `${"a".repeat(200)}…`);
  assert.equal(msg("😀".repeat(201)), `${"😀".repeat(200)}…`);
});
