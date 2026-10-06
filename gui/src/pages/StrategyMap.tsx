import { lazy, Suspense, useState } from "react";
import type { KeyboardEvent } from "react";
import { useResource } from "../resource";
import type { Row, Stamp } from "../types";
import { CardLink, ErrorMessage, Freshness, Loading, time } from "../ui";
import type { LiveSession, OpenAlerts } from "../status-band";
import { buildMap, iso, placeUnits, shortName, STATE_LABEL, TILE_H, TILE_W, visibleUnits, type Base, type Unit } from "../strategy-map";

// 전략 맵(2026-10-05 [kyle]): 현황판과 같은 자료(status)를 슈퍼감독 기지·역할 유닛으로 그린다. 1단계는 SVG 2D 등각.
// 색은 전부 style.css의 클래스로만 준다 — SVG 속성에 색을 적으면 다크 모드 변환(theme.mjs)을 거치지 않는다.
type StatusData = Stamp & {
  rows: Row[]; live: LiveSession[] | null; alerts: OpenAlerts | null; hierarchy: Record<string, string> | null;
};
const KIND_LABEL = { super: "슈퍼감독", director: "감독", worker: "작업자·검수자" } as const;
const SLAB = 10, HEAD_ROOM = 86, FOOT_ROOM = 44, GAP = 56, COLS = 4;
const DEPOT = "\u0000창고"; // 선택 상태에서 창고를 역할 이름과 구분하는 키
// 3D 보기는 누를 때만 불러온다(three.js는 따로 나뉜 파일). 고른 보기는 이 브라우저에만 기억한다(2026-10-06 [kyle]).
const StrategyMap3D = lazy(() => import("./StrategyMap3D"));
type View = "2d" | "3d";
const VIEW_KEY = "kadan-strategy-view";
function readView(): View { try { return localStorage.getItem(VIEW_KEY) === "3d" ? "3d" : "2d"; } catch { return "2d"; } }
function saveView(view: View) { try { localStorage.setItem(VIEW_KEY, view); } catch {} }
// 묶음 이름은 서버 bucketGroups와 같다(2026-10-05 [kyle]).
const BUCKET_LABEL: Record<string, string> = { planned: "진행 전", hold: "일시정지" };

