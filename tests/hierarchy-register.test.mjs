import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { activeHierarchyPath, isKadanToolCommand, registerRoleManually, registerStartedRole } from "../src/hierarchy-register.mjs";

function makeHome(table) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-register-"));
  const hierarchyPath = path.join(home, "관계표.json");
  fs.writeFileSync(hierarchyPath, JSON.stringify(table, null, 2));
  const entries = [{ kind: "hierarchy-loaded", path: hierarchyPath }];
  return { home, hierarchyPath, entries };
}

const 기본표 = { "판-슈퍼감독": "@user", "판-감독": "판-슈퍼감독" };

test("만든 감독을 상위로 적고 기존 줄은 그대로 둔다", () => {
  const { home, hierarchyPath, entries } = makeHome(기본표);
  const result = registerStartedRole({ role: "판-사진-작업자", creator: "판-감독", home, entries });
  assert.equal(result.registered, true);
  assert.equal(result.parent, "판-감독");
  const saved = JSON.parse(fs.readFileSync(hierarchyPath, "utf8"));
  assert.deepEqual(saved, { ...기본표, "판-사진-작업자": "판-감독" });
});

test("이미 있는 역할의 상위는 덮어쓰지 않는다", () => {
  const { home, hierarchyPath, entries } = makeHome({ ...기본표, "판-작업자": "판-슈퍼감독" });
  const result = registerStartedRole({ role: "판-작업자", creator: "판-감독", home, entries });
  assert.equal(result.registered, false);
  assert.equal(result.reason, "이미 등록됨");
  assert.equal(JSON.parse(fs.readFileSync(hierarchyPath, "utf8"))["판-작업자"], "판-슈퍼감독");
});

test("사람이 직접 띄우면 적지 않는다", () => {
  const { home, hierarchyPath, entries } = makeHome(기본표);
  for (const creator of ["사람", "watch", null]) {
    assert.equal(registerStartedRole({ role: "판-작업자", creator, home, entries }).registered, false);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(hierarchyPath, "utf8")), 기본표);
});

test("상위가 관계표에 없으면 끊긴 줄을 만들지 않는다", () => {
  const { home, hierarchyPath, entries } = makeHome(기본표);
  const result = registerStartedRole({ role: "판-작업자", creator: "모르는-감독", home, entries });
  assert.equal(result.registered, false);
  assert.match(result.reason, /관계표에 없음/);
  assert.deepEqual(JSON.parse(fs.readFileSync(hierarchyPath, "utf8")), 기본표);
});

test("감시기 관계표를 모르거나 파일이 깨졌으면 건너뛴다", () => {
  const { home } = makeHome(기본표);
  assert.equal(registerStartedRole({ role: "판-작업자", creator: "판-감독", home, entries: [] }).registered, false);
  const broken = path.join(home, "깨진.json");
  fs.writeFileSync(broken, "{");
  const result = registerStartedRole({
    role: "판-작업자",
    creator: "판-감독",
    home,
    entries: [{ kind: "hierarchy-loaded", path: broken }],
  });
  assert.equal(result.registered, false);
  assert.match(result.reason, /읽지 못함/);
});

test("다른 등록이 진행 중이면 건드리지 않는다", () => {
  const { home, hierarchyPath, entries } = makeHome(기본표);
  const lockPath = path.join(home, "hierarchy-register.lock");
  fs.writeFileSync(lockPath, "");
  const result = registerStartedRole({ role: "판-작업자", creator: "판-감독", home, entries, lockWaitMs: 200 });
  assert.equal(result.registered, false);
  assert.equal(result.reason, "다른 등록이 진행 중");
  assert.deepEqual(JSON.parse(fs.readFileSync(hierarchyPath, "utf8")), 기본표);
  fs.unlinkSync(lockPath);
  assert.equal(registerStartedRole({ role: "판-작업자", creator: "판-감독", home, entries }).registered, true);
});

