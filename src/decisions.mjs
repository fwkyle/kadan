import {assertWritable,transaction,readStream,appendStream} from './storage.mjs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {CardStore} from './card-store.mjs';
import {WorkStore} from './work-store.mjs';
import {readLedger,appendLedger} from './ledger.mjs';
import {autopilotWingmanSnapshot} from './autopilot.mjs';
import {readActiveHierarchy} from './hierarchy-register.mjs';
import {buildAutopilotNote} from './autopilot-note.mjs';
import {proceedEligibility,mayProceed,gatedDecisionText,holdBlocks,holdReason,PROHIBITED_SUMMARY,WORD_HINT} from './decision-proceed.mjs';
import {effectiveCardRole} from './handover-state.mjs';
import {isUserActor,isSupervisorActor} from './actors.mjs';
import {notifyUser,fitDiscord} from './user-notify.mjs';
import {DEFAULT_PORT} from './quickstart.mjs';
import {readDecisions} from './notify-threads.mjs';
import {loadRemoteConfig} from './remote-access.mjs';
const supervisor=isSupervisorActor;
const human=by=>isUserActor(by);
const UUID=/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi;
// 보이는 본문의 UUID를 앞 8자로 줄인다. 단 경로·주소 조각(/·~·./·../로 시작, ://, 슬래시 2개 이상)은 확인 경로가 깨지므로 그대로 둔다.
const keepWhole=tok=>/^[(\[<"'`]*(?:[/~]|\.{1,2}\/|[a-z][a-z0-9+.-]*:\/\/)/i.test(tok)||(tok.match(/\//g)??[]).length>=2;
const shortIds=text=>String(text).split(/(\s+)/).map(tok=>keepWhole(tok)?tok:tok.replace(UUID,m=>m.slice(0,8))).join('');
// 채팅 질문(--chat): kyle에게 이미 채팅으로 물은 질문을 가볍게 등록한다. 선택지·확인 경로를 자동으로 채운다.
export const CHAT_OPTIONS=Object.freeze(['추천대로 진행','보류']);
const CHAT_VERIFY_LINE='- 확인 경로 없음: 채팅 질문';
export const AUTO_BY='자동';
const required=(v,name)=>{if(typeof v!=='string'||!v.trim())throw new Error(`${name} 필요`);return v.trim()};
// 새 결정 요청은 사용자가 답하기 전에 열어 볼 주소·절대경로, 또는 '확인 경로 없음: 이유' 줄이 있어야 한다.
export function assertVerifyPath(...texts){
 const text=texts.filter(t=>typeof t==='string').join('\n');
 if(/https?:\/\/\S/.test(text)||/(^|[\s(\[<"'`])\/[^\s\/]+\/\S/.test(text)||/^[ \t]*[-*]?[ \t]*확인 경로 없음:[ \t]*\S/m.test(text))return;
 const blank=/확인 경로 없음:/.test(text)?'"확인 경로 없음:" 뒤에 이유가 비어 있습니다. ':'';
 throw new Error(`확인 경로 필요: ${blank}질문이나 이유에 답하기 전에 열어 볼 주소나 절대경로를 한 줄에 하나씩 넣으세요. 예: "- PR: https://github.com/<조직>/<레포>/pull/<번호>", "- Preview: <배포 기록에서 확인한 실제 접속 주소>", "- 노션: https://www.notion.so/<페이지>", "- 결과 파일: /home/<이름>/.kadan/cards/<저장소>/<카드>/result.md". 열어 볼 대상이 없는 순수 방침 질문이면 "- 확인 경로 없음: <이유>" 줄을 넣으세요.`);
}
// 결정 요청 글이 있는 디코 스레드에 조용한 글 하나를 단다. 실패해도 던지지 않는다(취소 기록이 본체). 시험(KADAN_NOTIFY=off)에서는 보내지 않는다.
function postThreadNote(home,d,text){
 if(process.env.KADAN_NOTIFY==='off')return false;
 try{
  const threadId=readDecisions(home)[d.id]?.threadId;if(!threadId)return false;
  const r=spawnSync(process.execPath,[new URL('./cli.mjs',import.meta.url).pathname,'discord','send','--thread',threadId,'--quiet',text],{env:{...process.env,KADAN_HOME:home},encoding:'utf8',timeout:15000});
  return r.status===0;
 }catch{return false;}
}
// 알림에 붙는 결정 링크. 원격 설정(remote-access.json)에 호스트가 있으면 공개 주소, 없으면 로컬 주소다. 서버 상태가 아니라 설정 파일을 읽는다.
export function decisionLink(home,id){
 const host=loadRemoteConfig(home)?.host;
 return host?`https://${host}/#decision-${id}`:`http://127.0.0.1:${DEFAULT_PORT}/#decision-${id}`;
}
// 화면에 돌려주는 결정에서 원격 감사 필드(answer.remote: 이메일·sub·IP)를 뺀다. 저장 기록에는 그대로 있다.
export function withoutAuditFields(d){
 if(!d?.answer||!('remote' in d.answer))return d;
 const {remote,...answer}=d.answer;return {...d,answer};
}
export class DecisionStore {
 constructor(home,{notify,userNotify,threadNote}={}){this.home=home;this.threadNote=threadNote??((d,text)=>postThreadNote(home,d,text));this.userNotify=userNotify??((message,opts)=>notifyUser(message,spawnSync,{home,...opts}));this.dir=path.join(home,'decisions');this.notify=notify??((role,message)=>{
  const r=spawnSync(process.execPath,[new URL('./cli.mjs',import.meta.url).pathname,'send',role,message],{env:{...process.env,KADAN_HOME:home,KADAN_ROLE:'사람'},encoding:'utf8',timeout:15000});
  if(r.status!==0)throw new Error('통지 실패/불확실: 요청자 화면과 우편 원장을 확인하세요');
 });}
 list(){
  const latest=new Map();for(const e of readStream(this.home,'decisions/events.jsonl',{optional:true})){
   const old=latest.get(e.id);if(!Array.isArray(e.options)||e.options.length<2||!e.options.every(x=>typeof x==='string')||typeof e.question!=='string'||typeof e.reason!=='string'||(e.chat!==undefined&&e.chat!==true)||(e.chat===true?(e.card!==null||typeof e.work!=='string'):typeof e.card!=='string')||(e.work!==undefined&&typeof e.work!=='string')||(e.reversible!==undefined&&(typeof e.reversible!=='string'||!e.reversible.trim()))||(e.notProhibited!==undefined&&(!e.notProhibited||typeof e.notProhibited.by!=='string'||typeof e.notProhibited.at!=='string'))||(e.proceeded!==undefined&&(!e.proceeded||typeof e.proceeded.by!=='string'||typeof e.proceeded.at!=='string'||typeof e.proceeded.recommendation!=='string'||typeof e.proceeded.reversible!=='string'))||!supervisor(e.requestedBy)||(e.status==='answered'&&typeof e.answer?.text!=='string')||(e.answer?.source!==undefined&&e.answer.source!=='discord')||(e.answer?.messageId!==undefined&&typeof e.answer.messageId!=='string')||!e.id||e.to!=='@user'||e.revision!==(old?.revision??0)+1||!['open','answered','cancelled'].includes(e.status))throw new Error('결정 이력 손상');latest.set(e.id,e);
  }return [...latest.values()];}
 get(id){const d=this.list().find(d=>d.id===id);if(!d)throw new Error('결정 요청 없음');return d;}
 write(d){appendStream(this.home,'decisions/events.jsonl',d);return d;}
 locked(fn){assertWritable(this.home);return transaction(this.home,fn);}
 // work: 결정이 막고 있는 업무. 카드가 그 업무의 실행이 아니어도(조사 카드 등) 감시·후속 표시가 업무를 답 대기로 알아보게 한다(2026-10-07 [kyle]).
 request(card,{question,options,recommendation,reason,work,chat,reversible,notProhibited},by){let created=false;const saved=this.locked(()=>{
  if(!supervisor(by))throw new Error('사용자 결정 요청은 슈퍼감독만 작성');
  chat=chat===true;if(chat&&card!=null)throw new Error('--chat 결정은 카드 없이 업무로만 등록');
  const c=chat?null:new CardStore(this.home).get(card);this.list();
  if(chat){if(work===undefined||String(work).trim()==='없음')throw new Error('--chat 결정은 --work <업무주소> 필요');}
  if(work!==undefined&&String(work).trim()==='없음')work=undefined;
  else if(work!==undefined){work=required(work,'업무 주소').replace(/^work:/,'');if(new WorkStore(this.home).get(work).status!=='open')throw new Error('열린 업무만 연결');}
  else if(!chat){
   // 업무 밖 카드의 결정은 막는 업무를 밝혀야 저장한다(2026-10-08 [kyle]: 지침만으로는 --work 누락이 반복돼 감독이 15분마다 깨워졌다).
   const open=new WorkStore(this.home).list().filter(w=>w.status==='open');
   const candidates=open.some(w=>w.executions.some(x=>x.key===card))?[]:open.filter(w=>c.board&&w.board===c.board).map(w=>w.key);
   if(candidates.length)throw new Error(`업무 연결 필요: 이 카드는 업무의 실행이 아닙니다. 이 결정이 막는 업무를 --work로 적으세요: ${candidates.join(', ')}. 막는 업무가 없으면 --work 없음`);
  }
  question=required(question,'질문');
  if(chat){ // 선택지를 안 주면 고정 선택지, 이유를 안 주면 고정 문구, 확인 경로가 없으면 '확인 경로 없음: 채팅 질문' 줄을 채운다.
   if(options===undefined){options=[...CHAT_OPTIONS];recommendation??=CHAT_OPTIONS[0];}
   reason=required(reason??'kyle에게 채팅으로 물은 질문','추천 이유/사용자 판단 필요 이유');
   try{assertVerifyPath(question,reason)}catch{reason=`${reason}\n${CHAT_VERIFY_LINE}`}
  }else{reason=required(reason,'추천 이유/사용자 판단 필요 이유');assertVerifyPath(question,reason);}
  if(!Array.isArray(options))options=options===undefined?options:[options];
  if(!Array.isArray(options)||options.length<2||options.length>4)throw new Error('선택지 2~4개 필요');
  options=options.map(x=>required(x,'선택지'));if(new Set(options).size!==options.length||!options.includes(recommendation))throw new Error('중복 없는 선택지와 일치하는 추천 필요');
  // 완전자율의 "추천대로 진행" 자격 표시. 요청할 때만 붙일 수 있고(나중에 더하는 길 없음), 머지·관문·정책 결정에는 줄 수 없다.
  // 세 겹(검수 2라운드): (나) 금지 목록에 닿지 않는다는 선언 필수, (가) 업무가 있어야 하고 그 업무에 풀리지 않은 보류·관문 거절 기록이 없어야 함, (다) 낱말 거름. 모두 종료 코드 2.
  if(notProhibited!==undefined&&notProhibited!==true)throw Object.assign(new Error('--not-prohibited는 값 없는 옵션입니다'),{exitCode:2});
  if(reversible===undefined&&notProhibited)throw Object.assign(new Error('--not-prohibited는 --reversible과 함께만 줄 수 있습니다'),{exitCode:2});
  if(reversible!==undefined){
   reversible=required(typeof reversible==='string'?reversible:'','--reversible(되돌리는 방법 한 줄)');
   const refuse=m=>{throw Object.assign(new Error(`--reversible을 받지 않았습니다: ${m}`),{exitCode:2});};
   if(notProhibited!==true)refuse(`--not-prohibited로 이 결정이 금지 목록(${PROHIBITED_SUMMARY})에 닿지 않는다고 밝혀야 합니다`);
   if(!work)refuse('업무가 없는 결정은 보류·관문 거절 기록을 대조할 수 없습니다(--work 필요)');
   let rows=null;try{rows=readLedger(this.home);if(rows.some(e=>e?.broken))rows=null;}catch{rows=null;}
   const held=holdReason(holdBlocks(rows,work));if(held)refuse(held);
   if(gatedDecisionText({question,reason,recommendation,options}))refuse(`금지 목록·관문·정책에 닿을 수 있는 낱말이 있습니다(${WORD_HINT})`);
  }
  const existing=this.list().find(d=>d.status==='open'&&d.requestedBy===by&&d.question===question&&(chat?d.chat===true&&d.work===work:d.card===card));
  if(existing){if(JSON.stringify(existing.options)!==JSON.stringify(options)||existing.reason!==reason||existing.recommendation!==recommendation||(existing.reversible??null)!==(reversible??null)||Boolean(existing.notProhibited)!==Boolean(notProhibited))throw new Error('같은 질문의 다른 내용: 기존 요청을 취소한 뒤 새 요청');return existing;}
  created=true;return this.write({id:randomUUID(),revision:1,card:chat?null:card,...(chat?{chat:true}:{}),...(work?{work}:{}),...(reversible?{reversible,notProhibited:{by,at:new Date().toISOString()}}:{}),to:'@user',requestedBy:by,question,options,recommendation,reason,status:'open',at:new Date().toISOString()});
 });
 if(created)this.announce('request',saved);return saved;}
 // 사용자 알림(디스코드 → 시스템 알림). 결정은 이미 저장된 뒤에 부르고, 알림이 실패해도 던지지 않는다(2026-10-14 [kyle]).
 // 요청만 사용자 멘션이고 답변·취소는 멘션 없이 "해결됨"만 알린다. 시험이 실제로 보내지 않도록 KADAN_NOTIFY=off면 아무것도 안 보낸다.
 // 모든 결정 알림은 `[레포]`(카드 키 앞부분)로 시작한다. 요청은 업무 글, 업무가 없으면 그 레포의 '결정' 글로 가고(레포 웹훅이 없을 때만 #브리핑),
 // 답변·취소는 원래 요청 메시지를 고친다(상태를 맨 위에). 원래 메시지를 못 찾을 때만 질문 앞부분·사유가 든 새 메시지를 보낸다.
 announce(kind,d){
  if(process.env.KADAN_NOTIFY==='off'||d.chat===true)return null; // 채팅 질문은 kyle이 이미 채팅으로 받았다: 등록·닫힘 알림을 보내지 않는다(중복 멘션 방지).
  const cut=(t,n)=>{t=String(t).replace(/\s+/g,' ').trim();return t.length>n?t.slice(0,n-1)+'…':t;};
  const repo=d.card.split('/')[0],tag=`[${repo}]`;
  const link=decisionLink(this.home,d.id),where=link.startsWith('https://')?'열어서':'맥에서'; // 공개 주소 링크는 맥 밖(폰)에서 열린다
  const q=shortIds(d.question),summary=cut(q.split('\n').find(l=>l.trim())??q,80),full=cut(q,600);
  const body=()=>[...(full!==summary?[`질문: ${full}`]:[]),`선택지: ${d.options.map((o,i)=>`${i+1}) ${cut(shortIds(o),100)}`).join(' ')}`,`추천: ${cut(shortIds(d.recommendation),100)}`,`이유: ${cut(shortIds(d.reason),300)}`,
   `결정 ${d.id.slice(0,8)} · 카드 ${shortIds(d.card)}${d.work?` · 업무 ${shortIds(d.work)}`:''}`].join('\n');
  const head=mention=>`${tag} ${mention?`${mention} `:''}결정 요청: ${summary}\n${body()}`;
  const base={kind:`decision-${kind}`,workTitle:undefined,key:`decision:${d.id}:${kind}`,tagRepo:repo,
   ...(d.work?{work:d.work}:{repo,forumKey:`${repo}/__decisions__`,forumTitle:`${tag} 결정`})};
  const stateOf=x=>x.status==='answered'
   ?`답변: ${cut(shortIds(x.answer.choice??x.answer.text),150)}${x.answer.choice&&x.answer.text&&x.answer.text!==x.answer.choice?` — ${cut(shortIds(x.answer.text),200)}`:''}`
   :`취소: ${cut(shortIds(x.cancelReason??'사유 없음'),200)}`;
  const resolvedContent=x=>fitDiscord(`${tag} 결정 해결됨: ${cut(summary,60)} — ${stateOf(x)}`,`${where} 보기: ${link}`);
  let short,build,extra;
  if(kind==='request'){
   short=`카단 결정 요청: ${cut(q,100)}`;
   build=userId=>({mention:true,content:fitDiscord(head(`<@${userId}>`),`${where} 답하기: ${link}`)});
   // 보내기 직전에 저장소의 현재 상태를 다시 읽는다: 취소가 먼저 잠금을 잡았으면 열린 요청이 아니라 해결 모양으로 보낸다.
   extra={decision:{id:d.id,latest:()=>this.get(d.id),resolvedContent,resolvedShort:x=>`카단 결정 해결됨 — ${stateOf(x)}`}};
  }else{
   const state=stateOf({...d,status:kind==='answer'?'answered':'cancelled'});
   short=`카단 결정 해결됨 — ${state}`;
   extra={decision:{id:d.id,edit:fitDiscord(`✅ 해결됨 — ${state}\n${head('')}`,`${where} 보기: ${link}`)}};
   build=()=>({mention:false,content:resolvedContent({...d,status:kind==='answer'?'answered':'cancelled'})});
  }
  try{return this.userNotify(short,{...base,...extra,discord:build});}catch{return null;}
 }
 // source·messageId: 디코 다리가 사람 명의로 기록할 때 남기는 출처('discord')와 그 디코 글 id. 같은 글을 두 번 처리하지 않는 표시이기도 하다.
 // remote: 원격 답변의 감사 필드(Access 이메일·sub·iat·exp·IP). 옛 검증기가 무시하는 선택 필드 answer.remote로만 남기고 source 값은 넓히지 않는다.
 answer(id,{revision,text,choice,source,messageId,remote},by){let newlyAnswered=false;const saved=this.locked(()=>{
  if(!human(by)){
   // 역할이 kyle의 채팅 답을 기록하려다 거절될 때 닫는 길(cancel)을 실제 ID·revision으로 보인다. 못 찾거나 열린 결정이 아니면 값을 지어내지 않고 원래 문구만 낸다.
   let open=null;try{const d=this.get(id);if(d.status==='open')open=d;}catch{}
   throw new Error('사용자 답변은 사람 명의로만 기록'+(open?` — kyle이 채팅으로 답했으면 요청한 역할(${open.requestedBy})이 kadan decision cancel ${open.id} --revision ${open.revision} --reason "kyle 채팅 승인: <답 원문>"으로 닫는다`:''));
  }
  if(source!==undefined&&source!=='discord')throw new Error('알 수 없는 답변 출처');
  if(messageId!==undefined&&(typeof messageId!=='string'||!messageId))throw new Error('디코 글 id 형식 오류');
  const d=this.get(id);choice=choice||null;text=required(typeof text==='string'&&text.trim()?text:choice,'답변 또는 선택');
  if(choice&&!d.options.includes(choice))throw new Error('선택지가 일치하지 않음');
  if(d.status==='answered'&&d.answer.text===text&&d.answer.choice===choice)return d;
  if(d.status!=='open'||Number(revision)!==d.revision)throw new Error('요청 상태/버전 변경: 다시 확인');
  newlyAnswered=true;return this.write({...d,revision:d.revision+1,status:'answered',answer:{by,text,choice,at:new Date().toISOString(),...(source?{source}:{}),...(messageId?{messageId}:{}),...(remote?{remote}:{})},delivery:{status:'pending'}});
 });
 if(!newlyAnswered)return saved;
 const d=saved;
  let delivery;try{
   const rows=readLedger(this.home);if(rows.some(e=>e?.broken))throw new Error('원장 손상');
   const role=d.chat===true?d.requestedBy:effectiveCardRole({key:d.card,role:d.requestedBy,id:d.card.split('/')[1],at:d.at},rows,new CardStore(this.home).list());
   const late=d.proceeded&&(choice??text)!==d.recommendation?` 추천대로 이미 진행됨 — 되돌리는 방법: ${d.proceeded.reversible}.`:'';
   this.notify(role,`[kyle] 결정 답변 ${id} / ${d.chat===true?`업무 ${d.work}`:`카드 ${d.card}`}: ${text}${choice?` (선택: ${choice})`:''}.${late} decision show로 질문/답변을 확인하고 기존 승인 범위에서 후속 처리하라.`);
   delivery={status:'sent',role};
  }catch(error){delivery={status:'failed',error:error.message};}
  this.announce('answer',d);
  return this.locked(()=>{const current=this.get(id);if(current.revision!==saved.revision)throw new Error('통지 이후 결정 변경: 현재 상태 확인 필요');return this.write({...current,revision:current.revision+1,delivery});});
 }
 // 디코 자유 답(choice 없음)은 관계없는 말이 답으로 굳을 수 있어 그 결정의 요청자만 answered 상태에서도 취소할 수 있다(2026-10-16 PR #173 검수).
 // 기록은 고치지 않고 취소 사건을 뒤에 쌓는다. 선택지 답과 디코 밖의 답은 지금처럼 취소하지 못한다. 취소하면 그 스레드에 조용한 글을 단다.
 cancel(id,{revision,reason,via},by){let freeAnswer=false;const cancelled=this.locked(()=>{const d=this.get(id);if(!human(by)&&by!==d.requestedBy&&!(by===AUTO_BY&&d.chat===true))throw new Error('요청자 또는 사용자만 취소');
  freeAnswer=d.status==='answered'&&d.answer.source==='discord'&&!d.answer.choice&&by===d.requestedBy;
  if((d.status!=='open'&&!freeAnswer)||Number(revision)!==d.revision)throw new Error('요청 상태/버전 변경');return this.write({...d,status:'cancelled',revision:d.revision+1,cancelReason:required(reason,'취소 이유'),cancelledBy:by,cancelledAt:new Date().toISOString(),...(via?{cancelledVia:via}:{}),...(freeAnswer?{cancelledAnswer:true}:{})});});this.announce('cancel',cancelled);
  if(freeAnswer)this.threadNote(cancelled,'기타 답 기록 취소됨');return cancelled;}
 // 완전자율: 답 없는 결정을 추천대로 진행했다는 기록을 덧붙인다. 자격은 proceedEligibility 한 곳에서 검사하고(통과 못 하면 이유를 모두 모아 종료 코드 2, 아무것도 쓰지 않음),
 // 결정은 닫지 않는다: 상태는 그대로 열려 있고 kyle의 늦은 답이 정상 답으로 기록된다. 이미 진행했으면 기록 없이 already를 돌려준다.
 // by는 역할 명의다(사용자 행위자가 아니다). 알림·요약 기록이 실패해도 진행 기록은 남고 경고로 드러낸다.
 proceed(id,{revision},by,{now,expectStartedAt}){let already=false,at=0;const saved=this.locked(()=>{
  // 판정은 쓰기 잠금 안에서 다시 읽는다(검수 F3): Autopilot 켜짐 구간·단계·대기 시간·경과 시간·부른 쪽의 권한·업무의 보류 기록을 잠금 안의 원장에서 새로 읽고,
  // 잠금을 기다리는 사이 꺼졌거나 다시 켜졌으면(켜짐 구간 시작이 바뀌었으면) 거절한다. 시계도 잠금 안에서 다시 읽는다.
  const d=this.get(id);
  if(d.proceeded){already=true;return d;}
  at=now();
  let rows=null;try{rows=readLedger(this.home);if(rows.some(e=>e?.broken))rows=null;}catch{rows=null;}
  const ap=rows?autopilotWingmanSnapshot(rows,at):null;
  const reasons=rows?[...proceedEligibility(d,ap,at).reasons]:['원장을 읽지 못해 Autopilot 상태를 확인할 수 없습니다(진행하지 않음)'];
  if(ap?.on&&expectStartedAt!==undefined&&ap.startedAt!==expectStartedAt)reasons.push('명령을 받은 뒤 Autopilot 켜짐 구간이 바뀌었습니다(꺼졌다 다시 켜짐)');
  const held=holdReason(holdBlocks(rows,d.work));if(held)reasons.push(held);
  if(!mayProceed(by,d,rows?readActiveHierarchy(rows):null))reasons.push(`요청한 역할(${d.requestedBy}) 또는 그 가장 가까운 슈퍼감독만 진행할 수 있습니다(부른 쪽: ${by})`);
  if(reasons.length)throw Object.assign(new Error(`추천대로 진행할 수 없습니다: ${reasons.join('; ')}`),{exitCode:2});
  if(Number(revision)!==d.revision)throw new Error('요청 상태/버전 변경: 다시 확인');
  return this.write({...d,revision:d.revision+1,proceeded:{by,at:new Date(at).toISOString(),recommendation:d.recommendation,reversible:d.reversible,notProhibited:d.notProhibited}});
 });
 if(already)return {already:true,decision:saved};
 const now_=at;
 const warnings=[],cut=t=>{t=String(t).replace(/\s+/g,' ').trim();return t.length>100?t.slice(0,99)+'…':t;};
 const q=cut(shortIds(saved.question)),line=`추천대로 진행함: ${q} → ${cut(shortIds(saved.recommendation))} (되돌리는 방법: ${cut(shortIds(saved.reversible))}; 요청자 선언: ${saved.notProhibited?.by} 금지 목록에 닿지 않음)`;
 try{
  if(process.env.KADAN_NOTIFY!=='off'){
   const repo=(saved.card??saved.work??'').split('/')[0],tag=`[${repo}]`;
   const r=this.userNotify(`${tag} ${line}. 늦게라도 다른 답을 주면 그 답이 우선합니다: ${decisionLink(this.home,saved.id)}`,{kind:'decision-proceed',key:`decision:${saved.id}:proceed`,tagRepo:repo,...(saved.work?{work:saved.work}:{repo,forumKey:`${repo}/__decisions__`,forumTitle:`${tag} 결정`})});
   if(r&&typeof r==='object'&&r.error)warnings.push(`kyle 알림을 보내지 못했습니다: ${String(r.error).slice(0,200)}`);
  }
 }catch(error){warnings.push(`kyle 알림을 보내지 못했습니다: ${String(error?.message??error).slice(0,200)}`);}
 try{appendLedger(buildAutopilotNote({words:['decision',line],flags:saved.work?{work:saved.work}:{},by,now:now_}),this.home);}
 catch(error){warnings.push(`요약 기록(autopilot note)을 남기지 못했습니다: ${String(error?.message??error).slice(0,200)}`);}
 return {already:false,decision:saved,...(warnings.length?{warnings}:{})};}
 // 업무 명령(execute·turn-owner update·complete)이 성공한 뒤, 같은 업무의 열린 채팅 결정 가운데 규칙이 허락한 것만 닫는다.
 // 카드 결정은 건드리지 않는다. 닫을 대상을 거르는 자리는 `shouldClose` 한 곳이다(조건을 더할 때 여기만 고친다).
 // rule: 'requester' = 부른 역할(by)이 요청한 결정만, 'all' = 모두, 'none' = 하나도 닫지 않음. 닫지 않고 남긴 열린 결정도 돌려준다.
 // 닫힌 건수의 취소마다 따로 잠근다(업무 쓰기와 같은 트랜잭션에 넣지 않는다). 만료는 만들지 않는다.
 closeChatForWork(work,reason,via,{rule='all',by}={}){const key=String(work).replace(/^work:/,'');const closed=[],kept=[];
  // 진행 기록이 붙은 결정(완전자율이 추천대로 진행함)은 요청자 본인의 work execute로 자동 취소하지 않는다: 늦은 사람 답을 받을 수 있어야 한다. 완료·취소(rule all)는 그대로 닫는다.
  const shouldClose=d=>rule==='all'||(rule==='requester'&&by!==undefined&&d.requestedBy===by&&!d.proceeded);
  for(const d of this.list())if(d.status==='open'&&d.chat===true&&d.work===key)
   (shouldClose(d)?closed.push(this.cancel(d.id,{revision:d.revision,reason,via},AUTO_BY)):kept.push(d));
  return {closed,kept};}
}
export function decisionCommand(args,flags,{home,by,notify,now,userNotify}){
 const s=new DecisionStore(home,{notify,userNotify}),[cmd,key]=args;
 if(flags.help||!cmd)return 'kadan decision request <카드키> [--work <업무주소>|없음] --question 질문 --option 선택1 --option 선택2 --recommend 추천선택 --reason 이유 [--reversible 되돌리는방법한줄 --not-prohibited(둘은 함께만 준다)] | request --chat --work <업무주소> --question 질문 [--option 선택1 --option 선택2 --recommend 추천선택 --reason 이유] (kyle에게 채팅으로 이미 물은 질문 등록. 선택지 생략 시 추천대로 진행/보류. 알림 없음) | proceed <ID> --revision N (완전자율에서 대기 시간이 지난 --reversible을 붙인 결정만 추천대로 진행함 기록. 결정은 닫지 않음) | list [--status open] | show <ID> | answer <ID> --revision N (--text 답변 | --choice 선택) | cancel <ID> --revision N --reason 이유';
 if(cmd==='request'&&flags.chat){
  if(key)throw new Error('--chat 결정은 카드키 없이 --work <업무주소>로 등록');
  const d=s.request(null,{question:flags.question,options:flags.option,recommendation:flags.recommend,reason:flags.reason,work:flags.work,chat:true,reversible:flags.reversible,notProhibited:flags['not-prohibited']},by);
  return {...d,chatCloseCommand:`kadan decision cancel ${d.id} --revision ${d.revision} --reason "kyle 채팅 답: <원문>"`};
 }
 if(cmd==='request')return s.request(key,{question:flags.question,options:flags.option,recommendation:flags.recommend,reason:flags.reason,work:flags.work,reversible:flags.reversible,notProhibited:flags['not-prohibited']},by);
 if(cmd==='proceed'){
  // 명령을 받을 때의 켜짐 구간 시작을 기억해 두고, 잠금 안에서 다시 읽은 값과 다르면 거절한다.
  const first=(now??Date.now)(),rows=readLedger(home);
  if(rows.some(e=>e?.broken))throw new Error('원장 손상: 진행 자격을 확인할 수 없습니다');
  return s.proceed(key,{revision:flags.revision},by,{now:now??Date.now,expectStartedAt:autopilotWingmanSnapshot(rows,first).startedAt});
 }
 if(cmd==='list')return s.list().filter(d=>!flags.status||d.status===flags.status);
 if(cmd==='show')return s.get(key);
 if(cmd==='answer')return s.answer(key,{revision:flags.revision,text:flags.text,choice:flags.choice},by);
 if(cmd==='cancel')return s.cancel(key,{revision:flags.revision,reason:flags.reason},by);
 throw new Error('알 수 없는 decision 명령');
}
