// 꺼진 역할 가르기(2026-11-26 [kyle]): 원장 → 현황 응답(stopped·held) → 전략 맵 표시를 가짜 역할로 끝까지 잇는다.
// 화면 쪽 표(gui/tests/strategy-map.test.ts)는 서버가 준 값을 그대로 쓴다. 여기서는 그 값이 원장에서 맞게 나오는지와,
// 지도에서 빠진 최상위 역할을 관계표 정리가 "든 일"로 붙잡지 않는지(같은 함수)를 같은 원장으로 확인한다.
import "./helpers/isolated-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CardStore } from "../src/card-store.mjs";
import { WorkStore } from "../src/work-store.mjs";
import { buildCardCenter } from "../src/card-center.mjs";
import { buildTree } from "../src/cli-tree.mjs";
import { appendLedger, readLedger } from "../src/ledger.mjs";
import { createDatabase, writeStorageMarker } from "../src/storage.mjs";
import { dashboardData } from "../src/dashboard-api.mjs";
import { stoppedRoles } from "../src/dashboard/status.mjs";
import { planHierarchyPrune, PRUNE_GRACE_MS } from "../src/hierarchy-prune.mjs";
import { intendedStop } from "../src/lifecycle-tail.mjs";

const now = Date.now();
const at = (hoursAgo) => new Date(now - hoursAgo * 3_600_000).toISOString();
const table = {
  "꺼짐-빈손": "@user", "꺼짐-업무": "@user", "꺼짐-차례": "@user", "꺼짐-발령": "@user", "꺼짐-옛발령": "@user",
  "꺼짐-하위": "@user", "꺼짐-하위-작업자": "꺼짐-하위", "꺼짐-우편": "@user",
  "사라짐": "@user", "재시작중": "@user", "살아있음": "@user",
};
const ALIVE = ["살아있음", "꺼짐-하위-작업자"];
const pidOf = (role) => String(100 + Object.keys(table).indexOf(role));

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-stopped-roles-"));
  createDatabase(home);
  writeStorageMarker(home, "sqlite");
  const file = path.join(home, "hierarchy.json");
  fs.writeFileSync(file, JSON.stringify(table));
  const cards = new CardStore(home), works = new WorkStore(home);
  const put = (entry) => appendLedger(entry, home);
  put({ kind: "hierarchy-loaded", path: file, by: "watch", t: at(100) });
  for (const role of Object.keys(table)) {
    put({ kind: "start", role, session: `kadan-${role}`, panePid: pidOf(role), cmd: "claude --model sonnet", harness: "claude", model: "sonnet", by: "사람", t: at(90) });
  }
  // 정상 종료(restart 아님): 유예 24시간을 넘긴 옛 종료.
  for (const role of ["꺼짐-빈손", "꺼짐-업무", "꺼짐-차례", "꺼짐-발령", "꺼짐-옛발령", "꺼짐-하위", "꺼짐-우편"]) {
    put({ kind: "stop", role, session: `kadan-${role}`, by: "사람", t: at(72) });
  }
  // 재시작 도중 사라짐: 마지막 수명 사건이 restart stop이다.
  put({ kind: "stop", role: "재시작중", session: "kadan-재시작중", restart: true, by: "사람", t: at(72) });
  // 꺼진 뒤 사람이 보낸 보관 우편(2026-11-26 실측과 같은 꼴). 든 일도 활동도 아니다.
  put({ kind: "send", role: "꺼짐-우편", by: "사람", transport: "mailbox", mailId: "m-1", preview: "왜 꺼졌어?", t: at(2) });
  // 열린 업무의 책임 감독 / 다음 담당(turnOwner).
  const owned = works.create({ key: "demo/owned", title: "책임 업무", goal: "g", scope: "s", acceptance: "a", owner: "꺼짐-업무", repoPath: home, board: "판" });
  const turn = works.create({ key: "demo/turn", title: "차례 업무", goal: "g", scope: "s", acceptance: "a", owner: "살아있음", repoPath: home, board: "판" });
  works.change(turn.key, "update", { turnOwner: "꺼짐-차례" }, { revision: turn.revision, by: "사람", note: "차례 지정" });
  // 미완료 발령: 카드는 발령됐고 done이 없다.
  const card = cards.create({ repo: "demo", id: "task-1", repoPath: home, title: "발령 카드", body: "# 발령", by: "사람" });
  cards.update(card.key, { status: "assigned", role: "꺼짐-발령", board: "판", scope: "격리 시험", rallyId: "r-1", rallyTitle: "묶음", rallyRound: "1", rallyStep: "implementation" }, { revision: card.revision, by: "사람", note: "발령" });
  put({ kind: "send", role: "꺼짐-발령", session: "kadan-꺼짐-발령", taskId: "demo/task-1", by: "살아있음", t: at(80) });
  // 옛 미완료 발령: 중앙 카드는 이미 끝났는데 원장에 done 없는 send만 남았다(운영의 최상위 4개와 같은 꼴). 화면 행에는 없다.
  const old = cards.create({ repo: "demo", id: "task-old", repoPath: home, title: "옛 카드", body: "# 옛", by: "사람" });
  cards.update(old.key, { status: "done", role: "꺼짐-옛발령", board: "판", scope: "격리 시험", rallyId: "r-1", rallyTitle: "묶음", rallyRound: "1", rallyStep: "implementation" }, { revision: old.revision, by: "사람", note: "끝" });
  put({ kind: "send", role: "꺼짐-옛발령", session: "kadan-꺼짐-옛발령", taskId: "demo/task-old", by: "살아있음", t: at(85) });
  return { home, cards, works };
}

