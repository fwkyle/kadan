// 대기 표시(card progress --activity waiting)로 화면·AI 감시에서 빠진 실행이 이미 아는 오류 화면에 멈췄는지 본다.
// Why: 2026-11-18 검수자가 '대기 중'을 남긴 뒤 `Selected model is at capacity` 화면에 멈췄고, 대기 표시 때문에 감시 밖이라
// 22시간 동안 경보가 없었다(감독은 그 검수자를 기다리는 것이 정상이라 감독 점검도 조용했다).
//
// 결정식 검사만 한다: 감시기가 이미 읽은 화면(collectRoles)에 낱말표·최종 429 판정을 한 번 돌린다. 화면을 새로 읽지 않고
// AI를 부르지 않고 키를 보내지 않는다. 정체 시간·자동 재개·큐 재개는 대기 세션에 붙지 않는다(감시 범위 sessions 밖 그대로).
// 비용은 대기 세션 수에만 비례한다(원장 크기와 무관).
import { STOP_PHRASES, WORKER_PHRASES, phraseOfLine, currentStopPhrases } from "./watch-stop-phrases.mjs";
import { terminal429 } from "./watch-rate-limit.mjs";
import { intendedStop } from "./lifecycle-tail.mjs";
import { shortDigest } from "./watch-roles.mjs";

const RATE_429 = STOP_PHRASES.find((p) => p.id === "rate-limit-429").pattern;
const rank = (line) => WORKER_PHRASES.indexOf(phraseOfLine(line));

// 화면의 정지 줄과 그 지문. 낱말표의 현재 오류 덩어리(인용·설명·코드 울타리 제외)가 먼저고, 덩어리로 못 읽은 최종 429 화면이 다음이다.
export function waitingStopScreen(screen, now) {
  if (typeof screen !== "string") return null;
  const found = [...currentStopPhrases(screen)].sort(([, a], [, b]) => rank(a) - rank(b))[0];
  if (found) return { key: found[0], line: found[1] };
  const limit = terminal429(screen, now);
  if (!limit) return null;
  const line = screen.split("\n").findLast((text) => RATE_429.test(text))?.trim() ?? "최종 429 오류 뒤 빈 입력창";
  return { key: `429:${limit.fingerprint ?? "blocked"}`, line };
}

// 지금 대기 사유: 그 대기 표시를 만든 보고 한 줄(뒤에 붙은 일반 메모는 사유가 아니다). 경보를 만들 때만 읽는다.
function waitingNote(card) {
  const row = card.at === card.activityAt ? card
    : card.history?.findLast((h) => h.at === card.activityAt && h.activity === "waiting");
  const note = String(row?.noteKind === "progress" ? row.note ?? "" : "").replace(/\s+/gu, " ").trim();
  return note.length > 80 ? `${note.slice(0, 80)}…` : note;
}

// seenAlive: 지난 순회에 대기 중이면서 살아 있던 세션. 살아 있는 것을 본 뒤 사라진 세션만 죽음으로 알린다
// (감시 시작 때 이미 없던 묵은 대기 카드가 한꺼번에 울리지 않게 — 작업자 죽음 판정과 같은 기준).
// active: 지금 열려 있는 경보. 재시작 뒤 복원된 죽음 경보를 이어 가는 데만 쓴다.
// 돌려주는 alive는 다음 순회의 seenAlive다(대기 세션 목록에서 빠진 세션은 자연히 사라진다).
export function assessWaitingStops(seenAlive, waitingSessions, observations, { entries, now, active = [] }) {
  const alive = new Set(), alerts = [];
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
      // 일부러 끈 세션(kadan stop)은 죽음이 아니다. 화면이 없으니 정지 화면 검사도 없다.
      if ((seenAlive.has(session) || open.has(id)) && !intendedStop(entries, session)) {
        alive.add(session);
        alerts.push({ ...base, id, dead: true, line: "세션 없음 또는 PID 불일치", waitingNote: waitingNote(card) });
      }
      continue;
    }
    alive.add(session);
    const stop = waitingStopScreen(seen.screen, now);
    if (!stop) continue;
    // 같은 세션·같은 실행·같은 화면 줄이면 같은 경보다(시계 숫자만 바뀐 줄은 같은 줄). 화면이 바뀌면 새 경보다.
    alerts.push({ ...base, id: `${prefix}:${shortDigest(stop.key)}`, line: stop.line, waitingNote: waitingNote(card) });
  }
  return { alive, alerts };
}
