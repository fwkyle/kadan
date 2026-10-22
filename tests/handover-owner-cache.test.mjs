import "./helpers/isolated-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { effectiveWorkOwnership, withEffectiveOwner } from "../src/handover-state.mjs";

// 기준 구현: 캐시 도입 전 effectiveWorkOwnership 본문. 시험 안에만 둔다.
function baseline(work, entries) {
  const history = work.history ?? [];
  const changed = history.findLast((h, i) => i === 0 || history[i - 1].owner !== h.owner)?.at ?? work.at;
  const assigned = history.findLast(h => h.ownerAssignedAt)?.ownerAssignedAt;
  const since = assigned && (!changed || Date.parse(assigned) > Date.parse(changed)) ? assigned : changed;
  let owner = work.owner, at = since ?? null;
  for (const e of entries) if (e?.kind === 'handover' && e.phase === 'transferred' && e.from === owner &&
    (!since || !e.t || Date.parse(e.t) >= Date.parse(since))) { owner = e.to; at = e.t ?? null; }
  return { owner, at };
}

const at = (min) => new Date(Date.parse("2026-10-14T00:00:00Z") + min * 60_000).toISOString();
const ho = (from, to, min, extra = {}) => ({ kind: "handover", phase: "transferred", from, to, ...(min == null ? {} : { t: at(min) }), ...extra });
const noise = [{ kind: "send", role: "a" }, null, { kind: "handover", phase: "requested", from: "A", to: "B", t: at(5) }, { kind: "done" }];
const work = (extra = {}) => ({ key: "r/w", owner: "A", at: at(0), history: [{ owner: "A", at: at(0) }], ...extra });
const same = (w, entries) => assert.deepEqual(effectiveWorkOwnership(w, entries), baseline(w, entries));

test("인계 없음", () => same(work(), noise));
test("A→B→C 체인은 원장 순서를 따른다", () => {
  const entries = [...noise, ho("A", "B", 10), noise[0], ho("B", "C", 20)];
  same(work(), entries);
  assert.deepEqual(effectiveWorkOwnership(work(), entries), { owner: "C", at: at(20) });
  // 순서가 뒤집히면 체인이 끊긴다 — 거른 배열도 원래 순서를 지킨다.
  const reversed = [ho("B", "C", 20), ho("A", "B", 10)];
  same(work(), reversed);
  assert.equal(effectiveWorkOwnership(work(), reversed).owner, "B");
});
test("since 이전 인계는 제외한다", () => {
  const w = work({ owner: "B", at: at(30), history: [{ owner: "A", at: at(0) }, { owner: "B", at: at(30) }] });
  const entries = [ho("B", "C", 10), ho("B", "D", 40)];
  same(w, entries);
  assert.equal(effectiveWorkOwnership(w, entries).owner, "D");
});
test("t 없는 인계는 since와 상관없이 따른다", () => {
  const entries = [ho("A", "B", null)];
  same(work(), entries);
  assert.deepEqual(effectiveWorkOwnership(work(), entries), { owner: "B", at: null });
});
test("ownerAssignedAt이 history 변경보다 늦으면 그 시각이 since", () => {
  const w = work({ history: [{ owner: "A", at: at(0) }, { owner: "A", at: at(5), ownerAssignedAt: at(50) }] });
  const entries = [ho("A", "B", 20), ho("A", "C", 60)];
  same(w, entries);
  assert.equal(effectiveWorkOwnership(w, entries).owner, "C");
});
test("같은 체인을 공유하는 업무 여러 개", () => {
  const entries = [...noise, ho("A", "B", 10), ho("B", "C", 20), ho("X", "Y", 15)];
  for (const w of [work(), work({ key: "r/w2" }), work({ owner: "X", history: [{ owner: "X", at: at(0) }] }), work({ owner: "Z", history: [] })]) {
    same(w, entries);
    assert.deepEqual(withEffectiveOwner(w, entries), { ...w, ...(({ owner, at: a }) => ({ owner, ownedAt: a }))(baseline(w, entries)) });
  }
});
test("같은 entries로 두 번 불러도 결과가 같다(캐시 적중)", () => {
  const entries = [ho("A", "B", 10)];
  const first = effectiveWorkOwnership(work(), entries), second = effectiveWorkOwnership(work(), entries);
  assert.deepEqual(first, second);
  assert.deepEqual(second, baseline(work(), entries));
});
test("같은 배열에 사건이 덧붙으면 길이 검사로 다시 거른다", () => {
  const entries = [ho("A", "B", 10)];
  assert.equal(effectiveWorkOwnership(work(), entries).owner, "B");
  entries.push(ho("B", "C", 20));
  same(work(), entries);
  assert.equal(effectiveWorkOwnership(work(), entries).owner, "C");
});
test("배열이 아닌 반복 가능 입력도 같은 답", () => {
  const entries = [ho("A", "B", 10), ho("B", "C", 20)];
  assert.deepEqual(effectiveWorkOwnership(work(), new Set(entries)), baseline(work(), entries));
});
