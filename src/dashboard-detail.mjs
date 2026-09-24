import {escapeHtml as e,renderCardDocument} from './card-content.mjs';
import {statusContext,statusChanges} from './card-status-context.mjs';
import {stateText,progressLabel} from './human-brief.mjs';
import {approvedDetailGuide} from './dashboard-detail-guides.mjs';

const stamp=value=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false}):'모름';
const shortStamp=value=>Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value)):'시각 모름';
const preview=(text,n=180)=>{const value=String(text||'').replace(/\s+/g,' ').trim();return value.length>n?value.slice(0,n)+'…':value;};
const labels={'Why':'작업 목적','이번에 확인할 결과':'목표·기한','작업공간과 수정파일 소유':'수정 범위','범위':'수정 범위','금지':'금지 사항','합격 기준':'완료 조건','결과 파일':'결과 파일','결과 파일 형식':'결과 형식','완료 통지 수신자':'보고 대상','완료':'완료 신호','확인된 현재접점과 최소설계':'구현 방법','입력·저장·실연결 경계':'입력·연결','검증·독립검수·배포':'검증·배포','허용 결과·실행자료':'남길 자료','실목록 최종 활성 입력':'추가 입력','정확 입력과 진행 경계':'입력·진행','실제기준·소유·자료':'원본·소유','구현계약':'표시 조건','로컬검증·45분상한':'검증·기한'};

// 요약과 인박스는 바로 보이고, 나머지는 기존 주소로도 펼칠 수 있다.
export function renderDetailSections(summary,sections) {
 return (summary?`<section id="dw-panel-summary" class="dw-tab-panel" aria-label="한눈에">${summary}</section>`:'')+sections.map(([key,label,html,open])=>`<details class="dw-detail-fold" data-detail-section="${key}"${open?' open':''}><summary id="dw-tab-${key}">${e(label)}</summary><section id="dw-panel-${key}" class="dw-tab-panel" aria-labelledby="dw-tab-${key}">${html}</section></details>`).join('');
}

