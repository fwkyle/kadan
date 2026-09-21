// Why: 전달 사실과 작업 발령을 따로 보존하면서 기존 조회의 순서를 유지한다.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {appendStream,readStream,storageMode,storageSnapshot,storageTransaction,assertWritable} from './storage.mjs';
import {isMailTransfer} from './mail-routing.mjs';
import {taskIdentity} from './task-identity.mjs';

export const ledgerStreams = Object.freeze({tasks:'tasks/events.jsonl',mail:'mail/events.jsonl',system:'system/events.jsonl'});
const taskKinds = new Set(['plan','dispatch','done']);
const taskFields = ['t','role','taskId','rawTaskId','executionKey','workKey','board','by'];
const own = (value,key) => Object.hasOwn(value,key);
const taskSend = value => value.kind === 'send' && value.taskId != null && value.transport !== 'mailbox' && !value.completion && !value.systemGenerated && !value.replyFinal;
const lockPath = home => path.join(home,'.ledger-lock');

export function ledgerDomain(kind) {
  if (taskKinds.has(kind)) return 'tasks';
  if (kind === 'send' || /^(mail-|reply(?:-|$)|cancel(?:-|$))/.test(kind)) return 'mail';
  return 'system';
}

// 통합 조회의 send에는 전달/발령 의미가 함께 있다. mailbox의 작업 연결은 발령이 아니다.
export function classifyLedgerEntry(entry) {
  if (!entry || typeof entry.kind !== 'string' || entry.broken) return {domains:[],dispatch:null};
  if (taskSend(entry)) return {domains:['tasks','mail'],dispatch:entry.dispatchId === entry.mailId && entry.mailId ? 'linked' : 'legacy'};
  return {domains:[ledgerDomain(entry.kind)],dispatch:entry.kind === 'dispatch' ? (entry.legacy ? 'legacy' : 'linked') : null};
}

export function validateDomainEvent(stream,value) {
  const domain = Object.keys(ledgerStreams).find(key => ledgerStreams[key] === stream);
  if (!domain) return;
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.kind !== 'string' || !value.kind || value.broken || ledgerDomain(value.kind) !== domain)
    throw new Error(`도메인 원장 종류 손상: ${stream}`);
  if (!Number.isSafeInteger(value._ledgerOrder) || value._ledgerOrder < 1)
    throw new Error(`도메인 원장 순번 손상: ${stream}`);
  if ((value.kind === 'send' || value.kind === 'dispatch') && (typeof value.mailId !== 'string' || !value.mailId))
    throw new Error(`도메인 원장 mailId 손상: ${stream}`);
  if ((taskSend(value) || value.kind === 'dispatch') && (typeof value.taskId !== 'string' || !value.taskId || value.dispatchId !== value.mailId))
    throw new Error(`도메인 원장 dispatch 연결 손상: ${stream}`);
}

function dispatchFor(send) {
  // 발령 대상/작업 연결은 dispatch가 원본. 전달 내용/전송 영수증은 send가 원본이다.
  return {...Object.fromEntries(taskFields.filter(key => own(send,key)).map(key => [key,send[key]])),
    kind:'dispatch',mailId:send.mailId,dispatchId:send.mailId,_ledgerOrder:send._ledgerOrder};
}

