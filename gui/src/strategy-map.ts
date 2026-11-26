// 전략 맵(2026-10-05 [kyle]): 여러 AI 역할의 상태를 전략 게임 지도처럼 한눈에 본다.
// 이 모듈은 화면 없이 "어느 기지에 어느 유닛이 어떤 상태로 있는가"만 계산한다. 그리는 쪽(나무 보기 — strategy-tree.ts)은
// 이 결과를 그대로 그린다 — 데이터 해석을 화면마다 다시 만들지 않기 위해서다.
// 2D 등각·3D 배치와 2D 모션 계산은 2026-11-23 [kyle] 결정으로 뺐다(나무 보기만 남김).
import type { Row } from "./types";
import { liveLabel, type LiveSession, type OpenAlerts } from "./status-band.ts";

export type UnitKind = "super" | "director" | "worker";
// 우선순위 순서: 세션 사라짐 > 꺼짐 > 막힘 > 작업중 > 오래된 미확정 > 대기(세션만 있음). 결과 대기는 #102부터 작업중에 합쳐 센다.
// 세션 상태를 모르면 unknown, 세션도 일도 없으면 off. 오래된 미확정(stale)는 현황판처럼 막힘과 따로 둔다 — 2026-10-05 실데이터에서
// 막힘 16건이 전부 오래된 미확정이었고, 막힘으로 세면 세션이 닫힌 옛 작업자 11명이 빨강으로 떠 과장됐다.
// 세션이 없는 역할은 둘로 가른다(2026-11-26 [kyle]): stop 기록 없이 사라졌으면 dead(빨강 "세션 사라짐"),
// 일부러 껐는데 든 일·경보·하위가 남아 지도에 있으면 stopped(회색 "꺼짐 · 인계 필요"). 일부러 껐고 남은 것이 없으면 지도에 올리지 않는다.
// "일부러 껐다"는 서버가 정한다(status.stopped — 감시와 같은 판정). 화면은 다시 판정하지 않는다.
export type UnitState = "dead" | "stopped" | "stuck" | "running" | "stale" | "idle" | "unknown" | "off";
export type Crates = { running: number; stuck: number; stale: number; planned: number; hold: number };
export type Unit = {
  role: string; kind: UnitKind; parent: string | null; state: UnitState; alive: boolean | null;
  model: string | null; crates: Crates; alerts: number; rows: Row[];
  // 열린 세션의 시작 기록(실행 도구·모델·PID 대조·세대). 세션이 없거나 세션 상태를 모르면 null.
  session: LiveSession | null;
  // 창이 닫혔거나 세션 상태를 모를 때 마지막 start 줄의 실행 도구·모델(status.lastRuns). 없으면 null.
  lastRun: LastRun | null;
};
export type LastRun = { harness: string | null; model: string | null };
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
  lastRuns?: Record<string, LastRun>;
  // 일부러 끈 역할 이름(세션이 없는 역할만). 모르면 null — 그때는 아무도 꺼진 것으로 보지 않는다(예전 표시).
  stopped?: string[] | null;
  // 역할이 든 일의 이유(관계표 정리와 같은 서버 함수). 모르면 null — 그때는 든 일이 있는 것으로 보고 숨기지 않는다.
  held?: Record<string, string> | null;
};

export const STATE_LABEL: Record<UnitState, string> = {
  dead: "세션 사라짐", stopped: "꺼짐 · 인계 필요", stuck: "막힘", running: "작업중", stale: "오래된 미확정", idle: "대기", unknown: "세션 모름", off: "쉬는 중",
};
export const KIND_LABEL: Record<UnitKind, string> = { super: "슈퍼감독", director: "감독", worker: "작업자·검수자" };
// 카단 자체 세션(감시기·대시보드)은 역할 유닛이 아니다.
const SYSTEM_ROLES = new Set(["watch", "대시보드"]);
const OUTSIDE = "관계표 밖";
const USER = "@user";

function emptyCrates(): Crates {
  return { running: 0, stuck: 0, stale: 0, planned: 0, hold: 0 };
}

