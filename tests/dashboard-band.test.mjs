import test from "node:test";
import assert from "node:assert/strict";
import { liveSessions, flowSummary, openAlerts } from "../src/dashboard-band.mjs";

test("살아 있는 담당: 창이 열린 역할만, 시작 기록의 모델·강도를 붙여 역할 이름순", () => {
  const center = {
    runtimeKnown: true,
    roles: [
      { role: "p-작업자", life: { state: "alive", pidState: "match", recordedPid: "41" } },
      { role: "p-검수자", life: { state: "dead" } },
      { role: "p-감독", life: { state: "alive", pidState: "changed" } },
    ],
    models: {
      "p-작업자": { harness: "claude", model: "sonnet", effort: "high", at: "2026-10-05T00:00:00Z" },
      "p-검수자": { harness: "codex", model: "gpt-5", effort: "", at: "2026-10-05T00:00:00Z" },
    },
  };
  assert.deepEqual(liveSessions(center), [
    { role: "p-감독", harness: null, model: null, effort: null, pidState: "changed", recordedPid: null },
    { role: "p-작업자", harness: "claude", model: "sonnet", effort: "high", pidState: "match", recordedPid: "41" },
  ]);
  assert.equal(liveSessions({ ...center, runtimeKnown: false }), null, "세션 상태를 모르면 null");
  assert.equal(liveSessions(null), null);
});

test("흐름 확인: 집계가 unconfirmed인 묶음만 모은다", () => {
  const flows = [
    { id: "a", title: "A", verdict: "pass", label: "최종 검수 통과", warnings: [] },
    { id: "b", title: "B", verdict: "unconfirmed", label: "연결 확인 필요", warnings: ["2라운드의 검수 카드가 연결되지 않았습니다."] },
    { id: "c", title: "C", verdict: "pending", label: "검수 대기" },
  ];
  assert.deepEqual(flowSummary(flows), {
    total: 3,
    unconfirmed: [{ id: "b", title: "B", label: "연결 확인 필요", warnings: ["2라운드의 검수 카드가 연결되지 않았습니다."] }],
  });
  assert.deepEqual(flowSummary(undefined), { total: 0, unconfirmed: [] });
});

test("열린 경보: 같은 id의 마지막 기록이 해소가 아니면 센다. id 없는 옛 기록과 손상 원장은 제외·null", () => {
  const alert = (id, t, extra = {}) => ({ kind: "alert", id, t, alertKind: "정지", level: "warn", role: "p-작업자", session: "kadan-p-작업자", recipient: "p-감독", ...extra });
  const entries = [
    alert("a1", "2026-10-05T00:00:00Z"),
    alert("a1", "2026-10-05T00:05:00Z", { resolved: true }),
    alert("a2", "2026-10-05T00:01:00Z"),
    alert("a3", "2026-10-05T00:02:00Z", { alertKind: "한도" }),
    // 감시기가 해소 기록 없이 닫는 종류: 원장에는 영원히 열린 것으로 남으므로 세지 않는다.
    alert("r1", "2026-10-05T00:02:30Z", { alertKind: "자원" }),
    alert("f1", "2026-10-05T00:02:40Z", { alertKind: "전달실패" }),
    { kind: "alert", t: "2026-10-05T00:03:00Z", alertKind: "옛기록" },
    { kind: "send", t: "2026-10-05T00:04:00Z" },
  ];
  const open = openAlerts(entries);
  assert.equal(open.count, 2);
  assert.deepEqual(open.items.map((a) => [a.id, a.kind]), [["a3", "한도"], ["a2", "정지"]], "최근 것이 먼저");
  assert.equal(open.items[0].recipient, "p-감독");
  assert.equal(openAlerts([...entries, { broken: true }]), null);
  // 화면용 상한은 20건이고 count는 전체다. 슈퍼감독별 묶기는 상한 없이 받는다.
  const many = Array.from({ length: 25 }, (_, i) => alert("m" + i, "2026-10-05T01:" + String(i).padStart(2, "0") + ":00Z"));
  assert.deepEqual([openAlerts(many).count, openAlerts(many).items.length, openAlerts(many, { limit: Infinity }).items.length, openAlerts(many, { limit: 3 }).items.length], [25, 20, 25, 3]);
  assert.equal(openAlerts(null), null);
  assert.deepEqual(openAlerts([]), { count: 0, items: [] });
});

