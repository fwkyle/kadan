import test from "node:test";
import assert from "node:assert/strict";
import { canSave, cardHint, changesOf, confirmText, euro, fieldsOf, forgetSaved, initialForm, rememberSaved, savedNote } from "../src/night-form.ts";
import type { NightLine } from "../src/night-repos.ts";

const mk = (settings: NightLine["settings"], effective: NightLine["effective"]): NightLine =>
  ({ github: "o/a", repo: "a", settings, effective, verdict: { action: "merge", reason: "allowed" } });
const fromDoc = mk({ deployBranch: null, nightMerge: null },
  { deployBranch: { value: "main", from: "ontology" }, nightMerge: { value: "금지", from: "ontology" } });
const own = mk({ deployBranch: "dev", nightMerge: "허용" },
  { deployBranch: { value: "dev", from: "kadan" }, nightMerge: { value: "허용", from: "kadan" } });

test("초기값은 카단 설정이다: 연결 문서 값으로 채우지 않는다", () => {
  assert.deepEqual(initialForm(fromDoc), { deploy: "", merge: "" });
  assert.deepEqual(initialForm(own), { deploy: "dev", merge: "허용" });
  assert.deepEqual(cardHint(fromDoc, "deployBranch"), "연결 문서 값: main");
  assert.equal(cardHint(own, "deployBranch"), null);
});

test("값이 바뀔 때만 저장 가능, 나이트런 중 자동 머지를 건드리지 않으면 그 칸을 보내지 않는다", () => {
  assert.equal(canSave(changesOf(own, initialForm(own))), false);
  const c = changesOf(own, { deploy: "release", merge: "허용" });
  assert.deepEqual(c, { deployBranch: "release" });
  assert.deepEqual(fieldsOf(own, c), { repo: "o/a", deployBranch: "release" });
  assert.equal("nightMerge" in fieldsOf(own, c), false);
  assert.equal(canSave(changesOf(fromDoc, { deploy: "", merge: "" })), false);
  assert.deepEqual(changesOf(fromDoc, { deploy: "", merge: "허용" }), { nightMerge: "허용" });
});

test("빈 칸은 유지(보내지 않음), 잘못된 브랜치 이름은 저장 불가", () => {
  assert.deepEqual(changesOf(own, { deploy: "  ", merge: "" }), {});
  assert.equal(canSave({ deployBranch: "a b" }), false);
  assert.equal(canSave({ deployBranch: "없음" }), true);
});

test("확인 줄: 바뀌는 칸만, 비어 있던 칸을 채우면 덮어씀 안내", () => {
  assert.equal(confirmText(own, { deployBranch: "release" }), "o/a: 배포 브랜치 dev→release로 바꿉니다");
  const t = confirmText(fromDoc, { nightMerge: "허용" });
  assert.match(t, /나이트런 중 자동 머지 카단 설정 없음→허용/);
  assert.match(t, /카단 설정으로 덮어씀 → 연결 문서 값\(금지\)보다 우선/);
  assert.doesNotMatch(t, /배포 브랜치/);
});

test("확인 줄 조사: 받침 있으면 으로, 없음·ㄹ받침·한글 아님은 로", () => {
  assert.equal(confirmText(fromDoc, { nightMerge: "허용" }).includes("허용으로 바꿉니다"), true);
  assert.equal(confirmText(fromDoc, { nightMerge: "금지" }).includes("금지로 바꿉니다"), true);
  assert.equal(confirmText(own, { deployBranch: "main" }).includes("main로 바꿉니다"), true);
  assert.equal(confirmText(own, { deployBranch: "없음" }).includes("없음으로 바꿉니다"), true);
  assert.equal(euro("달"), "로");
});

test("저장 성공 기록: 줄별로 남고, 편집하면 사라진다", () => {
  rememberSaved("o/zz", new Date(2026, 10, 4, 9, 5));
  assert.equal(savedNote("o/zz"), "저장했습니다 · 09:05");
  assert.equal(savedNote("o/other"), null);
  forgetSaved("o/zz");
  assert.equal(savedNote("o/zz"), null);
});