function snapshotOf(f, { runtimeKnown = true } = {}) {
  const entries = readLedger(f.home);
  const alive = Object.fromEntries(ALIVE.map((role) => [`kadan-${role}`, { session: `kadan-${role}`, alive: true, pid: pidOf(role) }]));
  const tree = buildTree(entries, runtimeKnown ? alive : {}, f.cards.listSummaries());
  return {
    home: f.home, collectedAt: new Date(now).toISOString(), centerError: null, entries, ledgerLines: entries.length,
    center: buildCardCenter({ cards: f.cards.list(), entries, tree, runtimeKnown, now }),
    registeredWorks: f.works.list(), resources: null, resourceError: "격리 시험", tree, decisions: [],
  };
}
const status = (snapshot) => dashboardData(snapshot, new URL("http://local/api/dashboard/status"));

test("현황 응답의 stopped는 감시와 같은 판정이고, held는 관계표 정리와 같은 이유를 준다", () => {
  const f = fixture(), snapshot = snapshotOf(f), data = status(snapshot);
  assert.deepEqual(data.stopped, ["꺼짐-발령", "꺼짐-빈손", "꺼짐-업무", "꺼짐-옛발령", "꺼짐-우편", "꺼짐-차례", "꺼짐-하위"].sort((a, b) => a.localeCompare(b, "ko")));
  // 감시(lifecycle-tail.mjs intendedStop)와 한 역할씩 대조한다: 세션 없는 역할은 stopped ⇔ intendedStop.
  for (const role of Object.keys(table)) {
    if (ALIVE.includes(role)) continue;
    assert.equal(data.stopped.includes(role), intendedStop(snapshot.entries, `kadan-${role}`), role);
  }
  assert.deepEqual(data.held, { "꺼짐-업무": "미완료 업무", "꺼짐-차례": "미완료 업무", "꺼짐-발령": "미완료 카드", "꺼짐-옛발령": "미완료 발령", "살아있음": "미완료 업무" });
  // 관계표 정리가 같은 원장으로 내는 판정과 대조한다(같은 함수 heldRoles). 현황의 held에는 정리에 없는 이유 "열린 경보"가
  // 더 있을 수 있다(tests/dashboard-review-fixes.test.mjs) — 이 자료에는 경보가 없어 두 쪽이 그대로 같다.
  const plan = planHierarchyPrune({ table, entries: snapshot.entries, cards: f.cards.listSummaries(), works: f.works.list(), now,
    sessions: ALIVE.map((role) => ({ session: `kadan-${role}`, alive: true, pid: pidOf(role) })) });
  const kept = new Map(plan.retain.map((r) => [r.role, r.reason]));
  for (const role of Object.keys(table)) {
    if (ALIVE.includes(role)) continue;
    const reason = kept.get(role);
    if (["미완료 카드", "미완료 업무", "미완료 발령", "카드 연결 모름"].includes(reason)) assert.equal(data.held[role], reason, `${role}: 정리가 붙잡는 이유가 현황에도 같다`);
    else assert.ok(!(role in data.held), `${role}: 정리가 든 일로 붙잡지 않으면 현황에도 없다(${reason ?? "정리 대상"})`);
  }
  // 재시작중: 정리는 restart stop도 종료 관측으로 센다(기존 동작). 지도는 그때까지 빨강으로 보이고, 정리되면 관계표와 함께 사라진다.
  assert.deepEqual(plan.remove.map((r) => r.role).sort(), ["꺼짐-빈손", "꺼짐-우편", "재시작중"].sort(), "든 일 없는 꺼진 역할은 정리 대상이다(보관 우편은 막지 않는다)");
  assert.equal(now - Date.parse(at(72)) > PRUNE_GRACE_MS, true);
});

