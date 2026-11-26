import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { keepsNotice, saveNotice } from "../src/save-notice.ts";

const failed = (count: number, reason = "마감 뒤 업무가 다시 열려 닫지 않음") =>
  Array.from({ length: count }, (_, i) => ({ key: `repo/exec-${i}`, reason }));

test("닫기 실패가 없으면 예전 문구 그대로이고 알림은 시간이 지나면 사라진다", () => {
  for (const result of [{ key: "work:repo/w", revision: 2 }, { cardClose: { closed: 3, failed: [] } }]) {
    assert.equal(saveNotice(result), "저장했습니다.");
    assert.equal(keepsNotice(saveNotice(result)), false);
  }
});

test("닫기 실패가 있으면 업무는 저장됐다고 알리고 실패 수·키·이유를 적는다", () => {
  const text = saveNotice({ cardClose: { closed: 1, failed: [
    { key: "repo/exec-a", reason: "새 기록" }, { key: "repo/exec-b", reason: "다시 열림" },
    { key: "repo/exec-c", reason: "새 기록" }] } });
  assert.equal(text, "업무는 저장했습니다. 실행 카드 닫기 실패 3장: repo/exec-a, repo/exec-c (새 기록) / "
    + "repo/exec-b (다시 열림). 이유를 확인한 뒤 카드를 정리하세요.");
  assert.equal(keepsNotice(text), true);
});

test("많으면 앞 10장의 키만 적고 전체 수와 나머지 수를 적는다", () => {
  const text = saveNotice({ cardClose: { closed: 0, failed: failed(12) } });
  assert.match(text, /닫기 실패 12장: /);
  assert.ok(text.includes("repo/exec-9 ("), text);
  assert.ok(!text.includes("repo/exec-10"), text);
  assert.match(text, / 외 2장\. /);
});

test("저장 폼은 이 문구를 알리고, 알림 창은 닫기 실패 안내를 시간 제한으로 지우지 않는다", () => {
  const read = (file: string) => fs.readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  assert.ok(read("ui.tsx").includes("context.notice(saveNotice(result.result));"));
  assert.ok(read("App.tsx").includes("if (!notice || keepsNotice(notice)) return;"));
});
