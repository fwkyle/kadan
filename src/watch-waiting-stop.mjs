// 대기 표시(card progress --activity waiting)로 화면·AI 감시에서 빠진 실행이 이미 아는 오류 화면에 멈췄는지 본다.
// Why: 2026-11-18 검수자가 '대기 중'을 남긴 뒤 `Selected model is at capacity` 화면에 멈췄고, 대기 표시 때문에 감시 밖이라
// 22시간 동안 경보가 없었다(감독은 그 검수자를 기다리는 것이 정상이라 감독 점검도 조용했다).
//
// 결정식 검사 하나만 한다: 감시기가 이미 읽은 화면(collectRoles)에 정상 감시와 같은 낱말표 판정(currentStopPhrases)을 한 번 돌린다.
// 화면을 새로 읽지 않고 원장을 읽지 않고 AI를 부르지 않고 키를 보내지 않는다. 상태도 두지 않는다(같은 화면이면 같은 경보 id라
// 기존 경보 중복 막기가 한 번만 알린다). 정체 시간·자동 재개·큐 재개는 대기 세션에 붙지 않는다.
// 세션이 사라진 것은 알리지 않는다(대기 세션의 죽음은 이 검사의 범위 밖이다).
import { WORKER_PHRASES, phraseOfLine, currentStopPhrases } from "./watch-stop-phrases.mjs";
import { shortDigest, changeDigest } from "./watch-roles.mjs";
import { statusProgress } from "./watch-status-line.mjs";

// 대기 표시 실행의 화면이 일하는 표시 없이 이 시간 동안 그대로면 한 번 알린다(아래 assessWaitingCap). 설정이 아닌 상수다.
// 감독 정기 점검(SUPERVISOR_CHECK_MS, 1시간)과 같은 값: 감독이 "하위 결과 대기"로 한 번 정상 판정을 받는 동안에는 조용하고,
// 그보다 오래 멈춘 대기만 알린다. 백그라운드 셸을 기다리는 빈 입력창의 유예(30분)보다 길어 그 대기에도 먼저 울리지 않는다.
export const WAITING_CAP_MS = 60 * 60_000;

const rank = (line) => WORKER_PHRASES.indexOf(phraseOfLine(line));

// 화면의 정지 줄과 그 키. 정상 감시의 즉시 경보와 같은 기준이다: 마지막 빈 입력창 바로 위의 현재 오류 덩어리 안에서만 읽는다
// (코드 울타리·인용·설명·오류 뒤에 응답이 이어진 화면은 아니다). 자동 재개용 최종 429 판정(terminal429)은 쓰지 않는다 —
// 그 판정은 인용하거나 이미 복구된 429도 집고, 지문에 스크롤 위쪽의 옛 오류 줄이 섞인다.
// 키는 그 줄 하나를 정규화한 값(숫자를 지운 모양)이라 화면의 다른 줄이 바뀌어도 같다.
export function waitingStopScreen(screen) {
  if (typeof screen !== "string") return null;
  const found = [...currentStopPhrases(screen)].sort(([, a], [, b]) => rank(a) - rank(b))[0];
  return found ? { key: found[0], line: found[1] } : null;
}

// 지금 대기 사유: 그 대기 표시를 만든 보고 한 줄. 경보를 만들 때만 읽는다.
// 감시기의 카드 요약(watch-store-cache.mjs)은 이력 없이 마지막 기록만 싣는다. 그래서 대기 보고가 카드의 마지막 기록일 때만
// 사유를 알 수 있고, 뒤에 다른 메모가 붙었으면 사유 없이 대기 표시 시각만 알린다(뒤 메모를 사유로 읽지 않는다).
function waitingNote(card) {
  if (card.at !== card.activityAt || card.noteKind !== "progress") return "";
  const note = String(card.note ?? "").replace(/\s+/gu, " ").trim();
  return note.length > 80 ? `${note.slice(0, 80)}…` : note;
}

// waitingSessions: buildWatchScope(…, {waiting:true})가 준 대기 실행. observations: 이번 순회에 읽은 화면.
// 살아 있고 창 PID가 등록된 PID와 같은 세션의 화면만 본다(정상 감시가 화면을 읽는 조건과 같다).
export function assessWaitingStops(waitingSessions, observations) {
  const alerts = [];
  for (const entry of waitingSessions ?? []) {
    const { session, role, card } = entry;
    const seen = observations.get(session);
    if (!(seen?.alive === true && (seen.expectedPid == null || String(seen.pid) === String(seen.expectedPid)))) continue;
    const stop = waitingStopScreen(seen.screen);
    if (!stop) continue;
    // 같은 세션·같은 실행·같은 정지 줄이면 같은 경보다(시계 숫자만 바뀐 줄은 같은 줄). 정지 줄이 바뀌면 새 경보다.
    alerts.push({
      id: `waiting-stop:${session}:${entry.executionKey ?? entry.taskId}:${shortDigest(stop.key)}`,
      kind: "대기중정지", level: "AMBER", role, session, taskId: entry.taskId, executionKey: entry.executionKey ?? null,
      dispatcher: entry.by, waitingAt: card.activityAt, waitingNote: waitingNote(card), line: stop.line,
    });
  }
  return alerts;
}

