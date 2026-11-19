// '화면이 이런 문구로 멈췄다'를 알아보는 판정의 단일 목록 (kadan/work-watch-status-line PR-B).
// 문구 모양 → 종류 → 행동. 작업자 감시(watch.mjs)와 감독 감시(watch-supervisor-health.mjs)가 같은 목록을 쓰고,
// skills/kadan-super/references/intervention.md 표는 이 목록의 id를 참조한다(원본은 여기, tests/watch-stop-phrases.test.mjs가 어긋남을 잡는다).
//
// 행동: auto-resume(자동 재개) | alert-supervisor(직속 감독 경보) | replace-runner(실행기 교체 필요 — 직속 감독에게 올리되 같은 세션 재시도 금지)
//   | report(보고만 — 실제 한도로 멈춘 화면. 자동 재개 없음, 경보에 대체 후보 교대 명령 한 줄이 붙는다: watch-limit-fallback.mjs)
// scope: worker(작업자 화면) | supervisor(감독 화면). live: 지금 그려진 상태 줄이라 감시기가 처음 본 주기에도 바로 경보한다
//   (스크롤백 줄은 처음 본 주기를 기준선으로만 삼는다 — 옛 줄 헛경보 방지).
// sample: 실제 화면 표본이 있는 근거. '없음'은 문구를 사고표·설치본에서만 확인했고 감시AI 입력 기록에서 못 찾았다는 뜻이다.
// 모든 낱말은 아래 '현재 오류 덩어리' 안에서만 읽는다(한 줄 낱말 판정 없음, PR #200 수정 2라운드). 덩어리로 확정 못 한 화면은 정체 경로로 간다.
// 구조로 판정하는 항목(detect)은 마지막 입력창 주변 덩어리만 본다 — 인용·설명·오래된 스크롤 줄을 멈춤으로 읽지 않는다.
import { terminal429, USAGE_LIMIT_LINE } from "./watch-rate-limit.mjs";
import { securityFilterNotice } from "./watch-security-filter.mjs";
import { claudeLimitLine } from "./claude-limit-line.mjs";

export const STOP_ACTIONS = ["auto-resume", "alert-supervisor", "replace-runner", "report"];

