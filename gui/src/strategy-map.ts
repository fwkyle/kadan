// 전략 맵(2026-10-05 [kyle]): 여러 AI 역할의 상태를 전략 게임 지도처럼 한눈에 본다.
// 이 모듈은 화면 없이 "어느 기지에 어느 유닛이 어떤 상태로 있는가"만 계산한다. 그리는 쪽(2D SVG든 나중의 3D든)은
// 이 결과를 그대로 그린다 — 데이터 해석을 화면마다 다시 만들지 않기 위해서다.
// 미감 기준: 납작한 등각(2:1). 바닥은 저채도 한 색, 상태색만 채도 높게(현황판과 같은 색), 외곽선 없음.
import type { Row } from "./types";
import type { LiveSession, OpenAlerts } from "./status-band";

export type UnitKind = "super" | "director" | "worker";
// 우선순위 순서: 창 없음 > 막힘 > 작업중 > 오래된 미정리 > 대기(창만 있음). 결과 대기는 #102부터 작업중에 합쳐 센다. 세션 상태를 모르면 unknown,
// 창도 일도 없으면 off. 오래된 미정리(stale)는 현황판처럼 막힘과 따로 둔다 — 2026-10-05 실데이터에서 막힘 16건이 전부
// 오래된 미정리였고, 막힘으로 세면 창이 닫힌 옛 작업자 11명이 '창 없음' 빨강으로 떠 과장됐다.
export type UnitState = "dead" | "stuck" | "running" | "stale" | "idle" | "unknown" | "off";
export type Crates = { running: number; stuck: number; stale: number; planned: number; hold: number };
export type Unit = {
  role: string; kind: UnitKind; parent: string | null; state: UnitState; alive: boolean | null;
  model: string | null; crates: Crates; alerts: number; rows: Row[];
};
export type Base = { id: string; label: string; super: string | null; units: Unit[] };
export type MapModel = {
  bases: Base[];
  depot: number; // 담당이 아직 없는 실행(진행 전·일시정지). 어느 유닛에도 못 붙인다.
  depotRows: Row[]; // 창고를 눌렀을 때 옆 칸에 보일 그 실행들
  totals: { units: number; running: number; stuck: number; stale: number; dead: number; alerts: number };
};
export type MapInput = {
  hierarchy: Record<string, string> | null;
  rows: Row[];
  live: LiveSession[] | null;
  alerts: OpenAlerts | null;
};

export const STATE_LABEL: Record<UnitState, string> = {
  dead: "창 없음", stuck: "막힘", running: "작업중", stale: "오래된 미정리", idle: "대기", unknown: "세션 모름", off: "쉬는 중",
};
// 카단 자체 세션(감시기·대시보드)은 역할 유닛이 아니다.
const SYSTEM_ROLES = new Set(["watch", "대시보드"]);
const OUTSIDE = "관계표 밖";
const USER = "@user";

function emptyCrates(): Crates {
  return { running: 0, stuck: 0, stale: 0, planned: 0, hold: 0 };
}

