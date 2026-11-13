// 화면 맨 아래 상태 줄로 '일하는 중 / 멈춤 / 애매함'을 가른다 (kadan/work-watch-status-line).
// 변화 지문(normalizeForChange)은 숫자를 지워 일하는 화면도 '변화 없음'으로 만든다(#187). 그 뜻은 바꾸지 않고,
// 이 모듈이 정규화 전 원래 화면의 아래쪽만 따로 읽는다.
// 표본 근거: 감시AI 관찰 자료(codex 0.163 일하는 중·입력 대기·끊김, claude 입력 대기)와 claude 2.1.302 일하는 중 실제 화면 2장.
// claude 일하는 중 모양은 감독이 자기 세션에서 뜬 실제 화면 두 장으로 맞췄다.
import {waitingLetters} from './mailbox-queries.mjs';
import { anyStopWordInBottom } from "./watch-stop-phrases.mjs";

// (b) 멈춤 경보의 코드 기본값. 감시 주기 60초, 정체 기본 5분보다 짧게 둔다. 프로필 키는 더하지 않는다.
export const IDLE_STOP_AFTER_MS = 4 * 60_000;

const BOTTOM_LINES = 14;
// 일하는 표시는 화면 끝 14줄에 더해, 그 14줄 안의 마지막 입력 줄 위로 이만큼은 항상 찾는다(범위는 넓어지기만 한다).
// 입력칸 아래 바닥글이 길면(8줄까지 입력칸으로 본다 — ghost-text.mjs) 끝 14줄이 입력 줄 위를 거의 못 봐서, 회전 줄이 남은
// 화면이 idle로 읽혔다(PR #374 검수 F1). 바닥글 3줄인 보통 화면에서 끝 14줄은 입력 줄 위 9줄(14 − 바닥글 3 − 아래 가로줄 1
// − 입력 줄 1)을 본다. 실측 사본(바닥글 3~4줄)은 8~9줄이다. 그보다 좁아지지 않게 10으로 둔다.
const ABOVE_INPUT_LINES = 10;
const INPUT_SYMBOL = /^\s*[❯›>]/u;
const CLOCK_TEXT = /^(?:(\d+)h\s+)?(?:(\d+)m\s+)?(\d+)s$/u;
// codex 0.163: `• Working (5m 12s • esc to interrupt)` 뒤에 `· 1 background terminal running …`이 붙을 수 있다.
const CODEX_WORKING = /^\s*•\s*Working\s*\(([^()•]*?)\s*•[^()]*esc to interrupt/iu;
// claude 2.1.302 일하는 중(실제 표본 2장): `✢ Grooving… (32s · ↓ 1.7k tokens)` — 회전 기호 + 동사 + `…` + `(시계 · …)`.
// `esc to interrupt`는 없고, 일하는 동안에도 빈 `❯` 입력창이 보인다. 회전 기호는 `✢`에서 `·`로 바뀌며 돈다.
// 끝난 턴(`✻ Cogitated for 3m 44s`, `Brewed for 11s · done 1:48 AM`)은 `…`과 괄호가 없어 걸리지 않는다.
const CLAUDE_WORKING = /^\s*[✻✶✳✢✽·*⏺]\s+\S+(?:…|\.\.\.)\s*\(([^()·]*?)\s*(?:·|\))/u;
// 도구 실행 줄 `⎿  Running… (4s)`: 도구가 도는 동안 회전 줄 없이 이 줄과 빈 `❯`만 보일 수 있다(검수 F1).
// 시계가 늘면 (a) 일하는 중, 아니면 (c) 애매함이다. 이 줄이 있으면 빈 입력창만 보고 idle로 확정하지 않는다.
const CLAUDE_TOOL_RUNNING = /^\s*⎿\s+Running(?:…|\.\.\.)\s*\(([^()·]*?)\s*(?:·|\))/u;
const CODEX_INPUT = /^\s*›\s*(?:Ask Codex to do anything)?\s*$/u;
const CLAUDE_INPUT = /^\s*[❯>]\s*$/u;

// `12s` `5m 12s` `1h 02m 03s`를 초로. 다른 모양은 null이다.
export function parseClock(text) {
  const match = CLOCK_TEXT.exec(String(text ?? "").trim());
  if (!match) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3]);
}

// 끝의 빈 줄을 뗀 화면 전체 줄.
function screenLines(screenText) {
  if (typeof screenText !== "string") return [];
  const lines = screenText.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
}

// kind: working(일하는 표시 있음) | idle(일하는 표시 없음 + 빈 입력창) | unknown(그 밖)
// clockSec: 일하는 줄의 경과 시계(초). 읽지 못하면 null.
export function readStatusLine(screenText) {
  const all = screenLines(screenText);
  const bottomStart = Math.max(0, all.length - BOTTOM_LINES);
  // 끝 14줄 안의 마지막 입력 기호 줄(글이 있어도 된다). 없으면 예전과 똑같이 끝 14줄만 본다.
  const anchor = all.findLastIndex((line, i) => i >= bottomStart && INPUT_SYMBOL.test(line));
  const workStart = anchor < 0 ? bottomStart : Math.min(bottomStart, Math.max(0, anchor - ABOVE_INPUT_LINES));
  for (let i = all.length - 1; i >= workStart; i--) {
    const codex = CODEX_WORKING.exec(all[i]);
    const claude = codex ? null : CLAUDE_WORKING.exec(all[i]) ?? CLAUDE_TOOL_RUNNING.exec(all[i]);
    const hit = codex ?? claude;
    if (hit) return { kind: "working", tool: codex ? "codex" : "claude", clockSec: parseClock(hit[1]) };
  }
  // idle 판정의 빈 입력 줄은 예전처럼 끝 14줄에서만 찾는다.
  const lines = all.slice(bottomStart);
  const input = lines.findLast((line) => CODEX_INPUT.test(line) || CLAUDE_INPUT.test(line));
  if (input != null) return { kind: "idle", tool: CODEX_INPUT.test(input) ? "codex" : "claude", clockSec: null };
  return { kind: "unknown", tool: null, clockSec: null };
}

