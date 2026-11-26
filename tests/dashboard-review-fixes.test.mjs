// 독립검수(exec-61aef215) 중요 발견 1~3의 재현을 고정한다(4번은 tests/stop-conversation.test.mjs의 "겹친 꺼짐 기록").
// 세 시험 모두 두 커밋에 다 있는 면(현황 응답 JSON·buildMap·recipientGone·/ask·현황 수집기)으로만 묻는다 —
// 고치기 전 커밋(aea4927f)에서는 가져오기 오류가 아니라 단언 실패로 떨어진다.
import "./helpers/isolated-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CardStore } from "../src/card-store.mjs";
import { WorkStore } from "../src/work-store.mjs";
import { buildCardCenter } from "../src/card-center.mjs";
import { buildTree } from "../src/cli-tree.mjs";
import { appendLedger, readLedger } from "../src/ledger.mjs";
import { createDatabase, writeStorageMarker } from "../src/storage.mjs";
import { dashboardData } from "../src/dashboard-api.mjs";
import { createWallServer } from "../src/wall.mjs";

const at = (hoursAgo) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();

// 가짜 역할의 원장과 관계표를 격리 홈에 만든다. roles: {이름: {parent, profile, alive, stopped}}.
function fixture(roles) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-review-fixes-"));
  createDatabase(home);
  writeStorageMarker(home, "sqlite");
  const file = path.join(home, "hierarchy.json");
  const table = Object.fromEntries(Object.entries(roles).map(([role, r]) => [role, r.parent]));
  fs.writeFileSync(file, JSON.stringify(table));
  appendLedger({ kind: "hierarchy-loaded", path: file, by: "watch", t: at(100) }, home);
  const pid = (role) => String(500 + Object.keys(roles).indexOf(role));
  for (const [role, r] of Object.entries(roles)) {
    appendLedger({ kind: "start", role, session: `kadan-${role}`, panePid: pid(role), cmd: "claude --model sonnet", harness: "claude", model: "sonnet",
      roleProfile: r.profile, by: "사람", t: at(90) }, home);
    if (r.stopped) appendLedger({ kind: "stop", role, session: `kadan-${role}`, by: "사람", t: at(72) }, home);
  }
  const alive = Object.entries(roles).filter(([, r]) => r.alive).map(([role]) => role);
  const snapshot = () => {
    const entries = readLedger(home), cards = new CardStore(home);
    const live = Object.fromEntries(alive.map((role) => [`kadan-${role}`, { session: `kadan-${role}`, alive: true, pid: pid(role) }]));
    const tree = buildTree(entries, live, cards.listSummaries());
    return { home, collectedAt: new Date().toISOString(), centerError: null, entries, ledgerLines: entries.length,
      center: buildCardCenter({ cards: cards.list(), entries, tree, runtimeKnown: true }),
      registeredWorks: new WorkStore(home).list(), resources: null, resourceError: "격리 시험", tree, decisions: [] };
  };
  return { home, table, alive, snapshot, status: () => dashboardData(snapshot(), new URL("http://local/api/dashboard/status")) };
}