function platform(width: number, depth: number) {
  const c = (x: number, y: number) => { const p = iso(x, y); return `${p.x},${p.y}`; };
  const down = (pt: string) => { const [x, y] = pt.split(",").map(Number); return `${x},${y + SLAB}`; };
  const a = c(-0.5, -0.5), b = c(width - 0.5, -0.5), d = c(width - 0.5, depth - 0.5), e = c(-0.5, depth - 0.5);
  return { top: [a, b, d, e].join(" "), left: [e, d, down(d), down(e)].join(" "), right: [d, b, down(b), down(d)].join(" ") };
}
function bounds(width: number, depth: number) {
  const left = iso(-0.5, depth - 0.5).x, right = iso(width - 0.5, -0.5).x;
  const top = iso(-0.5, -0.5).y, bottom = iso(width - 0.5, depth - 0.5).y + SLAB;
  return { left, right, top, bottom };
}
// 작은 등각 상자 하나. 위·왼쪽·오른쪽 면을 클래스로 칠한다.
function Crate({ x, y, kind }: { x: number; y: number; kind: string }) {
  const s = 7;
  return <g className={"sm-crate sm-c-" + kind}>
    <polygon className="sm-crate-top" points={`${x},${y - s} ${x + s},${y - s / 2} ${x},${y} ${x - s},${y - s / 2}`} />
    <polygon className="sm-crate-left" points={`${x - s},${y - s / 2} ${x},${y} ${x},${y + s} ${x - s},${y + s / 2}`} />
    <polygon className="sm-crate-right" points={`${x + s},${y - s / 2} ${x},${y} ${x},${y + s} ${x + s},${y + s / 2}`} />
  </g>;
}
function crateKinds(unit: Unit) {
  const kinds: string[] = [];
  for (const k of ["stuck", "running", "stale", "planned", "hold"] as const)
    for (let i = 0; i < unit.crates[k]; i++) kinds.push(k === "hold" ? "planned" : k);
  return kinds;
}
function unitLabel(unit: Unit) {
  const work = unit.crates.running + unit.crates.stuck + unit.crates.stale;
  return `${unit.role} · ${KIND_LABEL[unit.kind]} · ${STATE_LABEL[unit.state]}${work ? ` · 진행 카드 ${work}장` : ""}${unit.alerts ? ` · 경보 ${unit.alerts}건` : ""}`;
}
function UnitFigure({ unit, x, y, base, selected, onSelect }: { unit: Unit; x: number; y: number; base: Base; selected: boolean; onSelect: () => void }) {
  const scale = unit.kind === "super" ? 1.3 : unit.kind === "director" ? 1.12 : 1;
  const key = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } };
  const crates = crateKinds(unit), shown = crates.slice(0, 4), name = shortName(unit.role, base.super);
  const badge = unit.state === "dead" ? "✕" : unit.state === "stuck" || unit.alerts ? "!" : null;
  return <g className={`sm-unit sm-k-${unit.kind} sm-s-${unit.state}${selected ? " sm-selected" : ""}`} transform={`translate(${x} ${y})`}
    role="button" tabIndex={0} aria-label={unitLabel(unit)} aria-pressed={selected} onClick={onSelect} onKeyDown={key}>
    <title>{unitLabel(unit)}</title>
    <ellipse className="sm-hit" cx={0} cy={-18} rx={24} ry={34} />
    {selected && <ellipse className="sm-ring" cx={0} cy={0} rx={22} ry={10} />}
    <ellipse className="sm-shadow" cx={0} cy={0} rx={15} ry={6} />
    <g transform={`scale(${scale})`}>
      <g className="sm-figure">
        <path className="sm-body" d="M-10,-2 Q-11,-24 0,-26 Q11,-24 10,-2 Q0,3 -10,-2 Z" />
        <circle className="sm-head" cx={0} cy={-32} r={7.5} />
        {unit.kind === "super" && <path className="sm-crown" d="M-7,-40 L-7,-45 L-3.5,-42 L0,-47 L3.5,-42 L7,-45 L7,-40 Z" />}
        {unit.kind === "director" && <g className="sm-flag"><line x1={9} y1={-14} x2={9} y2={-44} /><path d="M9,-44 L21,-40 L9,-36 Z" /></g>}
      </g>
    </g>
    {badge && <g className="sm-badge" transform={`translate(${12 * scale} ${-50 * scale})`}><circle r={8} /><text y={3.5}>{badge}</text></g>}
    {shown.map((kind, i) => <Crate key={i} x={20 + (i % 2) * 11} y={-2 - Math.floor(i / 2) * 9 + (i % 2) * 5} kind={kind} />)}
    {crates.length > shown.length && <text className="sm-more" x={38} y={-14}>+{crates.length - shown.length}</text>}
    <text className="sm-label" y={20}>{name.length > 11 ? name.slice(0, 10) + "…" : name}</text>
  </g>;
}

// 발령 전 창고: 담당이 아직 없는 실행. 진행 전·일시정지로 나눠 보이고, 많으면 40장씩 더 본다.
function Depot({ rows, close }: { rows: Row[]; close: () => void }) {
  const [limit, setLimit] = useState(40);
  const groups = ["planned", "hold"].map((b) => [b, rows.filter((r) => r.bucket === b)] as const)
    .concat([["other", rows.filter((r) => r.bucket !== "planned" && r.bucket !== "hold")] as const]).filter(([, list]) => list.length);
  let left = limit;
  return <>
    <header className="sm-side-head"><h2>발령 전 창고</h2><button type="button" onClick={close}>닫기</button></header>
    <p className="sm-depot-note">담당이 아직 정해지지 않은 실행 {rows.length}건입니다. 발령하거나, 더 필요 없으면 취소·대체로 정리합니다.</p>
    {groups.map(([b, list]) => { const shown = list.slice(0, Math.max(0, left)); left -= shown.length; return <section key={b}>
      <h3>{BUCKET_LABEL[b] ?? "그 밖"} {list.length}장</h3>
      {shown.length > 0 && <ul className="sm-cards">{shown.map((row) => <li key={row.key}>
        <span className={"sm-dot sm-c-" + (b === "other" ? "planned" : b)} /><CardLink row={row} />
        <small>{[row.repo, row.board || "판 미지정", row.signalAt ? "마지막 신호 " + time(row.signalAt) : ""].filter(Boolean).join(" · ")}</small></li>)}</ul>}
    </section>; })}
    {rows.length > limit && <button type="button" onClick={() => setLimit((n) => n + 40)}>다음 40장 · 남은 {rows.length - limit}장</button>}
  </>;
}

