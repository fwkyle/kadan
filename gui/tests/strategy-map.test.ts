import test from "node:test";
import assert from "node:assert/strict";
import { askRecipient, buildMap, lifeLabel, recipientGone, restartGeneration, runLabel, STATE_LABEL, systemSessions, visibleUnits } from "../src/strategy-map.ts";
import type { Row } from "../src/types.ts";

const row = (key: string, owner: string, bucket: string) => ({ key, owner, bucket, title: key }) as unknown as Row;
const hierarchy = {
  "m-슈퍼감독": "@user", "m-감독": "m-슈퍼감독", "m-작업자": "m-감독", "m-검수자": "m-감독", "m-옛작업자": "m-감독",
  "비서": "@user", "고아": "없는-감독",
};
const live = [
  { role: "m-슈퍼감독", harness: "claude", model: "opus", effort: null, pidState: "match" },
  { role: "m-감독", harness: "claude", model: "sonnet", effort: null, pidState: "match" },
  { role: "m-검수자", harness: "codex", model: "gpt", effort: null, pidState: "match" },
  { role: "떠돌이", harness: "claude", model: "haiku", effort: null, pidState: "match" },
];
const rows = [
  row("r/1", "m-작업자", "running"), row("r/2", "m-작업자", "stale"), row("r/3", "m-검수자", "running"),
  row("r/4", "", "planned"), row("r/5", "", "hold"), row("r/6", "고아", "running"),
];

test("슈퍼감독마다 기지 하나, 사슬이 끊긴 역할은 '관계표 밖', 담당 없는 실행은 창고 수로만", () => {
  const map = buildMap({ hierarchy, rows, live, alerts: null });
  assert.deepEqual(map.bases.map((b) => b.id), ["m-슈퍼감독", "비서", "관계표 밖"]);
  assert.equal(map.depot, 2);
  assert.deepEqual(map.depotRows.map((r) => r.key), ["r/4", "r/5"], "창고를 누르면 볼 실행");
  const m = map.bases[0];
  assert.deepEqual(m.units.map((u) => [u.role, u.kind]), [
    ["m-슈퍼감독", "super"], ["m-감독", "director"], ["m-검수자", "worker"], ["m-작업자", "worker"],
  ], "일·창·경보가 없는 옛 역할(m-옛작업자)은 올리지 않는다");
  assert.deepEqual(map.bases[2].units.map((u) => u.role).sort(), ["고아", "떠돌이"]);
});

test("유닛 상태 우선순위: 세션 사라짐 > 막힘 > 작업 중 > 결과 대기 > 대기, stop 기록 없는 슈퍼감독은 세션이 없으면 일이 없어도 세션 사라짐", () => {
  const map = buildMap({ hierarchy, rows, live, alerts: null });
  const unit = (role: string) => map.bases.flatMap((b) => b.units).find((u) => u.role === role)!;
  assert.equal(unit("m-작업자").state, "dead", "stop 기록 없이 세션이 없는데 일이 남았다");
  assert.deepEqual(unit("m-작업자").crates, { running: 1, stuck: 0, stale: 1, planned: 0, hold: 0 }, "오래된 미확정은 막힘과 따로 센다");
  assert.equal(unit("m-검수자").state, "running", "결과 대기는 #102부터 작업중으로 온다");
  assert.equal(unit("m-감독").state, "idle");
  assert.equal(unit("비서").state, "dead");
  assert.equal(unit("고아").state, "dead");
  const alive = buildMap({ hierarchy, rows, live: [...live, { role: "m-작업자", harness: "claude", model: "s", effort: null, pidState: "match" }], alerts: null });
  assert.equal(alive.bases[0].units.find((u) => u.role === "m-작업자")!.state, "running", "오래된 미확정은 작업 중보다 뒤");
  assert.equal(alive.totals.stuck, 0); assert.equal(alive.totals.stale, 1);
  assert.equal(alive.totals.running, 3, "작업자 1 + 검수자 1 + 관계표 밖 1");
});

