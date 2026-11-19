// 대기 표시(card progress --activity waiting)로 화면·AI 감시에서 빠진 실행이 이미 아는 오류 화면에 멈췄는지 본다.
// Why: 2026-11-18 검수자가 '대기 중'을 남긴 뒤 `Selected model is at capacity` 화면에 멈췄고, 대기 표시 때문에 감시 밖이라
// 22시간 동안 경보가 없었다(감독은 그 검수자를 기다리는 것이 정상이라 감독 점검도 조용했다).
//
// 결정식 검사만 한다: 감시기가 이미 읽은 화면(collectRoles)에 정상 감시와 같은 낱말표 판정(currentStopPhrases)을 한 번 돌린다.
// 화면을 새로 읽지 않고 AI를 부르지 않고 키를 보내지 않는다. 정체 시간·자동 재개·큐 재개는 대기 세션에 붙지 않는다.
// 비용은 대기 세션 수에만 비례한다. 원장은 세션이 사라진 것을 처음 본 주기에 그 세션의 마지막 시작·종료 기록을 한 번 찾을 때만 읽는다.
import { WORKER_PHRASES, phraseOfLine, currentStopPhrases } from "./watch-stop-phrases.mjs";
import { intendedStop } from "./lifecycle-tail.mjs";
import { shortDigest } from "./watch-roles.mjs";

const rank = (line) => WORKER_PHRASES.indexOf(phraseOfLine(line));

// 화면의 정지 줄과 그 키. 정상 감시의 즉시 경보와 같은 기준이다: 마지막 빈 입력창 바로 위의 현재 오류 덩어리 안에서만 읽는다
// (코드 울타리·인용·설명·오류 뒤에 응답이 이어진 화면은 아니다). 자동 재개용 최종 429 판정(terminal429)은 쓰지 않는다 —
// 그 판정은 인용하거나 이미 복구된 429도 집고, 지문에 스크롤 위쪽의 옛 오류 줄이 섞인다(2026-11-19 검수 발견 1·3).
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

// previous: 지난 순회가 돌려준 {alive, judged}(처음이면 null).
//  - alive: 대기 중이면서 살아 있던 세션. 살아 있는 것을 본 뒤 사라진 세션만 죽음 후보다
//    (감시 시작 때 이미 없던 묵은 대기 카드가 한꺼번에 울리지 않게 — 작업자 죽음 판정과 같은 기준).
//  - judged: 사라진 세션의 판정(dead | stopped). 사라진 것을 처음 본 주기에 원장에서 한 번만 정하고 그대로 들고 간다.
//    주기마다 원장을 다시 훑지 않는다(2026-11-19 검수 발견 5). 그래서 죽음 경보가 열린 뒤 그 세션을 kadan stop으로 꺼도
//    경보는 닫히지 않는다 — 세션이 다시 뜨거나 대기가 풀리거나 실행이 끝나면 닫힌다.
// active: 지금 열려 있는 경보. 재시작 뒤 복원된 죽음 경보를 원장을 다시 읽지 않고 이어 가는 데만 쓴다.
// 대기 세션 목록에서 빠진 세션은 두 상태에서 자연히 사라진다.
export function assessWaitingStops(previous, waitingSessions, observations, { entries, active = [] }) {
  const alive = new Set(), judged = new Map(), alerts = [];
  const open = new Set(active.filter((a) => a.kind === "대기중정지").map((a) => a.id));
  for (const entry of waitingSessions ?? []) {
    const { session, role, card } = entry;
    const seen = observations.get(session);
    const base = {
      kind: "대기중정지", level: "AMBER", role, session, taskId: entry.taskId,
      executionKey: entry.executionKey ?? null, dispatcher: entry.by, waitingAt: card.activityAt,
    };
    const prefix = `waiting-stop:${session}:${entry.executionKey ?? entry.taskId}`;
    const live = seen?.alive === true && (seen.expectedPid == null || String(seen.pid) === String(seen.expectedPid));
    if (!live) {
      const id = `${prefix}:death`;
      let verdict = judged.get(session) ?? previous?.judged?.get(session) ?? (open.has(id) ? "dead" : null);
      // 일부러 끈 세션(kadan stop)은 죽음이 아니다. 화면이 없으니 정지 화면 검사도 없다.
      if (!verdict && previous?.alive?.has(session)) verdict = intendedStop(entries, session) ? "stopped" : "dead";
      if (verdict) judged.set(session, verdict);
      if (verdict === "dead") alerts.push({ ...base, id, dead: true, line: "세션 없음 또는 PID 불일치", waitingNote: waitingNote(card) });
      continue;
    }
    alive.add(session);
    const stop = waitingStopScreen(seen.screen);
    if (!stop) continue;
    // 같은 세션·같은 실행·같은 정지 줄이면 같은 경보다(시계 숫자만 바뀐 줄은 같은 줄). 정지 줄이 바뀌면 새 경보다.
    alerts.push({ ...base, id: `${prefix}:${shortDigest(stop.key)}`, line: stop.line, waitingNote: waitingNote(card) });
  }
  return { alive, judged, alerts };
}