// 담당자 상태 표(sessions)를 전략 맵 옆 칸(status.live)으로 옮겼다(2026-10-25). 두 자료는 모델을 다른 곳에서 읽는다 —
// sessions는 마지막 start 줄, live는 모델이 적힌 가장 최근 start 줄. 옮긴 뒤 '모름'이 늘지 않는지 같은 원장으로 대조한다.
test("살아 있는 담당의 실행 도구·모델·세대가 sessions 표와 같다(모델 모름이 늘지 않는다)", async () => {
  const { buildTree } = await import("../src/cli.mjs");
  const { buildCardCenter } = await import("../src/card-center.mjs");
  const { sessionsData } = await import("../src/dashboard/summary.mjs");
  const t = (n) => new Date(Date.UTC(2026, 9, 25, 0, n)).toISOString();
  const start = (role, panePid, n, cmd) => ({ kind: "start", role, session: `kadan-${role}`, panePid, t: t(n),
    ...(cmd ? { cmd, harness: cmd.split(" ")[0], model: cmd.split("--model ")[1] } : {}) });
  const entries = [
    start("q-작업자", 11, 0, "claude --model sonnet"),
    start("q-검수자", 12, 1, "codex --model gpt-x"),
    start("q-감독", 13, 2, "claude --model opus"),
    start("q-감독", 23, 5), // 모델 없이 다시 띄움(재사용·옛 start)
    start("q-닫힘", 14, 3, "claude --model haiku"),
  ];
  const alive = {
    "kadan-q-작업자": { alive: true, pid: 11 },
    "kadan-q-검수자": { alive: true, pid: 99 },
    "kadan-q-감독": { alive: true, pid: 23 },
  };
  const center = buildCardCenter({ cards: [], entries, tree: buildTree(entries, alive, []) });
  const live = liveSessions(center), sessions = sessionsData({ center }, new URL("http://x/"), {});
  const open = sessions.roles.filter((r) => r.life.state === "alive");
  assert.deepEqual(live.map((s) => s.role), open.map((r) => r.role).sort((a, b) => a.localeCompare(b, "ko")));
  for (const r of open) {
    const s = live.find((x) => x.role === r.role);
    assert.equal(s.recordedPid, r.life.recordedPid, r.role + " 세대");
    assert.equal(s.pidState, r.life.pidState, r.role + " PID 대조");
    if (r.model && r.model !== "모름") {
      assert.equal(s.model, r.model, r.role + " 모델");
      assert.equal(s.harness, r.harness, r.role + " 실행 도구");
    }
  }
  // 알려진 차이: 마지막 start에 모델이 없으면 sessions는 '모름', live는 그 전 start의 모델을 보인다(전략 맵은 모름이 줄어든다).
  assert.equal(open.find((r) => r.role === "q-감독").model, "모름");
  assert.equal(live.find((s) => s.role === "q-감독").model, "opus");
});