export function buildMap({ hierarchy, rows, live, alerts }: MapInput): MapModel {
  const parents = new Map(Object.entries(hierarchy ?? {}));
  const children = new Map<string, string[]>();
  for (const [role, parent] of parents) {
    if (parent === USER) continue;
    children.set(parent, [...(children.get(parent) ?? []), role]);
  }
  // 사슬 끝(상위가 @user)인 슈퍼감독. 순환·끊긴 사슬이면 null.
  const topOf = (role: string): string | null => {
    let r: string | undefined = role;
    for (let i = 0; i < 64 && r; i++) {
      const p = parents.get(r);
      if (p === USER) return r;
      if (p == null) return null;
      r = p;
    }
    return null;
  };
  const liveByRole = new Map((live ?? []).filter((s) => !SYSTEM_ROLES.has(s.role)).map((s) => [s.role, s]));
  const rowsByRole = new Map<string, Row[]>();
  const depotRows: Row[] = [];
  for (const row of rows) {
    if (!row.owner) { depotRows.push(row); continue; }
    rowsByRole.set(row.owner, [...(rowsByRole.get(row.owner) ?? []), row]);
  }
  const alertsByRole = new Map<string, number>();
  for (const a of alerts?.items ?? []) alertsByRole.set(a.role, (alertsByRole.get(a.role) ?? 0) + 1);

  // 지도에 올릴 역할: 슈퍼감독 전부, 창이 열렸거나 일·경보가 있는 역할, 그리고 그 역할의 상위 사슬.
  // 끝난 지 오래된 역할(관계표에만 남은 이름)은 올리지 않는다.
  const shown = new Set<string>();
  const addChain = (role: string) => {
    let r: string | undefined = role;
    for (let i = 0; i < 64 && r && r !== USER && !shown.has(r); i++) {
      shown.add(r);
      // 관계표에 자기 줄이 없는 상위(끊긴 사슬의 끝 이름)는 유닛으로 만들지 않는다.
      const p = parents.get(r);
      r = p && p !== USER && (parents.has(p) || liveByRole.has(p)) ? p : undefined;
    }
  };
  for (const [role, parent] of parents) if (parent === USER) shown.add(role);
  for (const role of [...liveByRole.keys(), ...rowsByRole.keys(), ...alertsByRole.keys()]) addChain(role);

  const unitOf = (role: string): Unit => {
    const parent = parents.get(role);
    const kind: UnitKind = parent === USER ? "super" : children.has(role) ? "director" : "worker";
    const own = rowsByRole.get(role) ?? [];
    const crates = emptyCrates();
    for (const row of own) if (row.bucket && row.bucket in crates) crates[row.bucket as keyof Crates]++;
    const active = crates.running + crates.stuck;
    const alive = live === null ? null : liveByRole.has(role);
    const state: UnitState =
      alive === false && (active > 0 || kind === "super") ? "dead"
      : crates.stuck > 0 ? "stuck"
      : crates.running > 0 ? "running"
      : crates.stale > 0 ? "stale"
      : alive === null ? "unknown"
      : alive ? "idle" : "off";
    return {
      role, kind, parent: parent && parent !== USER ? parent : null, state, alive,
      model: liveByRole.get(role)?.model ?? null, crates, alerts: alertsByRole.get(role) ?? 0,
      rows: own.filter((r) => r.bucket === "running" || r.bucket === "stuck" || r.bucket === "stale"),
    };
  };
  const order: Record<UnitKind, number> = { super: 0, director: 1, worker: 2 };
  const byBase = new Map<string, Unit[]>();
  for (const role of shown) {
    const base = topOf(role) ?? OUTSIDE;
    byBase.set(base, [...(byBase.get(base) ?? []), unitOf(role)]);
  }
  // 유닛이 많은(일이 몰린) 기지부터, '관계표 밖'은 맨 끝.
  const bases: Base[] = [...byBase.entries()]
    .sort(([a, ua], [b, ub]) => (a === OUTSIDE ? 1 : b === OUTSIDE ? -1 : ub.length - ua.length || a.localeCompare(b, "ko")))
    .map(([id, units]) => ({
      id, label: id, super: id === OUTSIDE ? null : id,
      units: units.sort((x, y) => order[x.kind] - order[y.kind] || (x.parent ?? "").localeCompare(y.parent ?? "", "ko") || x.role.localeCompare(y.role, "ko")),
    }));
  const all = bases.flatMap((b) => b.units);
  return {
    bases, depot: depotRows.length, depotRows,
    totals: {
      units: all.length,
      running: all.reduce((n, u) => n + u.crates.running, 0),
      stuck: all.reduce((n, u) => n + u.crates.stuck, 0),
      stale: all.reduce((n, u) => n + u.crates.stale, 0),
      dead: all.filter((u) => u.state === "dead").length,
      alerts: alerts?.count ?? 0,
    },
  };
}

// 등각 배치. 기지 안에서 슈퍼감독은 맨 앞 줄, 감독은 둘째 줄, 작업자는 그 뒤 줄들(한 줄에 cols개).
export const TILE_W = 124, TILE_H = 62; // 2:1 등각 칸. 이름표가 옆 칸과 겹치지 않을 만큼 넓게
export type Placed = { unit: Unit; gx: number; gy: number };
export function placeUnits(units: Unit[], cols = 4): { placed: Placed[]; width: number; depth: number } {
  const placed: Placed[] = [];
  let gy = 0;
  for (const kind of ["super", "director", "worker"] as UnitKind[]) {
    const group = units.filter((u) => u.kind === kind);
    for (let i = 0; i < group.length; i++) placed.push({ unit: group[i], gx: i % cols, gy: gy + Math.floor(i / cols) });
    if (group.length) gy += Math.ceil(group.length / cols);
  }
  const width = Math.max(1, ...placed.map((p) => p.gx + 1));
  return { placed, width, depth: Math.max(1, gy) };
}
export function iso(gx: number, gy: number) {
  return { x: (gx - gy) * (TILE_W / 2), y: (gx + gy) * (TILE_H / 2) };
}
// 같은 기지 안에서 겹치는 접두사(예: "shop-")를 떼어 유닛 이름표를 짧게 한다. 전체 이름은 툴팁·옆 칸에 그대로.
export function shortName(role: string, base: string | null) {
  const prefix = base?.match(/^[^-]+-/)?.[0];
  return prefix && role.startsWith(prefix) && role.length > prefix.length ? role.slice(prefix.length) : role;
}

