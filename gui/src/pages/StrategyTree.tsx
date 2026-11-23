import { useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { KIND_LABEL, shortName, STATE_LABEL, systemSessions, type MapModel, type Unit, type UnitState } from "../strategy-map";
import type { LiveSession } from "../status-band";
import {
  buildForest, clip, defaultOpen, depotLine, fitText, flatten, harnessName, isBranch, isOpen, isRunning, layoutTree, LONE_KEY, shapeOf, stateCounts, TREE,
  type Box, type Cell, type Count, type Forest, type Group, type MoreCell, type TreeNode,
} from "../strategy-tree";

// 전략 맵 '나무' 보기(2026-11-23 [kyle]). 넓으면 시안 1안 그림(판 → 감독 → 지시 → 작업자·검수자), 좁으면 접는 목록.
// 색은 전부 style.css의 클래스로만 준다(2D와 같은 이유: SVG 속성의 색은 다크 모드 변환을 거치지 않는다).
const NARROW = "(max-width: 799px)";
const LIST_LIMIT = 8, LIST_KEEP = 6;
const DEPOT_NOTE = "담당이 정해지지 않은 카드 (누르면 옆 칸에 목록)";
const SYSTEM_KEY = "\u0000system";
const press = (run: () => void) => (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); run(); } };
const harnessLabel = (unit: Unit) => harnessName(unit) ?? "세션";
const unitLine = (unit: Unit) => `${harnessLabel(unit)} · ${STATE_LABEL[unit.state]}`;
// 칸 둘째 줄("실행 도구 · 상태")이 칸보다 길면 상태만 남긴다. 실행 도구는 모양으로도 보인다.
const fitLine = (full: string, state: string, max: number) => (fitText(full, max, 9.5) === full ? full : full.endsWith(state) ? fitText(state, max, 9.5) : fitText(full, max, 9.5));
// 기반 세션 칸의 생존 줄. PID가 기록과 다르면 아래 기반 세션 표와 같은 낱말로 알린다.
const sessionLife = (s: LiveSession) => (s.pidState === "match" ? "살아 있음" : "PID 변경 · 확인 필요");
const unitTitle = (unit: Unit) => `${unit.role} · ${KIND_LABEL[unit.kind]} · ${unitLine(unit)}${unit.alerts ? ` · 경보 ${unit.alerts}건` : ""}`;

// 모양 = 실행 도구, 색 = 상태. 창 없음은 가운데 ✕ 금.
function ShapeMark({ harness, state, cx, cy, r }: { harness: string | null; state: UnitState; cx: number; cy: number; r: number }) {
  const shape = shapeOf(harness), cls = `smt-shape sm-s-${state}${shape === "none" ? " smt-nohar" : ""}`, k = r * 0.45;
  return <>
    {shape === "square" ? <rect className={cls} x={cx - r} y={cy - r} width={2 * r} height={2 * r} rx={1.5} />
      : shape === "triangle" ? <polygon className={cls} points={`${cx},${cy - r - 1} ${cx + r + 1},${cy + r} ${cx - r - 1},${cy + r}`} />
      : <circle className={cls} cx={cx} cy={cy} r={r} />}
    {state === "dead" && shape !== "none" && <path className="smt-x" d={`M${cx - k},${cy - k}L${cx + k},${cy + k}M${cx + k},${cy - k}L${cx - k},${cy + k}`} />}
  </>;
}
function ShapeIcon({ harness, state, size = 13 }: { harness: string | null; state: UnitState; size?: number }) {
  return <svg className="smt-icon" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
    <ShapeMark harness={harness} state={state} cx={size / 2} cy={size / 2} r={size * 0.36} /></svg>;
}
function Roll({ counts }: { counts: Count[] }) {
  return <span className="smt-roll">{counts.map((c) => <span key={c.state} title={STATE_LABEL[c.state]}><i className={"sm-dot sm-s-" + c.state} />{c.n}</span>)}</span>;
}

// 범례 줄(나무 보기에서만): 실행 도구별 수와 모양, 상자 모양의 뜻.
export function TreeLegend({ forest }: { forest: Forest }) {
  return <>
    <li>{(["claude", "codex", "agy"] as const).map((h, i) => <span key={h} className="smt-legend-run">{i > 0 && "· "}<ShapeIcon harness={h} state="idle" />{h} {forest.harness[h]}</span>)}</li>
    <li>큰 상자 = 슈퍼감독 · 둥근 상자 = 감독</li>
  </>;
}

