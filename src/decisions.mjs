import {assertWritable,storageMode,transaction,readStream,appendStream} from './storage.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {CardStore} from './card-store.mjs';
import {readLedger} from './ledger.mjs';
import {effectiveCardRole} from './handover-state.mjs';
import {isUserActor} from './actors.mjs';
const supervisor=by=>typeof by==='string'&&/(^|-)슈퍼감독(?:-\d+)?$/.test(by);
const human=by=>isUserActor(by);
const required=(v,name)=>{if(typeof v!=='string'||!v.trim())throw new Error(`${name} 필요`);return v.trim()};
// 새 결정 요청은 사용자가 답하기 전에 열어 볼 주소·절대경로, 또는 '확인 경로 없음: 이유' 줄이 있어야 한다.
export function assertVerifyPath(...texts){
 const text=texts.filter(t=>typeof t==='string').join('\n');
 if(/https?:\/\/\S/.test(text)||/(^|[\s(\[<"'`])\/[^\s\/]+\/\S/.test(text)||/^[ \t]*[-*]?[ \t]*확인 경로 없음:[ \t]*\S/m.test(text))return;
 const blank=/확인 경로 없음:/.test(text)?'"확인 경로 없음:" 뒤에 이유가 비어 있습니다. ':'';
 throw new Error(`확인 경로 필요: ${blank}질문이나 이유에 답하기 전에 열어 볼 주소나 절대경로를 한 줄에 하나씩 넣으세요. 예: "- PR: https://github.com/<조직>/<레포>/pull/<번호>", "- Preview: <배포 기록에서 확인한 실제 접속 주소>", "- 노션: https://www.notion.so/<페이지>", "- 결과 파일: /home/<이름>/.kadan/cards/<저장소>/<카드>/result.md". 열어 볼 대상이 없는 순수 방침 질문이면 "- 확인 경로 없음: <이유>" 줄을 넣으세요.`);
}
export class DecisionStore {
 constructor(home,{notify}={}){this.home=home;this.dir=path.join(home,'decisions');this.notify=notify??((role,message)=>{
  const r=spawnSync(process.execPath,[new URL('./cli.mjs',import.meta.url).pathname,'send',role,message],{env:{...process.env,KADAN_HOME:home,KADAN_ROLE:'사람'},encoding:'utf8',timeout:15000});
  if(r.status!==0)throw new Error('통지 실패/불확실: 요청자 화면과 우편 원장을 확인하세요');
 });}
 list(){
  const latest=new Map();for(const e of readStream(this.home,'decisions/events.jsonl',{optional:true})){
   const old=latest.get(e.id);if(!Array.isArray(e.options)||e.options.length<2||!e.options.every(x=>typeof x==='string')||typeof e.question!=='string'||typeof e.reason!=='string'||typeof e.card!=='string'||!supervisor(e.requestedBy)||(e.status==='answered'&&typeof e.answer?.text!=='string')||!e.id||e.to!=='@user'||e.revision!==(old?.revision??0)+1||!['open','answered','cancelled'].includes(e.status))throw new Error('결정 이력 손상');latest.set(e.id,e);
  }return [...latest.values()];}
 get(id){const d=this.list().find(d=>d.id===id);if(!d)throw new Error('결정 요청 없음');return d;}
 write(d){appendStream(this.home,'decisions/events.jsonl',d);return d;}
 locked(fn){assertWritable(this.home);if(storageMode(this.home)==='sqlite')return transaction(this.home,fn);fs.mkdirSync(this.dir,{recursive:true,mode:0o700});const lock=path.join(this.dir,'.lock');try{fs.mkdirSync(lock)}catch{throw new Error('결정 저장 중: 새 상태를 확인하세요')}
  try{return fn()}finally{fs.renameSync(lock,path.join(this.dir,`.released-${randomUUID()}`))}}
 request(card,{question,options,recommendation,reason},by){return this.locked(()=>{
  if(!supervisor(by))throw new Error('사용자 결정 요청은 슈퍼감독만 작성');
  new CardStore(this.home).get(card);this.list();
  question=required(question,'질문');reason=required(reason,'추천 이유/사용자 판단 필요 이유');
  assertVerifyPath(question,reason);
  if(!Array.isArray(options)||options.length<2||options.length>4)throw new Error('선택지 2~4개 필요');
  options=options.map(x=>required(x,'선택지'));if(new Set(options).size!==options.length||!options.includes(recommendation))throw new Error('중복 없는 선택지와 일치하는 추천 필요');
  const existing=this.list().find(d=>d.status==='open'&&d.card===card&&d.requestedBy===by&&d.question===question);
  if(existing){if(JSON.stringify(existing.options)!==JSON.stringify(options)||existing.reason!==reason||existing.recommendation!==recommendation)throw new Error('같은 질문의 다른 내용: 기존 요청을 취소한 뒤 새 요청');return existing;}
  return this.write({id:randomUUID(),revision:1,card,to:'@user',requestedBy:by,question,options,recommendation,reason,status:'open',at:new Date().toISOString()});
 });}
 answer(id,{revision,text,choice},by){let newlyAnswered=false;const saved=this.locked(()=>{
  if(!human(by))throw new Error('사용자 답변은 사람 명의로만 기록');
  const d=this.get(id);choice=choice||null;text=required(typeof text==='string'&&text.trim()?text:choice,'답변 또는 선택');
  if(choice&&!d.options.includes(choice))throw new Error('선택지가 일치하지 않음');
  if(d.status==='answered'&&d.answer.text===text&&d.answer.choice===choice)return d;
  if(d.status!=='open'||Number(revision)!==d.revision)throw new Error('요청 상태/버전 변경: 다시 확인');
  newlyAnswered=true;return this.write({...d,revision:d.revision+1,status:'answered',answer:{by,text,choice,at:new Date().toISOString()},delivery:{status:'pending'}});
 });
 if(!newlyAnswered)return saved;
 const d=saved;
  let delivery;try{
   const rows=readLedger(this.home);if(rows.some(e=>e?.broken))throw new Error('원장 손상');
   const role=effectiveCardRole({key:d.card,role:d.requestedBy,id:d.card.split('/')[1],at:d.at},rows,new CardStore(this.home).list());
   this.notify(role,`[kyle] 결정 답변 ${id} / 카드 ${d.card}: ${text}${choice?` (선택: ${choice})`:''}. decision show로 질문/답변을 확인하고 기존 승인 범위에서 후속 처리하라.`);
   delivery={status:'sent',role};
  }catch(error){delivery={status:'failed',error:error.message};}
  return this.locked(()=>{const current=this.get(id);if(current.revision!==saved.revision)throw new Error('통지 이후 결정 변경: 현재 상태 확인 필요');return this.write({...current,revision:current.revision+1,delivery});});
 }
 cancel(id,{revision,reason},by){return this.locked(()=>{const d=this.get(id);if(!human(by)&&by!==d.requestedBy)throw new Error('요청자 또는 사용자만 취소');
  if(d.status!=='open'||Number(revision)!==d.revision)throw new Error('요청 상태/버전 변경');return this.write({...d,status:'cancelled',revision:d.revision+1,cancelReason:required(reason,'취소 이유'),cancelledBy:by});});}
}
export function decisionCommand(args,flags,{home,by,notify}){
 const s=new DecisionStore(home,{notify}),[cmd,key]=args;
 if(flags.help||!cmd)return 'kadan decision request <카드키> --question 질문 --option 선택1 --option 선택2 --recommend 추천선택 --reason 이유 | list [--status open] | show <ID> | answer <ID> --revision N (--text 답변 | --choice 선택) | cancel <ID> --revision N --reason 이유';
 if(cmd==='request')return s.request(key,{question:flags.question,options:flags.option,recommendation:flags.recommend,reason:flags.reason},by);
 if(cmd==='list')return s.list().filter(d=>!flags.status||d.status===flags.status);
 if(cmd==='show')return s.get(key);
 if(cmd==='answer')return s.answer(key,{revision:flags.revision,text:flags.text,choice:flags.choice},by);
 if(cmd==='cancel')return s.cancel(key,{revision:flags.revision,reason:flags.reason},by);
 throw new Error('알 수 없는 decision 명령');
}
