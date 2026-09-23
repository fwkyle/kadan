import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as cli from "../src/cli.mjs";
import { floor } from "../src/floor.mjs";

function withExitTrap(t) {
  const previous = process.exit;
  const exits = [];
  process.exit = (code) => {
    const error = new Error("kadan-exit-" + code);
    error.exitCode = code;
    exits.push(code);
    throw error;
  };
  t.after(() => {
    process.exit = previous;
  });
  return exits;
}

test("창이 실패해도 세션은 만들어져 manual로 조용히 떨어지던 것 — 2026-09-06 실측", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-c69-missing-"));
  const missing = path.join(home, "missing-rottie");
  const previous = {
    KADAN_HOME: process.env.KADAN_HOME,
    KADAN_WINDOW: process.env.KADAN_WINDOW,
    KADAN_ROTTIE_BIN: process.env.KADAN_ROTTIE_BIN,
    KADAN_ROTTIE_AUTO_ATTACH: process.env.KADAN_ROTTIE_AUTO_ATTACH,
  };
  process.env.KADAN_HOME = home;
  process.env.KADAN_WINDOW = "rottie";
  process.env.KADAN_ROTTIE_BIN = missing;
  // 이 컴퓨터에 켜진 진짜 로티에 자동으로 붙어 탭을 열지 않게 끈다.
  process.env.KADAN_ROTTIE_AUTO_ATTACH = "off";
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  t.mock.method(floor, "alive", () => false);
  let creates = 0;
  t.mock.method(floor, "create", () => {
    creates += 1;
    return { panePid: "123" };
  });
  const errors = [];
  t.mock.method(console, "error", (line) => errors.push(line));
  const exits = withExitTrap(t);
  assert.throws(
    () => cli.main(["start", "c69-missing", "--cmd", "cat"]),
    (error) => error.exitCode === 2
  );
  assert.equal(creates, 0);
  assert.equal(cli.readLedger().filter((entry) => entry?.kind === "start").length, 0);
  assert.equal(exits[0], 2);
  const text = errors.join("\n");
  assert.match(text, /파일 없음/);
  assert.match(text, /지금 켜진 로티 실행 파일 후보/);
  assert.match(text, /KADAN_ROTTIE_BIN을 위 후보 중 하나로 바꾼다/);
});

test("연결이 안 되면 세션을 만들지 않고 후보만 보여 준다", () => {
  const inspected = cli.inspectRottieStartPreflight({
    env: { KADAN_WINDOW: "rottie", KADAN_ROTTIE_BIN: "/exists/rottie" },
    floorName: "tmux",
    existsFn: () => true,
    connectFn: ({ bin }) => {
      assert.equal(bin, "/exists/rottie");
      return {
        ok: false,
        code: "ROTTIE_APP_NOT_RUNNING",
        bundleId: "com.example.rottie.dev",
        build: "test-build",
      };
    },
    listBinsFn: () => ["/home/tester/Rottie/src-tauri/target/debug/rottie", "/home/tester/Rottie-2/rottie"],
  });
  assert.equal(inspected.ok, false);
  assert.equal(inspected.reason, "connect");
  assert.match(inspected.message, /연결 실패/);
  assert.match(inspected.message, /ROTTIE_APP_NOT_RUNNING/);
  assert.match(inspected.message, /target\/debug\/rottie/);
  assert.match(inspected.message, /정확히 하나이고 연결될 때만 자동으로 붙는다/);
});

test("설정 경로가 없거나 끊겨도 켜진 로티가 하나이고 연결되면 그쪽에 붙는다(2026-09-23)", () => {
  const live = "/opt/Rottie/Rottie Local.app/Contents/MacOS/rottie";
  for (const [reason, exists, connect] of [["missing", false, () => ({ ok: true, build: "live" })],
    ["connect", true, ({ bin }) => (bin === live ? { ok: true, build: "live" } : { ok: false, code: "ROTTIE_APP_NOT_RUNNING" })]]) {
    const env = { KADAN_WINDOW: "rottie", KADAN_ROTTIE_BIN: "/gone/rottie" };
    const inspected = cli.inspectRottieStartPreflight({ env, floorName: "tmux", existsFn: () => exists, connectFn: connect, listBinsFn: () => [live] });
    assert.equal(inspected.ok, true, reason);
    assert.deepEqual(inspected.switched, { from: "/gone/rottie", to: live, reason });
    assert.equal(env.KADAN_ROTTIE_BIN, live);
  }
});

test("자동으로 붙지 않는 경우: 후보 여러 개·후보 연결 실패·끔 설정", () => {
  const base = { floorName: "tmux", existsFn: () => false };
  const cases = [
    [{ KADAN_WINDOW: "rottie", KADAN_ROTTIE_BIN: "/gone/rottie" }, () => ["/a/rottie", "/b/rottie"], () => ({ ok: true })],
    [{ KADAN_WINDOW: "rottie", KADAN_ROTTIE_BIN: "/gone/rottie" }, () => ["/a/rottie"], () => ({ ok: false, code: "X" })],
    [{ KADAN_WINDOW: "rottie", KADAN_ROTTIE_BIN: "/gone/rottie", KADAN_ROTTIE_AUTO_ATTACH: "off" }, () => ["/a/rottie"], () => ({ ok: true })],
  ];
  for (const [env, listBinsFn, connectFn] of cases) {
    const inspected = cli.inspectRottieStartPreflight({ ...base, env, listBinsFn, connectFn });
    assert.equal(inspected.ok, false);
    assert.equal(env.KADAN_ROTTIE_BIN, "/gone/rottie");
  }
});

