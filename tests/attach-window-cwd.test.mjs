import test from "node:test";
import assert from "node:assert/strict";
import { attachWindowCwd } from "../src/commands/inspect.mjs";

test("attach 창은 역할의 시작 폴더로 연다", () => {
  assert.equal(attachWindowCwd({ cwd: "/work/kadan-worktrees/kyle/fix/x" }, "/caller"), "/work/kadan-worktrees/kyle/fix/x");
});

test("시작 기록이 없거나 폴더가 절대경로가 아니면 붙이는 쪽 폴더를 쓴다", () => {
  assert.equal(attachWindowCwd(null, "/caller"), "/caller");
  assert.equal(attachWindowCwd({ cwd: "relative/dir" }, "/caller"), "/caller");
  assert.equal(attachWindowCwd({}, "/caller"), "/caller");
});

import { openWindow } from "../src/floor-tmux.mjs";

const conflict = { status: 1, stdout: JSON.stringify({ ok: false, error: { code: "ROTTIE_IDEMPOTENCY_CONFLICT" } }) };
const created = { status: 0, stdout: JSON.stringify({ ok: true, result: { terminal: { id: "t-new", pid: 1 } } }) };
const keyOf = (argv) => argv[argv.indexOf("--idempotency-key") + 1];

test("로티 키 충돌이면 접미사 키로 한 번만 다시 연다", () => {
  const calls = [];
  const opened = openWindow("kadan-역할", "darwin", {
    choice: { kind: "rottie" }, role: "역할", cwd: "/work/repo", panePid: "42", rottieBin: "/bin/rottie",
    conflictKeySuffix: "attach-abc", waitForClient: () => true,
    spawnFn: (bin, argv) => { calls.push(argv); return calls.length === 1 ? conflict : created; },
  });
  assert.equal(opened.method, "rottie");
  assert.deepEqual(calls.map(keyOf), ["kadan-kadan-역할-42", "kadan-kadan-역할-42-attach-abc"]);
  assert.equal(calls[1][calls[1].indexOf("--workspace") + 1], "/work/repo");
});

test("접미사가 없으면 키 충돌을 그대로 실패로 둔다", () => {
  const calls = [];
  const opened = openWindow("kadan-역할", "darwin", {
    choice: { kind: "rottie" }, role: "역할", cwd: "/work/repo", panePid: "42", rottieBin: "/bin/rottie",
    waitForClient: () => true, spawnFn: (bin, argv) => { calls.push(argv); return conflict; },
  });
  assert.equal(opened, null);
  assert.equal(calls.length, 1);
});
