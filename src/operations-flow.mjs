import {taskIdentity} from './task-identity.mjs';
import {workEntries} from './handover-state.mjs';
// 운영 흐름은 저장된 관계와 근거만 읽는다. 실행·업무·인수 상태를 쓰거나 추정하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import {storageMode,storageSnapshot,transaction,readStream} from './storage.mjs';
import {WorkStore} from './work-store.mjs';
import {workLetters} from './work-mail.mjs';
import {Handover} from './handover.mjs';

const validKey=value=>typeof value==='string'&&/^[\p{L}\p{N}_-]+\/[\p{L}\p{N}_-]+$/u.test(value);
const failure=(message,status=503)=>Object.assign(new Error(message),{status});
const fields=(value,names)=>Object.fromEntries(names.map(name=>[name,value[name]??null]));
const ref=seq=>`ledger:${seq}`;
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

function eventReader(home){
 let legacy;
 return (where,args,predicate)=>{
  if(storageMode(home)==='sqlite')return transaction(home,db=>db.prepare(`SELECT seq,payload FROM events WHERE stream='ledger.jsonl' AND (${where}) ORDER BY seq`).all(...args).map(r=>({...JSON.parse(r.payload),seq:r.seq})),{readOnly:true});
  legacy??=readStream(home,'ledger.jsonl',{optional:true}).map((e,i)=>({...e,seq:i+1}));
  if(legacy.some(e=>e.broken||!e.kind))throw failure('원장 손상: 관련 기록을 확인할 수 없습니다.');
  return legacy.filter(predicate);
 };
}

function workAt(home,key){
 if(!validKey(key))throw failure('업무 주소는 저장소/업무ID입니다.',400);
 const work=new WorkStore(home).get(key);
 if(!['open','hold','done','cancelled'].includes(work.status))throw failure('업무 상태를 확인할 수 없습니다.');
 return work;
}

export function operationsFlowIndex(home){
 return storageSnapshot(home,()=>({collectedAt:stamp(),works:heads(home,'works').map(w=>fields(w,['key','title','owner','status','at','revision'])).sort((a,b)=>String(b.at).localeCompare(String(a.at)))}));
}

function linkedRecords(home,work,cardHeads){
 const read=eventReader(home),keys=work.executions.map(x=>x.key);
 const identity=taskIdentity(cardHeads);
 const ids=[...keys,...cardHeads.filter(c=>keys.includes(c.key)&&identity.resolve(c.id).key===c.key).map(c=>c.id)];
 const eventIds=[...keys,...cardHeads.filter(c=>keys.includes(c.key)).map(c=>c.id)];
 const mailRefs=work.mailRefs;
 const seed=read("(json_extract(payload,'$.kind') IN ('send','done') AND (json_extract(payload,'$.workKey')=? OR json_extract(payload,'$.executionKey') IN (SELECT value FROM json_each(?)) OR json_extract(payload,'$.taskId') IN (SELECT value FROM json_each(?)) OR json_extract(payload,'$.mailId') IN (SELECT value FROM json_each(?)) OR json_extract(payload,'$.digest') IN (SELECT value FROM json_each(?)))) OR (json_extract(payload,'$.kind')='handover' AND EXISTS(SELECT 1 FROM json_each(payload,'$.taskIds') WHERE value IN (SELECT value FROM json_each(?))))",
  [work.key,JSON.stringify(keys),JSON.stringify(eventIds),JSON.stringify(mailRefs),JSON.stringify(mailRefs),JSON.stringify(ids)],
  e=>['send','done'].includes(e.kind)&&(e.workKey===work.key||keys.includes(e.executionKey)||eventIds.includes(e.taskId)||mailRefs.includes(e.mailId)||mailRefs.includes(e.digest))||e.kind==='handover'&&e.taskIds?.some(id=>ids.includes(id)));
 const candidates=new Map(seed.map(e=>[e.seq,e]));
 const connected=e=>(!e.workKey||e.workKey===work.key)&&(!e.executionKey||keys.includes(e.executionKey));
 let letters=[];
 for(;;){
  const entries=[...candidates.values()].sort((a,b)=>a.seq-b.seq);
  const safeRefs=mailRefs.filter(id=>entries.filter(e=>e.kind==='send'&&(e.mailId===id||e.digest===id)).length===1);
  letters=workLetters({...work,mailRefs:safeRefs},entries,cardHeads).filter(connected);
  const refs=[...new Set(letters.flatMap(e=>[e.mailId,e.digest]).filter(Boolean))];
  const extra=refs.length?read("json_extract(payload,'$.kind')='send' AND (json_extract(payload,'$.replyTo') IN (SELECT value FROM json_each(?)) OR json_extract(payload,'$.mailId') IN (SELECT value FROM json_each(?)) OR json_extract(payload,'$.digest') IN (SELECT value FROM json_each(?)))",
   [JSON.stringify(refs),JSON.stringify(refs),JSON.stringify(refs)],e=>e.kind==='send'&&(refs.includes(e.replyTo)||refs.includes(e.mailId)||refs.includes(e.digest))):[];
  const before=candidates.size;for(const e of extra)candidates.set(e.seq,e);
  if(candidates.size===before)break;
 }
 const handoverIds=[...new Set(seed.filter(e=>e.kind==='handover').map(e=>e.handoverId))];
 const handovers=handoverIds.length?read("json_extract(payload,'$.kind')='handover' AND json_extract(payload,'$.handoverId') IN (SELECT value FROM json_each(?))",[JSON.stringify(handoverIds)],e=>e.kind==='handover'&&handoverIds.includes(e.handoverId)):[];
 return {events:seed.filter(e=>['send','done'].includes(e.kind)&&connected(e)),letters,handovers,ids};
}

