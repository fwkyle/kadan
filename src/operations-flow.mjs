import {workFollowup,elapsed} from './work-followup.mjs';
import {DecisionStore} from './decisions.mjs';
import {readLedgerState} from './ledger-domains.mjs';
import {classifyLedgerEntry} from './ledger.mjs';
import {taskIdentity} from './task-identity.mjs';
import {workEntries,effectiveCardRole} from './handover-state.mjs';
// 운영 흐름은 저장된 관계와 근거만 읽는다. 실행·업무·인수 상태를 쓰거나 추정하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import {storageMode,storageSnapshot,transaction,readStream} from './storage.mjs';
import {WorkStore} from './work-store.mjs';
import {workLetters} from './work-mail.mjs';
import {listPageSize} from './dashboard-inbox.mjs';
import {isMailTransfer} from './mail-routing.mjs';
import {Handover} from './handover.mjs';

const validKey=value=>typeof value==='string'&&/^[\p{L}\p{N}_-]+\/[\p{L}\p{N}_-]+$/u.test(value);
const failure=(message,status=503)=>Object.assign(new Error(message),{status});
const fields=(value,names)=>Object.fromEntries(names.map(name=>[name,value[name]??null]));
const ref=entry=>entry.ledgerRef;
const stamp=()=>new Date().toISOString();

// headsは現在値だけ。カード本文や他業務の変更履歴を読み込まない。
function heads(home,kind){
 let rows;
 if(storageMode(home)==='sqlite'){
  rows=transaction(home,db=>db.prepare('SELECT stream,seq,payload FROM heads WHERE stream GLOB ? ORDER BY stream').all(`${kind}/*/*/events.jsonl`).map(r=>({...r,value:JSON.parse(r.payload)})),{readOnly:true});
 }else{
  const root=path.join(home,kind);if(!fs.existsSync(root))return [];
  rows=fs.readdirSync(root,{withFileTypes:true}).filter(x=>x.isDirectory()&&!x.name.startsWith('.')).flatMap(repo=>
   fs.readdirSync(path.join(root,repo.name),{withFileTypes:true}).filter(x=>x.isDirectory()&&!x.name.startsWith('.')).map(item=>{
    const stream=`${kind}/${repo.name}/${item.name}/events.jsonl`,history=readStream(home,stream);
    return {stream,seq:history.length,value:history.at(-1)};
   }));
 }
 return rows.map(({stream,seq,value})=>{
  if(!value||!validKey(value.key)||stream!==`${kind}/${value.key}/events.jsonl`||value.revision!==seq)throw failure('현재 기록의 주소·버전을 확인할 수 없습니다.');
  return value;
 });
}

function eventReader(home,state=readLedgerState(home)){
 // 주소는 출처와 저장 순번을 함께 보존한다. 날짜나 조회 위치를 원장 주소로 쓰지 않는다.
 const rows=[...state.legacy.map((entry,i)=>({...entry,seq:i+1,ledgerRef:`ledger:legacy:${i+1}`})),
  ...state.ordered.filter(entry=>entry.kind!=='dispatch').map(entry=>({...entry,seq:state.legacy.length+entry._ledgerOrder,ledgerRef:`ledger:new:${entry._ledgerOrder}`}))];
 if(rows.some(entry=>entry.broken||!entry.kind))throw failure('원장 손상: 관련 기록을 확인할 수 없습니다.');
 return predicate=>rows.filter(predicate);
}

function workAt(home,key){
 if(!validKey(key))throw failure('업무 주소는 저장소/업무ID입니다.',400);
 const work=new WorkStore(home).get(key);
 if(!['open','hold','done','cancelled'].includes(work.status))throw failure('업무 상태를 확인할 수 없습니다.');
 return work;
}