type Common = { selected: string | null; onSelect: (key: string) => void };
type Variant = "super" | "director" | "worker";
// 유닛 상자 하나. 누르면 옆 칸이 열린다(2D의 유닛과 같은 동작).
function UnitBox({ cell, variant, sup, lines, selected, onSelect }: Common & { cell: Cell; variant: Variant; sup: string | null; lines?: string[] }) {
  const { unit, x, y, w, h } = cell, on = selected === unit.role, tall = h > 40;
  const rx = variant === "director" ? h / 2 : variant === "super" ? 8 : 6, pick = () => onSelect(unit.role);
  const name = variant === "super" ? unit.role : shortName(unit.role, sup);
  const reserve = variant === "super" && lines ? 54 : 34; // 판 상자는 접기 단추 자리를 비운다
  const textY = lines ? y + h / 2 - 6 : y + (tall ? 16 : 14);
  return <g className={`smt-unit smt-${variant}${on ? " smt-on" : ""}`} role="button" tabIndex={0} aria-label={unitTitle(unit)} aria-pressed={on}
    onClick={pick} onKeyDown={press(pick)}>
    <title>{unitTitle(unit)}</title>
    <rect className="smt-frame" x={x} y={y} width={w} height={h} rx={rx} />
    <ShapeMark harness={harnessName(unit)} state={unit.state} cx={x + (lines ? 16 : 14)} cy={lines ? y + h / 2 - 10 : y + h / 2} r={5.5} />
    <text className="smt-t1" x={x + (lines ? 29 : 27)} y={textY}>{fitText(name, w - reserve, 11.5)}</text>
    {(lines ?? [unitLine(unit)]).map((line, i) => <text key={i} className="smt-t2" x={x + (lines ? 29 : 27)} y={lines ? textY + 14 + i * 13 : y + (tall ? 30 : 26)}>
      {fitLine(line, STATE_LABEL[unit.state], w - (lines ? 36 : variant === "director" ? 40 : 30))}</text>)}
    {on && <rect className="smt-sel" x={x - 3} y={y - 3} width={w + 6} height={h + 6} rx={rx + 2} />}
  </g>;
}
function MoreBox({ cell, onMore }: { cell: MoreCell; onMore: (key: string) => void }) {
  const label = `+${cell.units.length} 더 보기`, names = cell.units.map((u) => u.role).join(", "), run = () => onMore(cell.key);
  return <g className="smt-more" role="button" tabIndex={0} aria-label={`${label}: ${names}`} onClick={run} onKeyDown={press(run)}>
    <title>{`${label}: ${names}`}</title>
    <rect className="smt-frame" x={cell.x} y={cell.y} width={cell.w} height={cell.h} rx={6} />
    <text className="smt-t1" x={cell.x + cell.w / 2} y={cell.y + cell.h / 2 + 4} textAnchor="middle">{label}</text>
  </g>;
}
function FoldMark({ box, open, label, onToggle }: { box: Box; open: boolean; label: string; onToggle: () => void }) {
  const x = box.x + box.w - 28, y = box.y + 4;
  return <g className="smt-fold" role="button" tabIndex={0} aria-expanded={open} aria-label={`${label} 하위 역할`} onClick={onToggle} onKeyDown={press(onToggle)}>
    <rect className="smt-hit" x={x} y={y} width={24} height={24} rx={5} />
    <path className="smt-chev" d={open ? `M${x + 7},${y + 10} l5,5 l5,-5` : `M${x + 10},${y + 7} l5,5 l-5,5`} />
  </g>;
}

