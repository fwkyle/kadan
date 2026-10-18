import {assertWritable,storageMode,transaction,readStream,appendStream} from './storage.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {CardStore} from './card-store.mjs';
import {WorkStore} from './work-store.mjs';
import {readLedger} from './ledger.mjs';
import {effectiveCardRole} from './handover-state.mjs';
import {isUserActor} from './actors.mjs';
import {notifyUser,fitDiscord} from './user-notify.mjs';
import {DEFAULT_PORT} from './quickstart.mjs';
import {readDecisions} from './notify-threads.mjs';
import {loadRemoteConfig} from './remote-access.mjs';
const supervisor=by=>typeof by==='string'&&/(^|-)슈퍼감독(?:-\d+)?$/.test(by);
const human=by=>isUserActor(by);
const UUID=/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi;
// 보이는 본문의 UUID를 앞 8자로 줄인다. 단 경로·주소 조각(/·~·./·../로 시작, ://, 슬래시 2개 이상)은 확인 경로가 깨지므로 그대로 둔다.
const keepWhole=tok=>/^[(\[<"'`]*(?:[/~]|\.{1,2}\/|[a-z][a-z0-9+.-]*:\/\/)/i.test(tok)||(tok.match(/\//g)??[]).length>=2;
const shortIds=text=>String(text).split(/(\s+)/).map(tok=>keepWhole(tok)?tok:tok.replace(UUID,m=>m.slice(0,8))).join('');
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
export class DecisionStore {
 constructor(home,{notify,userNotify,threadNote}={}){this.home=home;this.threadNote=threadNote??((d,text)=>postThreadNote(home,d,text));this.userNotify=userNotify??((message,opts)=>notifyUser(message,spawnSync,{home,...opts}));this.dir=path.join(home,'decisions');this.notify=notify??((role,message)=>{
  const r=spawnSync(process.execPath,[new URL('./cli.mjs',import.meta.url).pathname,'send',role,message],{env:{...process.env,KADAN_HOME:home,KADAN_ROLE:'사람'},encoding:'utf8',timeout:15000});
  if(r.status!==0)throw new Error('통지 실패/불확실: 요청자 화면과 우편 원장을 확인하세요');
 });}
 list(){
  const latest=new Map();for(const e of readStream(this.home,'decisions/events.jsonl',{optional:true})){
   const old=latest.get(e.id);if(!Array.isArray(e.options)||e.options.length<2||!e.options.every(x=>typeof x==='string')||typeof e.question!=='string'||typeof e.reason!=='string'||typeof e.card!=='string'||(e.work!==undefined&&typeof e.work!=='string')||!supervisor(e.requestedBy)||(e.status==='answered'&&typeof e.answer?.text!=='string')||(e.answer?.source!==undefined&&e.answer.source!=='discord')||(e.answer?.messageId!==undefined&&typeof e.answer.messageId!=='string')||!e.id||e.to!=='@user'||e.revision!==(old?.revision??0)+1||!['open','answered','cancelled'].includes(e.status))throw new Error('결정 이력 손상');latest.set(e.id,e);
  }return [...latest.values()];}
 get(id){const d=this.list().find(d=>d.id===id);if(!d)throw new Error('결정 요청 없음');return d;}
 write(d){appendStream(this.home,'decisions/events.jsonl',d);return d;}
 locked(fn){assertWritable(this.home);if(storageMode(this.home)==='sqlite')return transaction(this.home,fn);fs.mkdirSync(this.dir,{recursive:true,mode:0o700});const lock=path.join(this.dir,'.lock');try{fs.mkdirSync(lock)}catch{throw new Error('결정 저장 중: 새 상태를 확인하세요')}
  try{return fn()}finally{fs.renameSync(lock,path.join(this.dir,`.released-${randomUUID()}`))}}
 // work: 결정이 막고 있는 업무. 카드가 그 업무의 실행이 아니어도(조사 카드 등) 감시·후속 표시가 업무를 답 대기로 알아보게 한다(2026-10-07 [kyle]).
 request(card,{question,options,recommendation,reason,work},by){let created=false;const saved=this.locked(()=>{
  if(!supervisor(by))throw new Error('사용자 결정 요청은 슈퍼감독만 작성');
  const c=new CardStore(this.home).get(card);this.list();
  if(work!==undefined&&String(work).trim()==='없음')work=undefined;
  else if(work!==undefined){work=required(work,'업무 주소').replace(/^work:/,'');if(new WorkStore(this.home).get(work).status!=='open')throw new Error('열린 업무만 연결');}
  else{
   // 업무 밖 카드의 결정은 막는 업무를 밝혀야 저장한다(2026-10-08 [kyle]: 지침만으로는 --work 누락이 반복돼 감독이 15분마다 깨워졌다).
   const open=new WorkStore(this.home).list().filter(w=>w.status==='open');
   const candidates=open.some(w=>w.executions.some(x=>x.key===card))?[]:open.filter(w=>c.board&&w.board===c.board).map(w=>w.key);
   if(candidates.length)throw new Error(`업무 연결 필요: 이 카드는 업무의 실행이 아닙니다. 이 결정이 막는 업무를 --work로 적으세요: ${candidates.join(', ')}. 막는 업무가 없으면 --work 없음`);
  }
  question=required(question,'질문');reason=required(reason,'추천 이유/사용자 판단 필요 이유');
  assertVerifyPath(question,reason);
  if(!Array.isArray(options)||options.length<2||options.length>4)throw new Error('선택지 2~4개 필요');
  options=options.map(x=>required(x,'선택지'));if(new Set(options).size!==options.length||!options.includes(recommendation))throw new Error('중복 없는 선택지와 일치하는 추천 필요');
  const existing=this.list().find(d=>d.status==='open'&&d.card===card&&d.requestedBy===by&&d.question===question);
  if(existing){if(JSON.stringify(existing.options)!==JSON.stringify(options)||existing.reason!==reason||existing.recommendation!==recommendation)throw new Error('같은 질문의 다른 내용: 기존 요청을 취소한 뒤 새 요청');return existing;}
  created=true;return this.write({id:randomUUID(),revision:1,card,...(work?{work}:{}),to:'@user',requestedBy:by,question,options,recommendation,reason,status:'open',at:new Date().toISOString()});
 });
 if(created)this.announce('request',saved);return saved;}
 // 사용자 알림(디스코드 → 시스템 알림). 결정은 이미 저장된 뒤에 부르고, 알림이 실패해도 던지지 않는다(2026-10-14 [kyle]).
 // 요청만 사용자 멘션이고 답변·취소는 멘션 없이 "해결됨"만 알린다. 시험이 실제로 보내지 않도록 KADAN_NOTIFY=off면 아무것도 안 보낸다.
 // 모든 결정 알림은 `[레포]`(카드 키 앞부분)로 시작한다. 요청은 업무 글, 업무가 없으면 그 레포의 '결정' 글로 가고(레포 웹훅이 없을 때만 #브리핑),
 // 답변·취소는 원래 요청 메시지를 고친다(상태를 맨 위에). 원래 메시지를 못 찾을 때만 질문 앞부분·사유가 든 새 메시지를 보낸다.
 announce(kind,d){
  if(process.env.KADAN_NOTIFY==='off')return null;
  const cut=(t,n)=>{t=String(t).replace(/\s+/g,' ').trim();return t.length>n?t.slice(0,n-1)+'…':t;};
  const repo=d.card.split('/')[0],tag=`[${repo}]`;
  const link=decisionLink(this.home,d.id);
  const q=shortIds(d.question),summary=cut(q.split('\n').find(l=>l.trim())??q,80),full=cut(q,600);
  const body=()=>[...(full!==summary?[`질문: ${full}`]:[]),`선택지: ${d.options.map((o,i)=>`${i+1}) ${cut(shortIds(o),100)}`).join(' ')}`,`추천: ${cut(shortIds(d.recommendation),100)}`,`이유: ${cut(shortIds(d.reason),300)}`,
   `결정 ${d.id.slice(0,8)} · 카드 ${shortIds(d.card)}${d.work?` · 업무 ${shortIds(d.work)}`:''}`].join('\n');
  const head=mention=>`${tag} ${mention?`${mention} `:''}결정 요청: ${summary}\n${body()}`;
  const base={kind:`decision-${kind}`,workTitle:undefined,key:`decision:${d.id}:${kind}`,tagRepo:repo,
   ...(d.work?{work:d.work}:{repo,forumKey:`${repo}/__decisions__`,forumTitle:`${tag} 결정`})};
  const stateOf=x=>x.status==='answered'
   ?`답변: ${cut(shortIds(x.answer.choice??x.answer.text),150)}${x.answer.choice&&x.answer.text&&x.answer.text!==x.answer.choice?` — ${cut(shortIds(x.answer.text),200)}`:''}`
   :`취소: ${cut(shortIds(x.cancelReason??'사유 없음'),200)}`;
  const resolvedContent=x=>fitDiscord(`${tag} 결정 해결됨: ${cut(summary,60)} — ${stateOf(x)}`,`맥에서 보기: ${link}`);
  let short,build,extra;
  if(kind==='request'){
   short=`카단 결정 요청: ${cut(q,100)}`;
   build=userId=>({mention:true,content:fitDiscord(head(`<@${userId}>`),`맥에서 답하기: ${link}`)});
   // 보내기 직전에 저장소의 현재 상태를 다시 읽는다: 취소가 먼저 잠금을 잡았으면 열린 요청이 아니라 해결 모양으로 보낸다.
   extra={decision:{id:d.id,latest:()=>this.get(d.id),resolvedContent,resolvedShort:x=>`카단 결정 해결됨 — ${stateOf(x)}`}};
  }else{
   const state=stateOf({...d,status:kind==='answer'?'answered':'cancelled'});
   short=`카단 결정 해결됨 — ${state}`;
   extra={decision:{id:d.id,edit:fitDiscord(`✅ 해결됨 — ${state}\n${head('')}`,`맥에서 보기: ${link}`)}};
   build=()=>({mention:false,content:resolvedContent({...d,status:kind==='answer'?'answered':'cancelled'})});
  }
  try{return this.userNotify(short,{...base,...extra,discord:build});}catch{return null;}
 }
 // source·messageId: 디코 다리가 사람 명의로 기록할 때 남기는 출처('discord')와 그 디코 글 id. 같은 글을 두 번 처리하지 않는 표시이기도 하다.
 // remote: 원격 답변의 감사 필드(Access 이메일·sub·iat·exp·IP). 옛 검증기가 무시하는 선택 필드 answer.remote로만 남기고 source 값은 넓히지 않는다.
 answer(id,{revision,text,choice,source,messageId,remote},by){let newlyAnswered=false;const saved=this.locked(()=>{
  if(!human(by))throw new Error('사용자 답변은 사람 명의로만 기록');
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
   const role=effectiveCardRole({key:d.card,role:d.requestedBy,id:d.card.split('/')[1],at:d.at},rows,new CardStore(this.home).list());
   this.notify(role,`[kyle] 결정 답변 ${id} / 카드 ${d.card}: ${text}${choice?` (선택: ${choice})`:''}. decision show로 질문/답변을 확인하고 기존 승인 범위에서 후속 처리하라.`);
   delivery={status:'sent',role};
  }catch(error){delivery={status:'failed',error:error.message};}
  this.announce('answer',d);
  return this.locked(()=>{const current=this.get(id);if(current.revision!==saved.revision)throw new Error('통지 이후 결정 변경: 현재 상태 확인 필요');return this.write({...current,revision:current.revision+1,delivery});});
 }
 // 디코 자유 답(choice 없음)은 관계없는 말이 답으로 굳을 수 있어 그 결정의 요청자만 answered 상태에서도 취소할 수 있다(2026-10-16 PR #173 검수).
 // 기록은 고치지 않고 취소 사건을 뒤에 쌓는다. 선택지 답과 디코 밖의 답은 지금처럼 취소하지 못한다. 취소하면 그 스레드에 조용한 글을 단다.
 cancel(id,{revision,reason},by){let freeAnswer=false;const cancelled=this.locked(()=>{const d=this.get(id);if(!human(by)&&by!==d.requestedBy)throw new Error('요청자 또는 사용자만 취소');
  freeAnswer=d.status==='answered'&&d.answer.source==='discord'&&!d.answer.choice&&by===d.requestedBy;
  if((d.status!=='open'&&!freeAnswer)||Number(revision)!==d.revision)throw new Error('요청 상태/버전 변경');return this.write({...d,status:'cancelled',revision:d.revision+1,cancelReason:required(reason,'취소 이유'),cancelledBy:by,cancelledAt:new Date().toISOString(),...(freeAnswer?{cancelledAnswer:true}:{})});});this.announce('cancel',cancelled);
  if(freeAnswer)this.threadNote(cancelled,'기타 답 기록 취소됨');return cancelled;}
}
export function decisionCommand(args,flags,{home,by,notify}){
 const s=new DecisionStore(home,{notify}),[cmd,key]=args;
 if(flags.help||!cmd)return 'kadan decision request <카드키> [--work <업무주소>|없음] --question 질문 --option 선택1 --option 선택2 --recommend 추천선택 --reason 이유 | list [--status open] | show <ID> | answer <ID> --revision N (--text 답변 | --choice 선택) | cancel <ID> --revision N --reason 이유';
 if(cmd==='request')return s.request(key,{question:flags.question,options:flags.option,recommendation:flags.recommend,reason:flags.reason,work:flags.work},by);
 if(cmd==='list')return s.list().filter(d=>!flags.status||d.status===flags.status);
 if(cmd==='show')return s.get(key);
 if(cmd==='answer')return s.answer(key,{revision:flags.revision,text:flags.text,choice:flags.choice},by);
 if(cmd==='cancel')return s.cancel(key,{revision:flags.revision,reason:flags.reason},by);
 throw new Error('알 수 없는 decision 명령');
}
