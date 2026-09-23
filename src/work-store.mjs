import fs from 'node:fs';
import path from 'node:path';
import {isUserActor} from './actors.mjs';
import {randomUUID} from 'node:crypto';
import {assertWritable,storageMode,storageSnapshot,transaction,readStream,appendStream,listStreams} from './storage.mjs';
import {CardStore} from './card-store.mjs';
import {buildCardCenter} from './card-center.mjs';
import {readLedger} from './ledger.mjs';
import {effectiveWorkOwner} from './handover-state.mjs';

export const workPhases={implementation:'구현',review:'검수',fix:'수정',release:'배포·연결',research:'조사',other:'기타'};
export const endedExecution=c=>['done','failed','cancelled','superseded','archived'].includes(c.displayState);
const required=(value,label,max=12000)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(`${label}을(를) 적어주세요 (${max}자 이내)`);return value.trim();};
const keyStream=key=>{if(typeof key!=='string'||!/^([\p{L}\p{N}_-]+)\/([\p{L}\p{N}_-]+)$/u.test(key))throw new Error('업무 주소는 저장소/업무ID');return `works/${key}/events.jsonl`;};

// 업무 완료는 실행 DONE과 다른 기록이다. 기존 카드와 우편은 ID로만 연결한다.
export class WorkStore {
 constructor(home){this.home=home;}
 get(key){
  const history=readStream(this.home,keyStream(key));
  if(!history.length||history.some((h,i)=>h.key!==key||h.revision!==i+1||!Array.isArray(h.executions)||!Array.isArray(h.mailRefs)))throw new Error('업무 이력 손상');
  return {...history.at(-1),history};
 }
 list(){return storageSnapshot(this.home,()=>{
  if(storageMode(this.home)==='sqlite')return listStreams(this.home,'works/').filter(s=>s.endsWith('/events.jsonl')).map(s=>this.get(s.slice(6,-13)));
  const root=path.join(this.home,'works');if(!fs.existsSync(root))return [];
  return fs.readdirSync(root,{withFileTypes:true}).filter(x=>x.isDirectory()&&!x.name.startsWith('.')).flatMap(repo=>fs.readdirSync(path.join(root,repo.name),{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>this.get(`${repo.name}/${x.name}`)));
 });}
 locked(fn){
  assertWritable(this.home);if(storageMode(this.home)==='sqlite')return transaction(this.home,fn);
  const root=path.join(this.home,'works');fs.mkdirSync(root,{recursive:true,mode:0o700});
  const lock=path.join(root,'.lock');try{fs.mkdirSync(lock)}catch{throw new Error('업무 저장 중: 새로 읽고 확인하세요');}
  try{return fn()}finally{fs.renameSync(lock,path.join(root,`.released-${randomUUID()}`));}
 }
 create({key,title,goal,scope,acceptance,owner,repoPath,board='',by='사람'}){
  return this.locked(()=>{
   const stream=keyStream(key);if(readStream(this.home,stream,{optional:true}).length)throw new Error('이미 있는 업무 ID');
   if(typeof repoPath!=='string'||!path.isAbsolute(repoPath)||!fs.statSync(repoPath).isDirectory())throw new Error('저장소 절대경로 필요');
   const record={key,repo:key.split('/')[0],id:key.split('/')[1],repoPath,title:required(title,'업무 제목',200),goal:required(goal,'약속한 결과'),scope:required(scope,'전체 대상 범위'),acceptance:required(acceptance,'완료 조건'),owner:required(owner,'책임 감독',160),board:String(board),status:'open',executions:[],mailRefs:[],progress:'',nextAction:'',turnOwner:'',result:'',revision:1,at:new Date().toISOString(),by,note:'업무 등록',action:'create'};
   appendStream(this.home,stream,record);return this.get(key);
  });
 }
 change(key,action,fields,{revision,by='사람',note}={}){
  return this.locked(()=>{
   const current=this.get(key),{history,...old}=current;
   if(Number(revision)!==current.revision)throw new Error('업무가 변경됨: 새로 읽고 다시 저장');
   note=required(note,'변경 이유');
   const next={...old,executions:old.executions.map(x=>({...x})),mailRefs:[...old.mailRefs],revision:old.revision+1,at:new Date().toISOString(),by,note,action};
   if(['done','cancelled'].includes(old.status)&&action!=='reopen')throw new Error('종료한 업무입니다. 이유를 남기고 다시 열어주세요');
   if(action==='update'){
    for(const [field,value] of Object.entries(fields)){
     if(!['title','goal','scope','acceptance','owner','board','progress','nextAction','turnOwner','status'].includes(field)||typeof value!=='string'||value.length>12000)throw new Error('잘못된 업무 수정 항목');
     next[field]=value.trim();
    }
    if(Object.hasOwn(fields,'turnOwner')){next.turnAt=next.at;next.turnBy=by;}
    for(const field of ['title','goal','scope','acceptance','owner'])required(next[field],field,['title','owner'].includes(field)?200:12000);
    if(!['open','hold'].includes(next.status))throw new Error('최종 완료는 업무 완료 확인으로 기록하세요');
   }else if(action==='link'||action==='execute'){
    if(!Object.hasOwn(workPhases,fields.phase)||!/^([1-9]\d*)$/.test(String(fields.round))||Number(fields.round)>999)throw new Error('실행 단계와 라운드(1~999)를 확인하세요');
    const store=new CardStore(this.home),registered=this.list();
    let executionKey=fields.execution;
    if(action==='execute'){
     required(fields.title,'실행 제목',200);required(fields.body,'실행 지시');
     // 한 번 끝낸 실행 ID를 재사용하지 않는다. 발령은 기존 card/send 명령으로 한다.
     const card=store.create({repo:old.repo,id:`exec-${randomUUID()}`,repoPath:old.repoPath,title:fields.title,body:fields.body,by});executionKey=card.key;
    }else store.get(executionKey);
    const other=registered.find(w=>w.key!==key&&w.executions.some(x=>x.key===executionKey));
    if(other)throw new Error(`다른 업무에 연결된 실행: ${other.key}`);
    const link={key:executionKey,phase:fields.phase,round:Number(fields.round)};
    const index=next.executions.findIndex(x=>x.key===executionKey);
    if(index<0)next.executions.push(link);else next.executions[index]=link;
   }else if(action==='unlink'){
    if(!next.executions.some(x=>x.key===fields.execution))throw new Error('이 업무에 연결되지 않은 실행');
    next.executions=next.executions.filter(x=>x.key!==fields.execution);
   }else if(action==='mail'){
    const entries=readLedger(this.home);if(entries.some(x=>x.broken))throw new Error('원장 손상: 우편 연결 불가');
    const matches=entries.filter(x=>x.kind==='send'&&(x.mailId===fields.mail||x.digest===fields.mail));
    if(matches.length!==1)throw new Error('고유한 우편 ID 필요: 우편 없음 또는 같은 본문으로 여러 번 보냄');
    if(!next.mailRefs.includes(fields.mail))next.mailRefs.push(fields.mail);
   }else if(action==='complete'||action==='cancel'||action==='reopen'){
    if(!(isUserActor(by)||by===effectiveWorkOwner(current,readLedger(this.home))))throw new Error('책임 감독 또는 사용자가 업무의 최종 결과를 확인해야 합니다');
    if(action==='reopen'){
     if(!['done','cancelled'].includes(old.status))throw new Error('종료한 업무만 다시 열 수 있습니다');
     next.status='open';next.result='';next.turnOwner=old.owner;next.turnAt=next.at;next.turnBy=by;
    }else{
     const cards=new CardStore(this.home).list(),entries=readLedger(this.home);
     const center=buildCardCenter({cards,entries,tree:[],runtimeKnown:false});
     const unresolved=old.executions.filter(x=>{const card=center.cards.find(c=>c.key===x.key);return !card||card.ambiguous||!endedExecution(card);});
     if(unresolved.length)throw new Error(`끝나지 않은 실행 ${unresolved.length}건: 실행을 마치거나 취소한 뒤 업무 결과를 확인하세요`);
     next.result=required(fields.result,'최종 결과와 확인 근거');next.status=action==='complete'?'done':'cancelled';next.turnOwner='';
    }
   }else throw new Error('알 수 없는 업무 변경');
   appendStream(this.home,keyStream(key),next);return this.get(key);
  });
 }
}