type TreeProps = Common & {
  forest: Forest; model: MapModel; sessions: LiveSession[] | null; width: number;
  fold: Record<string, boolean>; expanded: ReadonlySet<string>; onFold: (key: string, open: boolean) => void; onMore: (key: string) => void; depotKey: string;
};
function TreeSvg({ forest, model, sessions, width, fold, expanded, selected, onSelect, onFold, onMore, depotKey }: TreeProps) {
  const T = TREE, layout = layoutTree(forest, { width, fold, expanded, selected, depot: model.depot, system: sessions?.length ?? 0 });
  const W = layout.width, common = { selected, onSelect }, pickDepot = () => onSelect(depotKey);
  const rule = (y: number) => <line className="smt-rule" x1={0} x2={W} y1={y} y2={y} />;
  return <svg className="sm-svg smt-svg" width={W} height={layout.height} viewBox={`0 0 ${W} ${layout.height}`} role="group" aria-label="판과 역할 나무">
    <text className="smt-hd" x={0} y={16}>{KIND_LABEL.super}</text><text className="smt-hd" x={T.DX} y={16}>{KIND_LABEL.director}</text>
    <text className="smt-hd" x={T.CX} y={16}>{KIND_LABEL.worker}</text>{rule(24)}
    {layout.groups.map(({ group, open, box, counts, running, rows }) => {
      const midY = box.y + box.h / 2, total = `유닛 ${group.units.length}${running ? ` · 작업중 ${running}` : ""}`;
      return <g key={group.id} className="smt-group">
        {rows.map((row) => {
          const dir = row.dir, from = dir ? dir.x : T.CX - 24, bend = dir ? 12 : 30;
          const up = row.parent >= 0 ? rows[row.parent] : null;
          return <g key={row.key}>
            {up?.dir ? <path className="smt-link" d={`M${up.dir.x + 10},${up.dir.y + up.dir.h} V${row.mid} H${from}`} />
              : <path className="smt-link" d={`M${box.w},${midY} C${box.w + bend},${midY} ${from - bend},${row.mid} ${from},${row.mid}`} />}
            {dir && (row.workers.length > 0 || row.more) && <g className="smt-arrow">
              <line x1={dir.x + dir.w} y1={row.mid} x2={T.CX - 6} y2={row.mid} />
              <polygon points={`${T.CX - 6},${row.mid - 4} ${T.CX},${row.mid} ${T.CX - 6},${row.mid + 4}`} />
              <text className="smt-t2" x={(dir.x + dir.w + T.CX) / 2 - 10} y={row.mid - 4}>지시</text></g>}
            {dir && <UnitBox cell={dir} variant="director" sup={group.root?.role ?? null} {...common} />}
            {row.workers.map((cell) => <UnitBox key={cell.unit.role} cell={cell} variant="worker" sup={group.root?.role ?? null} {...common} />)}
            {row.more && <MoreBox cell={row.more} onMore={onMore} />}
          </g>;
        })}
        {group.root ? <UnitBox cell={{ unit: group.root, ...box }} variant="super" sup={null} lines={[unitLine(group.root), total]} {...common} />
          : <g className="smt-unit smt-super smt-outside"><rect className="smt-frame" x={box.x} y={box.y} width={box.w} height={box.h} rx={8} />
            <text className="smt-t1" x={14} y={midY - 2}>{fitText(group.label, box.w - 44, 11.5)}</text><text className="smt-t2" x={14} y={midY + 12}>{total}</text></g>}
        <FoldMark box={box} open={open} label={group.label} onToggle={() => onFold(group.id, !open)} />
        {!open && counts.map((c, i) => <g key={c.state} className="smt-count" transform={`translate(${T.DX + i * 44} ${midY})`}>
          <title>{STATE_LABEL[c.state]}</title><circle className={"smt-shape sm-s-" + c.state} r={5} cx={5} /><text className="smt-t1" x={15} y={4}>{c.n}</text></g>)}
      </g>;
    })}
    {layout.lone && <g className="smt-lone">
      <text className="smt-hd" x={0} y={layout.lone.y + 10}>하위 역할 없는 슈퍼감독 {layout.lone.total}</text>{rule(layout.lone.y + 18)}
      {layout.lone.cells.map((cell) => <UnitBox key={cell.unit.role} cell={cell} variant="super" sup={null} {...common} />)}
      {layout.lone.more && <MoreBox cell={layout.lone.more} onMore={onMore} />}
    </g>}
    {layout.depot && <g className={"smt-depot" + (selected === depotKey ? " smt-on" : "")} role="button" tabIndex={0} aria-pressed={selected === depotKey}
      aria-label={`발령 전 창고 · 담당이 아직 없는 실행(진행 전·일시정지) ${model.depot}건`} onClick={pickDepot} onKeyDown={press(pickDepot)}>
      <title>{`담당이 아직 없는 실행(진행 전·일시정지) ${model.depot}건`}</title>
      <rect className="smt-hit" x={0} y={layout.depot.box.y} width={W} height={layout.depot.box.h} />
      <rect className="smt-frame" x={0} y={layout.depot.box.y} width={T.SW} height={layout.depot.box.h} rx={8} />
      <text className="smt-t1" x={14} y={layout.depot.box.y + 24}>발령 전 창고</text>
      <text className="smt-t2" x={14} y={layout.depot.box.y + 40}>{fitText(depotLine(model.depotRows), T.SW - 22, 9.5)}</text>
      {layout.depot.crates.map((c, i) => <rect key={i} className="smt-crate" x={c.x} y={c.y} width={11} height={11} rx={2} />)}
      <text className="smt-t2" x={T.CX} y={layout.depot.box.y + layout.depot.box.h - 4}>{DEPOT_NOTE}</text>
      {selected === depotKey && <rect className="smt-sel" x={-3} y={layout.depot.box.y - 3} width={T.SW + 6} height={layout.depot.box.h + 6} rx={10} />}
    </g>}
    <g className="smt-system">
      <rect className="smt-frame" x={0} y={layout.system.box.y} width={T.SW} height={layout.system.box.h} rx={8} />
      <text className="smt-t1" x={14} y={layout.system.box.y + layout.system.box.h / 2 + 4}>기반 세션</text>
      {!sessions?.length && <text className="smt-t2" x={T.CX} y={layout.system.box.y + layout.system.box.h / 2 + 4}>
        {sessions === null ? "세션 상태를 지금 알 수 없습니다." : "열린 기반 세션(감시기·대시보드)이 없습니다."}</text>}
      {(sessions ?? []).map((s, i) => { const c = layout.system.cells[i]; return <g key={s.role}><title>{s.role}</title>
        <rect className="smt-frame" x={c.x} y={c.y} width={c.w} height={c.h} rx={6} /><ShapeMark harness={null} state="idle" cx={c.x + 14} cy={c.y + c.h / 2} r={5.5} />
        <text className="smt-t1" x={c.x + 27} y={c.y + 14}>{fitText(s.role, c.w - 34, 11.5)}</text><text className="smt-t2" x={c.x + 27} y={c.y + 26}>{fitText(sessionLife(s), c.w - 30, 9.5)}</text></g>; })}
    </g>
  </svg>;
}