// 대기 시간 상한(마지막 그물, 2026-11-20): 대기 표시 실행의 화면이 일하는 표시 없이 capMs 동안 그대로면 `대기중장기정지` 1회.
// Why: 위 정지 화면 검사는 이미 아는 문구만 본다. 모르는 오류 화면이나 문구 검사가 놓치는 모양에 멈춘 대기는 여전히 조용했다.
// 화면 문구를 읽지 않고 두 가지만 본다: (1) 턴이 도는 중인가 — 기존 statusProgress(일하는 줄의 시계가 직전 순회와 다름).
// (2) 변화 지문(changeDigest: 숫자·회전 표시를 지운 화면)이 그대로인가. 턴이 돌거나 화면이 바뀌면 처음부터 다시 잰다.
// 이미 읽은 화면만 쓴다. 화면 새로 읽기·원장 읽기·AI 호출·키 전송이 없다.
//
// previous: 지난 순회의 states(경보 id → {digest, stillMs, clockSec, alert}). 감시기 메모리에만 둔다. 재시작하면 0부터 다시 잰다.
//   재시작 때 원장에서 복원한 열린 경보는 {digest:null, alert}로 심는다: 처음 본 화면을 기준으로 삼아 그 화면이 그대로인 동안
//   경보를 그대로 내보낸다(같은 id라 다시 알리지 않는다). 심지 않으면 첫 순회에 해소로 닫히고 capMs 뒤 같은 경보가 또 울린다.
// excluded(entry): 다른 경로가 맡는 대기(등록된 답 대기·업무 대기 시각·이번 순회 `대기중정지` 세션)면 true. 상태를 버린다.
// canOpen: 답 대기 목록을 읽지 못한 순회에는 false. 시간은 세되 새 경보는 열지 않는다(정당한 대기를 모르고 알리지 않는다).
// 경보 id에는 화면 지문이 없다(세션 + 실행). 화면이 바뀌어 닫힌 뒤 다시 capMs 동안 그대로면 같은 id로 다시 열려 한 번 알린다.
const capId = (entry) => `waiting-cap:${entry.session}:${entry.executionKey ?? entry.taskId}`;

export function assessWaitingCap(previous, waitingSessions, observations, {
  elapsedMs, intervalMs, capMs = WAITING_CAP_MS, excluded = () => false, canOpen = true,
} = {}) {
  const states = new Map();
  const alerts = [];
  // 맥북이 잠든 공백은 세지 않는다(assessIdleStop과 같은 기준). 세면 깨어난 순간 모든 대기 세션이 한꺼번에 울린다.
  const slept = elapsedMs > intervalMs * 3;
  for (const entry of waitingSessions ?? []) {
    const id = capId(entry);
    const before = previous.get(id);
    const seen = observations.get(entry.session);
    // 세션이 사라졌으면 상태를 버린다(대기 세션의 죽음은 이 검사의 범위 밖이다. 열린 경보는 해소로 닫힌다).
    if (!seen || seen.alive === false) continue;
    // 화면만 못 읽은 순회(읽기 실패·PID 불일치)는 판단하지 않는다. 상태와 이미 연 경보를 그대로 둔다.
    if (seen.alive !== true || seen.screen == null
      || !(seen.expectedPid == null || String(seen.pid) === String(seen.expectedPid))) {
      if (before) { states.set(id, before); if (before.alert) alerts.push(before.alert); }
      continue;
    }
    if (excluded(entry)) continue;
    const { status, moving } = statusProgress(seen.screen, before?.clockSec ?? null);
    const digest = seen.digest ?? changeDigest(seen.screen);
    const still = before != null && !moving && (before.digest == null || before.digest === digest);
    const stillMs = still ? (before.stillMs ?? 0) + (slept ? 0 : elapsedMs) : 0;
    const open = still && (before.alert != null || (canOpen && stillMs >= capMs));
    const alert = !open ? null : {
      id, kind: "대기중장기정지", level: "AMBER", role: entry.role, session: entry.session, taskId: entry.taskId,
      executionKey: entry.executionKey ?? null, dispatcher: entry.by, waitingAt: entry.card.activityAt,
      waitingNote: waitingNote(entry.card), stillMs, statusKind: status?.kind ?? null,
    };
    states.set(id, { digest, stillMs, clockSec: status?.kind === "working" ? status.clockSec : null, alert });
    if (alert) alerts.push(alert);
  }
  return { states, alerts };
}
