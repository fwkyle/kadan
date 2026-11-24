import {recentLetters} from './mailbox-queries.mjs';
import {workEntries} from './handover-state.mjs';
import {taskIdentity} from './task-identity.mjs';
import {SUPERVISOR_ERROR_PATTERN} from './watch-stop-phrases.mjs';
import {statusProgress} from './watch-status-line.mjs';
import {readToolTimeout} from './watch-tool-timeout.mjs';
import {changeDigest} from './watch-roles.mjs';
import {decisionFields} from './watch-waits.mjs';
import {resultOfDispatch} from './watch-scope.mjs';
import {intendedStop} from './lifecycle-tail.mjs';
// 감독의 정상 대기는 멈춤이 아니다. 시간·오류 지속 후보만 고르고 판단은 감시ai가 한다.
export const SUPERVISOR_CHECK_MS = 60 * 60_000;
export const SUPERVISOR_ERROR_MS = 5 * 60_000;
// 일하는 표시가 있는 화면은 '시계가 안 나아간 채 이 시간 이어진 것'을 이 감시기가 직접 본 뒤에만 정기 후보를 낸다.
// 상태를 막 만든 첫 순회·일을 막 시작한 순회는 직전 시계가 없어(null) 안 나아감으로 읽히기 때문이다(2026-11-24 헛경보 8건).
// 셈은 감시기 메모리에 있어 재시작·감시 대상 재진입마다 처음부터라서, 진짜 멈춤을 늦게 보는 양은 재시작 1회당 최대 이 시간이다.
export const SUPERVISOR_STILL_MS = 5 * 60_000;
// 같은 화면 재사용: 원장의 마지막 요청 뒤 이 시간이 지나면 같은 화면이어도 정기 확인을 한 번 부른다(재시작해도 유지).
export const SUPERVISOR_REUSE_MS = 4 * 60 * 60_000;
// 도구 줄 `Running… (… · timeout T)`이 화면 끝 상태 구역에 있는 동안, 처음 본 시각 + T(최대 60분) + 이 여유까지는 정기 후보를 내지 않는다.
export const SUPERVISOR_TOOL_GRACE_MS = 60_000;
const REUSABLE_VERDICTS = new Set(['입력대기', '실행완료']);
const errorPattern = SUPERVISOR_ERROR_PATTERN; // 작업자 감시와 같은 목록(watch-stop-phrases.mjs)

