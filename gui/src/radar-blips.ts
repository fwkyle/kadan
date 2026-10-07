// 우주 테마의 레이더(2026-10-07 [kyle]): 관심이 필요한 담당을 점으로 찍는다. 화면 없이 계산만 한다.
// 각도는 역할 이름으로 정해 새로 고쳐도 같은 자리에 있다. 반지름은 급한 정도: 창 없음·경보 0.82, 막힘 0.58, 오래된 미정리 0.36.
import type { Row } from "./types";

export type Blip = { role: string; kind: "alert" | "dead" | "stuck" | "stale"; angle: number; r: number };
const RADIUS = { alert: 0.82, dead: 0.82, stuck: 0.58, stale: 0.36 } as const;
const RANK = { alert: 3, dead: 3, stuck: 2, stale: 1 } as const;

export function angleOf(role: string) {
  let h = 2166136261;
  for (const ch of role) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  return ((h >>> 0) % 360);
}

export function radarBlips({ alerts, rows, deadRoles = [] }: { alerts: { items: { role: string }[] } | null; rows: Row[]; deadRoles?: string[] }, limit = 24): Blip[] {
  const worst = new Map<string, Blip["kind"]>();
  const mark = (role: string | null | undefined, kind: Blip["kind"]) => {
    if (!role) return;
    const was = worst.get(role);
    if (!was || RANK[kind] > RANK[was]) worst.set(role, kind);
  };
  for (const a of alerts?.items ?? []) mark(a.role, "alert");
  for (const role of deadRoles) mark(role, "dead");
  for (const row of rows) if (row.bucket === "stuck" || row.bucket === "stale") mark(row.owner, row.bucket);
  return [...worst].map(([role, kind]) => ({ role, kind, angle: angleOf(role), r: RADIUS[kind] }))
    .sort((a, b) => RANK[b.kind] - RANK[a.kind] || a.role.localeCompare(b.role)).slice(0, limit);
}
