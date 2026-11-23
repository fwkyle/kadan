// 전략 맵 '나무' 보기(2026-11-23 [kyle]): 판(슈퍼감독) → 감독 → "지시" → 작업자·검수자를 왼쪽에서 오른쪽으로 펼친다.
// 이 모듈은 화면 없이 "어느 상자가 어디에 놓이고, 무엇이 접히고 넘치는가"만 계산한다. 자료는 buildMap 결과 그대로다.
// 넓은 화면은 좌표가 있는 그림(layoutTree), 좁은 화면은 같은 나무(buildForest)를 접는 목록으로 그린다.
import { visibleUnits, type Base, type Unit, type UnitState } from "./strategy-map.ts";
import type { Row } from "./types";

// 실행 도구 이름. 시작 기록에 따옴표 같은 군글자가 붙어 온 적이 있어 영문자만 남긴다. 기록이 없으면 null.
export function harnessName(unit: Pick<Unit, "session" | "lastRun">): string | null {
  return (unit.session?.harness ?? unit.lastRun?.harness ?? "").toLowerCase().replace(/[^a-z]/g, "") || null;
}
// 모양 = 실행 도구: 동그라미 claude(와 그 밖의 도구), 네모 codex, 세모 agy. 기록이 없으면 점선 동그라미(none).
export type Shape = "circle" | "square" | "triangle" | "none";
export function shapeOf(harness: string | null): Shape {
  return harness === null ? "none" : harness === "codex" ? "square" : harness === "agy" ? "triangle" : "circle";
}

// 상태별 개수. 접은 줄에 하위 상태를 합쳐 보일 때 쓴다. 0인 상태는 뺀다.
const STATE_ORDER: UnitState[] = ["running", "stuck", "stale", "dead", "idle", "unknown", "off"];
export type Count = { state: UnitState; n: number };
export function stateCounts(units: Unit[]): Count[] {
  return STATE_ORDER.map((state) => ({ state, n: units.filter((u) => u.state === state).length })).filter((c) => c.n > 0);
}

// 판 하나의 나무. root는 슈퍼감독(없으면 null — '관계표 밖'), tops는 그 바로 아래(와 상위를 못 찾은 역할).
export type TreeNode = { unit: Unit; children: TreeNode[] };
// counts는 접은 줄에 보이는 하위 상태 개수다. 슈퍼감독 자신은 빼고 센다. 그림과 목록이 이 값 하나를 같이 쓴다.
export type Group = { id: string; label: string; root: Unit | null; tops: TreeNode[]; units: Unit[]; counts: Count[] };
export type Forest = {
  groups: Group[]; // 하위 역할이 있는 판(과 '관계표 밖')
  lone: Unit[]; // 하위 역할 없는 슈퍼감독 — 한 줄 묶음
  boards: number; idle: number; harness: { claude: number; codex: number; agy: number }; // 맨 위 집계 줄
};
export function flatten(node: TreeNode): Unit[] {
  return [node.unit, ...node.children.flatMap(flatten)];
}
// 쉬는 작업자는 기본으로 숨긴다(쉬는 역할도 보기로 켠다). 보이는 유닛이 없는 판은 뺀다.
export function buildForest(bases: Base[], showResting: boolean): Forest {
  const groups: Group[] = [], lone: Unit[] = [], all: Unit[] = [];
  for (const base of bases) {
    const units = visibleUnits(base.units, showResting);
    if (!units.length) continue;
    all.push(...units);
    const root = base.super ? units.find((u) => u.role === base.super) ?? null : null;
    if (root && units.length === 1) { lone.push(root); continue; }
    const byRole = new Map(units.map((u) => [u.role, u])), kids = new Map<string, Unit[]>(), tops: Unit[] = [];
    for (const u of units) {
      if (u === root) continue;
      if (u.parent && u.parent !== root?.role && byRole.has(u.parent)) kids.set(u.parent, [...(kids.get(u.parent) ?? []), u]);
      else tops.push(u);
    }
    // 서로를 상위로 가리키는 역할(순환)은 어느 가지에도 안 걸린다. 한 번씩만 놓고, 남은 것은 맨 위 가지로 올린다.
    const seen = new Set<string>(root ? [root.role] : []);
    const place = (u: Unit): TreeNode => {
      seen.add(u.role);
      const children: TreeNode[] = [];
      for (const c of kids.get(u.role) ?? []) if (!seen.has(c.role)) children.push(place(c));
      return { unit: u, children };
    };
    const nodes = tops.map(place);
    for (const u of units) if (!seen.has(u.role)) nodes.push(place(u));
    groups.push({ id: base.id, label: base.label, root, tops: nodes, units, counts: stateCounts(units.filter((u) => u !== root)) });
  }
  const harness = { claude: 0, codex: 0, agy: 0 };
  for (const u of all) { const h = harnessName(u); if (h === "claude" || h === "codex" || h === "agy") harness[h]++; }
  return { groups, lone, boards: groups.length + lone.length, idle: all.filter((u) => u.state === "idle").length, harness };
}