test("동시 시작으로 잠금이 짧게 겹치면 기다렸다가 등록한다", async () => {
  const { home, hierarchyPath, entries } = makeHome(기본표);
  const lockPath = path.join(home, "hierarchy-register.lock");
  fs.writeFileSync(lockPath, "");
  // 300ms 뒤 잠금을 푸는 별도 프로세스 — 등록은 그동안 잠금을 다시 시도한다.
  const releaser = spawn(process.execPath, [
    "-e",
    `setTimeout(() => { try { require("node:fs").unlinkSync(${JSON.stringify(lockPath)}); } catch {} }, 300)`,
  ]);
  const startedAt = Date.now();
  const result = registerStartedRole({ role: "판-작업자", creator: "판-감독", home, entries, lockWaitMs: 2000 });
  await new Promise((resolve) => releaser.once("exit", resolve));
  assert.equal(result.registered, true);
  assert.equal(result.parent, "판-감독");
  assert.ok(Date.now() - startedAt >= 250, "잠금이 풀릴 때까지 기다렸어야 한다");
  assert.equal(JSON.parse(fs.readFileSync(hierarchyPath, "utf8"))["판-작업자"], "판-감독");
});

test("사람이 직접 띄운 역할을 수동으로 등록한다", () => {
  const { home, hierarchyPath, entries } = makeHome(기본표);
  const top = registerRoleManually({ role: "비서", parent: "@user", home, entries });
  assert.equal(top.registered, true);
  assert.equal(top.parent, "@user");
  const under = registerRoleManually({ role: "판-임시작업자", parent: "판-감독", home, entries });
  assert.equal(under.registered, true);
  const saved = JSON.parse(fs.readFileSync(hierarchyPath, "utf8"));
  assert.equal(saved["비서"], "@user");
  assert.equal(saved["판-임시작업자"], "판-감독");
  // 같은 줄을 다시 넣거나 기존 줄을 고치지는 않는다.
  assert.equal(registerRoleManually({ role: "비서", parent: "판-감독", home, entries }).registered, false);
  assert.equal(JSON.parse(fs.readFileSync(hierarchyPath, "utf8"))["비서"], "@user");
  // 표에 없는 상위나 잘못된 이름은 거부한다.
  assert.equal(registerRoleManually({ role: "판-작업자", parent: "모르는-감독", home, entries }).registered, false);
  for (const [role, parent] of [["띄 어", "판-감독"], ["@user", "판-감독"], ["", "판-감독"], ["판-작업자", ""]]) {
    assert.equal(registerRoleManually({ role, parent, home, entries }).registered, false, JSON.stringify([role, parent]));
  }
  assert.equal(JSON.parse(fs.readFileSync(hierarchyPath, "utf8"))["판-작업자"], undefined);
});

test("마지막으로 읽힌 관계표를 현재 경로로 본다", () => {
  assert.equal(activeHierarchyPath([]), null);
  assert.equal(
    activeHierarchyPath([
      { kind: "hierarchy-loaded", path: "/옛/표.json" },
      { kind: "start", role: "판-작업자" },
      { kind: "hierarchy-loaded", path: "/새/표.json" },
    ]),
    "/새/표.json"
  );
});

test("카단 감시기·대시보드 세션은 관계표에 넣지 않는다(2026-09-23 실제 명령)", () => {
  for (const cmd of [
    "env -u KADAN_ROLE /opt/node/bin/kadan watch --profile /opt/kadan/watch-profile.json",
    "/usr/local/bin/node /opt/kadan/src/cli.mjs dashboard --port 8790",
    "kadan wall --port 8800",
    "KADAN_HOME=/tmp/x kadan watch",
  ]) {
    assert.equal(isKadanToolCommand(cmd), true, cmd);
    const { home, hierarchyPath, entries } = makeHome(기본표);
    const result = registerStartedRole({ role: "watch", creator: "판-감독", cmd, home, entries });
    assert.equal(result.registered, false, cmd);
    assert.equal(result.reason, "카단 운영 도구 세션");
    assert.deepEqual(JSON.parse(fs.readFileSync(hierarchyPath, "utf8")), 기본표);
  }
  for (const cmd of ["codex -p lite --model gpt-6-sol", "claude --model claude-opus-5-5", "kadan send 판-감독 hi", "node /x/other.mjs watch", undefined, "echo watch; kadan watch"]) {
    assert.equal(isKadanToolCommand(cmd), false, String(cmd));
  }
  const { home, entries } = makeHome(기본표);
  assert.equal(registerStartedRole({ role: "판-작업자", creator: "판-감독", cmd: "codex --model x", home, entries }).registered, true);
});
