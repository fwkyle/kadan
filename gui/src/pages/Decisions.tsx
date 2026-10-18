import { useCallback, useEffect, useRef, useState } from "react";
import { useResource } from "../resource";
import { navigate } from "../navigation";
import type { Decision, Stamp } from "../types";
import { ActionForm, CardLink, DocumentContent, ErrorMessage, Freshness, Loading, time } from "../ui";
import { readFolded, saveFolded, toggleFolded } from "../decision-fold";
import { linkMode, linkOutcome, linkTarget } from "../decision-link";

const storage = (() => { try { return window.localStorage; } catch { return null; } })();

export default function Decisions({ url }: { url: URL }) {
  // 기본 응답은 열린 결정과 지난 결정 건수뿐이다. 지난 결정은 펼칠 때 페이지로 받는다(PastDecisions).
  const resource = useResource<Stamp & {items: Decision[]; answered: number; past: number}>("decisions"), data = resource.data;
  const [previous, setPrevious] = useState(false), [drafts, setDrafts] = useState(new Set<string>());
  const newest = url.searchParams.get("decisionSort") === "newest";
  const open = [...(data?.items || [])].sort((a,b)=>(Date.parse(a.at)-Date.parse(b.at))*(newest?-1:1));
  // 쓰던 답변 칸은 다른 곳에서 그 결정이 닫혀도 남긴다. 닫힌 결정은 목록에서 빠지므로 마지막에 본 복사본을 쓴다.
  const seen = useRef(new Map<string, Decision>());
  for (const d of open) seen.current.set(d.id, d);
  const kept = [...drafts].filter(id => !open.some(d => d.id === id) && seen.current.has(id)).map(id => ({...seen.current.get(id)!, status: "closed"}));
  const items = [...open, ...kept];
  const target = linkTarget(url.hash);
  const scrolled = useRef("");
  useEffect(() => {
    const element = target && document.getElementById("decision-"+target);
    if (element && scrolled.current !== target) {
      element.scrollIntoView({block:"start"});
      // 알림 링크로 열리면 답하기 양식(선택된 추천안 또는 첫 칸)에 바로 초점을 둔다.
      element.querySelector<HTMLElement>("input[type=radio]:checked, textarea")?.focus({preventScroll:true});
      scrolled.current=target;
    }
  }, [target, data]);
  const draft = useCallback((id: string, dirty: boolean) => setDrafts(previous => {
    if (previous.has(id) === dirty) return previous;
    const next = new Set(previous);
    if (dirty) next.add(id); else next.delete(id);
    return next;
  }), []);
  const [folded, setFolded] = useState(() => readFolded(storage));
  const openIds = data ? open.map(d=>d.id) : null;
  const toggleFold = useCallback((id: string) => setFolded(previous => {
    const next = toggleFolded(previous, id);
    saveFolded(storage, next, openIds);
    return next;
  }), [openIds?.join("\n")]);
  const foldedCount = open.filter(d=>folded.has(d.id)).length;
  const answered = data?.answered ?? 0, past = data?.past ?? 0;
  const toggleSort = () => {
    const next = new URL(url);
    if (newest) next.searchParams.delete("decisionSort");
    else next.searchParams.set("decisionSort", "newest");
    // 같은 폼을 유지한 채 순서만 바꾸므로 작성 내용을 버리는 이동이 아니다.
    navigate(next, false, true);
  };
  return <section className="decision-page">
    <h1>내 결정 필요 {data ? open.length+"건" : "모름"}</h1>
    <p>슈퍼감독이 사용자에게 명시적으로 요청한 결정만 표시합니다.</p>
    <ErrorMessage error={resource.error}/><Freshness collectedAt={data?.collectedAt} {...resource}/>
    <div className="decision-progress"><span>대기 {open.length}건{foldedCount ? ` · 접어 둔 결정 ${foldedCount}건` : ""} · 답한 결정 {answered}건</span><div className="track"><span style={{width:(answered+open.length ? answered/(answered+open.length)*100 : 0)+"%"}}/></div><button onClick={toggleSort}>정렬: {newest?"최신 순":"오래된 순"}</button></div>
    {!data ? <Loading/> : <>
      {data && linkMode(target, open.map(d=>d.id)) === "lookup" && <LinkedDecision id={target}/>}
      <div className="decision-list">{items.map(d=><DecisionRequest key={d.id} decision={d} draft={draft} folded={folded.has(d.id)} onToggleFold={toggleFold}/>)}</div>
      {!open.length && <p className="empty">기다리는 결정이 없습니다.</p>}
      <details className="st-fold" open={previous} onToggle={e=>setPrevious(e.currentTarget.open)}><summary>이전 결정 {past}건</summary>{previous && <PastDecisions newest={newest}/>}</details>
    </>}
  </section>;
}
// 알림 링크가 가리킨 결정이 열린 목록에 없을 때: 이미 답했거나 취소됐으면 상태만, 모르는 id면 안내 문구만 보인다(양식 없음).
function LinkedDecision({id}: {id: string}) {
  const resource = useResource<Stamp & {item: Decision | null}>(`decisions?id=${encodeURIComponent(id)}`), item = resource.data?.item;
  const outcome = linkOutcome(resource.data ? item : undefined);
  if (outcome === "loading" || outcome === "open") return null;
  return <aside className="decision-linked" id={"decision-"+id} role="status">
    {outcome === "unknown" ? <p>이 링크의 결정을 찾을 수 없습니다. 이미 정리됐거나 주소가 잘못됐을 수 있습니다.</p>
      : <><h2>{item!.questionTitle ?? item!.question}</h2><p>{outcome === "answered" ? "이미 답한 결정입니다." : "취소된 결정입니다."} {item!.answer?.text || item!.cancelReason}</p><p>{time(item!.answer?.at || item!.at)}</p></>}
  </aside>;
}
function PastDecisions({newest}: {newest: boolean}) {
  const [page, setPage] = useState(1);
  const resource = useResource<Stamp & {items: Decision[]; page: number; pages: number; total: number}>(`decisions?past=1&page=${page}${newest ? "&sort=newest" : ""}`), data = resource.data;
  return <>
    <ErrorMessage error={resource.error}/>
    {!data ? <Loading/> : data.items.map(d=><article className="work-tile" key={d.id}><h3>{d.questionTitle ?? d.question}</h3>{d.questionHtml && <div className="decision-question"><DocumentContent html={d.questionHtml}/></div>}<p>{d.answer?.text || d.cancelReason}</p><p>{time(d.answer?.at || d.at)} · {d.status === "answered"?"답변 완료":"취소"} · 전달 {d.delivery?.status || "미기록"}</p>{d.delivery?.error && <p className="error">{d.delivery.error}</p>}<CardLink row={{key:d.card,title:"관련 카드"}}/></article>)}
    {data && data.pages > 1 && <p><button disabled={page <= 1} onClick={()=>setPage(page-1)}>이전</button> {data.page}/{data.pages}쪽 · {data.total}건 <button disabled={page >= data.pages} onClick={()=>setPage(page+1)}>다음</button></p>}
  </>;
}
function DecisionRequest({decision, draft, folded, onToggleFold}: {decision: Decision; draft: (id: string, dirty: boolean)=>void; folded: boolean; onToggleFold: (id: string)=>void}) {
  const onDirtyChange = useCallback((dirty: boolean)=>draft(decision.id,dirty), [draft,decision.id]);
  // 접어도 본문은 숨기기만 한다. 쓰던 메모와 고른 선택지가 남는다.
  return <article id={"decision-"+decision.id} data-fresh={`decision:${decision.id}:${decision.status}`} className={folded ? "folded" : undefined}>
    <div className="decision-meta"><span className="requester">요청 {decision.requestedBy}</span><CardLink row={{key:decision.card,title:decision.card}}/><time>{time(decision.at)}</time><button type="button" className="decision-fold" aria-expanded={!folded} aria-controls={"decision-body-"+decision.id} onClick={()=>onToggleFold(decision.id)}>{folded ? "펼치기" : "접기"}</button></div>
    <h2>{decision.questionTitle ?? decision.question}</h2>
    {folded && <p className="decision-folded-note">접어 둔 결정 · 추천안: {decision.recommendation}</p>}
    <div className="decision-body" id={"decision-body-"+decision.id} hidden={folded}>
    {decision.questionHtml && <div className="decision-question"><DocumentContent html={decision.questionHtml}/></div>}
    <div className="decision-recommendation">
      <p className="recommendation-heading"><span className="recommendation-badge">추천안</span><strong>{decision.recommendation}</strong></p>
      <div className="reason"><span>추천 이유</span>{decision.reasonHtml ? <DocumentContent html={decision.reasonHtml}/> : <p>{decision.reason}</p>}</div>
    </div>
    <ActionForm revision={decision.revision} onDirtyChange={onDirtyChange} spec={{
      action:"/decisions/answer", title:"답변 전달", disabled:decision.status!=="open",
      fields:[
        {name:"id",label:"요청 ID",value:decision.id,type:"hidden",options:null,required:true},
        {name:"choice",label:"선택",value:"",type:"radio",recommendedValue:decision.recommendation,options:[...decision.options.map(option=>[option,option] as [string,string]),["","선택지 없이 메모로 답변"]],required:false},
        {name:"text",label:"메모 (선택) · 선택지 없이 보내려면 여기에 답을 적으세요.",value:"",type:"textarea",options:null,required:false},
      ],
    }} onSaved={result=>{
      const delivery=result.result.delivery;
      if(delivery?.status!=="sent") alert("답변은 저장됐지만 전달 상태를 확인해야 합니다: "+(delivery?.error || delivery?.status || "모름"));
    }}/>
    <p className="decision-note">답변 전달을 누를 때만 보냅니다. 요청한 {decision.requestedBy}에게 한 번 알립니다.</p>
    </div>
  </article>;
}
