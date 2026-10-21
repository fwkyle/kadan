import {mailboxLetters} from './mailbox-state.mjs';
import {workEntries} from './handover-state.mjs';
import {taskIdentity} from './task-identity.mjs';
import {SUPERVISOR_ERROR_PATTERN} from './watch-stop-phrases.mjs';
import {statusProgress} from './watch-status-line.mjs';
import {changeDigest} from './watch-roles.mjs';
// 감독의 정상 대기는 멈춤이 아니다. 시간·오류 지속 후보만 고르고 판단은 감시ai가 한다.
export const SUPERVISOR_CHECK_MS = 60 * 60_000;
export const SUPERVISOR_ERROR_MS = 5 * 60_000;
// 같은 화면 재사용: 원장의 마지막 요청 뒤 이 시간이 지나면 같은 화면이어도 정기 확인을 한 번 부른다(재시작해도 유지).
export const SUPERVISOR_REUSE_MS = 4 * 60 * 60_000;
const REUSABLE_VERDICTS = new Set(['입력대기', '실행완료']);
const errorPattern = SUPERVISOR_ERROR_PATTERN; // 작업자 감시와 같은 목록(watch-stop-phrases.mjs)

export function observationContext(role, observation, entries, cards, tasks) {
  const identity=taskIdentity(cards);
  const ids = new Set(tasks.filter(e => e.role === role).map(e => e.taskId));
  return {
    process:{alive:observation.alive,pid:observation.pid,expectedPid:observation.expectedPid},
    tasks:cards.filter(c => ids.has(identity.taskIdFor(c))).map(c => ({id:c.id,title:c.title,status:c.status,activity:c.activity,scope:c.scope?.slice(0,1000)})),
    responsibilities:tasks.filter(e => e.role === role),
    recentTaskEvents:workEntries(entries,identity).filter(e => e.kind === 'done' && (e.role === role || e.by === role))
      .slice(-12).map(e => ({at:e.t,kind:e.kind,role:e.role,by:e.by,taskId:e.taskId,executionKey:e.executionKey,result:e.result})),
    recentMail:mailboxLetters(entries).filter(e => (e.currentRecipient || e.role) === role || (e.currentSender || e.by) === role)
      .slice(-12).map(e => ({at:e.t,kind:e.kind,mailId:e.mailId,from:e.by,to:e.role,
        currentRecipient:e.currentRecipient || e.role,currentSender:e.currentSender || e.by,
        taskId:e.taskId,executionKey:e.executionKey,workKey:e.workKey,replyTo:e.replyTo,
        transport:e.transport,completion:e.completion,systemGenerated:e.systemGenerated,notificationOnly:e.notificationOnly,
        read:e.read,readKind:e.readKind,expectReply:e.expectReply,replyStatus:e.replyStatus,replyFinal:e.replyFinal,
        preview:e.preview?.slice(0,400)})),
  };
}

// 그 세션의 마지막 감독 관찰AI 요청(원장)과 짝인 보고가 정상 판정이고, 그 요청의 화면 지문이 지금 화면과 같고, 마지막 요청 뒤 SUPERVISOR_REUSE_MS가 안 지났는가.
// 요청의 observationDigest는 호출 때 화면의 changeDigest다(숫자·회전 표시만 바뀐 화면은 같은 화면으로 본다). 지문이 없는 옛 요청·보고 없음은 재사용하지 않는다.
function sameAsJudgedNormal(entries, session, screen, now) {
  const request = entries.findLast(e => e.kind === 'watch-ai-request' && e.source === 'supervisor-health' && e.session === session);
  if (!request?.observationDigest || !(now - Date.parse(request.t) < SUPERVISOR_REUSE_MS)) return false;
  const report = entries.findLast(e => e.kind === 'watch-ai-report' && e.requestId === request.requestId && e.accepted);
  return REUSABLE_VERDICTS.has(report?.verdict) && changeDigest(screen) === request.observationDigest;
}

