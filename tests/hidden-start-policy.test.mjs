import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("KADAN_WINDOW=rottie + 역할 프로필 + --hidden은 거부된다", () => {
  const denied = cli.inspectHiddenStartPolicy({
    env: { KADAN_WINDOW: "rottie" },
    floorName: "tmux",
    hidden: true,
    roleProfile: "worker",
    reusing: false,
  });
  assert.equal(denied.ok, false);
  assert.match(denied.message, /KADAN_HIDDEN_FORBIDDEN/);
  assert.match(denied.message, /worker/);
});

test("프로필 없음·none·비hidden·재사용·rottie 바닥은 허용한다", () => {
  const base = {
    env: { KADAN_WINDOW: "rottie" },
    floorName: "tmux",
    hidden: true,
    roleProfile: "worker",
    reusing: false,
  };
  assert.equal(cli.inspectHiddenStartPolicy({ ...base, roleProfile: undefined }).ok, true);
  assert.equal(cli.inspectHiddenStartPolicy({ ...base, env: { KADAN_WINDOW: "none" } }).ok, true);
  assert.equal(cli.inspectHiddenStartPolicy({ ...base, hidden: false }).ok, true);
  assert.equal(cli.inspectHiddenStartPolicy({ ...base, reusing: true }).ok, true);
  assert.equal(cli.inspectHiddenStartPolicy({ ...base, floorName: "rottie" }).ok, true);
});

test("KADAN_WINDOW=rottie에서 프로필 세션의 --hidden은 세션을 만들기 전에 죽는다", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-hidden-policy-"));
  const previous = {
    KADAN_HOME: process.env.KADAN_HOME,
    KADAN_WINDOW: process.env.KADAN_WINDOW,
    KADAN_ROTTIE_BIN: process.env.KADAN_ROTTIE_BIN,
  };
  process.env.KADAN_HOME = home;
  process.env.KADAN_WINDOW = "rottie";
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
    return { panePid: "123" };
  });
  const errors = [];
  t.mock.method(console, "error", (line) => errors.push(line));
  const exits = withExitTrap(t);
  assert.throws(
    () => cli.main(["start", "hp-worker", "--hidden", "--profile", "worker", "--cmd", "cat"]),
    (error) => error.exitCode === 2
  );
  assert.equal(creates, 0);
  assert.equal(cli.readLedger().filter((entry) => entry?.kind === "start").length, 0);
  assert.equal(exits[0], 2);
  assert.match(errors.join("\n"), /KADAN_HIDDEN_FORBIDDEN/);
});

test("프로필 없는 세션은 같은 환경에서도 --hidden이 허용된다", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-hidden-policy-allow-"));
  const previous = {
    KADAN_HOME: process.env.KADAN_HOME,
    KADAN_WINDOW: process.env.KADAN_WINDOW,
    KADAN_ROTTIE_BIN: process.env.KADAN_ROTTIE_BIN,
  };
  process.env.KADAN_HOME = home;
  process.env.KADAN_WINDOW = "rottie";
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
    return { panePid: "321" };
  });
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  cli.main(["start", "hp-dash", "--hidden", "--cmd", "cat"]);
  assert.equal(creates, 1);
  const rows = cli.readLedger().filter((entry) => entry?.kind === "start");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].window, "hidden");
});
