// '화면이 이런 문구로 멈췄다'를 알아보는 판정의 단일 목록 (kadan/work-watch-status-line PR-B).
// 문구 모양 → 종류 → 행동. 작업자 감시(watch.mjs)와 감독 감시(watch-supervisor-health.mjs)가 같은 목록을 쓰고,
// skills/kadan-super/references/intervention.md 표는 이 목록의 id를 참조한다(원본은 여기, tests/watch-stop-phrases.test.mjs가 어긋남을 잡는다).
//
// 행동: auto-resume(자동 재개) | alert-supervisor(직속 감독 경보) | replace-runner(실행기 교체 필요 — 직속 감독에게 올리되 같은 세션 재시도 금지)
// scope: worker(작업자 화면) | supervisor(감독 화면). live: 지금 그려진 상태 줄이라 감시기가 처음 본 주기에도 바로 경보한다
//   (스크롤백 줄은 처음 본 주기를 기준선으로만 삼는다 — 옛 줄 헛경보 방지).
// sample: 실제 화면 표본이 있는 근거. '없음'은 문구를 사고표·설치본에서만 확인했고 감시AI 입력 기록에서 못 찾았다는 뜻이다.
// 모든 낱말은 아래 '현재 오류 덩어리' 안에서만 읽는다(한 줄 낱말 판정 없음, PR #200 수정 2라운드). 덩어리로 확정 못 한 화면은 정체 경로로 간다.
// 구조로 판정하는 항목(detect)은 마지막 입력창 주변 덩어리만 본다 — 인용·설명·오래된 스크롤 줄을 멈춤으로 읽지 않는다.
import { terminal429 } from "./watch-rate-limit.mjs";
import { securityFilterNotice } from "./watch-security-filter.mjs";

export const STOP_ACTIONS = ["auto-resume", "alert-supervisor", "replace-runner"];

export const STOP_PHRASES = [
  { id: "rate-limit-429", kind: "한도", action: "auto-resume", scope: ["worker"],
    pattern: /429 Too Many Requests|exceeded retry limit/iu,
    sample: "codex 0.163 `Exceeded retry limit, last status: 429` (tests/watch-stall-digits.test.mjs)" },
  { id: "rate-limit-text", kind: "한도", action: "auto-resume", scope: ["worker", "supervisor"],
    pattern: /rate limit/iu, sample: "없음(사고표 E1)" },
  // 입력창 바로 위 오류 줄 + 빈 입력창 구조로 자동 재개 대상인지 가른다(watch-rate-limit.mjs).
  { id: "rate-limit-terminal", kind: "한도", action: "auto-resume", scope: ["worker"],
    detect: terminal429, sample: "codex 0.163 429 방치 사고 화면" },
  { id: "no-api-key", kind: "설정", action: "replace-runner", scope: ["worker", "supervisor"],
    pattern: /No API key/iu, sample: "없음(사고표 E5)" },
  { id: "auth-token", kind: "인증", action: "replace-runner", scope: ["worker", "supervisor"],
    pattern: /oauth\/token|authentication (?:failed|required)|401 Unauthorized/iu, sample: "없음(intervention.md 표)" },
  { id: "reconnecting", kind: "끊김", action: "alert-supervisor", scope: ["worker", "supervisor"], live: true,
    pattern: /Reconnecting\.\.\./iu, sample: "codex 0.163 `• Reconnecting... 2/5 (9m 34s • esc to interrupt)`" },
  { id: "stream-error", kind: "끊김", action: "alert-supervisor", scope: ["worker", "supervisor"],
    pattern: /stream error|stream disconnected/iu, sample: "codex 0.163 `Stream disconnected before completion`" },
  { id: "bad-gateway", kind: "끊김", action: "alert-supervisor", scope: ["worker", "supervisor"],
    pattern: /502 Bad Gateway|Provider unreachable/iu, sample: "없음(사고표 E2)" },
  { id: "dns", kind: "끊김", action: "alert-supervisor", scope: ["worker"],
    pattern: /getaddrinfo ENOTFOUND/iu, sample: "없음(사고표 E2)" },
  { id: "sse-timeout", kind: "끊김", action: "alert-supervisor", scope: ["supervisor"],
    pattern: /idle timeout waiting for SSE/iu, sample: "없음" },
  { id: "compact-error", kind: "끊김", action: "alert-supervisor", scope: ["supervisor"],
    pattern: /Error running remote compact task/iu, sample: "없음" },
  // 입력창 구조 판정: 알림 줄 + cybersecurity 줄 + 빈 입력창(watch-security-filter.mjs, #194). codex 화면에서만 본다.
  { id: "security-filter", kind: "보안필터", action: "replace-runner", scope: ["worker"],
    detect: securityFilterNotice, sample: "tests/fixtures/security-filter-screens.json (2026-09-30 codex)" },
];

