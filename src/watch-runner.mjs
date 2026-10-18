import { isNotificationHold } from './notification-guard.mjs';
import { MailWatch } from "./watch-mail.mjs";
import { taskIdentity, taskConnectionError } from "./task-identity.mjs";
import { doneMarkerOf } from "./done-marker.mjs";
import { RateLimitRetry, terminal429 } from "./watch-rate-limit.mjs";
import { QueueResume, queuedInputBanner } from "./watch-queue-resume.mjs";
import {
  latestWatchReports,
  normalWatchVerdict,
  watchResponsibility,
  watchAILabel,
} from "./watch-report.mjs";
import { OFFLINE_REASONS } from "./watch-ai.mjs";
import { buildWatchScope, buildSupervisorScope } from "./watch-scope.mjs";
import { SupervisorHealth, observationContext } from "./watch-supervisor-health.mjs";
import { ProgressWatch, WORKER_RECHECK_MS } from "./watch-progress.mjs";
import { assessMissingStartReports, alertedStartReports } from "./watch-start-report.mjs";
import {
  buildCycleEntry,
  cycleRecordDue,
  ioCounter,
  timedCall,
  roundAll,
  accumulateTiming,
} from "./watch-cycle.mjs";
import { USER_RECIPIENT } from "./hierarchy.mjs";
import { runDailyHierarchyPrune } from "./watch-prune.mjs";
import { createOcxRefresher, codexBasis } from "./ocx-refresh.mjs";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  assessQueuedInput,
  assessRoles,
  dedupAlerts,
  filterConfirmedCompletions,
  explainAlertRoute,
  failureEscalation,
} from "./watch.mjs";
import { eligibleStallAlerts } from "./watch-judge.mjs";
import { assessSupervisorIdle, buildIdleNudge } from "./watch-supervisor.mjs";
import { assertSingleWatch, notifyUser, watchProcessName } from "./watch-system.mjs";
import { ALERT_DEDUP_WINDOW_MS } from "./user-notify.mjs";
import { withEffectiveOwner } from "./handover-state.mjs";
import { mailboxLetters } from "./mailbox-state.mjs";
import { shortDigest, readText, collectRoles, absorbDeliveredScreens } from "./watch-roles.mjs";
import {
  clockTime,
  formatAlertBody,
  recordAlert,
  seedAlertState,
  deliverResolution,
  isDatabaseBusy,
} from "./watch-alert-body.mjs";

export { collectRoles, absorbDeliveredScreens } from "./watch-roles.mjs";
export {
  formatAlertBody,
  seedAlertState,
  deliverResolution,
  isDatabaseBusy,
} from "./watch-alert-body.mjs";



// 경보의 실행 키가 어느 업무 하나에 속하면 그 업무 키를 돌려준다(그 업무 글로 보내려고). 역할 단위 경보(실행 키 없음)나
// 못 찾은 경우·여러 업무에 걸친 경우는 undefined → 기본 #브리핑.
export function workKeyOfAlert(alert, identity, works) {
  if (!alert?.taskId) return undefined;
  const key = identity.resolve(alert.taskId).key ?? alert.taskId;
  const owners = (works ?? []).filter(w => (w.executions ?? []).some(x => x.key === key));
  return owners.length === 1 ? owners[0].key : undefined;
}

// 경보가 가리키는 카드·실행 키의 앞부분이 레포다. 키를 모르면 undefined — 추측해서 붙이지 않는다.
export function repoOfAlert(alert, identity) {
  if (!alert?.taskId) return undefined;
  const key = identity.resolve(alert.taskId).key ?? alert.taskId;
  return typeof key === 'string' && key.includes('/') ? key.split('/')[0] : undefined;
}

