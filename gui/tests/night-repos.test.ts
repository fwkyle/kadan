import test from "node:test";
import assert from "node:assert/strict";
import { badgeOf, badgeTitle, groupByRepo, headFacts, sidebarBadge, type NightLine } from "../src/night-repos.ts";

const eff = { deployBranch: { value: null, from: null }, nightMerge: { value: null, from: null } };
const line = (github: string, repo: string | null, verdict: NightLine["verdict"], effective = eff): NightLine => ({ github, repo, effective, verdict });
const allowed = { action: "merge", reason: "allowed" };
const except = { action: "merge", reason: "deploy-branch", exceptBranch: "main" };
const forbidden = { action: "hold", reason: "night-merge-forbidden" };
const setup = { action: "hold", reason: "setup-needed", detail: "deploy_branch 값이 없음" };

test("뱃지 4종 문구: 함 / 안 함(배포 브랜치) / 금지 / 설정 필요(+이유)", () => {
  assert.deepEqual(badgeOf(line("o/a", "a", allowed)), { kind: "allow", text: "함", detail: null });
  assert.equal(badgeOf(line("o/a", "a", { ...allowed, exceptBranch: "main" })).text, "안 함(배포 브랜치 main)");
  assert.equal(badgeOf(line("o/a", "a", forbidden)).text, "금지");
  const s = badgeOf(line("o/a", "a", setup));
  assert.equal(s.text, "설정 필요");
  assert.equal(s.detail, "deploy_branch 값이 없음");
});

test("모르는 판정은 '함'으로 꾸미지 않는다", () => {
  assert.equal(badgeOf(line("o/a", "a", { action: "merge", reason: "something-new" })).kind, "unknown");
  assert.equal(badgeOf(line("o/a", "a", { action: "merge", reason: "" })).text, "판정 모름");
});

test("나이트런 켜짐/꺼짐/모름 설명: 글자는 그대로, 설명만 다르다", () => {
  const badge = badgeOf(line("o/a", "a", forbidden));
  assert.equal(badgeTitle(true, badge), "나이트런 켜짐 · 자동 머지: 금지");
  assert.equal(badgeTitle(false, badge), "나이트런 꺼짐 · 켜지면 자동 머지: 금지");
  assert.equal(badgeTitle(null, badge), "나이트런 상태 모름 · 켜지면 자동 머지: 금지");
  assert.ok(!/밤 머지/.test(badgeTitle(true, badge)));
});

test("저장소 조인: repo 이름이 대소문자까지 같을 때만. Rottie와 rottie는 합치지 않는다", () => {
  const lines = [line("o/rottie", "rottie", allowed), line("o/Rottie", "Rottie", forbidden), line("o/none", null, setup), line("o/zzz", "zzz", setup)];
  const { byRepo, orphans } = groupByRepo(lines, ["rottie", "kadan"]);
  assert.deepEqual([...byRepo.keys()], ["rottie"]);
  assert.equal(byRepo.get("rottie")![0].github, "o/rottie");
  assert.deepEqual(orphans.map((l) => l.github), ["o/Rottie", "o/none", "o/zzz"]);
});

test("우산 저장소: 모두 같으면 '문구 N개', 다르면 '섞임', 하나면 그 문구, 없으면 null", () => {
  const three = (v: NightLine["verdict"][]) => v.map((x, i) => line(`o/m${i}`, "umbrella_demo", x));
  assert.equal(sidebarBadge(three([forbidden, forbidden, forbidden]))!.text, "금지 3개");
  const mixed = sidebarBadge(three([forbidden, allowed, setup]))!;
  assert.equal(mixed.text, "섞임");
  assert.equal(mixed.detail, "금지 · 함 · 설정 필요");
  assert.equal(sidebarBadge(three([setup]))!.text, "설정 필요");
  assert.equal(sidebarBadge([]), null);
});

test("머리 줄 값: 출처 한글 표시, nightMerge가 null이면 기본 허용", () => {
  const facts = headFacts(line("o/a", "a", allowed, { deployBranch: { value: "main", from: "kadan" }, nightMerge: { value: null, from: null } }));
  assert.deepEqual(facts, { deploy: "main", deployFrom: "카단 설정", policy: "기본 허용", policyFrom: null });
  const card = headFacts(line("o/a", "a", forbidden, { deployBranch: { value: null, from: null }, nightMerge: { value: "금지", from: "card" } }));
  assert.equal(card.deploy, "정해지지 않음");
  assert.equal(card.deployFrom, "없음");
  assert.equal(card.policyFrom, "연결 문서");
});