test("세션 상태를 모르면 '세션 사라짐'으로 꾸미지 않고 세션 모름, 경보는 대상 역할에 붙는다", () => {
  const map = buildMap({ hierarchy, rows: [], live: null, alerts: { count: 2, items: [
    { id: "a", kind: "정체", level: "AMBER", role: "m-검수자", session: "kadan-m-검수자", recipient: "m-감독", at: "" },
    { id: "b", kind: "죽음", level: "RED", role: "m-검수자", session: "kadan-m-검수자", recipient: "m-감독", at: "" },
  ] } });
  const units = map.bases.flatMap((b) => b.units);
  assert.ok(units.every((u) => u.state === "unknown" && u.alive === null));
  assert.equal(units.find((u) => u.role === "m-검수자")!.alerts, 2);
  assert.equal(map.totals.alerts, 2);
  assert.equal(map.totals.dead, 0);
});

test("관계표를 모르면 모든 역할이 '관계표 밖' 한 기지에 모인다", () => {
  const map = buildMap({ hierarchy: null, rows, live, alerts: null });
  assert.deepEqual(map.bases.map((b) => b.id), ["관계표 밖"]);
});

test("오래된 미확정만 든 역할은 세션이 없어도 '세션 사라짐'으로 과장하지 않는다, 감시기·대시보드 세션은 유닛이 아니다", () => {
  const map = buildMap({ hierarchy, rows: [row("r/9", "m-작업자", "stale"), row("r/10", "m-검수자", "stuck")], live: [...live,
    { role: "watch", harness: null, model: null, effort: null, pidState: "match" }, { role: "대시보드", harness: null, model: null, effort: null, pidState: "match" }], alerts: null });
  const units = map.bases.flatMap((b) => b.units);
  assert.equal(units.find((u) => u.role === "m-작업자")!.state, "stale");
  assert.equal(units.find((u) => u.role === "m-검수자")!.state, "stuck");
  assert.ok(!units.some((u) => u.role === "watch" || u.role === "대시보드"));
});

test("쉬는 작업자만 숨기고 슈퍼감독·감독은 쉬어도 남긴다", () => {
  const map = buildMap({ hierarchy, rows: [row("r/11", "m-작업자", "hold")], live: [], alerts: null });
  const units = map.bases.find((b) => b.id === "m-슈퍼감독")!.units;
  assert.deepEqual(units.map((u) => [u.role, u.state]), [["m-슈퍼감독", "dead"], ["m-감독", "off"], ["m-작업자", "off"]]);
  assert.deepEqual(visibleUnits(units, false).map((u) => u.role), ["m-슈퍼감독", "m-감독"]);
  assert.equal(visibleUnits(units, true).length, 3);
});

test("옆 칸의 생존·다시 띄우기: 옛 담당자 상태 표와 같은 낱말, 창이 열리고 세대가 있을 때만, 원격 읽기 전용이면 없음", () => {
  const withPid = [
    { role: "m-슈퍼감독", harness: "claude", model: "opus", effort: null, pidState: "match", recordedPid: "101" },
    { role: "m-감독", harness: "claude", model: "sonnet", effort: null, pidState: "changed", recordedPid: "102" },
    { role: "m-검수자", harness: "codex", model: "gpt", effort: null, pidState: "match", recordedPid: null },
  ];
  const map = buildMap({ hierarchy, rows, live: withPid, alerts: null });
  const unit = (role: string) => map.bases.flatMap((b) => b.units).find((u) => u.role === role)!;
  assert.equal(unit("m-슈퍼감독").session?.harness, "claude", "실행 도구가 옆 칸까지 온다");
  assert.equal(lifeLabel(unit("m-슈퍼감독")), "열려 있음");
  assert.equal(lifeLabel(unit("m-감독")), "PID 변경 · 확인 필요");
  assert.equal(lifeLabel(unit("m-작업자")), "닫힘");
  assert.equal(restartGeneration(unit("m-슈퍼감독"), false), "101");
  assert.equal(restartGeneration(unit("m-감독"), false), "102", "PID가 바뀌어도 옛 표처럼 기록된 세대로 보낸다(서버가 대조)");
  assert.equal(restartGeneration(unit("m-검수자"), false), null, "세대 기록이 없으면 버튼 없음");
  assert.equal(restartGeneration(unit("m-작업자"), false), null, "창이 없으면 버튼 없음");
  assert.equal(restartGeneration(unit("m-슈퍼감독"), true), null, "원격 읽기 전용이면 버튼 없음");
  const unknown = buildMap({ hierarchy, rows, live: null, alerts: null }).bases.flatMap((b) => b.units)[0];
  assert.equal(lifeLabel(unknown), "모름");
  assert.equal(restartGeneration(unknown, false), null, "세션 상태를 모르면 버튼 없음");
});

