import {MailWatch} from './watch-mail.mjs';
import {taskIdentity,taskConnectionError} from './task-identity.mjs';
import {doneMarkerOf,findDoneMarkers,diffDoneMarkers} from './done-marker.mjs';
import {RateLimitRetry,terminal429} from './watch-rate-limit.mjs';
import {QueueResume,queuedInputBanner} from './watch-queue-resume.mjs';
import {latestWatchReports,normalWatchVerdict,watchResponsibility,watchAILabel} from './watch-report.mjs';
import {buildWatchScope,buildSupervisorScope} from './watch-scope.mjs';
import {SupervisorHealth,observationContext} from './watch-supervisor-health.mjs';
import {ProgressWatch,WORKER_RECHECK_MS} from './watch-progress.mjs';
import {assessMissingStartReports,alertedStartReports} from './watch-start-report.mjs';
import {buildCycleEntry,cycleRecordDue,ioCounter,timedCall,roundAll,accumulateTiming} from './watch-cycle.mjs';
import { USER_RECIPIENT } from "./hierarchy.mjs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {setTimeout as delay} from 'node:timers/promises';
import {
  DISCONNECT_ALERT_KINDS,
  assessQueuedInput,
  assessRoles,
  dedupAlerts,
  filterConfirmedCompletions,
  routeAlert,
  explainAlertRoute,
} from "./watch.mjs";
import { eligibleStallAlerts } from "./watch-judge.mjs";
import {
  assessSupervisorIdle,
  buildIdleNudge,
} from "./watch-supervisor.mjs";
import { assertSingleWatch, notifyUser } from "./watch-system.mjs";
import { effectiveWorkOwner } from "./handover-state.mjs";
import { mailboxLetters } from "./mailbox-state.mjs";

