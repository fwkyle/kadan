import "./helpers/isolated-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createDatabase, writeStorageMarker } from "../src/storage.mjs";
import { WorkStore } from "../src/work-store.mjs";
import { CardStore } from "../src/card-store.mjs";
import { cardCommand } from "../src/card-command.mjs";
import { readLedger } from "../src/ledger.mjs";
import { buildCardCenter } from "../src/card-center.mjs";
import { mergeCheck } from "../src/merge-check.mjs";
import { nightState } from "../src/night.mjs";
import { nightStrip, prHeadOf, ciLineOf, reviewsOfWork, judgeHead, mergeLineInfo } from "../src/dashboard/night-view.mjs";
import { frontStrip } from "../src/dashboard/front.mjs";

// Why: PR3 나이트런 띠가 스냅샷(최신 상태 결정)으로도 night status와 같은 켜짐/꺼짐을 내는지,
// 머지 줄의 검수 SHA·커밋 같음 판정이 merge-check와 같은 결과인지 확인한다.
const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const on = { kind: "night", phase: "on", by: "사람", text: "자라", t: iso(NOW - 3600_000), until: iso(NOW + 3600_000), level: "자동", onlyRunning: false };
const answer = (at, by = "사람") => ({ id: "d1", status: "answered", to: "@user", answer: { by, at: iso(at), text: "응" } });
const snap = (entries, decisions = [], over = {}) => ({ entries, ledgerLines: entries.length, decisions, decisionError: null, ...over });

test("nightStrip: 켜짐 — nightState(이벤트)와 같은 결과, 단계·끝 시각을 싣는다", () => {
  const strip = nightStrip(snap([{ kind: "x" }, on, { kind: "y" }]), NOW);
  assert.deepEqual(strip, { on: true, since: on.t, until: on.until, level: "자동", onlyRunning: false });
  assert.equal(nightState([on], [], NOW).on, true);
});

test("nightStrip: 스냅샷 결정(최신 상태)과 이벤트 줄이 같은 판정 — 켜진 뒤 사람 답, 켜지기 전 답, 기계 답, 끝 시각 지남", () => {
  const events = (list) => list.map((d) => ({ status: d.status, answer: d.answer }));
  const cases = [
    [[answer(NOW - 1800_000)], false],          // 켜진 뒤 사람이 답함 → 꺼짐
    [[answer(NOW - 7200_000)], true],           // 켜지기 전 답 → 영향 없음
    [[answer(NOW - 1800_000, "감독")], true],   // 사람이 아닌 답 → 영향 없음
    [[{ id: "d2", status: "open", to: "@user" }], true],
  ];
  for (const [decisions, wantOn] of cases) {
    assert.equal(nightState([on], events(decisions), NOW).on, wantOn);
    assert.equal(nightStrip(snap([on], decisions), NOW).on, wantOn);
  }
  const expired = nightStrip(snap([{ ...on, until: iso(NOW - 60_000) }]), NOW);
  assert.equal(expired.on, false);
  assert.equal(expired.last.phase, "expired");
});

test("nightStrip: 켠 적 없음·끝 사건 있음·읽기 실패(모름)", () => {
  assert.deepEqual(nightStrip(snap([{ kind: "x" }]), NOW), { on: false, last: null });
  const off = { kind: "night", phase: "off", startedAt: on.t, endedAt: iso(NOW - 600_000), t: iso(NOW - 600_000) };
  assert.deepEqual(nightStrip(snap([on, off]), NOW), { on: false, last: { since: on.t, endedAt: off.endedAt, phase: "off" } });
  assert.equal(nightStrip({ entries: [], ledgerLines: null, decisions: [] }, NOW).on, null);
  assert.equal(nightStrip(snap([on], [], { decisionError: "손상" }), NOW).on, null);
});

test("결정 글에서 PR head·CI 줄은 적혀 있을 때만 읽는다", () => {
  const head = "a".repeat(40);
  assert.equal(prHeadOf({ question: `머지?\nPR head: ${head}` }), head);
  assert.equal(prHeadOf({ reason: "headRefOid=ABCDEF1234" }), "abcdef1234");
  assert.equal(prHeadOf({ question: "head 가 바뀌었나요? https://github.com/o/r/pull/1" }), null);
  assert.equal(prHeadOf({ question: "커밋 abcdef1234 를 봤다" }), null, "head 표시 없이 적힌 해시는 PR head로 보지 않는다");
  assert.equal(ciLineOf({ question: "머지?\nCI 통과 (11:02 기록)\n끝" }), "CI 통과 (11:02 기록)");
  assert.equal(ciLineOf({ question: "머지?" }), null);
});