export async function runWatch({
  runtime = null,
  measure = () => performance.now(),
  floor,
  readEntries,
  readCards = null,
  readWorks = () => [],
  // 사용자 결정 요청 목록. 열린 결정을 올린 감독은 노는 게 아니라 답을 기다리는 것이다(2026-10-05 [kyle]).
  readDecisions = () => [],
  startReportGraceMs = 5 * 60_000,
  completionGraceMs = 15 * 60_000,
  stallAfterMs = 0,
  // 큐 대기의 경보 기준은 정체와 같다 — 입력이 닿지 않은 채 같은 시간을 견딘 것이다.
  queuedAfterMs = stallAfterMs,
  sendAlert,
  // 놀고 있음 본인 알림 전용 전송. 사람이 그 창에서 입력 중이면 미루는 보류 검사를 붙인다(없으면 sendAlert).
  sendNudge = null,
  resume429 = null,
  sendMailReminder = null,
  mailHold = null,
  // 받는 창별 입력 보호 연속 미룸 횟수(watch-notify-hold.mjs). 없으면 세지 않는다.
  holdTracker = null,
  mailUnreadGraceMs = 300_000,
  sendQueueEnter = null,
  record = () => {},
  intervalMs,
  stallN,
  routes,
  superRole,
  parents = new Map(),
  loadHierarchy = null,
  // 하루 한 번 관계표 정리. ({file, now}) => 정리 결과. 없으면(--hierarchy 없음·끔) 정리도 기록도 하지 않는다.
  pruneHierarchy = null,
  idleMs = 15 * 60 * 1_000,
  userNotify = false,
  judgeCmd = null,
  ai = null,
  // 설명 AI(explain-ai.mjs). 감시 AI가 아니다: brief 줄만 쓰고 판정·알림을 하지 않으며 감시 순회를 기다리게 하지 않는다. 없으면 하지 않는다.
  explain = null,
  hierarchyPath = null,
  profilePath = null,
  judgeCooldownMs = 5 * 60 * 1_000,
  now = Date.now,
  spawn = spawnSync,
  signal = null,
  sleep = (ms,signal) => delay(ms,undefined,signal?{signal}:{}),
  print = console.log,
  // cycleReads()가 감싼 읽기의 주기 시작·횟수 통계. 없으면 읽기 횟수를 기록하지 않는다.
  reads = null,
  cpuUsage = previous => process.cpuUsage(previous),
  memoryUsage = () => process.memoryUsage(),
}) {
  if (judgeCmd && !ai) throw new Error("감시AI 보고 실행기가 필요합니다");
  assertSingleWatch(spawn, watchProcessName(process.env.KADAN_HOME || process.env.KADAN_LITE_HOME));
  // 기록 쓰기·알림 전송은 여러 단계에서 불리고 원장 잠금이나 바닥 전송을 기다릴 수 있다.
  // 단계 구간과 별도로 호출 수·총시간·최대시간을 모은다.
  const io = {record:ioCounter(), send:ioCounter()};
  record = timedCall(io.record, record, measure);
  sendAlert = timedCall(io.send, sendAlert, measure);
  const sendToRole = sendAlert;
  sendAlert = (role, message, key, work, repo) => {
    if (role !== USER_RECIPIENT) return sendToRole(role, message);
    const errorText = notifyUser(message, spawn, {kind: "alert", ring: true, key, work, tagRepo: repo, dedupWindowMs: ALERT_DEDUP_WINDOW_MS}).error;
    if (errorText) {
      const error = new Error(`사용자 알림 실패: ${errorText}`);
      error.delivery = "not-sent";
      throw error;
    }
  };
  const rateLimitRetry = new RateLimitRetry({record, resume:resume429});
  const ocxRefresh = createOcxRefresher({record});
  const mailDelivered = new Set();
  const mailWatch = sendMailReminder ? new MailWatch({record,graceMs:mailUnreadGraceMs,hold:mailHold,send:(role,message,pid)=>{
    try { sendMailReminder(role,message,pid); mailDelivered.add(role); }
    catch (error) {
      if (error.delivery === 'sent') mailDelivered.add(role);
      throw error;
    }
  }}) : null;
  const queueResume = new QueueResume({record, sendEnter:sendQueueEnter, sleep,
    readScreen: session => { try { return readText(floor.read(session)); } catch { return null; } }});
  let roleStates = new Map();
  // 감독 세션의 화면 지문·생존 추적. 작업자 상태와 분리해 둔다 — 같은 맵에 넣으면 감독이 정체 AI·완료후보
  // 경로로 흘러든다. 유휴 판정(놀고 있음)과 죽은 감독 건너뛰기에만 쓴다.
  let supervisorStates = new Map();
  let queuedStates = new Map();
  const pendingCompletions = new Map();
  // 재시작 첫 순회에 같은 경보를 다시 본내지 않게, 원장의 미해소 경보를 직전 상태로 복원한다.
  const seeded = seedAlertState(readEntries());
  let activeAlerts = seeded.active;
  const alertRecipients = seeded.recipients;
  const deliveryFailures = new Map();
  const pendingAlerts = new Map(seeded.active.filter(a => a.held).map(a => [a.id, a]));
  const workerChecks = new Map();
  const judgeFailures = new Map();
  // 감시 AI가 인터넷 없음으로 실패한 연속 횟수(호출 대상별). 깨어 있는 동안 3번 이어질 때만 알린다(잠긴 규칙 3, 2026-10-07).
  const offlineFailures = new Map();
  const progressWatch = new ProgressWatch();
  const supervisorHealth = new SupervisorHealth();
  let lastCycleAt = now();
  let lastCycleRecordedAt = null;
  // 감독 본인에게 보낼 놀고 있음 1단 알림 중 사람이 그 창에서 입력 중이라 미룬 것. 경보가 열려 있는 동안 다음 주기에 다시 시도한다.
  const pendingNudges = new Map();
  let hierarchyHash = null;
  let scopeSignature = null;
  const queuedAI = new Map();
  const completedAI = [];
  let activeAI = null;
  let lockFailures = 0;
  // 주기 기록은 5분에 한 번이라, 그 사이 주기들의 시간을 합계·최대로 모아 함께 남긴다.
  let timingWindow = null;

  try { while (!signal?.aborted) {
    // 원장 잠금(SQLITE_BUSY)은 원인이 식별된 실패다. 이번 주기만 건너뛰고 다음 주기에 다시 본다. 같은 오류가
    // 3주기 연속이면 멈추고 보고한다(잠긴 규칙 3). 2026-09-24 22:55: 잠금 오류 한 번에 감시가 종료됐다.
    try {
    const cycleAt = now(),began=measure(),cpuAtStart=cpuUsage();
    // 순회 사이가 크게 벌어졌으면 맥북이 잠들었던 것이다. 잠들기 전후의 인터넷 없음은 이어진 실패로 세지 않는다.
    if (cycleAt - lastCycleAt > Math.max(60_000, intervalMs * 3)) offlineFailures.clear();
    reads?.begin();
    holdTracker?.beginCycle();
    io.record.reset(); io.send.reset();
    let entries = [], mailEntries = [];
    let ledgerError = null;
    try {
      entries = readEntries();
      mailEntries = entries;
    } catch (error) {
      ledgerError = error;
    }
    const ledgerReadAt=measure();
    let hierarchyError = null;
    // 정리를 읽기 앞에 둬서, 줄이 바뀌면 같은 주기의 hierarchy-loaded가 새 표를 읽는다.
    if (pruneHierarchy && hierarchyPath && !ledgerError) {
      runDailyHierarchyPrune({entries, now:cycleAt, file:hierarchyPath, prune:pruneHierarchy, record});
    }
    if (loadHierarchy) {
      try {
        const loaded = loadHierarchy();
        if (loaded.hash !== hierarchyHash) {
          record({kind:"hierarchy-loaded",path:loaded.path,hash:loaded.hash,pid:process.pid,by:"watch"});
          parents = loaded.parents;
          hierarchyHash = loaded.hash;
        }
      } catch (error) { hierarchyError = { id:"hierarchy:unreadable",kind:"모름",level:"AMBER",message:error.message }; }
    }
    let cards = null;
    let cardError = null;
    let scope = null;
    let works = [], supervisorScope = null;
    if (readCards && !ledgerError) {
      try {
        // 워크 owner는 확정된 역할 인계를 따라 지금 책임 감독으로 바꿔 쓴다. 옛 감독 이름 그대로면 감독 점검 범위와
        // 할 일 판정에서 이어 맡은 감독이 빠졌다(PR #99 검수 2). 원장의 owner 원문은 바꾸지 않는다.
        cards = readCards(); works = readWorks().map(w => withEffectiveOwner(w, entries));
        entries = taskIdentity(cards).project(entries).filter(e=>!taskConnectionError(e));
        scope = buildWatchScope(cards, entries, parents, works);
        supervisorScope = buildSupervisorScope(cards, entries, parents, works);
      }
      catch (error) { cardError = error; scope = null; supervisorScope = null; }
    }
    const observationError = ledgerError || cardError;
    const observedSessions = scope ? new Set([...scope.sessions,...supervisorScope.sessions]) : null;
    const currentAI = job => !observationError && (!observedSessions || observedSessions.has(job.candidate.session))
      && job.responsibility === watchResponsibility(job.candidate.role,cards??[],entries,parents,job.candidate.source,works);
    const aiRecipients = new Set();
    for(const {job,result} of observationError?[]:completedAI.splice(0)) {
      if(!currentAI(job)||result.reason==='cancelled')continue;
      for(const recipient of result.deliveredRecipients||[])aiRecipients.add(recipient);
      if(result.deliveredRecipients?.length)print(`[${watchAILabel(job.candidate.source)}] ${job.candidate.role} 보고 전달 → ${result.deliveredRecipients.join(', ')} (호출 ${result.requestId})`);
      const failure=reason=>judgeFailures.set(job.key,{id:`ai-call:${job.key}`,kind:'감시AI오류',level:'AMBER',role:job.candidate.role,
        session:job.candidate.session,taskId:job.candidate.taskId,source:job.candidate.source,reason,
        ...(result.verdict?{judgeVerdict:result.verdict,judgeDeliveredTo:result.deliveredRecipients??[]}:{})});
      // 인터넷 없음·잠자기는 알리지 않고 다음 정기 점검에 다시 부른다. 이전 알림은 그대로 둔다(성공해야 풀린다).
      if(OFFLINE_REASONS.has(result.reason)){
        const count=result.reason==='network'?(offlineFailures.get(job.key)??0)+1:0;
        offlineFailures.set(job.key,count);
        if(count>=3)failure('network');
        continue;
      }
      offlineFailures.delete(job.key);
      if(result.ok)judgeFailures.delete(job.key);
      else failure(result.reason);
    }
    if(!observationError) {
      for(const [role,job] of queuedAI)if(!currentAI(job))queuedAI.delete(role);
      if(activeAI&&!currentAI(activeAI))activeAI.controller.abort();
    }
    let aiStoreError=null;
    if (scope) {
      const signature = JSON.stringify([[...scope.sessions].sort(),[...supervisorScope.sessions].sort()]);
      if (signature !== scopeSignature) {
        record({kind:'watch-scope',by:'watch',pid:process.pid,sessions:[...scope.sessions].sort(),supervisorSessions:[...supervisorScope.sessions].sort()});
        scopeSignature = signature;
      }
      try {
        ai?.reports.retire(entries,cards,parents,works);
        ai?.reports.retryHeld?.(entries,parents);
      }
      catch { aiStoreError={id:'watch-ai:store',kind:'감시AI오류',level:'AMBER',role:'감시 보고 저장소',reason:'report-error'}; }
      for (const [key,failure] of judgeFailures) if (!observedSessions.has(failure.session)) judgeFailures.delete(key);
      for (const key of offlineFailures.keys()) if (!observedSessions.has(`kadan-${key.split(':')[1]}`)) offlineFailures.delete(key);
      // 대상 제외는 사망/회복이 아니다. 이전 비교·AI 결과와 알림을 조용히 퇴역시킨다.
      for (const session of roleStates.keys()) if (!scope.sessions.has(session)) roleStates.delete(session);
      for (const session of supervisorStates.keys()) if (!supervisorScope.sessions.has(session)) supervisorStates.delete(session);
      // 재시작 뒤에도 실제 호출 시각을 재사용한다. 예전 지문 없는 기록은 추측하지 않는다.
      for(const request of entries)if(request.kind==='watch-ai-request'&&request.source!=='supervisor-health'&&request.evidenceDigest){
        const at=Date.parse(request.t),previous=workerChecks.get(request.session);
        if(Number.isFinite(at)&&at<=cycleAt&&(!previous||at>previous.at))workerChecks.set(request.session,
          {at,responsibility:request.responsibility,evidenceDigest:request.evidenceDigest});
      }
      for (const session of workerChecks.keys()) if (!scope.sessions.has(session)) workerChecks.delete(session);
      activeAlerts = activeAlerts.filter(alert => {
        // 큐 대기 경보의 수명은 scope가 아니라 화면 문구가 정한다 — 여기서
        // 퇴역시키면 scope 밖 세션에서 매 주기 알림이 다시 울린다.
        if (alert.kind === '큐대기') return true;
        if (!alert.session || observedSessions.has(alert.session)) return true;
        recordAlert(record, {...alert, kind:'감시제외'}, null, false, true);
        alertRecipients.delete(alert.id); deliveryFailures.delete(alert.id);
        return false;
      });
    }
    const preparedAt=measure();
    const roles = observationError
      ? { observations: new Map(), liveSessions: new Set(), screenAlerts: [] }
      : collectRoles(floor, entries, observedSessions, cards);
    const observedAt=measure();
    // otherMs를 단계별로 나눈다. 감시AI 응답은 주기가 기다리지 않으므로 여기 들어가지 않는다
    // (응답 시간은 watch-ai-call의 durationMs에 따로 남는다).
    const stages={};let lapAt=observedAt;
    const lap=name=>{const at=measure();stages[name]=at-lapAt;lapAt=at;};
    const workerObservations = scope ? new Map([...roles.observations].filter(([s])=>scope.sessions.has(s))) : roles.observations;
    const retrySessions = observationError || !scope ? new Set() : rateLimitRetry.tick({
      observations:workerObservations, tasks:scope.entries, entries, now:cycleAt,
      fresh:(session,seen,taskId,fingerprint)=> {
        try {
          const currentCards=readCards();
          const currentEntries=taskIdentity(currentCards).project(readEntries()).filter(e=>!taskConnectionError(e));
          const currentScope=buildWatchScope(currentCards,currentEntries,parents,readWorks().map(w=>withEffectiveOwner(w,currentEntries)));
          const currentTasks=currentScope.entries.filter(e=>e.role===seen.role);
          if(currentTasks.length!==1||currentTasks[0].taskId!==taskId)return false;
          const lastInput=list=>list.findLast(e=>e.kind==='send'&&e.transport!=='mailbox'&&e.role===seen.role);
          if(JSON.stringify(lastInput(entries))!==JSON.stringify(lastInput(currentEntries)))return false;
          const current=collectRoles(floor,currentEntries,new Set([session])).observations.get(session);
          return current?.alive && String(current.pid)===String(seen.pid) && String(current.expectedPid)===String(seen.pid) &&
            terminal429(current.screen,cycleAt)?.fingerprint===fingerprint;
        } catch { return false; }
      },
    });
    lap('rateLimit');
    // 명시 큐 배너는 AI 판정 없이 결정식으로 먼저 처리한다. Enter를 보낸 세션은 이번 주기의 정체·AI 판정에서 뺀다.
    const queueHandled = observationError || !scope ? new Set() : await queueResume.tick({
      observations:workerObservations, tasks:scope.entries, cards:cards??[], entries, now:cycleAt,
      fresh:(session,seen,taskId,fingerprint)=> {
        try {
          const currentEntries=readEntries();
          const currentScope=buildWatchScope(readCards(),currentEntries,parents,readWorks().map(w=>withEffectiveOwner(w,currentEntries)));
          const currentTasks=currentScope.entries.filter(e=>e.role===seen.role);
          if(currentTasks.length!==1||currentTasks[0].taskId!==taskId)return false;
          const current=collectRoles(floor,currentEntries,new Set([session])).observations.get(session);
          return current?.alive && String(current.pid)===String(seen.pid) && String(current.expectedPid)===String(seen.pid) &&
            queuedInputBanner(current.screen)?.fingerprint===fingerprint;
        } catch { return false; }
      },
    });
    lap('queueResume');
    // 명시 큐 배너가 결정식으로 처리 중인 세션(Enter를 보냈거나 '입력큐' 경보를 낸 세션)은 같은 화면을 두고
    // 정체 AI 판정·'큐대기'를 겹쳐 올리지 않는다. 한 배너에 경보 셋(입력큐·큐대기·정체)이 나가던 중복(2026-10-05).
    const queueSessions = new Set([...queueHandled, ...(queueResume.alerts ?? []).map(a => a.session)]);
    const roleAssessment = observationError
      ? { states: roleStates, alerts: [] }
      : assessRoles(
          roleStates,
          workerObservations,
          cycleAt - lastCycleAt,
          intervalMs,
          stallN
        );
    roleStates = roleAssessment.states;
    // 감독 세션은 지문·생존만 추적한다. 여기서 나온 경보(죽음 등)는 쓰지 않는다 — 감독의 죽음·PID는
    // supervisorHealth가, 유휴는 assessSupervisorIdle이 이 상태로 판단한다.
    if (!observationError && supervisorScope) {
      const supervisorObservations = new Map([...roles.observations].filter(([s]) => supervisorScope.sessions.has(s) && !scope.sessions.has(s)));
      supervisorStates = assessRoles(supervisorStates, supervisorObservations, cycleAt - lastCycleAt, intervalMs, stallN).states;
    }
    // 완료후보는 정상 완료 처리에 시간을 준다. 화면에서 사라져도 done을 재확인한다.
    if (!observationError) {
      const identity = taskIdentity(cards ?? []);
      const dispatchVersion = alert => {
        const key = identity.resolve(alert.taskId).key ?? alert.taskId;
        const sent = roles.observations.get(alert.session)?.completionDispatches.get(key);
        return sent ? JSON.stringify([sent.mailId, sent.t, sent.baselineMarkers, sent.handoverId, sent.handoverAt]) : null;
      };
      // 유예 중 같은 카드가 재발령되면 이전 실행의 후보도 폐기한다.
      for (const [id, pending] of pendingCompletions) {
        if (pending.dispatch !== dispatchVersion(pending.alert)) pendingCompletions.delete(id);
      }
      for (const alert of roleAssessment.alerts) {
        if (alert.kind !== '완료후보' || pendingCompletions.has(alert.id)) continue;
        pendingCompletions.set(alert.id, {alert, at:cycleAt, dispatch:dispatchVersion(alert),
          startedAt:roles.observations.get(alert.session)?.startedAt});
      }
      const visible = new Set(roleAssessment.alerts.map(a => a.id));
      const unconfirmed = new Set(filterConfirmedCompletions(
        [...pendingCompletions.values()].map(p => p.alert), entries, cards
      ).map(a => a.id));
      roleAssessment.alerts = roleAssessment.alerts.filter(a => a.kind !== '완료후보');
      for (const [id, pending] of pendingCompletions) {
        const {alert, at, startedAt} = pending;
        if ((pending.emitted && !visible.has(id)) || !roleStates.get(alert.session)?.alive ||
            !unconfirmed.has(id) || (scope && !scope.sessions.has(alert.session)) ||
            roles.observations.get(alert.session)?.startedAt !== startedAt) {
          pendingCompletions.delete(id);
          continue;
        }
        if (cycleAt - at >= completionGraceMs) {
          roleAssessment.alerts.push(alert);
          pending.emitted = true;
        }
      }
    }
    // 큐 대기는 scope 밖 세션까지 포함한 전체 관측으로 본다 — 발령이 없어 감시
    // 대상이 아니던 작업자가 큐가 쌓인 채 멈춘 사고(2026-09-15)를 잡기 위해서다.
    const queuedAssessment = observationError
      ? { states: queuedStates, alerts: [] }
      : assessQueuedInput(
          queuedStates,
          roles.observations,
          cycleAt - lastCycleAt,
          intervalMs,
          queuedAfterMs
        );
    queuedStates = queuedAssessment.states;
    lap('assess');
    // 설명 AI는 대기열에 넣기까지만 이 순회에서 하고, AI 호출은 뒤에서 따로 돈다. 실패해도 감시를 멈추지 않는다.
    if (explain && !observationError && cards) {
      try { explain.tick({cards, entries, readEntries, decisions: readDecisions(), liveSessions: roles.liveSessions, now: cycleAt}); }
      catch (error) { print(`[watch] 설명 AI 점검 실패: ${error.message}`); }
    }

    const stallAlerts=eligibleStallAlerts(roleAssessment.alerts,roleStates,stallAfterMs).filter(a=>!retrySessions.has(a.session)&&!queueSessions.has(a.session));
    let reportAlerts=[];
    const workerCheck=(candidate,seen)=>{
      const responsibility=watchResponsibility(candidate.role,cards??[],entries,parents,candidate.source,works);
      const context=observationContext(candidate.role,seen,mailEntries,cards??[],scope?.entries??[]);
      const evidenceDigest=shortDigest(JSON.stringify([seen.screen,context.process,context.tasks,context.recentTaskEvents,context.recentMail]));
      const previous=workerChecks.get(candidate.session);
      const same=previous?.responsibility===responsibility;
      const interval=same&&previous.evidenceDigest===evidenceDigest?WORKER_RECHECK_MS:judgeCooldownMs;
      return {responsibility,evidenceDigest,due:!same||cycleAt-previous.at>=interval};
    };
    const invokeAI=candidate=>{
      if(retrySessions.has(candidate.session)||queueSessions.has(candidate.session))return;
      const seen=roles.observations.get(candidate.session);
      if(candidate.source!=='supervisor-health'&&!workerCheck(candidate,seen).due)return;
      const previous=latestWatchReports(entries).find(e=>e.role===candidate.role&&e.source===candidate.source&&e.taskId===(candidate.taskId??null));
      const assigned=scope?.entries.filter(e=>e.role===candidate.role)??[];
      // 짧은 카드id·정식 주소 어느 쪽으로 찍어도 같은 카드다(2026-09-27).
      const identity=taskIdentity(cards??[]),cardOf=(id,key)=>{const found=identity.resolve(id,key);return found.state==='resolved'?found.key:id;};
      const completed=assigned.length===1 && seen?.screen?.split('\n').some(line=>{const m=doneMarkerOf(line);return m&&cardOf(m.taskId)===cardOf(assigned[0].taskId,assigned[0].executionKey);});
      if(candidate.source!=='supervisor-health' && completed && previous?.verdict==='실행완료' && previous.observationDigest===seen?.digest &&
        previous.responsibility===watchResponsibility(candidate.role,cards,entries,parents,candidate.source,works))return;
      const key=`${candidate.source}:${candidate.role}:${candidate.taskId||''}`;
      if(activeAI?.candidate.role===candidate.role)return;
      queuedAI.set(candidate.role,{key,candidate,
        responsibility:watchResponsibility(candidate.role,cards??[],entries,parents,candidate.source,works)});
    };
    if(cards&&!observationError){
      reportAlerts=assessMissingStartReports(cards,entries,workerObservations,cycleAt,startReportGraceMs,{
        states:roleStates,alerted:alertedStartReports(entries),active:new Set(activeAlerts.map(a=>a.id))
      });
      const progress=progressWatch.select({cards,entries,observations:workerObservations,now:cycleAt,
        enabled:Boolean(judgeCmd),blockedSessions:new Set(stallAlerts.map(a=>a.session))});
      if(progress) invokeAI(progress);
    }
    const supervisorCheck=supervisorScope&&!observationError
      ? supervisorHealth.select({scope:supervisorScope,observations:roles.observations,entries,mailEntries,cards,now:cycleAt,enabled:Boolean(judgeCmd)})
      : {candidate:null,alerts:[]};
    if(supervisorCheck.candidate)invokeAI(supervisorCheck.candidate);
    if(cardError) reportAlerts=[{id:'cards:unreadable',kind:'모름',level:'AMBER',screenError:'감시 대상 카드 읽기 실패'}];
    if(judgeCmd&&!observationError){
      const candidates=new Map(stallAlerts.filter(a=>a.id.startsWith('stall:')).map(a=>[a.session,a]));
      // 경보 뒤 화면이 움직여도 정상이라고 추측하지 않는다. 다음 허용 시각에 AI가 다시 확인한다.
      for(const report of latestWatchReports(entries)) {
        if(report.source==='stall'&&!normalWatchVerdict(report.verdict)&&workerObservations.get(report.session)?.screen)
          candidates.set(report.session,report);
      }
      for(const candidate of candidates.values()){
        invokeAI({source:'stall',role:candidate.role,session:candidate.session,input:{
          role:candidate.role,screen:roles.observations.get(candidate.session)?.screen?.slice(-8000)}});
      }
    }
    // 감독의 정기 관찰을 먼저 꺼낸다. 같은 종류 안에서는 대기 순서를 유지한다.
    const orderedAI=[...queuedAI].sort((a,b)=>Number(b[1].candidate.source==='supervisor-health')-Number(a[1].candidate.source==='supervisor-health'));
    if(!activeAI&&!observationError)for(const [role,job] of orderedAI) {
      queuedAI.delete(role);
      if(!currentAI(job))continue;
      const {candidate}=job,seen=roles.observations.get(candidate.session);
      if(!seen?.alive||!seen.screen)continue;
      const check=candidate.source==='supervisor-health'?null:workerCheck(candidate,seen);
      if(check&&!check.due)continue;
      const input={...candidate.input,...observationContext(role,seen,mailEntries,cards??[],
        candidate.source==='supervisor-health'?supervisorScope.entries:scope?.entries??[])};
      if(candidate.source==='stall')input.screen=seen.screen.slice(-8000);
      else input.current=seen.screen.slice(-8000);
      job.controller=new AbortController();activeAI=job;
      if(check){
        workerChecks.set(candidate.session,{at:cycleAt,responsibility:check.responsibility,evidenceDigest:check.evidenceDigest});
        progressWatch.started(candidate.session,seen.screen,cycleAt);
      }else supervisorHealth.started(candidate.session,seen.screen,cycleAt);
      let result;
      try {
        result=ai.run({
          ...candidate,input,observationDigest:seen.digest,evidenceDigest:check?.evidenceDigest??null,
          judgeCmd,parents,routes,superRole,hierarchyPath,userNotify,signal:job.controller.signal
        });
      }
      catch {result={ok:false,reason:'report-error'};}
      job.promise=Promise.resolve(result).catch(()=>({ok:false,reason:'report-error'})).then(result=>{
        completedAI.push({job,result});
        if(activeAI===job)activeAI=null;
      });
      break;
    }
    lap('ai');
    const roleAlerts=judgeCmd?stallAlerts.filter(a=>!a.id.startsWith('stall:')):stallAlerts;
    const stallSessions=new Set(stallAlerts.filter(a=>a.id.startsWith('stall:')).map(a=>a.session));
    // 답을 기다리는 일(2026-10-05 [kyle]): 사용자 결정을 기다리는 카드는 모두에게, 감독이 상위에게 물은 질문 우편(답 대기)이
    // 걸린 카드·워크는 묻는 쪽에게 할 일이 아니다. 답할 쪽에게는 그대로 할 일이다. 감독을 통째로 빼지 않는다 — 다른 일은 그대로 판정한다.
    // 목록을 못 읽으면 아무것도 빼지 않는다(판정을 숨기지 않는다).
    let waits = [];
    try {
      const idOf = key => (cards ?? []).find(c => c.key === key)?.id ?? null;
      const worksOf = key => (works ?? []).filter(w => (w.executions ?? []).some(x => x.key === key)).map(w => `work:${w.key}`);
      const item = (key, taskId, workKey, answerer) => ({ answerer, ids: [taskId, key, idOf(key), ...(key ? worksOf(key) : []), workKey ? `work:${workKey}` : null].filter(Boolean) });
      for (const d of readDecisions() ?? []) if (d?.status === "open" && typeof d.card === "string") waits.push(item(d.card, null, d.work ?? null, "@user"));
      for (const l of mailboxLetters(entries, undefined, { view: "waiting" }))
        if (l.expectReply && !l.replyFinal && !l.notificationOnly && !l.systemGenerated && l.currentRecipient) waits.push(item(l.executionKey, l.taskId, l.workKey, l.currentRecipient));
    } catch { waits = []; }
    // 한도 경보가 처음 생길 때만, 그 세션이 codex일 때 ocx 사용량을 새로 받고 결과를 경보에 붙인다(ocx-refresh.mjs).
    // 순회 안에서 동기로 부른다: 30분에 1번·30초 상한이라 순회를 길게 막지 않고, 같은 순회의 경보 본문에 결과를 바로 실을 수 있다.
    // 실패·없음이어도 경보 전달과 429 재개 예약은 그대로다.
    if(!ledgerError){
      const known=new Set(activeAlerts.map(a=>a.id));
      for(const a of [...roleAlerts,...(!observationError?rateLimitRetry.alerts??[]:[])]){
        if(a.kind!=='한도'||known.has(a.id)||a.ocx||retrySessions.has(a.session))continue;
        if(!codexBasis(entries,a.role))continue;
        try{a.ocx=ocxRefresh({entries,now:cycleAt,trigger:{role:a.role,session:a.session}});}catch{}
      }
    }
    const nextAlerts = [
      ...(hierarchyError ? [hierarchyError] : []),
      ...(aiStoreError ? [aiStoreError] : []),
      // 429 재개가 예약된 세션의 '한도' 경보는 새로 알리지 않는다. 다만 이미 알린 경보는 화면에 429가 남아 있는 동안
      // 통지 없이 그대로 이월한다 — 숨기면 dedup이 해소로 보고 '한도 → 해소됨'이 깜빡였다(2026-10-05 점검 보고서 2-M2).
      ...roleAlerts.filter(a=>!(a.kind==='한도'&&(retrySessions.has(a.session)||rateLimitRetry.alerts?.some(r=>r.session===a.session)))),
      ...activeAlerts.filter(a=>a.kind==='한도'&&retrySessions.has(a.session)&&roleAssessment.alerts.some(r=>r.id===a.id)),
      // 큐대기 상태 추적은 그대로 두고 경보만 거른다 — 배너 경로가 조용해지면 쌓인 시간으로 큐대기가 이어받는다.
      ...queuedAssessment.alerts.filter(a=>!queueSessions.has(a.session)),
      ...(!observationError ? rateLimitRetry.alerts ?? [] : []),
      ...(!observationError ? queueResume.alerts ?? [] : []),
      // 알림이 3번 이상 연속 밀린 창. 지난 주기까지의 횟수이며 사용자에게만 간다.
      ...(!observationError && holdTracker ? holdTracker.alerts() : []),
      ...reportAlerts,
      ...judgeFailures.values(),
      ...roles.screenAlerts.filter(a=>!supervisorScope?.sessions.has(a.session)),
      ...supervisorCheck.alerts,
      // 유휴 판정은 작업자뿐 아니라 감독 세션(상위가 있는 감독·최상위 감독)에도 닿는다.
      // 이전에는 작업 감시 범위로만 걸러 등록된 감독에게는 영원히 가지 않았다(2026-10-05, hierarchy.md 2-H1).
      ...assessSupervisorIdle(
        scope?.entries ?? entries,
        new Map([...roleStates, ...supervisorStates]),
        cycleAt,
        idleMs,
        ledgerError,
        parents,
        { works, cards: cards ?? [], waits, peerEntries: observationError ? [] : mailEntries }
      ).filter(a=>(!observedSessions || !a.session || observedSessions.has(a.session)) && (!cardError || a.id === 'ledger:unreadable') && (a.kind!=="놀고 있음"||!stallSessions.has(a.session))

        // 감독의 세션 부재·화면 없음은 감독 점검이 이미 알린다. 같은 세션에 '모름'을 겹쳐 올리지 않는다.
        && !supervisorCheck.alerts.some(s=>s.session===a.session)),
      ...(observationError ? activeAlerts.filter(a=>a.session) : []),
    ];
    const sourceIds = new Set(nextAlerts.map(alert => alert.id));
    nextAlerts.push(...[...deliveryFailures.values()].filter(alert => sourceIds.has(alert.sourceAlertId)));
    const changes = dedupAlerts(activeAlerts, nextAlerts);
    const deliveredRecipients = aiRecipients;
    // 놀고 있음 1단은 상위가 아니라 감독 본인에게 간다(2026-10-05 [kyle]). 사람이 그 창에서 입력 중이면 미루고 다음 주기에 다시.
    const sendIdleNudge = (alert, retry = false) => {
      if (retry || pendingNudges.has(alert.id)) {
        if (!recordAlert(record, {...alert, held:false}, alert.role, false)) {
          pendingNudges.set(alert.id, alert);
          return false;
        }
      }
      const message = `[watch ${clockTime(cycleAt)}] ${buildIdleNudge(alert)}`;
      let target = alert.role, held = false, delivered = false;
      try {
        (sendNudge ?? sendAlert)(alert.role, message);
        delivered = true;
        deliveredRecipients.add(alert.role);
      } catch (error) {
        held = isNotificationHold(error);
        target = `${alert.role} ${held ? '미룸' : '전달 실패'}(${error.message})`;
      }
      if (held) pendingNudges.set(alert.id, alert); else pendingNudges.delete(alert.id);
      print(`${message} → ${target}`);
      return delivered;
    };
    // 이전 주기에 보류된 1단 알림. 이번 주기의 새 보류는 다음 주기에 다시 본다.
    const heldNudges = new Map(pendingNudges);
    const retryAlerts = [...pendingAlerts.values()].filter(a => !observationError && sourceIds.has(a.id)
      && !changes.notify.some(n => n.id === a.id)).map(a => nextAlerts.find(n => n.id === a.id));
    let alertIdentity = null;
    const workOfAlert = alert => workKeyOfAlert(alert, alertIdentity ??= taskIdentity(cards ?? []), works);
    const repoOf = alert => repoOfAlert(alert, alertIdentity ??= taskIdentity(cards ?? []));
    for (const alert of [...changes.notify, ...retryAlerts]) {
      const retry = pendingAlerts.delete(alert.id);
      if (deliveryFailures.has(alert.id)) continue;
      if (alert.kind === "놀고 있음" && alert.stage !== 2) {
        const delivered = sendIdleNudge(alert, retry);
        if (delivered) alertRecipients.set(alert.id, alert.role);
        recordAlert(record, {...alert, held:pendingNudges.has(alert.id), route:{recipient:alert.role, basis:'본인'}}, alert.role, delivered);
        continue;
      }
      const message = `[watch ${clockTime(cycleAt)}] ${formatAlertBody(alert)}`;
      const route = explainAlertRoute(
        alert,
        routes,
        // 조회 실패(observationError)는 사망이 아니라 모름이다 — 생존 검사를 건너뛴다.
        observationError ? null : roles.liveSessions,
        superRole,
        parents
      );
      const recipient=route.recipient;
      let target = "stdout";
      const failureRecipient = failureEscalation(recipient, routes, observationError ? null : roles.liveSessions, superRole, parents);
      let delivered = false, held = false;
      if (recipient) {
        if (retry && !recordAlert(record, {...alert,route,held:false}, recipient, false)) {
          pendingAlerts.set(alert.id, alert);
          continue;
        }
        try {
          sendAlert(recipient, message, `alert:${alert.id}:${alert.level ?? ""}`, workOfAlert(alert), repoOf(alert));
          delivered = true;
          target = recipient;
          if (!alertRecipients.has(alert.id)) {
            alertRecipients.set(alert.id, recipient);
          }
          deliveredRecipients.add(recipient);
        } catch (error) {
          target = `${recipient} 전달 실패(${error.message})`;
          if (isNotificationHold(error)) {
            held = true;
            pendingAlerts.set(alert.id, alert);
            target = `${recipient} 알림 미룸(${error.message})`;
          } else if (error.delivery === "sent") {
            alertRecipients.set(alert.id, recipient);
            deliveredRecipients.add(recipient);
          } else if (error.delivery === "not-sent" && failureRecipient && recipient !== failureRecipient && recipient !== USER_RECIPIENT) {
            const escalation = {
              id: `delivery-failed:${alert.id}:${recipient}`,
              kind: "전달실패",
              level: alert.level,
              sourceAlertId: alert.id,
              sourceKind: alert.kind,
              sourceBody: formatAlertBody(alert),
              failedRecipient: recipient,
              deliveryError: error.message,
            };
            const escalationMessage = `[watch ${clockTime(cycleAt)}] ${formatAlertBody(escalation)}`;
            let escalationTarget = failureRecipient;
            let escalationDelivered = false;
            try {
              sendAlert(failureRecipient, `${escalationMessage} → ${failureRecipient}`);
              escalationDelivered = true;
              alertRecipients.set(alert.id, failureRecipient);
              deliveryFailures.set(alert.id, escalation);
              deliveredRecipients.add(failureRecipient);
            } catch (escalationError) {
              escalationTarget = `${failureRecipient} 전달 실패(${escalationError.message})`;
            }
            recordAlert(record, escalation, failureRecipient, escalationDelivered);
            print(`${escalationMessage} → ${escalationTarget}`);
          }
        }
      }
      recordAlert(record, {...alert,route,held}, recipient ?? null, delivered);
      if (!held && recipient !== USER_RECIPIENT && userNotify && (alert.level === "RED" || alert.kind === "죽음")) {
        const notifyError = notifyUser(message, spawn, {kind: "alert", ring: true, key: `alert:${alert.id}:${alert.level ?? ""}:겹알림`, work: workOfAlert(alert), tagRepo: repoOf(alert), dedupWindowMs: ALERT_DEDUP_WINDOW_MS}).error;
        if (notifyError) target += `; 사용자 알림 실패(${notifyError})`;
      }
      print(`${message} → ${target}`);
    }
    for (const alert of changes.absorbed) {
      alertRecipients.delete(alert.id);
      deliveryFailures.delete(alert.id);
      pendingNudges.delete(alert.id);
      pendingAlerts.delete(alert.id);
      // 감독 멈춤 1단이 2단으로 올라간 것: 풀린 게 아니므로 '해소됨'을 찍지 않는다. 다만 열린 경보로 남지 않게
      // escalatedTo를 붙여 닫힘 기록만 남긴다(대시보드는 마지막 기록이 resolved면 닫힌 것으로 센다).
      if (alert.kind === "놀고 있음" && sourceIds.has(`${alert.id}:상위`)) recordAlert(record, {...alert, escalatedTo:`${alert.id}:상위`}, null, false, true);
    }
    for (const alert of changes.resolved) {
      if (alert.kind === "전달실패") continue;
      deliveryFailures.delete(alert.id);
      pendingNudges.delete(alert.id);
      pendingAlerts.delete(alert.id);
      if (alert.kind === "감시AI오류") { recordAlert(record,alert,null,false,true); continue; }
      const recipient = deliverResolution({
        alert,
        recipients: alertRecipients,
        cycleAt,
        sendAlert,
        print,
        record,
      });
      if (recipient) deliveredRecipients.add(recipient);
    }
    // 보류됐던 1단 알림 재시도: 경보가 아직 열려 있는 동안만. 전달되면 그때 기록한다.
    for (const [id, alert] of heldNudges) {
      if (observationError || !sourceIds.has(id)) { pendingNudges.delete(id); continue; }
      const delivered = sendIdleNudge(alert);
      if (delivered) alertRecipients.set(id, alert.role);
      recordAlert(record, {...alert, held:pendingNudges.has(id),
        route:{recipient:alert.role, basis:'본인'}}, alert.role, delivered);
    }
    lap('alerts');
    let mailError = false;
    if (mailWatch && !observationError) {
      try {
        mailWatch.tick({entries:mailEntries,cards:cards??[],works,now:cycleAt,
          floor,readEntries,readCards:readCards??(()=>[]),readWorks,signal,parents});
        mailError = mailWatch.failed;
      } catch (error) {
        mailError = true;
        print(`[watch] 미확인 우편 감시 실패: ${error.message}`);
        try { record({kind:'watch-mail-reminder',by:'watch',action:'error',phase:'cycle',
          reason:'mail-reminder-cycle-failed',error:error.message,t:new Date(cycleAt).toISOString()}); }
        catch (storeError) { print(`[watch] 우편 감시 실패 기록 오류: ${storeError.message}`); }
      }
      for (const role of mailDelivered) deliveredRecipients.add(role);
      mailDelivered.clear();
    }
    // 관찰 실패 주기에는 전송을 시도하지 않았으므로 연속 횟수를 건드리지 않는다.
    if (!observationError) holdTracker?.endCycle(cycleAt);
    lap('mail');
    const absorbed = observationError ? {states:roleStates,screenAlerts:[]} : absorbDeliveredScreens(floor, roleStates, deliveredRecipients);
    roleStates = absorbed.states;
    // 감독 창에 넣은 글(놀고 있음 1단 등)도 그 감독의 화면 변화로 세지 않는다. 안 그러면 알림 자체가 경보를 닫고
    // idleMs 뒤 다시 울리는 타이머가 된다(없앤 --wake와 같은 모양).
    if (!observationError) supervisorStates = absorbDeliveredScreens(floor, supervisorStates, deliveredRecipients).states;
    // Absorption belongs to this cycle's baseline, not a second delivery pass.
    activeAlerts = [...new Map(
      [...changes.active, ...deliveryFailures.values(), ...absorbed.screenAlerts].map(alert => [alert.id, alert])
    ).values()];
    lap('absorb');
    const finished=measure();
    const cpu=cpuUsage(cpuAtStart);
    // 주기 사건 자신의 기록 쓰기는 이 시간에 들어가지 않는다(쓰기 전에 계산한다).
    const sample={totalMs:finished-began,ledgerMs:ledgerReadAt-began,prepareMs:preparedAt-ledgerReadAt,screenMs:observedAt-preparedAt,otherMs:finished-observedAt,
      stages:roundAll(stages),cpuMs:roundAll({user:cpu.user/1000,system:cpu.system/1000}),
      ...(reads?{reads:reads.stats()}:{}),record:io.record.stats(),send:io.send.stats()};
    timingWindow=accumulateTiming(timingWindow,sample);
    reads?.end?.(); // 다음 주기 시작까지 원장 전체 사본을 쥐지 않는다.
    // 주기 완료 증거. 프로세스 생존과 구분해 대시보드가 마지막 주기·설정·공백을 읽는다.
    if (cycleRecordDue(lastCycleRecordedAt, cycleAt)) {
      try {
        const memory=memoryUsage();
        const timing={totalMs:sample.totalMs,ledgerMs:sample.ledgerMs,prepareMs:sample.prepareMs,screenMs:sample.screenMs,otherMs:sample.otherMs,
          observedSessions:[...roles.observations.values()].filter(r=>r.alive).length,
          stages:sample.stages,cpuMs:sample.cpuMs,...(sample.reads?{reads:sample.reads}:{}),record:sample.record,send:sample.send,
          memoryMb:roundAll({rss:memory.rss/2**20,heapUsed:memory.heapUsed/2**20}),window:timingWindow};
        record(buildCycleEntry({runtime,timing,pid: process.pid, hierarchyPath, hierarchyHash, judge: Boolean(judgeCmd), profile: profilePath, intervalMs, routes, superRole,
          sessions: scope ? [...scope.sessions] : null, supervisorSessions: supervisorScope ? [...supervisorScope.sessions] : null, ok: !observationError && !mailError}));
        // 기록에 성공한 뒤에만 비운다. 잠금으로 실패하면 모은 주기를 다음 기록에 이어 싣는다.
        timingWindow=null;
        lastCycleRecordedAt = cycleAt;
      } catch (error) { console.error(`감시 주기 기록 실패: ${error.message}`); }
    }
    lastCycleAt = cycleAt;
    lockFailures = 0;
    } catch (error) {
      if (!isDatabaseBusy(error)) throw error;
      lockFailures++;
      print(`[watch] 원장 잠금으로 이번 주기를 건너뜀 (${lockFailures}/3): ${error.message}`);
      if (lockFailures >= 3) throw error;
    }
    // 재사용 자료를 대기 동안 붙잡아 두지 않는다(기존처럼 주기가 끝나면 버릴 수 있게).
    reads?.begin();
    try {await sleep(intervalMs,signal);}
    catch(error) {if(!signal?.aborted)throw error;}
  }} finally {
    queuedAI.clear();
    await explain?.stop();
    if(activeAI){const job=activeAI;job.controller.abort();await job.promise;}
  }
}
