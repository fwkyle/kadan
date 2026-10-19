// '화면이 이런 문구로 멈췄다'를 알아보는 판정의 단일 목록 (kadan/work-watch-status-line PR-B).
// 문구 모양 → 종류 → 행동. 작업자 감시(watch.mjs)와 감독 감시(watch-supervisor-health.mjs)가 같은 목록을 쓰고,
// skills/kadan-super/references/intervention.md 표는 이 목록의 id를 참조한다(원본은 여기, tests/watch-stop-phrases.test.mjs가 어긋남을 잡는다).
//
// 행동: auto-resume(자동 재개) | alert-supervisor(직속 감독 경보) | replace-runner(실행기 교체 필요 — 직속 감독에게 올리되 같은 세션 재시도 금지)
// scope: worker(작업자 화면) | supervisor(감독 화면). live: 지금 그려진 상태 줄이라 감시기가 처음 본 주기에도 바로 경보한다
//   (스크롤백 줄은 처음 본 주기를 기준선으로만 삼는다 — 옛 줄 헛경보 방지).
// sample: 실제 화면 표본이 있는 근거. '없음'은 문구를 사고표·설치본에서만 확인했고 감시AI 입력 기록에서 못 찾았다는 뜻이다.
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
