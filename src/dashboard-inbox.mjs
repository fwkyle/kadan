import {escapeHtml as e} from './card-content.mjs';
import {readMailBody} from './ledger.mjs';
import {workLetters} from './work-mail.mjs';
export const mailViews=[['all','전체'],['received','받은 편지'],['sent','보낸 편지'],['to-reply','내가 답할 질문'],['waiting','답변 대기']];
export const replyStates=[['','모든 답변 상태'],['waiting','답변 대기'],['answered','답변 완료'],['cancelled','질문 취소']];
export function mailStatus(m){
 const read=m.read===true?'받는 사람 읽음 확인':m.read===false?'읽음 미확인':'전달 기록 · 읽음 모름';
 const reply=replyStates.find(([value])=>value&&value===m.replyStatus)?.[1];
 const sender=m.currentSender||m.by,recipient=m.currentRecipient||m.role;
 const responsibility=sender!==m.by||recipient!==m.role?`현재 책임: ${sender||'모름'} → ${recipient||'모름'}`:'';
 return [m.completion?'실행 결과 통지':'',m.notificationOnly===true||m.systemGenerated==='task-completion'?'기록용 · 추가 알림 없음':'',m.replyFinalRejected?'전달됨 · 답변종결 반영 안됨':'',read,reply,m.replyFinal?'최종 답장':m.replyTo?'답장':'',responsibility].filter(Boolean).join(' · ');
}
// 카드로 거르기: 카드 키(저장소/ID)나 ID가 편지의 작업·실행·완료·업무 번호와 맞으면 남긴다.
export function mailMatchesCard(m,card){
 if(!card)return true;
 const id=card.split('/').at(-1),fields=[m.taskId,m.executionKey,m.completionTaskId,m.workKey].filter(x=>typeof x==='string');
 return fields.some(x=>x===card||x===id||x.split('/').at(-1)===id&&(!card.includes('/')||x===card||!x.includes('/')));
}
// 글자로 거르기: 보낸이·받는이·번호·미리보기, 본문을 읽을 수 있으면 본문까지(대소문자 무시).
export function mailMatchesText(m,q,bodyOf){
 if(!q)return true;
 const needle=q.toLowerCase();
 const hay=[m.by,m.role,m.currentSender,m.currentRecipient,m.taskId,m.executionKey,m.completionTaskId,m.workKey,m.mailId,m.preview].filter(Boolean).join(' ').toLowerCase();
 if(hay.includes(needle))return true;
 let body=null;try{body=bodyOf?.(m)??null;}catch{body=null;}
 return typeof body==='string'&&body.toLowerCase().includes(needle);
}
export function filterMail(letters,url,{bodyOf}={}){
 const role=url.searchParams.get('mailRole')||'',view=url.searchParams.get('mailView')||'all',reply=url.searchParams.get('mailReply')||'';
 const card=(url.searchParams.get('mailCard')||'').trim(),q=(url.searchParams.get('mailQ')||'').trim();
 return letters.filter(m=>{
  if(!mailMatchesCard(m,card)||!mailMatchesText(m,q,bodyOf))return false;
  const recipient=m.currentRecipient||m.role,sender=m.currentSender||m.by;
  if(role&&(view==='received'||view==='to-reply'?recipient!==role:view==='sent'||view==='waiting'?sender!==role:recipient!==role&&sender!==role))return false;
  if(['to-reply','waiting'].includes(view)&&m.replyStatus!=='waiting')return false;
  return (!reply||m.replyStatus===reply)&&(url.searchParams.get('mailUnread')!=='1'||m.read===false)&&(url.searchParams.get('hideWatch')!=='1'||m.by!=='watch');
 });
}
const short=at=>Number.isFinite(Date.parse(at))?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(at)):'시각 모름';

