import "./helpers/isolated-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { scenario, surfaces, parents } from "./helpers/responsibility-scenario.mjs";
import { currentResponsibility, responsibilityTargets } from "../src/handover-state.mjs";
import { idleWorkEntries, assessSupervisorIdle } from "../src/watch-supervisor.mjs";
import { buildSupervisorScope } from "../src/watch-scope.mjs";
import { SupervisorHealth } from "../src/watch-supervisor-health.mjs";

// 실행 발령이 있는 열린 업무는 {감시 범위, 이전 세대 목록} 중 정확히 하나에 나온다.
const exactlyOne = (s) => {
  const { scopeRoles, previous } = surfaces(s);
  assert.equal(Number(scopeRoles.length > 0) + Number(previous.length > 0), 1, JSON.stringify({ scopeRoles, previous }));
  return { scopeRoles, previous };
};

test("재현: 새 대화 세대 × 같은 owner 재배정 × 과거 turnOwner — 감시와 이전 세대 목록 양쪽에서 빠지지 않는다", () => {
  const s = scenario({ run: ({ start, update }) => {
    start("r-감독"); update({ turnOwner: "r-감독" }); start("r-감독"); update({ owner: "r-감독" });
  } });
  const w = s.work;
  assert.equal(w.ownedAt, w.history.at(-1).ownerAssignedAt, "ownedAt은 재배정 시각이다");
  assert.ok(Date.parse(w.ownedAt) > Date.parse(w.turnAt), "재배정이 과거 차례보다 늦다");
  assert.equal(currentResponsibility(w, parents).since, w.ownedAt, "늦은 쪽(재배정)이 책임 시각");
  const { scopeRoles } = exactlyOne(s);
  assert.ok(scopeRoles.includes("r-감독"), "감독 응답 감시 범위에 든다");
  const idle = idleWorkEntries(s.works, s.cards, parents);
  assert.deepEqual(idle.map((e) => [e.role, e.ownedAt]), [["r-감독", w.ownedAt]]);
  const states = new Map(["r-슈퍼", "r-감독", "r-작업자"].map((r) => [`kadan-${r}`, { alive: true, digest: "same", unchangedMs: 3600e3 }]));
  const alerts = assessSupervisorIdle(s.entries, states, Date.now() + 3600e3, 60e3, null, parents,
    { works: s.works, cards: s.cards, waits: [], peerEntries: s.entries }).filter((a) => a.kind === "놀고 있음");
  assert.ok(alerts.some((a) => a.idleItems?.own?.includes("work:r/w1")), "유휴 감시 대상에도 든다");
});

test("성질: 어떤 상황에서도 정확히 하나에 나온다", () => {
  const cases = {
    "같은 이름 재배정 뒤 새 세대": [({ start, update }) => { start("r-감독"); update({ turnOwner: "r-감독" }); start("r-감독"); update({ owner: "r-감독" }); }, "scope"],
    "차례≠owner, owner가 옛 세대": [({ start, update }) => { start("r-슈퍼"); start("r-슈퍼"); update({ turnOwner: "r-감독" }); }, "scope"],
    "차례≠owner, 차례가 옛 세대": [({ start, update }) => { update({ turnOwner: "r-감독" }); start("r-감독"); start("r-감독"); }, "scope"],
    "차례≠owner, 둘 다 옛 세대": [({ start, update }) => { update({ turnOwner: "r-감독" }); start("r-감독"); start("r-감독"); start("r-슈퍼"); start("r-슈퍼"); }, "previous"],
    "평범한 현재": [() => {}, "scope"],
    "차례=작업자": [({ update }) => update({ turnOwner: "r-작업자" }), "scope"],
    "차례=작업자, 그 작업자가 새 세대": [({ start, update }) => { update({ turnOwner: "r-작업자" }); start("r-작업자"); start("r-작업자"); }, "scope"],
    "owner가 옛 세대(차례 없음)": [({ start }) => { start("r-감독"); start("r-감독"); }, "previous"],
  };
  for (const [name, [run, expected]] of Object.entries(cases)) {
    const { scopeRoles, previous } = exactlyOne(scenario({ owner: name.startsWith("차례≠owner") ? "r-슈퍼" : "r-감독", run }));
    assert.equal(scopeRoles.length > 0 ? "scope" : "previous", expected, `${name}: ${JSON.stringify({ scopeRoles, previous })}`);
  }
});

test("작업자 차례: 응답 점검 대상은 감독뿐이고, 그 작업자를 stop해도 죽음 경보가 없다. owner 감독은 범위에 남는다", () => {
  const s = scenario({ run: ({ update }) => update({ turnOwner: "r-작업자" }) });
  assert.deepEqual(currentResponsibility(s.work, parents), { role: "r-감독", since: s.work.ownedAt });
  assert.deepEqual(responsibilityTargets(s.work, parents).map((t) => t.role), ["r-감독"]);
  const scope = buildSupervisorScope(s.cards, s.entries, parents, s.works);
  assert.ok(scope.sessions.has("kadan-r-감독"));
  assert.ok(!scope.sessions.has("kadan-r-작업자"), "작업자는 응답 점검 대상이 아니다");
  // 작업자를 stop한 상태(세션 없음)를 관찰로 넣는다.
  const observations = new Map([["kadan-r-작업자", { alive: false }], ["kadan-r-감독", { alive: true, pid: 1, expectedPid: 1, screen: "ok", startedAt: new Date().toISOString() }],
    ["kadan-r-슈퍼", { alive: true, pid: 2, expectedPid: 2, screen: "ok", startedAt: new Date().toISOString() }]]);
  const { alerts } = new SupervisorHealth().select({ scope, observations, entries: s.entries, cards: s.cards, now: Date.now(), enabled: false });
  assert.deepEqual(alerts.filter((a) => a.id === "supervisor-health:kadan-r-작업자"), []);
});

test("차례가 owner와 다른 감독이면 지금처럼 그 감독과 차례 시각이다", () => {
  const s = scenario({ run: ({ update }) => update({ turnOwner: "r-감독" }), owner: "r-슈퍼" });
  assert.deepEqual(currentResponsibility(s.work, parents), { role: "r-감독", since: s.work.turnAt });
  assert.deepEqual(responsibilityTargets(s.work, parents).map((t) => t.role), ["r-슈퍼", "r-감독"]);
});