export const STOP_PHRASES = [
  { id: "rate-limit-429", kind: "한도", action: "auto-resume", scope: ["worker"],
    pattern: /429 Too Many Requests|exceeded retry limit/iu,
    sample: "codex 0.163 `Exceeded retry limit, last status: 429` (tests/watch-stall-digits.test.mjs)" },
  { id: "rate-limit-text", kind: "한도", action: "auto-resume", scope: ["worker", "supervisor"],
    pattern: /rate limit/iu, sample: "없음(사고표 E1)" },
  // 입력창 바로 위 오류 줄 + 빈 입력창 구조로 자동 재개 대상인지 가른다(watch-rate-limit.mjs).
  { id: "rate-limit-terminal", kind: "한도", action: "auto-resume", scope: ["worker"],
    detect: terminal429, sample: "codex 0.163 429 방치 사고 화면" },
  // 실제 사용 한도로 멈춘 화면(일일·주간·세션·사용). 자동 재개 대상이 아니다(재개해도 같은 한도에 걸린다) — 보고만, 대체 후보는 경보가 안내한다.
  // 줄 맨 앞(표시 기호 하나 허용)이 문구일 때만 읽는다: 문장 중간의 인용·설명은 걸리지 않는다. 읽는 자리는 아래 currentStopPhrases:
  // codex는 현재 오류 덩어리(`■ …`), Claude는 claudeLimitLine(빈 입력창 바로 위 한도 줄). 429 자동 재개 판정(terminal429)은 이 줄을 집지 않는다.
  { id: "usage-limit", kind: "한도", action: "report", scope: ["worker"],
    pattern: USAGE_LIMIT_LINE,
    sample: "claude `You've hit your session limit · resets 3pm (Asia/Seoul)` (tests/fixtures/claude-limit-screens.json), codex `■ You've hit your usage limit. Upgrade or try again later.` (tests/helpers/fake-codex-tui.mjs)" },
  { id: "no-api-key", kind: "설정", action: "replace-runner", scope: ["worker", "supervisor"],
    pattern: /No API key/iu, sample: "없음(사고표 E5)" },
  { id: "auth-token", kind: "인증", action: "replace-runner", scope: ["worker", "supervisor"],
    pattern: /oauth\/token|authentication (?:failed|required)|401 Unauthorized/iu, sample: "없음(intervention.md 표)" },
  { id: "reconnecting", kind: "끊김", action: "alert-supervisor", scope: ["worker", "supervisor"], live: true,
    pattern: /Reconnecting\.\.\./iu, sample: "codex 0.163 `• Reconnecting... 2/5 (9m 34s • esc to interrupt)`" },
  // Claude 화면: `⏺ API Error: Your computer went to sleep mid-response…` 뒤에 빈 입력창만 남는다(2026-10-21 감독 오판 사고).
  { id: "sleep-interrupted", kind: "끊김", action: "alert-supervisor", scope: ["worker", "supervisor"],
    pattern: /went to sleep mid-response/iu, sample: "claude 감독 `API Error: Your computer went to sleep mid-response` (tests/fixtures/sleep-interrupt-screens.json)" },
  { id: "stream-error", kind: "끊김", action: "alert-supervisor", scope: ["worker", "supervisor"],
    pattern: /stream error|stream disconnected/iu, sample: "codex 0.163 `Stream disconnected before completion`" },
  { id: "bad-gateway", kind: "끊김", action: "alert-supervisor", scope: ["worker", "supervisor"],
    pattern: /502 Bad Gateway|Provider unreachable/iu, sample: "없음(사고표 E2)" },
  { id: "dns", kind: "끊김", action: "alert-supervisor", scope: ["worker"],
    pattern: /getaddrinfo ENOTFOUND/iu, sample: "없음(사고표 E2)" },
  // codex 화면: `■ Selected model is at capacity. Please try a different model.` 뒤에 빈 입력창만 남는다
  // (2026-11-18 대기 표시를 남긴 검수자가 이 화면에서 22시간 멈춘 사고). 오류 표시로 시작하는 현재 오류 덩어리 전체가 이 두 문장일 때만
  // 읽는다 — 낱말 `capacity`(아래 OVERLOAD_PATTERN), 다른 오류가 인용한 문장(`■ Could not read … "Selected model is at capacity".`),
  // 뒤에 다른 말이 붙은 줄(`… at capacity planning stage.`)은 아니다. 좁은 창에서 접힌 줄은 이어 붙여 읽는다(아래 capacityStopLine).
  // 이 pattern은 그렇게 읽은 한 줄의 종류·순서를 정하는 데만 쓴다. 줄 하나씩 읽는 낱말 판정(WORKER_SIGNATURES)에는 넣지 않는다.
  // 자동 재개는 붙이지 않고 직속 감독이 다시 보낼지·모델을 바꿀지 정한다.
  { id: "model-capacity", kind: "끊김", action: "alert-supervisor", scope: ["worker"],
    pattern: /^\s*[■✕×]\s+Selected model is at capacity\.\s+Please try a different model\.\s*$/iu,
    sample: "codex `■ Selected model is at capacity. Please try a different model.` (tests/fixtures/waiting-capacity-screens.json)" },
  { id: "sse-timeout", kind: "끊김", action: "alert-supervisor", scope: ["supervisor"],
    pattern: /idle timeout waiting for SSE/iu, sample: "없음" },
  { id: "compact-error", kind: "끊김", action: "alert-supervisor", scope: ["supervisor"],
    pattern: /Error running remote compact task/iu, sample: "없음" },
  // 입력창 구조 판정: 알림 줄 + cybersecurity 줄 + 빈 입력창(watch-security-filter.mjs, #194). codex 화면에서만 본다.
  { id: "security-filter", kind: "보안필터", action: "replace-runner", scope: ["worker"],
    detect: securityFilterNotice, sample: "tests/fixtures/security-filter-screens.json (2026-09-30 codex)" },
];

