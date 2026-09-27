// 판 설명과 카드 제목 — "mp가 도대체 뭐냐"를 없앤다 (2026-09-06 [kyle] 신고).
// 원장은 append-only이므로 옛 줄에는 설명이 없다. 그 경우 예전처럼 id만 보여야 한다.
import "./helpers/isolated-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { buildTree, planCards, parsePlanCard, renderTree } from "../src/cli.mjs";
import { renderWallHtml } from "../src/wall.mjs";

test("판 설명과 카드 제목을 원장 plan 줄에 남긴다 — 2026-09-06", () => {
  const lines = [];
  planCards({
    board: "mp",
    about: "역할별 모델 편성과 계열 분리",
    taskIds: ["card-65:역할별 프리셋·계열 정의", "card-66"],
    env: {},
    record: entry => lines.push(entry),
  });

  assert.equal(lines.length, 2);
  assert.equal(lines[0].title, "역할별 프리셋·계열 정의");
  assert.equal(lines[0].about, "역할별 모델 편성과 계열 분리");
  assert.equal(lines[0].taskId, "card-65");
  // 제목이 없는 카드는 title 없이 남는다 — 없는 값을 지어내지 않는다.
  assert.equal("title" in lines[1], false);
  assert.equal(lines[1].about, "역할별 모델 편성과 계열 분리");
});

test("제목의 콜론은 첫 번째만 가르고 설명 없는 호출은 예전과 같다", () => {
  assert.deepEqual(parsePlanCard("card-70:라운드 표기: 사람 말로"), {
    taskId: "card-70",
    title: "라운드 표기: 사람 말로",
  });
  assert.deepEqual(parsePlanCard("card-71"), { taskId: "card-71" });

  const lines = [];
  planCards({ board: "b", taskIds: ["card-1"], env: {}, record: entry => lines.push(entry) });
  assert.deepEqual(lines, [{ kind: "plan", board: "b", taskId: "card-1", by: "사람" }]);
});

test("제목이 있어도 카드 id 중복과 공백 id는 그대로 막는다", () => {
  const reject = taskIds =>
    assert.throws(() => planCards({ board: "b", taskIds, env: {}, record: () => {} }), /카드 중복/);
  reject(["card-1:제목", "card-1:다른 제목"]);
  reject([":제목만 있음"]);
});

test("화면은 판 설명과 카드 제목을 보여주고, 없으면 id만 보여준다", () => {
  const entries = [
    { t: "2026-09-06T02:00:00.000Z", kind: "plan", board: "mp", taskId: "card-65", title: "역할별 프리셋", about: "역할별 모델 편성", by: "슈퍼감독" },
    { t: "2026-09-06T02:00:00.000Z", kind: "plan", board: "mp", taskId: "card-66", title: "계열 겹침 경고", about: "역할별 모델 편성", by: "슈퍼감독" },
    { t: "2026-09-06T02:10:00.000Z", kind: "start", role: "mp-작업자", session: "kadan-mp-작업자", panePid: "1", window: "rottie" },
    { t: "2026-09-06T02:11:00.000Z", kind: "send", role: "mp-작업자", session: "kadan-mp-작업자", taskId: "card-65", by: "슈퍼감독" },
    { t: "2026-09-06T02:20:00.000Z", kind: "plan", board: "old", taskId: "card-1", by: "사람" },
  ];
  const tree = buildTree(entries, {});
  const text = renderTree(tree);

  // 발령된 카드도 제목이 살아 있어야 한다 — send 줄에는 제목이 없다.
  assert.match(text, /판 mp — 역할별 모델 편성/);
  assert.match(text, /card-65.*역할별 프리셋/);
  assert.match(text, /발령 전 1장: card-66\(계열 겹침 경고\)/);
  // 설명 없는 옛 판은 예전 모양 그대로다.
  assert.match(text, /판 old\n/);

  const html = renderWallHtml({
    tree,
    entries,
    collectedAt: new Date("2026-09-06T02:30:00.000Z"),
    ledgerPath: "/tmp/kadan/ledger.jsonl",
    ledgerLines: entries.length,
    error: null,
    all: true,
  });
  assert.match(html, /역할별 모델 편성/);
  assert.match(html, /card-66\(계열 겹침 경고\)/);
  assert.match(html, /라운드 1\/18/);
});