function shortDigest(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function readText(value) {
  if (typeof value === "string") return value;
  return typeof value?.text === "string" ? value.text : null;
}

function latestStarts(entries) {
  const starts = new Map();
  for (const entry of entries) {
    if (
      entry?.kind === "start" &&
      typeof entry.session === "string" &&
      entry.session.startsWith("kadan-")
    ) {
      starts.set(entry.session, entry);
    }
  }
  return starts;
}

function startTimeMs(entry) {
  const at = Date.parse(entry?.t);
  return Number.isFinite(at) ? at : 0;
}

export function collectRoles(selectedFloor, entries, monitoredSessions = null, cards = null) {
  const liveItems = selectedFloor.list();
  const liveBySession = new Map(
    liveItems
      .filter((item) => item.alive !== false)
      .map((item) => [item.session, item])
  );
  const starts = latestStarts(entries);
  const identity = taskIdentity(cards ?? []);
  const taskKey = (id, key) => {
    const found = identity.resolve(id, key);
    if (found.state === 'resolved') return found.key;
    if (cards == null) return key || id;
    return found.state === 'unregistered' ? id : null;
  };
  // 6줄 제한을 없애되, 현재 세대에 실제 발령한 카드와 발령 전 화면을 함께 대조한다.
  const dispatches = new Map(), generations = new Map();
  for (const entry of entries) {
    if (entry?.kind === 'start') {
      const previous = generations.get(entry.session);
      const pid = entry.panePid ?? entry.rottiePid;
      // start는 살아 있는 세션을 다시 열 때도 기록된다. 창의 reused 값과 프로세스 세대는 별개다.
      const reused = previous && pid != null && String(pid).trim() !== '' &&
        String(pid) === String(previous.panePid ?? previous.rottiePid) && previous.role === entry.role &&
        (previous.floor ?? 'tmux') === (entry.floor ?? 'tmux') &&
        (entry.floor !== 'rottie' || previous.rottieTerminalId === entry.rottieTerminalId);
      if (!reused) {
        generations.set(entry.session, entry);
        dispatches.set(entry.session, new Map());
      }
      continue;
    }
    if (entry?.kind === 'stop') {
      generations.delete(entry.session);
      // 종료된 선임도 확정 인계할 수 있다. 발령은 인계에만 남기고 다음 start에서는 비운다.
      continue;
    }
    if (entry?.kind === 'handover' && entry.phase === 'transferred') {
      const from = `kadan-${entry.from}`, to = `kadan-${entry.to}`;
      const source = dispatches.get(from), target = dispatches.get(to);
      if (from === to || !source || !target || !generations.has(to)) continue;
      for (const id of entry.taskIds ?? []) {
        const key = taskKey(id), sent = source.get(key);
        if (!key || !sent) continue;
        target.set(key, {...sent, role:entry.to, session:to, handoverId:entry.handoverId, handoverAt:entry.t});
        source.delete(key);
      }
      continue;
    }
    if (entry?.kind !== 'send' || !entry.taskId || entry.transport === 'mailbox' || entry.notificationOnly || taskConnectionError(entry)) continue;
    const key = taskKey(entry.taskId, entry.executionKey);
    if (key && entry.role === generations.get(entry.session)?.role) dispatches.get(entry.session)?.set(key, entry);
  }
  const observations = new Map();
  const screenAlerts = [];
  for (const [session, start] of starts) {
    const monitored =
      monitoredSessions == null || monitoredSessions.has(session);
    const live = liveBySession.get(session);
    const role = start.role ?? session.slice("kadan-".length);
    const expectedPid = start.panePid ?? start.rottiePid ?? null;
    let screen = null;
    let screenError = null;
    // 카드가 없는 세션도 화면은 읽는다 — 큐에 쌓인 입력은 발령과 무관하게 생긴다.
    // 다만 화면 읽기 실패 경보의 표면은 그대로 두어 감시 대상에만 올린다.
    if (live) {
      try {
        screen = readText(selectedFloor.read(session));
        if (screen == null) throw new Error("빈 응답");
      } catch (error) {
        screenError = error.message;
        if (monitored && !/감독$/u.test(role)) {
          screenAlerts.push({
            id: `screen-read:${session}`,
            kind: "모름",
            level: "AMBER",
            role,
            session,
            screenError,
          });
        }
      }
    }
    const completionDispatches = dispatches.get(session) ?? new Map();
    const markers = findDoneMarkers(screen ?? ''), fresh = new Set();
    for (const [key, dispatch] of completionDispatches) {
      const newer = diffDoneMarkers(dispatch.baselineMarkers ?? [], markers,
        marker => JSON.stringify([taskKey(marker.taskId), marker.result]));
      for (const marker of newer) if (taskKey(marker.taskId) === key) fresh.add(marker);
    }
    // 중앙 카드 조회를 쓰지 않는 기존 호출은 발령 없는 화면 후보도 보고한다.
    // 실제 CLI는 카드 목록(빈 목록 포함)을 넘기므로 등록 카드 감시는 위 대조를 반드시 거친다.
    const doneMarker = cards == null && completionDispatches.size === 0
      ? markers.at(-1) : markers.findLast(marker => fresh.has(marker));
    observations.set(session, {
      role,
      alive: Boolean(live),
      pid: live?.pid ?? null,
      expectedPid,
      digest: screen == null ? null : shortDigest(screen),
      screen,
      screenError,
      startedAt: generations.get(session)?.t ?? start.t,
      doneMarker: doneMarker ?? null,
      completionDispatches,
    });
  }
  const liveSessions = new Set(
    [...starts.entries()]
      .sort((left, right) => startTimeMs(right[1]) - startTimeMs(left[1]))
      .filter(([session]) => liveBySession.has(session))
      .map(([session]) => session)
  );
  return { observations, liveSessions, screenAlerts };
}

export function absorbDeliveredScreens(floor, roleStates, deliveredRecipients) {
  const screenAlerts = [];
  for (const recipient of deliveredRecipients) {
    const session = `kadan-${recipient}`;
    const state = roleStates.get(session);
    if (state?.alive) {
      try {
        const screen = readText(floor.read(session));
        if (screen == null) throw new Error("빈 응답");
        roleStates.set(session, {
          ...state,
          digest: shortDigest(screen),
          screenError: null,
        });
      } catch (error) {
        roleStates.set(session, {
          ...state,
          digest: null,
          screenError: error.message,
        });
        if (!/감독$/u.test(state.role)) {
          screenAlerts.push({
            id: `screen-read:${session}`,
            kind: "모름",
            level: "AMBER",
            role: state.role,
            session,
            screenError: error.message,
          });
        }
      }
    }
  }
  return { states: roleStates, screenAlerts };
}

function clockTime(at) {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes()
  ).padStart(2, "0")}`;
}

// 알림 앞머리는 날것 이름 대신 사람이 읽는 뜻으로 쓴다(2026-09-12 [kyle]). 원장 alertKind 등 기계 키는 바꾸지 않는다.
const ALERT_LABELS = {
  "죽음": "세션 종료 의심",
  "정체": "화면이 멈춤",
  "완료후보": "끝난 것 같음",
  "응답장애": "대답을 못 함",
  "감시제외": "감시 대상에서 빠짐",
  "계열겹침": "같은 계열 역할 중복 실행",
  "시작보고누락": "시작 보고 누락",
  "큐대기": "입력이 큐에 쌓여 대기",
  "입력큐": "입력 큐 대기",
};
const alertLabel = (kind) => ALERT_LABELS[kind] ?? kind;

export function formatAlertBody(alert) {
  if (alert.kind === "감시AI오류") {
    // 판정 AI 자체의 시간 초과는 작업자 응답 장애가 아니다 — 작업 상태는 미판정으로 둔다.
    if (alert.reason === "timeout") return `${alert.source?watchAILabel(alert.source):'감시AI'} 점검 필요 · ${alert.role} (감시 판정 AI 시간 초과 — 작업 상태 미판정)`;
    const reason={ "call-failed":"호출 실패", "report-missing":"보고 명령 미실행", "report-incomplete":"보고 전달 기록 미완료", "report-error":"보고 실행·기록 오류"}[alert.reason] || "호출 상태 확인 필요";
    return `${alert.source?watchAILabel(alert.source):'감시AI'} 점검 필요 · ${alert.role} (${reason}; 작업 상태 판정과 별개)`;
  }
  if (alert.kind === "입력큐") {
    return `입력 큐 대기 ${alert.session} (${alert.line})`;
  }
  if (alert.kind === "전달실패") {
    return `전달실패 ${alert.sourceBody} (수신자 ${alert.failedRecipient} 없음: ${alert.deliveryError})`;
  }
  if (alert.id === "hierarchy:unreadable") return "관계표 읽기 실패: 마지막 정상 관계 유지, 원본 설정 확인 필요";
  if (alert.id === "ledger:unreadable") {
    return `모름 원장 (읽기 실패: ${alert.ledgerError})`;
  }
  if (alert.kind === "진행조정") return `${alert.verdict==='모름'?'진행 판단 불가':'진행 조정 필요'} ${alert.role} / ${alert.taskId} (${alert.verdict==='모름'?'감시ai 근거 부족 또는 호출 실패. 감독이 실제 진전 확인 필요':alert.consecutive>=2?'반복 조정 판정. 직속 감독은 상위 감독에게 범위·담당 조정 요청':'반복 실패·범위 확장 후보. 감독이 근거 확인 후 조정'}; 자동 중지 아님)`;
  if (alert.kind === "시작보고누락") return `시작 보고 누락 ${alert.role} / ${alert.taskId} (발령 ${alert.waitMinutes}분 경과, 실제 착수 여부 확인 후 보고 보완 필요)`;
  if (alert.kind === "놀고 있음") {
    // 상위가 받는 건 2단이다: 본인에게 먼저 알렸는데도 그대로였다.
    const self = alert.stage === 2 ? `; ${Math.floor(alert.idleMinutes / 2)}분 전에 본인에게 알렸으나 그대로` : "";
    return `놀고 있음 ${alert.session} (할 일 ${alert.openCards}건, ${alert.idleMinutes}분간 화면 변화 없음${self})`;
  }
  if (alert.kind === "모름" && alert.screenError) {
    return `상태 확인 필요 ${alert.session} (화면 읽기 실패: ${alert.screenError})`;
  }
  if (alert.judgeVerdict === "모름") {
    const reason = {
      'ai-unknown':'감시AI가 화면만으로 판단하지 못함',
      'invalid-output':'감시AI 응답 형식 오류',
      'call-failed':'감시AI 호출 실패',
      timeout:'감시AI 응답 시간 초과',
    }[alert.judgeReason] ?? '감시AI 판정 근거 없음';
    return `상태 확인 필요 ${alert.session} (${reason})`;
  }
  if (alert.judgeVerdict === "죽음") {
    return `세션 종료 의심 ${alert.session} (정체 후보, 판정 세션 종료 의심)`;
  }
  if (DISCONNECT_ALERT_KINDS.includes(alert.kind)) {
    return `${alert.kind} ${alert.session} (${alert.line})`;
  }
  if (alert.kind === "완료후보") {
    return `끝난 것 같음 ${alert.session} (${alert.taskId} ${alert.result}, 감독 확인 필요)`;
  }
  if (alert.kind === "큐대기") {
    const minutes = Math.floor((alert.queuedMs ?? 0) / 60_000);
    const action = /press enter/iu.test(alert.line ?? "")
      ? "해당 창에서 Enter를 눌러 큐를 흘려내면 처리됨"
      : "턴 종료·다음 도구 호출 때 자동 제출 예정 — 계속 쌓여 있으면 해당 창 확인";
    return `입력이 큐에 쌓여 대기 ${alert.session} (${minutes}분째 '${alert.line}' — ${action})`;
  }
  if (alert.kind === "정체") {
    const judged = alert.judgeVerdict ? `, 판정 ${alertLabel(alert.judgeVerdict)}` : "";
    return `화면이 멈춤 ${alert.session} (지문 무변화 ${alert.count}회${judged})`;
  }
  if (alert.kind === "죽음") {
    return `세션 종료 의심 ${alert.session} (세션 없음 또는 PID 불일치)`;
  }
  return `${alertLabel(alert.kind)}${alert.session ? ` ${alert.session}` : ""}`;
}

function resolvedBody(alert) {
  if (alert.kind === "시작보고누락") {
    return `시작 보고 누락 - 해소됨 ${alert.role} / ${alert.taskId}`;
  }
  if (alert.kind === "모름") {
    return `상태 확인 필요 - 해소됨${alert.session ? ` ${alert.session}` : ''} (작업 완료를 뜻하지 않음)`;
  }
  if (alert.kind === "죽음") {
    return `세션 종료 의심 - 해소됨${alert.session ? ` ${alert.session}` : ''}`;
  }
  return `${alertLabel(alert.kind)} - 해소됨${alert.session ? ` ${alert.session}` : ''}`;
}

function recordAlert(record, alert, recipient, delivered, resolved = false) {
  try {
    record({
      kind: "alert",
      ...(alert.id ? {id:alert.id} : {}),
      alertKind: alert.kind,
      level: alert.level,
      role: alert.role,
      session: alert.session,
      taskId: alert.taskId,
      ...(alert.source ? {source:alert.source} : {}),
      ...(alert.verdict !== undefined ? {verdict:alert.verdict} : {}),
      ...(alert.reason !== undefined ? {reason:alert.reason} : {}),
      ...(alert.judgeVerdict !== undefined ? {judgeVerdict:alert.judgeVerdict} : {}),
      ...(alert.judgeReason !== undefined ? {judgeReason:alert.judgeReason} : {}),
      recipient,
      ...(alert.route?{route:alert.route}:{}),
      ...(alert.escalatedTo ? {escalatedTo:alert.escalatedTo} : {}),
      delivered,
      by: "watch",
      ...(resolved ? { resolved: true } : {}),
    });
  } catch (error) {
    console.error(`원장 기록 실패: ${error.message}`);
  }
}

// 재시작 뒤 첫 순회의 재전송을 막는다. 원장의 경보 기록에서 배달됐지만 아직 해소되지 않은 경보를 직전 상태로 복원한다.
// id가 없는 옛 기록(2026-09-12 이전)은 복원 재료가 없어 건너뛰며, 그 경보는 마지막으로 한 번만 더 울릴 수 있다.
export function seedAlertState(entries) {
  const latest = new Map();
  for (const e of entries || []) {
    if (e?.kind !== 'alert' || typeof e.id !== 'string' || !e.id) continue;
    latest.set(e.id, e);
  }
  const active = [], recipients = new Map();
  for (const e of latest.values()) {
    if (e.resolved) continue;
    active.push({ id: e.id, kind: e.alertKind, level: e.level, role: e.role, session: e.session, taskId: e.taskId, verdict: e.verdict, reason: e.reason, judgeVerdict: e.judgeVerdict, judgeReason: e.judgeReason });
    if (e.delivered && e.recipient) recipients.set(e.id, e.recipient);
  }
  return { active, recipients };
}

export function deliverResolution({
  alert,
  recipients,
  cycleAt,
  sendAlert,
  print,
  record = () => {},
}) {
  // 과거 자원 경고는 해소 우편이나 새 기록으로 다시 깨우지 않는다.
  if (alert.kind === "자원") {
    recipients.delete(alert.id);
    return null;
  }
  // 해소는 원장 기록과 감시 출력으로만 남긴다(2026-10-05 [kyle]). 받은 쪽에 우편을 보내면 할 일이 없는데도 모델이 읽고
  // 응답한다. 대신 경보 우편이 "행동 전 지금 상태를 확인하라"고 말한다(sendWatchMessage). 큐대기는 전부터 이랬다(2026-09-15).
  const recipient = recipients.get(alert.id) ?? null;
  recipients.delete(alert.id);
  recordAlert(record, alert, recipient, false, true);
  print(`[watch ${clockTime(cycleAt)}] ${resolvedBody(alert)}${recipient ? ` (${recipient}에게 우편 없음)` : ""}`);
  return null;
}

export const isDatabaseBusy=error=>error?.errcode===5||/database is locked|SQLITE_BUSY/i.test(String(error?.message??''));

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
  mailUnreadGraceMs = 300_000,
  sendQueueEnter = null,
  record = () => {},
  intervalMs,
  stallN,
  routes,
  superRole,
  parents = new Map(),
  loadHierarchy = null,
  idleMs = 15 * 60 * 1_000,
  userNotify = false,
  judgeCmd = null,
  ai = null,
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
  assertSingleWatch(spawn);
  // 기록 쓰기·알림 전송은 여러 단계에서 불리고 원장 잠금이나 바닥 전송을 기다릴 수 있다.
  // 단계 구간과 별도로 호출 수·총시간·최대시간을 모은다.
  const io = {record:ioCounter(), send:ioCounter()};
  record = timedCall(io.record, record, measure);
  sendAlert = timedCall(io.send, sendAlert, measure);
  const sendToRole = sendAlert;
  sendAlert = (role, message) => {
    if (role !== USER_RECIPIENT) return sendToRole(role, message);
    const errorText = notifyUser(message, spawn);
    if (errorText) {
      const error = new Error(`사용자 알림 실패: ${errorText}`);
      error.delivery = "not-sent";
      throw error;
    }
  };
  const rateLimitRetry = new RateLimitRetry({record, resume:resume429});
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
  const workerChecks = new Map();
  const judgeFailures = new Map();
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
    reads?.begin();
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
        cards = readCards(); works = readWorks().map(w => ({ ...w, owner: effectiveWorkOwner(w, entries) }));
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
      if(result.ok)judgeFailures.delete(job.key);
      else judgeFailures.set(job.key,{id:`ai-call:${job.key}`,kind:'감시AI오류',level:'AMBER',role:job.candidate.role,
        session:job.candidate.session,taskId:job.candidate.taskId,source:job.candidate.source,reason:result.reason});
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
      try { ai?.reports.retire(entries,cards,parents,works); }
      catch { aiStoreError={id:'watch-ai:store',kind:'감시AI오류',level:'AMBER',role:'감시 보고 저장소',reason:'report-error'}; }
      for (const [key,failure] of judgeFailures) if (!observedSessions.has(failure.session)) judgeFailures.delete(key);
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
          const currentScope=buildWatchScope(currentCards,currentEntries,parents,readWorks().map(w=>({...w,owner:effectiveWorkOwner(w,currentEntries)})));
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
          const currentScope=buildWatchScope(readCards(),currentEntries,parents,readWorks().map(w=>({...w,owner:effectiveWorkOwner(w,currentEntries)})));
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
      reportAlerts=assessMissingStartReports(cards,entries,workerObservations,cycleAt,startReportGraceMs,{states:roleStates,alerted:alertedStartReports(entries),active:new Set(activeAlerts.map(a=>a.id))});
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
      try {result=ai.run({...candidate,input,observationDigest:seen.digest,evidenceDigest:check?.evidenceDigest??null,judgeCmd,parents,routes,superRole,hierarchyPath,userNotify,signal:job.controller.signal});}
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
      for (const d of readDecisions() ?? []) if (d?.status === "open" && typeof d.card === "string") waits.push(item(d.card, null, null, "@user"));
      for (const l of mailboxLetters(entries, undefined, { view: "waiting" }))
        if (l.expectReply && !l.replyFinal && !l.notificationOnly && !l.systemGenerated && l.currentRecipient) waits.push(item(l.executionKey, l.taskId, l.workKey, l.currentRecipient));
    } catch { waits = []; }
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
        { works, cards: cards ?? [], waits }
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
    const sendIdleNudge = (alert) => {
      const message = `[watch ${clockTime(cycleAt)}] ${buildIdleNudge(alert)}`;
      let target = alert.role, held = false, delivered = false;
      try {
        (sendNudge ?? sendAlert)(alert.role, message);
        delivered = true;
        deliveredRecipients.add(alert.role);
      } catch (error) {
        held = typeof error.code === 'string' && (error.code === 'KADAN_HUMAN_ACTIVE' || error.code === 'KADAN_PANE_INPUT_PENDING');
        target = `${alert.role} ${held ? '보류' : '전달 실패'}(${error.message})`;
      }
      if (held) pendingNudges.set(alert.id, alert); else pendingNudges.delete(alert.id);
      print(`${message} → ${target}`);
      return delivered;
    };
    // 이전 주기에 보류된 1단 알림. 이번 주기의 새 보류는 다음 주기에 다시 본다.
    const heldNudges = new Map(pendingNudges);
    for (const alert of changes.notify) {
      if (deliveryFailures.has(alert.id)) continue;
      if (alert.kind === "놀고 있음" && alert.stage !== 2) {
        const delivered = sendIdleNudge(alert);
        if (delivered) alertRecipients.set(alert.id, alert.role);
        recordAlert(record, {...alert, route:{recipient:alert.role, basis:'본인'}}, alert.role, delivered);
        continue;
      }
      const message = `[watch ${clockTime(cycleAt)}] ${formatAlertBody(alert)}`;
      const route = explainAlertRoute(
        alert,
        routes,
        roles.liveSessions,
        superRole,
        parents
      );
      const recipient=route.recipient;
      let target = "stdout";
      const failureRecipient = parents.has(recipient)
        ? routeAlert({ id: "delivery", role: recipient }, routes, roles.liveSessions, superRole, parents)
        : superRole;
      let delivered = false;
      if (recipient) {
        try {
          sendAlert(recipient, message);
          delivered = true;
          target = recipient;
          if (!alertRecipients.has(alert.id)) {
            alertRecipients.set(alert.id, recipient);
          }
          deliveredRecipients.add(recipient);
        } catch (error) {
          target = `${recipient} 전달 실패(${error.message})`;
          if (error.delivery === "sent") {
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
      recordAlert(record, {...alert,route}, recipient ?? null, delivered);
      if (recipient !== USER_RECIPIENT && userNotify && (alert.level === "RED" || alert.kind === "죽음")) {
        const notifyError = notifyUser(message, spawn);
        if (notifyError) target += `; 사용자 알림 실패(${notifyError})`;
      }
      print(`${message} → ${target}`);
    }
    for (const alert of changes.absorbed) {
      alertRecipients.delete(alert.id);
      deliveryFailures.delete(alert.id);
      pendingNudges.delete(alert.id);
      // 감독 멈춤 1단이 2단으로 올라간 것: 풀린 게 아니므로 '해소됨'을 찍지 않는다. 다만 열린 경보로 남지 않게
      // escalatedTo를 붙여 닫힘 기록만 남긴다(대시보드는 마지막 기록이 resolved면 닫힌 것으로 센다).
      if (alert.kind === "놀고 있음" && sourceIds.has(`${alert.id}:상위`)) recordAlert(record, {...alert, escalatedTo:`${alert.id}:상위`}, null, false, true);
    }
    for (const alert of changes.resolved) {
      if (alert.kind === "전달실패") continue;
      deliveryFailures.delete(alert.id);
      pendingNudges.delete(alert.id);
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
      if (sendIdleNudge(alert)) { alertRecipients.set(id, alert.role); recordAlert(record, {...alert, route:{recipient:alert.role, basis:'본인'}}, alert.role, true); }
    }
    lap('alerts');
    let mailError = false;
    if (mailWatch && !observationError) {
      try {
        mailWatch.tick({entries:mailEntries,cards:cards??[],works,now:cycleAt,
          floor,readEntries,readCards:readCards??(()=>[]),readWorks,signal});
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
    // 주기 완료 증거. 프로세스 생존과 구분해 대시보드가 마지막 주기·설정·공백을 읽는다.
    if (cycleRecordDue(lastCycleRecordedAt, cycleAt)) {
      try {
        const memory=memoryUsage();
        const timing={totalMs:sample.totalMs,ledgerMs:sample.ledgerMs,prepareMs:sample.prepareMs,screenMs:sample.screenMs,otherMs:sample.otherMs,
          observedSessions:[...roles.observations.values()].filter(r=>r.alive).length,
          stages:sample.stages,cpuMs:sample.cpuMs,...(sample.reads?{reads:sample.reads}:{}),record:sample.record,send:sample.send,
          memoryMb:roundAll({rss:memory.rss/2**20,heapUsed:memory.heapUsed/2**20}),window:timingWindow};
        record(buildCycleEntry({runtime,timing,pid: process.pid, hierarchyPath, hierarchyHash, judge: Boolean(judgeCmd), profile: profilePath, intervalMs,
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
    if(activeAI){const job=activeAI;job.controller.abort();await job.promise;}
  }
}
