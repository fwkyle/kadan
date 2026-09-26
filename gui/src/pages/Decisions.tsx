import { useCallback, useEffect, useRef, useState } from "react";
import { useResource } from "../resource";
import { navigate } from "../navigation";
import type { Decision, Stamp } from "../types";
import { ActionForm, CardLink, DocumentContent, ErrorMessage, Freshness, Loading, time } from "../ui";

export default function Decisions({ url }: { url: URL }) {
  const resource = useResource<Stamp & {items: Decision[]}>("decisions"), data = resource.data;
  const [previous, setPrevious] = useState(false), [drafts, setDrafts] = useState(new Set<string>());
  const newest = url.searchParams.get("decisionSort") === "newest";
  const items = [...(data?.items || [])].sort((a,b)=>(Date.parse(a.at)-Date.parse(b.at))*(newest?-1:1));
  const open = items.filter(d=>d.status === "open");
  const target = url.hash.startsWith("#decision-") ? decodeURIComponent(url.hash.slice(10)) : "";
  const scrolled = useRef("");
  useEffect(() => {
    const element = target && document.getElementById("decision-"+target);
    if (element && scrolled.current !== target) { element.scrollIntoView({block:"start"}); scrolled.current=target; }
  }, [target, data]);
  const draft = useCallback((id: string, dirty: boolean) => setDrafts(previous => {
    if (previous.has(id) === dirty) return previous;
    const next = new Set(previous);
    if (dirty) next.add(id); else next.delete(id);
    return next;
  }), []);
  const answered = items.filter(d=>d.status === "answered").length;
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
    <div className="decision-progress"><span>대기 {open.length}건 · 답한 결정 {answered}건</span><div className="track"><span style={{width:(answered+open.length ? answered/(answered+open.length)*100 : 0)+"%"}}/></div><button onClick={toggleSort}>정렬: {newest?"최신 순":"오래된 순"}</button></div>
    {!data ? <Loading/> : <>
      <div className="decision-list">{items.filter(d=>d.status === "open" || drafts.has(d.id)).map(d=><DecisionRequest key={d.id} decision={d} draft={draft}/>)}</div>
      {!open.length && <p className="empty">기다리는 결정이 없습니다.</p>}
      <details className="st-fold" open={previous} onToggle={e=>setPrevious(e.currentTarget.open)}><summary>이전 결정 {items.filter(d=>d.status!=="open").length}건</summary>{previous && items.filter(d=>d.status!=="open").map(d=><article className="work-tile" key={d.id}><h3>{d.questionTitle ?? d.question}</h3>{d.questionHtml && <div className="decision-question"><DocumentContent html={d.questionHtml}/></div>}<p>{d.answer?.text || d.cancelReason}</p><p>{time(d.answer?.at || d.at)} · {d.status === "answered"?"답변 완료":"취소"} · 전달 {d.delivery?.status || "미기록"}</p>{d.delivery?.error && <p className="error">{d.delivery.error}</p>}<CardLink row={{key:d.card,title:"관련 카드"}}/></article>)}</details>
    </>}
  </section>;
}
function DecisionRequest({decision, draft}: {decision: Decision; draft: (id: string, dirty: boolean)=>void}) {
  const onDirtyChange = useCallback((dirty: boolean)=>draft(decision.id,dirty), [draft,decision.id]);
  return <article id={"decision-"+decision.id}>
    <div className="decision-meta"><span className="requester">요청 {decision.requestedBy}</span><CardLink row={{key:decision.card,title:decision.card}}/><time>{time(decision.at)}</time></div>
    <h2>{decision.questionTitle ?? decision.question}</h2>
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
  </article>;
}
