import "./helpers/isolated-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { superProfiles, isSuperRole, nearestSuper } from "../src/super-role.mjs";
import { supervisorSummary } from "../src/dashboard-band.mjs";
import { isPeerSuperMail } from "../src/peer-mail.mjs";
import { askRecipient } from "../src/center-wall.mjs";
import { dashboardFixture } from "./helpers/dashboard-fixture.mjs";
import { appendLedger } from "../src/ledger.mjs";

const start = (role, roleProfile, extra = {}) => ({ kind: "start", role, session: `kadan-${role}`, ...(roleProfile ? { roleProfile } : {}), ...extra });

test("프로필 기록이 있으면 위치와 무관하게 프로필이 이긴다 — 상위가 비서여도 super면 슈퍼감독", () => {
  const parents = new Map(Object.entries({ "kadan-슈퍼감독": "비서", "비서": "@user", "kadan-감독": "@user", "kadan-작업자": "kadan-감독" }));
  const profiles = superProfiles([start("kadan-슈퍼감독", "super"), start("kadan-감독", "conductor"), start("비서", "secretary")]);
  assert.equal(isSuperRole("kadan-슈퍼감독", parents, profiles), true);
  assert.equal(isSuperRole("kadan-감독", parents, profiles), false, "상위가 @user여도 프로필이 conductor면 슈퍼감독이 아니다");
  assert.equal(isSuperRole("비서", parents, profiles), false);
});

test("프로필 기록이 하나도 없는 옛 역할만 상위가 @user일 때 슈퍼감독(호환). 가장 최근 프로필 기록이 이긴다", () => {
  const parents = new Map(Object.entries({ "옛슈퍼": "@user", "옛감독": "옛슈퍼" }));
  const profiles = superProfiles([start("옛슈퍼"), start("옛감독", null, { session: "kadan-옛감독", role: undefined })]);
  assert.equal(isSuperRole("옛슈퍼", parents, profiles), true);
  assert.equal(isSuperRole("옛감독", parents, profiles), false);
  const later = superProfiles([start("x", "super"), start("x"), start("x", "worker")]);
  assert.equal(later.get("x"), "worker", "프로필 없는 start는 건너뛰고 기록 있는 가장 최근 것");
  assert.equal(isSuperRole("옛슈퍼", parents, null), true, "원장을 못 읽어 프로필을 모르면 예전 기준");
});

test("session만 있는 옛 start도 같은 역할 이름으로 읽는다", () => {
  const profiles = superProfiles([{ kind: "start", session: "kadan-옛역할", roleProfile: "super" }]);
  assert.equal(profiles.get("옛역할"), "super");
});

test("3단 사슬: 총괄 super → 레포 super → 감독 → 작업자는 가장 가까운 슈퍼감독으로 묶는다", () => {
  const parents = new Map(Object.entries({ "총괄": "@user", "레포슈퍼": "총괄", "감독": "레포슈퍼", "작업자": "감독" }));
  const profiles = superProfiles([start("총괄", "super"), start("레포슈퍼", "super"), start("감독", "conductor"), start("작업자", "worker")]);
  assert.equal(nearestSuper("작업자", parents, profiles), "레포슈퍼");
  assert.equal(nearestSuper("레포슈퍼", parents, profiles), "레포슈퍼", "자기 자신부터");
  assert.equal(nearestSuper("총괄", parents, profiles), "총괄");
  assert.equal(nearestSuper("없는", parents, profiles), null);
  assert.equal(nearestSuper("a", new Map([["a", "b"], ["b", "a"]]), profiles), null, "순환이면 null");
  const rows = [{ owner: "작업자", repo: "r", bucket: "running" }, { owner: "감독", repo: "r", bucket: "stuck" }, { owner: "총괄", repo: "t", bucket: "running" }];
  const summary = supervisorSummary({ hierarchy: Object.fromEntries(parents), rows, profiles });
  assert.deepEqual(summary.items.map(s => [s.super, s.running, s.stuck]), [["레포슈퍼", 1, 1], ["총괄", 1, 0]], "각 행은 한 번만 센다");
  assert.equal(summary.unassigned, 0);
});