// decisions: 이번 순회에 한 번 읽은 결정 목록(못 읽었으면 null, 안 넘기면 결정 필드를 싣지 않는다).
// outside: 감독 점검의 AI 호출 직전(watch-runner.mjs)에만 넘긴다. {keys, now} — 대기 표시로 작업자 화면 감시에서 빠진
//   실행의 키(감시 범위의 waitingSessions)와 지금 시각.
//   그 실행의 항목에만 outsideScreenWatch·activityAt·waitingMinutes를 싣는다. 안 넘기면(작업자 감시) 항목은 예전 그대로다.
//   Why: 2026-11-18 감독 점검은 activity:"waiting"만 보고 "하위 결과 대기 = 정상"으로 판정했다. 그 하위가 22시간 동안
//   화면 감시 밖에서 멈춰 있었다는 것은 관찰 자료에 없었다.
export function observationContext(role, observation, entries, cards, tasks, decisions, outside = null) {
  const identity=taskIdentity(cards);
  const outsideFields = c => {
    if (!outside?.keys?.has(c.key ?? identity.taskIdFor(c))) return {};
    const minutes = Math.floor((outside.now - Date.parse(c.activityAt)) / 60_000);
    return {outsideScreenWatch:true, activityAt:c.activityAt ?? null,
      ...(Number.isFinite(minutes) ? {waitingMinutes:Math.max(0, minutes)} : {})};
  };
  const own = tasks.filter(e => e.role === role);
  const ids = new Set(own.map(e => e.taskId));
  // 지금 담당(감독의 항목이면 subject)이 이번 발령 뒤에 등록한 결과만 지금 결과다. 재발령 전 담당이 남긴 결과는 싣지 않는다.
  const currentResult = c => own.some(e => e.taskId === identity.taskIdFor(c) && resultOfDispatch(c, e.subject ?? e.role, e));
  return {
    ...(decisions===undefined?{}:decisionFields(decisions,role)),
    process:{alive:observation.alive,pid:observation.pid,expectedPid:observation.expectedPid},
    // 담당이 결과를 등록했는지도 싣는다. activity만 보면 결과를 등록하고 확정을 기다리는 실행이 '아직 일하는 중'으로 읽힌다.
    tasks:cards.filter(c => ids.has(identity.taskIdFor(c))).map(c => ({id:c.id,title:c.title,status:c.status,activity:c.activity,...outsideFields(c),
      ...(currentResult(c)?{resultReportedAt:c.result.at,resultOutcome:c.result.outcome}:{}),scope:c.scope?.slice(0,1000)})),
    responsibilities:tasks.filter(e => e.role === role),
    recentTaskEvents:workEntries(entries,identity).filter(e => e.kind === 'done' && (e.role === role || e.by === role))
      .slice(-12).map(e => ({at:e.t,kind:e.kind,role:e.role,by:e.by,taskId:e.taskId,executionKey:e.executionKey,result:e.result})),
    recentMail:recentLetters(entries, role).map(e => ({at:e.t,kind:e.kind,mailId:e.mailId,from:e.by,to:e.role,
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
  select({scope,observations,entries,mailEntries=entries,cards,now,enabled,ownTurn=null,decisions}) {
    for (const session of this.states.keys()) if (!scope.sessions.has(session)) this.states.delete(session);
    const candidates = [], alerts = [];
    for (const session of scope.sessions) {
      const seen = observations.get(session), role = session.slice(6);
      if (!seen || !seen.alive || seen.screen == null || seen.expectedPid != null && String(seen.pid) !== String(seen.expectedPid)) {
        const kind = seen?.alive === false ? '죽음' : '모름';
        // 상위가 kadan stop으로 일부러 끈 감독은 알릴 일이 아니다. 예기치 않은 죽음만 알린다.
        if (kind === '죽음' && intendedStop(entries, session)) continue;
        alerts.push({id:`supervisor-health:${session}`,kind,level:kind === '죽음'?'RED':'AMBER',role,session,
          screenError:!seen?'감독 시작 기록 없음':seen.screenError || (seen.alive?'감독 PID 또는 화면 확인 필요':'감독 세션 없음')});
        continue;
      }
      let state = this.states.get(session);
      if (!state || String(state.pid) !== String(seen.pid)) {
        const previous = entries.findLast(e => e.kind === 'watch-ai-request' && e.source === 'supervisor-health' && e.session === session && Date.parse(e.t) >= Date.parse(seen.startedAt));
        state = {pid:seen.pid,at:now,screen:seen.screen.slice(-8000),lastCheck:Number.isFinite(Date.parse(previous?.t))?Date.parse(previous.t):now,errorSince:null,errorChecked:false,workClock:null,prevScreen:seen.screen.slice(-8000),tool:null,working:false,stillSince:null};
        this.states.set(session,state);
      }
      const error = errorPattern.test(seen.screen.split('\n').slice(-20).join('\n'));
      if (!error) { state.errorSince=null;state.errorChecked=false; }
      else if (state.errorSince == null) state.errorSince=now;
      // 감독 오류(errorPattern)가 보이는 화면에서는 진행 중 판정을 쓰지 않는다(early·hourly 모두 main과 같다). 오류가 없을 때만 직전 순회 대비 진행 중이면 정기 후보를 내지 않는다(작업자 감시와 같은 공용 판정). 시계·화면은 후보 여부와 무관하게 매 순회 갱신한다.
      const progress = statusProgress(seen.screen, state.workClock);
      const previousScreen = state.prevScreen, previousClockSec = state.workClock;
      const working = progress.status?.kind === 'working';
      state.workClock = working ? progress.status.clockSec : null;
      state.prevScreen = seen.screen.slice(-8000);
      // 일하는 화면의 '안 나아감' 셈: 일을 막 시작했거나(직전 순회가 일하는 화면이 아님·상태를 새로 만든 첫 순회) 시계가 나아간 순회가
      // 셈의 시작점이다. 그 뒤 시계가 같거나 못 읽혀도(clockSec null) 시작점을 그대로 둔다. 일하는 표시가 없으면 셈을 비운다.
      if (!working) state.stillSince = null;
      else if (!state.working || progress.moving || state.stillSince == null) state.stillSince = now;
      state.working = working;
      // 도구 줄 timeout 안: 상태 구역(실제 입력창 바로 위 스피너 + 그 위 도구 줄)이 확정될 때만 읽는다. 같은 도구 = 경과 표시를 뺀 도구 줄 + T라서 경과만 바뀌어도 처음 본 감시기 시각은 그대로고, 쓰는 T는 최대 60분이라 한 도구의 억제는 처음 본 뒤 최대 61분이다. 도구 줄이 없어지거나 T가 달라지면 다시 센다. 오류 화면·구역 미확정·T 못 읽음은 억제하지 않는다. 상태는 후보 여부와 무관하게 매 순회 갱신한다.
      const tool = readToolTimeout(seen.screen);
      if (!tool) state.tool = null;
      else if (state.tool?.key !== tool.key) state.tool = {key:tool.key,since:now,timeoutMs:tool.timeoutMs};
      const inToolTimeout = !error && state.tool != null && now < state.tool.since + state.tool.timeoutMs + SUPERVISOR_TOOL_GRACE_MS;
      const early = error && !state.errorChecked && now-state.errorSince >= SUPERVISOR_ERROR_MS;
      // 일하는 표시가 있는 화면이 아직 N분 안 나아갔다고 확인되지 않았으면 정기 후보를 미룬다. lastCheck는 건드리지 않아 N분이 차면 바로 나간다.
      // 오류 화면은 미루지 않는다(early·hourly가 그대로다).
      const stillWait = !error && working && now - state.stillSince < SUPERVISOR_STILL_MS;
      // 같은 화면 재사용: 지난 관찰AI가 정상으로 판정한 그 화면(changeDigest 같음)이고 오류·본인 차례가 없으면 정기 확인을 부르지 않는다. 화면 모양은 해석하지 않는다. 하나라도 아니면 그대로 부른다.
      const quiet = !error && now-state.lastCheck >= SUPERVISOR_CHECK_MS && ownTurn != null && !ownTurn.has(role) && sameAsJudgedNormal(entries, session, seen.screen, now);
      if (enabled && (early || (error || !progress.moving) && !stillWait && !inToolTimeout && !quiet && now-state.lastCheck >= SUPERVISOR_CHECK_MS)) {
        candidates.push({state,early,source:'supervisor-health',role,session,input:{
          ...observationContext(role,seen,mailEntries,cards,scope.entries,decisions),
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
