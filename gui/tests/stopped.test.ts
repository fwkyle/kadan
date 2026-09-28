import test from "node:test";
import assert from "node:assert/strict";
import {
  firstLine,
  groupAskText,
  groupStopped,
  shortenTurn,
} from "../src/stopped.ts";
import type { Row } from "../src/types.ts";

const row = (over: Partial<Row> & { key: string }): Row => ({
  kind: "execution",
  repo: "repo",
  revision: 1,
  state: "active",
  stateLabel: "실행",
  healthKind: "attention",
  healthLabel: "세션 확인 필요",
  healthReason: "",
  title: over.key,
  ...over,
});

test("같은 이유로 멈춘 실행은 한 그룹으로 묶고 실패·세션·오래된 순으로 정렬한다", () => {
  const groups = groupStopped([
    row({ key: "b/s1", signalAt: "2026-09-27T06:00:00Z" }),
    row({ key: "b/s2", signalAt: "2026-09-27T10:00:00Z" }),
    row({ key: "b/f1", healthLabel: "실패 확인 필요" }),
    row({ key: "b/old", bucket: "stale", healthLabel: "세션 확인 필요" }),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.key, g.rows.length]),
    [
      ["failed", 1],
      ["session", 2],
      ["stale", 1],
    ],
  );
  const session = groups[1];
  assert.equal(session.firstAt, "2026-09-27T06:00:00.000Z");
  assert.equal(session.lastAt, "2026-09-27T10:00:00.000Z");
});

test("오래된 미정리는 상태 문구가 같아도 세션 그룹과 섞지 않는다", () => {
  const groups = groupStopped([
    row({ key: "b/a" }),
    row({ key: "b/b", bucket: "stale" }),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups.find((g) => g.key === "stale")?.rows[0].key, "b/b");
});

test("알 수 없는 이유는 상태 문구 이름의 그룹으로 남긴다", () => {
  const groups = groupStopped([row({ key: "b/x", healthLabel: "활동 보고 확인" })]);
  assert.equal(groups[0].key, "other:활동 보고 확인");
  assert.equal(groups[0].label, "활동 보고 확인");
});

test("차례 나열은 세 자리까지 그대로, 넷부터 앞 둘과 외 N으로 줄인다", () => {
  assert.deepEqual(shortenTurn("가 · 나 · 중"), { text: "가 · 나 · 중", rest: 0 });
  assert.deepEqual(shortenTurn("가 · 나 · 중 · 다 · 마"), {
    text: "가 · 나 외 3",
    rest: 3,
  });
  assert.deepEqual(shortenTurn(undefined), { text: "", rest: 0 });
});

test("사유는 첫 줄만 보여 주고 길면 줄임표를 붙인다", () => {
  assert.equal(firstLine("짧은 이유\n둘째 줄"), "짧은 이유");
  const long = "가".repeat(100);
  const cut = firstLine(long, 80);
  assert.equal(cut.length, 80);
  assert.ok(cut.endsWith("…"));
});

test("그룹 문의 문장에 건수와 카드 키가 들어간다", () => {
  const [group] = groupStopped([row({ key: "b/s1" }), row({ key: "b/s2" })]);
  const text = groupAskText(group);
  assert.ok(text.includes("2건"));
  assert.ok(text.includes("b/s1") && text.includes("b/s2"));
});
