import {isUserActor} from './actors.mjs';
import {createMailRouting} from './mail-routing.mjs';
import {createTaskCompletionChecker} from './ledger-domains.mjs';
const views=new Set(['received','sent','to-reply','waiting']);
const canAct=(by,role)=>by===role||isUserActor(by);
const sameContext=(a,b)=>a.workKey===b.workKey&&a.executionKey===b.executionKey;
// 한 화면을 그리는 동안 같은 원장으로 여러 번 부른다(업무마다 workLetters 등). 우편 2만 건 규모에서 한 번에
// 0.5초라 대시보드 한 장이 12초 걸렸다(2026-09-24 실측). 같은 원장 배열·길이면 투영을 재사용하고,
// 부를 때마다 새 배열·새 객체를 돌려준다 — 부르는 쪽의 reverse·수정이 다른 호출에 번지지 않게.
const projections=new WeakMap();
// 기록용 알림(감시기 알림·자동 결과 통지)은 추가 알림 없이 원장에만 남긴다. 과거 자동 결과 통지는 필드가 없어 종류로 본다.
export const isNotificationOnly=e=>e.notificationOnly===true||e.systemGenerated==='task-completion';
// 사람이 처리할 미확인 우편: 읽음 미확인이면서 기록용 알림이 아닌 편지. inbox --unread와 화면 미확인 건수가 같이 쓴다.
export const isUnreadLetter=e=>e.read===false&&!isNotificationOnly(e);
export function mailboxLetters(entries,role,{view='received',all=true,unread=false}={}){
 if(entries.some(e=>e?.broken))throw new Error('원장 손상: 우편 상태 확인 불가');
 if(!views.has(view))throw new Error('우편 보기는 received/sent/to-reply/waiting만 지원합니다');
 let cached=projections.get(entries);
 if(!cached||cached.length!==entries.length){cached={length:entries.length,letters:projectLetters(entries)};projections.set(entries,cached);}
 return cached.letters.filter(e=>role===undefined||(['sent','waiting'].includes(view)?e.currentSender===role:e.currentRecipient===role))
 .filter(e=>(!unread||isUnreadLetter(e))&&(['waiting','to-reply'].includes(view)?e.replyStatus==='waiting':all||e.read!==true))
 .map(e=>({...e,replyRecipients:[...e.replyRecipients]}));
}
// 저장 순서로 한 번씩 순회한다. 읽음, 답변 종료, 실행 완료를 서로 합치지 않는다.
function projectLetters(entries){
 const sends=entries.filter(e=>e.kind==='send'),refs=new Map(),byId=new Map(),read=new Set(),claims=new Map();
 const routing=createMailRouting();
 const completionReply=createTaskCompletionChecker(entries);
 for(const e of sends){
  if(e.mailId){if(byId.has(e.mailId))throw new Error('우편 원장 중복 mailId');byId.set(e.mailId,e);}
 }
 for(const e of entries){
  routing.apply(e);
  if(e.kind==='send'){
   routing.add(e,refs.get(e.replyTo));
   for(const ref of new Set([e.mailId,e.digest].filter(Boolean)))refs.set(ref,refs.has(ref)?null:e);
  }
  if(e.kind==='mail-read'){
   const parent=byId.get(e.mailId);
   const owner=routing.get(parent);
   if(owner&&e.role===owner.currentRecipient&&canAct(e.by,owner.currentRecipient))read.add(parent);
  }else if(e.kind==='mail-cancel'){
   const parent=byId.get(e.mailId);
   const owner=routing.get(parent);
   if(owner&&parent.expectReply===true&&e.role===owner.currentRecipient&&canAct(e.by,owner.currentSender)&&!claims.has(parent))claims.set(parent,{replyStatus:'cancelled',cancelled:true});
  }else if(e.kind==='send'&&e.replyFinal===true){
   const parent=refs.get(e.replyTo);
   const owner=routing.get(parent);
   const validReply=e.systemGenerated==='task-completion'?completionReply(e,parent):parent&&sameContext(e,parent);
   if(owner&&parent!==e&&parent.expectReply===true&&routing.get(e).currentRecipient===owner.currentSender&&canAct(e.by,owner.currentRecipient)&&validReply&&!claims.has(parent))claims.set(parent,{replyStatus:'answered',cancelled:false,finalReplyId:e.mailId});
  }
 }
 return sends.map(e=>({
  ...e,currentRecipient:routing.get(e).currentRecipient,currentSender:routing.get(e).currentSender,
  replyRecipients:[...routing.get(e).senderRoles],
  // 수신자 직접 ack가 있으면 그것을, 없으면 raw 창 전달 성공의 전달 읽음을 읽음 근거로 표시한다.
  read:read.has(e)||e.mailId&&e.deliveredRead===true?true:e.mailId?false:null,
  readKind:read.has(e)?'recipient-ack':e.mailId&&e.deliveredRead===true?'delivered-read':null,expectReply:e.expectReply===true,replyFinal:e.replyFinal===true,
  replyStatus:e.expectReply===true?'waiting':'not-requested',cancelled:false,...claims.get(e),
 }));
}
