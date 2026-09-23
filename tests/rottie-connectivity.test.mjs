import test from "node:test";
import assert from "node:assert/strict";
import * as cli from "../src/cli.mjs";
import * as tmux from "../src/floor-tmux.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { floor } from "../src/floor.mjs";

const runtime = { bundleId: "com.example.rottie.dev", build: "test-build" };
const reply = (ok) => ({ status: ok ? 0 : 4, stdout: JSON.stringify({ ok, runtime, ...(ok ? { result: { terminal: { id: "owned-tab" } } } : { error: { code: "ROTTIE_APP_NOT_RUNNING", message: "not connected" } }) }) });
const deps = (spawnFn) => ({ choice: { kind: "rottie" }, rottieBin: "/fake/rottie", spawnFn, waitForClient: () => true });

for (const ok of [true, false]) {
  test(`baseline: create ${ok ? "success records rottie" : "failure leaves manual"}`, (t) => {
    const lines = [];
    t.mock.method(console, "error", line => lines.push(line));
    const calls = [];
    const opened = tmux.openWindow("kadan-c58-worker", "darwin", deps((bin, argv) => { calls.push(argv); return reply(ok); }));
    assert.equal(opened?.method ?? "manual", ok ? "rottie" : "manual");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 2), ["terminal", "create"]);
    if (!ok) assert.match(lines[0], /ROTTIE_APP_NOT_RUNNING/);
    const entry = cli.buildStartLedgerEntry({ floorName: "tmux", role: "c58-worker", session: "kadan-c58-worker", evidence: { panePid: "123" }, window: opened?.method ?? "manual" });
    assert.equal(entry.window, ok ? "rottie" : "manual");
  });
}

test("start는 로티 CLI가 켜진 앱과 이어지는지 먼저 본다 — 번들이 달라 창이 조용히 manual로 떨어졌다(2026-09-05)(card-58)", () => {
  const calls = [], lines = [];
  const opened = cli.openStartedWindow("kadan-c58-worker", "darwin", { ...deps((bin, argv) => { calls.push([bin, argv]); return reply(false); }), print: line => lines.push(line) });
  assert.deepEqual(calls, [["/fake/rottie", ["status", "--json"]]]);
  assert.deepEqual(opened, { method: "manual", rottieConnect: "failed", rottieBundleId: runtime.bundleId, rottieConnectError: "ROTTIE_APP_NOT_RUNNING" });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(runtime.bundleId));
  assert.match(lines[0], /ROTTIE_APP_NOT_RUNNING/);
});

test("status ok precedes exactly one create and preserves receipt", () => {
  const calls = [];
  const opened = cli.openStartedWindow("kadan-c58-worker", "darwin", { ...deps((bin, argv) => { calls.push(argv); return reply(true); }), print() { assert.fail("unexpected diagnosis"); } });
  assert.deepEqual(calls.map(argv => argv.slice(0, 2)), [["status", "--json"], ["terminal", "create"]]);
  assert.deepEqual(opened, { method: "rottie", rottieTerminalId: "owned-tab", rottieConnect: "ok", rottieBundleId: runtime.bundleId });
});

test("connectivity returns runtime and never throws or retries for spawn and malformed failures", () => {
  for (const result of [reply(true), reply(false), { status: null, error: Object.assign(new Error("missing"), { code: "ENOENT" }) }, Object.assign(new Error("missing"), { code: "ENOENT" }), { status: 1, stdout: "not JSON", stderr: "bad status" }]) {
    let calls = 0;
    const value = tmux.rottieConnectivity({ bin: "/fake", spawnFn(bin, argv, options) {
      calls++;
      assert.equal(bin, "/fake");
      assert.deepEqual(argv, ["status", "--json"]);
      assert.deepEqual(options, { encoding: "utf8" });
      if (result instanceof Error) throw result;
      return result;
    } });
    assert.equal(calls, 1);
    if (result.stdout?.startsWith("{")) {
      assert.equal(value.bundleId, runtime.bundleId);
      assert.equal(value.build, runtime.build);
      assert.equal(value.ok, result.status === 0);
      if (!value.ok) assert.equal(value.code, "ROTTIE_APP_NOT_RUNNING");
    } else {
      assert.equal(value.ok, false);
      assert.equal(value.code, result.error || result instanceof Error ? "ENOENT" : "ROTTIE_STATUS_FAILED");
      assert.ok(value.message);
    }
  }
});

test("stop failure diagnoses bundle once; success never probes and removes the tab once", () => {
  for (const closed of [true, false]) {
    let probes = 0, closes = 0, removes = 0;
    const lines = [];
    cli.closeStartedWindow({ rottieTerminalId: "owned-tab" }, {
      env: { KADAN_ROTTIE_BIN: "/fake" },
      closeFn() { closes++; return { closed, code: "ROTTIE_INTERNAL" }; },
      removeFn() { removes++; return { removed: true }; },
      connectFn({ bin }) { assert.equal(bin, "/fake"); probes++; return { ok: false, ...runtime }; },
      print: line => lines.push(line),
    });
    assert.equal(closes, 1);
    assert.equal(probes, closed ? 0 : 1);
    assert.equal(removes, closed ? 1 : 0);
    assert.equal(lines.length, closed ? 2 : 1);
    if (!closed) assert.ok(lines[0].includes(runtime.bundleId));
  }
});

test("cmdStart writes failed preflight receipt but hidden/none never probe", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-c58-wiring-"));
  const env = { KADAN_HOME: home, KADAN_WINDOW: "rottie", KADAN_ROTTIE_BIN: path.join(home, "missing-rottie"), KADAN_ROTTIE_AUTO_ATTACH: "off" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const lines = [];
  t.mock.method(console, "log", line => lines.push(line));
  t.mock.method(floor, "alive", () => false);
  let creates = 0;
  t.mock.method(floor, "create", () => { creates++; return { panePid: "123" }; });
  const errors = [];
  t.mock.method(console, "error", line => errors.push(line));
  const previousExit = process.exit;
  const exits = [];
  process.exit = (code) => {
    const error = new Error("kadan-exit-" + code);
    error.exitCode = code;
    exits.push(code);
    throw error;
  };
  t.after(() => { process.exit = previousExit; });
  assert.throws(
    () => cli.main(["start", "c58-wire", "--cmd", "cat"]),
    (error) => error.exitCode === 2
  );
  assert.equal(creates, 0);
  assert.equal(cli.readLedger().filter(entry => entry?.kind === "start").length, 0);
  assert.equal(exits[0], 2);
  assert.match(errors.join("\n"), /파일 없음/);
  assert.match(errors.join("\n"), /KADAN_ROTTIE_BIN을 위 후보 중 하나로 바꾼다/);
  cli.main(["start", "c58-hidden", "--hidden", "--cmd", "cat"]);
  const hidden = cli.readLedger().at(-1);
  assert.equal(hidden.window, "hidden");
  assert.equal(Object.hasOwn(hidden, "rottieConnect"), false);
  process.env.KADAN_WINDOW = "none";
  cli.main(["start", "c58-none", "--cmd", "cat"]);
  const none = cli.readLedger().at(-1);
  assert.equal(none.window, "manual");
  assert.equal(Object.hasOwn(none, "rottieConnect"), false);
  assert.equal(creates, 2);
  assert.equal(lines.length, 2);
});