// 설명 AI(explain-diag.mjs)의 '모델 과부하' 낱말 모양. STOP_PHRASES에 넣지 않는다 — 넣으면 감시 경보가 새로 생기고,
// `capacity`는 일반 문장에도 흔한 낱말이다. 감시 판정(WORKER_SIGNATURES·SUPERVISOR_ERROR_PATTERN 등)에는 쓰이지 않는다.
// 감시가 읽는 것은 위 목록의 두 문장 전체(`model-capacity`)뿐이다.
export const OVERLOAD_PATTERN = /overloaded|capacity/u;

const withPattern = (scope) => STOP_PHRASES.filter((p) => p.pattern && p.scope.includes(scope));
const sourceOf = (entries) => entries.map(({ pattern }) => pattern.source).join("|");

// 작업자 화면의 끊김·한도·설정·인증 줄 낱말 판정. 첫 번째로 맞는 항목의 종류가 줄의 종류다.
export const WORKER_PHRASES = withPattern("worker");
// 줄 하나씩 읽는 낱말(현재 오류 덩어리의 각 줄, 일하는 중 거부용 넓은 검사). 용량 초과 문장은 여기 없다: 덩어리 전체를 이어 붙여
// 따로 읽고(capacityStopLine), 넓은 검사에는 넣지 않는다 — 넣으면 문장이 화면 아래에 보이는 동안 시계가 도는 정상 작업이
// '일하는 중 아님'이 되어 정체 판정 AI가 불린다(2026-11-19 검수).
export const WORKER_SIGNATURES = new RegExp(sourceOf(WORKER_PHRASES.filter((p) => p.id !== "model-capacity")), "giu");
export const SUPERVISOR_ERROR_PATTERN = new RegExp(sourceOf(withPattern("supervisor")), "iu");