test("슈퍼 간 우편은 프로필 기준이다 — 상위가 비서인 super끼리도 동료", () => {
  const parents = new Map(Object.entries({ "a-슈퍼": "비서", "b-슈퍼": "@user", "비서": "@user", "a-감독": "a-슈퍼" }));
  const entries = [start("a-슈퍼", "super"), start("b-슈퍼", "super"), start("a-감독", "conductor")];
  assert.equal(isPeerSuperMail(entries, parents, "a-슈퍼", "b-슈퍼"), true);
  assert.equal(isPeerSuperMail(entries, parents, "a-감독", "b-슈퍼"), false);
  assert.equal(isPeerSuperMail([], new Map(Object.entries({ x: "@user", y: "@user" })), "x", "y"), true, "프로필 기록이 없으면 위치 기준(호환)");
});

test("대시보드 질문 수신자는 가장 가까운 슈퍼감독, 없으면 비서", () => {
  const table = { "총괄": "@user", "레포슈퍼": "총괄", "작업자": "레포슈퍼", "떠돌이": "@user" };
  const profiles = superProfiles([start("총괄", "super"), start("레포슈퍼", "super"), start("떠돌이", "worker")]);
  assert.equal(askRecipient("작업자", table, profiles), "레포슈퍼");
  assert.equal(askRecipient("떠돌이", table, profiles), "비서");
});

test("status?super=: 상위가 비서인 super → 200, 프로필 없는 역할 → 400(새 문구), 총괄은 전부·레포슈퍼는 그 아래만", async (t) => {
  const f = dashboardFixture({ mode: "jsonl" });
  t.after(() => f.server.close());
  await new Promise((resolve) => f.server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + f.server.address().port;
  const file = path.join(f.home, "hierarchy.json");
  fs.writeFileSync(file, JSON.stringify({
    "비서": "@user", "kadan-슈퍼감독": "비서", "총괄": "@user", "레포슈퍼": "총괄", "감독": "레포슈퍼", "작업자": "감독", "평범": "총괄",
  }));
  appendLedger({ kind: "hierarchy-loaded", path: file, by: "watch", t: new Date().toISOString() }, f.home);
  for (const [role, profile] of [["비서", "secretary"], ["kadan-슈퍼감독", "super"], ["총괄", "super"], ["레포슈퍼", "super"], ["감독", "conductor"], ["작업자", "worker"], ["평범", "worker"]])
    appendLedger({ kind: "start", role, session: `kadan-${role}`, roleProfile: profile, by: "사람", t: new Date().toISOString() }, f.home);
  const get = async (q) => fetch(base + "/api/dashboard/status" + q);
  const own = await get("?super=kadan-슈퍼감독");
  assert.equal(own.status, 200, await own.clone().text());
  assert.equal((await own.json()).super, "kadan-슈퍼감독");
  const plain = await get("?super=평범");
  assert.equal(plain.status, 400);
  assert.match(await plain.text(), /슈퍼감독\(--profile super\)으로 시작한 역할이 아님: 평범/);
  assert.equal((await get("?super=비서")).status, 400, "비서는 슈퍼감독이 아니다");
  const all = await (await get("?super=총괄")).json(), sub = await (await get("?super=레포슈퍼")).json();
  assert.equal(all.supervisor.super, "총괄");
  assert.equal(sub.supervisor.super, "레포슈퍼");
  const body = await (await get("")).json();
  assert.deepEqual([body.previousGeneration.works, body.previousGeneration.executions], [0, 0], "이전 세대 업무 건수 칸(관계표를 알면 숫자)");
  assert.ok("previousGeneration" in sub);
  const summary = body.supervisors.items.map(s => s.super);
  assert.deepEqual(summary, ["레포슈퍼", "총괄", "kadan-슈퍼감독"], "요약은 프로필 기준 슈퍼감독들");
});