test("원장에서 지도까지: 합격 기준 표(가짜 역할)", async () => {
  const { buildMap, STATE_LABEL } = await import("../gui/src/strategy-map.ts");
  const { supervisorLife, shownSupervisors } = await import("../gui/src/status-band.ts");
  const f = fixture(), data = status(snapshotOf(f));
  const map = buildMap({ hierarchy: data.hierarchy, rows: data.rows, live: data.live, alerts: data.alerts, lastRuns: data.lastRuns, stopped: data.stopped, held: data.held });
  const units = new Map(map.bases.flatMap((b) => b.units).map((u) => [u.role, u]));
  const shown = (role) => (units.has(role) ? STATE_LABEL[units.get(role).state] : "지도에 없음");
  assert.deepEqual(Object.fromEntries(Object.keys(table).map((role) => [role, shown(role)])), {
    "꺼짐-빈손": "지도에 없음",
    "꺼짐-업무": "꺼짐 · 인계 필요",
    "꺼짐-차례": "꺼짐 · 인계 필요",
    "꺼짐-발령": "꺼짐 · 인계 필요",
    "꺼짐-옛발령": "꺼짐 · 인계 필요",
    "꺼짐-하위": "꺼짐 · 인계 필요",
    "꺼짐-하위-작업자": "대기",
    "꺼짐-우편": "지도에 없음",
    "사라짐": "세션 사라짐",
    "재시작중": "세션 사라짐",
    "살아있음": "대기",
  });
  assert.deepEqual(map.bases.find((b) => b.id === "꺼짐-하위").units.map((u) => u.role), ["꺼짐-하위", "꺼짐-하위-작업자"], "하위가 판 아래 보인다");
  assert.equal(map.totals.dead, 2);
  // 지도에서 빠진 역할은 든 일이 없다(= 정리가 든 일로 붙잡지 않는다 — 앞 시험이 정리 쪽을 확인한다).
  for (const role of Object.keys(table)) if (!units.has(role)) assert.ok(!(role in data.held), role);
  // 전체 현황의 슈퍼감독 줄도 같은 말·같은 기준이다.
  const lines = Object.fromEntries(shownSupervisors(data.supervisors.items, new Set(units.keys())).map((s) => [s.super, supervisorLife(s)]));
  assert.equal(lines["꺼짐-빈손"], undefined);
  assert.equal(lines["꺼짐-우편"], undefined);
  assert.equal(lines["꺼짐-업무"], "꺼짐 · 인계 필요");
  assert.equal(lines["꺼짐-하위"], "꺼짐 · 인계 필요");
  assert.equal(lines["사라짐"], "세션 사라짐");
  assert.equal(lines["재시작중"], "세션 사라짐");
  assert.match(lines["살아있음"], /^살아 있음/);
  // 세션 조회 실패: 서버는 stopped를 모름(null)으로 주고, 지도는 전부 "세션 모름"으로 남긴다(숨기지 않는다).
  const blind = status(snapshotOf(f, { runtimeKnown: false }));
  assert.equal(blind.live, null);
  assert.equal(blind.stopped, null);
  const blindUnits = buildMap({ hierarchy: blind.hierarchy, rows: blind.rows, live: blind.live, alerts: blind.alerts, stopped: blind.stopped, held: blind.held }).bases.flatMap((b) => b.units);
  assert.ok(blindUnits.some((u) => u.role === "꺼짐-빈손"));
  // 카드를 든 역할은 예전처럼 카드 상태(오래된 미확정 등)가 먼저이고, 나머지는 세션 모름이다. 누구도 꺼짐·사라짐으로 꾸미지 않는다.
  assert.ok(blindUnits.every((u) => u.alive === null && !["dead", "stopped"].includes(u.state)));
  assert.equal(STATE_LABEL[blindUnits.find((u) => u.role === "꺼짐-빈손").state], "세션 모름");
  assert.equal(STATE_LABEL[blindUnits.find((u) => u.role === "사라짐").state], "세션 모름");
});

test("정상 종료 판정은 역할 나무의 기존 훑기에서 나온다(현황 계산이 원장을 다시 훑지 않는다)", () => {
  const f = fixture(), snapshot = snapshotOf(f);
  const roles = new Map(snapshot.center.roles.map((r) => [r.role, r.intendedStop]));
  assert.equal(roles.get("꺼짐-빈손"), true);
  assert.equal(roles.get("재시작중"), false);
  assert.equal(roles.get("사라짐"), false);
  // 다시 시작하면 정상 종료가 아니다(뒤의 start가 이긴다). life.state "dead"와 다른 값이다.
  appendLedger({ kind: "start", role: "꺼짐-빈손", session: "kadan-꺼짐-빈손", panePid: "999", cmd: "claude", by: "사람", t: at(1) }, f.home);
  const again = snapshotOf(f).center.roles.find((r) => r.role === "꺼짐-빈손");
  assert.deepEqual([again.intendedStop, again.life.state], [false, "dead"], "stop이 한 번이라도 있었다는 뜻인 life.state와 구분된다");
  // stoppedRoles는 원장을 인자로 받지 않는다 — center.roles(역할 나무가 한 번 훑으며 만든 값)만 읽는다. 추가 훑기 0회의 근거다.
  assert.equal(stoppedRoles.length, 2, "입력은 center와 역할 집합뿐이다");
  assert.deepEqual(stoppedRoles(snapshot.center, new Set(["꺼짐-빈손", "사라짐"])), ["꺼짐-빈손"]);
  assert.equal(stoppedRoles({ ...snapshot.center, runtimeKnown: false }, new Set(["꺼짐-빈손"])), null, "세션 상태를 모르면 모름");
});