// PR #298 검수 F2: 창이 닫힌 담당(열린 카드 있음)과 세션 상태를 모를 때도 옛 표의 실행 도구·모델이 남아야 한다.
// 옛 표(sessions)가 보이던 역할 가운데 전략 맵에 실제로 오르는 모든 역할(카드 없는 감독·슈퍼감독 조상 포함, 수정 2)을
// 실제 지도 계산(buildMap·runLabel)으로 대조한다.
test("닫힌 담당·세션 상태 모름에서도 sessions 표의 실행 도구·모델이 live 또는 lastRuns로 남는다", async () => {
  const { buildTree } = await import("../src/cli.mjs");
  const { buildCardCenter } = await import("../src/card-center.mjs");
  const { sessionsData, lastRuns } = await import("../src/dashboard/summary.mjs");
  const { buildMap, runLabel } = await import("../gui/src/strategy-map.ts");
  const t = (n) => new Date(Date.UTC(2026, 9, 25, 1, n)).toISOString();
  const start = (role, panePid, n, cmd) => ({ kind: "start", role, session: `kadan-${role}`, panePid, t: t(n),
    ...(cmd ? { cmd, harness: cmd.split(" ")[0], model: cmd.split("--model ")[1] } : {}) });
  const card = (role) => ({ id: "c-" + role, key: "r/c-" + role, repo: "r", role, status: "assigned", scope: "local",
    board: "r", at: t(0), history: [], workType: "execution" });
  const send = (role) => ({ kind: "send", role, session: `kadan-${role}`, taskId: "c-" + role, t: t(9) });
  const entries = [
    start("r-열림", 11, 0, "claude --model sonnet"),
    start("r-닫힘", 12, 1, "codex --model model-2"),
    { kind: "stop", role: "r-닫힘", session: "kadan-r-닫힘", t: t(4) },
    start("r-기록만", 13, 2, "codex --model model-3"), // stop 없이 세션만 사라짐
    start("r-끝남", 14, 3, "claude --model haiku"), // 열린 카드 없음·관계표에 없음 → 지도에 안 오름
    start("r-감독", 15, 4, "codex --model model-5"), // 자기 카드 없는 상위 사슬
    start("r-슈퍼", 16, 5, "codex --model model-6"), // 자기 카드 없는 슈퍼감독
    send("r-열림"), send("r-닫힘"), send("r-기록만"),
  ];
  const cards = ["r-열림", "r-닫힘", "r-기록만"].map(card);
  const hierarchy = { "r-슈퍼": "@user", "r-감독": "r-슈퍼", "r-열림": "r-감독", "r-닫힘": "r-감독", "r-기록만": "r-감독" };
  const rows = cards.map((c) => ({ key: c.key, title: c.id, owner: c.role, bucket: "running" }));
  const runtimeKnownOf = (label) => label === "세션 상태 앎";
  const build = (alive, runtimeKnown) =>
    buildCardCenter({ cards, entries, tree: buildTree(entries, alive, cards), runtimeKnown });
  for (const [label, center] of [
    ["세션 상태 앎", build({ "kadan-r-열림": { alive: true, pid: 11 } }, true)],
    ["세션 상태 모름", build({}, false)],
  ]) {
    const sessions = sessionsData({ center }, new URL("http://x/"), {}), live = liveSessions(center) ?? [];
    const runs = lastRuns(center, { hierarchy, alerts: null });
    const map = buildMap({ hierarchy, rows, live: liveSessions(center), alerts: null, lastRuns: runs });
    const units = new Map(map.bases.flatMap((b) => b.units).map((u) => [u.role, u]));
    const checked = [];
    for (const r of sessions.roles) {
      if (!r.model || r.model === "모름") continue;
      const now = live.find((s) => s.role === r.role);
      // 세션 상태를 모르면 옛 표는 모든 역할을 보였다. 새 화면은 지도에 오르는 역할만 보인다.
      if (!units.has(r.role)) continue;
      const got = now ?? runs[r.role];
      assert.ok(got, `${label}: ${r.role}의 실행 기록이 사라짐`);
      assert.equal(got.model, r.model, `${label}: ${r.role} 모델`);
      assert.equal(got.harness, r.harness, `${label}: ${r.role} 실행 도구`);
      assert.ok(runLabel(units.get(r.role)).includes(`${r.harness} · ${r.model}`), `${label}: ${r.role} 옆 칸 문구`);
      checked.push(r.role);
    }
    // 세션 상태를 알면 옛 표도 카드 없는 닫힌 감독·슈퍼감독을 숨겼다. 모르면 옛 표가 보이던 조상까지 대조한다.
    const expected = runtimeKnownOf(label) ? ["r-기록만", "r-닫힘", "r-열림"] : ["r-감독", "r-기록만", "r-닫힘", "r-슈퍼", "r-열림"];
    assert.deepEqual(checked.sort(), expected.sort(), label + ": 지도에 오르는 역할 대조");
    assert.equal(units.size, 5, label + ": 지도 유닛 수(슈퍼·감독·작업자 3)");
    assert.ok(!("r-끝남" in runs), label + ": 지도에 안 오르는 과거 역할은 싣지 않는다");
    assert.deepEqual(runs["r-감독"], { harness: "codex", model: "model-5" }, label + ": 카드 없는 감독");
    assert.deepEqual(runs["r-슈퍼"], { harness: "codex", model: "model-6" }, label + ": 카드 없는 슈퍼감독");
  }
});