function followupContext(home,snapshot={}){
 const context={cards:[],read:null,decisions:[],error:null};
 try{context.cards=snapshot.cards??heads(home,'cards');context.read=eventReader(home,snapshot.ledgerState);context.watchCalls=context.read(e=>e.kind==='watch-ai-call');context.decisions=snapshot.decisions??new DecisionStore(home).list();}
 catch{context.error='후속 근거 조회 실패: 실행·결정 기록을 확인하세요.';}
 return context;
}
function followupFor(home,work,executions,context,now=stamp()){
 let automatic=null,error=context.error,terminalAt=null;
 try{const rows=readStream(home,`automatic-review/${work.key}/events.jsonl`,{optional:true});automatic=rows.at(-1)||null;terminalAt=rows.find(e=>e.current?.key===automatic?.current?.key&&['pass','boundary','limit','exception'].includes(e.status))?.at||null;}
 catch{error='자동 왕복 기록 조회 실패';}
 const decisions=context.decisions.filter(d=>work.executions.some(c=>c.key===d.card));
 const followup=workFollowup(work,executions,{automatic,decisions,error});
 const identity=taskIdentity(context.cards||[]),keys=new Set(work.executions.map(x=>x.key));
 const linkedWatchCalls=context.watchCalls?context.watchCalls.filter(e=>e.taskId&&keys.has(identity.resolve(e.taskId,e.executionKey).key)).length:null;
 const history=work.history||[],opened=history.findLast(h=>['create','reopen'].includes(h.action));
 const ended=history.findLast(h=>['complete','cancel'].includes(h.action));
 const terminal=['done','cancelled'].includes(work.status);
 const cycles=Math.max(0,...work.executions.filter(c=>['implementation','fix','review'].includes(c.phase)).map(c=>Number(c.round)||0));
 return {followup,decisions,automatic:automatic?fields(automatic,['status','terminal','round','at','reason','notification']):null,
  timing:{openedAt:opened?.at||null,closedAt:terminal?ended?.at||null:null,elapsedMs:elapsed(opened?.at,terminal?ended?.at:now),
   pending:!terminal,cycles,linkedWatchCalls,watchCost:null,completionConfirmationMs:null,actualWorkMs:null,
   supervisorFollowupMs:automatic&&['pass','boundary','limit','exception'].includes(automatic.status)?elapsed(terminalAt,history.find(h=>Date.parse(h.at)>Date.parse(terminalAt)&&['update','complete','cancel'].includes(h.action)&&h.by===work.owner)?.at):null}};
}

// 목록도 본문을 열지 않고 같은 실행·결정 기록을 한 번만 읽는다.
export function operationsFlowSummaries(home,works,snapshot={}){
 if(!works.length)return new Map();
 return storageSnapshot(home,()=>{
  const context=followupContext(home,snapshot),now=stamp();
  return new Map(works.map(work=>{
   if(!work.history)work={...work,history:readStream(home,`works/${work.key}/events.jsonl`)};
   let records=null;
   if(context.read){
    const keys=new Set(work.executions.map(x=>x.key)),ids=new Set(context.cards.filter(c=>keys.has(c.key)).map(c=>c.id));
    records={events:context.read(e=>['send','done'].includes(e.kind)&&(!e.workKey||e.workKey===work.key)&&(keys.has(e.executionKey)||keys.has(e.taskId)||ids.has(e.taskId))),handovers:context.read(e=>e.kind==='handover')};
   }
   const executions=work.executions.map(link=>executionModel(home,link,context.cards,records));
   return [work.key,followupFor(home,work,executions,context,now)];
  }));
 });
}
export function operationsFlowIndex(home){
 return storageSnapshot(home,()=>{
  const works=heads(home,'works'),summaries=operationsFlowSummaries(home,works);
  return {collectedAt:stamp(),works:works.map(w=>({...fields(w,['key','title','owner','status','at','revision']),followup:fields(summaries.get(w.key).followup,['state','label','owner','next','at'])})).sort((a,b)=>String(b.at).localeCompare(String(a.at)))};
 });
}