test("hidden·none·tmux 전용 경로는 점검을 타지 않는다", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-c69-skip-"));
  const previous = {
    KADAN_HOME: process.env.KADAN_HOME,
    KADAN_WINDOW: process.env.KADAN_WINDOW,
    KADAN_ROTTIE_BIN: process.env.KADAN_ROTTIE_BIN,
  };
  process.env.KADAN_HOME = home;
  process.env.KADAN_ROTTIE_BIN = path.join(home, "missing-rottie");
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  t.mock.method(floor, "alive", () => false);
  let creates = 0;
  t.mock.method(floor, "create", () => {
    creates += 1;
    return { panePid: String(100 + creates) };
  });
  t.mock.method(console, "log", () => {});
  process.env.KADAN_WINDOW = "rottie";
  cli.main(["start", "c69-hidden", "--hidden", "--cmd", "cat"]);
  process.env.KADAN_WINDOW = "none";
  cli.main(["start", "c69-none", "--cmd", "cat"]);
  const rows = cli.readLedger();
  assert.equal(creates, 2);
  assert.equal(rows[0].window, "hidden");
  assert.equal(rows[1].window, "manual");
  assert.equal(
    cli.inspectRottieStartPreflight({
      env: { KADAN_WINDOW: "none", KADAN_ROTTIE_BIN: process.env.KADAN_ROTTIE_BIN },
      floorName: "tmux",
    }).skipped,
    true
  );
});

test("올바른 경로와 연결이면 점검을 통과하고 창 열기는 그대로 둔다", () => {
  const inspected = cli.inspectRottieStartPreflight({
    env: { KADAN_WINDOW: "rottie", KADAN_ROTTIE_BIN: "/exists/rottie" },
    floorName: "tmux",
    existsFn: () => true,
    connectFn: () => ({
      ok: true,
      bundleId: "com.example.rottie.dev",
      build: "ok-build",
    }),
    listBinsFn: () => ["/exists/rottie"],
  });
  assert.equal(inspected.ok, true);
  assert.equal(inspected.connection.ok, true);
  const opened = cli.openStartedWindow("kadan-c69-ok", "darwin", {
    choice: { kind: "rottie" },
    rottieBin: "/exists/rottie",
    spawnFn: (bin, argv) => {
      assert.equal(bin, "/exists/rottie");
      if (argv[0] === "status") {
        return {
          status: 0,
          stdout: JSON.stringify({
            ok: true,
            runtime: { bundleId: "com.example.rottie.dev", build: "ok-build" },
          }),
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({ ok: true, result: { terminal: { id: "owned-tab" } } }),
      };
    },
    waitForClient: () => true,
  });
  assert.equal(opened.method, "rottie");
  const entry = cli.buildStartLedgerEntry({
    floorName: "tmux",
    role: "c69-ok",
    session: "kadan-c69-ok",
    evidence: { panePid: "123" },
    window: opened.method,
  });
  assert.equal(entry.window, "rottie");
});

test("ps 후보는 로티 실행 파일 경로만 모으고 데몬은 빼 준다", () => {
  const bins = cli.listRunningRottieBins({
    spawnFn: () => ({
      status: 0,
      stdout: [
        "/home/tester/Rottie/src-tauri/target/debug/rottie --flag",
        "/home/tester/Library/Application Support/com.example.rottie.dev/terminal-daemons/v1/daemon --serve",
        "target/debug/rottie",
        "/home/tester/Rottie/src-tauri/target/debug/rottie",
        "/home/tester/Rottie-other/src-tauri/target/release/bundle/macos/Rottie Local.app/Contents/MacOS/rottie --native-recovery-wait-for-pid=15754",
      ].join("\n"),
    }),
  });
  assert.deepEqual(bins, [
    "/home/tester/Rottie/src-tauri/target/debug/rottie",
    "/home/tester/Rottie-other/src-tauri/target/release/bundle/macos/Rottie Local.app/Contents/MacOS/rottie",
  ]);
});

test("자식 프로세스로 없는 경로 start는 세션 0개·원장 start 0줄이다", (t) => {
  if (spawnSync("tmux", ["-V"]).status !== 0) return t.skip("tmux 없음");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-c69-child-"));
  const socket = "kadan-c69-" + process.pid;
  const cliPath = path.resolve("src/cli.mjs");
  const missing = path.join(home, "does-not-exist");
  const started = spawnSync(process.execPath, [cliPath, "start", "c69-child", "--cmd", "cat"], {
    encoding: "utf8",
    env: {
      ...process.env,
      KADAN_HOME: home,
      KADAN_SOCKET: socket,
      KADAN_WINDOW: "rottie",
      KADAN_ROTTIE_BIN: missing,
      // 이 컴퓨터에 켜진 진짜 로티에 자동으로 붙어 탭을 열지 않게 끈다.
      KADAN_ROTTIE_AUTO_ATTACH: "off",
      KADAN_FLOOR: "tmux",
    },
  });
  t.after(() => {
    spawnSync("tmux", ["-L", socket, "kill-server"]);
  });
  assert.equal(started.status, 2);
  assert.match(started.stderr, /파일 없음/);
  const listed = spawnSync("tmux", ["-L", socket, "list-sessions"], { encoding: "utf8" });
  assert.notEqual(listed.status, 0);
  const ledgerFile = path.join(home, "ledger.jsonl");
  const ledger = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, "utf8") : "";
  assert.equal(ledger, "");
});
