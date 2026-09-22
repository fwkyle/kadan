// 화면의 설명도 저장된 상태만 사용한다. 완료 미확인을 실행 중이나 실패로 바꾸지 않는다.
export function summarizeOperationsFlow(data){
 const count={ok:0,failed:0,partial:0,unreported:0,unknown:0};
 for(const execution of data.executions)count[Object.hasOwn(count,execution.reportState)?execution.reportState:'unknown']++;
 const total=data.executions.length,handovers=data.handovers;
 const accepted=(handovers||[]).filter(h=>h.accepted).length;
 const handoverUnknown=handovers===null||(handovers||[]).some(h=>h.error);
 const central=({open:'미마감',hold:'보류 · 미마감',done:'업무 마감',cancelled:'업무 취소'})[data.work.status]||'모름';
 const report=total?`완료 보고 ${count.ok} / ${total}`:'연결된 실행 없음';
 const reportDetail=[count.failed&&`실패 보고 ${count.failed}개`,count.partial&&`일부 보고 ${count.partial}개`,count.unreported&&`완료 미확인 ${count.unreported}개`,count.unknown&&`상태 모름 ${count.unknown}개`].filter(Boolean).join(' · ')||(total?'모든 연결 실행에 성공 종료 신호가 있습니다.':'업무에 연결된 실행 기록이 없습니다.');
 const handover=handovers===null?'인수 상태 모름':handovers.length?`수락 기록 ${accepted}건`:'인수 연결 미확인';
 let title,description,tone='neutral';
 if(data.errors.length||count.unknown||handoverUnknown){
  title='일부 기록을 확인하지 못했습니다.';description='확인된 상태는 그대로 표시합니다. 모름으로 표시된 항목의 근거를 확인하세요.';tone='warning';
 }else if(data.work.status==='cancelled'){
  title='중앙에 업무 취소가 기록돼 있습니다.';description='작업자 보고와 인수 기록은 취소 기록과 따로 확인할 수 있습니다.';
 }else if(data.work.status==='hold'){
  title='중앙 업무가 보류돼 있습니다.';description='작업자 보고와 함께 업무에 기록된 진척·다음 행동을 확인하세요.';
 }else if(data.work.status==='done'){
  title='중앙 업무의 최종 마감이 기록돼 있습니다.';description='작업자 완료 보고와 인수 수락은 아래에서 각각 확인할 수 있습니다.';
 }else if(data.work.status!=='open'){
  title='중앙 업무 상태를 확인하지 못했습니다.';description='작업자 보고만으로 업무 마감을 판단하지 않습니다.';tone='warning';
 }else if(count.failed){
  title=`실패 보고 ${count.failed}개가 있고, 중앙 업무는 미마감입니다.`;description='작업자 보고를 눌러 해당 실행과 기록된 결과를 확인하세요.';tone='failed';
 }else if(!total){
  title='아직 연결된 실행이 없습니다.';description='중앙 업무의 목표와 현재 진척을 먼저 확인할 수 있습니다.';
 }else if(count.ok===total){
  title='작업자 완료 보고는 모였고, 중앙 마감은 남아 있습니다.';description='완료 보고와 업무 마감은 별도입니다. 중앙에 기록된 진척과 완료 조건을 확인하세요.';tone='attention';
 }else if(count.ok){
  title=`실행 ${total}개 중 ${count.ok}개에 완료 보고가 있고, 중앙은 미마감입니다.`;description='작업자 보고를 누르면 어떤 실행이 끝났고, 어디가 미확인인지 볼 수 있습니다.';
 }else{
  title='작업자 완료 보고가 아직 모두 확인되지 않았습니다.';description='완료 신호가 없는 것만으로 실행 중이거나 실패했다고 판단하지 않습니다.';
 }
 return {count,total,accepted,central,report,reportDetail,handover,handoverUnknown,title,description,tone};
}

export function renderOperationsFlow(){
 return `<section id="operations-flow" class="of-page" data-view="operations-flow" hidden>
 <div class="of-heading"><div><span class="of-eyebrow">운영 흐름</span><h1>누가, 어디까지 진행했는지.</h1><p>업무를 고르고, 현재 상황을 읽고, 궁금한 칸을 눌러 근거를 확인하세요.</p></div><div class="of-actions"><span class="of-readonly">읽기 전용</span><button type="button" data-of-refresh>새로 읽기</button></div></div>
 <div id="of-status" class="of-status" role="status">탭을 열면 업무 목록을 읽습니다.</div>
 <div class="of-mobile-select"><label for="of-work-select">업무 선택</label><select id="of-work-select"><option>조회 전</option></select></div>
 <div class="of-layout"><aside class="of-list-panel" aria-label="업무 선택"><label for="of-search">업무 선택 <span id="of-count">모름</span></label><input id="of-search" type="search" placeholder="업무명 · 담당자 검색"><div id="of-list" class="of-list"><p>아직 조회하지 않았습니다.</p></div><p class="of-list-help">선택한 업무의 기록을 확인합니다.<br>원문은 한 건씩 열어봅니다.</p><small id="of-index-time"></small></aside>
 <div id="of-content" class="of-content"><div class="of-empty"><h2>업무를 선택하세요.</h2><p>선택한 업무에 연결된 실행·보고·인수 근거를 표시합니다.</p></div></div></div>
 </section>`;
}