function linkedRecords(home,work,cardHeads,read=eventReader(home)){
 const keys=work.executions.map(x=>x.key);
 const identity=taskIdentity(cardHeads);
 const ids=[...keys,...cardHeads.filter(c=>keys.includes(c.key)&&identity.resolve(c.id).key===c.key).map(c=>c.id)];
 const eventIds=[...keys,...cardHeads.filter(c=>keys.includes(c.key)).map(c=>c.id)];
 const mailRefs=work.mailRefs;
 const seed=read(e=>['send','done'].includes(e.kind)&&(e.workKey===work.key||keys.includes(e.executionKey)||eventIds.includes(e.taskId)||mailRefs.includes(e.mailId)||mailRefs.includes(e.digest))||e.kind==='handover'&&e.taskIds?.some(id=>ids.includes(id)));
 // 우편 책임은 카드 연결이 없는 인계와 여러 차례의 후임 이전도 따른다.
 const candidates=new Map([...seed,...read(isMailTransfer)].map(e=>[e.seq,e]));
 const connected=e=>(!e.workKey||e.workKey===work.key)&&(!e.executionKey||keys.includes(e.executionKey));
 let letters=[];
 for(;;){
  const entries=[...candidates.values()].sort((a,b)=>a.seq-b.seq);
  const safeRefs=mailRefs.filter(id=>entries.filter(e=>e.kind==='send'&&(e.mailId===id||e.digest===id)).length===1);
  letters=workLetters({...work,mailRefs:safeRefs},entries,cardHeads).filter(connected);
  const refs=[...new Set(letters.flatMap(e=>[e.mailId,e.digest]).filter(Boolean))];
  const extra=refs.length?read(e=>e.kind==='send'&&(refs.includes(e.replyTo)||refs.includes(e.mailId)||refs.includes(e.digest))||['mail-read','mail-cancel'].includes(e.kind)&&refs.includes(e.mailId)):[];
  const before=candidates.size;for(const e of extra)candidates.set(e.seq,e);
  if(candidates.size===before)break;
 }
 const handoverIds=[...new Set(seed.filter(e=>e.kind==='handover').map(e=>e.handoverId))];
 const handovers=handoverIds.length?read(e=>e.kind==='handover'&&handoverIds.includes(e.handoverId)):[];
 return {watchCalls:read(e=>e.kind==='watch-ai-call'),events:seed.filter(e=>['send','done'].includes(e.kind)&&connected(e)),letters,handovers,ids};
}

function executionModel(home,link,cardHeads,records){
 const base={key:link.key,phase:link.phase,round:link.round,title:link.key,role:null,status:null,signals:[],reportState:'unknown'};
 try{
  if(!validKey(link.key))throw failure('실행 주소 확인 필요');
  const history=readStream(home,`cards/${link.key}/events.jsonl`);
  if(!history.length||history.some((c,i)=>c.key!==link.key||c.revision!==i+1))throw failure('실행 이력 확인 필요');
  const card=history.at(-1),identity=taskIdentity(cardHeads);
  const ambiguous=records?.events.some(e=>identity.resolve(e.taskId,e.executionKey).state==='ambiguous'&&e.taskId===card.id)??false;
  const runs=new Map(),sent=new Map(),seen=new Set();
  if(records&&!ambiguous)for(const e of workEntries([...records.events,...records.handovers].sort((a,b)=>a.seq-b.seq),identity).filter(e=>e.taskConnection?.state==='resolved'&&e.executionKey===card.key&&e.role)){
   if(e.kind==='send'&&classifyLedgerEntry(e).dispatch){runs.set(e.role,null);sent.set(e.role,e.t);}
   else if(e.kind==='done'&&!seen.has(e.role)){seen.add(e.role);runs.set(e.role,e);}
  }
  const signals=[...runs.values()].filter(Boolean).map(e=>({ref:ref(e),role:e.role,by:e.by||null,result:e.result,at:e.t||null}));
  let reportState=!records||ambiguous?'unknown':signals.some(e=>e.result==='failed')?'failed':signals.length&&[...runs.values()].every(e=>e?.result==='ok')?'ok':signals.length?'partial':'unreported';
  const sentAt=[...sent.values()].sort().at(-1)||null,completedAt=signals.map(e=>e.at).sort().at(-1)||null;
  if(signals.some(e=>sent.has(e.role)&&elapsed(sent.get(e.role),e.at)===null))reportState='unknown';
  const transition=history.filter((h,i)=>i&&h.status!==history[i-1].status).at(-1);
  if(reportState!=='unknown'&&transition&&['draft','ready','assigned'].includes(card.status)&&Date.parse(transition.at)>Math.max(Date.parse(sentAt)||0,Date.parse(completedAt)||0))reportState='unreported';
  const result=card.result,registered=history.find(h=>h.result),changedAfterResult=registered&&['scope','role','repoPath'].some(k=>registered[k]!==card[k]);
  const role=effectiveCardRole(card,records?[...records.events,...records.handovers].sort((a,b)=>a.seq-b.seq):[],identity);
  const sameRun=result&&sentAt&&elapsed(sentAt,result.at)!==null&&!changedAfterResult&&!(transition&&['draft','ready','assigned'].includes(card.status)&&Date.parse(transition.at)>Date.parse(result.at));
  const active=reportState==='unreported'&&card.status==='assigned'&&card.activityRole===role&&sent.has(role)&&elapsed(sent.get(role),card.activityAt)!==null;
  return {...base,...fields(card,['title','role','status','id','revision','at','nextAction','resolutionOwner','activityAt']),role,ambiguous,signals,reportState,sentAt,completedAt,
   quality:sameRun?result.outcome:null,resultAt:sameRun?result.at:null,
   running:active&&card.activity==='running',waiting:active&&card.activity==='waiting',
   timing:{dispatchToResultMs:sameRun?elapsed(sentAt,result.at):null,dispatchToDoneMs:reportState==='ok'||reportState==='failed'?elapsed(sentAt,completedAt):null,completionConfirmationMs:null}};
 }catch(error){return {...base,error:error.message};}
}