function executionModel(home,link,cardHeads,records){
 const base={key:link.key,phase:link.phase,round:link.round,title:link.key,role:null,status:null,signals:[],reportState:'unknown'};
 try{
  if(!validKey(link.key))throw failure('실행 주소 확인 필요');
  const history=readStream(home,`cards/${link.key}/events.jsonl`);
  if(!history.length||history.some((c,i)=>c.key!==link.key||c.revision!==i+1))throw failure('실행 이력 확인 필요');
  const card=history.at(-1),identity=taskIdentity(cardHeads);
  const ambiguous=records?.events.some(e=>identity.resolve(e.taskId,e.executionKey).state==='ambiguous'&&e.taskId===card.id)??false;
  const runs=new Map(),seen=new Set();
  if(records&&!ambiguous)for(const e of workEntries([...records.events,...records.handovers].sort((a,b)=>a.seq-b.seq),identity).filter(e=>e.taskConnection?.state==='resolved'&&e.executionKey===card.key&&e.role)){
   if(e.kind==='send')runs.set(e.role,null);
   else if(!seen.has(e.role)){seen.add(e.role);runs.set(e.role,e);}
  }
  const signals=[...runs.values()].filter(Boolean).map(e=>({ref:ref(e.seq),role:e.role,by:e.by||null,result:e.result,at:e.t||null}));
  return {...base,...fields(card,['title','role','status','id','revision','at']),ambiguous,signals,
   reportState:!records||ambiguous?'unknown':signals.some(e=>e.result==='failed')?'failed':signals.length&&[...runs.values()].every(e=>e?.result==='ok')?'ok':signals.length?'partial':'unreported'};
 }catch(error){return {...base,error:error.message};}
}

function handoverModels(home,events,executions,cards){
 const identity=taskIdentity(cards);
 return [...new Set(events.map(e=>e.handoverId))].map(id=>{
  const rows=events.filter(e=>e.handoverId===id),base=rows.find(e=>e.taskIds?.length)||rows[0],last=rows.at(-1),accepted=rows.find(e=>e.phase==='accepted');
  const value={id,from:base.from,to:base.to,phase:last.phase,at:last.t||null,ref:ref(last.seq),accepted:Boolean(accepted),acceptedAt:accepted?.t||null,acceptedRef:accepted?ref(accepted.seq):null,
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

const mailModel=e=>({ref:ref(e.seq),mailId:e.mailId||null,at:e.t||null,by:e.by||null,to:e.role||null,executionKey:e.executionKey||null,replyTo:e.replyTo||null,kind:e.mailKind||null,hasBodyRef:Boolean(e.digest)});

export function operationsFlowDetail(home,key,{page=1}={}){
 return storageSnapshot(home,()=>{
  const work=workAt(home,key),errors=[];
  let cards=[],records=null;
  try{cards=heads(home,'cards');records=linkedRecords(home,work,cards);}catch{errors.push('연결 기록 조회 실패 · 실행 보고·우편·인수 상태는 모름입니다.');}
  const executions=work.executions.map(link=>executionModel(home,link,cards,records));
  const total=records?records.letters.length:null,pages=total===null?null:Math.max(1,Math.ceil(total/100));
  const selectedPage=Math.min(pages||1,Math.max(1,Number.parseInt(page,10)||1));
  return {collectedAt:stamp(),work:fields(work,['key','title','goal','scope','acceptance','owner','status','progress','nextAction','result','revision','at','by']),executions,
   handovers:records?handoverModels(home,records.handovers,executions,cards):null,
   mail:{total,page:selectedPage,pages,items:records?records.letters.slice((selectedPage-1)*100,selectedPage*100).map(mailModel):[]},errors,
   history:work.history.slice(-30).reverse().map(h=>fields(h,['revision','at','by','action','status','note']))};
 });
}

export function operationsFlowMail(home,key,recordRef){
 if(!/^ledger:[1-9]\d*$/.test(recordRef||''))throw failure('올바른 기록 주소가 필요합니다.',400);
 return storageSnapshot(home,()=>{
  const work=workAt(home,key),records=linkedRecords(home,work,heads(home,'cards'));
  const letter=records.letters.find(e=>ref(e.seq)===recordRef);
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

export function handleOperationsFlow(home,request,response,url){
 if(!['/api/operations-flow','/api/operations-flow/mail'].includes(url.pathname))return false;
 const send=(status,value)=>{response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});response.end(JSON.stringify(value));};
 if(request.method!=='GET'){send(405,{error:'조회 전용입니다.'});return true;}
 if(request.headers.origin&&request.headers.origin!==`http://${request.headers.host}`||request.headers['sec-fetch-site']==='cross-site'){send(403,{error:'같은 대시보드에서만 조회할 수 있습니다.'});return true;}
 try{
  const key=url.searchParams.get('work');
  const value=url.pathname.endsWith('/mail')?operationsFlowMail(home,key,url.searchParams.get('ref')):key?operationsFlowDetail(home,key,{page:url.searchParams.get('page')}):operationsFlowIndex(home);
  send(200,value);
 }catch(error){send(error.status||503,{error:error.status?error.message:'기록을 읽을 수 없습니다. 상태는 모름입니다.',collectedAt:stamp()});}
 return true;
}
