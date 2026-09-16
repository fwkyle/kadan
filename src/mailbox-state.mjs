import {isUserActor} from './actors.mjs';
const views=new Set(['received','sent','to-reply','waiting']);
const canAct=(by,role)=>by===role||isUserActor(by);
const sameContext=(a,b)=>a.workKey===b.workKey&&a.executionKey===b.executionKey;
// 저장 순서로 한 번씩 순회한다. 읽음, 답변 종료, 실행 완료를 서로 합치지 않는다.
export function mailboxLetters(entries,role,{view='received',all=true,unread=false}={}){
 if(entries.some(e=>e?.broken))throw new Error('원장 손상: 우편 상태 확인 불가');
 if(!views.has(view))throw new Error('우편 보기는 received/sent/to-reply/waiting만 지원합니다');
 const sends=entries.filter(e=>e.kind==='send'),refs=new Map(),byId=new Map(),read=new Set(),claims=new Map();
 for(const e of sends){
  if(e.mailId){if(byId.has(e.mailId))throw new Error('우편 원장 중복 mailId');byId.set(e.mailId,e);}
  for(const ref of new Set([e.mailId,e.digest].filter(Boolean)))refs.set(ref,refs.has(ref)?null:e);
 }
 for(const e of entries){
  if(e.kind==='mail-read'){
   const parent=byId.get(e.mailId);
   if(parent&&e.role===parent.role&&canAct(e.by,parent.role))read.add(parent);
  }else if(e.kind==='mail-cancel'){
   const parent=byId.get(e.mailId);
   if(parent?.expectReply===true&&e.role===parent.role&&canAct(e.by,parent.by)&&!claims.has(parent))claims.set(parent,{replyStatus:'cancelled',cancelled:true});
  }else if(e.kind==='send'&&e.replyFinal===true){
   const parent=refs.get(e.replyTo);
   if(parent?.expectReply===true&&e.role===parent.by&&canAct(e.by,parent.role)&&sameContext(e,parent)&&!claims.has(parent))claims.set(parent,{replyStatus:'answered',cancelled:false,finalReplyId:e.mailId});
  }
 }
 return sends.filter(e=>role===undefined||(['sent','waiting'].includes(view)?e.by===role:e.role===role)).map(e=>({
  ...e,read:read.has(e)?true:e.mailId?false:null,expectReply:e.expectReply===true,replyFinal:e.replyFinal===true,
  replyStatus:e.expectReply===true?'waiting':'not-requested',cancelled:false,...claims.get(e),
 })).filter(e=>(!unread||e.read===false)&&(['waiting','to-reply'].includes(view)?e.replyStatus==='waiting':all||e.read!==true));
}
