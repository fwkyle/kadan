// 감시 경보 본문·해소 알림·경보 기록 (HW-3-impl: watch-runner.mjs에서 옮김)
import { normalWatchVerdict } from "./watch-report.mjs";
import { DISCONNECT_ALERT_KINDS } from "./watch.mjs";
import { idleCountsText } from "./watch-supervisor.mjs";
import { ocxAlertLine } from "./ocx-refresh.mjs";

export function clockTime(at) {
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
  "알림밀림": "알림이 계속 밀림",
  "보안필터": "보안 필터로 멈춤",
};
const alertLabel = (kind) => ALERT_LABELS[kind] ?? kind;

// 감시AI오류 알림은 누가·무엇을·무슨 일·대상 문제 여부·할 일을 한 줄로 쓴다(2026-10-17 [kyle]). 기계 키는 바꾸지 않는다.
// 실패한 점검은 정해진 주기에 다시 불린다: 작업 점검은 화면이 바뀌면 5분, 같으면 30분, 감독 응답 점검은 1시간 뒤(watch-runner workerCheck·SUPERVISOR_CHECK_MS).
const AI_ERROR_REASONS = {
  timeout: ["시간 안에 답이 없었음", "없음, 정해진 주기에 다시 점검함"],
  "report-missing": ["결과를 기록하지 못함", "없음, 정해진 주기에 다시 점검함"],
  "call-failed": ["점검 AI를 부르지 못함", "반복되면 점검 기록 폴더 확인"],
  network: ["인터넷 연결이 3번 연속 안 돼 점검하지 못함", "인터넷 연결 확인"],
  "report-incomplete": ["결과는 기록됐지만 알림 전달 기록이 끝나지 않음", "반복되면 점검 기록 폴더 확인"],
  "report-error": ["결과를 저장하는 중 오류가 남", "반복되면 점검 기록 폴더 확인"],
};

// 문제 판정을 따로 보고했다는 말은 실제 전달 기록이 있을 때만 쓴다.
const abnormalDelivery = (to) => Array.isArray(to) && to.length
  ? `(문제 판정은 ${to.join(", ")}에게 따로 보고됨)`
  : "(판정은 기록됐지만 따로 전달됐는지는 확인 안 됨)";

function watchAIErrorBody(alert) {
  const [happened, todo] = AI_ERROR_REASONS[alert.reason] ?? ["점검 상태를 알 수 없음", "반복되면 점검 기록 폴더 확인"];
  const what = alert.source === "supervisor-health" ? "응답 상태" : alert.source ? "작업 진행" : "상태";
  const judged = alert.judgeVerdict
    ? ` · 점검 AI 판단: ${alert.judgeVerdict}${normalWatchVerdict(alert.judgeVerdict) ? "(정상으로 보임)" : abnormalDelivery(alert.judgeDeliveredTo)}`
    : "";
  return `감시기의 점검 AI가 ${alert.role} ${what} 점검에 실패 — ${happened} · ${alert.role}에 문제가 있는지는 모름(점검 도구 문제) · 할 일: ${todo}${judged}`;
}

export function formatAlertBody(alert) {
  if (alert.kind === "감시AI오류") return watchAIErrorBody(alert);
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
  if (alert.kind === "진행조정") {
    return `${alert.verdict==='모름'?'진행 판단 불가':'진행 조정 필요'} ${alert.role} / ${alert.taskId} (${
      alert.verdict==='모름'
        ? '감시ai 근거 부족 또는 호출 실패. 감독이 실제 진전 확인 필요'
        : alert.consecutive>=2
          ? '반복 조정 판정. 직속 감독은 상위 감독에게 범위·담당 조정 요청'
          : '반복 실패·범위 확장 후보. 감독이 근거 확인 후 조정'
    }; 자동 중지 아님)`;
  }
  if (alert.kind === "알림밀림") {
    return `알림이 ${alert.role} 창에 ${alert.holdCount}번 연속 밀림 (사유 ${alert.holdCode}, ${alert.heldSince}부터. 5번 밀린 다음 시도에 입력 보호 없이 넣음)`;
  }
  if (alert.kind === "시작보고누락") return `시작 보고 누락 ${alert.role} / ${alert.taskId} (발령 ${alert.waitMinutes}분 경과, 실제 착수 여부 확인 후 보고 보완 필요)`;
  if (alert.kind === "놀고 있음") {
    // 상위가 받는 건 2단이다: 본인에게 먼저 알렸는데도 그대로였다.
    const self = alert.stage === 2 ? `; ${Math.floor(alert.idleMinutes / 2)}분 전에 본인에게 알렸으나 그대로` : "";
    return `놀고 있음 ${alert.session} (${idleCountsText(alert)}, ${alert.idleMinutes}분간 화면 변화 없음${self})`;
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
    // 한도 경보에는 감시기가 ocx 사용량을 새로 받은 결과 한 줄을 붙인다(ocx-refresh.mjs).
    const ocx = alert.kind === "한도" && alert.ocx ? ` · ${ocxAlertLine(alert.ocx)}` : "";
    return `${alert.kind} ${alert.session} (${alert.line})${ocx}`;
  }
  if (alert.kind === "보안필터") {
    return `보안 필터로 멈춤 ${alert.role ?? alert.session}${alert.taskId ? ` / ${alert.taskId}` : ""} (${alert.session}, codex가 응답을 가리고 입력창으로 돌아옴) → 다른 실행기로 교대 필요, 같은 지시를 다시 보내도 또 걸릴 수 있음`;
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

export function resolvedBody(alert) {
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

export function recordAlert(record, alert, recipient, delivered, resolved = false) {
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
      ...(alert.judgeDeliveredTo !== undefined ? {judgeDeliveredTo:alert.judgeDeliveredTo} : {}),
      ...(alert.judgeReason !== undefined ? {judgeReason:alert.judgeReason} : {}),
      ...(alert.holdCount !== undefined ? {holdCount:alert.holdCount,holdCode:alert.holdCode,heldSince:alert.heldSince} : {}),
      recipient,
      ...(alert.route?{route:alert.route}:{}),
      ...(alert.idleItems ? {idleItems:alert.idleItems} : {}),
      ...(alert.escalatedTo ? {escalatedTo:alert.escalatedTo} : {}),
      delivered,
      ...(alert.held ? {held:true} : {}),
      by: "watch",
      ...(resolved ? { resolved: true } : {}),
    });
    return true;
  } catch (error) {
    console.error(`원장 기록 실패: ${error.message}`);
    return false;
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
    active.push({
      id: e.id, ...(e.held ? {held:true} : {}), kind: e.alertKind, level: e.level, role: e.role, session: e.session, taskId: e.taskId,
      verdict: e.verdict, reason: e.reason, judgeVerdict: e.judgeVerdict, judgeReason: e.judgeReason,
      ...(e.judgeDeliveredTo !== undefined ? {judgeDeliveredTo:e.judgeDeliveredTo} : {}),
      ...(e.holdCode !== undefined ? {holdCode:e.holdCode} : {}),   // 알림밀림 사유(재시작 뒤에도 사유 변화 판정이 같도록)
    });
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