// 좁은 화면: 같은 나무를 접는 목록으로. 접은 줄에는 하위 상태 개수가 합쳐 보인다.
export function TreeList({ forest, model, sessions, fold, expanded, selected, onSelect, onFold, onMore, depotKey }: Omit<TreeProps, "width">) {
  const line = (key: string, head: ReactNode, counts: Count[], open: boolean, label: string, body: () => ReactNode, big = false) => <div key={key} className={"smt-node" + (big ? " smt-big" : "")}>
    <div className="smt-row">
      <button type="button" className="smt-toggle" aria-expanded={open} aria-label={label} onClick={() => onFold(key, !open)}>
        <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden="true"><path className="smt-chev" d={open ? "M2,5 l5,5 l5,-5" : "M5,2 l5,5 l-5,5"} /></svg></button>
      {head}<Roll counts={counts} />
    </div>
    {open && <div className="smt-kids">{body()}</div>}
  </div>;
  const pick = (unit: Unit, name: string, tag: string) => <button type="button" className={"smt-pick" + (selected === unit.role ? " smt-on" : "")}
    aria-pressed={selected === unit.role} title={unit.role} onClick={() => onSelect(unit.role)}>
    <ShapeIcon harness={harnessName(unit)} state={unit.state} /><span className="smt-nm">{name}</span><span className="smt-tag">{tag}</span></button>;
  // 감독 줄(가지)은 접지 않고 전부 보인다. 넘침 묶음은 작업자·검수자(잎)만 — 그림의 감독 줄·작업자 칸과 같은 규칙이다.
  // 하위 없는 슈퍼감독 묶음(bundle)은 그림처럼 전부를 묶음 대상으로 본다.
  const kids = (key: string, nodes: TreeNode[], sup: string | null, bundle = false) => {
    const branches = bundle ? [] : nodes.filter(isBranch), leaves = bundle ? nodes : nodes.filter((n) => !isBranch(n));
    const { shown, more } = clip(leaves, LIST_LIMIT, LIST_KEEP, expanded.has(key), (n) => isRunning(n.unit));
    return <>{branches.map((n) => node(n, sup))}{shown.map((n) => node(n, sup))}{more.length > 0 && <button type="button" className="smt-more-row" onClick={() => onMore(key)}>+{more.length} 더 보기</button>}</>;
  };
  const node = (n: TreeNode, sup: string | null): ReactNode => {
    const name = shortName(n.unit.role, sup);
    if (!n.children.length) return <div key={n.unit.role} className="smt-row smt-leaf">{pick(n.unit, name, unitLine(n.unit))}</div>;
    const below = n.children.flatMap(flatten);
    return line(n.unit.role, pick(n.unit, name, `${unitLine(n.unit)} · 하위 ${below.length}`), stateCounts(below), isOpen(fold, n.unit.role, defaultOpen(below, selected)),
      `${n.unit.role} 하위 역할`, () => kids(n.unit.role, n.children, sup));
  };
  const group = (g: Group) => {
    const open = isOpen(fold, g.id, defaultOpen(g.units, selected)), sup = g.root?.role ?? null, count = `유닛 ${g.units.length}`;
    const head = g.root ? pick(g.root, g.root.role, `${KIND_LABEL.super} · ${harnessLabel(g.root)} · ${count}`)
      : <span className="smt-pick smt-plain"><span className="smt-nm">{g.label}</span><span className="smt-tag">{count}</span></span>;
    return line(g.id, head, g.counts, open, `${g.label} 하위 역할`, () => kids(g.id, g.tops, sup), true);
  };
  const loneOpen = isOpen(fold, LONE_KEY, defaultOpen(forest.lone, selected)), systemOpen = isOpen(fold, SYSTEM_KEY, true);
  const title = (text: string) => <span className="smt-pick smt-plain"><span className="smt-nm">{text}</span></span>;
  return <div className="smt-list">
    {forest.groups.map(group)}
    {forest.lone.length > 0 && line(LONE_KEY, title(`하위 역할 없는 슈퍼감독 ${forest.lone.length}`), stateCounts(forest.lone), loneOpen, "하위 역할 없는 슈퍼감독",
      () => kids(LONE_KEY, forest.lone.map((unit) => ({ unit, children: [] })), null, true))}
    {model.depot > 0 && <div className="smt-node"><div className="smt-row smt-leaf">
      <button type="button" className={"smt-pick" + (selected === depotKey ? " smt-on" : "")} aria-pressed={selected === depotKey} onClick={() => onSelect(depotKey)}>
        <span className="smt-nm">발령 전 창고 {model.depot}</span><span className="smt-tag">{depotLine(model.depotRows)}</span></button></div>
      <p className="smt-note">{DEPOT_NOTE}</p></div>}
    {line(SYSTEM_KEY, title(`기반 세션${sessions ? ` ${sessions.length}` : ""}`), [], systemOpen, "기반 세션", () => !sessions?.length
      ? <p className="smt-note">{sessions === null ? "세션 상태를 지금 알 수 없습니다." : "열린 기반 세션(감시기·대시보드)이 없습니다."}</p>
      : sessions.map((s) => <div key={s.role} className="smt-row smt-leaf"><span className="smt-pick smt-plain">
        <ShapeIcon harness={null} state="idle" /><span className="smt-nm">{s.role}</span><span className="smt-tag">{sessionLife(s)}</span></span></div>))}
  </div>;
}

