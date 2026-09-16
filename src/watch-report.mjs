import {taskIdentity} from './task-identity.mjs';
// 감시AI가 호출하는 보고 경계. 판단은 AI, 저장·중복 방지·상신은 이 명령의 책임이다.
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {appendLedger, readLedger, classifyLedgerEntry} from './ledger.mjs';
import {assertWritable, storageMode, transaction} from './storage.mjs';
import {CardStore} from './card-store.mjs';
import {WorkStore} from './work-store.mjs';
import {buildWatchScope,buildSupervisorScope} from './watch-scope.mjs';
import {mailboxLetters} from './mailbox-state.mjs';
import {effectiveCardRole,openTaskIds,workEntries} from './handover-state.mjs';
import {isDescendant, parseHierarchy} from './hierarchy.mjs';
import {routeAlert} from './watch.mjs';

export const WATCH_VERDICTS = ['진행중','입력대기','실행완료','응답장애','정체','죽음','모름','조정'];
export const WATCH_AI_TIMEOUT_MS = 300_000;
export const watchAILabel = source => source === 'supervisor-health' ? '감독 관찰AI' : ['worker','stall','progress'].includes(source) ? '작업 감시AI' : '감시AI';
export const normalWatchVerdict = verdict => ['진행중','입력대기','실행완료'].includes(verdict);
const normal = normalWatchVerdict;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function watchResponsibility(role, cards, entries, parents, source='stall', works=[]) {
  const session = `kadan-${role}`;
  const scope = source === 'supervisor-health' ? buildSupervisorScope(cards,entries,parents,works) : buildWatchScope(cards, entries, parents,works);
  if (!scope.sessions.has(session)) return null;
  const start = entries.findLast(e => e.kind === 'start' && e.session === session);
  if (!start) return null;
  const tasks = scope.entries.filter(e => {
    const owner = e.role || `${e.board}-감독`;
    return owner === role || isDescendant(owner, role, parents)
      || (!parents.has(owner) && owner.startsWith(role.replace(/-감독$/u,'')+'-'));
  }).map(e => [e.role || e.board,e.taskId,e.t ?? null]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return hash([start.t, start.panePid ?? start.rottiePid, tasks]);
}

export function latestWatchReports(entries) {
  const states = new Map();
  for (const e of entries) {
    if (e.kind === 'watch-ai-report' && e.accepted) states.set(e.key,e);
    if (e.kind === 'watch-ai-retired') states.delete(e.key);
  }
  return [...states.values()];
}

// 현재 실행을 맡은 사람이 실제로 답을 기다리는 질문만 정상 대기의 근거다.
export function waitingWithoutAsking(entries, {role, taskId}, cards = []) {
  if (!role || !taskId) return false;
  const identity = taskIdentity(cards);
  const projected = identity.project(entries);
  const address = identity.resolve(taskId);
  const task = address.key || address.taskId;
  const execution = e => {
    const found = identity.resolve(e.taskId, e.executionKey);
    return ['resolved','unregistered'].includes(found.state) ? found.key || e.executionKey || found.taskId : null;
  };
  const inherited = workEntries(projected);
  const index = inherited.findLastIndex(e => e.kind === 'send' && e.role === role && e.taskId
    && execution(e) === task && classifyLedgerEntry(e).dispatch);
  if (index < 0) return false;
  const afterDispatch = new Set(projected.slice(index + 1).filter(e => e.kind === 'send' && e.mailId).map(e => e.mailId));
  const questions = mailboxLetters(entries, role, {view:'waiting'});
  return !questions.some(e => e.expectReply && e.replyStatus === 'waiting'
    && !e.replyFinal && !e.notificationOnly && !e.systemGenerated && execution(e) === task
    && afterDispatch.has(e.mailId));
}

function currentRequest(request,cards,entries,parents,works=[]) {
  if(watchResponsibility(request.role,cards,entries,parents,request.source,works)!==request.responsibility)return false;
  if(request.source!=='progress')return true;
  const identity=taskIdentity(cards);entries=identity.project(entries);
  return cards.some(card=>identity.resolve(request.taskId).key===card.key&&card.status==='assigned'&&card.activity==='running'
    &&card.workType!=='coordination'&&effectiveCardRole(card,entries,identity)===request.role)
    &&openTaskIds(entries,request.role).includes(identity.resolve(request.taskId).taskId);
}

export class WatchReports {
  constructor({home, floor, send, now=Date.now, readEntries, readCards, readWorks, record}) {
    Object.assign(this,{home:path.resolve(home),floor,send,now});
    this.readEntries = readEntries ?? (() => readLedger(this.home));
    this.readCards = readCards ?? (() => new CardStore(this.home).list());
    this.readWorks = readWorks ?? (() => new WorkStore(this.home).list());
    this.record = record ?? (e => appendLedger(e,this.home));
  }
  entries() {
    const entries=this.readEntries();
    if (entries.some(e=>e.broken)) throw new Error('감시 보고 원장 읽기 실패');
    return entries;
  }
  locked(fn) {
    assertWritable(this.home);
    if (storageMode(this.home)==='sqlite') return transaction(this.home,fn);
    fs.mkdirSync(this.home,{recursive:true,mode:0o700});
    const lock=path.join(this.home,'.watch-report-lock');
    fs.mkdirSync(lock);
    try { return fn(); } finally { fs.renameSync(lock,`${lock}.released-${randomUUID()}`); }
  }
  request({source,role,taskId=null,parents=new Map(),routes=new Map(),superRole=null,hierarchyPath=null,userNotify=false,timeoutMs=WATCH_AI_TIMEOUT_MS,observationDigest=null,evidenceDigest=null}) {
    const responsibility=watchResponsibility(role,this.readCards(),this.entries(),parents,source,this.readWorks());
    if (!responsibility) return null;
    const requestId=randomUUID(),at=this.now();
    const dir=path.join(this.home,'watch-ai',requestId);
    fs.mkdirSync(dir,{recursive:true,mode:0o700});
    const request={kind:'watch-ai-request',by:'watch',protocol:2,requestId,source,role,session:`kadan-${role}`,taskId,observationDigest,evidenceDigest,
      responsibility,key:`${source}:${role}:${taskId||''}:${responsibility}`,expiresAt:at+timeoutMs,
      parents:[...parents],routes:routes instanceof Map?[...routes]:Object.entries(routes),superRole,hierarchyPath,userNotify,
      evidencePath:dir,t:new Date(at).toISOString()};
    this.record(request);
    return request;
  }
  receipt(requestId) {
    const entries=this.entries();
    const report=entries.find(e=>e.kind==='watch-ai-report'&&e.requestId===requestId);
    if (!report) return null;
    const delivery=entries.find(e=>e.kind==='watch-ai-delivery'&&e.requestId===requestId);
    return {report,delivery,complete:!report.notify||Boolean(delivery)};
  }
  completed(request,result) {
    // 신호 파일은 원장이 아니다. 호출자는 실제 보고·전달 기록을 대조한 뒤 종료한다.
    if(this.receipt(request.requestId)?.complete)
      fs.writeFileSync(path.join(request.evidencePath,'report-complete'),request.requestId,{mode:0o600});
    return result;
  }
  submit(requestId, verdict, reason) {
    if (!WATCH_VERDICTS.includes(verdict)) throw new Error(`판정은 ${WATCH_VERDICTS.join(', ')} 중 하나`);
    if (typeof reason!=='string'||!reason.trim()||reason.length>500) throw new Error('판단 이유는 1~500자로 입력하세요');
    reason=reason.replace(/[\x00-\x1f\x7f]/g,' ').trim();
    let request,parents,report,duplicate=false;
    this.locked(()=>{
      const entries=this.entries();
      request=entries.find(e=>e.kind==='watch-ai-request'&&e.requestId===requestId);
      if (!request) throw new Error('감시AI 호출 기록 없음');
      if (request.protocol === 2 && verdict === '죽음') throw new Error('새 감시AI 보고는 죽음을 쓰지 않습니다. 완료 후 대기는 실행완료, 연결·압축 실패는 응답장애, 근거 부족은 모름으로 보고하세요.');
      const old=entries.find(e=>e.kind==='watch-ai-report'&&e.requestId===requestId);
      if (old) { duplicate=true; report=old; return; }
      parents=request.hierarchyPath ? parseHierarchy(JSON.parse(fs.readFileSync(request.hierarchyPath,'utf8'))) : new Map(request.parents);
      const cards=this.readCards(),identity=taskIdentity(cards);
      const current=currentRequest(request,cards,entries,parents,this.readWorks());
      const stale=this.now()>request.expiresAt||entries.some(e=>e.kind==='watch-ai-call'&&e.requestId===requestId)
        ||!current
        ||entries.findLast(e=>e.kind==='watch-ai-request'&&e.key===request.key)?.requestId!==requestId;
      const previous=latestWatchReports(entries).find(e=>e.key===request.key);
      const consecutive=verdict==='조정'?(previous?.verdict==='조정'?previous.consecutive:0)+1:0;
      const level=verdict==='죽음'||consecutive>=2?'RED':'AMBER';
      // 진행 중인 카드를 맡은 작업자가 아무것도 묻지 않은 채 입력 대기면 멈춘 것으로 보고 감독에게 알린다.
      const idleWithoutAsk=!stale&&verdict==='입력대기'&&request.source==='progress'
        &&waitingWithoutAsking(entries,{role:request.role,taskId:identity.resolve(request.taskId).taskId},cards);
      const notify=!stale&&(!normal(verdict)||idleWithoutAsk)
        &&(!previous||previous.verdict!==verdict||previous.level!==level||Boolean(previous.idleWithoutAsk)!==idleWithoutAsk);
      const reasonPath=path.join(request.evidencePath,'reason.txt');
      fs.writeFileSync(reasonPath,reason,{mode:0o600});
      report={kind:'watch-ai-report',by:'watch-ai',requestId,key:request.key,source:request.source,
        role:request.role,session:request.session,taskId:request.taskId,responsibility:request.responsibility,observationDigest:request.observationDigest,
        verdict,level,consecutive,accepted:!stale,notify,reasonPath,...(idleWithoutAsk?{idleWithoutAsk:true}:{}),t:new Date(this.now()).toISOString()};
      // 먼저 기록해 같은 명령/문제의 재전송을 막는다. 외부 발송은 저장 잠금 밖에서 한다.
      this.record(report);
      if (!stale&&normal(verdict)&&!idleWithoutAsk&&previous&&(!normal(previous.verdict)||previous.idleWithoutAsk)) this.record({kind:'alert',by:'watch',source:'watch-ai',
        requestId,role:request.role,session:request.session,taskId:request.taskId,alertKind:previous.verdict,
        level:previous.level,resolved:true,delivered:false,recipient:null,resolution:'ai-normal'});
    });
    if (duplicate||!report.notify) return this.completed(request,{...report,duplicate});
    const label=report.idleWithoutAsk?'카드 미완인데 입력 대기'
      :{'정체':'작업 정체 확인 필요','죽음':'세션 종료 의심','응답장애':'응답 장애 의심','모름':'상태 판단 근거 부족','조정':'진행 조정 필요'}[verdict];
    const message=`[${watchAILabel(request.source)}] ${label} · ${request.role}${request.taskId?` / ${request.taskId}`:''}: ${reason}${report.consecutive>=2?' 반복 조정 판정입니다. 상위 감독과 범위·담당 조정을 검토하세요.':''} 감독이 확인 후 후속 조치를 결정하세요.`;
    const live=new Set(this.floor.list().filter(x=>x.alive!==false).map(x=>x.session));
    const routes=new Map(request.routes);
    const recipient=routeAlert({id:request.key,role:request.role},routes,live,request.superRole,parents);
    let delivery='no-recipient',escalation=null;
    if (recipient) {
      try { this.send(recipient,message); delivery='sent'; }
      catch(error) {
        delivery=error.delivery??'unknown';
        const upper=parents.has(recipient)?routeAlert({id:'delivery',role:recipient},routes,live,request.superRole,parents):request.superRole;
        if (delivery==='not-sent'&&upper&&upper!==recipient&&recipient!=='@user') {
          try { this.send(upper,`[${watchAILabel(request.source)}] 보고 전달 실패 · ${recipient}에게 전달하지 못했습니다. ${message}`); escalation={recipient:upper,delivery:'sent'}; }
          catch(e) { escalation={recipient:upper,delivery:e.delivery??'unknown'}; }
        }
      }
    }
    let userNotification=null;
    if(request.userNotify&&report.level==='RED'&&recipient!=='@user'&&escalation?.recipient!=='@user') {
      try { this.send('@user',message); userNotification='sent'; } catch { userNotification='failed'; }
    }
    this.record({kind:'watch-ai-delivery',by:'watch-ai',requestId,source:request.source,role:request.role,recipient,delivery,escalation,userNotification});
    this.record({kind:'alert',by:'watch',source:'watch-ai',requestId,role:request.role,session:request.session,
      taskId:request.taskId,alertKind:verdict,level:report.level,recipient,delivered:delivery==='sent'});
    if(escalation) this.record({kind:'alert',by:'watch',source:'watch-ai',requestId,role:request.role,session:request.session,
      taskId:request.taskId,alertKind:'전달실패',level:report.level,recipient:escalation.recipient,delivered:escalation.delivery==='sent'});
    return this.completed(request,{...report,recipient,delivery,escalation});
  }
  retire(entries,cards,parents,works=this.readWorks()) {
    for (const report of latestWatchReports(entries)) {
      if (currentRequest(report,cards,entries,parents,works)) continue;
      this.record({kind:'watch-ai-retired',by:'watch',key:report.key,requestId:report.requestId,source:report.source,role:report.role,reason:'responsibility-changed'});
      if (!normal(report.verdict)) this.record({kind:'alert',by:'watch',source:'watch-ai',requestId:report.requestId,
        role:report.role,session:report.session,taskId:report.taskId,alertKind:report.verdict,level:report.level,
        resolved:true,delivered:false,recipient:null,resolution:'scope-exit'});
    }
  }
}

export function watchReportCommand(args,flags,options) {
  if (flags.help||!args.length) return 'kadan watch-report <호출ID> --verdict 진행중|입력대기|실행완료|응답장애|정체|모름|조정 --reason 판단이유';
  if (args.length!==1||Object.keys(flags).some(k=>!['verdict','reason'].includes(k))) throw new Error('watch-report는 호출ID, --verdict, --reason만 사용합니다');
  return new WatchReports(options).submit(args[0],flags.verdict,flags.reason);
}