export default function StrategyMap() {
  const resource = useResource<StatusData>("status"), data = resource.data;
  const [selected, setSelected] = useState<string | null>(null);
  const [showResting, setShowResting] = useState(false);
  const [view, setView] = useState<View>(readView);
  const pick = (key: string) => setSelected((now) => (now === key ? null : key));
  const map = data ? buildMap({ hierarchy: data.hierarchy ?? null, rows: data.rows, live: data.live, alerts: data.alerts }) : null;
  // 기지를 가로로 늘어놓는다. 기지마다 자기 배치의 경계로 너비를 잡는다.
  let cursor = 0, height = 0;
  // 보이는 유닛이 하나도 없는 기지(쉬는 역할만 있는 기지)는 숨긴다. '쉬는 역할도 보기'를 켜면 다시 보인다.
  const layouts = (map?.bases ?? []).filter((base) => visibleUnits(base.units, showResting).length > 0).map((base) => {
    const placement = placeUnits(visibleUnits(base.units, showResting), COLS), box = bounds(placement.width, placement.depth);
    const ox = cursor - box.left, oy = HEAD_ROOM - box.top;
    cursor += box.right - box.left + GAP;
    height = Math.max(height, oy + box.bottom + FOOT_ROOM);
    return { base, placement, box, ox, oy, slab: platform(placement.width, placement.depth) };
  });
  const depotX = cursor + 60, width = Math.max(map?.depot ? depotX + 70 : cursor - GAP + 8, 320);
  const unit = map?.bases.flatMap((b) => b.units).find((u) => u.role === selected) ?? null;
  const resting = map ? map.bases.reduce((n, b) => n + b.units.length - visibleUnits(b.units, false).length, 0) : 0;
  const tone = (n: number, cls: string) => (n > 0 ? cls : undefined);
  return <section className="sm-view">
    <header className="st-lead"><h1>전략 맵</h1>
      <p>슈퍼감독마다 기지 하나, 역할마다 유닛 하나입니다. 유닛 옆 상자는 그 역할이 든 카드입니다. 유닛을 누르면 옆 칸(좁은 화면에서는 아래)에 그 역할의 카드가 보입니다. 숫자의 기준은 <a href="#status">전체 현황</a>과 같습니다.</p>
      <small>수집 {time(data?.collectedAt)}</small></header>
    <ErrorMessage error={resource.error} /><Freshness collectedAt={data?.collectedAt} {...resource} />
    {!data || !map ? <Loading /> : <>
      <p className="sm-totals" role="group" aria-label="지도 요약">
        <span><b>{map.totals.units - (showResting ? 0 : resting)}</b> 유닛{!showResting && resting > 0 ? ` · 쉬는 ${resting} 숨김` : ""}</span>
        <span className={tone(map.totals.running, "sm-t-running")}><b>{map.totals.running}</b> 작업중 상자</span>
        <span className={tone(map.totals.stuck, "sm-t-stuck")}><b>{map.totals.stuck}</b> 막힌 상자</span>
        <span><b>{map.totals.stale}</b> 오래된 미정리 상자</span>
        <span className={tone(map.totals.dead, "sm-t-dead")}><b>{map.totals.dead}</b> 창 없음</span>
        <span><b>{map.totals.alerts}</b> 열린 경보</span>
        {data.live === null && <span>세션 상태를 지금 알 수 없습니다.</span>}
        {!data.hierarchy && <span>관계표가 없어 모든 역할을 한 기지에 모았습니다.</span>}
      </p>
      <ul className="sm-legend" aria-label="색 안내">
        {(["running", "stuck", "stale", "dead", "idle", "off"] as const).map((s) => <li key={s}><i className={"sm-dot sm-s-" + s} />{STATE_LABEL[s]}</li>)}
        <li><i className="sm-dot sm-k-super-dot" />왕관 = 슈퍼감독 · 깃발 = 감독</li>
        <li className="sm-viewswitch" role="group" aria-label="지도 보기">{(["2d", "3d"] as const).map((v) =>
          <button key={v} type="button" aria-pressed={view === v} onClick={() => { setView(v); saveView(v); }}>{v.toUpperCase()}</button>)}</li>
        {resting > 0 && <li><label className="sm-toggle"><input type="checkbox" checked={showResting} onChange={(e) => setShowResting(e.target.checked)} />쉬는 역할도 보기({resting})</label></li>}
      </ul>
      <div className="sm-layout">
        <div className="sm-stage">
          {map.bases.length === 0 && !map.depot ? <p className="st-empty">지도에 올릴 역할이 없습니다.</p> : view === "3d" ?
            <Suspense fallback={<Loading />}><StrategyMap3D bases={map.bases} depot={map.depot} showResting={showResting}
              selected={selected} depotKey={DEPOT} onSelect={pick} /></Suspense> :
            <svg className="sm-svg" width={width} height={Math.max(height, 200)} viewBox={`0 0 ${width} ${Math.max(height, 200)}`}
              role="group" aria-label="기지와 유닛 지도">
              {layouts.map(({ base, placement, box, ox, oy, slab }) => <g key={base.id} transform={`translate(${ox} ${oy})`} className="sm-base">
                <polygon className="sm-plat-left" points={slab.left} />
                <polygon className="sm-plat-right" points={slab.right} />
                <polygon className={"sm-plat-top" + (base.super ? "" : " sm-plat-outside")} points={slab.top} />
                {placement.placed.map(({ gx, gy }) => { const p = iso(gx, gy); return <ellipse key={`${gx}-${gy}`} className="sm-tile" cx={p.x} cy={p.y} rx={TILE_W / 2 - 8} ry={TILE_H / 2 - 4} />; })}
                {placement.placed.map(({ unit: u, gx, gy }) => { const p = iso(gx, gy); return <UnitFigure key={u.role} unit={u} base={base} x={p.x} y={p.y}
                  selected={selected === u.role} onSelect={() => setSelected(selected === u.role ? null : u.role)} />; })}
                <text className="sm-base-label" x={(box.left + box.right) / 2} y={box.bottom + 24}>{base.label} · 유닛 {placement.placed.length}{placement.placed.length < base.units.length ? ` (쉬는 ${base.units.length - placement.placed.length})` : ""}</text>
              </g>)}
              {map.depot > 0 && <g className={"sm-depot" + (selected === DEPOT ? " sm-selected" : "")} transform={`translate(${depotX} ${HEAD_ROOM + TILE_H})`}
                role="button" tabIndex={0} aria-pressed={selected === DEPOT} aria-label={`발령 전 창고 · 담당이 아직 없는 실행(진행 전·일시정지) ${map.depot}건`}
                onClick={() => setSelected(selected === DEPOT ? null : DEPOT)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(selected === DEPOT ? null : DEPOT); } }}>
                <title>{`담당이 아직 없는 실행(진행 전·일시정지) ${map.depot}건`}</title>
                <ellipse className="sm-hit" cx={0} cy={6} rx={44} ry={34} />
                {selected === DEPOT && <ellipse className="sm-ring" cx={0} cy={10} rx={30} ry={13} />}
                {[0, 1, 2, 3, 4].map((i) => <Crate key={i} x={(i % 3) * 13 - 13} y={-Math.floor(i / 3) * 11 + (i % 3) * 5} kind="planned" />)}
                <text className="sm-base-label" y={36}>발령 전 창고 {map.depot}</text>
              </g>}
            </svg>}
        </div>
        <aside className="sm-side" aria-live="polite">
          {selected === DEPOT ? <Depot rows={map.depotRows} close={() => setSelected(null)} />
          : !unit ? <p className="st-empty">유닛이나 발령 전 창고를 누르면 상태와 카드가 여기에 보입니다.</p> : <>
            <header className="sm-side-head"><h2>{unit.role}</h2><button type="button" onClick={() => setSelected(null)}>닫기</button></header>
            <dl className="sm-facts">
              <dt>상태</dt><dd><i className={"sm-dot sm-s-" + unit.state} />{STATE_LABEL[unit.state]}</dd>
              <dt>종류</dt><dd>{KIND_LABEL[unit.kind]}</dd>
              <dt>직속 상위</dt><dd>{unit.parent ?? (unit.kind === "super" ? "사용자" : "관계표에 없음")}</dd>
              <dt>모델</dt><dd>{unit.model ?? (unit.alive === false ? "창 없음" : "모름")}</dd>
              <dt>경보</dt><dd>{unit.alerts ? `${unit.alerts}건` : "없음"}</dd>
            </dl>
            <h3>진행 카드 {unit.rows.length}장</h3>
            {unit.rows.length ? <ul className="sm-cards">{unit.rows.map((row) => <li key={row.key}>
              <span className={"sm-dot sm-c-" + row.bucket} /><CardLink row={row} />
              <small>{row.healthLabel}{row.signalAt ? ` · 마지막 신호 ${time(row.signalAt)}` : ""}</small></li>)}</ul>
              : <p className="st-empty">진행 중인 카드가 없습니다.</p>}
          </>}
        </aside>
      </div>
    </>}
  </section>;
}