export default function StrategyTree({ model, live, showResting, selected, depotKey, onSelect }: Common & { model: MapModel; live: LiveSession[] | null; showResting: boolean; depotKey: string }) {
  const host = useRef<HTMLDivElement>(null);
  // 그림 폭은 실제 칸 폭을 재서 정한다. 재기 전(서버 렌더·첫 그림)에는 시안 폭으로 그린다.
  const [width, setWidth] = useState<number>(TREE.DEFAULT_WIDTH), [narrow, setNarrow] = useState(false);
  const [fold, setFold] = useState<Record<string, boolean>>({}), [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set<string>());
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const query = matchMedia(NARROW), measure = () => { setWidth(Math.floor(el.clientWidth)); setNarrow(query.matches); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    query.addEventListener("change", measure);
    return () => { observer.disconnect(); query.removeEventListener("change", measure); };
  }, []);
  const forest = buildForest(model.bases, showResting);
  const shared = {
    forest, model, sessions: systemSessions(live), fold, expanded, selected, onSelect, depotKey,
    onFold: (key: string, open: boolean) => setFold((now) => ({ ...now, [key]: open })),
    onMore: (key: string) => setExpanded((now) => new Set(now).add(key)),
  };
  return <div className="smt-host" ref={host}>
    {narrow || width < TREE.MIN_WIDTH ? <TreeList {...shared} /> : <TreeSvg {...shared} width={width} />}
  </div>;
}
