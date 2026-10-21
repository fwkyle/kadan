import "./helpers/isolated-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { isTurnCurrent, turnState, lastChildAt, currentResponsibility, responsibilityTargets } from "../src/handover-state.mjs";
import { idleWorkEntries } from "../src/watch-supervisor.mjs";
import { workDashboardModel } from "../src/work-dashboard.mjs";

// 차례 기록 유효성: 대시보드와 감시가 같은 함수를 쓴다(같은 개념 감사 5번).
const parents = new Map(Object.entries({ "r-슈퍼": "@user", "r-감독": "r-슈퍼", "r-작업자": "r-감독" }));
const T = (m) => new Date(Date.UTC(2026, 9, 21, 0, m)).toISOString();
const card = { key: "r/e1", id: "e1", title: "실행", status: "done", workType: "execution", role: "r-작업자", at: T(30), runs: [{ at: T(40) }] };
const base = { key: "r/w1", title: "t", goal: "g", status: "open", owner: "r-슈퍼", ownedAt: T(0), at: T(5), revision: 1, history: [],
  executions: [{ key: "r/e1", phase: "implementation", round: 1 }], turnOwner: "r-감독" };

const both = (work) => {
  const model = workDashboardModel([work], { cards: [card] }, [])[0];
  const idle = idleWorkEntries([work], [card], parents);
  return { label: model.turnLabel, source: model.turnSource, idleRole: idle[0]?.role, holder: currentResponsibility(work, parents, [card]).role };
};

test("마지막 하위 실행 시각은 카드 at과 runs[].at 중 최댓값이다", () => {
  assert.equal(lastChildAt(base, [card]), Date.parse(T(40)));
  assert.equal(lastChildAt(base, []), 0);
  assert.equal(lastChildAt(base, null), 0);
});

test("turnAt < 마지막 하위 실행: 대시보드와 감시 모두 옛 turnOwner를 쓰지 않는다", () => {
  const work = { ...base, turnAt: T(10) };
  assert.equal(turnState(work, [card]), "stale");
  const r = both(work);
  assert.notEqual(r.source, "차례 기록");
  assert.equal(r.holder, "r-슈퍼");
  assert.equal(r.idleRole, "r-슈퍼");
  assert.deepEqual(responsibilityTargets(work, parents, [card]).map((t) => t.role), ["r-슈퍼"]);
});

test("turnAt ≥ 마지막 하위 실행: 둘 다 turnOwner다", () => {
  for (const at of [T(40), T(50)]) {
    const work = { ...base, turnAt: at };
    assert.equal(isTurnCurrent(work, [card]), true);
    const r = both(work);
    assert.equal(r.label, "r-감독");
    assert.equal(r.source, "차례 기록");
    assert.equal(r.holder, "r-감독");
    assert.equal(r.idleRole, "r-감독");
  }
});

test("turnAt 없음·잘못된 시각: 지금과 같다(대시보드는 차례 기록으로 안 보고, 감시는 turnOwner를 따른다)", () => {
  for (const turnAt of [undefined, "", "엉터리"]) {
    const work = { ...base, turnAt };
    assert.equal(turnState(work, [card]), "unknown");
    assert.notEqual(both(work).source, "차례 기록");
    assert.equal(currentResponsibility(work, parents, [card]).role, "r-감독");
  }
});

test("cards를 안 주면 하위 실행을 모르는 것이라 turnAt만 본다(옛 호출 모양)", () => {
  assert.equal(currentResponsibility({ ...base, turnAt: T(10) }, parents).role, "r-감독");
});

test("차례가 작업자면 응답 책임은 여전히 owner다(차례와 책임의 구분 유지)", () => {
  const work = { ...base, turnOwner: "r-작업자", turnAt: T(50) };
  assert.equal(currentResponsibility(work, parents, [card]).role, "r-슈퍼");
});

test("차례가 owner 자신이면 지난 기록이어도 since를 유지한다(세대 판정 불변, main과 같음)", () => {
  const work = { ...base, turnOwner: "r-슈퍼", turnAt: T(30), ownedAt: T(20) };
  assert.equal(turnState(work, [card]), "stale");
  assert.deepEqual(currentResponsibility(work, parents, [card]), { role: "r-슈퍼", since: T(30) });
  assert.deepEqual(currentResponsibility(work, parents, [card]), currentResponsibility(work, parents));
});
