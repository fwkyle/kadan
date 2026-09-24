import {renderLedgerTable,ledgerView,ledgerViews} from './ledger-table.mjs';
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
const splitQuestion=value=>{const text=String(value??'').trim(),line=text.split('\n')[0],at=line.indexOf('?'),cut=at>=0?at+1:line.length;return [text.slice(0,cut).trim(),text.slice(cut).trim()];};
const time=x=>x?new Date(x).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false}):'모름';
// 방금 답한 결정의 저장된 전달 결과를 토스트로 알린다(2026-09-24 [kyle]). 성공은 5초 뒤 사라지고,
// 알림 전달 실패는 닫을 때까지 남긴다.
export const decisionStyle=`.decision-toast{position:fixed;right:24px;bottom:56px;z-index:50;display:flex;gap:12px;align-items:flex-start;max-width:min(520px,calc(100vw - 32px));padding:12px 14px;border-radius:10px;background:#1f2a24;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:14px;line-height:1.5;animation:decision-toast-out .3s ease 5s forwards}
.decision-toast-failed{background:#8a1f1f;animation:none}
.decision-toast-close{flex:none;border:0;background:transparent;color:inherit;font-size:18px;line-height:1;cursor:pointer;padding:0 2px}
@keyframes decision-toast-out{to{opacity:0;visibility:hidden}}
@media (max-width:640px){.decision-toast{right:16px;left:16px;max-width:none}}
@media (prefers-reduced-motion:reduce){.decision-toast{animation-duration:0s}}`;
const answeredNotice=d=>{
 if(!d||d.status==='open')return '';
 const title=e(splitQuestion(d.question)[0]);
 const text=d.delivery?.status==='sent'?`답변을 전달했습니다 — ${e(d.delivery.role)}에게 알렸습니다: ${title}`
  :d.delivery?.status==='failed'?`답변은 저장했지만 알림 전달에 실패했습니다(${e(d.delivery.error)}): ${title}`
  :`답변을 저장했습니다. 알림 전달은 확인 중입니다: ${title}`;
 const failed=d.delivery?.status==='failed';
 return `<div role="status" aria-live="polite" class="decision-toast${failed?' decision-toast-failed':''}"><span>${text}</span><button type="button" class="decision-toast-close" data-toast-close aria-label="알림 닫기">×</button></div>`;
};
export function renderDecisions(items,error,token,answered=null){
 if(error)return `<section class="panel" id="decisions" data-view="decisions"><h2>내 결정 필요</h2><p role="alert">모름: ${e(error)}</p></section>`;
 const open=items.filter(d=>d.status==='open');
 const one=d=>{const [title,body]=splitQuestion(d.question);return `<article id="decision-${e(d.id)}"><h3>${e(title)}</h3>${body?`<p style="white-space:pre-line">${linked(body)}</p>`:''}<p><a href="?card=${encodeURIComponent(d.card)}#detail">${e(d.card)}</a> · 요청자 ${e(d.requestedBy)}</p><p><strong>추천: ${e(d.recommendation)}</strong></p><p style="white-space:pre-wrap">${linked(d.reason)}</p>${d.status==='open'?`<form method="post" action="/decisions/answer"><input type="hidden" name="token" value="${e(token)}"><input type="hidden" name="id" value="${e(d.id)}"><input type="hidden" name="revision" value="${d.revision}"><label>선택 (선택 사항)<select name="choice"><option value="">직접 답변</option>${d.options.map(o=>`<option value="${e(o)}">${e(o)}</option>`).join('')}</select></label><label>결정 내용<textarea name="text" rows="3"></textarea></label><button>답변 전달</button><p class="muted">선택지만 골라도 답할 수 있습니다. 답변을 저장하고 요청한 슈퍼감독에게 한 번 알립니다.</p></form>`:d.status==='answered'?`<p><strong>답변:</strong> ${e(d.answer.text)}</p><p>통지: ${e(d.delivery?.status==='sent'?'전달됨':d.delivery?.status==='failed'?'실패 — 답변은 저장됨':'확인 필요 — 답변은 저장됨')}</p>`:`<p>취소: ${e(d.cancelReason)}</p>`}</article>`;};
 return `<section class="panel" id="decisions" data-view="decisions"><h2>내 결정 필요 ${open.length}건</h2>${answeredNotice(answered&&items.find(d=>d.id===answered))}<p class="muted">슈퍼감독이 [kyle]에게 명시적으로 요청한 결정만 표시합니다.</p>${open.map(one).join('<hr>')||'<p>결정을 기다리는 요청이 없습니다.</p>'}<details><summary>이전 결정 ${items.length-open.length}건</summary>${items.filter(d=>d.status!=='open').slice().reverse().map(one).join('<hr>')}</details></section>`;
}
const recordTabs=active=>`<nav class="record-tabs" aria-label="시스템 기록 보기"><a href="#runs" ${active==='runs'?'aria-current="page"':''}>작업별 보기</a><a href="#ledger" ${active==='ledger'?'aria-current="page"':''}>사건순 보기</a></nav>`;
export function renderActivity({center,entries=[],ledgerLines,error,home},url){
 const known=ledgerLines!==null&&!entries.some(e=>e?.broken);
 if(!known)return [['mailbox','우편함'],['runs','작업 실행 기록'],['ledger','시스템 기록']].map(([id,title])=>`<section class="panel" id="${id}" data-view="${id}"><h2>${id==='mailbox'?title:'시스템 기록'}</h2>${id==='mailbox'?'':recordTabs(id)}${activityGuide(id)}<p role="alert">모름 — 원장을 읽을 수 없습니다.</p></section>`).join('');
 const letters=mailboxLetters(entries);
 const unread=letters.filter(m=>m.read===false).length;
 const role=url.searchParams.get('mailRole')||'',hideWatch=url.searchParams.get('hideWatch')==='1';
 const view=url.searchParams.get('mailView')||'all',reply=url.searchParams.get('mailReply')||'';
 const domain=ledgerViews.some(([value])=>value===url.searchParams.get('ledgerDomain'))?url.searchParams.get('ledgerDomain'):'all';
 const options=(values,current)=>values.map(([value,label])=>`<option value="${e(value)}"${value===current?' selected':''}>${e(label)}</option>`).join('');
 const all=filterMail(letters,url).slice().reverse();
 let ledgerRows=[],ledgerError=null;
 try{ledgerRows=ledgerView(entries,home,domain);if(ledgerRows.some(row=>row?.broken))throw new Error('원장 손상');}catch(error){ledgerError=error.message;}
 const hidden=excluded=>[...url.searchParams].filter(([key])=>!excluded.includes(key)).map(([key,value])=>`<input type="hidden" name="${e(key)}" value="${e(value)}">`).join('');
 const paginate=(items,param)=>{const n=Math.max(1,Math.min(Math.ceil(items.length/25)||1,Math.floor(Number(url.searchParams.get(param)))||1));const link=k=>{const q=new URLSearchParams(url.searchParams);q.set(param,k);return '?'+q+'#'+(param==='mailPage'?'mailbox':param==='runPage'?'runs':'ledger')};return{items:items.slice((n-1)*25,n*25),nav:`<nav>${n>1?`<a href="${e(link(n-1))}">이전</a>`:''}<span>${n} / ${Math.ceil(items.length/25)||1}</span>${n*25<items.length?`<a href="${e(link(n+1))}">다음</a>`:''}</nav>`}};
 const mails=paginate(all,'mailPage'),logs=paginate(ledgerRows.slice().reverse(),'logPage');
 const runs=[...(center?.cards??[]).flatMap(c=>c.runs.map(r=>({...r,card:c.key,board:c.board}))),...(center?.unregistered??[])];
 const executions=paginate(runs,'runPage');
 return `<section class="panel" id="mailbox" data-view="mailbox"><h2>우편함</h2>${activityGuide('mailbox')}<p>전체 역할 미확인 우편 · 미확인 ${unread}건</p><p class="muted">조회는 읽음 처리하지 않습니다. 읽음 확인과 중간 답장은 질문을 끝내지 않습니다. 지정 수신자의 최종 답장 또는 발신자의 취소로 답변 대기가 끝납니다.</p><p class="muted">저장·전달은 상대의 처리 완료나 터미널 깨움을 뜻하지 않습니다.</p><form class="toolbar" method="get" action="/#mailbox">${hidden(['mailRole','mailView','mailReply','mailUnread','hideWatch','mailPage'])}<label>기준 역할<input name="mailRole" value="${e(role)}" placeholder="비우면 모든 역할"></label><label>보기<select name="mailView">${options(mailViews,view)}</select></label><label>답변 상태<select name="mailReply">${options(replyStates,reply)}</select></label><label><input type="checkbox" name="mailUnread" value="1"${url.searchParams.get('mailUnread')==='1'?' checked':''}>읽음 미확인만</label><label><input type="checkbox" name="hideWatch" value="1"${hideWatch?' checked':''}>감시 우편 숨기기</label><button>우편 조회</button></form>${!role&&['to-reply','waiting'].includes(view)?'<p class="muted">기준 역할이 없어 모든 역할의 답변 대기 질문을 표시합니다.</p>':''}<div class="scroll"><table><thead><tr><th>시각</th><th>보낸이</th><th>받는이</th><th>내용</th></tr></thead><tbody>${mails.items.map(m=>{let body;try{body=home&&m.digest?readMailBody(m.digest,home):null}catch{body=null}return `<tr><td>${e(time(m.t))}</td><td>${e(m.by||'모름')}</td><td>${e(m.role||'모름')}</td><td>${e(m.completion?m.executionKey||m.completionTaskId||'':m.taskId||'')}<span class="state">${e(mailStatus(m))}${m.transport==='mailbox'?' · 저장됨':''}</span><small> ${e(({request:'작업 요청',decision:'결정',report:'공식 보고'})[m.mailKind]||m.mailKind||'')}</small><p>${e(m.preview||(m.transport==='mailbox'?'공식 우편 · 본문을 펼쳐 확인':'미리보기 없음'))}</p><details><summary>본문</summary><pre>${e(body??'본문 없음 또는 읽기 불가 — 원장 기록은 보존됨')}</pre></details></td></tr>`}).join('')||'<tr><td colspan="4">조건에 맞는 편지가 없습니다.</td></tr>'}</tbody></table></div>${mails.nav}</section>
 <section class="panel" id="runs" data-view="runs"><h2>시스템 기록</h2>${recordTabs('runs')}<h3>작업별 보기</h3>${activityGuide('runs')}<p class="muted">중앙 카드와 같은 계산을 사용합니다. 세션 생존만으로 진행이라고 표시하지 않습니다.</p><div class="scroll"><table><thead><tr><th>카드</th><th>역할 · 판</th><th>실행 기록</th></tr></thead><tbody>${executions.items.map(r=>`<tr><td>${r.card?`<a href="?card=${encodeURIComponent(r.card)}#detail">${e(r.card)}</a>`:e(r.taskId)}</td><td>${e(r.role)}<br>${e(r.board||'판 미지정')}</td><td>${e(({done:'완료 기록',failed:'실패 기록',unconfirmed:'완료 미확인',orphaned:'세션 없음·미완료'})[r.state]||r.state)}<br>${e(time(r.at))}</td></tr>`).join('')}</tbody></table></div>${executions.nav}</section>
 <section class="panel lg-panel" id="ledger" data-view="ledger"><div class="lg-top"><h2>시스템 기록</h2>${recordTabs('ledger')}</div><div class="lg-heading"><h3>사건순 보기</h3><span>${ledgerError?'모름':ledgerRows.length+'건'} · 최신순</span><details class="lg-help"><summary>기록 안내</summary>${activityGuide('ledger')}</details></div><form class="toolbar" method="get" action="/#ledger">${hidden(['ledgerDomain','logPage'])}<label>원장 구분<select name="ledgerDomain">${options(ledgerViews,domain)}</select></label><button>기록 조회</button></form><p class="lg-caption">같은 저장소의 작업·우편·시스템 사건을 구분합니다. 과거 이력은 수정 없이 읽기용으로 분류하며 전체는 기존 호출자용 호환 조회입니다. 작업 발령은 우편 send와 작업 dispatch로 연결되어 원장별 건수를 더한 값과 전체 건수가 다를 수 있습니다.</p>${ledgerError?`<p role="alert">모름 — 원장을 읽을 수 없습니다: ${e(ledgerError)}</p>`:renderLedgerTable(logs.items)}<div class="lg-pagination">${logs.nav}</div></section>`;
}
