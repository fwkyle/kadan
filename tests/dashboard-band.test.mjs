import test from "node:test";
import assert from "node:assert/strict";
import { liveSessions, flowSummary, openAlerts } from "../src/dashboard-band.mjs";

test("살아 있는 담당: 창이 열린 역할만, 시작 기록의 모델·강도를 붙여 역할 이름순", () => {
  const center = {
    runtimeKnown: true,
    roles: [
      { role: "p-작업자", life: { state: "alive", pidState: "match" } },
      { role: "p-검수자", life: { state: "dead" } },
      { role: "p-감독", life: { state: "alive", pidState: "changed" } },
    ],
    models: {
      "p-작업자": { harness: "claude", model: "sonnet", effort: "high", at: "2026-10-05T00:00:00Z" },
      "p-검수자": { harness: "codex", model: "gpt-5", effort: "", at: "2026-10-05T00:00:00Z" },
    },
  };
  assert.deepEqual(liveSessions(center), [
    { role: "p-감독", harness: null, model: null, effort: null, pidState: "changed" },
    { role: "p-작업자", harness: "claude", model: "sonnet", effort: "high", pidState: "match" },
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
  assert.equal(openAlerts(null), null);
  assert.deepEqual(openAlerts([]), { count: 0, items: [] });
});