// (a) 일하는 중: 일하는 표시가 있고 시계가 지난 주기와 다르다(늘었거나 새 턴으로 줄었다).
// 시계가 같거나 처음 본 화면은 근거가 아니다. 호출한 쪽이 오류(끊김·429·보안 필터)가 걸린 화면을 먼저 걸러야 한다.
export function isWorkingMoving(status, previousClockSec) {
  return (
    status?.kind === "working" &&
    status.clockSec != null &&
    previousClockSec != null &&
    status.clockSec !== previousClockSec
  );
}

// 작업자 감시(watch.mjs)와 감독 관찰(watch-supervisor-health.mjs)이 함께 쓰는 '이번 화면이 직전 순회 대비 진행 중인가' 판정.
// 화면이 없으면(죽음·읽기 실패) screen에 null을 준다 → {status: null, moving: false}.
// 오류 낱말이 아래 12줄 어디든 있으면 시계가 늘어도 moving은 거짓이다(#187: 끊김 화면이 일하는 중으로 묻히지 않게).
export function statusProgress(screen, previousClockSec) {
  const status = screen != null ? readStatusLine(screen) : null;
  const moving = !(screen != null && anyStopWordInBottom(screen)) && isWorkingMoving(status, previousClockSec ?? null);
  return { status, moving };
}

// 답을 기다리는 질문 우편이 그 발령 뒤에 있는가. 있으면 작업자는 정당하게 기다리는 중이다.
// unreadable: 우편 상태를 못 읽었을 때의 답. 멈춤 경보는 기본값(true, 올리지 않는다)을 쓰고,
// 확정 대기 실행의 정체를 가릴 때는 false를 넘긴다(못 읽었으면 가리지 않는다).
export function hasOpenQuestion(entries, role, sinceIso, unreadable = true) {
  const since = Date.parse(sinceIso);
  try {
    return waitingLetters(entries, role).some(
      (letter) =>
        letter.replyStatus === "waiting" &&
        !letter.notificationOnly &&
        !letter.systemGenerated &&
        (!Number.isFinite(since) || Date.parse(letter.t) >= since)
    );
  } catch {
    // 우편 상태를 못 읽으면 정당한 대기일 수 있으니 (기본값으로는) 경보를 올리지 않는다.
    return unreadable;
  }
}

// (b) 멈춤: 일하는 표시 없음 + 빈 입력창 + DONE 없음 + 미완료 실행이 있고 화면이 그대로인 채 기준 시간 이어짐.
// 결정식이라 AI를 부르지 않는다. 정당한 대기는 여기서 뺀다:
//  - 완료·일시정지·취소·미발령: tasks(감시 범위 = 발령된 assigned·waiting 아님 실행)에 없는 역할은 보지 않는다.
//  - 질문 대기: hasOpenQuestion
//  - 완료후보: doneMarker가 있으면 세지 않는다
//  - 큐 배너: 큐 줄이 있으면 제외. 사람이 입력창에 쓴 글이 있으면 idle이 아니다
//  - 입력 보호·알림밀림: 입력창 글자와 무관하게(복사 모드·최근 사람 입력 등) 알림 전달이 밀린 역할은
//    NotifyHoldTracker.isHeld로 호출한 쪽이 excludedSessions에 넣는다(검수 F2)
export function assessIdleStop(previousStates, observations, {
  elapsedMs, intervalMs, afterMs = IDLE_STOP_AFTER_MS, tasks = [], entries = [],
  excludedSessions = new Set(), queuedLine = () => null,
}) {
  const states = new Map();
  const alerts = [];
  const slept = elapsedMs > intervalMs * 3;
  const taskOf = new Map(tasks.map((task) => [`kadan-${task.role}`, task]));
  for (const [session, current] of observations) {
    const task = taskOf.get(session);
    const previous = previousStates.get(session);
    const status = current?.alive === true && current.screen != null ? readStatusLine(current.screen) : null;
    const candidate =
      task != null &&
      status?.kind === "idle" &&
      current.doneMarker == null &&
      !excludedSessions.has(session) &&
      queuedLine(current.screen) == null &&
      !hasOpenQuestion(entries, task.role, task.t);
    const sameScreen = candidate && previous?.digest === current.digest;
    const idleMs = !candidate ? 0 : sameScreen ? (previous.idleMs ?? 0) + (slept ? 0 : elapsedMs) : 0;
    states.set(session, { idleMs, digest: candidate ? current.digest : null });
    if (candidate && idleMs >= afterMs) {
      alerts.push({
        id: `idle-stop:${session}:${current.digest}`,
        kind: "멈춤",
        level: "AMBER",
        role: current.role,
        session,
        idleMs,
        tool: status.tool,
      });
    }
  }
  return { states, alerts };
}
