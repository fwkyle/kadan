import "./helpers/isolated-home.mjs";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { dashboardFixture } from "./helpers/dashboard-fixture.mjs";
import { appendLedger } from "../src/ledger.mjs";
import { dashboardData } from "../src/dashboard-api.mjs";
import { sidebarRepos, alertsOfRepo, answeredMergesToday } from "../src/dashboard/repo-view.mjs";
import { UNKNOWN_REPO } from "../src/dashboard/front.mjs";

// PR2 왼쪽 사이드 탭: ?repo= 거르기, ?super= 우선, 사이드 탭 재료, 칸반 기본 묶음.
const ask = (question) => ({ question, options: ["예", "아니오"], recommendation: "예", reason: "시험\n- 확인 경로 없음: 합성 데이터" });

function twoRepos() {
  const f = dashboardFixture({ count: 2 });
  f.cards.create({ repo: "other", id: "o-1", repoPath: f.home, title: "다른 저장소 카드", body: "# 목표\n\n## 완료 조건\n확인", by: "사람" });
  f.decisions.request("other/o-1", ask("머지할까요? https://github.com/o/other/pull/7"), "슈퍼감독");
  f.decisions.request("other/o-1", ask("방향을 정할까요?"), "슈퍼감독");
  return f;
}
const get = (f, path) => dashboardData(f.snapshot(), new URL("http://local/api/dashboard/" + path));

test("사이드 탭 재료: 저장소 합집합과 결정·머지 수, 거르기와 무관하게 전체", () => {
  const f = twoRepos();
  try {
    const all = get(f, "status"), one = get(f, "status?repo=other");
    const by = Object.fromEntries(all.sidebar.map((r) => [r.repo, r]));
    assert.deepEqual([by.demo.decisions, by.demo.merges], [2, 0]);
    assert.deepEqual([by.other.decisions, by.other.merges], [1, 1]);
    assert.equal(all.repo, null);
    assert.deepEqual(one.sidebar, all.sidebar, "저장소를 골라도 목록은 전체");
    assert.equal(one.repo, "other");
  } finally { f.server.close(); }
});

test("?repo= 거르기: 행·워크·결정·front가 그 저장소만, 저장소 모름도 거른다", () => {
  const f = twoRepos();
  try {
    const one = get(f, "status?repo=other");
    assert.ok(one.rows.every((r) => r.repo === "other") && one.rows.length === 1);
    assert.ok(one.works.every((w) => (w.repo || "other") === "other"));
    assert.equal(one.decisions.length, 2);
    assert.deepEqual(one.front.repos.map((r) => r.repo), ["other"]);
    assert.equal(one.front.decisions.filter((d) => d.merge).length, 1);
    const demo = get(f, "status?repo=demo");
    assert.equal(demo.decisions.length, 2);
    assert.ok(demo.rows.length > 0 && demo.rows.every((r) => r.repo === "demo"));
    const unknown = get(f, "status?repo=" + encodeURIComponent(UNKNOWN_REPO));
    assert.equal(unknown.rows.length, 0);
    assert.equal(unknown.decisions.length, 0);
    // 거르면 응답이 작아진다.
    assert.ok(JSON.stringify(one).length < JSON.stringify(get(f, "status")).length);
  } finally { f.server.close(); }
});

test("?super=와 ?repo=가 함께 오면 ?super=가 이기고 ?repo=는 무시된다", () => {
  const f = twoRepos();
  try {
    const file = path.join(f.home, "hierarchy.json");
    fs.writeFileSync(file, JSON.stringify({ "작업자": "qa-슈퍼감독", "qa-슈퍼감독": "@user" }));
    appendLedger({ kind: "hierarchy-loaded", path: file, by: "watch", t: new Date().toISOString() }, f.home);
    const only = get(f, "status?super=qa-슈퍼감독");
    const both = get(f, "status?super=qa-슈퍼감독&repo=other");
    const strip = ({ collectedAt, ...rest }) => rest;
    assert.deepEqual(strip(both), strip(only), "repo가 super 응답을 바꾸지 않는다");
    assert.ok(!("sidebar" in both) && !("front" in both), "?super= 응답 모양은 그대로");
  } finally { f.server.close(); }
});

test("repo-view 함수: 모름 결정, 경보 거르기, 오늘 머지 근거", () => {
  const rows = [{ key: "a/1", repo: "a" }, { key: "x", repo: "" }];
  assert.deepEqual(sidebarRepos({ rows, decisions: null, supervisors: null }).map((r) => [r.repo, r.decisions, r.merges, r.super]),
    [["a", null, null, null], [UNKNOWN_REPO, null, null, null]]);
  const supervisors = { items: [{ super: "슈퍼A", repos: ["a"] }, { super: "슈퍼B", repos: ["a"] }] };
  assert.equal(sidebarRepos({ rows, decisions: [], supervisors })[0].super, "슈퍼A, 슈퍼B");
  const alerts = { count: 3, items: [{ role: "r1", recipient: "p" }, { role: "r2", recipient: "q" }, { role: "r3", recipient: "r1" }] };
  assert.equal(alertsOfRepo(alerts, new Set(["r1"])).count, 2);
  assert.equal(alertsOfRepo(null, new Set()), null);
  const now = Date.parse("2026-11-03T12:00:00+09:00");
  const dec = (id, at, over = {}) => ({ id, status: "answered", to: "@user", card: "a/1", question: "https://github.com/o/a/pull/5", answer: { at }, ...over });
  const got = answeredMergesToday([dec("m1", new Date(now - 60_000).toISOString()), dec("m2", "2020-01-01T00:00:00Z"), dec("m3", new Date(now).toISOString(), { card: "b/1" })], "a", now);
  assert.deepEqual(got.map((x) => x.id), ["m1"]);
  assert.equal(answeredMergesToday(null, "a", now), null);
});

test("칸반: 기본은 프로젝트별, ?group=owner는 감독별, ?repo=는 그 저장소 판만", () => {
  const f = twoRepos();
  try {
    const def = get(f, "kanban");
    assert.equal(def.group, "project");
    assert.deepEqual(def.boards.map((b) => b.label).sort(), ["demo", "other"]);
    assert.equal(get(f, "kanban?group=project").group, "project", "옛 주소도 프로젝트별");
    assert.equal(get(f, "kanban?group=owner").group, "owner");
    const one = get(f, "kanban?repo=other");
    assert.deepEqual(one.boards.map((b) => b.label), ["other"]);
    assert.equal(one.repo, "other");
  } finally { f.server.close(); }
});
