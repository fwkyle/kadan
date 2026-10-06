import test from "node:test";
import assert from "node:assert/strict";
import { buildMap, placeUnits, shortName, iso, visibleUnits, worldLayout, CELL, BASE_GAP, TILE_W, TILE_H } from "../src/strategy-map.ts";
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

test("유닛 상태 우선순위: 창 없음 > 막힘 > 작업 중 > 결과 대기 > 대기, 슈퍼감독은 창이 없으면 일이 없어도 창 없음", () => {
  const map = buildMap({ hierarchy, rows, live, alerts: null });
  const unit = (role: string) => map.bases.flatMap((b) => b.units).find((u) => u.role === role)!;
  assert.equal(unit("m-작업자").state, "dead", "창이 없는데 일이 남았다");
  assert.deepEqual(unit("m-작업자").crates, { running: 1, stuck: 0, stale: 1, planned: 0, hold: 0 }, "오래된 미정리는 막힘과 따로 센다");
  assert.equal(unit("m-검수자").state, "running", "결과 대기는 #102부터 작업중으로 온다");
  assert.equal(unit("m-감독").state, "idle");
  assert.equal(unit("비서").state, "dead");
  assert.equal(unit("고아").state, "dead");
  const alive = buildMap({ hierarchy, rows, live: [...live, { role: "m-작업자", harness: "claude", model: "s", effort: null, pidState: "match" }], alerts: null });
  assert.equal(alive.bases[0].units.find((u) => u.role === "m-작업자")!.state, "running", "오래된 미정리는 작업 중보다 뒤");
  assert.equal(alive.totals.stuck, 0); assert.equal(alive.totals.stale, 1);
  assert.equal(alive.totals.running, 3, "작업자 1 + 검수자 1 + 관계표 밖 1");
});

test("세션 상태를 모르면 '창 없음'으로 꾸미지 않고 세션 모름, 경보는 대상 역할에 붙는다", () => {
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

test("배치: 슈퍼감독 앞줄, 감독 둘째 줄, 작업자는 cols개씩 줄바꿈", () => {
  const map = buildMap({ hierarchy, rows, live, alerts: null });
  const { placed, width, depth } = placeUnits(map.bases[0].units, 1);
  assert.deepEqual(placed.map((p) => [p.unit.role, p.gx, p.gy]), [
    ["m-슈퍼감독", 0, 0], ["m-감독", 0, 1], ["m-검수자", 0, 2], ["m-작업자", 0, 3],
  ]);
  assert.deepEqual([width, depth], [1, 4]);
  assert.deepEqual(iso(1, 0), { x: TILE_W / 2, y: TILE_H / 2 });
  assert.equal(shortName("m-작업자", "m-슈퍼감독"), "작업자");
  assert.equal(shortName("떠돌이", null), "떠돌이");
});

test("오래된 미정리만 든 역할은 창이 없어도 '창 없음'으로 과장하지 않는다, 감시기·대시보드 세션은 유닛이 아니다", () => {
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

test("3D 배치: 2D와 같은 칸을 바닥 좌표로, 기지는 x로 늘어서고 창고는 맨 오른쪽", () => {
  const map = buildMap({ hierarchy, rows, live, alerts: null });
  const world = worldLayout(map.bases, map.depot, false);
  assert.deepEqual(world.bases.map((b) => b.base.id), ["m-슈퍼감독", "비서", "관계표 밖"]);
  const [m, , outside] = world.bases;
  assert.equal(m.x0, 0);
  assert.equal(world.bases[1].x0, m.x1 + BASE_GAP, "기지 사이 간격");
  const at = (role: string) => m.units.find((u) => u.unit.role === role)!;
  assert.deepEqual([at("m-슈퍼감독").x, at("m-슈퍼감독").z], [CELL / 2, CELL / 2], "슈퍼감독은 맨 안쪽 첫 칸");
  assert.ok(at("m-감독").z > at("m-슈퍼감독").z && at("m-작업자").z > at("m-감독").z, "감독·작업자 줄은 앞으로");
  assert.ok(world.depot && world.depot.x > outside.x1, "창고는 마지막 기지 오른쪽");
  assert.equal(world.size.x, world.depot!.x + CELL / 2);
  assert.equal(worldLayout(map.bases, 0, false).depot, null, "담당 없는 실행이 없으면 창고도 없다");
  assert.ok(worldLayout(map.bases, map.depot, true).bases.length >= world.bases.length, "쉬는 역할도 보기를 켜면 기지가 줄지 않는다");
});
