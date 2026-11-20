import test from "node:test";
import assert from "node:assert/strict";
import { buildTree } from "../src/cli-tree.mjs";
import { launchOrigin } from "../src/cli-family.mjs";
import { liveSessions } from "../src/dashboard-band.mjs";

// 실행 모델 설정 화면의 '값의 출처'가 쓰는 재료: 살아 있는 세션마다 역할 프로필과 떠 있는 방식.
// 새 원장 조회 없이 start 사건에 이미 적힌 칸만 읽는다(src/cli-family.mjs launchOrigin).
const at = (n) => `2026-11-20T01:0${n}:00Z`;
const start = (role, extra, n = 0, pid = 100 + n) => ({
  kind: "start", role, session: `kadan-${role}`, t: at(n), panePid: pid, harness: "claude", model: "m", roleProfile: "worker", ...extra,
});

test("launchOrigin: 설정·대체 번호·덮어쓰기·검수 지정·다시 열기·기록 없음을 가른다", () => {
  assert.equal(launchOrigin(null), null);
  assert.deepEqual(launchOrigin(start("a", { launchSource: "settings" })), { source: "settings" });
  assert.deepEqual(launchOrigin(start("a", { launchSource: "fallback", fallbackIndex: 1 })), { source: "fallback", fallbackIndex: 1 });
  assert.deepEqual(launchOrigin(start("a", { launchSource: "override", overrideReason: "x" })), { source: "override" });
  assert.deepEqual(launchOrigin(start("a", { launchSource: "review-for", fallbackIndex: 2 })), { source: "review-for", fallbackIndex: 2 });
  assert.deepEqual(launchOrigin(start("a", {})), { source: "unknown" });
  // 재시작·다시 열기·복원은 launchSource가 없거나 앞 세대 것이다: '다시 띄움'으로 따로 센다. 어려운 일 표시는 이어진다.
  assert.deepEqual(launchOrigin(start("a", { restartOf: "x", difficulty: "hard" })), { source: "resume", hard: true });
  assert.deepEqual(launchOrigin(start("a", { reopenOf: "x", launchSource: "settings" })), { source: "resume" });
  assert.deepEqual(launchOrigin(start("a", { launchSource: "settings", difficulty: "hard" })), { source: "settings", hard: true });
});

test("liveSessions: 살아 있는 세션만, 프로필과 떠 있는 방식을 싣는다(꺼진 세션·재사용 start는 원래 세대 기준)", () => {
  const entries = [
    start("설정-작업자", { launchSource: "settings" }, 0, 11),
    start("대체-작업자", { launchSource: "fallback", fallbackIndex: 1 }, 1, 12),
    start("덮어쓰기-검수자", { roleProfile: "reviewer", launchSource: "override" }, 2, 13),
    start("꺼진-작업자", { launchSource: "settings" }, 3, 14),
    { kind: "stop", role: "꺼진-작업자", session: "kadan-꺼진-작업자", t: at(4) },
    // 설정으로 띄운 세션을 나중에 같은 이름으로 다시 start(이미 살아 있어 재사용): 원래 세대의 출처가 남아야 한다.
    start("설정-작업자", { launchSource: "settings", reuseOf: "digest" }, 5, 11),
    start("대체-작업자", { launchSource: "settings", reuseOf: "digest" }, 6, 12),
  ];
  const alive = {
    "kadan-설정-작업자": { alive: true, pid: 11 },
    "kadan-대체-작업자": { alive: true, pid: 12 },
    "kadan-덮어쓰기-검수자": { alive: true, pid: 13 },
  };
  const roles = buildTree(entries, alive).flatMap((board) => board.roles);
  const live = liveSessions({ runtimeKnown: true, models: {}, roles });
  assert.deepEqual(live.map((s) => [s.role, s.profile, s.launch, s.pidState]), [
    ["대체-작업자", "worker", { source: "fallback", fallbackIndex: 1 }, "match"],
    ["덮어쓰기-검수자", "reviewer", { source: "override" }, "match"],
    ["설정-작업자", "worker", { source: "settings" }, "match"],
  ]);
  assert.equal(liveSessions({ runtimeKnown: false, roles }), null, "세션 상태를 모르면 세지 않는다");
});