export const operationsFlowStyle=`
.of-page{
 --ds-color-page:#f5f6fb;--ds-color-text:#202d48;--ds-color-muted:#63718b;--ds-color-border:#dce2f0;
 --ds-color-action:#5754dc;--ds-color-action-soft:#f0efff;--of-soft:#f8f9fd;--of-ok:#087965;--of-warn:#865912;
 color:var(--ds-color-text);background:var(--ds-color-page);padding:28px;min-height:100%;
}
.of-page .of-heading{display:flex;justify-content:space-between;align-items:center;gap:24px;margin:0 0 20px}
.of-eyebrow{display:block;font-size:11px;font-weight:600;color:var(--ds-color-action);letter-spacing:.06em;margin-bottom:9px}
.of-page .of-heading h1{font-size:clamp(24px,2.2vw,32px);letter-spacing:-.045em;line-height:1.3;margin:0 0 8px}
.of-heading p,.of-subtitle{margin:0;color:var(--ds-color-muted);font-size:var(--ds-text-caption)}
.of-actions{display:flex;align-items:center;gap:16px;flex-shrink:0}.of-readonly{font-size:var(--ds-text-caption);color:var(--ds-color-muted);white-space:nowrap}
.of-status{min-height:28px;margin-bottom:20px;color:var(--ds-color-muted);font-size:11px;line-height:1.7}
.of-status[data-tone=warning],.of-partial{padding:10px 14px;background:#fff8ea;color:var(--of-warn);border:1px solid #efdab0;border-radius:8px}
.of-layout{display:grid;grid-template-columns:224px minmax(0,1fr);gap:20px;align-items:start}.of-content{min-width:0}
.of-list-panel{background:var(--ds-color-surface);border:1px solid var(--ds-color-border);border-radius:12px;padding:18px 12px;min-width:0;position:sticky;top:0}
.of-list-panel label{display:flex;flex-direction:row;align-items:center;justify-content:space-between;font-weight:600;margin:0 6px 14px}.of-list-panel label span{font-weight:400;color:var(--ds-color-muted);font-size:var(--ds-text-caption)}
.of-list-panel input{width:100%;margin-bottom:12px}.of-list{max-height:58dvh;overflow:auto;display:grid;gap:8px}
.of-list-help{font-size:11px;color:var(--ds-color-muted);line-height:1.8;border-top:1px solid var(--ds-color-border);padding:14px 6px 0;margin:18px -1px 0}
.of-list-panel>small{display:block;margin:10px 6px 0;font-size:10px;color:var(--ds-color-muted);overflow-wrap:anywhere}
.of-page .of-work-button{display:block;width:100%;text-align:left;padding:14px 12px;background:transparent;border-color:transparent;border-radius:8px;font-weight:400}
.of-work-button strong{display:block;margin:6px 0 12px;line-height:1.6}.of-work-button>small{display:block;font-size:11px;color:var(--ds-color-muted);overflow-wrap:anywhere;margin-top:5px}
.of-page .of-work-button[aria-pressed=true]{border-color:#c7c4ff;background:#f7f6ff}.of-work-button .of-pill{margin-right:6px}
.of-work-heading{margin:3px 0 18px}.of-work-heading h2{margin:0 0 7px;font-size:18px;letter-spacing:-.025em;overflow-wrap:anywhere}.of-work-heading p{overflow-wrap:anywhere}
.of-situation{padding:18px 20px;margin-bottom:18px;background:#eeeffb;border:1px solid #dfe0f5;border-radius:10px}
.of-situation>strong{display:block;font-size:15px;line-height:1.6;letter-spacing:-.02em}.of-situation>p{font-size:var(--ds-text-caption);line-height:1.7;margin:5px 0 0;color:var(--ds-color-muted)}
.of-situation[data-tone=attention],.of-situation[data-tone=warning]{background:#fff8e9;border-color:#efd8a6}.of-situation[data-tone=attention]>strong,.of-situation[data-tone=warning]>strong{color:var(--of-warn)}
.of-situation[data-tone=failed]{background:#fff2f0;border-color:#f0ccc5}.of-situation[data-tone=failed]>strong{color:var(--ds-color-error)}
.of-state-strip{display:flex;flex-wrap:wrap;gap:6px 18px;padding-top:12px;margin-top:12px;border-top:1px solid #dfe2ef;font-size:11px;color:var(--ds-color-muted)}.of-state-strip b{color:var(--ds-color-text);font-weight:600;margin-left:6px}
.of-reading{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:14px;align-items:start}
.of-map,.of-evidence,.of-history{background:var(--ds-color-surface);border:1px solid var(--ds-color-border);border-radius:12px;min-width:0}
.of-map-header{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:18px 20px}.of-map-header h3{font-size:var(--ds-text-control);margin:0}.of-map-header span{font-size:11px;color:var(--ds-color-muted)}
.of-graph{display:grid;grid-template-columns:minmax(0,1fr) 74px minmax(0,1fr);grid-template-rows:auto 70px auto;align-items:stretch;margin:0 14px;padding:24px 12px;background-image:radial-gradient(#dfe5f3 .7px,transparent .7px);background-size:16px 16px}
.of-page .of-node{display:flex;flex-direction:column;align-items:start;justify-content:start;gap:0;width:100%;min-height:156px;padding:19px 16px;text-align:left;background:#fff;border-color:var(--ds-color-border);border-radius:11px;font-weight:400}
.of-page .of-node[aria-pressed=true]{border-color:#7973ff;box-shadow:0 0 0 3px #efeeff;background:#fdfcff}
.of-node-label{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--ds-color-muted);margin-bottom:11px}.of-node-label svg{width:16px;height:16px;flex-shrink:0;color:#7a88ab}
.of-node strong{display:block;font-size:16px;line-height:1.5;letter-spacing:-.025em;overflow-wrap:anywhere;margin:0 0 8px}.of-node small{display:block;font-size:11px;line-height:1.7;color:var(--ds-color-muted);overflow-wrap:anywhere}
.of-node-footer{display:block;font-size:11px;margin-top:auto;padding-top:15px;color:var(--ds-color-action)}.of-node[data-tone=ok] strong{color:var(--of-ok)}.of-node[data-tone=failed] strong{color:var(--ds-color-error)}.of-node[data-tone=warning] strong{color:var(--of-warn)}
.of-relation{align-self:center;text-align:center;color:#7787a7;font-size:10px;padding:0 4px;line-height:1.5}.of-relation:after{content:'';display:block;border-top:1.5px solid #b5c1df;margin-top:8px}
.of-relation--empty:after{border-color:transparent}
.of-vertical{display:flex;justify-content:center;align-items:center;gap:9px;color:#7787a7;font-size:10px;line-height:1.5}.of-vertical:before{content:'';height:100%;border-left:1.5px dashed #b5c1df}
.of-vertical--empty:before{border-color:transparent}.of-graph-handover{grid-column:1;grid-row:3}.of-graph-mail{grid-column:3;grid-row:3}.of-graph-handover-line{grid-column:1;grid-row:2}.of-graph-mail-line{grid-column:3;grid-row:2}
.of-map-note{font-size:11px;line-height:1.7;color:var(--ds-color-muted);margin:0;padding:13px 20px;border-top:1px solid #edf0f7}
.of-evidence{padding:22px 20px;min-height:505px;position:sticky;top:0}.of-evidence>.of-eyebrow{color:#7a86a0;font-size:10px;letter-spacing:.08em;margin:0 0 20px}
.of-evidence h3{font-size:18px;line-height:1.5;letter-spacing:-.025em;margin:0 0 12px;overflow-wrap:anywhere}.of-evidence h4{font-size:var(--ds-text-control);margin:22px 0 10px}
.of-evidence p{font-size:var(--ds-text-caption);line-height:1.8;overflow-wrap:anywhere;color:var(--ds-color-muted)}
.of-evidence dl{margin:18px 0}.of-evidence dt{font-size:11px;color:var(--ds-color-muted);margin-top:12px}.of-evidence dd{font-size:var(--ds-text-caption);margin:5px 0;white-space:pre-wrap;overflow-wrap:anywhere}
.of-evidence details{margin-top:16px;padding-top:14px;border-top:1px solid #edf0f7}.of-evidence summary{font-size:var(--ds-text-caption);color:var(--ds-color-muted);cursor:pointer}.of-evidence details>p{white-space:pre-wrap}
.of-proof{padding:12px;margin:12px 0;background:var(--of-soft);border:1px solid #e8ebf5;border-radius:8px;font-size:var(--ds-text-caption)}.of-proof code{font-size:10px;overflow-wrap:anywhere}.of-proof small{display:block;font-size:11px;color:var(--ds-color-muted);margin-top:4px}
.of-pill{display:inline-block;border-radius:4px;padding:2px 6px;line-height:1.6;background:#edf0f6;color:#5f6e89;font-size:11px;white-space:normal;overflow-wrap:anywhere}.of-pill[data-tone=ok]{color:var(--of-ok);background:#e9f5f1}.of-pill[data-tone=warning]{color:var(--of-warn);background:#fff3d9}.of-pill[data-tone=failed]{color:var(--ds-color-error);background:#fff0ed}
.of-record-list{display:grid;max-height:420px;overflow:auto;margin:14px -4px;padding:4px;gap:0}.of-page .of-record{width:100%;display:block;text-align:left;padding:13px 4px;background:transparent;border:0;border-bottom:1px solid #e9edf5;border-radius:0;font-weight:400}
.of-record strong{display:block;font-size:var(--ds-text-caption);line-height:1.6;overflow-wrap:anywhere;margin:0 0 5px}.of-record small{display:block;font-size:11px;color:var(--ds-color-muted);line-height:1.7;overflow-wrap:anywhere;margin-bottom:5px}
.of-page .of-back{margin:0 0 14px;padding-left:0;background:transparent;border-color:transparent;color:var(--ds-color-action);font-size:var(--ds-text-caption)}
.of-page button:hover{border-color:#aba6ea;background:var(--ds-color-action-soft)}.of-page :where(button,input,select,summary):focus-visible{outline:2px solid var(--ds-color-action);outline-offset:3px}
.of-page .of-open-body{width:100%;margin:12px 0;background:var(--ds-color-action);border-color:var(--ds-color-action);color:#fff}.of-page .of-open-body:hover{background:#4743bb}
.of-body{max-height:460px;overflow:auto;padding:14px;background:var(--of-soft);border:1px solid var(--ds-color-border);border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--ds-text-caption);line-height:1.8}
.of-mail-filter label{display:block;font-size:11px;color:var(--ds-color-muted);margin-bottom:6px}.of-mail-filter select{width:100%;min-width:0}.of-mail-paging{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;margin-top:16px}
.of-empty{padding:32px 24px;background:var(--ds-color-surface);border:1px solid var(--ds-color-border);border-radius:12px;color:var(--ds-color-muted)}.of-empty h2{font-size:var(--ds-text-heading);color:var(--ds-color-text)}
.of-history{margin-top:16px;padding:16px 20px}.of-history summary{font-size:var(--ds-text-caption);cursor:pointer}.of-history ol{padding-left:20px;font-size:var(--ds-text-caption);color:var(--ds-color-muted)}.of-history li{margin:14px 0}.of-history li small{display:block;font-size:11px}.of-history li p{margin:4px 0;overflow-wrap:anywhere}
.of-partial{font-size:var(--ds-text-caption);margin-bottom:12px}.of-mobile-select{display:none}
@media(min-width:1650px){.of-reading{grid-template-columns:minmax(0,1fr) 340px}.of-page .of-node{min-height:176px;padding:24px}.of-graph{padding:30px 22px;grid-template-columns:minmax(0,1fr) 120px minmax(0,1fr);grid-template-rows:auto 86px auto}.of-evidence{min-height:573px}}
@media(max-width:1199px){.of-page{padding:22px}.of-layout{grid-template-columns:190px minmax(0,1fr);gap:16px}.of-reading{grid-template-columns:minmax(0,1fr)}.of-evidence{position:static;min-height:0}.of-evidence .of-record-list{max-height:360px}.of-graph{grid-template-columns:minmax(0,1fr) 88px minmax(0,1fr)}}
@media(max-width:799px){.of-page{padding:22px 16px}.of-heading{align-items:start;flex-wrap:wrap}.of-actions{width:100%;justify-content:space-between}.of-heading p{line-height:1.8}.of-status{margin-bottom:14px}.of-layout{grid-template-columns:minmax(0,1fr)}.of-list-panel{display:none}.of-mobile-select{display:block;margin-bottom:24px}.of-mobile-select label{display:block;font-size:var(--ds-text-caption);margin-bottom:7px;color:var(--ds-color-muted)}.of-mobile-select select{width:100%;min-width:0}.of-work-heading h2{font-size:17px}.of-situation{padding:16px}.of-situation>strong{font-size:15px}.of-state-strip{gap:7px 12px}.of-map-header{padding:16px;align-items:start;flex-direction:column;gap:4px}.of-graph{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:auto auto;gap:12px;margin:0 8px;padding:14px 8px 20px}.of-relation,.of-vertical{display:none}.of-graph-handover{grid-column:1;grid-row:2}.of-graph-mail{grid-column:2;grid-row:2}.of-page .of-node{padding:14px 12px;min-height:180px}.of-node strong{font-size:15px}.of-node-label{font-size:10px;gap:5px}.of-node-label svg{width:14px;height:14px}.of-map-note{padding:12px 16px}.of-evidence{padding:20px}.of-history{padding:16px}}
@media(max-width:799px){.of-page .of-heading{gap:12px;margin-bottom:12px}.of-heading .of-eyebrow{display:none}.of-heading p{font-size:11px}.of-mobile-select{margin-bottom:16px}.of-work-heading{margin-bottom:12px}}
`;