test("닫힌 담당·세션 상태 모름에도 마지막 실행 기록을 보이고, 기반 세션은 지도 유닛이 아니라 따로 모인다(검수 F2·F3)", () => {
  const lastRuns = { "m-작업자": { harness: "codex", model: "model-2" }, "m-감독": { harness: "claude", model: "old" } };
  const sys = [
    { role: "watch", harness: "codex", model: "model-3", effort: null, pidState: "match", recordedPid: "103" },
    { role: "대시보드", harness: "codex", model: "model-4", effort: null, pidState: "changed", recordedPid: "104" },
  ];
  const base = buildMap({ hierarchy, rows, live, alerts: null });
  const map = buildMap({ hierarchy, rows, live: [...live, ...sys], alerts: null, lastRuns });
  const unit = (m: typeof map, role: string) => m.bases.flatMap((b) => b.units).find((u) => u.role === role)!;
  assert.equal(lifeLabel(unit(map, "m-작업자")), "닫힘");
  assert.equal(runLabel(unit(map, "m-작업자")), "마지막 실행: codex · model-2", "창이 닫혀도 마지막 start 기록");
  assert.equal(runLabel(unit(map, "m-감독")), "claude · sonnet", "살아 있으면 지금 창의 기록이 우선");
  assert.equal(unit(map, "m-감독").lastRun, null);
  const unknown = buildMap({ hierarchy, rows, live: null, alerts: null, lastRuns });
  assert.equal(runLabel(unit(unknown, "m-작업자")), "마지막 실행: codex · model-2", "세션 상태를 몰라도 기록은 보인다");
  assert.equal(runLabel(unit(base, "m-작업자")), "세션 사라짐", "기록이 없으면 세션이 왜 없는지를 지도와 같은 말로");
  assert.equal(map.totals.units, base.totals.units, "기반 세션은 지도 유닛 수를 바꾸지 않는다");
  assert.deepEqual(systemSessions([...live, ...sys])?.map((s) => s.role), ["watch", "대시보드"]);
  assert.equal(systemSessions(null), null);
  assert.equal(restartGeneration({ alive: true, session: sys[1] }, false), "104");
  assert.equal(restartGeneration({ alive: true, session: sys[1] }, true), null);
});

// 꺼진 역할 가르기(2026-11-26 [kyle]). 가짜 역할 8개는 운영 실측(빨강 7개)을 흉내 낸 경우다. "일부러 껐다"(stopped)와
// "든 일"(held)은 서버가 정해 내려 준다 — 이 표의 서버 쪽 짝은 tests/dashboard-stopped-roles.test.mjs가 같은 원장으로 확인한다.
const goneTable = {
  "꺼짐-빈손": "@user", "꺼짐-업무": "@user", "꺼짐-발령": "@user", "꺼짐-하위": "@user", "꺼짐-하위-작업자": "꺼짐-하위",
  "사라짐": "@user", "재시작중": "@user", "모름": "@user", "살아있음": "@user",
};
const goneInput = {
  hierarchy: goneTable, rows: [] as Row[], alerts: null,
  live: [
    { role: "살아있음", harness: "claude", model: "opus", effort: null, pidState: "match" },
    { role: "꺼짐-하위-작업자", harness: "codex", model: "gpt", effort: null, pidState: "match" },
  ],
  // 서버 판정: 마지막 수명 사건이 restart 아닌 stop인 역할만. 재시작중(restart stop)·사라짐(start만)은 여기 없다.
  stopped: ["꺼짐-빈손", "꺼짐-업무", "꺼짐-발령", "꺼짐-하위"],
  held: { "꺼짐-업무": "미완료 업무", "꺼짐-발령": "미완료 발령" },
};

