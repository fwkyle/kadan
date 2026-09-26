import { useContext, useEffect, useRef } from "react";
import { useResource } from "../resource";
import type { Decision, Row, Stamp } from "../types";
import { CardLink, DocumentContent, ErrorMessage, Freshness, Health, AppContext, Facts, Loading, time } from "../ui";

type StatusData = Stamp & {
  rows: Row[]; works: Row[]; cleanupRequest: string; executionCount: number;
  waitingQuestions: number | null;
  boards: {name: string; state: string; total: number; counts: Record<string, number>; watchHtml: string}[];
  watchHtml: string;
  resources: {current: {memory: string; freePercent: number | null; swapUsed: number | null; load5: number | null}; ncpu: number | null} | null;
  resourceError: string | null; workError: string | null; decisions: Decision[] | null;
  recent: {at: string; kind: string; label: string; role: string; card: {key: string; title: string}}[];
  recentCounts: Record<string, number>;
};
const groups = [
  ["running", "작업 중"], ["waiting", "결과 대기"], ["stuck", "지금 막힌 것"],
  ["stale", "오래된 미정리"], ["planned", "발령 전"], ["hold", "보류"],
  ["done", "완료"], ["closed", "취소·대체·보관"],
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
  const section = (id: string, title: string, key: string, hint: string) => {
    const rows = bucket(key);
    return <section id={id} className="st-section">
      <header className="st-sec-head"><h2>{title}</h2><span className={"st-cnt"+(key === "stuck" ? " st-cnt-attn" : "")}>{rows.length}건</span><span className="st-hint">{hint}</span></header>
      {rows.length ? <>{rows.slice(0,8).map(execution)}{rows.length>8 && <details className="st-fold"><summary>나머지 {rows.length-8}장</summary>{rows.slice(8).map(execution)}</details>}</> : <p className="st-empty">해당 실행이 없습니다.</p>}
    </section>;
  };
  const work = (row: Row) => <article className="st-work" key={row.key}>
    <div className="st-work-top"><Health row={row}/><span className="st-work-board">{row.board || row.repo} · {row.flowLabel}</span><span className="st-work-prog">{row.flowPhase}</span></div>
    <h3 className="st-work-title"><CardLink row={row}/></h3>
    {row.purpose && <p className="st-work-purpose">{row.purpose}</p>}
    <p>{row.healthReason}</p>
    <dl className="st-work-grid"><dt>지금 차례</dt><dd className="st-turn">{row.turnLabel}</dd><dt>다음 행동</dt><dd>{row.next}</dd></dl>
    <div className="st-work-foot"><span>최근 실행 신호 {row.signalLabel || "없음"} {row.signalAt && time(row.signalAt)}</span><span className="st-when">업무 기록 {row.reportLabel}</span>{row.summary && <span className="st-sum">{row.summary}</span>}</div>
  </article>;
  return <section className="st-view">
    <header className="st-lead"><h1>전체 현황</h1><p>내가 답할 요청과 막힌 일을 먼저 확인합니다. 맡긴 일의 자세한 진행 상황은 <a href="/?collection=work#dashboard">업무</a>에서 봅니다.</p><small>수집 {time(data?.collectedAt)}</small></header>
    <nav className="inline-nav" aria-label="현황 상세"><a href="#sessions">담당자 상태</a></nav>
    <ErrorMessage error={resource.error}/><Freshness collectedAt={data?.collectedAt} {...resource}/>
    {!data ? <Loading/> : <>
      <div className="st-band" role="group" aria-label="지금 내가 볼 것">
        <a className="st-chip st-c-decision" href="#status-decisions"><span className="st-num">{data.decisions?.length ?? "모름"}</span><span className="st-lbl">내 결정 대기</span></a>
        <a className="st-chip st-c-attn" href="#status-attention"><span className="st-num">{bucket("stuck").length}</span><span className="st-lbl">지금 막힌 것</span></a>
      </div>
      <p className="st-band-more" role="group" aria-label="나머지 요약">
        {[["#status-executing",bucket("running").length,"작업 중"],["#status-waiting",bucket("waiting").length,"결과 대기"],["#status-stale",bucket("stale").length,"오래된 미정리"],["#status-running",data.workError ? "모름" : open.length,"열린 업무"],["?mailView=to-reply#mailbox",data.waitingQuestions ?? "모름","답을 기다리는 질문"],["?collection=executions&state=all#dashboard",data.executionCount,"전체 실행 카드"]].map(([href,n,label]) => <a key={href} className="st-mini" href={String(href)}><span className="st-num">{n}</span><span className="st-lbl">{label}</span></a>)}
      </p>
      <section id="status-decisions" className="st-section">
        <header className="st-sec-head"><h2>내 결정 대기</h2><span className="st-cnt st-cnt-attn">{data.decisions?.length ?? "모름"}건</span><span className="st-hint">슈퍼감독이 요청한 결정입니다. 답하기를 누르면 결정 화면에서 바로 답합니다.</span></header>
        {data.decisions === null ? <p className="st-error" role="alert">결정 기록을 읽지 못했습니다.</p> : data.decisions.length ? <><ul className="st-decisions">{data.decisions.slice(0,3).map(d => <li className="st-dec-row" key={d.id}><span className="st-dec-title">{d.questionTitle ?? d.question.split(/\n/)[0]}</span><small>{d.requestedBy} · 추천 {d.recommendation}</small><a className="st-dec-answer" href={"#decision-"+encodeURIComponent(d.id)}>답하기</a></li>)}</ul><p><a href="#decisions">결정 대기 {data.decisions.length}건 모두 보기</a></p></> : <p className="st-empty">기다리는 결정이 없습니다.</p>}
      </section>
      {section("status-attention","지금 막힌 것","stuck","담당 창은 살아 있는데 시작 보고가 없거나 실패한 실행입니다. 감독에게 확인을 부탁하세요. 오래 멈춘 것은 아래 오래된 미정리에 따로 모읍니다.")}
      <DocumentContent html={data.watchHtml}/>
      {section("status-executing","작업 중인 실행","running","담당이 진행 중이라고 보고했고 담당 창도 살아 있습니다.")}
      {section("status-waiting","결과를 기다리는 실행","waiting","담당이 검수·답변 같은 다른 결과를 기다린다고 보고했습니다. 보고가 오래돼도 멈춘 것으로 보지 않습니다.")}
      <p className="st-hint">실행 전 {bucket("planned").length}건 · 보류 {bucket("hold").length}건 · 보고 시각은 담당이 마지막으로 알린 때입니다. 지금 일하는지를 실시간으로 잡은 값이 아닙니다.</p>
      <section id="status-running" className="st-section"><header className="st-sec-head"><h2>열린 업무</h2><span className="st-cnt">{data.workError ? "모름" : open.length+"장"}</span><span className="st-hint">열린 업무도 실행 준비·결과 대기·감독 확인 단계일 수 있습니다.</span></header><ErrorMessage error={data.workError}/>{open.length ? open.map(work) : !data.workError && <p className="st-empty">열린 업무가 없습니다. 위의 실행 목록에서 개별 작업을 확인하세요.</p>}</section>
      {held.length>0 && <section className="st-section"><h2>보류 중인 업무</h2>{held.map(work)}</section>}
      {bucket("stale").length>0 && <details id="status-stale" className="st-fold st-stale"><summary>오래된 미정리 {bucket("stale").length}장 · 24시간 이상 신호 없음 · 정리 대상</summary><p className="st-hint">담당 세션이 없고 신호가 오래된 실행입니다. 지금 막힌 것과 구분하며, 감독이 대체·취소·보류로 정리해야 목록에서 빠집니다. <button className="copy-question" onClick={() => void copy(data.cleanupRequest)}>정리 요청 복사</button></p><ul className="st-stale-list">{bucket("stale").map(row => <li className="st-stale-row" key={row.key}><CardLink row={row}/><small>담당 {row.owner || "미배정"} · {row.board || "판 미지정"} · {row.healthLabel} · 마지막 신호 {time(row.signalAt)} · 저장 상태 {row.stored}</small></li>)}</ul></details>}
      <details className="st-fold st-recent-fold"><summary className="st-sec-head"><h2>최근 24시간에 일어난 일</h2><span className="st-cnt">완료 {data.recentCounts.done} · 실패 {data.recentCounts.failed} · 발령 {data.recentCounts.send}</span><span className="st-hint">일을 맡기고, 끝나고, 실패한 시각입니다. 카드 내용을 고친 것은 세지 않습니다.</span></summary>{data.recent.length ? <ul className="st-recent">{data.recent.map((event,i)=><li className={"st-recent-row st-recent-"+event.kind} key={i}><span className="st-recent-time">{time(event.at)}</span><span className="st-recent-kind">{event.label}</span><CardLink row={event.card}/><small>{event.role}</small></li>)}</ul> : <p className="st-empty">최근 24시간에 기록된 발령·완료·실패가 없습니다.</p>}</details>
      <details className="st-fold"><summary>판별 진행 막대 {data.boards.filter(b=>b.state!=="done").length}개 판</summary><p className="st-hint">실제 일을 하는 카드만 한 번씩 셉니다(관리·조율 카드 제외). 위 숫자와 같은 기준입니다.</p>{data.boards.filter(b=>b.state!=="done").map(board=><section className="board-progress" key={board.name}><h3><a href={"/?board="+encodeURIComponent(board.name)+"&collection=executions&state=all#dashboard"}>{board.name}</a></h3><div className="progress-track">{groups.map(([key,label])=><span key={key} className={"progress-"+key} style={{flex:board.counts[key] || 0}} title={label+" "+(board.counts[key] || 0)}/>)}</div><div className="progress-legend">{groups.filter(([key])=>board.counts[key]).map(([key,label])=><span key={key}>{label} {board.counts[key]}</span>)}</div><DocumentContent html={board.watchHtml}/></section>)}</details>
      <details className="st-fold"><summary>발령 전 실행 {bucket("planned").length}건</summary>{bucket("planned").map(row=><p key={row.key}><CardLink row={row}/> · {row.owner || "미배정"}</p>)}</details>
      <details className="st-fold"><summary>끝난 판 {data.boards.filter(b=>b.state==="done").length}개 · 끝난 업무 {closed.length}장</summary>{closed.map(row=><p key={row.key}><CardLink row={row}/> · {row.stateLabel}</p>)}{data.boards.filter(b=>b.state==="done").map(board=><p key={board.name}>{board.name} · 실행 {board.total}장</p>)}</details>
      <details className="st-fold"><summary>자원 사용</summary><ErrorMessage error={data.resourceError}/>{data.resources ? <Facts items={[["메모리 여유",data.resources.current.freePercent===null ? "모름" : data.resources.current.freePercent+"%"],["스왑 사용",data.resources.current.swapUsed===null ? "모름" : data.resources.current.swapUsed.toFixed(1)+" MB"],["CPU 5분 부하",data.resources.current.load5===null ? "모름" : data.resources.current.load5.toFixed(2)+" / "+(data.resources.ncpu ?? "모름")]]}/> : <p>자원 상태 모름</p>}</details>
      <p className="st-footnote">모든 수치는 실행 카드 한 장을 한 번씩 센 값이며 관리·조율 카드는 제외합니다. 제품 완성률이 아닙니다. 상세 비교·정렬은 <a href="?collection=executions#dashboard">작업 표</a>에서 확인하세요.</p>
    </>}
  </section>;
}