// 접기: 사용자가 누른 값이 있으면 그 값, 없으면 "작업중이거나 고른 역할이 든 가지만 편다".
export function defaultOpen(units: Unit[], selected: string | null) {
  return units.some((u) => u.state === "running" || u.role === selected);
}
export function isOpen(fold: Record<string, boolean>, key: string, fallback: boolean) {
  return fold[key] ?? fallback;
}
// 넘침: limit을 넘으면 keep개만 보이고 나머지는 "+N 더 보기"로 접는다. 펼친 줄(all)은 전부 보인다.
// 넘칠 때는 작업중(first)인 것을 앞으로 옮기고 전부 보인다 — 지금 일하는 역할이 "더 보기" 뒤에 숨지 않는다.
// 그러고 남은 것이 묶을 만큼(limit - keep 초과)이 못 되면 묶지 않는다.
export function clip<T>(items: T[], limit: number, keep: number, all: boolean, first: (item: T) => boolean = () => false): { shown: T[]; more: T[] } {
  if (items.length <= limit) return { shown: items, more: [] };
  const hot = items.filter(first), ordered = hot.length ? [...hot, ...items.filter((item) => !first(item))] : items;
  const cut = Math.max(keep, hot.length);
  return all || ordered.length - cut <= limit - keep ? { shown: ordered, more: [] } : { shown: ordered.slice(0, cut), more: ordered.slice(cut) };
}
export const isRunning = (unit: Unit) => unit.state === "running";
// 가지인가(감독 줄로 그린다) 잎인가(작업자·검수자 칸으로 그린다).
export function isBranch(node: TreeNode) {
  return node.unit.kind !== "worker" || node.children.length > 0;
}

// SVG 글자는 스스로 줄이지 못한다. 한글은 글자 크기만큼, 그 밖은 0.58배로 어림해 넘치면 …로 자른다.
function textWidth(text: string, size: number) {
  let width = 0;
  for (const ch of text) width += ch.charCodeAt(0) > 0x2e7f ? size : size * 0.58;
  return width;
}
export function fitText(text: string, max: number, size: number) {
  if (textWidth(text, size) <= max) return text;
  let out = "";
  for (const ch of text) { if (textWidth(out + ch + "…", size) > max) break; out += ch; }
  return out + "…";
}

// 발령 전 창고 한 줄: 묶음별 장수. 전부 판이 없을 때만 '판 미지정'을 붙인다.
export function depotLine(rows: Pick<Row, "bucket" | "board">[]) {
  const count = (bucket: string) => rows.filter((r) => r.bucket === bucket).length;
  const planned = count("planned"), hold = count("hold"), other = rows.length - planned - hold;
  const parts = [planned && `진행 전 ${planned}장`, hold && `일시정지 ${hold}장`, other && `그 밖 ${other}장`].filter(Boolean);
  if (rows.length && rows.every((r) => !r.board)) parts.push("판 미지정");
  return parts.join(" · ");
}