// 본문은 바꾸지 않고 제목의 위치만 찾는다. 코드 블록 안의 #은 제목이 아니다.
export function instructionSections(body='') {
 const text=String(body??''),headings=[];let fence=null,offset=0;
 for(const line of text.match(/[^\n]*\n|[^\n]+$/g)||[]){
  const mark=line.match(/^ {0,3}(`{3,}|~{3,})/);
  if(fence){if(mark&&mark[1][0]===fence[0]&&mark[1].length>=fence.length&&line.slice(mark[0].length).trim()==='')fence=null;}
  else if(mark)fence=mark[1];
  else {const h=line.match(/^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*\r?\n?$/);if(h)headings.push({at:offset,end:offset+line.length,title:h[2].trim(),level:h[1].length});}
  offset+=line.length;
 }
 if(!text.trim())return {prefix:text,sections:[]};
 if(!headings.length)return {prefix:'',sections:[{title:'전체 지시',label:'전체 지시',body:text,content:text}]};
 const titleOnly=headings[0].level===1&&!text.slice(0,headings[0].at).trim()&&headings.length>1;
 const active=titleOnly?headings.slice(1):headings;
 return {prefix:text.slice(0,active[0].at),sections:active.map((h,i)=>({title:h.title,label:labels[h.title]||h.title,body:text.slice(h.at,active[i+1]?.at??text.length),content:text.slice(h.end,active[i+1]?.at??text.length)}))};
}
const rowButton=(id,label,content)=>`<button type="button" class="dd-open" aria-controls="${id}" aria-expanded="false" aria-label="${e(label)} 원문 펼치기"><span class="dd-preview">${content}</span><span class="dd-chevron" aria-hidden="true">›</span></button>`;
const original=(id,title,html)=>`<tr class="dd-expanded" id="${id}" hidden><td colspan="3"><div class="dd-original"><div class="dd-original-head"><span>원문 · ${e(title)}</span><button type="button" data-dd-close="${id}">접기</button></div><div class="dw-prose dd-original-body">${html}</div></div></td></tr>`;
export function renderInstructionTable(c) {
 const {prefix,sections}=instructionSections(c.body),guide=approvedDetailGuide(c)?.work;
 if(!sections.length)return '<p class="muted">작업 지시가 없습니다.</p>';
 return `<div class="dd-work-tools"><h3>작업 지시 <span id="dd-work-count">${sections.length}개 항목</span></h3><label class="dd-work-search"><span class="dw-sr">작업 지시 검색</span><input id="dd-work-search" type="search" placeholder="항목·원문에서 찾기"></label></div><p class="dd-help dd-table-only">${guide?'요약으로 훑고, 행을 펼쳐 세부 조건과 원문을 읽습니다.':'원문의 앞부분으로 훑고, 행을 펼쳐 세부 조건을 읽습니다.'}</p>${prefix.trim()?`<details class="dd-work-prefix"><summary>원문 제목·소개</summary><div class="dw-prose">${renderCardDocument(prefix,c)}</div></details>`:''}<div class="dd-work-scroll" tabindex="0" aria-label="작업 지시 항목"><table class="dd-work-table"><caption class="dw-sr">원본 작업 지시의 항목과 미리보기</caption><colgroup><col class="dd-work-label"><col><col class="dd-work-toggle"></colgroup><thead><tr><th scope="col">항목</th><th scope="col">${guide?'읽기용 요약':'원문 미리보기'}</th><th scope="col"><span class="dw-sr">펼치기</span></th></tr></thead><tbody>${sections.map((s,i)=>{const id='dd-work-original-'+i;const text=s.content.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm,'').trim();return `<tr data-dd-row="${id}" id="dd-work-row-${i}"><th scope="row" title="${e(s.title)}">${e(s.label)}</th><td><span class="dd-work-preview">${e(guide?.[s.title]?.[1]||preview(text)||'본문 없음')}</span></td><td>${rowButton(id,s.label,'')}</td></tr>${original(id,s.title,renderCardDocument(s.body,c))}`;}).join('')}</tbody></table><div id="dd-work-empty" hidden><p>일치하는 항목이 없습니다.</p><button type="button" data-dd-reset>검색 지우기</button></div></div>`;
}
export function detailEvents(c) {
 const changes=new Map(statusChanges(c).map(h=>[h.revision??h.at,h]));
 return [
  ...(c.history||[]).map(h=>{const change=changes.get(h.revision??h.at);
   const turn=Number.isInteger(h.turnRevision)&&h.turnRevision===h.revision&&h.turnAt===h.at&&h.turnBy===h.by;
   return {at:h.at,by:h.by,kind:turn?'차례 지정':({decision:'내부 판단',question:'질문',answer:'내부 답변',progress:'진행 보고'})[h.noteKind]||h.noteKind||'기록',note:h.note||'',turn:turn?'현재 차례 → '+(h.turnOwner||'미지정'):'',transition:change?`${stateText[change.from]||change.from||'등록'} → ${stateText[change.to]||change.to}`:''};}),
  // 발령자는 runs.by에 있다. 완료 확인자는 현재 자료에 없으므로 모름으로 남긴다.
  ...(c.runs||[]).flatMap(r=>[{at:r.sentAt,by:r.by,byLabel:'발령자',kind:'지시 전달',note:'담당: '+(r.role||'모름')},...(['done','failed'].includes(r.state)?[{at:r.at,by:null,kind:r.state==='done'?'실행 완료 기록':'실행 실패 기록',note:'담당: '+(r.role||'모름')+' · 결과: '+(r.result||r.state)}]:[])]).filter(h=>h.at)
 ].sort((a,b)=>(Date.parse(b.at)||0)-(Date.parse(a.at)||0));
}
export function renderDetailHistory(events) {
 if(!events.length)return '<h3>전체 기록</h3><p class="muted">기록이 없습니다.</p>';
 return `<div class="dd-history-heading"><h3>전체 기록 <span>${events.length}건</span></h3><p class="dd-help">최신순 · 행을 펼쳐 원문 확인</p></div><div class="dd-history-scroll" tabindex="0" aria-label="카드와 실행 이력 · 좌우 스크롤 가능"><table class="dd-history-table"><caption class="dw-sr">시각, 기록 종류, 기록자와 원문</caption><colgroup><col class="dd-time-col"><col class="dd-kind-col"><col class="dd-by-col"><col></colgroup><thead><tr><th scope="col">시각</th><th scope="col">기록 종류</th><th scope="col">기록자·발령자</th><th scope="col">내용</th></tr></thead><tbody>${events.map((h,i)=>{const id='dd-history-original-'+i;return `<tr data-dd-row="${id}" id="dd-history-row-${i}"><td class="dd-time" title="${e(stamp(h.at))}">${e(shortStamp(h.at))}</td><td><strong>${e(h.kind)}</strong></td><td title="${e(h.byLabel||'기록자')}: ${e(h.by||'모름')}">${e(h.by||'모름')}</td><td>${rowButton(id,h.kind,e(preview([h.turn,h.note].filter(Boolean).join(' · '))||'내용 미기록'))}</td></tr><tr class="dd-expanded" id="${id}" hidden><td colspan="4"><div class="dd-history-original dd-original"><div class="dd-original-head"><span>${e(h.byLabel||'기록자')}: ${e(h.by||'모름')} · ${e(stamp(h.at))}</span><button type="button" data-dd-close="${id}">접기</button></div>${h.turn?`<p class="dd-transition">${e(h.turn)}</p>`:''}${h.transition?`<p class="dd-transition">${e(h.transition)}</p>`:''}<p class="dd-history-note">${e(h.note||'내용 미기록')}</p></div></td></tr>`;}).join('')}</tbody></table></div>`;
}
const proofMeta=p=>`${({'card-history':'카드 변경 이력','card-state':'카드 저장 상태',ledger:'실행 원장',session:'세션 조회',progress:'진행 보고 이력',activity:'활동 보고 기록'})[p.source]||'근거 미확인'} · ${p.by||'기록자 모름'} · ${p.at?stamp(p.at):'시각 미기록'}`;
const proof=(title,text,meta)=>`<details class="dd-proof"><summary>${e(title)}<span>${e(meta)}</span></summary><p>${e(text||'미기록')}</p></details>`;
export function renderDetailSummary(c,{brief,report,reviews=[],reviewLinks='',decisions=[],decisionError=false,events=[],compact=false,showRecent=true}={}) {
 const ctx=statusContext(c),next=c.nextAction||brief?.next,reason=ctx.reason||'변경 이유 미기록';
 const latest=events.slice(0,3),guide=approvedDetailGuide(c)?.summary;
 const checked=guide?`<div class="dd-section"><h3>기록에서 확인할 범위</h3><table class="dd-facts-table"><thead><tr><th scope="col">확인 항목</th><th scope="col">범위·내용</th><th scope="col">상태</th></tr></thead><tbody>${guide.results.map(([title,description,label,type])=>`<tr><th scope="row">${e(title)}</th><td>${e(description)}</td><td class="dd-result-${e(type||'checked')}">${e(label)}</td></tr>`).join('')}</tbody></table></div>`:'';
 const context=`<div class="dd-situation"><h3>지금 상황</h3><div><p class="dw-situation">${e(guide?.headline||progressLabel(c))}</p>${guide||brief?.summary?`<p class="dd-description">${e(guide?.description||brief.summary)}</p>`:`<p class="dd-description dd-clamp">${e(reason)}</p>`}${proof('상태 이유 원문',reason,proofMeta(ctx.reasonEvidence))}${proof('현재 표시 근거',ctx.displayEvidence.text,proofMeta(ctx.displayEvidence))}</div></div>${checked}${guide?'<details class="dd-supporting"><summary>작업 범위·보고·검수 연결 확인</summary>':'<div class="dd-section"><h3>기록에서 확인할 내용</h3>'}<table class="dd-facts-table"><thead><tr><th scope="col">확인 항목</th><th scope="col">범위·내용</th><th scope="col">출처</th></tr></thead><tbody><tr><th scope="row">작업 범위</th><td>${e(c.scope||'미기록')}</td><td>카드 기록</td></tr><tr><th scope="row">최근 작업 보고</th><td>${report.state==='reported'?`${e(report.by||'모름')} · ${e(stamp(report.at))} <button type="button" data-read-tab="evidence">보고 읽기 →</button>`:report.state==='unknown'?'보고 확인 불가':'현재 발령 이후 보고 없음'}</td><td>${report.state==='reported'?'담당자 보고':report.state==='unknown'?'모름':'미기록'}</td></tr><tr><th scope="row">연결된 검수</th><td>${reviews.length?`<ul>${reviewLinks}</ul>`:'현재 라운드에 연결된 검수 카드가 없습니다.'}</td><td>${reviews.length?'검수 카드':'연결 없음'}</td></tr></tbody></table>${guide?'</details>':'</div>'}`;
 const follow=`<div class="dd-next"><h3>다음 확인</h3><div>${guide?`<p class="dd-follow-title">${e(guide.followTitle)}</p><p>${e(guide.follow)}</p>${guide.todos?`<ol>${guide.todos.map(t=>`<li>${e(t)}</li>`).join('')}</ol>`:''}${next?proof('다음 행동 원문',next,'카드에 기록된 다음 행동'):''}`:`<p>${e(next||'다음 행동 미기록')}</p>`}<p class="dd-meta">확인 담당 <strong>${e(c.resolutionOwner||'미기록')}</strong></p>${brief?.blocker?`<p>막힌 점: ${e(brief.blocker)}</p>`:''}${c.replacedBy?`<p>후속 카드: <a data-card-key="${e(c.replacedBy)}" href="?card=${encodeURIComponent(c.replacedBy)}#detail">${e(c.replacedBy)}</a></p>`:''}${decisionError?'<p>사용자 결정 요청 모름</p>':decisions.length?`<ul>${decisions.map(d=>`<li><a href="#decision-${e(d.id)}">${e(d.question)}</a> · ${d.status==='open'?'답변 필요':'처리 기록'}</li>`).join('')}</ul>`:'<p class="dd-meta">요청된 사용자 결정 없음</p>'}</div></div>`;
 const recent=`<div class="dd-section"><div class="dd-section-heading"><h3>최근 기록</h3><button type="button" data-read-tab="history">전체 기록 ${events.length}건 →</button></div>${latest.length?`<ol class="dd-recent">${latest.map(h=>`<li><time title="${e(stamp(h.at))}">${e(shortStamp(h.at))}</time><span><strong>${e(h.kind)}</strong> · ${e(h.by||'모름')}<span class="dd-recent-note">${e(preview(h.note,150)||'내용 미기록')}</span></span></li>`).join('')}</ol>`:'<p class="muted">기록 없음</p>'}</div>`;
 const attention=compact?`${c.replacedBy?`<p>후속 카드: <a data-card-key="${e(c.replacedBy)}" href="?card=${encodeURIComponent(c.replacedBy)}#detail">${e(c.replacedBy)}</a></p>`:''}${decisionError?'<p>사용자 결정 요청 모름</p>':decisions.length?`<ul>${decisions.map(d=>`<li><a href="#decision-${e(d.id)}">${e(d.question)}</a> · ${d.status==='open'?'답변 필요':'처리 기록'}</li>`).join('')}</ul>`:''}`:'';
 return compact?`${attention}<details class="dd-supporting"><summary>상태 이유·범위·보고 원문</summary>${context}${follow}</details>${showRecent?recent:''}`:context+follow+recent;
}
