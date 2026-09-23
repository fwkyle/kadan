import {taskIdentity,taskConnectionError} from './task-identity.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {isUserActor} from './actors.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {storageMode,transaction,readStream,appendStream} from './storage.mjs';
import {WorkStore} from './work-store.mjs';
import {CardStore} from './card-store.mjs';
import {readLedger,appendLedger} from './ledger.mjs';
import {effectiveCardRole} from './handover-state.mjs';
import {checkFamilies,readSettings} from './runner-settings.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const workStamp=w=>hash(JSON.stringify([w.goal,w.scope,w.acceptance,w.owner,w.board,w.repoPath]));
const cardStamp=c=>hash(JSON.stringify([c.body,c.scope,c.repoPath]));
const terminal=['pass','exception','boundary','limit'];
const closed=['done','cancelled','superseded','archived'];
const actorOK=(by,owner)=>isUserActor(by)||by===owner;
const session=role=>`kadan-${role}`;
const processAlive=pid=>{if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};

// 이 스트림도 기존 SQLite events/heads를 사용한다. 외부 전달 예약은 반드시 먼저 커밋한다.
export class AutomaticReview {
 constructor({home,by='사람',floor,send,observeDone=()=>null,now=()=>Date.now()}){
  Object.assign(this,{home,by,floor,send,observeDone,now});
  this.works=new WorkStore(home);this.cards=new CardStore(home);
 }
 stream(key){this.cards.dir(key);return `automatic-review/${key}/events.jsonl`;}
 locked(fn){if(storageMode(this.home)!=='sqlite')throw new Error('자동 전달에는 기존 SQLite 저장소가 필요합니다');return transaction(this.home,fn);}
 get(key){const rows=readStream(this.home,this.stream(key),{optional:true});return rows.at(-1)||null;}
 save(s,patch){const next={...s,...patch,revision:(s.revision||0)+1,at:new Date(this.now()).toISOString(),by:this.by};appendStream(this.home,this.stream(s.key),next);return next;}
 entries(){const rows=readLedger(this.home);if(rows.some(x=>x.broken))throw new Error('원장 손상: 자동 전달 중단');return taskIdentity(this.cards.list()).project(rows);}
 identity(role){
  if(typeof role!=='string'||! /^[\p{L}\p{N}_-]+$/u.test(role))throw new Error('담당 역할 이름 필요');
  const rows=this.entries(),last=rows.filter(e=>e.role===role&&['start','stop'].includes(e.kind)).at(-1);
  const pid=last?.panePid??last?.rottiePid;
  if(last?.kind!=='start'||!pid||last.session!==session(role)||last.floor!==this.floor.name)throw new Error(`시작 기록 확인 불가: ${role}`);
  if(!this.floor.alive(session(role))||String(this.floor.pid(session(role)))!==String(pid))throw new Error(`PID 변경 또는 세션 없음: ${role}`);
  return {role,pid:String(pid),start:hash(JSON.stringify(last))};
 }
 reference(key){const c=this.cards.get(key);if(['draft','hold','cancelled','superseded','archived'].includes(c.status)||!c.scope)throw new Error(`원본 카드 사용 불가: ${key}`);return {key,path:c.path,stamp:cardStamp(c)};}
 configure(key,{revision,implementation,review,worker,reviewer,notify,deadline,nextBlock=false}){
  return this.locked(()=>{
   const w=this.works.get(key),old=this.get(key);
   if(!actorOK(this.by,w.owner))throw new Error('책임 감독이 자동 전달을 설정해야 합니다');
   if(Number(revision)!==w.revision||w.status!=='open'||!w.board)throw new Error('열린 업무·최신 revision·판이 필요합니다');
   if(old&&(!nextBlock||old.status!=='boundary'))throw new Error('기존 설정은 재시작으로 덮을 수 없습니다. 블록 경계에서만 다음 블록 설정');
   if(!old&&nextBlock)throw new Error('이전 블록 없음');
   const identities={worker:this.identity(worker),reviewer:this.identity(reviewer),notify:this.identity(notify||w.owner)};
   if(new Set(Object.values(identities).map(x=>x.role)).size!==3||identities.worker.pid===identities.reviewer.pid)throw new Error('작업자·독립검수자·감독은 서로 다른 세션이어야 합니다');
   // 실제로 띄운 모델의 계열이 같으면 자기 검수다. 모르는 계열끼리는 막지 않는다.
   const startedModel=role=>this.entries().filter(e=>e.kind==='start'&&e.role===role).at(-1)?.model;
   checkFamilies({worker:{model:startedModel(worker)},reviewer:{model:startedModel(reviewer)}},readSettings(this.home)?.families);
   if(old){
    if(workStamp(w)!==old.workStamp||JSON.stringify(w.executions)!==JSON.stringify(old.links))throw new Error('업무 범위 또는 실행 연결 변경');
    const history=readStream(this.home,this.stream(key));
    for(const past of history)for(const kind of ['worker','reviewer'])for(const previous of ['worker','reviewer']){
     if(identities[kind].start===past.identities[previous].start||identities[kind].pid===past.identities[previous].pid)throw new Error('다음 블록은 이전 두 세션을 모두 교대해야 합니다. 과거 블록 세션도 재사용하지 않습니다');
    }
    if(implementation!==old.references.implementation.key||review!==old.references.review.key||deadline!==undefined&&deadline!==old.deadline)throw new Error('다음 블록에서 원본·시한을 변경할 수 없습니다');
   }
   const references={implementation:this.reference(implementation),review:this.reference(review)};
   if(old&&JSON.stringify(references)!==JSON.stringify(old.references))throw new Error('원본 범위 변경');
   const round=old?old.round+1:Math.max(0,...w.executions.filter(x=>['implementation','fix','review'].includes(x.phase)).map(x=>x.round))+1;
   if(round>18)throw new Error('업무 전체 18라운드 상한');
   const until=old?.deadline??deadline??null;
   if(until!==null&&(!Number.isFinite(Date.parse(until))||Date.parse(until)<=this.now()))throw new Error('유효한 기존 시한 필요');
   const s={key,revision:old?.revision||0,status:'ready',phase:old?'fix':'implementation',round,block:Math.floor((round-1)/3)+1,workStamp:workStamp(w),links:w.executions,references,identities,deadline:until,current:null,report:null,previous:old?.report||null,notification:null,reason:'',claim:null};
   this.guard(s);
   return this.save(s,{});
  });
 }
 guard(s,{target=null,allowCurrentDone=false}={}){
  const w=this.works.get(s.key);
  if(w.status!=='open')throw new Error(`업무 ${w.status}: 자동 전달 중단`);
  if(workStamp(w)!==s.workStamp||JSON.stringify(w.executions)!==JSON.stringify(s.links))throw new Error('업무 범위·담당·실행 연결 변경');
  if(w.turnOwner&&!Object.values(s.identities).some(x=>x.role===w.turnOwner))throw new Error('다른 담당이 업무 차례를 점유');
  if(s.deadline&&this.now()>=Date.parse(s.deadline))throw new Error('기존 시한 도달');
  if(s.previous?.sha256&&hash(fs.readFileSync(s.previous.resultFile))!==s.previous.sha256)throw new Error('확인 뒤 결과 파일 변경');
  for(const ref of Object.values(s.references))if(JSON.stringify(this.reference(ref.key))!==JSON.stringify(ref))throw new Error('원본 카드 범위 변경');
  const entries=this.entries(),cards=this.cards.list(),identity=taskIdentity(cards);
  for(const kind of ['worker','reviewer']){
   const expected=s.identities[kind];
   if(JSON.stringify(this.identity(expected.role))!==JSON.stringify(expected))throw new Error(`시작 세대 변경: ${expected.role}`);
  }
  if(s.current){
   const c=this.cards.get(s.current.key),role=effectiveCardRole(c,entries,identity);
   if(c.role!==s.current.role||role!==s.current.role||cardStamp(c)!==s.current.stamp||!['assigned',...(allowCurrentDone?['done']:[])].includes(c.status))throw new Error('현재 실행 보류·취소·범위·담당 변경');
   if(c.turnOwner&&c.turnOwner!==s.current.role)throw new Error('다른 담당이 실행 차례를 점유');
   if(target)this.cards.checkSend(c.key,target);
  }
  const ownedRoles=[s.identities.worker.role,s.identities.reviewer.role];
  for(const c of cards){
   if(c.key===s.current?.key||closed.includes(c.status))continue;
   const role=effectiveCardRole(c,entries,identity);
   if(!ownedRoles.includes(role))continue;
   if(c.status==='assigned'&&!entries.some(e=>e.kind==='done'&&!taskConnectionError(e)&&e.role===role&&e.executionKey===c.key))throw new Error(`다른 실행이 담당을 점유: ${c.key}`);
  }
  for(const e of entries.filter(e=>e.kind==='send'&&e.taskId&&ownedRoles.includes(e.role)&&e.transport!=='mailbox')){
   if(taskConnectionError(e))throw new Error(`기록 연결 실패: ${e.rawTaskId}`);
   if(e.executionKey===s.current?.key)continue;
   const c=this.cards.findTask(e.executionKey||e.taskId);
   if(!entries.some(d=>d.kind==='done'&&!taskConnectionError(d)&&d.role===e.role&&d.taskId===e.taskId)&&!(c.length===1&&closed.includes(c[0].status)))throw new Error(`다른 미완료 발령이 담당을 점유: ${e.taskId}`);
  }
  return w;
 }
 report(key,{execution,outcome,resultFile}){
  return this.locked(()=>{
   const s=this.get(key);if(!s||!s.current||s.current.key!==execution||!['sending','waiting'].includes(s.status))throw new Error('현재 자동 실행의 보고가 아닙니다');
   if(this.by!==s.current.role)throw new Error('배정된 담당만 결과를 보고할 수 있습니다');
   const allowed=s.phase==='review'?['pass','changes','exception']:['implemented','exception'];
   if(!allowed.includes(outcome))throw new Error('실행 완료와 품질 판정을 구분해 명시하세요');
   resultFile=this.cards.resultLocation(execution,resultFile);
   const report={execution,outcome,resultFile};
   if(s.report){if(['execution','outcome','resultFile'].some(k=>report[k]!==s.report[k]))return this.stop(s,'기존 보고와 충돌: 감독 확인 필요');return s;}
   return this.save(s,{report});
  });
 }
 stop(s,reason,status='exception'){return this.save(s,{status,reason,claim:null});}
 prepare(s){
  const w=this.guard(s,{allowCurrentDone:true});
  const ref=s.references[s.phase==='review'?'review':'implementation'];
  const role=s.identities[s.phase==='review'?'reviewer':'worker'].role;
  const body=[`# 자동 전달 — ${s.phase} / ${s.round}라운드`,`원본 지시: ${ref.path}`,`업무 정본: kadan work show ${s.key}`,
   `원본의 범위·검증·시한을 그대로 따른다. 원본과 최신 card show를 읽어라. 검수자는 수정하지 않는다.`,
   s.previous?`직전 실행 결과 원문: ${s.previous.resultFile} (SHA256 ${s.previous.sha256})`:'',
   `이번 실행의 card show에 표시된 resultPath에 보고서, evidenceDir에 검증 자료를 쓴다. 원본 카드나 직전 실행의 결과 경로를 재사용하지 않는다. 제품 코드·설계·사용 설명서는 대상 레포에 둔다.`,
   `이번 자동 경로에서는 정상 중간 완료 편지를 감독에게 보내지 않는다. 결과 파일을 완성하고 현재 실행ID로 kadan work auto-report ${s.key} --execution <저장소/현재실행ID> --outcome ${s.phase==='review'?'pass|changes|exception':'implemented|exception'}를 실행한다. result-file 생략 시 현재 실행의 resultPath를 사용한다.`,
   '구현 자체 실패·범위 밖 수정·판정 불명확은 exception이다. changes는 승인 범위 안의 품질 수정에만 쓴다.',
   '이어 자기 화면 마지막 줄에 완료 마커를 출력한다. 형식: KADAN:DONE <카드id> <ok 또는 failed>. 새 실행ID는 이 중앙 카드의 ID다.'].filter(Boolean).join('\n\n');
  const next=this.works.change(s.key,'execute',{title:`자동 ${s.phase} ${s.round}라운드`,body,phase:s.phase,round:s.round},{revision:w.revision,by:this.by,note:'명시 설정한 구현·검수 자동 전달'});
  const link=next.executions.at(-1),created=this.cards.get(link.key);
  const card=this.cards.update(link.key,{status:'assigned',scope:w.scope,board:w.board,role,rallyId:w.id,rallyTitle:w.title.slice(0,160),rallyRound:String(s.round),rallyStep:s.phase},{revision:created.revision,by:this.by,note:'기존 원본 기준과 자동 전달 설정으로 배정'});
  appendLedger({kind:'plan',board:w.board,...taskIdentity(this.cards.list()).write(card.key),by:this.by},this.home);
  return this.save(s,{status:'ready',links:next.executions,report:null,current:{key:card.key,role,stamp:cardStamp(card),path:card.path},claim:null});
 }
 step(key){
  const action=this.locked(()=>{
   let s=this.get(key);if(!s)throw new Error('자동 전달이 설정되지 않은 업무');
   if(!actorOK(this.by,this.works.get(key).owner))throw new Error('책임 감독이 전달 프로그램을 실행해야 합니다');
   if(['sending','notifying'].includes(s.status)){
    if(processAlive(s.claimOwner))return {state:s}; // 살아 있는 전달과 경쟁하지 않는다.
    if(s.status==='notifying')return {state:this.save(s,{status:s.terminal,notification:{status:'unknown',error:'통지 예약 뒤 프로그램 종료: 재전송 금지'},claim:null})};
    return this.reserveNotice(this.stop(s,'전송 예약 뒤 프로그램 종료: 전달 여부 불명확, 재전송 금지'));
   }
   if(terminal.includes(s.status))return this.reserveNotice(s);
   try{
    this.guard(s,{allowCurrentDone:s.status==='waiting'});
    if(s.status==='waiting'){
     const entries=this.entries(),address=taskIdentity(this.cards.list()).write(s.current.key),id=address.taskId;
     const sendIndex=entries.findIndex(e=>e.kind==='send'&&!taskConnectionError(e)&&e.taskId===id&&e.role===s.current.role);
     if(sendIndex<0)throw new Error('현재 실행 전달 영수증 없음');
     let done=entries.slice(sendIndex+1).find(e=>e.kind==='done'&&!taskConnectionError(e)&&e.taskId===id&&e.role===s.current.role);
     if(!done){
      const result=this.observeDone(s);
      if(result){if(!['ok','failed'].includes(result))throw new Error('완료 마커 판정 불명확');appendLedger({kind:'done',role:s.current.role,...address,result,by:this.by},this.home);done={result};}
     }
     if(!done)return {state:s};
     if(done.result!=='ok')return this.reserveNotice(this.stop(s,'실행 자체 실패 또는 완료 판정 불명확'));
     if(!s.report)return {state:s};
     if(!fs.existsSync(s.report.resultFile))return {state:s};
     if(!fs.statSync(s.report.resultFile).isFile())throw new Error('결과 경로가 파일이 아님');
     const bytes=fs.readFileSync(s.report.resultFile);if(!bytes.length)return {state:s};
     const report={...s.report};
     let c=this.cards.get(s.current.key);
     c=this.cards.report(c.key,{revision:c.revision,resultFile:report.resultFile,outcome:report.outcome,by:s.current.role});
     report.sha256=c.result.sha256;
     if(c.status==='assigned')this.cards.update(c.key,{status:'done'},{revision:c.revision,by:this.by,note:`현재 실행 완료 근거와 결과 파일 확인: ${report.resultFile}`});
     s=this.save(s,{report,previous:report});
     if(report.outcome==='exception')return this.reserveNotice(this.stop(s,'담당이 예외로 보고함'));
     if(s.phase==='review'){
      if(report.outcome==='pass')return this.reserveNotice(this.stop(s,'품질 PASS 보고: 감독의 최종 판단 대기','pass'));
      if(s.round>=18)return this.reserveNotice(this.stop(s,'업무 전체 18라운드 상한','limit'));
      if(s.round%3===0)return this.reserveNotice(this.stop(s,'3번째 검수도 수정 필요: 새 두 세션으로 다음 블록 판단','boundary'));
      s=this.save(s,{phase:'fix',round:s.round+1,status:'ready'});
     }else s=this.save(s,{phase:'review',status:'ready'});
     s=this.prepare(s);
    }else if(!s.current)s=this.prepare(s);
    this.guard(s,{target:s.current.role});
    const baseline=this.floor.read(session(s.current.role));
    if(typeof baseline!=='string'&&typeof baseline?.text!=='string')throw new Error('발령 전 화면 읽기 실패');
    s=this.save(s,{status:'sending',claim:randomUUID(),claimOwner:process.pid,baseline:typeof baseline==='string'?baseline:baseline.text});
    return {state:s,kind:'execution'};
   }catch(e){return this.reserveNotice(this.stop(s,e.message));}
  });
  if(!action.kind)return action.state;
  const delivered=this.deliver(action);
  if(terminal.includes(delivered.status)&&!delivered.notification){
   const notice=this.locked(()=>this.reserveNotice(this.get(key)));
   return notice.kind?this.deliver(notice):notice.state;
  }
  return delivered;
 }
 reserveNotice(s){
  if(s.notification)return {state:s};
  const state=this.save(s,{status:'notifying',terminal:s.status,claim:randomUUID(),claimOwner:process.pid,notification:{status:'reserved'}});
  return {state,kind:'notice'};
 }
 deliver({state:s,kind}){
  let receipt,error;
  try{
   // DB 예약 커밋 뒤 마지막 배정·범위 검사. 전송 바로 앞의 PID 검사는 guardedSend가 다시 한다.
   this.locked(()=>{
    const fresh=this.get(s.key);if(fresh.claim!==s.claim||fresh.status!==s.status)throw new Error('전달 예약 변경');
    if(kind==='execution')this.guard(fresh,{target:s.current.role});
   });
   const identity=s.identities[kind==='execution'?(s.phase==='review'?'reviewer':'worker'):'notify'];
   if(JSON.stringify(this.identity(identity.role))!==JSON.stringify(identity))throw new Error('통지 또는 발령 수신 세대 변경');
   receipt=this.send({role:identity.role,pid:identity.pid,taskId:kind==='execution'?taskIdentity(this.cards.list()).taskIdFor(this.cards.get(s.current.key)):undefined,
    ...(kind==='execution'?{roleProfile:s.phase==='review'?'reviewer':'worker'}:{}),
    executionKey:s.current?.key,workKey:s.key,
    transmit:fn=>this.locked(()=>{
     const fresh=this.get(s.key);if(fresh.claim!==s.claim||fresh.status!==s.status)throw new Error('전달 예약 변경');
     if(kind==='execution')this.guard(fresh,{target:s.current.role});
     if(JSON.stringify(this.identity(identity.role))!==JSON.stringify(identity))throw new Error('전송 직전 PID 변경');
     return fn();
    }),
    message:kind==='execution'?`중앙 카드 ${s.current.path} 및 최신 card show를 읽고 수행하라. 카드 id는 ${s.current.key.split('/')[1]}이다.`:
     `자동 전달 결과: ${s.key} / ${s.terminal} / ${s.reason} / 실행 ${s.current?.key||'없음'} / 결과 ${s.report?.resultFile||'없음'}. kadan work auto-show ${s.key} 확인. 다음 행동(next action): 결과 근거와 미확정 done·빠진 검수/후속을 확인하고, kadan work show ${s.key}의 최신 revision·owner·전체 완료 조건을 대조하라. 전체 조건 충족 시 책임 owner만 work complete하며 PASS만으로 자동 마감하지 않는다.`});
  }catch(e){error={message:e.message,delivery:e.delivery||'unknown'};}
  return this.locked(()=>{
   const current=this.get(s.key);if(current.claim!==s.claim)return current;
   if(kind==='notice')return this.save(current,{status:s.terminal,claim:null,notification:{status:error?'unknown':'sent',...(error?{error}:{receipt})}});
   if(error)return this.stop(current,`전달 ${error.delivery}: ${error.message}`);
   return this.save(current,{status:'waiting',claim:null,receipt});
  });
 }
}