test("꺼진 역할 표: 정상 종료+빈손은 지도에 없고, 든 일·하위가 있으면 회색, stop 기록 없이 사라졌으면 빨강", () => {
  const map = buildMap(goneInput);
  const units = new Map(map.bases.flatMap((b) => b.units).map((u) => [u.role, u]));
  const shown = (role: string) => { const u = units.get(role); return u ? [u.state, STATE_LABEL[u.state]] : null; };
  assert.equal(shown("꺼짐-빈손"), null, "정상 종료이고 든 일이 없으면 지도에서 빠진다");
  assert.ok(!map.bases.some((b) => b.id === "꺼짐-빈손"), "판도 생기지 않는다");
  assert.deepEqual(shown("꺼짐-업무"), ["stopped", "꺼짐 · 인계 필요"]);
  assert.deepEqual(shown("꺼짐-발령"), ["stopped", "꺼짐 · 인계 필요"]);
  assert.deepEqual(shown("꺼짐-하위"), ["stopped", "꺼짐 · 인계 필요"], "든 일이 없어도 살아 있는 하위가 판 아래 보인다");
  assert.deepEqual(map.bases.find((b) => b.id === "꺼짐-하위")!.units.map((u) => u.role), ["꺼짐-하위", "꺼짐-하위-작업자"]);
  assert.deepEqual(shown("사라짐"), ["dead", "세션 사라짐"]);
  assert.deepEqual(shown("재시작중"), ["dead", "세션 사라짐"], "restart stop은 정상 종료가 아니다");
  assert.deepEqual(shown("살아있음"), ["idle", "대기"], "살아 있으면 지금과 같은 상태 표시");
  assert.deepEqual(shown("모름"), ["dead", "세션 사라짐"], "세션 조회가 됐고 stop 기록이 없으면 사라진 것이다");
  assert.equal(map.totals.dead, 3, "요약의 세션 사라짐 수는 빨강만 센다(회색은 세지 않는다)");
  // 세션 조회 실패(live null): 누구도 꺼졌다고 꾸미지 않고 전부 세션 모름으로 지도에 남는다.
  const unknown = buildMap({ ...goneInput, live: null });
  const all = unknown.bases.flatMap((b) => b.units);
  assert.ok(all.every((u) => u.state === "unknown" && STATE_LABEL[u.state] === "세션 모름"));
  assert.ok(all.some((u) => u.role === "꺼짐-빈손"), "모를 때는 숨기지 않는다");
});