function handoverModels(home,events,executions,cards){
 const identity=taskIdentity(cards);
 return [...new Set(events.map(e=>e.handoverId))].map(id=>{
  const rows=events.filter(e=>e.handoverId===id),base=rows.find(e=>e.taskIds?.length)||rows[0],last=rows.at(-1),accepted=rows.find(e=>e.phase==='accepted');
  const value={id,from:base.from,to:base.to,phase:last.phase,at:last.t||null,ref:ref(last),accepted:Boolean(accepted),acceptedAt:accepted?.t||null,acceptedRef:accepted?ref(accepted):null,
   executionKeys:executions.filter(c=>!c.ambiguous&&base.taskIds?.some(id=>identity.resolve(id).key===c.key)).map(c=>c.key)};
  try{
   const current=new Handover({home}).status(id);
   if(current.id!==id||current.from!==base.from||current.to!==base.to||!Array.isArray(current.taskIds)||JSON.stringify([...current.taskIds].sort())!==JSON.stringify([...base.taskIds].sort()))throw failure('인계 파일과 연결 근거가 다릅니다.');
   const phases=['preparing','prepared','accepted','routes-pending','transferred','stopped','activation-pending','complete','aborted'];
   if(!phases.includes(current.phase))throw failure('인계 단계 확인 필요');
   value.phase=current.phase;value.fileRef=`handovers/${id}.json`;
   value.accepted||=['accepted','routes-pending','transferred','stopped','activation-pending','complete'].includes(current.phase)&&Boolean(current.receipt);
   if(current.error)value.error='인계 처리 오류가 기록되어 있습니다.';
  }catch{value.error='현재 인계 파일 미확인 · 마지막 원장 기록을 표시합니다.';}
  return value;
 });
}

const mailModel=e=>({ref:ref(e),mailId:e.mailId||null,at:e.t||null,by:e.by||null,to:e.role||null,currentSender:e.currentSender||e.by||null,currentRecipient:e.currentRecipient||e.role||null,executionKey:e.executionKey||null,replyTo:e.replyTo||null,kind:e.mailKind||null,read:e.read,expectReply:e.expectReply,replyStatus:e.replyStatus,replyFinal:e.replyFinal,replyFinalRejected:e.replyFinalRejected===true,completion:e.completion===true,notificationOnly:e.notificationOnly===true,systemGenerated:e.systemGenerated||null,completionTaskId:e.completionTaskId||null,hasBodyRef:Boolean(e.digest)});

