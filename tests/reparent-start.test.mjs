// 같은 이름을 새 대화가 다시 쓰는 start는 옛 상위 줄을 물려받지 않는다(A2, 2026-10-14).
// 실제 CLI를 격리 홈·격리 tmux 소켓에서 돌린다. 운영 카단(~/.kadan, 소켓 kadan)은 건드리지 않는다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { reparentStartedRole } from "../src/hierarchy-register.mjs";
import { appendLedger } from "../src/ledger.mjs";

const tmuxOk = spawnSync("tmux", ["-V"]).status === 0;
const cli = new URL("../src/cli.mjs", import.meta.url).pathname;

function makeHome(table) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-reparent-"));
  const file = path.join(home, "hierarchy.json");
  fs.writeFileSync(file, JSON.stringify(table, null, 2));
  return { home, file, entries: [{ kind: "hierarchy-loaded", path: file }] };
}
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));

test("상위 줄만 바꾸고 하위 줄은 건드리지 않는다. 개수와 살아 있는 수를 돌려준다", () => {
  const { home, file, entries } = makeHome({ P1: "@user", P2: "@user", X: "P1", Y: "X", Z: "X" });
  const moved = reparentStartedRole({ role: "X", parent: "P2", home, entries, isAlive: child => child === "Y" });
  assert.deepEqual([moved.changed, moved.from, moved.to, moved.children, moved.aliveChildren], [true, "P1", "P2", 2, 1]);
  assert.deepEqual(read(file), { P1: "@user", P2: "@user", X: "P2", Y: "X", Z: "X" });
});

test("같은 상위·만든 쪽 모름·표에 없는 이름·표에 없는 상위·순환은 표를 바꾸지 않는다", () => {
  const table = { P1: "@user", X: "P1", Y: "X" };
  const { home, file, entries } = makeHome(table);
  const before = fs.readFileSync(file, "utf8");
  assert.equal(reparentStartedRole({ role: "X", parent: "P1", home, entries }).same, true);
  assert.equal(reparentStartedRole({ role: "X", parent: null, home, entries }).reason, "만든 쪽을 모름");
  assert.equal(reparentStartedRole({ role: "없는이름", parent: "P1", home, entries }).reason, "관계표에 없음");
  assert.match(reparentStartedRole({ role: "X", parent: "없는상위", home, entries }).reason, /관계표에 없음/);
  assert.match(reparentStartedRole({ role: "X", parent: "Y", home, entries }).reason, /관계가 깨짐/, "하위를 상위로 두면 순환");
  assert.equal(reparentStartedRole({ role: "X", parent: "X", home, entries }).changed, false);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  fs.writeFileSync(file, "{ 깨짐");
  assert.match(reparentStartedRole({ role: "X", parent: "P1", home, entries }).reason, /읽지 못함/);
});

test("실제 start/stop: 새 세대 start가 X의 상위 줄만 바꾼다. resume·이어감·같은 상위는 표 변화도 안내도 없다", { skip: !tmuxOk && "tmux 없음" }, () => {
  const { home, file } = makeHome({ P1: "@user", P2: "@user", X: "P1", Y: "X" });
  const socket = `kadan-reparent-${process.pid}`;
  // 실행기 대신 아무 일도 안 하는 가짜 claude를 PATH 앞에 둔다(명령 문자열은 claude 형식이어야 대화 방식을 읽는다).
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-fake-claude-"));
  fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nexec sleep 600\n", { mode: 0o755 });
  const env = role => ({
    ...process.env, PATH: `${bin}:${process.env.PATH}`, KADAN_HOME: home, KADAN_SOCKET: socket, KADAN_WINDOW: "none", KADAN_NOTIFY: "off",
    KADAN_FLOOR: "tmux", KADAN_ROLE: role,
  });
  const run = (role, args) => spawnSync(process.execPath, [cli, ...args], { env: env(role), encoding: "utf8", cwd:os.tmpdir() });
  appendLedger({ kind: "hierarchy-loaded", path: file, by: "watch", t: new Date().toISOString() }, home);
  try {
    const cmd = "claude --model sonnet";
    const first = run("P1", ["start", "X", "--hidden", "--cmd", cmd]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(run("P1", ["stop", "X"]).status, 0);
    // P2가 X를 새 대화로 다시 쓴다.
    const second = run("P2", ["start", "X", "--hidden", "--cmd", cmd]);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, /관계표 상위 변경: X: P1 → P2/);
    assert.match(second.stderr, /옛 하위 1개\(살아 있는 것 0개\)/);
    assert.deepEqual(read(file), { P1: "@user", P2: "@user", X: "P2", Y: "X" });
    assert.equal(run("P2", ["stop", "X"]).status, 0);
    // 같은 상위가 다시 쓰면 표 변화도 안내도 없다.
    const same = run("P2", ["start", "X", "--hidden", "--cmd", cmd]);
    assert.equal(same.status, 0, same.stderr);
    assert.doesNotMatch(same.stderr, /관계표 상위|옛 하위/);
    assert.equal(run("P2", ["stop", "X"]).status, 0);
    // 같은 대화를 resume으로 열면 다른 쪽이 만들어도 상위를 바꾸지 않는다.
    const resumed = run("P1", ["start", "X", "--hidden", "--cmd", "claude --resume abc"]);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.doesNotMatch(resumed.stderr, /관계표 상위/);
    assert.equal(run("P1", ["stop", "X"]).status, 0);
    const inherited = run("P1", ["start", "X", "--hidden", "--cmd", cmd, "--inherit-mail"]);
    assert.equal(inherited.status, 0, inherited.stderr);
    assert.doesNotMatch(inherited.stderr, /관계표 상위/);
    assert.equal(read(file).X, "P2", "이어감은 표를 바꾸지 않는다");
    assert.equal(run("P1", ["stop", "X"]).status, 0);
    // 슈퍼감독 프로필은 --parent가 없으면 @user가 상위다. --parent X면 X.
    const sup = run("P1", ["start", "S", "--hidden", "--profile", "super", "--cmd", cmd]);
    assert.equal(sup.status, 0, sup.stderr);
    assert.equal(read(file).S, "@user");
    assert.equal(run("P1", ["stop", "S"]).status, 0);
    const under = run("P1", ["start", "S2", "--hidden", "--profile", "super", "--parent", "P1", "--cmd", cmd]);
    assert.equal(under.status, 0, under.stderr);
    assert.equal(read(file).S2, "P1");
    assert.equal(run("P1", ["stop", "S2"]).status, 0);
  } finally {
    spawnSync("tmux", ["-L", socket, "kill-server"]);
  }
});