export function validateDomainStreams(streams,legacy = []) {
  const groups = new Map(), mailIds = new Set(legacy.filter(row=>row?.kind==='send' && row.mailId).map(row=>row.mailId));
  for (const [stream,rows] of streams) {
    let previous = 0;
    for (const value of rows) {
      validateDomainEvent(stream,value);
      if (value._ledgerOrder <= previous) throw new Error(`도메인 원장 순서 손상: ${stream}`);
      previous = value._ledgerOrder;
      const group = groups.get(previous) || [];
      group.push(value);groups.set(previous,group);
      if (value.kind === 'send') {
        if (mailIds.has(value.mailId)) throw new Error('도메인 원장 중복 mailId');
        mailIds.add(value.mailId);
      }
    }
  }
  const ordered = [...groups].sort(([a],[b]) => a-b);
  for (const [i,[order,rows]] of ordered.entries()) {
    if (order !== i+1) throw new Error('도메인 원장 순번 누락');
    const send = rows.find(row => row.kind === 'send');
    const dispatch = rows.find(row => row.kind === 'dispatch');
    if (dispatch || taskSend(send || {})) {
      if (!send || !dispatch || rows.length !== 2 || !taskSend(send) ||
          JSON.stringify(dispatchFor(send)) !== JSON.stringify(dispatchFor({...dispatch,kind:'send'})))
        throw new Error('도메인 원장 send/dispatch 연결 손상');
    } else if (rows.length !== 1) throw new Error('도메인 원장 순번 중복');
  }
  const result = ordered.flatMap(([,rows]) => rows);
  const history=[...legacy,...result];
  const mails = new Map(history.filter(row=>row?.kind==='send' && row.mailId).map(row=>[row.mailId,row]));
  const completions = new Map();
  for (const done of result.filter(row=>row.kind==='done' && row.completionMailId)) {
    const mail=mails.get(done.completionMailId),request=mail && mails.get(mail.replyTo);
    if (!mail || mail.systemGenerated!=='task-completion' || !mail.completion || !mail.replyFinal || mail.transport!=='mailbox' || own(mail,'taskId') ||
        mail._ledgerOrder!==done._ledgerOrder+1 || mail.by!==done.role || mail.completionTaskId!==done.taskId || mail.result!==done.result ||
        !request || request!==completionRequest(done,history.slice(0,history.indexOf(done))) || request.by!==mail.role || !request.by || request.by==='모름')
      throw new Error('도메인 원장 완료 우편 연결 손상');
    if (completions.has(mail.mailId)) throw new Error('도메인 원장 완료 우편 중복');
    completions.set(mail.mailId,done);
  }
  for (const mail of result.filter(row=>row.systemGenerated==='task-completion')) {
    if (mail.kind!=='send' || !completions.has(mail.mailId)) throw new Error('도메인 원장 완료 사건 없는 우편');
  }
  return result;
}

function legacyRows(home) {
  if (storageMode(home) === 'sqlite') return readStream(home,'ledger.jsonl',{optional:true});
  const file = path.join(home,'ledger.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return {t:null,broken:line}; }
  });
}

export function readLedgerState(home,{locked=false}={}) {
  return storageSnapshot(home,() => {
    const checkLock = () => {
      if (!locked && storageMode(home) === 'jsonl' && fs.existsSync(lockPath(home)))
        throw new Error('도메인 원장 저장 중 또는 미완료 잠금: 상태 확인 필요');
    };
    checkLock();
    const legacy = legacyRows(home);
    const streams = new Map(Object.values(ledgerStreams).map(stream => [stream,readStream(home,stream,{optional:true})]));
    const ordered = validateDomainStreams(streams,legacy);
    checkLock();
    return {legacy,streams,ordered};
  });
}

const validTask = value => typeof value.taskId === 'string' && value.taskId &&
  (!value.executionKey || (typeof value.executionKey === 'string' &&
    (value.taskId === value.executionKey || value.taskId === value.executionKey.split('/').at(-1))));
const explicitTaskKey = value => value.executionKey || (value.taskId?.includes('/') ? value.taskId : null);
function completionRequest(done,history) {
  // 우편 책임과 달리 작업은 확정 인계의 taskIds에 적힌 실행만 옮긴다.
  // 원장 안의 정식 주소로 같은 taskIdentity 별칭 규칙을 적용하며 모호하면 통지하지 않는다.
  const keys=new Set([done,...history].flatMap(row=>[
    ...(validTask(row||{})&&explicitTaskKey(row)?[explicitTaskKey(row)]:[]),
    ...(isMailTransfer(row)&&Array.isArray(row.taskIds)?row.taskIds.filter(id=>typeof id==='string'&&id.includes('/')):[]),
  ]));
  const identity=taskIdentity([...keys].map(key=>({key,id:key.split('/').at(-1)})));
  const address=(taskId,executionKey)=>{
    const found=identity.resolve(taskId,executionKey);
    return found.state==='resolved'?found.key:found.state==='unregistered'?taskId:null;
  };
  const target=address(done.taskId,done.executionKey);
  if(!target)return null;
  const projected=[],transfers=new Set();
  for(const entry of history){
    if(isMailTransfer(entry)&&Array.isArray(entry.taskIds)){
      const id=entry.handoverId||JSON.stringify([entry.from,entry.to]);
      if(transfers.has(id))continue;
      transfers.add(id);
      const tasks=new Set(entry.taskIds.map(id=>address(id)));
      for(const item of projected)if(item.role===entry.from&&item.key&&tasks.has(item.key))item.role=entry.to;
    }else if((taskSend(entry||{})||entry?.kind==='done')&&validTask(entry)){
      projected.push({entry,role:entry.role,key:address(entry.taskId,entry.executionKey)});
    }
  }
  const matches=projected.filter(item=>item.role===done.role&&item.key===target);
  // 최초 완료만 인정한다. 인계 전에 이미 완료된 실행도 다시 결과 우편을 만들지 않는다.
  if(matches.some(item=>item.entry.kind==='done'))return null;
  return matches.filter(item=>taskSend(item.entry)).at(-1)?.entry||null;
}