// 그림 배치. 칸 크기는 시안 1안을 따르고, 작업자 칸은 그림 폭에 들어가는 만큼만 한 줄에 놓고 다음 줄로 내린다.
// 작업자 칸 폭만 시안(113)보다 3 좁다: 폭 1600 화면의 실제 그림 칸(964)에 다섯 칸이 들어가야 해서다.
export const TREE = {
  SW: 150, DX: 172, DW: 170, INDENT: 16, CX: 396, CW: 110, GAP: 4, RH: 40, BH: 32, FOLDED: 58,
  WORKERS: 5, LONE_W: 152, LONE_H: 44, LONE_ROWS: 2, CRATE: 17, DEFAULT_WIDTH: 980,
  MIN_WIDTH: 620, // 작업자 칸 두 개(CX + 2 × CW + GAP)가 들어가는 폭. 이보다 좁으면 목록으로 보인다
} as const;
export const LONE_KEY = "\u0000lone";
export type Box = { x: number; y: number; w: number; h: number };
export type Cell = Box & { unit: Unit };
export type MoreCell = Box & { key: string; units: Unit[] };
export type RowLayout = {
  key: string; dir: Cell | null; mid: number;
  parent: number; // 상위 감독 줄의 번호. 슈퍼감독 상자에서 바로 나오면 -1
  workers: Cell[]; more: MoreCell | null;
};
export type GroupLayout = { group: Group; open: boolean; box: Box; counts: Count[]; running: number; rows: RowLayout[] };
export type TreeLayout = {
  width: number; height: number; cols: number;
  groups: GroupLayout[];
  lone: { y: number; total: number; cells: Cell[]; more: MoreCell | null } | null;
  depot: { box: Box; crates: { x: number; y: number }[] } | null;
  system: { box: Box; cells: Box[] };
};
export type TreeOptions = {
  width: number; fold: Record<string, boolean>; expanded: ReadonlySet<string>; selected: string | null;
  depot: number; system: number; // 창고 장수, 기반 세션 수
};
export function layoutTree(forest: Forest, { width, fold, expanded, selected, depot, system }: TreeOptions): TreeLayout {
  const T = TREE, w = Math.max(T.MIN_WIDTH, Math.floor(width));
  const cols = Math.max(1, Math.floor((w - T.CX + T.GAP) / (T.CW + T.GAP)));
  const cellAt = (i: number, top: number): Box => ({ x: T.CX + (i % cols) * (T.CW + T.GAP), y: top + Math.floor(i / cols) * T.RH, w: T.CW, h: T.BH });
  let y = 34; // 머리글(슈퍼감독 · 감독 · 작업자·검수자) 아래
  const groups: GroupLayout[] = [];
  for (const group of forest.groups) {
    const top = y, open = isOpen(fold, group.id, defaultOpen(group.units, selected));
    const counts = group.counts;
    const running = group.units.filter((u) => u.state === "running").length;
    const rows: RowLayout[] = [];
    if (open) {
      let rowY = top;
      const add = (key: string, dir: Unit | null, level: number, parent: number, units: Unit[]) => {
        const { shown, more } = clip(units, T.WORKERS, T.WORKERS - 1, expanded.has(key), isRunning);
        rows.push({
          key, parent, mid: rowY + T.BH / 2,
          dir: dir && { unit: dir, x: T.DX + Math.min(level, 2) * T.INDENT, y: rowY, w: T.DW, h: T.BH },
          workers: shown.map((unit, i) => ({ unit, ...cellAt(i, rowY) })),
          more: more.length ? { key, units: more, ...cellAt(shown.length, rowY) } : null,
        });
        rowY += Math.max(1, Math.ceil((shown.length + (more.length ? 1 : 0)) / cols)) * T.RH;
      };
      const leaves = (nodes: TreeNode[]) => nodes.filter((n) => !isBranch(n)).map((n) => n.unit);
      const walk = (nodes: TreeNode[], level: number, parent: number) => {
        for (const node of nodes.filter(isBranch)) {
          const index = rows.length;
          add(node.unit.role, node.unit, level, parent, leaves(node.children));
          walk(node.children, level + 1, index);
        }
      };
      const direct = leaves(group.tops);
      if (direct.length) add(group.id + "\u0000direct", null, 0, -1, direct);
      walk(group.tops, 0, -1);
      const h = Math.max(T.FOLDED, rowY - top - (T.RH - T.BH));
      groups.push({ group, open, counts, running, rows, box: { x: 0, y: top, w: T.SW, h } });
      y = top + h + 20;
    } else {
      groups.push({ group, open, counts, running, rows, box: { x: 0, y: top, w: T.SW, h: T.FOLDED } });
      y = top + T.FOLDED + 12;
    }
  }
  let lone: TreeLayout["lone"] = null;
  if (forest.lone.length) {
    const pitch = T.LONE_W + 8, perRow = Math.max(1, Math.floor((w + 8) / pitch)), limit = perRow * T.LONE_ROWS;
    const { shown, more } = clip(forest.lone, limit, limit - 1, expanded.has(LONE_KEY), isRunning);
    const titleY = y, at = (i: number): Box => ({ x: (i % perRow) * pitch, y: titleY + 28 + Math.floor(i / perRow) * (T.LONE_H + 10), w: T.LONE_W, h: T.LONE_H });
    lone = {
      y: titleY, total: forest.lone.length, cells: shown.map((unit, i) => ({ unit, ...at(i) })),
      more: more.length ? { key: LONE_KEY, units: more, ...at(shown.length) } : null,
    };
    y = titleY + 28 + Math.ceil((shown.length + (more.length ? 1 : 0)) / perRow) * (T.LONE_H + 10) + 12;
  }
  let depotAt: TreeLayout["depot"] = null;
  if (depot > 0) {
    const perRow = Math.max(1, Math.floor((w - T.CX) / T.CRATE)), n = Math.min(depot, perRow * 2);
    depotAt = { box: { x: 0, y, w: T.SW, h: 58 }, crates: Array.from({ length: n }, (_, i) => ({ x: T.CX + (i % perRow) * T.CRATE, y: y + 10 + Math.floor(i / perRow) * 18 })) };
    y += 58 + 20;
  }
  const lines = Math.max(1, Math.ceil(system / cols));
  const systemAt = { box: { x: 0, y, w: T.SW, h: lines * T.RH + 8 }, cells: Array.from({ length: system }, (_, i) => cellAt(i, y + 8)) };
  y += systemAt.box.h + 12;
  return { width: w, height: y, cols, groups, lone, depot: depotAt, system: systemAt };
}