export function operationsFlowDetail(home,key,{page=1}={}){
 return storageSnapshot(home,()=>{
  const work=workAt(home,key),errors=[];
  let cards=[],records=null;
  try{cards=heads(home,'cards');records=linkedRecords(home,work,cards);}catch{errors.push('연결 기록 조회 실패 · 실행 보고·우편·인수 상태는 모름입니다.');}
  const executions=work.executions.map(link=>executionModel(home,link,cards,records));
  const total=records?records.letters.length:null,pages=total===null?null:Math.max(1,Math.ceil(total/listPageSize));
  const selectedPage=Math.min(pages||1,Math.max(1,Number.parseInt(page,10)||1));
  const context={cards,watchCalls:records?.watchCalls,decisions:[],error:records?null:'연결 기록 조회 실패'};
  try{context.decisions=new DecisionStore(home).list();}catch{context.error='결정 기록 조회 실패';}
  const followup=followupFor(home,work,executions,context);
  return {collectedAt:stamp(),...followup,work:fields(work,['key','title','goal','scope','acceptance','owner','status','progress','nextAction','result','revision','at','by']),executions,
   handovers:records?handoverModels(home,records.handovers,executions,cards):null,
   mail:{total,page:selectedPage,pages,items:records?records.letters.slice((selectedPage-1)*listPageSize,selectedPage*listPageSize).map(mailModel):[]},errors,
   history:work.history.slice(-30).reverse().map(h=>fields(h,['revision','at','by','action','status','note']))};
 });
}

export function operationsFlowMail(home,key,recordRef){
 if(!/^ledger:(?:(?:legacy|new):)?[1-9]\d*$/.test(recordRef||''))throw failure('올바른 기록 주소가 필요합니다.',400);
 return storageSnapshot(home,()=>{
  const work=workAt(home,key),records=linkedRecords(home,work,heads(home,'cards'));
  const canonicalRef=/^ledger:[1-9]\d*$/.test(recordRef)?recordRef.replace('ledger:','ledger:legacy:'):recordRef;
  const letter=records.letters.find(e=>ref(e)===canonicalRef);
  if(!letter)throw failure('이 업무에 연결된 원문이 아닙니다.',404);
  if(!/^(?:[a-f0-9]{12}|[a-f0-9]{64})$/.test(letter.digest||''))throw failure('원문 참조를 확인할 수 없습니다.',404);
  const dir=path.join(home,'mail'),file=path.join(dir,`${letter.digest}.txt`);
  let fd;
  try{
   if(fs.lstatSync(dir).isSymbolicLink())throw failure('원문 저장 위치 확인 필요');
   fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
   if(!fs.fstatSync(fd).isFile())throw failure('원문 파일 확인 필요');
   const body=fs.readFileSync(fd,'utf8');
   return {collectedAt:stamp(),workKey:key,...mailModel(letter),body};
  }catch(error){throw failure(error.code==='ENOENT'?'원문 파일이 없습니다.':'원문을 읽을 수 없습니다.',error.code==='ENOENT'?404:503);}
  finally{if(fd!==undefined)fs.closeSync(fd);}
 });
}

export function handleOperationsFlow(home,request,response,url,cache={}){
 if(!['/api/operations-flow','/api/operations-flow/mail'].includes(url.pathname))return false;
 const type='application/json; charset=utf-8',canCache=url.pathname==='/api/operations-flow';
 const send=(status,value)=>{const body=JSON.stringify(value);if(status===200&&canCache)cache.remember?.(body,type);response.writeHead(status,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','x-kadan-cache':'miss'});response.end(body);};
 if(request.method!=='GET'){send(405,{error:'조회 전용입니다.'});return true;}
 if(request.headers.origin&&request.headers.origin!==`http://${request.headers.host}`||request.headers['sec-fetch-site']==='cross-site'){send(403,{error:'같은 대시보드에서만 조회할 수 있습니다.'});return true;}
 if(canCache){const hit=cache.cached?.();if(hit){response.writeHead(200,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','x-kadan-cache':'hit'});response.end(hit.body);return true;}}
 try{
  const key=url.searchParams.get('work');
  const value=url.pathname.endsWith('/mail')?operationsFlowMail(home,key,url.searchParams.get('ref')):key?operationsFlowDetail(home,key,{page:url.searchParams.get('page')}):operationsFlowIndex(home);
  send(200,value);
 }catch(error){send(error.status||503,{error:error.status?error.message:'기록을 읽을 수 없습니다. 상태는 모름입니다.',collectedAt:stamp()});}
 return true;
}