// 페이지에 독립적으로 삽입한다. 서버 값은 실행 가능한 마크업이 아닌 문자로 표시한다.
export function installOperationsFlow(summarize){
 const root=document.getElementById('operations-flow');if(!root)return;
 const $=id=>document.getElementById(id);
 const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const when=value=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('ko-KR',{hour12:false}):'시각 모름';
 const workStatus={open:'진행 중 · 미마감',hold:'보류 · 미마감',done:'업무 완료',cancelled:'업무 취소'};
 const reportStatus={ok:'완료 보고 있음',failed:'실패 보고 있음',partial:'일부 완료 보고',unreported:'완료 미확인',unknown:'상태 모름'};
 const handoverStatus={preparing:'인수 준비 중',prepared:'인수 준비',accepted:'인수 수락', 'routes-pending':'보고 관계 반영 대기',transferred:'담당 이전 기록',stopped:'선임 종료 기록','activation-pending':'후임 활성화 확인 중',complete:'전환 완료',aborted:'인계 취소'};
 let works=null,selected='',data=null,node='work',mailScope='',listRequest=null,request=null,bodyRequest=null,started=false;
 const active=()=>location.hash==='#operations-flow';
 const status=(message,tone='')=>{$('of-status').textContent=message;$('of-status').dataset.tone=tone;};
 const pill=(text,tone='')=>`<span class="of-pill" data-tone="${tone}">${escape(text)}</span>`;
 const mailResponsibility=m=>(m.currentSender||m.by)!==m.by||(m.currentRecipient||m.to)!==m.to?`현재 책임: ${m.currentSender||m.by||'모름'} → ${m.currentRecipient||m.to||'모름'}`:'';
 const mailState=m=>[mailResponsibility(m),m.completion?'실행 결과 통지':'',m.notificationOnly===true||m.systemGenerated==='task-completion'?'기록용 · 추가 알림 없음':'',m.read===true?'받는 사람 읽음 확인':m.read===false?'읽음 미확인':'읽음 모름',({waiting:'답변 대기',answered:'답변 완료',cancelled:'질문 취소'})[m.replyStatus]||'',m.replyFinalRejected?'전달됨 · 답변종결 반영 안됨':m.replyFinal?'최종 답장':''].filter(Boolean).join(' · ');
 const proof=(source,at,by)=>`<div class="of-proof"><code>${escape(source||'기록 주소 모름')}</code><small>${escape(when(at))}</small><small>기록자 ${escape(by||'모름')}</small></div>`;
 const facts=values=>`<dl>${values.map(([label,value])=>`<dt>${escape(label)}</dt><dd>${escape(value||'미기록')}</dd>`).join('')}</dl>`;
 async function json(url,signal){const response=await fetch(url,{signal,credentials:'same-origin',cache:'no-store'});const value=await response.json();if(!response.ok)throw new Error(value.error||'조회 실패');return value;}
 function renderList(){
  const words=$('of-search').value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches=(works||[]).filter(w=>words.every(word=>[w.title,w.key,w.owner,w.followup?.label,w.followup?.owner,w.followup?.next].join(' ').toLocaleLowerCase().includes(word)));
  $('of-count').textContent=works===null?'모름':`${matches.length}건`;
  $('of-list').innerHTML=works===null?'<p>업무 목록 상태 모름</p>':!works.length?'<p>등록된 업무가 없습니다. 기존 작업 탭의 연결 전 실행은 그대로 보존됩니다.</p>':!matches.length?'<p>검색 결과가 없습니다.</p>':matches.map(w=>`<button type="button" class="of-work-button" data-of-work="${escape(w.key)}" aria-pressed="${selected===w.key}"><small>${escape(w.key.split('/')[0])}</small><strong>${escape(w.title)}</strong>${pill(workStatus[w.status]||'모름',w.status==='done'?'ok':'')}<small>${escape(w.followup?.label||'다음 행동 미지정')} · ${escape(w.followup?.owner==='@user'?'사용자':w.followup?.owner||w.owner||'담당 미기록')}</small></button>`).join('');
  $('of-work-select').innerHTML=(works||[]).map(w=>`<option value="${escape(w.key)}" ${w.key===selected?'selected':''}>${escape(w.title)}</option>`).join('')||`<option value="">${works===null?'업무 목록 상태 모름':'등록된 업무 없음'}</option>`;
 }
 const group=()=>node.startsWith('execution:')?'reports':node.startsWith('handover:')?'handovers':node.startsWith('mail:')?'mails':node;
 const reportTone=c=>c.reportState==='ok'?'ok':c.reportState==='failed'?'failed':c.reportState==='unknown'?'warning':'';
 const icon=id=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${({work:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',reports:'<circle cx="12" cy="7" r="4"/><path d="M4 21v-3a8 8 0 0 1 16 0v3"/>',handovers:'<path d="M3 7h17m-5-5 5 5-5 5M21 17H4m5-5-5 5 5 5"/>',mails:'<path d="M5 3h9l5 5v13H5zM14 3v6h5M8 13h8M8 17h6"/>'})[id]}</svg>`;
 function graphNode(id,label,title,sub,footer,tone=''){
  return `<button type="button" class="of-node of-graph-${id==='handovers'?'handover':id==='mails'?'mail':id}" data-of-node="${id}" data-tone="${tone}" aria-pressed="${group()===id}"><span class="of-node-label">${icon(id)}${escape(label)}</span><strong>${escape(title)}</strong><small>${escape(sub)}</small><span class="of-node-footer">${escape(footer)} <span aria-hidden="true">→</span></span></button>`;
 }
 function render(){
  if(!data)return;
  const w=data.work,s=summarize(data),h=data.handovers;
  const handoverDetail=h===null?'조회에 실패했습니다.':h.length===1?`${handoverStatus[h[0].phase]||'단계 모름'} · ${h[0].error?'현재 상태 미확인':h[0].to+'에게 인계'}`:h.length?`연결된 인계 ${h.length}건 · 각 단계는 근거에서 확인`:'이 업무와 연결된 인수 근거가 없습니다.';
  $('of-content').innerHTML=`<div class="of-work-heading"><h2>${escape(w.title)}</h2><p class="of-subtitle">${escape(w.key.split('/')[0])} · 책임 감독 ${escape(w.owner||'모름')}</p></div>
  <div class="of-situation" data-tone="${s.tone}"><strong>${escape(data.followup?.label||s.title)}</strong><p>${escape(data.followup?.next||s.description)}</p>${data.followup?.owner?`<p>다음 담당 · ${escape(data.followup.owner==='@user'?'사용자':data.followup.owner)}</p>`:''}<div class="of-state-strip"><span>작업자<b>${escape(s.report)}</b></span><span>중앙<b>${escape(s.central)}</b></span><span>인수<b>${escape(s.handover)}</b></span></div></div>
  ${data.errors.map(message=>`<div class="of-partial" role="status">${escape(message)}</div>`).join('')}
  <div class="of-reading"><div class="of-map"><div class="of-map-header"><h3>업무 관계도</h3><span>궁금한 칸을 눌러 근거 확인</span></div><div class="of-graph">
  ${graphNode('work','중앙 업무',s.central,`책임 감독 · ${w.owner||'모름'}`,'업무 근거 보기',w.status==='done'?'ok':'')}
  <div class="of-relation ${s.total?'':'of-relation--empty'}">${s.total?'실행 연결':''}</div>
  ${graphNode('reports','작업자 완료 보고',s.report,s.reportDetail,`실행 ${s.total}개 보기`,s.count.failed?'failed':s.count.unknown?'warning':s.total&&s.count.ok===s.total?'ok':'')}
  <div class="of-vertical of-graph-handover-line ${h?.length?'':'of-vertical--empty'}">${h?.length?'실행으로 연결':''}</div>
  <div class="of-vertical of-graph-mail-line ${data.mail.total?'':'of-vertical--empty'}">${data.mail.total?'업무·실행에 연결':''}</div>
  ${graphNode('handovers','인수 상태',s.handover,handoverDetail,'인수 근거 보기',s.handoverUnknown?'warning':s.accepted?'ok':'')}
  ${graphNode('mails','보고·대화 원문',data.mail.total===null?'우편 상태 모름':`연결 우편 ${data.mail.total}통`,'완료 보고와 일반 대화를 구분해 읽습니다.','목록에서 원문 선택')}
  </div><p class="of-map-note">연결선은 기록 사이의 관계입니다. 작업자 완료 보고 · 중앙 마감 · 인수 수락은 각각 별도 상태입니다.</p></div>
  <aside id="of-evidence" class="of-evidence" aria-label="선택한 기록의 근거"></aside></div>
  <details class="of-history"><summary>업무 변경 기록 · 최근 ${data.history.length}건</summary><ol>${data.history.map(h=>`<li>${escape(({create:'업무 등록',update:'업무 보고',link:'실행 연결',execute:'실행 등록',unlink:'연결 정정',mail:'우편 연결',complete:'업무 최종 완료',cancel:'업무 취소',reopen:'업무 다시 열기'})[h.action]||h.action)} · ${escape(workStatus[h.status]||h.status)}<small>버전 ${h.revision} · ${escape(when(h.at))} · ${escape(h.by||'모름')}</small><p>${escape(h.note)}</p></li>`).join('')}</ol></details>`;
  renderEvidence();
 }
 const back=(target,label)=>`<button type="button" class="of-back" data-of-node="${target}">← ${label}</button>`;
 const recordDetails=content=>`<details><summary>기록 주소·시각 확인</summary>${content}</details>`;
 function handoverEvidence(h){
  return `<h3>인수 수락과 전환 상태</h3>${pill(h.accepted?'인수 수락 기록 있음':'인수 수락 미확인',h.accepted?'ok':'')}<p>현재 단계 · <strong>${escape(handoverStatus[h.phase]||'모름')}</strong></p>${h.error?`<p class="of-partial">${escape(h.error)}</p>`:''}${facts([['넘긴 사람',h.from],['받는 사람',h.to]])}<p>인수를 수락한 것과 전체 업무를 마감한 것은 별도 기록입니다.</p>${h.accepted?`<p>수락 기록 시각 · ${escape(when(h.acceptedAt))}</p>`:''}${recordDetails(facts([['인계 ID',h.id],['연결 실행',h.executionKeys.join('\n')],['현재 상태 출처',h.fileRef||'마지막 원장 기록']])+(h.accepted?proof(h.acceptedRef||h.fileRef,h.acceptedAt,h.to):'')+proof(h.ref,h.at,null))}`;
 }
 function renderEvidence(){
  if(!data)return;const w=data.work,s=summarize(data);let content='';
  if(node==='work'){
   const explanation=({open:'책임 감독의 최종 마감 기록이 아직 없습니다.',hold:'업무가 보류돼 있습니다. 기록된 진척과 다음 행동을 확인하세요.',done:'책임 감독의 최종 마감이 업무에 기록돼 있습니다.',cancelled:'업무 취소가 기록돼 있습니다.'})[w.status]||'업무 상태 모름';
   content=`<h3>중앙 업무 마감</h3>${pill(s.central,w.status==='done'?'ok':'')}<p>${escape(explanation)}</p>${facts([['책임 감독',w.owner],['약속한 결과',w.goal]])}${w.progress?`<details><summary>기록된 진척</summary><p>${escape(w.progress)}</p></details>`:''}${w.nextAction?`<details><summary>기록된 다음 행동</summary><p>${escape(w.nextAction)}</p></details>`:''}<details><summary>완료 조건${w.result?'·최종 결과':''}</summary>${facts([['완료 조건',w.acceptance],['최종 결과',w.result]])}</details>${data.timing?`<details><summary>업무 경과 시간</summary>${facts([['업무 시작',when(data.timing.openedAt)],['업무 마감',data.timing.closedAt?when(data.timing.closedAt):'미마감'],['경과 시간',data.timing.elapsedMs===null?'미측정':Math.floor(data.timing.elapsedMs/60000)+'분'],['구현·검수 왕복',data.timing.cycles+'싸이클'],['실행에 명시 연결된 감시 호출',data.timing.linkedWatchCalls===null?'미측정':data.timing.linkedWatchCalls+'회'],['실제 작업 시간','미측정']])}<p>경과 시간에는 대기가 포함됩니다. 감시 횟수는 실행 주소가 연결된 기록만 세며 비용을 뜻하지 않습니다.</p></details>`:''}${recordDetails(proof(`works/${w.key}/events.jsonl · 버전 ${w.revision}`,w.at,w.by))}`;
  }else if(node==='reports'){
   content=`<h3>어떤 실행이 끝났나</h3>${pill(s.report,s.count.failed?'failed':'')}<p>${escape(s.reportDetail)}</p><div class="of-record-list">${data.executions.map(c=>`<button type="button" class="of-record" data-of-node="execution:${escape(c.key)}"><strong>${escape(c.title)}</strong><small>${escape(c.role||'담당 미기록')}</small>${pill(reportStatus[c.reportState]||'상태 모름',reportTone(c))}</button>`).join('')}</div><p>완료 보고는 원장의 종료 신호 기준입니다. 보고 원문과 검수 결과는 각각 확인합니다.</p>`;
  }else if(node.startsWith('execution:')){
   const c=data.executions.find(c=>`execution:${c.key}`===node);if(!c){node='reports';return renderEvidence();}
   content=back('reports','실행 목록')+`<h3>${escape(c.title)}</h3>${pill(reportStatus[c.reportState]||'상태 모름',reportTone(c))}${facts([['담당',c.role],['단계',`${({implementation:'구현',review:'검수',fix:'수정',release:'배포'})[c.phase]||c.phase} · ${c.round}싸이클`]])}${facts([['다음 행동',data.followup?.executions.find(x=>x.key===c.key)?.next],['다음 담당',data.followup?.executions.find(x=>x.key===c.key)?.owner],['품질 판정',({pass:'검수 합격',changes:'수정 필요',implemented:'구현 결과 등록',exception:'예외 보고'})[c.quality]||'미확인']])}${c.error?`<p class="of-partial">${escape(c.error)}</p>`:''}${c.signals.length?c.signals.map(signal=>`<p>${escape(signal.role)} · ${escape(signal.result==='ok'?'성공 종료 신호':signal.result==='failed'?'실패 종료 신호':'결과 모름')}<br>${escape(when(signal.at))}</p>`).join(''):'<p>유효한 완료 신호가 아직 확인되지 않았습니다.</p>'}<button type="button" data-of-mail-execution="${escape(c.key)}">관련 우편 보기 →</button><p>실행 종료는 전체 업무의 마감과 별개입니다.</p>${c.timing?`<details><summary>실행 경과 시간</summary>${facts([['발령→결과 등록',c.timing.dispatchToResultMs===null?'미측정':Math.floor(c.timing.dispatchToResultMs/60000)+'분'],['발령→DONE 확정',c.timing.dispatchToDoneMs===null?'미측정':Math.floor(c.timing.dispatchToDoneMs/60000)+'분'],['완료 관측→DONE 확정','미측정']])}</details>`:''}${recordDetails(facts([['실행 주소',c.key],['카드 저장 상태',c.status],['버전',c.revision]])+c.signals.map(signal=>proof(signal.ref,signal.at,signal.by)).join(''))}`;
  }else if(node==='handovers'){
   if(data.handovers?.length===1)content=handoverEvidence(data.handovers[0]);
   else content=`<h3>인수 상태</h3>${pill(s.handover,s.handoverUnknown?'warning':'')}<p>${data.handovers===null?'인수 기록을 조회하지 못했습니다.':!data.handovers.length?'이 업무와 연결된 인수 근거가 없습니다. 담당자 이름만으로 인수 관계를 추측하지 않습니다.':'인계를 선택해 수락 기록과 현재 전환 단계를 확인하세요.'}</p><div class="of-record-list">${(data.handovers||[]).map(h=>`<button type="button" class="of-record" data-of-node="handover:${escape(h.id)}"><strong>${escape(h.from)} → ${escape(h.to)}</strong><small>${escape(handoverStatus[h.phase]||'단계 모름')}</small>${pill(h.accepted?'인수 수락 기록 있음':'인수 수락 미확인',h.error?'warning':h.accepted?'ok':'')}</button>`).join('')}</div>`;
  }else if(node.startsWith('handover:')){
   const h=(data.handovers||[]).find(h=>`handover:${h.id}`===node);if(!h){node='handovers';return renderEvidence();}content=back('handovers','인수 목록')+handoverEvidence(h);
  }else if(node==='mails'){
   const filtered=data.mail.items.filter(m=>!mailScope||(mailScope==='unassigned'?!m.executionKey:m.executionKey===mailScope));
   content=`<h3>보고·대화 원문</h3><p>보낸 사람과 연결된 실행을 보고, 필요한 편지 한 건을 선택하세요.</p><div class="of-mail-filter"><label for="of-mail-filter">이번 페이지에서 실행별로 보기</label><select id="of-mail-filter"><option value="">모든 연결 우편</option><option value="unassigned" ${mailScope==='unassigned'?'selected':''}>실행 지정 없음</option>${data.executions.map(c=>`<option value="${escape(c.key)}" ${mailScope===c.key?'selected':''}>${escape(c.title)}</option>`).join('')}</select></div><p>${data.mail.total===null?'우편 목록 모름 · 새로 읽기로 다시 확인하세요.':`전체 ${data.mail.total}통${data.mail.pages>1?` · ${data.mail.page} / ${data.mail.pages}쪽`:''} · 이번 페이지에서 ${filtered.length}통 표시`}</p><div class="of-record-list">${filtered.map(m=>`<button type="button" class="of-record" data-of-node="mail:${escape(m.ref)}"><strong>${escape(m.by||'모름')} → ${escape(m.to||'모름')}</strong><small>${escape(data.executions.find(c=>c.key===m.executionKey)?.title||'실행 지정 없음')}<br>${escape(when(m.at))}</small>${pill(mailState(m))}${pill(m.hasBodyRef?'원문 참조 있음':'원문 참조 없음')}${m.replyTo?' '+pill('답장'):''}</button>`).join('')||(data.mail.total===null?'<p>우편 기록을 조회하지 못했습니다.</p>':'<p>이 범위에 연결된 편지가 없습니다.</p>')}</div>${data.mail.pages>1?`<div class="of-mail-paging"><button type="button" data-of-page="${data.mail.page-1}" ${data.mail.page===1?'disabled':''}>이전</button><span>${data.mail.page} / ${data.mail.pages}쪽</span><button type="button" data-of-page="${data.mail.page+1}" ${data.mail.page===data.mail.pages?'disabled':''}>다음</button></div>`:''}`;
  }else{
   const m=data.mail.items.find(m=>`mail:${m.ref}`===node);if(!m){node='mails';return renderEvidence();}
   content=back('mails','우편 목록')+`<h3>선택한 우편 원문</h3>${facts([['우편 상태',mailState(m)],['원래 보낸 사람',m.by],['원래 받는 사람',m.to],['현재 발신 책임자',m.currentSender||m.by],['현재 수신 책임자',m.currentRecipient||m.to],['보낸 시각',when(m.at)],['연결된 실행',data.executions.find(c=>c.key===m.executionKey)?.title]])}<button type="button" class="of-open-body" data-of-body="${escape(m.ref)}" ${m.hasBodyRef?'':'disabled'}>이 원문 읽기 →</button><div id="of-body-result" aria-live="polite"></div><p>조회는 읽음·인수·마감 처리를 하지 않습니다.</p>${recordDetails(facts([['우편 ID',m.mailId],['답장 대상',m.replyTo]])+proof(m.ref,m.at,m.by))}`;
  }
  $('of-evidence').innerHTML='<div class="of-eyebrow">선택한 기록의 근거</div>'+content;
  root.querySelectorAll('[data-of-node]').forEach(el=>el.setAttribute('aria-pressed',String(el.classList.contains('of-node')?el.dataset.ofNode===group():el.dataset.ofNode===node)));
 }
 async function load(key,{page=1,write=false}={}){
  request?.abort();bodyRequest?.abort();const controller=new AbortController();request=controller;
  const changed=selected!==key;selected=key;if(changed){data=null;node='work';mailScope='';$('of-content').innerHTML='<div class="of-empty"><h2>선택한 업무를 읽는 중입니다.</h2></div>';}
  if(write){const url=new URL(location.href);url.searchParams.set('flowWork',key);history.pushState(history.state,'',url);}
  renderList();status(data?'새로 조회 중 · 마지막 확인값을 유지합니다.':'선택한 업무를 조회 중입니다.');
  const timer=setTimeout(()=>{if(request===controller)status(data?'조회 지연 · 마지막 확인값입니다.':'조회 지연 · 아직 상태를 확인하지 못했습니다.','warning');},1500);
  try{
   const value=await json('/api/operations-flow?'+new URLSearchParams({work:key,page:String(page)}),controller.signal);
   if(request!==controller||selected!==key)return;
   if(value.work?.key!==key)throw new Error('선택한 업무와 응답이 다릅니다.');
   data=value;render();status(`마지막 성공 조회 ${when(data.collectedAt)}${data.errors.length?' · 일부 상태 모름':''}`,data.errors.length?'warning':'');
  }catch(error){if(request===controller&&error.name!=='AbortError'){status(`조회 실패 · ${data?'마지막 확인값 '+when(data.collectedAt)+'을 유지합니다.':'상태 모름.'} ${error.message}`,'warning');if(!data)$('of-content').innerHTML='<div class="of-empty"><h2>업무 상태 모름</h2><p>새로 읽기로 다시 확인할 수 있습니다.</p></div>';}}
  finally{clearTimeout(timer);if(request===controller)request=null;}
 }
 async function index(){
  listRequest?.abort();const controller=new AbortController();listRequest=controller;started=true;status('업무 목록을 조회 중입니다.');
  try{
   const value=await json('/api/operations-flow',controller.signal);if(listRequest!==controller)return;
   if(!Array.isArray(value.works))throw new Error('업무 목록 응답 확인 필요');
   works=value.works;renderList();$('of-index-time').textContent='목록 조회 '+when(value.collectedAt);
   const requested=new URL(location.href).searchParams.get('flowWork')||selected||works[0]?.key;
   if(requested)await load(requested);else status('등록된 업무가 없습니다.');
  }catch(error){if(listRequest===controller&&error.name!=='AbortError'){renderList();status(`업무 목록 조회 실패 · ${works?'마지막 목록 유지':'상태 모름'}. ${error.message}`,'warning');}}
  finally{if(listRequest===controller)listRequest=null;}
 }
 async function body(recordRef){
  bodyRequest?.abort();const controller=new AbortController();bodyRequest=controller;const key=selected,chosen=node;
  const result=$('of-body-result');result.textContent='원문 한 건을 조회 중입니다.';
  try{
   const value=await json('/api/operations-flow/mail?'+new URLSearchParams({work:key,ref:recordRef}),controller.signal);
   if(bodyRequest!==controller||selected!==key||node!==chosen)return;
   if(value.workKey!==key||value.ref!==recordRef||typeof value.body!=='string')throw new Error('원문 응답 확인 필요');
   const pre=document.createElement('pre');pre.className='of-body';pre.textContent=value.body;result.replaceChildren(pre);
  }catch(error){if(bodyRequest===controller&&selected===key&&node===chosen&&error.name!=='AbortError')result.textContent='원문 조회 실패 · '+error.message;}
  finally{if(bodyRequest===controller)bodyRequest=null;}
 }
 root.addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button)return;
  if(button.dataset.ofWork)load(button.dataset.ofWork,{write:true});
  else if(button.dataset.ofNode||button.dataset.ofMailExecution){
   bodyRequest?.abort();bodyRequest=null;
   const fromEvidence=button.closest('#of-evidence');
   if(button.dataset.ofMailExecution){mailScope=button.dataset.ofMailExecution;node='mails';}else node=button.dataset.ofNode;
   renderEvidence();
   if(fromEvidence){const heading=$('of-evidence').querySelector('h3');heading.tabIndex=-1;heading.focus({preventScroll:true});}
   if(matchMedia('(max-width:1199px)').matches)$('of-evidence').scrollIntoView({block:'nearest'});
  }
  else if(button.dataset.ofBody)body(button.dataset.ofBody);
  else if(button.dataset.ofPage)load(selected,{page:button.dataset.ofPage});
  else if(button.hasAttribute('data-of-refresh'))index();
 });
 $('of-search').addEventListener('input',renderList);
 $('of-work-select').addEventListener('change',event=>{if(event.target.value)load(event.target.value,{write:true});});
 root.addEventListener('change',event=>{if(event.target.id==='of-mail-filter'){mailScope=event.target.value;renderEvidence();$('of-mail-filter').focus({preventScroll:true});}});
 window.addEventListener('operations-flow-refresh',()=>{if(active())index();});
 window.addEventListener('hashchange',()=>{if(active()&&!started)index();});
 window.addEventListener('popstate',()=>{const key=new URL(location.href).searchParams.get('flowWork');if(active()&&key&&key!==selected)load(key);});
 if(active())index();
}

export const operationsFlowScript=`(${installOperationsFlow.toString()})(${summarizeOperationsFlow.toString()});`;