// 일반 답장의 연결 검사를 완화하지 않는다. 저장된 done과 원발령을 확인한 결과 우편만 예외다.
export function isTaskCompletionReply(entries,mail,request) {
  if(!request||!taskSend(request)||mail.systemGenerated!=='task-completion'||mail.completion!==true||
    mail.replyFinal!==true||mail.transport!=='mailbox'||own(mail,'taskId')||mail.replyTo!==request.mailId)return false;
  const mailIndex=entries.indexOf(mail);
  const doneIndex=entries.findIndex(entry=>entry?.kind==='done'&&entry.completionMailId===mail.mailId);
  if(doneIndex<0||doneIndex>=mailIndex)return false;
  const done=entries[doneIndex];
  return validTask(done)&&['ok','failed'].includes(done.result)&&done.role===mail.by&&done.taskId===mail.completionTaskId&&
    done.result===mail.result&&mail.role===request.by&&mail.workKey===request.workKey&&
    mail.executionKey===(done.executionKey??request.executionKey)&&completionRequest(done,entries.slice(0,doneIndex))===request;
}
function completionFor(done,state,home) {
  if (done.kind !== 'done' || !done.role || !validTask(done) || !['ok','failed'].includes(done.result)) return null;
  const history = [...state.legacy,...state.ordered];
  const request=completionRequest(done,history);
  if(!request)return null;
  if (request._ledgerOrder) {
    const dispatch=state.ordered.find(row=>row.kind==='dispatch' && row.mailId===request.mailId);
    if (!dispatch || JSON.stringify(dispatchFor(request))!==JSON.stringify(dispatchFor({...dispatch,kind:'send'}))) throw new Error('도메인 원장 send/dispatch 연결 손상');
  }
  if (!request.mailId || typeof request.by !== 'string' || !request.by.trim() || request.by === '모름') return null;
  const mailId = randomUUID();
  const refs = Object.fromEntries(['executionKey','workKey','originalCardPath','resultFile','resultPath'].flatMap(key => {
    const value = done[key] ?? request[key];
    return typeof value === 'string' && value ? [[key,value]] : [];
  }));
  const body = `${done.result}: ${refs.executionKey || done.taskId}` +
    [refs.originalCardPath,refs.resultFile,refs.resultPath].filter(Boolean).map(ref => `\n${ref}`).join('');
  const digest = createHash('sha256').update(body).digest('hex');
  const dir = path.join(home,'mail'),file = path.join(dir,`${digest}.txt`);
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file,'utf8') !== body) throw new Error('완료 우편 본문 지문 충돌');
  } else fs.writeFileSync(file,body,{flag:'wx',mode:0o600});
  done.completionMailId = mailId;
  return {t:done.t,kind:'send',mailId,transport:'mailbox',mailKind:'report',replyFinal:true,
    completion:true,systemGenerated:'task-completion',notificationOnly:true,role:request.by,by:done.role,replyTo:request.mailId,
    completionTaskId:done.taskId,...refs,result:done.result,digest,bytes:Buffer.byteLength(body),_ledgerOrder:done._ledgerOrder+1};
}

