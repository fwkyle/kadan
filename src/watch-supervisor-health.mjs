import {mailboxLetters} from './mailbox-state.mjs';
import {workEntries} from './handover-state.mjs';
import {taskIdentity} from './task-identity.mjs';
// 감독의 정상 대기는 멈춤이 아니다. 시간·오류 지속 후보만 고르고 판단은 감시ai가 한다.
export const SUPERVISOR_CHECK_MS = 60 * 60_000;
export const SUPERVISOR_ERROR_MS = 5 * 60_000;
const errorPattern = /stream disconnected|stream error|idle timeout waiting for SSE|Error running remote compact task|Reconnecting\.\.\.|502 Bad Gateway|Provider unreachable|rate limit|No API key/iu;

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
        read:e.read,expectReply:e.expectReply,replyStatus:e.replyStatus,replyFinal:e.replyFinal,
        preview:e.preview?.slice(0,400)})),
  };
}

export class SupervisorHealth {
  states = new Map();
  started(session,screen,now) {
    const state=this.states.get(session);
    if(!state)return;
    state.lastCheck=now;state.at=now;state.screen=screen.slice(-8000);
    if(state.errorSince!=null)state.errorChecked=true;
  }
  select({scope,observations,entries,mailEntries=entries,cards,now,enabled}) {
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
        state = {pid:seen.pid,at:now,screen:seen.screen.slice(-8000),lastCheck:Number.isFinite(Date.parse(previous?.t))?Date.parse(previous.t):now,errorSince:null,errorChecked:false};
        this.states.set(session,state);
      }
      const error = errorPattern.test(seen.screen.split('\n').slice(-20).join('\n'));
      if (!error) { state.errorSince=null;state.errorChecked=false; }
      else if (state.errorSince == null) state.errorSince=now;
      const early = error && !state.errorChecked && now-state.errorSince >= SUPERVISOR_ERROR_MS;
      if (enabled && (early || now-state.lastCheck >= SUPERVISOR_CHECK_MS)) {
        candidates.push({state,early,source:'supervisor-health',role,session,input:{
          ...observationContext(role,seen,mailEntries,cards,scope.entries),
          check:early?'persistent-error':'hourly',minutes:Math.floor((now-state.at)/60000),
          errorMinutes:error?Math.floor((now-state.errorSince)/60000):0,
          previous:state.screen,current:seen.screen.slice(-8000),
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
