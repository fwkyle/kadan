import { useContext, useState } from "react";
import { useResource } from "../resource";
import type { Row, Stamp } from "../types";
import { AppContext, CardLink, ErrorMessage, Freshness, Loading, Pulse, Roll, Spark, time } from "../ui";
import { liveLabel } from "../status-band";
import type { LastRun } from "../strategy-map";
import type { LiveSession, OpenAlerts } from "../status-band";
import AskSuper from "../AskSuper";
import { RestartRole } from "./RestartRole";
import { buildMap, KIND_LABEL, lifeLabel, restartGeneration, runLabel, systemSessions, STATE_LABEL, visibleUnits } from "../strategy-map";
import { buildForest } from "../strategy-tree";
import StrategyTree, { TreeLegend } from "./StrategyTree";

// 전략 맵(2026-10-05 [kyle]): 현황판과 같은 자료(status)를 판(슈퍼감독) → 감독 → 작업자·검수자 나무로 그린다.
// 그림은 나무 보기 하나다(2026-11-23 [kyle]: 2D 등각·3D 보기는 뺐다). 그리기는 StrategyTree, 배치 계산은 strategy-tree.ts.
type StatusData = Stamp & {
  rows: Row[]; live: LiveSession[] | null; alerts: OpenAlerts | null; hierarchy: Record<string, string> | null;
  activity?: Record<string, number[]>; lastRuns?: Record<string, LastRun>;
};
const DEPOT = "\u0000창고"; // 선택 상태에서 창고를 역할 이름과 구분하는 키
// 묶음 이름은 서버 bucketGroups와 같다(2026-10-05 [kyle]).
const BUCKET_LABEL: Record<string, string> = { planned: "진행 전", hold: "일시정지" };

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