export function buildMap({ hierarchy, rows, live, alerts, lastRuns, stopped, held }: MapInput): MapModel {
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

  // 지도에 올릴 역할: 최상위(상위가 @user) 역할, 세션이 열렸거나 진행 카드·경보가 있는 역할, 그리고 그 역할의 상위 사슬.
  // 끝난 지 오래된 역할(관계표에만 남은 이름)은 올리지 않는다. 최상위라도 일부러 껐고 든 일이 없으면 올리지 않는다 —
  // 진행 카드·경보·보이는 하위가 있으면 아래 사슬 따라가기가 다시 올린다. 든 일을 모르면(held 없음) 숨기지 않는다.
  const stoppedSet = new Set(live === null ? [] : stopped ?? []);
  const isStopped = (role: string) => stoppedSet.has(role) && !liveByRole.has(role);
  const holds = (role: string) => held == null || role in held;
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
  for (const [role, parent] of parents) if (parent === USER && !(isStopped(role) && !holds(role))) shown.add(role);
  for (const role of [...liveByRole.keys(), ...rowsByRole.keys(), ...alertsByRole.keys()]) addChain(role);

  const unitOf = (role: string): Unit => {
    const parent = parents.get(role);
    const kind: UnitKind = parent === USER ? "super" : children.has(role) ? "director" : "worker";
    const own = rowsByRole.get(role) ?? [];
    const crates = emptyCrates();
    for (const row of own) if (row.bucket && row.bucket in crates) crates[row.bucket as keyof Crates]++;
    const active = crates.running + crates.stuck;
    const alive = live === null ? null : liveByRole.has(role);
    // 일부러 끈 역할이 지도에 있다는 것은 든 일·진행 카드·경보·보이는 하위가 남았다는 뜻이다. 오래된 미확정만 든 하위 역할은
    // 예전처럼 오래된 미확정으로 둔다(나무의 "오래된 미확정 N" 묶음, 2026-11-23). 최상위는 세션 사라짐과 같은 자리라 회색이 먼저다.
    const gone = alive === false && isStopped(role);
    const state: UnitState =
      gone ? (active === 0 && crates.stale > 0 && kind !== "super" ? "stale" : "stopped")
      : alive === false && (active > 0 || kind === "super") ? "dead"
      : crates.stuck > 0 ? "stuck"
      : crates.running > 0 ? "running"
      : crates.stale > 0 ? "stale"
      : alive === null ? "unknown"
      : alive ? "idle" : "off";
    return {
      role, kind, parent: parent && parent !== USER ? parent : null, state, alive,
      model: liveByRole.get(role)?.model ?? null, session: liveByRole.get(role) ?? null,
      lastRun: liveByRole.has(role) ? null : lastRuns?.[role] ?? null, crates, alerts: alertsByRole.get(role) ?? 0,
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


// 쉬는 역할(창도 진행 카드도 없이 진행 전·일시정지 카드만 든 작업자)을 뺀 유닛. 슈퍼감독·감독은 기지의 뼈대라 늘 남긴다.
// 옆 칸의 생존 줄. 옛 '담당자 상태' 표(2026-10-25 전략 맵으로 옮김)와 같은 낱말을 쓴다.
type Life = Pick<Unit, "alive" | "session">;
export function lifeLabel(unit: Life) {
  if (unit.alive === null) return "모름";
  if (!unit.alive) return "닫힘";
  return unit.session?.pidState === "match" ? "열려 있음" : "PID 변경 · 확인 필요";
}
// 다시 띄우기에 보낼 세대(최근 start의 pane PID). 창이 열려 있고 세대가 기록된 역할만, 원격 읽기 전용이면 없음.
export function restartGeneration(unit: Life, readOnly: boolean) {
  return readOnly || !unit.alive ? null : unit.session?.recordedPid ?? null;
}

// 옆 칸의 실행 도구 · 모델 줄. 창이 닫혀도 마지막 start 기록을 보인다(옛 담당자 상태 표와 같은 정보).
export function runLabel(unit: Pick<Unit, "alive" | "session" | "lastRun" | "state">) {
  if (unit.session) return liveLabel(unit.session);
  const last = unit.lastRun && [unit.lastRun.harness, unit.lastRun.model].filter(Boolean).join(" · ");
  if (last) return "마지막 실행: " + last;
  // 기록이 없으면 세션이 왜 없는지만 지도와 같은 말로 적는다.
  return unit.alive === false ? STATE_LABEL[unit.state === "stopped" ? "stopped" : "dead"] : "모름";
}
// '슈퍼감독에게 묻기'의 받는 사람(미리 보기): 유닛이 최상위면 자신, 아니면 그 판의 슈퍼감독, 사슬 밖이면 비서. 실제로는 서버가 다시 정한다.
export function askRecipient(unit: Pick<Unit, "role" | "kind">, base: Pick<Base, "super">) {
  return unit.kind === "super" ? unit.role : base.super ?? "비서";
}
// 받는 사람의 세션이 없다고 확인됐는가. 세션 상태를 모르면(live 없음) 아니다 — 모를 때는 질문을 막지 않는다.
export function recipientGone(to: string, live: LiveSession[] | null) {
  return live !== null && !live.some((s) => s.role === to);
}
// 감시기·대시보드처럼 지도 유닛이 아닌 카단 자체 세션. 전략 맵의 '기반 세션' 묶음에 따로 보인다.
export function systemSessions(live: LiveSession[] | null) {
  return live === null ? null : live.filter((s) => SYSTEM_ROLES.has(s.role));
}

export function visibleUnits(units: Unit[], showResting: boolean) {
  return showResting ? units : units.filter((u) => u.kind !== "worker" || u.state !== "off");
}