test("frontStrip: 머지 요청에만 mergeInfo를 싣고, 안 주면 모양이 그대로", () => {
  const dec = (id, question) => ({ id, status: "open", to: "@user", requestedBy: "슈퍼", card: "r/c", question });
  const list = [dec("m", "https://github.com/o/r/pull/9"), dec("q", "그냥 질문")];
  const plain = frontStrip({ decisions: list, stoppedRows: [] });
  assert.ok(plain.decisions.every((d) => !("mergeInfo" in d)));
  const out = frontStrip({ decisions: list, stoppedRows: [], mergeInfo: (d) => ({ id: d.id }) });
  assert.deepEqual(out.decisions.find((d) => d.id === "m").mergeInfo, { id: "m" });
  assert.ok(!("mergeInfo" in out.decisions.find((d) => d.id === "q")));
});

// ---- merge-check와 맞춰 보기(진짜 카드·업무·검수 보고) ----
const A = "a".repeat(40), B = "b".repeat(40);
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-night-view-"));
  const repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kadan-nv-repo-")));
  assert.equal(spawnSync("git", ["-C", repoDir, "init", "--quiet"], { encoding: "utf8" }).status, 0);
  createDatabase(home); writeStorageMarker(home, "sqlite");
  const store = new WorkStore(home), cards = new CardStore(home);
  store.create({ key: "repo/w", title: "업무", goal: "결과", scope: "범위", acceptance: "조건", owner: "감독", repoPath: repoDir });
  const addReview = (round) => {
    store.change("repo/w", "execute", { title: `검수${round}`, body: `# 검수\n\n## 읽고 시작할 것\n- ${home}/AGENTS.md — 규칙\n`, phase: "review", round: String(round) },
      { revision: store.get("repo/w").revision, by: "감독", note: "검수 발령" });
    const key = store.get("repo/w").executions.at(-1).key;
    cards.update(key, { status: "assigned", scope: "범위", board: "b", role: "rv-test", rallyId: "w", rallyTitle: "업무", rallyRound: String(round), rallyStep: "review" },
      { revision: cards.get(key).revision, by: "감독", note: "발령", manual: true });
    return key;
  };
  const report = (key, outcome, flags = {}) => {
    const card = cards.get(key);
    fs.writeFileSync(card.resultPath, `검수 결과 ${key}`);
    return cardCommand(["report", key], { revision: card.revision, outcome, ...flags }, { home, by: "rv-test" });
  };
  const center = () => buildCardCenter({ cards: new CardStore(home).list(), entries: readLedger(home), tree: [], runtimeKnown: false });
  return { home, store, addReview, report, center };
}

test("머지 줄 판정은 mergeCheck와 같다: pass 없음·SHA 없음·같음·다름·changes", () => {
  const f = fixture();
  const compare = (head) => {
    const expected = mergeCheck("repo/w", { head }, { home: f.home }).result;
    const reviews = reviewsOfWork(f.center(), f.store.get("repo/w"));
    assert.equal(judgeHead(reviews, head), expected);
    return expected;
  };
  assert.equal(compare(A), "검수 pass 없음");
  const first = f.addReview(1);
  f.report(first, "pass");
  assert.equal(compare(A), "검수 SHA 없음");
  const second = f.addReview(2);
  f.report(second, "pass", { sha: A });
  assert.equal(compare(A), "같음");
  assert.equal(compare(B), "다름");
  const third = f.addReview(3);
  f.report(third, "changes", { sha: B });
  assert.equal(compare(B), "같은 커밋 검수 changes");
});

test("mergeLineInfo: 연결 업무가 없으면 '검수 기록 모름', 있으면 검수 SHA와 (head가 적힌 때만) 같음 판정", () => {
  const f = fixture();
  f.report(f.addReview(1), "pass", { sha: A });
  const snapshot = { center: f.center(), entries: [], ledgerLines: 0, decisions: [] };
  const shaped = { ...snapshot, home: f.home, registeredWorks: f.store.list() };
  const none = mergeLineInfo(shaped, { id: "d", card: "nowhere/c", at: iso(NOW) });
  assert.equal(none.review, "검수 기록 모름");
  assert.equal(none.reviewSha, null);
  assert.equal(none.match, null);
  const linked = mergeLineInfo(shaped, { id: "d", work: "repo/w", question: `PR head: ${A}\nCI 통과`, at: iso(NOW) });
  assert.equal(linked.work, "repo/w");
  assert.equal(linked.reviewSha, A);
  assert.equal(linked.match, "같음");
  assert.equal(linked.ci, "CI 통과");
  const noHead = mergeLineInfo(shaped, { id: "d", work: "repo/w", at: iso(NOW) });
  assert.equal(noHead.match, null, "PR head가 결정 글에 없으면 같음/다름을 말하지 않는다");
});