export default function StrategyMap({ url }: { url: URL }) {
  const { readOnly } = useContext(AppContext);
  const resource = useResource<StatusData>("status"), data = resource.data;
  const [selected, setSelected] = useState<string | null>(null);
  const [showResting, setShowResting] = useState(false);
  const pick = (key: string) => setSelected((now) => (now === key ? null : key));
  const map = data ? buildMap({ hierarchy: data.hierarchy ?? null, rows: data.rows, live: data.live, alerts: data.alerts, lastRuns: data.lastRuns }) : null;
  const unit = map?.bases.flatMap((b) => b.units).find((u) => u.role === selected) ?? null;
  const unitBase = unit ? map?.bases.find((b) => b.units.includes(unit)) ?? null : null;
  const resting = map ? map.bases.reduce((n, b) => n + b.units.length - visibleUnits(b.units, false).length, 0) : 0;
  const tone = (n: number, cls: string) => (n > 0 ? cls : undefined);
  const forest = map ? buildForest(map.bases, showResting) : null;
  return <section className="sm-view">
    <header className="st-lead"><h1>전략 맵</h1>
      <p>슈퍼감독마다 판 하나, 그 아래 감독과 작업자·검수자가 이어집니다. 칸을 누르면 옆 칸(좁은 화면에서는 아래)에 그 역할의 카드가 보입니다. 숫자의 기준은 <a href="#status">전체 현황</a>과 같습니다.</p>
      <small>수집 {time(data?.collectedAt)}</small></header>
    {url.hash === "#sessions" && <p className="muted">담당자 상태는 전략 맵으로 옮겼습니다. 유닛을 누르면 옆 칸에 생존·실행 도구·모델과 다시 띄우기가 있습니다.</p>}
    <ErrorMessage error={resource.error} /><Freshness collectedAt={data?.collectedAt} {...resource} />
    {!data || !map || !forest ? <Loading /> : <>
      <p className="sm-totals" role="group" aria-label="지도 요약">
        <span><Roll value={forest.boards} /> 판</span>
        <span><Roll value={map.totals.units - (showResting ? 0 : resting)} /> 유닛{!showResting && resting > 0 ? ` · 쉬는 ${resting} 숨김` : ""}</span>
        <span><Roll value={forest.idle} /> 대기 역할</span>
        <span className={tone(map.totals.running, "sm-t-running")}><Roll value={map.totals.running} /> 작업중 상자</span>
        <span className={tone(map.totals.stuck, "sm-t-stuck")}><Roll value={map.totals.stuck} /> 막힌 상자</span>
        <span><Roll value={map.totals.stale} /> 오래된 미확정 상자</span>
        <span className={tone(map.totals.dead, "sm-t-dead")}><Roll value={map.totals.dead} /> 창 없음</span>
        <span><Roll value={map.totals.alerts} /> 열린 경보</span>
        {data.live === null && <span>세션 상태를 지금 알 수 없습니다.</span>}
        {!data.hierarchy && <span>관계표가 없어 모든 역할을 한 기지에 모았습니다.</span>}
      </p>
      <ul className="sm-legend" aria-label="색 안내">
        {(["running", "stuck", "stale", "dead", "idle", "off"] as const).map((s) => <li key={s}><i className={"sm-dot sm-s-" + s} />{STATE_LABEL[s]}</li>)}
        <TreeLegend forest={forest} />
        {resting > 0 && <li><label className="sm-toggle"><input type="checkbox" checked={showResting} onChange={(e) => setShowResting(e.target.checked)} />쉬는 역할도 보기({resting})</label></li>}
      </ul>
      <div className="sm-layout">
        <div className="sm-stage">
          {map.bases.length === 0 && !map.depot ? <p className="st-empty">지도에 올릴 역할이 없습니다.</p>
            : <StrategyTree model={map} live={data.live} showResting={showResting} selected={selected} depotKey={DEPOT} onSelect={pick} />}
        </div>
        <aside className="sm-side" aria-live="polite">
          {selected === DEPOT ? <Depot rows={map.depotRows} close={() => setSelected(null)} />
          : !unit ? <p className="st-empty">유닛이나 발령 전 창고를 누르면 상태와 카드가 여기에 보입니다.</p> : <>
            <header className="sm-side-head"><h2>{unit.role}</h2><button type="button" onClick={() => setSelected(null)}>닫기</button></header>
            <dl className="sm-facts">
              <dt>상태</dt><dd><i className={"sm-dot sm-s-" + unit.state} />{STATE_LABEL[unit.state]}</dd>
              <dt>종류</dt><dd>{KIND_LABEL[unit.kind]}</dd>
              <dt>직속 상위</dt><dd>{unit.parent ?? (unit.kind === "super" ? "사용자" : "관계표에 없음")}</dd>
              <dt>생존</dt><dd>{lifeLabel(unit)}</dd>
              <dt>실행 도구 · 모델</dt><dd>{runLabel(unit)}</dd>
              <dt>경보</dt><dd>{unit.alerts ? `${unit.alerts}건` : "없음"}</dd>
              <dt>최근 1시간</dt><dd className="sm-activity">{data.activity?.[unit.role] ? <><Spark values={data.activity[unit.role]} width={140} height={22} /><small>{data.activity[unit.role].reduce((a, b) => a + b, 0)}건</small></> : "활동 없음"}</dd>
            </dl>
            {/* 형제 부품마다 다른 key — 같은 key면 역할을 바꿀 때 옛 버튼이 남는다(PR #298 검수 F1). */}
            <RestartRole key={"restart:" + unit.role} role={unit.role} generation={restartGeneration(unit, readOnly)} />
            <h3>진행 카드 {unit.rows.length}장</h3>
            {unit.rows.length ? <ul className="sm-cards">{unit.rows.map((row) => <li key={row.key}>
              <span className={"sm-dot sm-c-" + row.bucket} /><CardLink row={row} />
              <small><Pulse at={row.signalAt} />{row.healthLabel}{row.signalAt ? ` · 마지막 신호 ${time(row.signalAt)}` : ""}</small></li>)}</ul>
              : <p className="st-empty">진행 중인 카드가 없습니다.</p>}
            {unitBase && <AskSuper key={"ask:" + unit.role} unit={unit} base={unitBase} />}
          </>}
        </aside>
      </div>
      <BaseSessions live={data.live} readOnly={readOnly} />
    </>}
  </section>;
}

// 기반 세션(2026-10-25 PR #298 검수 F3): 감시기·대시보드는 지도 유닛이 아니지만, 옛 담당자 상태 표가 보이던
// 생존·실행 도구 · 모델·다시 띄우기를 여기서 그대로 보인다. 같은 RestartRole을 쓰고 원격 읽기 전용이면 버튼이 없다.
function BaseSessions({ live, readOnly }: { live: LiveSession[] | null; readOnly: boolean }) {
  const sessions = systemSessions(live);
  return <section className="sm-base-sessions" aria-label="기반 세션">
    <h2>기반 세션</h2>
    {sessions === null ? <p className="st-empty">세션 상태를 지금 알 수 없습니다.</p>
      : !sessions.length ? <p className="st-empty">열린 기반 세션(감시기·대시보드)이 없습니다.</p>
      : <div className="table-scroll"><table>
        <thead><tr><th>역할</th><th>생존</th><th>실행 도구 · 모델</th><th>다시 띄우기</th></tr></thead>
        <tbody>{sessions.map((s) => { const life = { alive: true, session: s }; return <tr key={s.role}>
          <td>{s.role}</td><td>{lifeLabel(life)}</td><td>{liveLabel(s)}</td>
          <td><RestartRole key={"restart:" + s.role} role={s.role} generation={restartGeneration(life, readOnly)} /></td>
        </tr>; })}</tbody>
      </table></div>}
  </section>;
}
