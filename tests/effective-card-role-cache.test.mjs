import "./helpers/isolated-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { effectiveCardRole } from "../src/handover-state.mjs";
import { taskIdentity } from "../src/task-identity.mjs";

// 기준 구현: 캐시 도입 전 effectiveCardRole 본문. 시험 안에만 둔다.
function baseline(card, entries, cards = null) {
  const identity = Array.isArray(cards) ? taskIdentity(cards) : cards;
  let role = card.role;
  for (const e of entries) if (e?.kind === 'handover' && e.phase === 'transferred' && e.from === role &&
    card.key && e.taskIds?.some(id => { const found = identity?.resolve(id); return identity ? found.state === 'resolved' && found.key === card.key : id === card.key; }) &&
    (!card.at || !e.t || Date.parse(e.t) >= Date.parse(card.at))) role = e.to;
  return role;
}

const at = (min) => new Date(Date.parse("2026-10-14T00:00:00Z") + min * 60_000).toISOString();
const ho = (from, to, min, taskIds, extra = {}) => ({ kind: "handover", phase: "transferred", from, to, taskIds, ...(min == null ? {} : { t: at(min) }), ...extra });
const noise = [{ kind: "send", role: "a" }, null, { kind: "handover", phase: "requested", from: "A", to: "B", taskIds: ["r/c"], t: at(5) }, { kind: "done" }];
const card = (extra = {}) => ({ key: "r/c", id: "c", role: "A", at: at(0), ...extra });
const same = (c, entries, cards) => {
  assert.equal(effectiveCardRole(c, entries, cards), baseline(c, entries, cards));
  return effectiveCardRole(c, entries, cards);
};

test("인계 없음·요청만 있는 인계는 담당이 그대로다", () => {
  assert.equal(same(card(), noise), "A");
});
test("A→B→C 연쇄는 원장 순서를 따르고 뒤집히면 끊긴다", () => {
  const entries = [...noise, ho("A", "B", 10, ["r/c"]), noise[0], ho("B", "C", 20, ["r/c"])];
  assert.equal(same(card(), entries), "C");
  assert.equal(same(card(), [ho("B", "C", 20, ["r/c"]), ho("A", "B", 10, ["r/c"])]), "B");
});
test("카드 시각 이전 인계는 제외하고 시각 없는 인계는 따른다", () => {
  assert.equal(same(card({ at: at(30) }), [ho("A", "B", 10, ["r/c"])]), "A");
  assert.equal(same(card({ at: at(30) }), [ho("A", "B", null, ["r/c"])]), "B");
  assert.equal(same(card({ at: undefined }), [ho("A", "B", 10, ["r/c"])]), "B");
});
test("다른 카드 인계·키 없는 카드는 따르지 않는다", () => {
  assert.equal(same(card(), [ho("A", "B", 10, ["r/other"])]), "A");
  assert.equal(same(card({ key: undefined }), [ho("A", "B", 10, ["r/c"])]), "A");
});
test("실행 ID 별칭(identity.resolve)은 해석된 카드만 따른다", () => {
  const cards = [card(), card({ key: "s/c", id: "c" })];
  const entries = [ho("A", "B", 10, ["r/c"])];
  assert.equal(same(cards[0], entries, cards), "B");
  assert.equal(same(cards[1], entries, cards), "A");
  const bare = [ho("A", "B", 10, ["c"])];
  assert.equal(same(cards[0], bare, cards), "A");
});
test("같은 배열에 사건을 덧붙인 뒤 다시 불러도 새 사건을 본다", () => {
  const entries = [ho("A", "B", 10, ["r/c"])];
  assert.equal(same(card(), entries), "B");
  entries.push(noise[0], ho("B", "C", 20, ["r/c"]));
  assert.equal(same(card(), entries), "C");
});
test("다른 배열은 서로 캐시를 섞지 않는다", () => {
  const a = [ho("A", "B", 10, ["r/c"])], b = [ho("A", "Z", 10, ["r/c"])];
  assert.equal(same(card(), a), "B");
  assert.equal(same(card(), b), "Z");
  assert.equal(same(card(), a), "B");
});
test("배열이 아닌 반복 가능한 입력도 같은 결과를 낸다", () => {
  const set = new Set([ho("A", "B", 10, ["r/c"])]);
  assert.equal(effectiveCardRole(card(), set), "B");
});
