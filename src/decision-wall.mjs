import {taskIdentity} from './task-identity.mjs';
import {renderLedgerTable,ledgerView,ledgerViews,isWatchRoutine,filterLedgerRows} from './ledger-table.mjs';
import {mailboxLetters} from './mailbox.mjs';
import {filterMail,mailStatus,mailViews,replyStates} from './dashboard-inbox.mjs';
import {activityGuide} from './activity-guide.mjs';
import {readMailBody} from './ledger.mjs';
import {documentLink} from './card-content.mjs';
const e=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
// 결정 글의 맨 주소를 누를 수 있는 링크로 바꾼다. 나머지 글은 그대로 이스케이프한다.
const linked=value=>{const text=String(value??'');let html='',last=0;
 for(const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)){const url=m[0].replace(/[.,;:]+$/,'');html+=e(text.slice(last,m.index))+documentLink(url,url);last=m.index+url.length;}
 return html+e(text.slice(last));};
// 첫 줄의 첫 물음표까지를 제목으로, 나머지는 줄바꿈을 살린 본문으로 보인다(2026-09-23 [kyle]: 한 문단 굵은 글씨라 읽기 어려움).
export const splitQuestion=value=>{const text=String(value??'').trim(),line=text.split('\n')[0],at=line.indexOf('?'),cut=at>=0?at+1:line.length;return [text.slice(0,cut).trim(),text.slice(cut).trim()];};
const time=x=>x?new Date(x).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false}):'모름';
// 방금 답한 결정의 전달 결과를 오른쪽 위 토스트로 알린다. 성공·확인 중은 15초 뒤 사라지고(마우스를 올리면 멈춤),
// 알림 전달 실패는 닫을 때까지 남긴다. 지난 결정은 오른쪽 드로어에서 본다(2026-09-24 [kyle]).
export const decisionStyle=`.decision-toast{position:fixed;right:24px;top:72px;z-index:50;display:flex;gap:12px;align-items:flex-start;max-width:min(520px,calc(100vw - 32px));padding:12px 14px;border-radius:10px;background:#1f2a24;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:14px;line-height:1.5;animation:decision-toast-out .3s ease 15s forwards}
.decision-toast:hover{animation-play-state:paused}
.decision-toast-failed{background:#8a1f1f;animation:none}
.decision-toast .decision-toast-close,.decision-toast .decision-toast-link{flex:none;border:0;background:transparent;box-shadow:none;min-height:0;color:inherit;cursor:pointer;padding:0 2px}
.decision-toast .decision-toast-close{font-size:18px;line-height:1}
.decision-toast .decision-toast-link{font:inherit;text-decoration:underline;text-underline-offset:3px;white-space:nowrap}
.decision-toast .decision-toast-close:hover,.decision-toast .decision-toast-link:hover{background:transparent;opacity:.75}
@keyframes decision-toast-out{to{opacity:0;visibility:hidden}}
@media (max-width:640px){.decision-toast{right:16px;left:16px;top:12px;max-width:none}}
@media (prefers-reduced-motion:reduce){.decision-toast{animation-duration:0s}}
.decision-history-open{margin-top:8px}
.decision-drawer{position:fixed;inset:0 0 0 auto;margin:0;width:min(480px,100vw);max-width:100vw;height:100dvh;max-height:100dvh;padding:0;border:0;border-left:1px solid #cdd8d0;background:#fff;color:#202824;overflow:auto;box-shadow:-12px 0 32px rgba(0,0,0,.12)}
.decision-drawer::backdrop{background:rgb(16 32 23 / .32)}
.decision-drawer .dh-top{position:sticky;top:0;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;background:#fff;border-bottom:1px solid #e0e7e1}
.decision-drawer .dh-top h2{margin:0;font-size:16px}
.decision-drawer .dh-top form{margin:0}
.decision-drawer .dh-list{padding:4px 18px 24px}
.decision-drawer .dh-item{padding:14px 0;border-bottom:1px solid #edf1ee}
.decision-drawer .dh-item h3{margin:6px 0;font-size:14px;line-height:1.45}
.decision-drawer .dh-item p{margin:4px 0;font-size:13px;line-height:1.5}
.decision-drawer .dh-meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:12px;color:#5d6b63}
.decision-drawer .dh-badge{border-radius:999px;padding:1px 8px;font-weight:600}
.decision-drawer .dh-answered{background:#e6f1ea;color:#155e43}
.decision-drawer .dh-cancelled{background:#eef0ef;color:#5d6b63}
.decision-drawer .dh-failed{background:#fbe9e9;color:#8a1f1f}
.decision-drawer .dh-item details{margin-top:6px;font-size:13px}
.decision-drawer .dh-empty{padding:18px;color:#5d6b63}
.decision-send-error{margin:8px 0 0;color:#8a1f1f;font-size:13px;white-space:pre-wrap}
.dd-jump{display:flex;gap:14px;flex-wrap:wrap;margin:4px 0 0;font-size:12.5px}
.run-state{display:inline-block;font-size:12px;font-weight:600;padding:1px 8px;border-radius:999px;background:#eef0ef;color:#5d6762}
.run-failed{background:#fbe1de;color:#a1231b}.run-unconfirmed{background:#f8ead7;color:#8a4b0f}.run-orphaned{background:#ebe5f8;color:#5b3fa0}.run-done{background:#dcf1e2;color:#1c6b38}
.run-key{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#5d6762}
.bw-mail-compact{list-style:none;margin:6px 0 12px;padding:0;display:flex;flex-direction:column;gap:6px}
.bw-mail-compact li{display:grid;grid-template-columns:auto auto minmax(0,1fr);gap:2px 10px;align-items:baseline;font-size:12.5px;padding:6px 0;border-bottom:1px solid #edf1ee}
.bw-mail-compact .bw-mail-text{grid-column:1/-1;overflow-wrap:anywhere}
.lg-incidents{font-size:12.5px;font-weight:700;color:#8a1f1f;margin-right:auto}
.dc-meter{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:13px;color:#5d6762;margin:4px 0 14px}
.dc-bar{flex:1 1 200px;min-width:120px;height:6px;background:#eaede8;border-radius:3px;overflow:hidden}.dc-bar i{display:block;height:100%;background:#1f6f5c}
.dc-list{display:flex;flex-direction:column;gap:12px}
/* 결정 화면 공통 규칙(#decisions form·article, label 세로 쌓기)보다 우선하도록 #decisions를 붙인다. */
#decisions .dc-card{background:#fff;border:1px solid #d9ddd8;border-radius:10px;padding:16px 18px;display:flex;flex-direction:column;gap:10px}
.dc-card:has(.dc-opt:not(.dc-opt-free) input:checked){border-color:#1f6f5c}
.dc-top{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dc-chip{font-size:12px;font-weight:600;padding:2px 8px;border-radius:4px;background:#dcefe8;color:#1f6f5c}
.dc-key{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#5d6762;word-break:break-all}
.dc-age{font-size:12px;color:#5d6762;margin-left:auto}
.dc-card h3{font-size:17px;font-weight:650;margin:0;line-height:1.45;text-wrap:balance}
.dc-fields{margin:0;display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 12px;font-size:14px;line-height:1.55}
.dc-fields dt{color:#5d6762;white-space:nowrap}.dc-fields dd{margin:0;overflow-wrap:anywhere}
.dc-pre{white-space:pre-wrap;margin:0;font-size:14px;line-height:1.55;overflow-wrap:anywhere}
#decisions .dc-form{display:flex;flex-direction:column;gap:8px;margin:2px 0 0;max-width:none}
.dc-opts{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;min-width:0}
#decisions .dc-opt{display:flex;flex-direction:row;gap:8px;align-items:flex-start;border:1px solid #d9ddd8;background:#fff;border-radius:8px;padding:9px 12px;cursor:pointer;font-size:14px;line-height:1.45}
.dc-opt:hover{border-color:#1f6f5c}
.dc-opt input{position:absolute;opacity:0;width:1px;height:1px}
.dc-opt .dc-dot{flex:none;width:14px;height:14px;border-radius:50%;border:2px solid #b9c1bb;margin-top:3px}
.dc-opt:has(input:checked){background:#dcefe8;border-color:#1f6f5c}
.dc-opt:has(input:checked) .dc-dot{border-color:#1f6f5c;background:#1f6f5c}
.dc-opt:has(input:focus-visible){outline:3px solid #21684e;outline-offset:2px}
.dc-opt-free{color:#5d6762;font-size:13px}
.dc-rec{font-size:11px;font-weight:700;color:#1f6f5c;border:1px solid #1f6f5c;border-radius:3px;padding:0 5px;margin-left:6px;white-space:nowrap}
.dc-form textarea{width:100%;min-height:44px;resize:vertical;font:inherit;font-size:14px}
.dc-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.dc-actions small{color:#5d6762;font-size:12px}`;
// 드로어 열기·닫기와 답변 전송. 닫기 버튼은 <form method="dialog">라 스크립트 없이 닫히고, Esc도 기본으로 닫힌다.
// 답변은 페이지를 다시 불러오지 않고 보낸 뒤 결정 영역·드로어·상단 숫자만 바꿔 끼운다 — 스크롤이 맨 위로 튀지 않게
// (2026-09-24 [kyle]). 스크립트가 없으면 폼이 그대로 제출되어 결정 영역으로 돌아간다.
export const decisionScript=`
 document.addEventListener('click',event=>{
  const history=document.getElementById('decision-history');
  if(!history)return;
  if(event.target.closest&&event.target.closest('[data-decision-history-open]')){event.preventDefault();if(!history.open)history.showModal();return;}
  if(event.target!==history)return;
  const r=history.getBoundingClientRect();
  if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)history.close();
 });
 document.addEventListener('submit',async event=>{
  const form=event.target;
  if(!form.matches||!form.matches('form[action="/decisions/answer"]'))return;
  event.preventDefault();
  if(form.dataset.sending)return;
  form.dataset.sending='1';
  const button=form.querySelector('button'),label=button?button.textContent:'';
  form.querySelector('.decision-send-error')?.remove();
  if(button){button.disabled=true;button.textContent='전송 중…';}
  try{
   const response=await fetch(form.action,{method:'POST',credentials:'same-origin',body:new URLSearchParams(new FormData(form))});
   const html=await response.text();
   if(!response.ok)throw new Error(html||'전달 실패. HTTP '+response.status);
   const parsed=new DOMParser().parseFromString(html,'text/html'),section=parsed.getElementById('decisions');
   if(!section)throw new Error('답변은 저장됐을 수 있지만 화면을 새로 읽지 못했습니다. 새로고침해서 확인하세요.');
   // 이 화면은 창이 아니라 <main>이 스크롤된다. 둘 다 기억했다가 되돌린다.
   const main=document.querySelector('main'),top=main?main.scrollTop:0,y=window.scrollY,x=window.scrollX;
   document.getElementById('decisions').replaceWith(document.importNode(section,true));
   const drawer=parsed.getElementById('decision-history'),oldDrawer=document.getElementById('decision-history');
   if(drawer&&oldDrawer&&!oldDrawer.open)oldDrawer.replaceWith(document.importNode(drawer,true));
   const count=parsed.querySelector('.dw-decision-count'),oldCount=document.querySelector('.dw-decision-count');
   if(count&&oldCount)oldCount.replaceWith(document.importNode(count,true));
   if(main)main.scrollTop=top;
   window.scrollTo(x,y);
  }catch(error){
   delete form.dataset.sending;
   if(button){button.disabled=false;button.textContent=label;}
   const alert=document.createElement('p');alert.className='decision-send-error';alert.setAttribute('role','alert');alert.textContent=error.message;
   (button||form).after(alert);
  }
 });
`;
const answeredNotice=d=>{
 if(!d||d.status==='open')return '';
 const title=e(splitQuestion(d.question)[0]);
 const text=d.delivery?.status==='sent'?`답변을 전달했습니다 — ${e(d.delivery.role)}에게 알렸습니다: ${title}`
  :d.delivery?.status==='failed'?`답변은 저장했지만 알림 전달에 실패했습니다(${e(d.delivery.error)}): ${title}`
  :`답변을 저장했습니다. 알림 전달은 확인 중입니다: ${title}`;
 const failed=d.delivery?.status==='failed';
 return `<div role="status" aria-live="polite" class="decision-toast${failed?' decision-toast-failed':''}"><span>${text}</span><button type="button" class="decision-toast-link" data-decision-history-open>내역 보기</button><button type="button" class="decision-toast-close" data-toast-close aria-label="알림 닫기">×</button></div>`;
};
// 질문 본문: 슈퍼감독이 쓰는 "- 이름: 내용" 줄은 이름표 표로, 나머지는 문단으로(2026-09-24 선택판 모양).
// 주소로 시작하는 줄(- https://…)의 "https"를 이름표로 읽지 않는다.
const fieldLine=/^\s*[-•*]\s*([^:：/\n]{1,24}?)\s*[:：]\s*(.+)$/;
export function questionBody(body){
 const out=[];let dl=[],para=[];
 const flush=()=>{if(dl.length){out.push(`<dl class="dc-fields">${dl.join('')}</dl>`);dl=[];}if(para.length){out.push(`<p class="dc-pre">${linked(para.join('\n'))}</p>`);para=[];}};
 for(const line of String(body??'').split('\n')){
  const m=line.match(fieldLine);
  if(m&&!/^https?$/i.test(m[1].trim())&&!m[2].startsWith('//')){if(para.length)flush();dl.push(`<dt>${e(m[1].trim())}</dt><dd>${linked(m[2])}</dd>`);}
  else if(line.trim()){if(dl.length)flush();para.push(line);}
 }
 flush();
 return out.join('');
}
// 지난 결정 한 건: 상태·시각·내 답변·알림 결과를 먼저, 질문 원문·추천·이유는 접어서.
const historyItem=d=>{
 const [title,body]=splitQuestion(d.question);
 const failed=d.status==='answered'&&d.delivery?.status==='failed';
 const badge=d.status==='answered'?(failed?'<span class="dh-badge dh-failed">알림 실패</span>':'<span class="dh-badge dh-answered">답변함</span>')
  :d.status==='cancelled'?'<span class="dh-badge dh-cancelled">취소됨</span>':`<span class="dh-badge">${e(d.status)}</span>`;
 const answer=d.answer?`<p><strong>내 답변</strong> ${d.answer.choice?`선택 ${e(d.answer.choice)}${d.answer.text&&d.answer.text!==d.answer.choice?' · ':''}`:''}${d.answer.text&&d.answer.text!==d.answer.choice?e(d.answer.text):''}</p>`:'';
 const delivery=d.status!=='answered'?'':d.delivery?.status==='sent'?`<p>알림 전달함 → ${e(d.delivery.role)}</p>`
  :failed?`<p>알림 실패: ${e(d.delivery.error)}</p>`:d.delivery?.status==='pending'?'<p>알림 확인 중</p>':'';
 const cancelled=d.status==='cancelled'?`<p>취소 이유: ${e(d.cancelReason||'모름')}${d.cancelledBy?` (${e(d.cancelledBy)})`:''}</p>`:'';
 return `<article class="dh-item" id="decision-${e(d.id)}"><div class="dh-meta">${badge}${d.answer?.at?`<span>${e(time(d.answer.at))}</span>`:''}</div><h3>${e(title)}</h3>${answer}${delivery}${cancelled}`+
  `<p class="dh-meta"><a href="?card=${encodeURIComponent(d.card)}#detail">${e(d.card)}</a><span>요청자 ${e(d.requestedBy)} · ${e(time(d.at))}</span></p>`+
  `<details><summary>원문 보기</summary>${body?`<p style="white-space:pre-line">${linked(body)}</p>`:''}<p><strong>추천: ${e(d.recommendation)}</strong></p><p style="white-space:pre-wrap">${linked(d.reason)}</p></details></article>`;
};
const renderDecisionHistory=past=>{
 const sorted=past.slice().sort((a,b)=>String(b.answer?.at||b.at||'').localeCompare(String(a.answer?.at||a.at||'')));
 return `<dialog id="decision-history" class="decision-drawer" aria-labelledby="decision-history-title"><header class="dh-top"><h2 id="decision-history-title">이전 결정 ${past.length}건</h2><form method="dialog"><button type="submit" value="close">닫기</button></form></header>`+
  (sorted.length?`<div class="dh-list">${sorted.map(historyItem).join('')}</div>`:'<p class="dh-empty">지난 결정이 없습니다.</p>')+'</dialog>';
};
export function renderDecisions(items,error,token,answered=null){
 if(error)return `<section class="panel" id="decisions" data-view="decisions"><h2>내 결정 필요</h2><p role="alert">모름: ${e(error)}</p></section>`;
 const open=items.filter(d=>d.status==='open');
 const one=d=>{const [title,body]=splitQuestion(d.question);
  const options=d.options.map(o=>`<label class="dc-opt"><input type="radio" name="choice" value="${e(o)}"><span class="dc-dot" aria-hidden="true"></span><span class="dc-opt-text">${e(o)}${o===d.recommendation?'<span class="dc-rec">추천</span>':''}</span></label>`).join('');
  return `<article class="dc-card" id="decision-${e(d.id)}"><div class="dc-top"><span class="dc-chip">요청 ${e(d.requestedBy)}</span><a class="dc-key" href="?card=${encodeURIComponent(d.card)}#detail">${e(d.card)}</a>${d.at?`<span class="dc-age">${e(time(d.at))}</span>`:''}</div><h3>${e(title)}</h3>${body?questionBody(body):''}<dl class="dc-fields"><dt>추천 이유</dt><dd class="dc-pre">${linked(d.reason)}</dd></dl>`+
   `<form method="post" action="/decisions/answer" class="dc-form"><input type="hidden" name="token" value="${e(token)}"><input type="hidden" name="id" value="${e(d.id)}"><input type="hidden" name="revision" value="${d.revision}"><fieldset class="dc-opts"><legend class="dw-sr">선택지</legend>${options}<label class="dc-opt dc-opt-free"><input type="radio" name="choice" value="" checked><span class="dc-dot" aria-hidden="true"></span><span class="dc-opt-text">선택지 없이 메모로 답변</span></label></fieldset><textarea name="text" rows="2" placeholder="메모 (선택) · 선택지 없이 보내려면 여기에 답을 적으세요"></textarea><div class="dc-actions"><button>답변 전달</button><small>누를 때만 보냅니다. 요청한 슈퍼감독에게 한 번 알립니다.</small></div></form></article>`;};
 // 오늘(서울) 답한 수와 남은 수로 진행 막대를 그린다.
 const today=new Date(Date.now()+9*3600_000).toISOString().slice(0,10);
 const answeredToday=items.filter(d=>d.status==='answered'&&typeof d.answer?.at==='string'&&new Date(Date.parse(d.answer.at)+9*3600_000).toISOString().slice(0,10)===today).length;
 const meter=`<div class="dc-meter"><span>대기 ${open.length}건 · 오늘 답함 ${answeredToday}건</span><div class="dc-bar" aria-hidden="true"><i style="width:${open.length+answeredToday?Math.round(answeredToday/(open.length+answeredToday)*100):0}%"></i></div></div>`;
 return `<section class="panel" id="decisions" data-view="decisions"><h2>내 결정 필요 ${open.length}건</h2>${answeredNotice(answered&&items.find(d=>d.id===answered))}<p class="muted">슈퍼감독이 [kyle]에게 명시적으로 요청한 결정만 표시합니다.</p>${meter}<div class="dc-list">${open.map(one).join('')||'<p>결정을 기다리는 요청이 없습니다.</p>'}</div><button type="button" class="decision-history-open" data-decision-history-open>이전 결정 ${items.length-open.length}건 보기</button></section>${renderDecisionHistory(items.filter(d=>d.status!=='open'))}`;
}
// 요약이 없는 편지(공식 보고 등)는 이미 읽은 본문 앞부분을 한 줄로 보인다(2026-09-24 UX 검토: 하나씩 펼쳐야 했음).
const mailExcerpt=body=>{const text=String(body??'').replace(/\s+/g,' ').trim();return text.length>120?text.slice(0,120)+'…':text;};
const recordTabs=active=>`<nav class="record-tabs" aria-label="시스템 기록 보기"><a href="#runs" ${active==='runs'?'aria-current="page"':''}>작업별 보기</a><a href="#ledger" ${active==='ledger'?'aria-current="page"':''}>사건순 보기</a></nav>`;
export function renderActivity({center,entries=[],ledgerLines,error,home},url){
 const known=ledgerLines!==null&&!entries.some(e=>e?.broken);
 if(!known)return [['mailbox','우편함'],['runs','작업 실행 기록'],['ledger','시스템 기록']].map(([id,title])=>`<section class="panel" id="${id}" data-view="${id}"><h2>${id==='mailbox'?title:'시스템 기록'}</h2>${id==='mailbox'?'':recordTabs(id)}${activityGuide(id)}<p role="alert">모름 — 원장을 읽을 수 없습니다.</p></section>`).join('');
 const letters=mailboxLetters(entries);
 const unread=letters.filter(m=>m.read===false).length;
 const awaiting=letters.filter(m=>m.replyStatus==='waiting').length;
 const role=url.searchParams.get('mailRole')||'',hideWatch=url.searchParams.get('hideWatch')==='1';
 const view=url.searchParams.get('mailView')||'all',reply=url.searchParams.get('mailReply')||'';
 const domain=ledgerViews.some(([value])=>value===url.searchParams.get('ledgerDomain'))?url.searchParams.get('ledgerDomain'):'all';
 const options=(values,current)=>values.map(([value,label])=>`<option value="${e(value)}"${value===current?' selected':''}>${e(label)}</option>`).join('');
 const all=filterMail(letters,url,{bodyOf:m=>home&&m.digest?readMailBody(m.digest,home):null}).slice().reverse();
 // 역할 입력칸의 선택 목록: 우편에 나온 역할(보낸이·받는이).
 // 작업 ID를 카드 목록에서 찾을 수 있으면 카드 상세 링크로, 아니면 글자 그대로.
 const identity=taskIdentity(center?.cards||[]);
 const cardKeyOf=(taskId,executionKey)=>{if(!taskId&&!executionKey)return null;const found=identity.resolve(taskId||executionKey,executionKey);return found.state==='resolved'?found.key:null;};
 const cardLink=(text,executionKey)=>{const key=cardKeyOf(text,executionKey);return key?`<a href="?card=${encodeURIComponent(key)}#detail">${e(text)}</a>`:e(text);};
 const knownRoles=[...new Set(letters.flatMap(m=>[m.currentSender||m.by,m.currentRecipient||m.role]).filter(Boolean))].sort();
 let ledgerRows=[],ledgerError=null;
 const showRoutine=url.searchParams.get('ledgerRoutine')==='1';
 const ledgerFilter={kind:url.searchParams.get('ledgerKind')==='incident'?'incident':'',card:(url.searchParams.get('ledgerCard')||'').trim(),role:(url.searchParams.get('ledgerRole')||'').trim(),date:/^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('ledgerDate')||'')?url.searchParams.get('ledgerDate'):''};
 let routineHidden=0;
 try{ledgerRows=ledgerView(entries,home,domain);if(ledgerRows.some(row=>row?.broken))throw new Error('원장 손상');if(!showRoutine){const before=ledgerRows.length;ledgerRows=ledgerRows.filter(row=>!isWatchRoutine(row));routineHidden=before-ledgerRows.length;}ledgerRows=filterLedgerRows(ledgerRows,ledgerFilter);}catch(error){ledgerError=error.message;}
 const hidden=excluded=>[...url.searchParams].filter(([key])=>!excluded.includes(key)).map(([key,value])=>`<input type="hidden" name="${e(key)}" value="${e(value)}">`).join('');
 const paginate=(items,param)=>{const n=Math.max(1,Math.min(Math.ceil(items.length/25)||1,Math.floor(Number(url.searchParams.get(param)))||1));const link=k=>{const q=new URLSearchParams(url.searchParams);q.set(param,k);return '?'+q+'#'+(param==='mailPage'?'mailbox':param==='runPage'?'runs':'ledger')};return{items:items.slice((n-1)*25,n*25),nav:`<nav>${n>1?`<a href="${e(link(n-1))}">이전</a>`:''}<span>${n} / ${Math.ceil(items.length/25)||1}</span>${n*25<items.length?`<a href="${e(link(n+1))}">다음</a>`:''}</nav>`}};
 const mails=paginate(all,'mailPage'),logs=paginate(ledgerRows.slice().reverse(),'logPage');
 // 작업별 실행: 최근 시각 순, 상태로 거르기, 카드 제목을 먼저(2026-09-24 UX 검토: 시각이 뒤섞이고 모두 같은 회색이었다).
 const runLabels={failed:'실패 기록',unconfirmed:'완료 미확인',orphaned:'세션 없음·미완료',done:'완료 기록'};
 const allRuns=[...(center?.cards??[]).flatMap(c=>c.runs.map(r=>({...r,card:c.key,title:c.title,board:c.board}))),...(center?.unregistered??[])]
  .sort((a,b)=>(Date.parse(b.at)||0)-(Date.parse(a.at)||0));
 const runState=Object.hasOwn(runLabels,url.searchParams.get('runState')||'')?url.searchParams.get('runState'):'';
 const runCount=state=>allRuns.filter(r=>r.state===state).length;
 const runs=runState?allRuns.filter(r=>r.state===runState):allRuns;
 const executions=paginate(runs,'runPage');
 return `<section class="panel" id="mailbox" data-view="mailbox"><h2>우편함</h2>${activityGuide('mailbox')}<p><a href="?mailView=to-reply#mailbox">답을 기다리는 질문 ${awaiting}건</a> · <span class="muted">전체 역할 미확인 ${unread}건(에이전트가 읽음 확인을 빠뜨리기 쉬워 참고용)</span></p><p class="muted">조회는 읽음 처리하지 않습니다. 읽음 확인과 중간 답장은 질문을 끝내지 않습니다. 지정 수신자의 최종 답장 또는 발신자의 취소로 답변 대기가 끝납니다.</p><p class="muted">저장·전달은 상대의 처리 완료나 터미널 깨움을 뜻하지 않습니다.</p><form class="toolbar" method="get" action="/#mailbox">${hidden(['mailRole','mailView','mailReply','mailUnread','hideWatch','mailPage','mailCard','mailQ'])}<label>기준 역할<input name="mailRole" value="${e(role)}" placeholder="비우면 모든 역할" list="mail-role-options"><datalist id="mail-role-options">${knownRoles.map(r=>`<option value="${e(r)}">`).join('')}</datalist></label><label>카드<input name="mailCard" value="${e(url.searchParams.get('mailCard')||'')}" placeholder="저장소/카드 또는 카드 ID"></label><label>검색<input name="mailQ" value="${e(url.searchParams.get('mailQ')||'')}" placeholder="보낸이·받는이·번호·본문"></label><label>보기<select name="mailView">${options(mailViews,view)}</select></label><label>답변 상태<select name="mailReply">${options(replyStates,reply)}</select></label><label><input type="checkbox" name="mailUnread" value="1"${url.searchParams.get('mailUnread')==='1'?' checked':''}>읽음 미확인만</label><label><input type="checkbox" name="hideWatch" value="1"${hideWatch?' checked':''}>감시 우편 숨기기</label><button>우편 조회</button></form>${!role&&['to-reply','waiting'].includes(view)?'<p class="muted">기준 역할이 없어 모든 역할의 답변 대기 질문을 표시합니다.</p>':''}<div class="scroll"><table><thead><tr><th>시각</th><th>보낸이</th><th>받는이</th><th>내용</th></tr></thead><tbody>${mails.items.map(m=>{let body;try{body=home&&m.digest?readMailBody(m.digest,home):null}catch{body=null}return `<tr><td>${e(time(m.t))}</td><td>${e(m.by||'모름')}</td><td>${e(m.role||'모름')}</td><td>${cardLink(m.completion?m.executionKey||m.completionTaskId||'':m.taskId||'',m.executionKey)}<span class="state">${e(mailStatus(m))}${m.transport==='mailbox'?' · 저장됨':''}</span><small> ${e(({request:'작업 요청',decision:'결정',report:'공식 보고'})[m.mailKind]||m.mailKind||'')}</small><p>${e(m.preview||mailExcerpt(body)||(m.transport==='mailbox'?'공식 우편 · 본문을 펼쳐 확인':'미리보기 없음'))}</p><details><summary>본문</summary><pre>${e(body??'본문 없음 또는 읽기 불가 — 원장 기록은 보존됨')}</pre></details></td></tr>`}).join('')||'<tr><td colspan="4">조건에 맞는 편지가 없습니다.</td></tr>'}</tbody></table></div>${mails.nav}</section>
 <section class="panel" id="runs" data-view="runs"><h2>시스템 기록</h2>${recordTabs('runs')}<h3>작업별 보기</h3>${activityGuide('runs')}<p class="muted">중앙 카드와 같은 계산을 사용합니다. 세션 생존만으로 진행이라고 표시하지 않습니다. 최근 시각 순입니다.</p><form class="toolbar" method="get" action="/#runs">${hidden(['runState','runPage'])}<label>상태<select name="runState">${options([['',`전체 ${allRuns.length}`],...Object.entries(runLabels).map(([k,l])=>[k,`${l} ${runCount(k)}`])],runState)}</select></label><button>실행 조회</button></form><div class="scroll"><table><thead><tr><th>카드</th><th>역할 · 판</th><th>실행 기록</th></tr></thead><tbody>${executions.items.map(r=>`<tr><td>${r.card?`<a href="?card=${encodeURIComponent(r.card)}#detail">${e(r.title||r.card)}</a>${r.title?`<br><small class="run-key">${e(r.card)}</small>`:''}`:e(r.taskId)}</td><td>${e(r.role)}<br>${e(r.board||'판 미지정')}</td><td><span class="run-state run-${e(r.state)}">${e(runLabels[r.state]||r.state)}</span><br>${e(time(r.at))}</td></tr>`).join('')||'<tr><td colspan="3">조건에 맞는 실행이 없습니다.</td></tr>'}</tbody></table></div>${executions.nav}</section>
 <section class="panel lg-panel" id="ledger" data-view="ledger"><div class="lg-top"><h2>시스템 기록</h2>${recordTabs('ledger')}</div><div class="lg-heading"><h3>사건순 보기</h3><a class="lg-incidents" href="?ledgerKind=incident#ledger">최근 사고</a><span>${ledgerError?'모름':ledgerRows.length+'건'} · 최신순${routineHidden?` · 감시 일상 기록 ${routineHidden}건 숨김`:''}</span><details class="lg-help"><summary>기록 안내</summary>${activityGuide('ledger')}</details></div><form class="toolbar" method="get" action="/#ledger">${hidden(['ledgerDomain','logPage','ledgerRoutine','ledgerKind','ledgerCard','ledgerRole','ledgerDate'])}<label>원장 구분<select name="ledgerDomain">${options(ledgerViews,domain)}</select></label><label>종류<select name="ledgerKind">${options([['','전체'],['incident','사고만']],ledgerFilter.kind)}</select></label><label>카드<input name="ledgerCard" value="${e(ledgerFilter.card)}" placeholder="저장소/카드 또는 카드 ID"></label><label>역할<input name="ledgerRole" value="${e(ledgerFilter.role)}" placeholder="기록자·대상" list="mail-role-options"></label><label>날짜<input type="date" name="ledgerDate" value="${e(ledgerFilter.date)}"></label><label><input type="checkbox" name="ledgerRoutine" value="1"${showRoutine?' checked':''}> 감시 일상 기록 보기</label><button>기록 조회</button></form><p class="lg-caption">같은 저장소의 작업·우편·시스템 사건을 구분합니다. 과거 이력은 수정 없이 읽기용으로 분류하며 전체는 기존 호출자용 호환 조회입니다. 작업 발령은 우편 send와 작업 dispatch로 연결되어 원장별 건수를 더한 값과 전체 건수가 다를 수 있습니다.</p>${ledgerError?`<p role="alert">모름 — 원장을 읽을 수 없습니다: ${e(ledgerError)}</p>`:renderLedgerTable(logs.items,{cardHref:entry=>{const key=cardKeyOf(entry.completion?entry.executionKey||entry.completionTaskId:entry.taskId,entry.executionKey);return key?`?card=${encodeURIComponent(key)}#detail`:null;}})}<div class="lg-pagination">${logs.nav}</div></section>`;
}