const SLEEP_SIGNATURE = new RegExp(STOP_PHRASES.find((p) => p.id === "sleep-interrupted").pattern.source, "giu");
const USAGE_SIGNATURE = new RegExp(USAGE_LIMIT_LINE.source, "giu");
// 실측 Claude 한도 줄 꼴: `⎿  You've hit your session limit · resets 12:40pm (Asia/Seoul)`, `… Fable limit · resets Nov 17 at 4pm (Asia/Seoul)`.
const CLAUDE_LIMIT_SHAPE = /^(?:[⏺⎿●✗⚠]\s+)?You['’]ve hit your (?:[\w-]+ ){0,2}limit\s+·\s+resets\s+[^·()]{1,40}?(?:\s+\([\w/+-]+\))?\s*$/u;
// 초기화 시각이 없는 맨 한도 줄은 바로 아래에 슬래시 안내 줄(`  /upgrade to increase your usage limit.`·`  /usage-credits to …`)이 붙을 때만 받는다.
// 도구 출력 안의 맨 문구(known-f5)·설명 문장(known-f7)에는 그 안내가 없다.
const CLAUDE_LIMIT_BARE = /^(?:[⏺⎿●✗⚠]\s+)?You['’]ve hit your (?:[\w-]+ ){0,2}limit\.?\s*$/u;
const SLASH_HINT = /^\s+\/[\w-]+\b/u;

// 또는 바로 위(빈 줄·가로선 건너뜀)가 턴 끝 줄(`✻ Baked for 10s · done …`)이라 턴이 끝난 뒤 처음 나온 시스템 줄일 때.
// 요약 배너(`⏺ Usage limit reached · continuing automatically at …`)는 한도 줄이 아니라 안내다. claudeLimitLine이 입력창 바로 위의 이 배너를 고르면
// (배너가 상세 줄보다 아래인 순서 — 2026-11-18 실제 화면), 배너 바로 위(빈 줄·가로선만 건너뜀)의 실측 꼴 상세 줄(`⎿ You've hit your Fable limit · resets …`)을
// 한도 줄로 쓴다(복귀 시각이 같을 때만 — 아래). 상세 줄이 없거나 실측 꼴이 아니거나 시각이 다르면 배너 그대로 돌려줘 예전과 같이 한도로 올리지 않는다(배너만 있는 화면은 정체 경로).
const CLAUDE_BANNER = /^(?:[⏺⎿●✗⚠]\s+)?Usage limit reached\b/u;
const LEAD_SYMBOL = /^(?:[⏺⎿●✗⚠]\s+)?/u;
const clockKey = (clock, meridiem) => `${clock}${meridiem}`.toLowerCase();
const CLOCK_TIME = /\b(\d{1,2}(?::\d{2})?)\s*([ap]m)\b/giu;
const CONTINUING_AT = /continuing automatically at\s+(\d{1,2}(?::\d{2})?)\s*([ap]m)\b/giu;
// 문자열 안 마지막 시각(`Nov 17 at 4pm` → `4pm`). 날짜 부분은 비교하지 않는다.
const lastClockTime = (text) => { let last = null; for (const m of text.matchAll(CLOCK_TIME)) last = clockKey(m[1], m[2]); return last; };
function claudeLimitDetail(screen, found) {
  if (!CLAUDE_BANNER.test(found.line)) return found;
  const lines = screen.split("\n");
  let above = found.at - 1;
  while (above >= 0 && RULE_OR_BLANK.test(lines[above])) above--;
  const line = above >= 0 ? lines[above].trim() : "";
  if (!CLAUDE_LIMIT_SHAPE.test(line)) return found;
  // 짝짓기 조건: 상세 줄의 복귀 시각(`resets 11pm`)이 배너 줄과 그 아래 화면(자동 계속 안내 포함)의 `continuing automatically at 11pm`과 같을 때만.
  // 응답·도구 출력에 인용된 옛 상세 줄(다른 시각)이 무관한 배너와 짝지어 오탐을 만들지 않게 한다. 비교할 시각이 없거나 다르면 짝짓지 않는다.
  const detailTime = lastClockTime(line.split(/\bresets\s+/iu)[1] ?? "");
  if (!detailTime) return found;
  const resumes = new Set([...lines.slice(found.at).join("\n").matchAll(CONTINUING_AT)].map((m) => clockKey(m[1], m[2])));
  return resumes.has(detailTime) ? { line, head: line.replace(LEAD_SYMBOL, ""), at: above } : found;
}

function claudeLimitShape(screen, found) {
  if (CLAUDE_LIMIT_SHAPE.test(found.line)) return true;
  if (!CLAUDE_LIMIT_BARE.test(found.line)) return false;
  const lines = screen.split("\n");
  if (SLASH_HINT.test(lines[found.at + 1] ?? "")) return true;
  let above = found.at - 1;
  while (above >= 0 && RULE_OR_BLANK.test(lines[above])) above--;
  return above >= 0 && TURN_DONE.test(lines[above]);
}

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
const CLAUDE_ERROR_HEAD = /^⏺\s+API Error:/u; // Claude 응답 오류 줄. 응답 머리표(⏺)로 시작하지만 이 모양만 오류 머리줄로 본다
const TURN_DONE = /^✻\s+\S+\s+for\s+\d/u; // Claude 턴 끝 줄(`✻ Baked for 8m 22s · done 6:12 PM`)
const FENCE = /^\s*(```|~~~)/u;
const EMPTY_COMPOSER = /^\s*(?:›\s*(?:Ask Codex to do anything)?|[❯>])\s*$/u;
const ANY_COMPOSER = /^\s*[›❯]/u;
const RULE_OR_BLANK = /^[\s─━—-]*$/u;
const FOOTER_LINES = 5;
// 감시기가 역할 창에 넣은 미확인 우편 안내(watch-notice-format.mjs unreadMailMessage)는 오류 줄이 아니다. 입력창 바로 위에 이 블록이 있으면
// 건너뛰고 그 위의 현재 오류 줄을 본다. 블록은 `[감시sh] 미확인 우편 N건` 머리줄에서 `…별개입니다.` 끝줄까지다(창 너비로 줄이 접혀도 끝줄은 `별개입니다.`로 끝난다,
// 입력으로 되울린 `› ` 머리 허용). 우편 미리보기 안의 문장은 블록 안이라 오류로 읽지 않는다. 끝줄을 못 찾으면 건너뛰지 않는다(예전 판정 그대로).
const MAIL_NOTICE_HEAD = /^\s*(?:[›❯]\s*)?\[감시sh\]\s*미확인 우편 \d+건/u;
const MAIL_NOTICE_TAIL = /별개입니다\.?\s*$/u;
const MAIL_NOTICE_MAX_LINES = 60;
const MAIL_NOTICE_STACK = 3;

// lines[end]가 안내 블록의 끝줄이면 그 블록의 머리줄 번호, 아니면 -1.
function mailNoticeStart(lines, end) {
  if (!MAIL_NOTICE_TAIL.test(lines[end] ?? "")) return -1;
  for (let at = end; at >= 0 && end - at <= MAIL_NOTICE_MAX_LINES; at--) if (MAIL_NOTICE_HEAD.test(lines[at])) return at;
  return -1;
}

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

// claudeHead: Claude 화면의 `⏺ API Error:` 머리줄과 턴 끝 줄(`✻ …`) 건너뛰기까지 덩어리로 읽는다. 이 덩어리는 절전 중단 낱말 판정에만 쓴다
// (currentStopPhrases) — 기본값(false)은 main과 같은 판정이다. 다른 Claude API 오류를 작업자 즉시 경보로 넓히지 않는다(2026-10-22 검수 F1).
// afterResponse: 오류 머리줄 바로 위가 응답 한 줄(`• …`)이어도 덩어리로 읽는다(콜론으로 끝나는 소개 문장은 여전히 제외). 사용 한도 줄 판정에만 쓴다
// (currentStopPhrases) — 기본값(false)은 main과 같은 판정이라 다른 낱말의 판정 범위는 그대로다.
// wrappedRows: 좁은 창에서 tmux가 접은 줄은 들여쓰기 없이(낱말 중간에서도) 이어진다. 덩어리 끝에서 위로, 빈 줄 없이 붙은 줄
// wrappedRows개 안에서 가장 가까운 오류 표시 줄을 머리줄로 삼는다. 용량 초과 문장 판정에만 쓴다(capacityStopLine) —
// 기본값(0)은 main과 같은 판정이다. 나머지 조건(빈 입력창·바닥글·코드 울타리·위쪽 소개 문단)은 그대로 적용되고,
// 위쪽 소개 문단은 바로 위 한 줄이 아니라 접힌 줄을 거슬러 올라간 논리 줄로 본다(responseParagraphAt).
export function currentErrorBlock(screen, { claudeHead = false, afterResponse = false, wrappedRows = 0 } = {}) {
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
  for (let n = 0; n < MAIL_NOTICE_STACK; n++) {
    const notice = mailNoticeStart(lines, end);
    if (notice < 0) break;
    end = notice - 1;
    while (end >= 0 && RULE_OR_BLANK.test(lines[end])) end--;
    if (end < 0) return null;
  }
  const headOf = (from) => { let at = from; while (at > 0 && /^\s+\S/u.test(lines[at])) at--; return at; };
  let head = headOf(end);
  if (wrappedRows > 0) {
    head = end;
    while (head > 0 && end - head < wrappedRows - 1 && !ERROR_HEAD.test(lines[head]) && !RULE_OR_BLANK.test(lines[head - 1])) head--;
  }
  // Claude는 오류 줄과 입력창 사이에 턴 끝 줄이 낀다. 그 줄을 건너뛴 위가 `⏺ API Error:` 머리줄일 때만 덩어리로 읽는다(다른 머리줄 판정은 그대로).
  if (claudeHead && TURN_DONE.test(lines[end])) {
    let above = end - 1;
    while (above >= 0 && RULE_OR_BLANK.test(lines[above])) above--;
    if (above >= 0 && CLAUDE_ERROR_HEAD.test(lines[headOf(above)])) { end = above; head = headOf(above); }
  }
  if (!(ERROR_HEAD.test(lines[head]) || RECONNECT_HEAD.test(lines[head]) || claudeHead && CLAUDE_ERROR_HEAD.test(lines[head]))) return null;
  if (rows.slice(head, end + 1).some((r) => r.inFence)) return null;
  // 위쪽 소개 문단 제외(#194 보안필터와 같은 규칙): 오류 표시 머리줄 바로 위(빈 줄·장식 줄을 건너)가 응답 머리표 문단이거나 콜론으로 끝나는
  // 소개 문장이면 설명·예시이지 현재 오류가 아니다. 애매하면 즉시 경보 대신 정체 경로로 간다. 상태 줄 모양의 재연결 머리줄에는 적용하지 않는다.
  if (ERROR_HEAD.test(lines[head]) || CLAUDE_ERROR_HEAD.test(lines[head])) {
    let above = head - 1;
    while (above >= 0 && RULE_OR_BLANK.test(lines[above])) above--; // 빈 줄·가로선 등 장식 줄은 몇 개든 건너뛴다
    const intro = above >= 0 ? lines[above] : "";
    // 접힌 줄을 이어 붙여 읽을 때(wrappedRows)는 위쪽도 같은 기준으로 논리 줄을 본다: 좁은 창에서는 응답 줄의 끝 조각만
    // 바로 위 줄에 남고 머리표(`•`)는 그 위 줄에 있다. 한 줄만 보면 접힌 응답의 인용이 현재 오류로 읽힌다(2026-11-19 재검수 2).
    const response = wrappedRows > 0 ? responseParagraphAt(lines, above) : /^\s*[•⏺]\s/u.test(intro);
    if ((!afterResponse && response) || /[:：]\s*$/u.test(intro)) return null;
  }
  return { head: lines[head], lines: lines.slice(head, end + 1) };
}

// lines[at]이 응답 문단의 줄인가: 빈 줄 없이 이어진 줄을 거슬러 올라가 가장 가까운 머리표 줄을 찾는다(접힌 오류 줄을 이어 붙이는 것과
// 같은 기준 — 빈 줄에서 끊는다). 응답 머리표(`• …`·`⏺ …`)에 닿으면 응답 문단이다. 그 전에 도구 출력 표시(`│ └ ⎿`)·오류 표시·입력창
// 줄에 닿으면 응답이 아니다: `• Ran …` 아래의 도구 출력은 응답 문단이 아니라서, 그 아래의 오류는 지금처럼 현재 오류로 읽는다.
// 3칸 이상 들여쓴 줄도 응답이 아니다: 접힌 줄 조각은 줄 맨 앞(또는 잘린 자리의 공백 하나)에서 시작하고 화면이 나눈 응답의 이어지는
// 줄은 2칸 들여쓰기다. 그보다 깊은 줄은 표시 없는 출력(`• Edited …` 아래의 바뀐 줄, `└` 아래의 출력)이다.
const RESPONSE_HEAD = /^\s*[•⏺]\s/u;
const OTHER_LINE_HEAD = /^\s*[│└⎿■✕×ⓘ›❯]|^\s{3,}\S/u;
function responseParagraphAt(lines, at) {
  for (; at >= 0 && !RULE_OR_BLANK.test(lines[at]); at--) {
    if (RESPONSE_HEAD.test(lines[at])) return true;
    if (OTHER_LINE_HEAD.test(lines[at])) return false;
  }
  return false;
}

// 용량 초과: 현재 오류 덩어리 전체가 두 문장 `Selected model is at capacity. Please try a different model.`일 때만 그 한 줄을 돌려준다.
// 창이 문장(62칸)보다 좁으면 tmux가 줄을 접고 접힌 자리의 끝 공백은 화면 읽기에서 사라진다. 그래서 덩어리의 줄을 이어 붙이고
// 공백을 모두 지운 모양으로 앞뒤 끝까지 대조한다(2026-11-19 재검수: 55·45칸 창에서 사고 문구를 놓쳤다). 덩어리에 다른 말이
// 한 글자라도 더 있으면(인용·접두어·뒤에 붙은 말·딸린 줄) 아니다. 돌려주는 줄은 창 너비와 무관하게 같은 한 줄이다(경보 id가 같다).
const CAPACITY_SENTENCE = "Selected model is at capacity. Please try a different model.";
const squeeze = (text) => text.replace(/\s+/gu, "").toLowerCase();
const CAPACITY_SQUEEZED = squeeze(CAPACITY_SENTENCE);
const CAPACITY_WRAPPED_ROWS = 6; // 12칸 창까지. 그보다 좁으면 입력창 줄도 접혀 현재 오류 덩어리로 읽지 못한다
function capacityStopLine(screen) {
  const block = currentErrorBlock(screen, { wrappedRows: CAPACITY_WRAPPED_ROWS });
  const joined = squeeze((block?.lines ?? []).join(""));
  return /^[■✕×]/u.test(joined) && joined.slice(1) === CAPACITY_SQUEEZED ? `${joined[0]} ${CAPACITY_SENTENCE}` : null;
}

// 현재 오류 덩어리 안의 목록 낱말: Map(줄 키 → 줄). 덩어리가 아니면 빈 Map.
export function currentStopPhrases(screen) {
  const found = new Map();
  const collect = (block, signatures) => {
    for (const line of block?.lines ?? []) {
      signatures.lastIndex = 0;
      for (const match of line.matchAll(signatures)) found.set(lineKey(match[0], line), line.trim());
    }
  };
  collect(currentErrorBlock(screen), WORKER_SIGNATURES);
  const capacity = capacityStopLine(screen);
  if (capacity) found.set(lineKey(capacity, capacity), capacity);
  // Claude `⏺ API Error:` 덩어리는 절전 중단 낱말만 읽는다(다른 낱말의 판정 범위는 main 그대로).
  collect(currentErrorBlock(screen, { claudeHead: true }), SLEEP_SIGNATURE);
  // 사용 한도 줄(codex `■ …`)은 바로 위가 응답 한 줄(`• …`)이어도 읽는다. 문구가 줄 맨 앞이고 `■` 오류 줄이라야 하며 콜론 소개 문장 아래는 여전히 제외다.
  collect(currentErrorBlock(screen, { afterResponse: true }), USAGE_SIGNATURE);
  // Claude 한도 줄은 `■` 머리줄 덩어리가 아니라 응답 문맥의 맨 줄이다. 빈 입력창 바로 위에 붙은 줄만 읽는 기존 판정(claudeLimitLine)을 쓰되,
  // 이 경보 경로에서는 실측 줄 꼴(`… limit · resets <시각> [(지역)]`이 줄 끝까지, 또는 맨 줄 + 바로 아래 슬래시 안내 줄)만 받는다 —
  // 도구 출력·응답 안의 맨 문구와 설명 문장은 한도로 올리지 않는다.
  const picked = claudeLimitLine(screen);
  const claude = picked && claudeLimitDetail(screen, picked);
  if (claude && claudeLimitShape(screen, claude) && phraseOfLine(claude.line)?.id === "usage-limit") {
    found.set(lineKey(claude.head.slice(0, 40), claude.line), claude.line);
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