// 쉬는 역할(창도 진행 카드도 없이 진행 전·일시정지 카드만 든 작업자)을 뺀 유닛. 슈퍼감독·감독은 기지의 뼈대라 늘 남긴다.
export function visibleUnits(units: Unit[], showResting: boolean) {
  return showResting ? units : units.filter((u) => u.kind !== "worker" || u.state !== "off");
}

// 3D 배치(2026-10-06 [kyle] 2단계). 2D와 같은 칸(placeUnits)을 바닥 좌표로 옮긴다. x는 기지가 늘어선 방향, z는 앞뒤
// (gy=0 슈퍼감독 줄이 가장 안쪽). 단위는 three.js 장면 단위다. 창고는 마지막 기지 오른쪽에 둔다.
export const CELL = 1.7, BASE_GAP = 1.6;
export type WorldBase = { base: Base; units: { unit: Unit; x: number; z: number }[]; x0: number; x1: number; depth: number; resting: number };
export function worldLayout(bases: Base[], depot: number, showResting: boolean, cols = 4) {
  let cursor = 0;
  const out: WorldBase[] = [];
  for (const base of bases) {
    const shown = visibleUnits(base.units, showResting);
    if (!shown.length) continue; // 2D와 같이, 보이는 유닛이 없는 기지는 숨긴다
    const { placed, width, depth } = placeUnits(shown, cols);
    out.push({ base, x0: cursor, x1: cursor + width * CELL, depth: depth * CELL, resting: base.units.length - shown.length,
      units: placed.map(({ unit, gx, gy }) => ({ unit, x: cursor + (gx + 0.5) * CELL, z: (gy + 0.5) * CELL })) });
    cursor += width * CELL + BASE_GAP;
  }
  const depotAt = depot > 0 ? { x: cursor + CELL / 2, z: CELL / 2 } : null;
  const x1 = depotAt ? depotAt.x + CELL / 2 : Math.max(0, cursor - BASE_GAP);
  return { bases: out, depot: depotAt, size: { x: x1, z: Math.max(CELL, ...out.map((b) => b.depth)) } };
}

// 모션(2026-10-07 [kyle]): 직전 지도와 새 지도를 비교해 "바뀐 것"만 뽑는다. 장식이 아니라 변화를 알리는 움직임이다.
// 처음 그릴 때(직전 없음)는 아무것도 움직이지 않는다. 한 번에 너무 많이 움직이지 않게 limit개까지만.
// fly: 카드가 창고(from=null)나 다른 유닛에서 이 유닛으로 왔다. 새로 생긴 카드도 창고에서 온 것으로 그린다.
// leave: 유닛이 들고 있던 카드가 지도에서 빠졌다(완료·취소·대체 등 — 이유는 구분하지 않는다).
// state: 유닛 상태가 바뀌었다.
export type MapEvent =
  | { kind: "fly"; key: string; from: string | null; to: string }
  | { kind: "leave"; key: string; from: string }
  | { kind: "state"; role: string; from: UnitState; to: UnitState };
function cardPlaces(model: MapModel) {
  const at = new Map<string, string | null>();
  for (const row of model.depotRows) at.set(row.key, null);
  for (const base of model.bases) for (const unit of base.units) for (const row of unit.rows) at.set(row.key, unit.role);
  return at;
}
export function diffMap(prev: MapModel | null, next: MapModel, limit = 8): MapEvent[] {
  if (!prev) return [];
  const before = cardPlaces(prev), after = cardPlaces(next), events: MapEvent[] = [];
  for (const [key, to] of after) {
    if (to === null) continue;
    const from = before.has(key) ? before.get(key)! : null;
    if (!before.has(key) || from !== to) events.push({ kind: "fly", key, from, to });
  }
  for (const [key, from] of before) if (from !== null && !after.has(key)) events.push({ kind: "leave", key, from });
  const states = new Map(prev.bases.flatMap((b) => b.units).map((u) => [u.role, u.state] as const));
  for (const unit of next.bases.flatMap((b) => b.units)) {
    const was = states.get(unit.role);
    if (was && was !== unit.state) events.push({ kind: "state", role: unit.role, from: was, to: unit.state });
  }
  return events.slice(0, limit);
}