test("꺼진 역할: 다시 살아나면 예전 표시, 재료를 모르면 숨기지 않는다, 감독·작업자에게도 같은 색 규칙", () => {
  const state = (input: Parameters<typeof buildMap>[0], role: string) => buildMap(input).bases.flatMap((b) => b.units).find((u) => u.role === role)?.state ?? null;
  // 서버 목록이 낡았어도 세션이 살아 있으면 꺼진 것으로 보지 않는다.
  assert.equal(state({ ...goneInput, live: [...goneInput.live, { role: "꺼짐-빈손", harness: "claude", model: "o", effort: null, pidState: "match" }] }, "꺼짐-빈손"), "idle");
  // 든 일을 모르면(held null) 일부러 끈 최상위 역할을 숨기지 않고 회색으로 남긴다. 일부러 껐는지를 모르면(stopped null) 예전처럼 빨강.
  assert.equal(state({ ...goneInput, held: null }, "꺼짐-빈손"), "stopped");
  assert.equal(state({ ...goneInput, stopped: null }, "꺼짐-빈손"), "dead");
  // 하위 역할: 일부러 껐고 진행 카드가 남으면 회색, stop 기록 없이 사라졌으면 빨강, 오래된 미확정만 들면 예전처럼 오래된 미확정.
  const hierarchy2 = { "판": "@user", "감독": "판", "끈-작업자": "감독", "사라진-작업자": "감독", "끈-옛작업자": "감독", "끈-빈손": "감독" };
  const live2 = [{ role: "판", harness: "claude", model: "o", effort: null, pidState: "match" }];
  const input = { hierarchy: hierarchy2, live: live2, alerts: null, stopped: ["감독", "끈-작업자", "끈-옛작업자", "끈-빈손"], held: { "끈-작업자": "미완료 카드", "끈-빈손": "미완료 발령" },
    rows: [row("x/1", "끈-작업자", "running"), row("x/2", "사라진-작업자", "stuck"), row("x/3", "끈-옛작업자", "stale")] };
  assert.equal(state(input, "끈-작업자"), "stopped");
  assert.equal(state(input, "사라진-작업자"), "dead");
  assert.equal(state(input, "끈-옛작업자"), "stale", "오래된 미확정 묶음(2026-11-23)은 그대로");
  assert.equal(state({ ...goneInput, rows: [row("z/1", "꺼짐-발령", "stale")] }, "꺼짐-발령"), "stopped", "최상위는 오래된 미확정만 들어도 회색이다(예전의 빨강 자리)");
  assert.equal(state(input, "감독"), "stopped", "일부러 끈 감독이 하위 사슬 때문에 지도에 오르면 회색");
  assert.equal(state(input, "끈-빈손"), null, "하위 역할은 지금처럼 세션·진행 카드·경보가 있을 때만 오른다(정리가 붙잡는 발령만으로는 새로 올리지 않는다)");
  assert.ok(visibleUnits(buildMap(input).bases[0].units, false).some((u) => u.role === "끈-작업자"), "회색 작업자는 쉬는 역할로 숨기지 않는다");
  const withAlert = { ...goneInput, alerts: { count: 1, items: [{ id: "a", kind: "정체", level: "AMBER", role: "꺼짐-빈손", session: "kadan-꺼짐-빈손", recipient: "@user", at: "" }] } };
  assert.equal(state(withAlert, "꺼짐-빈손"), "stopped", "열린 경보도 든 일이다");
});

test("질문 칸: 받는 사람의 세션이 없다고 확인된 때만 막는다(고른 유닛이 아니라 받는 사람 기준)", () => {
  const map = buildMap({ ...goneInput, rows: [row("y/1", "꺼짐-하위-작업자", "running")] });
  const base = map.bases.find((b) => b.id === "꺼짐-하위")!, worker = base.units.find((u) => u.role === "꺼짐-하위-작업자")!;
  assert.equal(worker.alive, true);
  assert.equal(askRecipient(worker, base), "꺼짐-하위", "살아 있는 작업자를 골라도 받는 사람은 꺼진 슈퍼감독이다");
  assert.equal(recipientGone("꺼짐-하위", goneInput.live), true);
  assert.equal(recipientGone("살아있음", goneInput.live), false);
  assert.equal(recipientGone("꺼짐-하위", null), false, "세션 상태를 모르면 막지 않는다");
  const outside = { id: "관계표 밖", label: "관계표 밖", super: null, units: [] };
  assert.equal(askRecipient({ role: "떠돌이", kind: "worker" }, outside), "비서");
  assert.equal(recipientGone("비서", goneInput.live), true, "비서가 받는 사람일 때도 같은 기준");
});
