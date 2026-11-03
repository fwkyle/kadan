import "./helpers/isolated-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { dashboardFixture } from "./helpers/dashboard-fixture.mjs";
import { dashboardData } from "../src/dashboard-api.mjs";
import { frontStrip, repoOfKey, UNKNOWN_REPO } from "../src/dashboard/front.mjs";

// PR1 첫 화면 '내 앞' 띠와 status 응답의 끝난 워크 제거.
const dec = (over) => ({ id: "d", status: "open", to: "@user", requestedBy: "슈퍼감독", question: "질문\n둘째 줄", ...over });

test("저장소 묶기: 키 첫 마디, work: 접두어 제거, 없으면 저장소 모름", () => {
  assert.equal(repoOfKey("rottie/card-1"), "rottie");
  assert.equal(repoOfKey("work:kadan/work-x"), "kadan");
  for (const bad of [null, undefined, "", "card-only", "/x"]) assert.equal(repoOfKey(bad), UNKNOWN_REPO);
});

test("내 앞 띠: 결정·머지 요청·막힘을 저장소별로 센다", () => {
  const out = frontStrip({
    decisions: [
      dec({ id: "a", card: "demo_app/c1" }),
      dec({ id: "b", card: "rottie/c2", question: "머지? https://github.com/o/rottie/pull/113" }),
      dec({ id: "c", card: null, work: "rottie/work-1" }),
      dec({ id: "x", card: "rottie/c9", status: "answered" }),
    ],
    stoppedRows: [{ key: "rottie/c3", repo: "rottie" }, { key: "nokey" }],
  });
  const by = Object.fromEntries(out.repos.map((r) => [r.repo, r]));
  assert.deepEqual(by.rottie, { repo: "rottie", decisions: 1, merges: 1, stuck: 1 });
  assert.deepEqual(by.demo_app, { repo: "demo_app", decisions: 1, merges: 0, stuck: 0 });
  assert.deepEqual(by[UNKNOWN_REPO], { repo: UNKNOWN_REPO, decisions: 0, merges: 0, stuck: 1 });
  assert.equal(out.decisions.length, 3, "닫힌 결정은 싣지 않는다");
  assert.equal(out.decisions.find((d) => d.id === "a").title, "질문", "첫 줄만");
  assert.equal(out.decisions.find((d) => d.id === "b").merge, true);
});

test("결정 0건·결정 읽기 실패에서도 깨지지 않는다", () => {
  assert.deepEqual(frontStrip({ decisions: [], stoppedRows: [] }), { repos: [], decisions: [] });
  assert.deepEqual(frontStrip({ decisions: null, stoppedRows: [] }), { repos: [], decisions: null });
  // 결정 조회 실패: 막힌 저장소 줄의 결정·머지는 0이 아니라 null(모름)
  const failed = frontStrip({ decisions: null, stoppedRows: [{ key: "rottie/c3", repo: "rottie" }] });
  assert.deepEqual(failed.repos, [{ repo: "rottie", decisions: null, merges: null, stuck: 1 }]);
  assert.equal(failed.decisions, null);
});

test("status 응답: 끝난 워크 본문은 건수만, ?works=all이면 본문, front가 실린다", () => {
  const f = dashboardFixture({ count: 2 });
  const second = f.works.create({ key: "demo/finished", title: "끝난 업무", goal: "g", scope: "s", acceptance: "a",
    owner: "감독", repoPath: f.home, board: "검증판" });
  f.works.change(second.key, "complete", { result: "끝남" }, { revision: second.revision, by: "사람", note: "시험" });
  const snapshot = f.snapshot();
  const get = (query = "") => dashboardData(snapshot, new URL("http://local/api/dashboard/status" + query));
  const slim = get(), all = get("?works=all");
  assert.ok(!slim.works.some((w) => w.state === "done"), "끝난 워크 본문 없음");
  assert.deepEqual([slim.endedWorks.done, slim.endedWorks.total, slim.endedWorks.included], [1, 1, false]);
  assert.ok(all.works.some((w) => w.state === "done") && all.endedWorks.included === true);
  assert.ok(slim.works.some((w) => w.state === "running"), "열린 워크는 그대로");
  const demo = slim.front.repos.find((r) => r.repo === "demo");
  assert.equal(demo.decisions, 2);
  assert.equal(slim.front.decisions.length, 2);
  // ?super= 응답 모양은 바뀌지 않는다(front·endedWorks 없음).
  f.server.close();
});
