import {taskIdentity} from './task-identity.mjs';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {parseHierarchy,hierarchyRecipient,hierarchyRoute} from './hierarchy.mjs';
import {buildWatchScope,buildSupervisorScope} from './watch-scope.mjs';
import {watchAILabel} from './watch-report.mjs';
import {cycleStatus,watchVerdict} from './watch-cycle.mjs';

// 이름의 접두사가 아니라 실제 직속 관계를 따라 부모 다음에 소속 역할을 놓는다.
export function orderWatchRoles(roles){
 const names=new Set(roles.map(r=>r.role)),children=new Map(),visited=new Set(),ordered=[];
 const byName=(a,b)=>a.role.localeCompare(b.role,'ko',{numeric:true});
 for(const r of roles){if(!children.has(r.parent))children.set(r.parent,[]);children.get(r.parent).push(r);}
 const visit=(r,depth)=>{if(visited.has(r.role))return;visited.add(r.role);ordered.push({...r,hierarchyDepth:depth});for(const child of (children.get(r.role)||[]).slice().sort(byName))visit(child,depth+1);};
 const roots=roles.filter(r=>!names.has(r.parent)).sort((a,b)=>Number(!a.registered)-Number(!b.registered)||byName(a,b));
 for(const r of roots)visit(r,0);
 for(const r of roles.slice().sort(byName))visit(r,0);
 return ordered;
}
export function readWatchProcesses(spawn=spawnSync){
 const result=spawn('ps',['-Ao','pid=,lstart=,command='],{encoding:'utf8',env:{...process.env,LC_ALL:'C',TZ:'UTC'}});
 if(result.status!==0||typeof result.stdout!=='string')throw new Error('프로세스 목록 조회 실패');
 const processes=[];
 for(const line of result.stdout.split('\n')){
  const m=line.trim().match(/^(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+kadan-watch\s*$/);
  if(m){const started=Date.parse(m[2]+' UTC');processes.push({pid:Number(m[1]),startedAt:Number.isFinite(started)?new Date(started).toISOString():null});}
 }
 return processes;
}
export function watchOverview({center,entries,works=[],processes,processError=null,readFile=file=>fs.readFileSync(file,'utf8'),now=Date.now(),profilePath=null}){
 const result={checkedAt:new Date(now).toISOString(),process:{state:processError?'unknown':processes.length===1?'running':processes.length?'duplicate':'absent',instances:processes,error:processError},configuration:{state:'unknown'},cycle:{state:'unknown',reason:'감시 주기 완료 기록 없음 — 프로세스 생존과 구분'},boards:[],profilePath};
 let parents=null;
 const worker=processes.length===1?processes[0]:null;
 const ledgerKnown=Array.isArray(entries)&&!entries.some(e=>e?.broken);
 result.cycle=cycleStatus(ledgerKnown?entries:null,worker,now);
 if(!ledgerKnown)result.configuration={state:'unknown',reason:'원장을 읽을 수 없습니다'};
 else if(!worker||processError)result.configuration={state:'unknown',reason:'단일 감시 프로세스를 확인할 수 없습니다'};
 else {
  const loaded=entries.filter(e=>e.kind==='hierarchy-loaded'&&Number(e.pid)===worker.pid).at(-1);
  const time=Date.parse(loaded?.t),started=Date.parse(worker.startedAt);
  if(!loaded)result.configuration={state:'missing',reason:'현재 감시기와 연결된 직속 관계 반영 기록 없음'};
  else if(!Number.isFinite(time)||!Number.isFinite(started)||time<started||time>now)result.configuration={state:'unknown',reason:'감시기 시작 시각과 관계 반영 기록 불일치'};
  else {
   result.configuration={state:'unknown',path:loaded.path,loadedAt:loaded.t,loadedHash:loaded.hash};
   try{
    const text=readFile(loaded.path),hash=createHash('sha256').update(text).digest('hex');const parsed=parseHierarchy(JSON.parse(text));
    result.configuration.currentHash=hash;
    if(hash!==loaded.hash)Object.assign(result.configuration,{state:'changed',reason:'관계 파일 변경 후 현재 감시기의 반영 확인 전'});
    else {parents=parsed;result.configuration.state='matched';result.configuration.reason='현재 파일과 감시기가 읽은 지문 일치';}
   }catch{Object.assign(result.configuration,{state:'unknown',reason:'직속 관계 파일을 읽거나 검증할 수 없습니다'});}
  }
 }
 let scope=null,supervisorScope=null;
 if(ledgerKnown&&parents){
  try{const cards=center.cards??center.boards.flatMap(b=>b.cards);scope=buildWatchScope(cards,entries,parents,works);supervisorScope=buildSupervisorScope(cards,entries,parents,works);}
  catch{Object.assign(result.configuration,{state:'unknown',reason:'감시 대상 카드를 읽거나 검증할 수 없습니다'});}
 }
 const live=new Set((center.roles??[]).filter(r=>r.life?.state==='alive'&&r.life?.pidState==='match').map(r=>'kadan-'+r.role));
 const aiActivity=names=>['worker','supervisor-health'].map(source=>{
  const events=ledgerKnown?entries.filter(e=>names.has(e.role)&&Date.parse(e.t)>=now-24*60*60_000&&Date.parse(e.t)<=now&&
    (source==='supervisor-health'?e.source===source:['stall','progress'].includes(e.source))):null;
  const count=fn=>events?events.filter(fn).length:null;
  return {source,label:watchAILabel(source),requests:count(e=>e.kind==='watch-ai-request'),
   reported:count(e=>e.kind==='watch-ai-call'&&e.reason==='reported'),timeouts:count(e=>e.kind==='watch-ai-call'&&e.reason==='timeout'),
   failed:count(e=>e.kind==='watch-ai-call'&&['call-failed','report-missing','report-incomplete','report-error'].includes(e.reason))};
 });
 const cardList=center.cards??center.boards.flatMap(b=>b.cards);
 const identity=taskIdentity(Array.isArray(cardList)?cardList:[]);
 for(const board of center.boards){
  const ids=new Set(board.cards.map(c=>identity.taskIdFor(c))),keys=new Set(board.cards.map(c=>c.key));
  const names=new Set(scope?.entries.filter(e=>ids.has(e.taskId)).map(e=>e.role)??[]);
  const supervisors=new Set(supervisorScope?.entries.filter(e=>ids.has(e.taskId)||works.some(w=>w.key===e.workKey&&(w.board===board.name||w.executions.some(x=>keys.has(x.key))))).map(e=>e.role)??[]);
  for(const role of supervisors)names.add(role);
  const roles=[...names].map(role=>({role,parent:parents?.get(role)??null,registered:parents?parents.has(role):null,
   recipient:parents?.has(role)&&center.runtimeKnown?hierarchyRecipient(role,parents,live):null,
   route:parents?.has(role)&&center.runtimeKnown?hierarchyRoute(role,parents,live):null,
   recipientKnown:!!(parents?.has(role)&&center.runtimeKnown),scope:supervisors.has(role)?'supervisor-health':'card',
   observer:watchAILabel(supervisors.has(role)?'supervisor-health':'worker'),
   ...(supervisors.has(role)?{checkIntervalMinutes:60,lastCheckedAt:entries.findLast(e=>e.kind==='watch-ai-report'&&e.role===role&&e.source==='supervisor-health'&&e.accepted)?.t??null}: {})}));
  const missing=roles.filter(r=>r.registered===false).map(r=>r.role);
  const state=!ledgerKnown?'unknown':result.process.state==='absent'?'absent':result.process.state==='duplicate'?'duplicate':!scope?'unknown':!roles.length?'not-required':missing.length?'incomplete':'configured';
  result.boards.push({name:board.name,state,roles:orderWatchRoles(roles),missingRoles:missing,registeredRoles:scope?roles.filter(r=>r.registered).length:null,totalRoles:scope?roles.length:null,
   aiActivity:scope?aiActivity(names):aiActivity(new Set()).map(a=>({...a,requests:null,reported:null,timeouts:null,failed:null})),
  recentAlerts:ledgerKnown?entries.filter(e=>e.kind==='alert'&&(names.has(e.role)||names.has(e.recipient))).slice(-3).map(e=>({at:e.t,role:e.role??null,kind:e.alertKind,recipient:e.recipient,route:e.route??null,delivered:e.delivered??null,resolved:e.resolved===true})):null});
 }
 result.verdict=watchVerdict(result,now);
 return result;
}
export function attachWatchOverview(center,entries,options={}){
 let processes=[],processError=null;
 try{processes=(options.readProcesses??readWatchProcesses)();}catch{processError='프로세스 목록을 읽을 수 없습니다';}
 const monitoring=watchOverview({center,entries,works:options.works,processes,processError,readFile:options.readFile,now:options.now,profilePath:options.profilePath??null});
 return {...center,monitoring,boards:center.boards.map(b=>({...b,monitoring:monitoring.boards.find(x=>x.name===b.name)}))};
}