export class SupervisorHealth {
  states = new Map();
  started(session,screen,now) {
    const state=this.states.get(session);
    if(!state)return;
    state.lastCheck=now;state.at=now;state.screen=screen.slice(-8000);
    if(state.errorSince!=null)state.errorChecked=true;
  }
  // ownTurn: 본인 차례 항목이 있는 감독 역할 집합(놀고 있음 계산 결과). null이면 모르는 것이라 거르지 않는다.
  select({scope,observations,entries,mailEntries=entries,cards,now,enabled,ownTurn=null}) {
    for (const session of this.states.keys()) if (!scope.sessions.has(session)) this.states.delete(session);
    const candidates = [], alerts = [];
    for (const session of scope.sessions) {
      const seen = observations.get(session), role = session.slice(6);
      if (!seen || !seen.alive || seen.screen == null || seen.expectedPid != null && String(seen.pid) !== String(seen.expectedPid)) {
        const kind = seen?.alive === false ? '죽음' : '모름';
        alerts.push({id:`supervisor-health:${session}`,kind,level:kind === '죽음'?'RED':'AMBER',role,session,
          screenError:!seen?'감독 시작 기록 없음':seen.screenError || (seen.alive?'감독 PID 또는 화면 확인 필요':'감독 세션 없음')});
        continue;
      }
      let state = this.states.get(session);
      if (!state || String(state.pid) !== String(seen.pid)) {
        const previous = entries.findLast(e => e.kind === 'watch-ai-request' && e.source === 'supervisor-health' && e.session === session && Date.parse(e.t) >= Date.parse(seen.startedAt));
        state = {pid:seen.pid,at:now,screen:seen.screen.slice(-8000),lastCheck:Number.isFinite(Date.parse(previous?.t))?Date.parse(previous.t):now,errorSince:null,errorChecked:false,workClock:null,prevScreen:seen.screen.slice(-8000)};
        this.states.set(session,state);
      }
      const error = errorPattern.test(seen.screen.split('\n').slice(-20).join('\n'));
      if (!error) { state.errorSince=null;state.errorChecked=false; }
      else if (state.errorSince == null) state.errorSince=now;
      // 감독 오류(errorPattern)가 보이는 화면에서는 진행 중 판정을 쓰지 않는다(early·hourly 모두 main과 같다). 오류가 없을 때만 직전 순회 대비 진행 중이면 정기 후보를 내지 않는다(작업자 감시와 같은 공용 판정). 시계·화면은 후보 여부와 무관하게 매 순회 갱신한다.
      const progress = statusProgress(seen.screen, state.workClock);
      const previousScreen = state.prevScreen, previousClockSec = state.workClock;
      state.workClock = progress.status?.kind === 'working' ? progress.status.clockSec : null;
      state.prevScreen = seen.screen.slice(-8000);
      const early = error && !state.errorChecked && now-state.errorSince >= SUPERVISOR_ERROR_MS;
      // 같은 화면 재사용: 지난 관찰AI가 정상으로 판정한 그 화면(changeDigest 같음)이고 오류·본인 차례가 없으면 정기 확인을 부르지 않는다. 화면 모양은 해석하지 않는다. 하나라도 아니면 그대로 부른다.
      const quiet = !error && now-state.lastCheck >= SUPERVISOR_CHECK_MS && ownTurn != null && !ownTurn.has(role) && sameAsJudgedNormal(entries, session, seen.screen, now);
      if (enabled && (early || (error || !progress.moving) && !quiet && now-state.lastCheck >= SUPERVISOR_CHECK_MS)) {
        candidates.push({state,early,source:'supervisor-health',role,session,input:{
          ...observationContext(role,seen,mailEntries,cards,scope.entries),
          check:early?'persistent-error':'hourly',minutes:Math.floor((now-state.at)/60000),
          errorMinutes:error?Math.floor((now-state.errorSince)/60000):0,
          // previous는 직전 순회(약 60초 전) 화면이다. 마지막 관찰AI 확인 때 화면이 아니다(minutes가 그 뒤 경과).
          previous:previousScreen,current:seen.screen.slice(-8000),
          statusLine:{kind:progress.status?.kind??null,clockSec:progress.status?.clockSec??null,previousClockSec},
        }});
      }
    }
    // 여러 감독이 같은 시각에 도래해도 한 주기 한 명씩 확인한다.
    candidates.sort((a,b)=>Number(b.early)-Number(a.early)||a.state.lastCheck-b.state.lastCheck);
    const candidate = candidates[0];
    if (candidate) {
      delete candidate.state;delete candidate.early;
    }
    return {candidate,alerts};
  }
}
