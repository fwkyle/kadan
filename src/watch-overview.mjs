import {taskIdentity} from './task-identity.mjs';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {parseHierarchy,hierarchyRecipient,hierarchyRoute} from './hierarchy.mjs';
import {buildWatchScope,buildSupervisorScope} from './watch-scope.mjs';
import {watchAILabel} from './watch-report.mjs';
import {cycleStatus,watchVerdict} from './watch-cycle.mjs';
import {watchRouteNameWarnings} from './watch-profile.mjs';

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
export function readWatchProcesses(spawn=spawnSync,name='kadan-watch'){
 const result=spawn('ps',['-Ao','pid=,lstart=,command='],{encoding:'utf8',env:{...process.env,LC_ALL:'C',TZ:'UTC'}});
 if(result.status!==0||typeof result.stdout!=='string')throw new Error('프로세스 목록 조회 실패');
 const processes=[];
 for(const line of result.stdout.split('\n')){
  const m=line.trim().match(/^(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/);
  if(m&&m[3]===name){const started=Date.parse(m[2]+' UTC');processes.push({pid:Number(m[1]),startedAt:Number.isFinite(started)?new Date(started).toISOString():null});}
 }
 return processes;
}
// 원장 색인. Why: 판마다 원장 사건 배열 전체를 세 번씩 걸러 내 비용이 판 수 × 사건 수였다(판 63개 × 11.7만 건).
// 원장을 한 번만 훑어 이 파일이 쓰는 사건만 역할별로 묶어 두고, 판마다 그 묶음만 본다.
// 담는 것은 원장에서 뽑은 값뿐이다. 프로세스·관계 파일·살아 있는 역할·시각에 달린 값은 조회 때마다 계산한다.
const DAY_MS=24*60*60_000,RECENT_ALERTS=3;
const AI_SOURCES=['worker','supervisor-health'],AI_COUNTS=['requests','reported','timeouts','failed','offline'];
const AI_CALL_COUNT=new Map([['reported',1],['timeout',2],['call-failed',3],['report-missing',3],
 ['report-incomplete',3],['report-error',3],['network',4],['slept',4]]);
function buildLedgerIndex(entries){
 const index={entries,length:entries.length,broken:false,cycles:[],hierarchyLoaded:[],
  activity:new Map(),lastChecked:new Map(),alerts:new Map()};
 const addAlert=(name,seq,entry)=>{
  let recent=index.alerts.get(name);
  if(!recent)index.alerts.set(name,recent=[]);
  recent.push({seq,entry});
  if(recent.length>RECENT_ALERTS)recent.shift(); // 이름마다 마지막 몇 개만 있으면 판의 마지막 몇 개를 고를 수 있다.
 };
 for(let seq=0;seq<entries.length;seq++){
  const e=entries[seq];
  if(e?.broken){index.broken=true;break;} // 깨진 원장은 색인을 쓰지 않는다(모름).
  switch(e?.kind){
   case 'watch-cycle':index.cycles.push(e);break;
   case 'hierarchy-loaded':index.hierarchyLoaded.push(e);break;
   case 'alert':
    addAlert(e.role,seq,e);
    if(e.recipient!==e.role)addAlert(e.recipient,seq,e);
    break;
   case 'watch-ai-report': // 원장 순서로 마지막 접수 보고의 시각. 시각이 없으면 앞 보고로 내려가지 않는다.
    if(e.source==='supervisor-health'&&e.accepted)index.lastChecked.set(e.role,e.t);
    break;
   case 'watch-ai-request':case 'watch-ai-call':{
    const group=e.source==='supervisor-health'?1:e.source==='stall'||e.source==='progress'?0:-1;
    const count=e.kind==='watch-ai-request'?0:AI_CALL_COUNT.get(e.reason);
    const time=Date.parse(e.t);
    if(group<0||count===undefined||Number.isNaN(time))break;
    // 원장 순서는 시각 순서가 아니다. 시각을 담아 두고 24시간 창은 조회 때 거른다.
    let calls=index.activity.get(e.role);
    if(!calls)index.activity.set(e.role,calls={times:[],slots:[]});
    calls.times.push(time);calls.slots.push(group*AI_COUNTS.length+count);
    break;
   }
  }
 }
 return index;
}
// 색인은 한 세대만 든다. 원장 읽기는 사건을 고치지 않고 버전마다 새 배열을 주므로 같은 배열·같은 길이면 같은 원장이다.
let ledgerIndex=null,ledgerIndexBuilds=0;
function ledgerIndexFor(entries){
 if(ledgerIndex?.entries!==entries||ledgerIndex.length!==entries.length){
  ledgerIndex=buildLedgerIndex(entries);ledgerIndexBuilds++;
 }
 return ledgerIndex;
}
// 시험·진단용: 색인을 만든 횟수(= 원장을 훑은 횟수)와 지금 색인의 사건 수.
export function watchLedgerIndexInfo(){return {builds:ledgerIndexBuilds,length:ledgerIndex?.length??null};}
function aiActivityFor(index,names,now){
 const counts=new Array(AI_SOURCES.length*AI_COUNTS.length).fill(index?0:null);
 if(index)for(const name of names){
  const calls=index.activity.get(name);
  if(!calls)continue;
  for(let i=0;i<calls.times.length;i++){
   if(calls.times[i]>=now-DAY_MS&&calls.times[i]<=now)counts[calls.slots[i]]++;
  }
 }
 return AI_SOURCES.map((source,group)=>({source,label:watchAILabel(source),
  ...Object.fromEntries(AI_COUNTS.map((key,i)=>[key,counts[group*AI_COUNTS.length+i]]))}));
}
function recentAlertsFor(index,names){
 const picked=new Map(); // 원장 순번 → 사건. 역할과 수신자가 둘 다 이 판이어도 한 번만 든다.
 for(const name of names)for(const {seq,entry} of index.alerts.get(name)??[])picked.set(seq,entry);
 return [...picked].sort((a,b)=>a[0]-b[0]).slice(-RECENT_ALERTS).map(([,e])=>({at:e.t,role:e.role??null,
  kind:e.alertKind,recipient:e.recipient,route:e.route??null,delivered:e.delivered??null,resolved:e.resolved===true}));
}
export function watchOverview({center,entries,works=[],processes,processError=null,readFile=file=>fs.readFileSync(file,'utf8'),now=Date.now(),profilePath=null}){
 const result={checkedAt:new Date(now).toISOString(),process:{state:processError?'unknown':processes.length===1?'running':processes.length?'duplicate':'absent',instances:processes,error:processError},configuration:{state:'unknown'},cycle:{state:'unknown',reason:'감시 주기 완료 기록 없음 — 프로세스 생존과 구분'},boards:[],profilePath};
 let parents=null;
 const worker=processes.length===1?processes[0]:null;
 const index=Array.isArray(entries)?ledgerIndexFor(entries):null;
 const ledgerKnown=!!index&&!index.broken;
 result.cycle=cycleStatus(ledgerKnown?index.cycles:null,worker,now);
 if(!ledgerKnown)result.configuration={state:'unknown',reason:'원장을 읽을 수 없습니다'};
 else if(!worker||processError)result.configuration={state:'unknown',reason:'단일 감시 프로세스를 확인할 수 없습니다'};
 else {
  const loaded=index.hierarchyLoaded.findLast(e=>Number(e.pid)===worker.pid);
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
   ...(supervisors.has(role)?{checkIntervalMinutes:60,lastCheckedAt:index.lastChecked.get(role)??null}: {})}));
  const missing=roles.filter(r=>r.registered===false).map(r=>r.role);
  const state=!ledgerKnown?'unknown':result.process.state==='absent'?'absent':result.process.state==='duplicate'?'duplicate':!scope?'unknown':!roles.length?'not-required':missing.length?'incomplete':'configured';
  result.boards.push({name:board.name,state,roles:orderWatchRoles(roles),missingRoles:missing,registeredRoles:scope?roles.filter(r=>r.registered).length:null,totalRoles:scope?roles.length:null,
   aiActivity:aiActivityFor(scope?index:null,names,now),
  recentAlerts:ledgerKnown?recentAlertsFor(index,names):null});
 }
 // 감시기가 쓰는 route/--super 이름이 살아 있는 세션인지(주기 기록의 설정 + 지금 살아 있는 역할). 모르면 경고하지 않는다.
 const cs=result.cycle?.settings;
 result.routeNames=worker&&center.runtimeKnown&&cs&&(cs.routes||cs.superRole)?watchRouteNameWarnings(cs.routes??{},cs.superRole??null,live):[];
 result.verdict=watchVerdict(result,now);
 return result;
}
export function attachWatchOverview(center,entries,options={}){
 let processes=[],processError=null;
 try{processes=(options.readProcesses??(()=>readWatchProcesses(spawnSync,options.watchName)))();}catch{processError='프로세스 목록을 읽을 수 없습니다';}
 const monitoring=watchOverview({center,entries,works:options.works,processes,processError,readFile:options.readFile,now:options.now,profilePath:options.profilePath??null});
 return {...center,monitoring,boards:center.boards.map(b=>({...b,monitoring:monitoring.boards.find(x=>x.name===b.name)}))};
}
