import "./helpers/isolated-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CardStore } from "../src/card-store.mjs";
import { createDatabase, writeStorageMarker } from "../src/storage.mjs";
import { endedExecutionKeys } from "../src/watch-supervisor.mjs";
import { planStaleNotices } from "../src/watch-stale-notice.mjs";
import { ProgressWatch } from "../src/watch-progress.mjs";

// 감시기는 카드 본문·이력 없는 요약(listWatch)을 읽는다. 카드 센터가 이력으로 판정을 바꾸는 열린 카드에만 이력이 붙는다.
const ROLE = "r-작업자";
const send = (key, t) => ({ kind: "send", role: ROLE, taskId: key.split("/")[1], executionKey: key, by: "r-감독", t });
const done = (key, t) => ({ kind: "done", role: ROLE, taskId: key.split("/")[1], executionKey: key, by: "r-감독", result: "ok", t });

function setup(mode) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-watch-card-summaries-"));
  if (mode === "sqlite") { createDatabase(home); writeStorageMarker(home, mode); }
  const store = new CardStore(home);
  const make = (id, body = "# 본문 " + id) => store.create({ repo: "r", id, repoPath: home, body });
  // 발령 뒤 상태가 바뀐 카드(옛 완료 기록 뒤에 다시 열림)와 계속 열린 카드, 완료 카드, 보류에서 돌아온 ready 카드
  const reopened = make("reopened"), open = make("open"), closed = make("closed"), back = make("back");
  for (const c of [reopened, open, closed, back]) store.update(c.key, { status: "assigned", role: ROLE, board: "r", scope: "s", rallyId: "t", rallyTitle: "t", rallyRound: "1", rallyStep: "implementation" }, { revision: 1, note: "발령" });
  store.update(reopened.key, { scope: "다시" }, { revision: 2, note: "범위 변경" });
  store.update(reopened.key, { status: "ready" }, { revision: 3, note: "되돌림" });
  store.update(back.key, { status: "hold" }, { revision: 2, note: "보류" });
  store.update(back.key, { status: "ready" }, { revision: 3, note: "재개" });
  store.update(closed.key, { status: "done" }, { revision: 2, note: "완료" });
  return { home, store };
}

for (const mode of ["jsonl", "sqlite"]) {
  test(`${mode}: listWatch는 본문을 읽지 않고, 열린 카드에만 전체 이력을 붙인다`, () => {
    const { store } = setup(mode);
    const full = store.list(), original = fs.readFileSync;
    let bodyReads = 0;
    fs.readFileSync = function (file, ...args) { if (String(file).endsWith("/card.md")) bodyReads++; return original.call(this, file, ...args); };
    let watch;
    try { watch = store.listWatch(); } finally { fs.readFileSync = original; }
    assert.equal(bodyReads, 0, "목록에서 본문 조회 금지");
    assert.equal(watch.length, full.length);
    for (const f of full) {
      const w = watch.find(x => x.key === f.key), { body, history, ...meta } = f;
      assert.equal(w.body, undefined);
      if (["assigned", "ready", "draft"].includes(f.status)) assert.deepEqual(w, { ...meta, history }, `${f.key}: 이력 포함 요약`);
      else assert.deepEqual(w, meta, `${f.key}: 닫힌 카드는 이력 없음`);
    }
  });

  test(`${mode}: 이력에 의존하는 판정(완료 뒤 다시 열림·전환 시각)이 전체 카드와 같다`, () => {
    const { home, store } = setup(mode);
    // 옛 완료(2020)는 카드 변경보다 앞서고, 미래 완료(2099)는 뒤다. 두 경우 모두 전체 카드와 같아야 한다.
    for (const [sendAt, doneAt] of [["2020-01-01T00:00:00Z", "2020-01-01T01:00:00Z"], ["2099-01-01T00:00:00Z", "2099-01-01T01:00:00Z"]]) {
      const entries = ["reopened", "open", "closed", "back"].flatMap(id => [send(`r/${id}`, sendAt), done(`r/${id}`, doneAt)]);
      const now = Date.parse("2100-01-01T00:00:00Z");
      const run = cards => ({
        ended: [...endedExecutionKeys({ cards, entries, liveSessions: new Set(), now })].sort(),
        stale: planStaleNotices({ cards, entries, works: [], now, liveSessions: new Set() }),
      });
      const full = run(store.list()), watch = run(store.listWatch());
      assert.deepEqual(watch, full);
      // 대조: 이력을 빼면 결과가 달라지는 입력이어야 비교가 의미 있다.
      const stripped = run(store.listSummaries());
      if (doneAt.startsWith("2020")) assert.notDeepEqual(stripped.ended, full.ended, "이력이 판정을 바꾸는 입력");
    }
    assert.ok(home);
  });
}

test("sqlite: 요약을 읽은 뒤 상태가 바뀐 카드도 개별로 이력을 채운다", () => {
  const { store } = setup("sqlite");
  const original = store.listSummaries.bind(store);
  let raced = false;
  store.listSummaries = () => { const rows = original(); if (raced) return rows; raced = true; store.update("r/open", { scope: "읽은 뒤 변경" }, { revision: 2, note: "경쟁 쓰기" }); return rows; };
  const w = store.listWatch().find(c => c.key === "r/open");
  assert.equal(w.history.length, w.revision, "순번이 어긋난 카드는 개별로 다시 읽는다");
});

test("ProgressWatch: 후보로 고른 카드 한 장만 본문을 읽는다", () => {
  const { store } = setup("jsonl");
  const cards = store.listWatch().map(c => ({ ...c, activity: "running", role: ROLE }));
  const seen = new Map([["kadan-" + ROLE, { alive: true, pid: 1, expectedPid: 1, screen: "화면" }]]);
  const entries = cards.map(c => ({ kind: "send", role: ROLE, taskId: c.id }));
  const w = new ProgressWatch();
  w.select({ cards, entries, observations: seen, now: 0, enabled: true });
  const original = fs.readFileSync, reads = [];
  fs.readFileSync = function (file, ...args) { if (String(file).endsWith("/card.md")) reads.push(String(file)); return original.call(this, file, ...args); };
  let out;
  try { out = w.select({ cards, entries, observations: seen, now: 30 * 60_000, enabled: true }); } finally { fs.readFileSync = original; }
  assert.equal(reads.length, 1);
  assert.match(out.input.goal, /^# 본문 /);
  assert.ok(reads[0].endsWith(`/${out.taskId}/card.md`) || reads[0].includes(out.taskId));
});