const withPattern = (scope) => STOP_PHRASES.filter((p) => p.pattern && p.scope.includes(scope));
const sourceOf = (entries) => entries.map(({ pattern }) => pattern.source).join("|");

// 작업자 화면의 끊김·한도·설정·인증 줄 낱말 판정. 첫 번째로 맞는 항목의 종류가 줄의 종류다.
export const WORKER_PHRASES = withPattern("worker");
export const WORKER_SIGNATURES = new RegExp(sourceOf(WORKER_PHRASES), "giu");
export const SUPERVISOR_ERROR_PATTERN = new RegExp(sourceOf(withPattern("supervisor")), "iu");

export const phraseKinds = () => [...new Set(WORKER_PHRASES.map(({ kind }) => kind))];
export const phraseByKind = (kind) => STOP_PHRASES.find((p) => p.kind === kind);
export const phraseAction = (kind) => phraseByKind(kind)?.action ?? null;

export function phraseOfLine(line) {
  const text = String(line ?? "");
  return WORKER_PHRASES.find(({ pattern }) => pattern.test(text)) ?? null;
}

// ---- 현재 오류 덩어리 (PR #200 수정 1라운드: 인용·예제·회복된 줄·입력 에코·도구 줄을 오류로 읽지 않는다) ----
// 오류로 읽는 덩어리 = 화면의 '마지막 입력창'(빈 입력창) 바로 위에 붙은, 오류 머리줄로 시작하는 덩어리다.
//  - 머리줄: 오류 표시(■ ✕ × ⓘ)로 시작하는 줄, 또는 상태 줄 모양의 재연결 `• Reconnecting... [n/m] (… esc to interrupt)`
//  - 덩어리 = 머리줄 + 바로 이어진 들여쓴 줄들(`  └ …`). 빈 줄이나 새 `•` 줄에서 끝난다.
//  - 덩어리와 입력창 사이에는 빈 줄(가로선 포함)만 있고, 입력창 아래에는 바닥글 몇 줄만 온다. 그 아래에 일하는 표시가 있을 수 없다.
//  - 코드 울타리 안이면 아니다. 입력창에 쓰는 중인 글(`› …`)이 마지막이면 아니다.
// 첫 관찰 주기에도 바로 경보한다(#194 보안필터와 같은 방식).
const ERROR_HEAD = /^[■✕×ⓘ]/u;
const RECONNECT_HEAD = /^•\s*Reconnecting\.\.\.(?:\s+\d+\/\d+)?(?:\s*\([^)]*\))?\s*$/iu; // 줄 전체가 상태 줄 모양일 때만(설명 문장 안의 낱말은 아님)
const FENCE = /^\s*(```|~~~)/u;
const EMPTY_COMPOSER = /^\s*(?:›\s*(?:Ask Codex to do anything)?|[❯>])\s*$/u;
const ANY_COMPOSER = /^\s*[›❯]/u;
const RULE_OR_BLANK = /^[\s─━—-]*$/u;
const FOOTER_LINES = 5;

// 줄 키: 시계·횟수 숫자만 바뀌는 줄이 주기마다 새 줄로 보이지 않게 숫자를 지운 모양으로 센다.
export const lineKey = (match, line) => `${String(match).toLowerCase()}|${line.trim().replace(/\d+/gu, "#")}`;

function trimmedLines(screen) {
  if (typeof screen !== "string") return [];
  const lines = screen.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
}

// 각 줄이 코드 울타리 안인지 함께 돌려준다.
export function linesWithFence(screen) {
  let open = false;
  return trimmedLines(screen).map((line) => {
    if (FENCE.test(line)) { open = !open; return { line, inFence: true }; }
    return { line, inFence: open };
  });
}

export function currentErrorBlock(screen) {
  // tmux는 floor.read에서 추천 문구를 뺀 판정용 화면을 준다. 표시용 readView를 넣지 않는다.
  const rows = linesWithFence(screen);
  const lines = rows.map((r) => r.line);
  const composer = lines.findLastIndex((line) => ANY_COMPOSER.test(line));
  if (composer < 0 || !EMPTY_COMPOSER.test(lines[composer])) return null;
  const footer = lines.slice(composer + 1).filter((line) => !RULE_OR_BLANK.test(line));
  if (footer.length > FOOTER_LINES || footer.some((line) => ANY_COMPOSER.test(line) || FENCE.test(line) || /^\s*[•⏺]\s/u.test(line))) return null;
  let end = composer - 1;
  while (end >= 0 && RULE_OR_BLANK.test(lines[end])) end--;
  if (end < 0) return null;
  let head = end;
  while (head > 0 && /^\s+\S/u.test(lines[head])) head--;
  if (!(ERROR_HEAD.test(lines[head]) || RECONNECT_HEAD.test(lines[head]))) return null;
  if (rows.slice(head, end + 1).some((r) => r.inFence)) return null;
  // 위쪽 소개 문단 제외(#194 보안필터와 같은 규칙): 오류 표시 머리줄 바로 위(빈 줄·장식 줄을 건너)가 응답 머리표 문단이거나 콜론으로 끝나는
  // 소개 문장이면 설명·예시이지 현재 오류가 아니다. 애매하면 즉시 경보 대신 정체 경로로 간다. 상태 줄 모양의 재연결 머리줄에는 적용하지 않는다.
  if (ERROR_HEAD.test(lines[head])) {
    let above = head - 1;
    while (above >= 0 && RULE_OR_BLANK.test(lines[above])) above--; // 빈 줄·가로선 등 장식 줄은 몇 개든 건너뛴다
    const intro = above >= 0 ? lines[above] : "";
    if (/^\s*[•⏺]\s/u.test(intro) || /[:：]\s*$/u.test(intro)) return null;
  }
  return { head: lines[head], lines: lines.slice(head, end + 1) };
}

// 현재 오류 덩어리 안의 목록 낱말: Map(줄 키 → 줄). 덩어리가 아니면 빈 Map.
export function currentStopPhrases(screen) {
  const found = new Map();
  const block = currentErrorBlock(screen);
  if (!block) return found;
  for (const line of block.lines) {
    WORKER_SIGNATURES.lastIndex = 0;
    for (const match of line.matchAll(WORKER_SIGNATURES)) found.set(lineKey(match[0], line), line.trim());
  }
  return found;
}

// 넓은 검사(일하는 중 거부 전용): 화면 아래 12줄 안에 목록 낱말이 하나라도 있으면 true. 덩어리·인용·코드 울타리 여부는 따지지 않는다.
// 즉시 경보는 만들지 않는다 — (a) 일하는 중으로 분류하지 않고 (c) 정체 경로로 보내는 데만 쓴다.
// 거부 쪽은 넓게: 잘못 걸리면 정상 인용이 정체 20분 뒤 감시AI 호출 하나로 가고, 잘못 통과시키면 429를 되풀이하며 멈춘 화면이 영원히 일하는 중으로 묻힌다.
export function anyStopWordInBottom(screen, count = 12) {
  const lines = trimmedLines(screen).slice(-count);
  return lines.some((line) => { WORKER_SIGNATURES.lastIndex = 0; return WORKER_SIGNATURES.test(line); });
}