test("검수 1: 질문 칸은 서버(/ask)와 같은 받는 사람을 쓴다 — 살아 있는 중첩 슈퍼감독이면 막지 않고, 받는 사람이 없으면 화면도 막는다", async () => {
  const { recipientGone } = await import("../gui/src/strategy-map.ts");
  // start --profile super --parent <역할>로 만들 수 있는 관계: 최상위 아래의 슈퍼감독.
  const f = fixture({
    "rv-끈-최상위": { parent: "@user", profile: "super", stopped: true },
    "rv-살아-슈퍼": { parent: "rv-끈-최상위", profile: "super", alive: true },
    "rv-작업자-가": { parent: "rv-살아-슈퍼", profile: "worker", alive: true },
    "rv-살아-최상위": { parent: "@user", profile: "super", alive: true },
    "rv-없는-슈퍼": { parent: "rv-살아-최상위", profile: "super" },
    "rv-작업자-나": { parent: "rv-없는-슈퍼", profile: "worker", alive: true },
  });
  const data = f.status();
  // 화면이 하는 일: 현황 응답의 받는 사람과 같은 응답의 live로 막을지 정한다.
  const screen = (unit) => { const to = data.askTo?.[unit] ?? null; return { to, blocked: recipientGone(to, data.live) }; };
  // 서버가 실제로 하는 일: 같은 홈의 /ask. 생존은 같은 수집 결과로 답한다.
  const sent = [];
  const server = createWallServer(() => ({ center: null, entries: [], tree: [], ledgerLines: 0, collectedAt: new Date() }),
    { home: f.home, cacheSec: 0, hierarchy: () => f.table, ask: async (args) => { sent.push(args.to); return { to: args.to, mailId: "id" }; },
      sessionAlive: (role) => f.alive.includes(role) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = (await (await fetch(base)).text()).match(/name="token" value="([a-f0-9]+)"/)[1];
    const post = async (unit) => {
      const r = await fetch(base + "/ask", { method: "POST", redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", origin: base }, body: new URLSearchParams({ token, unit, text: "왜?" }) });
      return { status: r.status, body: await r.text() };
    };
    // (가) 꺼진 최상위 아래의 살아 있는 슈퍼감독이 받는 사람이다: 서버는 보내고, 화면도 막지 않는다.
    const a = await post("rv-작업자-가");
    assert.equal(a.status, 200, a.body);
    assert.deepEqual(sent, ["rv-살아-슈퍼"]);
    assert.deepEqual(screen("rv-작업자-가"), { to: "rv-살아-슈퍼", blocked: false }, "화면이 꺼진 최상위를 받는 사람으로 보고 막으면 안 된다");
    // (나) 살아 있는 최상위 아래의 슈퍼감독이 받는 사람인데 세션이 없다: 서버는 거절하고, 화면도 막는다.
    const b = await post("rv-작업자-나");
    assert.equal(b.status, 409);
    assert.equal(b.body, "꺼져 있음 — 받을 세션 없음: rv-없는-슈퍼");
    assert.deepEqual(sent, ["rv-살아-슈퍼"], "거절한 질문은 보내지 않는다");
    assert.deepEqual(screen("rv-작업자-나"), { to: "rv-없는-슈퍼", blocked: true }, "화면이 살아 있는 최상위를 받는 사람으로 보고 열어 두면 안 된다");
    // 지도에 오를 수 있는 이름은 모두 받는 사람이 실려 있다(화면이 다시 계산할 일이 없다).
    for (const role of Object.keys(f.table)) assert.equal(typeof data.askTo?.[role], "string", role);
    assert.equal(screen("rv-살아-슈퍼").to, "rv-살아-슈퍼", "슈퍼감독 자신은 자신에게");
  } finally { server.close(); }
});

test("검수 3: 열린 경보가 미리 보기 20건 밖이어도 그 경보를 가진 꺼진 최상위 역할은 지도에 남는다", async () => {
  const { buildMap, STATE_LABEL } = await import("../gui/src/strategy-map.ts");
  const f = fixture({
    "rv-경보만-든": { parent: "@user", profile: "super", stopped: true },
    "rv-끈-빈손": { parent: "@user", profile: "super", stopped: true },
    "rv-살아-최상위": { parent: "@user", profile: "super", alive: true },
  });
  // 열린 경보 21건: 가장 오래된 한 건만 꺼진 역할의 것이고, 나머지 20건(더 최근)은 살아 있는 역할의 것이다.
  const alert = (id, role, hoursAgo) => appendLedger({ kind: "alert", id, alertKind: "정체", level: "AMBER", role, session: `kadan-${role}`,
    recipient: "@user", by: "watch", t: at(hoursAgo) }, f.home);
  alert("old-1", "rv-경보만-든", 50);
  for (let i = 0; i < 20; i++) alert(`new-${i}`, "rv-살아-최상위", 10 - i * 0.1);
  const data = f.status();
  assert.equal(data.alerts.count, 21);
  assert.equal(data.alerts.items.length, 20, "미리 보기 20건 제한은 그대로다");
  assert.ok(!data.alerts.items.some((a) => a.role === "rv-경보만-든"), "그 역할의 경보는 미리 보기 밖이다");
  const units = new Map(buildMap({ hierarchy: data.hierarchy, rows: data.rows, live: data.live, alerts: data.alerts, stopped: data.stopped, held: data.held })
    .bases.flatMap((b) => b.units).map((u) => [u.role, STATE_LABEL[u.state]]));
  assert.equal(units.get("rv-경보만-든"), "꺼짐 · 인계 필요", "열린 경보는 든 일이다 — 미리 보기 밖이어도 지도에서 빠지지 않는다");
  assert.equal(units.has("rv-끈-빈손"), false, "경보도 든 일도 없는 꺼진 역할은 그대로 빠진다");
  assert.equal(data.held?.["rv-경보만-든"], "열린 경보");
  assert.ok(!("rv-끈-빈손" in data.held));
});

// 가짜 tmux: list-sessions만 결과를 바꾸고 나머지(has-session 등)는 성공한다.
function fakeTmux(dir, listScript) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "tmux"), `#!/bin/sh\ncase " $* " in\n  *" list-sessions "*) ${listScript} ;;\nesac\nexit 0\n`, { mode: 0o755 });
  return bin;
}
function collect(f, bin, askTo) {
  const child = new URL("./helpers/session-list-failure-child.mjs", import.meta.url).pathname;
  const r = spawnSync(process.execPath, [child, askTo], { encoding: "utf8",
    env: { ...process.env, KADAN_HOME: f.home, KADAN_FLOOR: "tmux", KADAN_WINDOW: "none", KADAN_NOTIFY: "off", KADAN_ROLE: "", PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
}

test("검수 2: 세션 목록 조회가 실패하면 모름이다 — 살아 있는 역할을 사라짐으로, 꺼진 역할을 숨김으로 꾸미지 않고 질문도 막지 않는다", () => {
  const f = fixture({
    "rv-살아-최상위": { parent: "@user", profile: "super", alive: true },
    "rv-끈-빈손": { parent: "@user", profile: "super", stopped: true },
  });
  // 세션은 살아 있는데(has-session 성공) list-sessions만 종료 42로 실패한다.
  const failed = collect(f, fakeTmux(fs.mkdtempSync(path.join(os.tmpdir(), "kadan-fake-tmux-")), 'echo "list failed" >&2; exit 42'), "rv-살아-최상위");
  assert.equal(failed.live, null, "조회 실패는 빈 목록이 아니라 모름이다");
  assert.equal(failed.stopped, null);
  assert.match(failed.error, /생존 못 읽음/);
  assert.deepEqual(failed.units, { "rv-살아-최상위": "세션 모름", "rv-끈-빈손": "세션 모름" }, "아무도 숨기지 않고, 사라짐으로 꾸미지 않는다");
  assert.equal(failed.askBlocked, false, "모를 때는 질문을 막지 않는다");
  // 대조: tmux 서버가 아예 없으면 세션이 없다고 확인된 것이다(빈 홈·처음 켠 기계) — 모름이 아니라 빈 목록이고 오류도 아니다.
  const none = collect(f, fakeTmux(fs.mkdtempSync(path.join(os.tmpdir(), "kadan-fake-tmux-")), 'echo "no server running on /tmp/fake/kadan" >&2; exit 1'), "rv-살아-최상위");
  assert.deepEqual([none.live, none.error], [[], null]);
  assert.deepEqual(none.stopped, ["rv-끈-빈손"]);
  assert.deepEqual(none.units, { "rv-살아-최상위": "세션 사라짐" }, "세션이 없다고 확인되면 꺼진 빈손 역할은 빠지고 stop 기록 없는 역할은 사라짐이다");
});