export function renderInbox(w,home,url=new URL('http://localhost')){
 const letters=filterMail(w.letters,url);
 const pages=Math.max(1,Math.ceil(letters.length/100)),page=Math.min(pages,Math.max(1,Number.parseInt(url.searchParams.get('mailPage'),10)||1));
 const options=(values,current)=>values.map(([value,label])=>`<option value="${e(value)}"${value===current?' selected':''}>${e(label)}</option>`).join('');
 const hidden=[...url.searchParams].filter(([key])=>!['mailRole','mailView','mailReply','mailPage','card','detail','tab'].includes(key)).map(([key,value])=>`<input type="hidden" name="${e(key)}" value="${e(value)}">`).join('');
 const filters=`<form class="toolbar" method="get" action="${e(url.pathname)}#detail">${hidden}<input type="hidden" name="card" value="${e(w.key)}"><input type="hidden" name="detail" value="1"><input type="hidden" name="tab" value="summary"><label>기준 역할<input name="mailRole" value="${e(url.searchParams.get('mailRole')||'')}" placeholder="모든 역할"></label><label>보기<select name="mailView">${options(mailViews,url.searchParams.get('mailView')||'all')}</select></label><label>답변 상태<select name="mailReply">${options(replyStates,url.searchParams.get('mailReply')||'')}</select></label><button>우편 조회</button></form>`;
 const items=letters.slice((page-1)*100,page*100);
 const nav=n=>{const u=new URL(url);u.searchParams.set('mailPage',String(n));u.searchParams.set('card',w.key);u.searchParams.set('detail','1');u.searchParams.set('tab','summary');u.hash='detail';return `${u.pathname}${u.search}${u.hash}`;};
 return `<div class="dd-history-heading"><h3>인박스 <span>${letters.length}통</span></h3><span class="muted">${pages>1?`${page}/${pages}쪽 · 100통씩 · `:''}최신순 · 행을 펼쳐 원문 확인</span></div>${filters}${!items.length?'<p>조건에 맞는 연결된 편지가 없습니다. 업무·실행 주소나 답장으로 연결된 편지만 보여줍니다.</p>':`<div class="dd-history-scroll" tabindex="0" aria-label="이 카드의 인박스"><table class="dd-history-table bw-mail"><colgroup><col style="width:100px"><col style="width:170px"><col></colgroup><thead><tr><th>시각</th><th>보낸 사람 → 받는 사람</th><th>내용</th></tr></thead><tbody>${items.map((m,i)=>{
  const id=`bw-mail-${i}`,body=(m.digest&&home?readMailBody(m.digest,home):null),text=body??m.preview??'본문을 읽을 수 없습니다.';
  const status=mailStatus(m);
  return `<tr data-dd-row="${id}"><td class="dd-time">${e(short(m.t))}</td><td class="di-people" title="${e(m.by||'모름')} → ${e(m.role||'모름')}"><span>${e(m.by||'모름')}</span><span>→ ${e(m.role||'모름')}</span></td><td><button class="dd-open" type="button" aria-expanded="false" aria-controls="${id}"><span class="muted">${e(status)}</span> <span class="dd-preview">${e(text.replace(/\s+/g,' ').slice(0,150))}</span><span aria-hidden="true">›</span></button></td></tr><tr class="dd-expanded" id="${id}" hidden><td colspan="3"><div class="dd-history-original dd-original"><div class="dd-original-head"><span>${e(status)}</span><button type="button" data-dd-close="${id}">접기</button></div><p class="dd-history-note">${e(text)}</p><details><summary>우편 정보 · 읽음 처리는 하지 않음</summary><p class="muted">${m.completion?`완료 대상: ${e(m.executionKey||m.completionTaskId||'모름')} · `:''}우편 ID: ${e(m.mailId||m.digest||'모름')}${m.replyTo?` · 원본: ${e(m.replyTo)}`:''}</p></details></div></td></tr>`;
 }).join('')}</tbody></table></div>`}${pages>1?`<p class="bw-mail-pages">${page>1?`<a data-work-page href="${e(nav(page-1))}">이전 100통</a>`:''} ${page<pages?`<a data-work-page href="${e(nav(page+1))}">다음 100통</a>`:''}</p>`:''}`;
}

export function renderCardInbox(card,{entries=[],cards=[card],home,url}={}) {
 try {
  // 실행 주소와 고유한 카드 ID만 따른다. 상위 업무의 다른 실행 편지는 섞지 않는다.
  const letters=workLetters({key:'execution:'+card.key,executions:[{key:card.key}],mailRefs:[]},entries,cards);
  return renderInbox({key:card.key,letters},home,url);
 } catch { return '<h3>인박스</h3><p role="alert">인박스 확인 불가 · 원장을 읽을 수 없습니다.</p>'; }
}
