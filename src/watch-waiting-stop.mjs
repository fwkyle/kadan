// 대기 표시(card progress --activity waiting)로 화면·AI 감시에서 빠진 실행이 이미 아는 오류 화면에 멈췄는지 본다.
// Why: 2026-11-18 검수자가 '대기 중'을 남긴 뒤 `Selected model is at capacity` 화면에 멈췄고, 대기 표시 때문에 감시 밖이라
// 22시간 동안 경보가 없었다(감독은 그 검수자를 기다리는 것이 정상이라 감독 점검도 조용했다).
//
// 결정식 검사 하나만 한다: 감시기가 이미 읽은 화면(collectRoles)에 정상 감시와 같은 낱말표 판정(currentStopPhrases)을 한 번 돌린다.
// 화면을 새로 읽지 않고 원장을 읽지 않고 AI를 부르지 않고 키를 보내지 않는다. 상태도 두지 않는다(같은 화면이면 같은 경보 id라
// 기존 경보 중복 막기가 한 번만 알린다). 정체 시간·자동 재개·큐 재개는 대기 세션에 붙지 않는다.
// 세션이 사라진 것은 알리지 않는다(대기 세션의 죽음은 이 검사의 범위 밖이다).
import { WORKER_PHRASES, phraseOfLine, currentStopPhrases } from "./watch-stop-phrases.mjs";
import { shortDigest } from "./watch-roles.mjs";

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
