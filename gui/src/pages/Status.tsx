import { useContext, useEffect, useRef } from "react";
import { useResource } from "../resource";
import type { Decision, Row, Stamp } from "../types";
import { CardLink, DocumentContent, ErrorMessage, Freshness, Health, AppContext, Facts, Loading, time } from "../ui";
import { firstLine, groupAskText, groupStopped, shortenTurn, type StopGroup } from "../stopped";
import { bandChips, liveLabel, supervisorLife, supervisorLine, type FlowSummary, type LiveSession, type OpenAlerts, type Supervisors } from "../status-band";

type StatusData = Stamp & {
  rows: Row[]; works: Row[]; cleanupRequest: string; executionCount: number;
  waitingQuestions: number | null;
  live: LiveSession[] | null; flow: FlowSummary; alerts: OpenAlerts | null; supervisors: Supervisors | null;
  boards: {name: string; state: string; total: number; counts: Record<string, number>; watchHtml: string}[];
  watchHtml: string;
  resources: {current: {memory: string; freePercent: number | null; swapUsed: number | null; load5: number | null}; ncpu: number | null} | null;
  resourceError: string | null; workError: string | null; decisions: Decision[] | null;
  recent: {at: string; kind: string; label: string; role: string; card: {key: string; title: string}}[];
  recentCounts: Record<string, number>;
};
// 서버 bucketGroups와 같은 묶음. 결과 대기는 작업중에, 보류(archived)는 진행 전에 센다(2026-10-05 [kyle]).
const groups = [
  ["running", "작업중"], ["stuck", "지금 막힌 것"],
  ["stale", "오래된 미정리"], ["planned", "진행 전"], ["hold", "일시정지"],
  ["done", "완료"], ["closed", "취소·대체"],
];
export default function Status({url}: {url: URL}) {
  const resource = useResource<StatusData>("status"), data = resource.data;
  const context = useContext(AppContext), scrolled = useRef("");
  useEffect(() => {
    if (!data || !url.hash.startsWith("#status-") || scrolled.current === url.hash) return;
    const target = document.getElementById(url.hash.slice(1));
    if (target) {
      if (target instanceof HTMLDetailsElement) target.open = true;
      target.scrollIntoView({block:"start"});
      scrolled.current = url.hash;
    }
  }, [url.hash, data]);
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); context.notice("질문을 복사했습니다. 전달할 곳에 붙여 넣으세요."); }
    catch { context.notice("복사하지 못했습니다. 카드에서 내용을 확인하세요."); }
  };
  const bucket = (key: string) => data?.rows.filter(row => row.bucket === key) || [];
  const stoppedGroups = groupStopped([...bucket("stuck"), ...bucket("stale")]);
  const stoppedCount = bucket("stuck").length + bucket("stale").length;
  const open = data?.works.filter(row => row.state === "running") || [];
  const held = data?.works.filter(row => row.state === "hold") || [];
  const closed = data?.works.filter(row => ["done","cancelled"].includes(row.state)) || [];
  const execution = (row: Row) => <article className={row.healthKind === "attention" ? "st-attn-card" : "st-work"} key={row.key}>
    <div className="st-attn-head"><Health row={row}/><strong><CardLink row={row}/></strong></div>
    <p>{row.healthReason}</p>
    {row.failureReason && <p className="st-attn-reason"><strong>이유</strong> {row.failureReason}</p>}
    <p className="st-attn-meta">담당 {row.owner || "미배정"} · {row.board || "판 미지정"} · {row.signalLabel} {row.signalAt && time(row.signalAt)}</p>
    {row.next && <p>다음 행동: {row.next}</p>}
    {row.healthKind === "attention" && <p><button className="copy-question" onClick={() => void copy(`[대시보드 확인 요청] ${row.key}: ${row.healthLabel}. ${row.failureReason || row.healthReason} 후속 처리 방향과 근거를 확인해주세요.`)}>감독에게 물어볼 문장 복사</button></p>}
  </article>;
  const stopRow = (row: Row, showReason: boolean) => <li className="st-stop-row" key={row.key}>
    <span className="st-stop-main"><CardLink row={row}/></span>
    <small>담당 {row.owner || "미배정"} · {row.board || "판 미지정"} · 마지막 신호 {row.signalAt ? time(row.signalAt) : "없음"}</small>
    {showReason && row.failureReason
      ? <details className="st-reason-fold"><summary>{firstLine(row.failureReason)}</summary><p>{row.failureReason}</p></details>
      : showReason && row.healthReason ? <p className="st-stop-reason">{row.healthReason}</p> : null}
  </li>;
  const stopGroup = (group: StopGroup) => {
    const many = group.rows.length > 3;
    const rows = group.rows.map(row => stopRow(row, !many));
    const stale = group.key === "stale";
    return <section key={group.key} id={stale ? "status-stale" : undefined} className={"st-stop-group st-stop-" + group.key.split(":")[0]}>
      <header className="st-stop-head">
        <h3>{group.label} <span className="st-cnt">{group.rows.length}건</span></h3>
        {group.firstAt && <small>신호 {time(group.firstAt)}{group.lastAt && group.lastAt !== group.firstAt ? " ~ " + time(group.lastAt) : ""}</small>}
      </header>
      {group.desc && <p className="st-stop-desc">{group.desc} <button className="copy-question" onClick={() => void copy(stale ? (data?.cleanupRequest || "") : groupAskText(group))}>{stale ? "정리 요청 복사" : "감독에게 물어볼 문장 복사"}</button></p>}
      {many
        ? <details className="st-fold"><summary>목록 {group.rows.length}장</summary><ul className="st-stop-list">{rows}</ul></details>
        : <ul className="st-stop-list">{rows}</ul>}
    </section>;
  };
  const section = (id: string, title: string, key: string, hint: string) => {
    const rows = bucket(key);
    return <section id={id} className="st-section">
      <header className="st-sec-head"><h2>{title}</h2><span className={"st-cnt"+(key === "stuck" ? " st-cnt-attn" : "")}>{rows.length}건</span><span className="st-hint">{hint}</span></header>
      {rows.length ? <>{rows.slice(0,8).map(execution)}{rows.length>8 && <details className="st-fold"><summary>나머지 {rows.length-8}장</summary>{rows.slice(8).map(execution)}</details>}</> : <p className="st-empty">해당 카드가 없습니다.</p>}
    </section>;
  };
  const work = (row: Row) => <article className="st-work" key={row.key}>
    <div className="st-work-top"><Health row={row}/><span className="st-work-board">{row.board || row.repo} · {row.flowLabel}</span><span className="st-work-prog">{row.flowPhase}</span></div>
    <h3 className="st-work-title"><CardLink row={row}/></h3>
    {row.purpose && <p className="st-work-purpose">{row.purpose}</p>}
    <p>{row.healthReason}</p>
    <dl className="st-work-grid"><dt>지금 차례</dt><dd className="st-turn" title={shortenTurn(row.turnLabel).rest ? row.turnLabel : undefined}>{shortenTurn(row.turnLabel).text}</dd><dt>다음 행동</dt><dd>{row.next}</dd></dl>
    <div className="st-work-foot"><span>최근 실행 신호 {row.signalLabel || "없음"} {row.signalAt && time(row.signalAt)}</span><span className="st-when">워크 기록 {row.reportLabel}</span>{row.summary && <span className="st-sum">{row.summary}</span>}</div>
  </article>;
  return <section className="st-view">
    <header className="st-lead"><h1>전체 현황</h1><p>내가 답할 요청과 막힌 일을 먼저 확인합니다. 맡긴 일의 자세한 진행 상황은 <a href="/?collection=work#dashboard">워크</a>에서 봅니다.</p><small>수집 {time(data?.collectedAt)}</small></header>
    <nav className="inline-nav" aria-label="현황 상세"><a href="#sessions">담당자 상태</a></nav>
    <ErrorMessage error={resource.error}/><Freshness collectedAt={data?.collectedAt} {...resource}/>
    {!data ? <Loading/> : <>
      <div className="st-band" role="group" aria-label="지금 내가 볼 것 · 다섯 질문">
        {bandChips({decisions: data.decisions?.length ?? null, stopped: stoppedCount, running: bucket("running").length, alerts: data.alerts, flow: data.flow, live: data.live}).map(chip =>
          <a key={chip.kind} className={"st-chip st-c-" + chip.kind + (chip.on ? " st-on" : " st-off")} href={chip.href} title={chip.title}><span className="st-num">{chip.num}</span><span className="st-lbl">{chip.label}</span></a>)}
      </div>
      <p className="st-band-more" role="group" aria-label="나머지 요약">
        {[["#status-running",data.workError ? "모름" : open.length,"열린 워크"],["?mailView=to-reply#mailbox",data.waitingQuestions ?? "모름","답을 기다리는 질문"]].map(([href,n,label]) => <a key={href} className="st-mini" href={String(href)}><span className="st-num">{n}</span><span className="st-lbl">{label}</span></a>)}
      </p>
      <ul id="status-live" className="st-live" aria-label="살아 있는 담당과 모델">
        {data.live === null ? <li className="st-live-row"><small>세션 상태 모름</small></li>
          : data.live.length === 0 ? <li className="st-live-row"><small>열린 담당 창이 없습니다.</small></li>
          : data.live.map(s => <li key={s.role} className={"st-live-row" + (s.pidState === "changed" ? " st-live-changed" : "")} title={s.pidState === "changed" ? "PID가 바뀌었습니다. 확인이 필요합니다." : undefined}><strong>{s.role}</strong><small>{liveLabel(s)}</small></li>)}
        <li className="st-live-row"><a href="#sessions">담당자 상태 전체</a></li>
      </ul>
      <section id="status-supers" className="st-section">
        <header className="st-sec-head"><h2>슈퍼감독별 현황</h2><span className="st-cnt">{data.supervisors ? data.supervisors.items.length + "명" : "모름"}</span><span className="st-hint">내가 일을 맡긴 슈퍼감독(관계표에서 바로 내 아래)마다 한 줄입니다. 그 아래 감독·담당의 실행을 모두 묶어 세므로, 묻지 않아도 어디가 돌고 어디가 막혔는지 보입니다.</span></header>
        {data.supervisors === null ? <p className="st-error" role="alert">관계표를 읽지 못해 슈퍼감독별로 묶지 못했습니다. 감시기가 읽는 관계표 파일(원장의 마지막 hierarchy-loaded 기록이 가리키는 경로)을 확인하세요.</p>
          : data.supervisors.items.length === 0 ? <p className="st-empty">관계표에 사용자 바로 아래 역할이 없습니다.</p>
          : <ul className="st-sup-list">{data.supervisors.items.map(s => <li key={s.super} className={"st-sup-row" + (s.stuck || (s.alerts ?? 0) ? " st-sup-attn" : "") + (s.alive === false ? " st-sup-dead" : "")}>
              <strong>{s.super}</strong>
              <span className="st-sup-life">{supervisorLife(s)}</span>
              <small>{supervisorLine(s)} · 마지막 신호 {s.lastSignal ? time(s.lastSignal) : "없음"}</small>
            </li>)}</ul>}
        {data.supervisors && data.supervisors.unassigned > 0 && <p className="st-hint">관계표에 없는 담당의 실행 {data.supervisors.unassigned}건은 어느 슈퍼감독에도 묶이지 않았습니다.</p>}
        {data.supervisors && (data.supervisors.unowned ?? 0) > 0 && <p className="st-hint">담당이 아직 정해지지 않은 실행(초안·보류) {data.supervisors.unowned}건은 세지 않았습니다.</p>}
      </section>
      <section id="status-decisions" className="st-section">
        <header className="st-sec-head"><h2>내 결정 대기</h2><span className="st-cnt st-cnt-attn">{data.decisions?.length ?? "모름"}건</span><span className="st-hint">슈퍼감독이 요청한 결정입니다. 답하기를 누르면 결정 화면에서 바로 답합니다.</span></header>
        {data.decisions === null ? <p className="st-error" role="alert">결정 기록을 읽지 못했습니다.</p> : data.decisions.length ? <><ul className="st-decisions">{data.decisions.slice(0,3).map(d => <li className="st-dec-row" key={d.id}><span className="st-dec-title">{d.questionTitle ?? d.question.split(/\n/)[0]}</span><small>{d.requestedBy} · 추천 {d.recommendation}</small><a className="st-dec-answer" href={"#decision-"+encodeURIComponent(d.id)}>답하기</a></li>)}</ul><p><a href="#decisions">결정 대기 {data.decisions.length}건 모두 보기</a></p></> : <p className="st-empty">기다리는 결정이 없습니다.</p>}
      </section>
      <section id="status-attention" className="st-section">
        <header className="st-sec-head"><h2>지금 막힌 것</h2><span className={"st-cnt" + (stoppedCount ? " st-cnt-attn" : "")}>{stoppedCount}건</span><span className="st-hint">멈춘 카드를 이유별로 묶었습니다. 실패는 기록 확인, 담당 세션 없음은 감독 재확인, 오래된 미정리는 감독 정리가 필요합니다. <a href="?collection=executions&amp;state=all#dashboard">작업 표에서 보기</a></span></header>
        {stoppedCount ? stoppedGroups.map(stopGroup) : <p className="st-empty">멈춘 카드가 없습니다.</p>}
        {data.alerts === null ? <p className="st-error" role="alert">감시 경보를 읽지 못했습니다(원장 확인 불가).</p>
          : data.alerts.count > 0 && <details className="st-fold" open={data.alerts.count <= 5}><summary>해소 전 감시 경보 {data.alerts.count}건</summary><p className="st-hint">감시기가 보냈지만 아직 해소 기록이 없는 경보입니다. 수신자가 처리하면 다음 순회에서 닫힙니다.</p><ul className="st-alert-list">{data.alerts.items.map(a => <li key={a.id} className="st-alert-row"><strong>{a.kind || "경보"}</strong><span>{a.role || a.session || "대상 모름"}</span><small>{a.level}{a.recipient ? " · 수신 " + a.recipient : ""} · {time(a.at)}</small></li>)}</ul></details>}
      </section>
      <section id="status-flow" className="st-section">
        <header className="st-sec-head"><h2>흐름 확인</h2><span className={"st-cnt" + (data.flow.unconfirmed.length ? " st-cnt-attn" : "")}>{data.flow.unconfirmed.length}건</span><span className="st-hint">티키타카 묶음 {data.flow.total}개 중 라운드·구현·검수 연결이 깨져 집계되지 않는 묶음입니다. 감독이 카드의 묶음 번호·단계를 고치면 빠집니다.</span></header>
        {data.flow.unconfirmed.length ? <ul className="st-flow-list">{data.flow.unconfirmed.map(f => <li key={f.id} className="st-flow-row"><strong>{f.title}</strong> · {f.label}{f.warnings.length > 0 && <small>{f.warnings.join(" ")}</small>}</li>)}</ul> : <p className="st-empty">{data.flow.total ? "모든 묶음이 흐름대로 연결돼 있습니다." : "티키타카 묶음이 없습니다."}</p>}
      </section>
      <DocumentContent html={data.watchHtml}/>
      {section("status-executing","작업중인 카드","running","담당이 진행 중이라고 보고했고 담당 창도 살아 있습니다. 검수·답변 같은 다른 결과를 기다린다고 보고한 카드도 여기 셉니다. 보고가 오래돼도 멈춘 것으로 보지 않습니다.")}
      <p className="st-hint">진행 전 {bucket("planned").length}건 · 일시정지 {bucket("hold").length}건 · 보고 시각은 담당이 마지막으로 알린 때입니다. 지금 일하는지를 실시간으로 잡은 값이 아닙니다.</p>
      <section id="status-running" className="st-section"><header className="st-sec-head"><h2>열린 워크</h2><span className="st-cnt">{data.workError ? "모름" : open.length+"장"}</span><span className="st-hint">열린 워크도 실행 준비·작업중·감독 확인 단계일 수 있습니다.</span></header><ErrorMessage error={data.workError}/>{open.length ? open.map(work) : !data.workError && <p className="st-empty">열린 워크가 없습니다. 위의 카드 목록에서 개별 작업을 확인하세요.</p>}</section>
      {held.length>0 && <section className="st-section"><h2>보류 중인 워크</h2>{held.map(work)}</section>}
      <details className="st-fold st-recent-fold"><summary className="st-sec-head"><h2>최근 24시간에 일어난 일</h2><span className="st-cnt">완료 {data.recentCounts.done} · 실패 {data.recentCounts.failed} · 발령 {data.recentCounts.send}</span><span className="st-hint">일을 맡기고, 끝나고, 실패한 시각입니다. 카드 내용을 고친 것은 세지 않습니다.</span></summary>{data.recent.length ? <ul className="st-recent">{data.recent.map((event,i)=><li className={"st-recent-row st-recent-"+event.kind} key={i}><span className="st-recent-time">{time(event.at)}</span><span className="st-recent-kind">{event.label}</span><CardLink row={event.card}/><small>{event.role}</small></li>)}</ul> : <p className="st-empty">최근 24시간에 기록된 발령·완료·실패가 없습니다.</p>}</details>
      <details className="st-fold"><summary>판별 진행 막대 {data.boards.filter(b=>b.state!=="done").length}개 판</summary><p className="st-hint">실제 일을 하는 카드만 한 번씩 셉니다(관리·조율 카드 제외). 위 숫자와 같은 기준입니다.</p>{data.boards.filter(b=>b.state!=="done").map(board=><section className="board-progress" key={board.name}><h3><a href={"/?board="+encodeURIComponent(board.name)+"&collection=executions&state=all#dashboard"}>{board.name}</a></h3><div className="progress-track">{groups.map(([key,label])=><span key={key} className={"progress-"+key} style={{flex:board.counts[key] || 0}} title={label+" "+(board.counts[key] || 0)}/>)}</div><div className="progress-legend">{groups.filter(([key])=>board.counts[key]).map(([key,label])=><span key={key}>{label} {board.counts[key]}</span>)}</div><DocumentContent html={board.watchHtml}/></section>)}</details>
      <details className="st-fold"><summary>진행 전 카드 {bucket("planned").length}건</summary>{bucket("planned").map(row=><p key={row.key}><CardLink row={row}/> · {row.owner || "미배정"}</p>)}</details>
      <details className="st-fold"><summary>끝난 판 {data.boards.filter(b=>b.state==="done").length}개 · 끝난 워크 {closed.length}장</summary>{closed.map(row=><p key={row.key}><CardLink row={row}/> · {row.stateLabel}</p>)}{data.boards.filter(b=>b.state==="done").map(board=><p key={board.name}>{board.name} · 실행 {board.total}장</p>)}</details>
      <details className="st-fold"><summary>자원 사용</summary><ErrorMessage error={data.resourceError}/>{data.resources ? <Facts items={[["메모리 여유",data.resources.current.freePercent===null ? "모름" : data.resources.current.freePercent+"%"],["스왑 사용",data.resources.current.swapUsed===null ? "모름" : data.resources.current.swapUsed.toFixed(1)+" MB"],["CPU 5분 부하",data.resources.current.load5===null ? "모름" : data.resources.current.load5.toFixed(2)+" / "+(data.resources.ncpu ?? "모름")]]}/> : <p>자원 상태 모름</p>}</details>
      <p className="st-footnote">모든 수치는 카드 한 장을 한 번씩 센 값이며 관리·조율 카드는 제외합니다. 제품 완성률이 아닙니다. 상세 비교·정렬은 <a href="?collection=executions#dashboard">작업 표</a>에서 확인하세요.</p>
    </>}
  </section>;
}