export function appendDomainLedger(entry,home) {
  assertWritable(home);
  fs.mkdirSync(home,{recursive:true,mode:0o700});
  const write = db => {
    // SQLite 일반 사건 추가는 heads 세 행만 읽는다. 전체 이력 검증은 read/verify에 둔다.
    const state = db ? {legacy:[],ordered:[]} : readLedgerState(home,{locked:true});
    const lastOrder = db ? Math.max(0,...db.prepare("SELECT stream,payload FROM heads WHERE stream IN (?,?,?)").all(...Object.values(ledgerStreams)).map(row => {
      const value=JSON.parse(row.payload);validateDomainEvent(row.stream,value);return value._ledgerOrder;
    })) : (state.ordered.at(-1)?._ledgerOrder || 0);
    const value = JSON.parse(JSON.stringify({t:new Date().toISOString(),...entry}));
    if (own(value,'completionMailId') || value.systemGenerated === 'task-completion') throw new Error('완료 우편 연결은 done 저장이 생성합니다');
    if (own(value,'_ledgerOrder')) throw new Error('원장 저장 순번은 호출자가 지정할 수 없습니다');
    if (value.kind === 'dispatch') throw new Error('dispatch 직접 기록 금지: taskId가 있는 send로 기록하세요');
    value._ledgerOrder = lastOrder+1;
    if (value.kind === 'send') {
      value.mailId ??= randomUUID();
      if (db ? db.prepare("SELECT 1 FROM events WHERE stream IN ('ledger.jsonl','mail/events.jsonl') AND json_extract(payload,'$.kind')='send' AND json_extract(payload,'$.mailId')=? LIMIT 1").get(value.mailId) : [...state.legacy,...state.ordered].some(row => row?.kind === 'send' && row.mailId === value.mailId))
        throw new Error('도메인 원장 중복 mailId');
      if (taskSend(value)) value.dispatchId = value.mailId;
    }
    if (db && value.kind === 'done' && value.role && validTask(value)) {
      // 같은 작업 주소 후보와 확정 인계만 읽는다. 후임 완료는 선임 발령도 함께 확인한다.
      const address=value.executionKey || value.taskId,shortId=value.taskId.split('/').at(-1);
      const rows=db.prepare(`SELECT stream,payload FROM events WHERE
        (stream IN ('ledger.jsonl','system/events.jsonl') AND json_extract(payload,'$.kind')='handover' AND json_extract(payload,'$.phase')='transferred')
        OR (stream IN ('ledger.jsonl','tasks/events.jsonl','mail/events.jsonl')
          AND json_extract(payload,'$.kind') IN ('send','dispatch','done')
          AND (json_extract(payload,'$.taskId') IN (?,?,?) OR json_extract(payload,'$.executionKey')=?
            OR substr(json_extract(payload,'$.taskId'),-length(?)-1)='/'||?)) ORDER BY stream,seq`).all(value.taskId,address,shortId,address,shortId,shortId);
      state.legacy=rows.filter(row=>row.stream==='ledger.jsonl').map(row=>JSON.parse(row.payload));
      state.ordered=rows.filter(row=>row.stream!=='ledger.jsonl').map(row=>JSON.parse(row.payload)).sort((a,b)=>a._ledgerOrder-b._ledgerOrder);
    }
    const completion = completionFor(value,state,home);
    const stream = ledgerStreams[ledgerDomain(value.kind)];
    validateDomainEvent(stream,value);
    const dispatch = taskSend(value) ? dispatchFor(value) : null;
    if (dispatch) validateDomainEvent(ledgerStreams.tasks,dispatch);
    appendStream(home,stream,value);
    if (dispatch) appendStream(home,ledgerStreams.tasks,dispatch);
    if (completion) { validateDomainEvent(ledgerStreams.mail,completion);appendStream(home,ledgerStreams.mail,completion); }
    return JSON.stringify(publicEvent(value));
  };
  if (storageMode(home) === 'sqlite') return storageTransaction(home,write);
  // JSONL은 파일 두 개의 원자적 쓰기를 지원하지 않는다. 잠금 + 연결 검증으로
  // 중간 실패를 성공한 발령으로 읽지 않는다. 중단한 잠금/원문은 자동 삭제하지 않는다.
  const lock = lockPath(home);
  try { fs.mkdirSync(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('도메인 원장 저장 중 또는 미완료 잠금: 상태 확인 필요');
    throw error;
  }
  try { return write(); } finally { fs.renameSync(lock,path.join(home,`.released-ledger-${randomUUID()}`)); }
}

function publicEvent(value) {
  if (!value || typeof value !== 'object') return value;
  const {_ledgerOrder,...entry} = value;
  return entry;
}

export function uniqueDone(rows) {
  const seen = new Set();
  return rows.filter(entry => {
    if (entry?.kind !== 'done' || !entry.role || !entry.taskId) return true;
    const key = JSON.stringify([entry.role,entry.taskId,entry.executionKey || '']);
    if (seen.has(key)) return false;
    seen.add(key);return true;
  });
}

export function projectLedger(state,domain) {
  if (domain && state.legacy.some(row=>!row || typeof row.kind!=='string' || row.broken)) throw new Error('과거 원장 손상: 도메인 조회 불가');
  const mailEvidence=value=>isMailTransfer(value)||value?.kind==='done'&&value.completionMailId;
  const legacy = state.legacy.flatMap(value => {
    if (!domain) return [value];
    if (domain === 'tasks' && taskSend(value || {})) {
      return [{...value,kind:'dispatch',legacy:true}];
    }
    return ledgerDomain(value?.kind) === domain || domain === 'mail' && mailEvidence(value) ? [value] : [];
  });
  // 인계와 완료는 자기 영역에 한 번만 저장한다. 우편 조회에는 판정 근거를 원래 순서로 포함한다.
  const rows = state.ordered.filter(value => domain ? ledgerDomain(value.kind) === domain || domain === 'mail' && mailEvidence(value) : value.kind !== 'dispatch').map(publicEvent);
  return uniqueDone([...legacy,...rows]);
}
