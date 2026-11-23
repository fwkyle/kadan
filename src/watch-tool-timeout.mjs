// 화면 끝 '살아 있는 상태 구역'의 도구 실행 줄에서 timeout을 읽는다(감독 관찰의 정기 후보 억제용).
// 구역 = 화면 맨 아래의 실제 입력창(위·아래 가로줄 사이의 `❯` 한 줄) 바로 위(빈 줄만 사이에)의 들여쓰기 없는 스피너 줄과,
// 그 바로 위(빈 줄만 사이에)에 Claude가 그리는 그대로의 `  ⎿  Running… (<경과> · timeout <T>)` 줄이다.
// 입력창을 확인 못 하거나 줄 사이에 다른 글이 끼거나 들여쓰기가 다르면(인용·지난 출력) 읽지 않는다 = 억제하지 않는다.
// statusProgress·readStatusLine은 건드리지 않는다.
const BOTTOM_LINES = 14;
// 입력창 아래 바닥글 상한(watch-status-line.mjs·ghost-text.mjs의 입력칸 기준과 같다).
const FOOTER_LINES = 8;
// 한 도구로 억제되는 T의 상한. 감독 정기 확인 간격(1시간)과 같아, 처음 본 뒤 최대 T+여유만 억제된다.
export const TOOL_TIMEOUT_MAX_MS = 60 * 60_000;
const INPUT_LINE = /^[❯>](?: .*)?$/u;
const RULE = /^─{3,}$/u;
// watch-status-line.mjs의 claude 일하는 줄(`✢ Grooving… (32s · ↓ 1.7k tokens)`)과 같은 모양이되 들여쓰지 않은 줄만이다.
const SPINNER = /^[✻✶✳✢✽·*⏺]\s+\S+(?:…|\.\.\.)\s*\(/u;
const TOOL_LINE = /^ {2}⎿ {2}Running(?:…|\.\.\.)\s*\(([^()]*)\)\s*$/u;
const TIP_LINE = /^ {2}⎿ {2}Tip: /u;
const BACKGROUND_HINT = /^ {5}\(ctrl\+b .*run in background\)$/u;
const DURATION =/^(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?$/u;

// `4m` `6m 40s` `1h 2m` `30s`를 밀리초로. 다른 모양·빈 값·0·유한하지 않은 값(아주 큰 숫자 → Infinity)은 null이다.
// 읽은 값이 TOOL_TIMEOUT_MAX_MS보다 크면 그 상한으로 자른다.
export function parseTimeout(text) {
  const trimmed = String(text ?? '').trim();
  const match = trimmed ? DURATION.exec(trimmed) : null;
  if (!match) return null;
  const sec = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  if (!Number.isFinite(sec) || sec <= 0) return null;
  return Math.min(sec * 1000, TOOL_TIMEOUT_MAX_MS);
}

// 반환: {key, timeoutMs} 또는 null(구역이 확정되지 않았거나 도구 줄이 없거나 timeout을 못 읽음 = 지금처럼).
// key는 같은 도구인지 비교하는 값이다: 도구 줄에서 경과 표시를 뺀 것이라 T(상한 적용 뒤)만 담는다. 경과만 바뀌면 같은 도구다.
export function readToolTimeout(screen) {
  if (typeof screen !== 'string') return null;
  // 실제 Claude 화면의 `❯`·`⎿` 뒤에는 줄바꿈 방지 공백(U+00A0)이 섞인다. 판정 전에 일반 공백으로 바꿔 같은 공백으로 받는다(줄 순서·들여쓰기 폭은 그대로 센다).
  const all = screen.replaceAll(' ', ' ').split('\n');
  while (all.length > 0 && all[all.length - 1].trim() === '') all.pop();
  // 실제 입력창: 위·아래 가로줄 사이의 입력 한 줄이고 그 아래에는 바닥글만 있다. 못 찾으면 구역을 모른다.
  const input = all.findLastIndex((line, n) => n >= all.length - BOTTOM_LINES && n > 0 && INPUT_LINE.test(line)
    && RULE.test(all[n - 1]) && RULE.test(all[n + 1] ?? ''));
  if (input < 0 || all.length - 1 - input > FOOTER_LINES + 1) return null;
  let i = input - 2;
  while (i >= 0 && all[i].trim() === '') i--;
  // 실측 화면(tests/fixtures/waiting-cap-screens.json)에는 스피너 바로 아래의 팁 줄과 도구 줄 바로 아래의 백그라운드 안내 줄이 낀다.
  // 이 두 줄 모양에 정확히 맞는 한 줄씩만 건너뛴다. 다른 글이 끼면 구역을 확정하지 못한 것이다.
  if (i >= 0 && TIP_LINE.test(all[i])) i--;
  if (i < 0 || !SPINNER.test(all[i])) return null;
  i--;
  while (i >= 0 && all[i].trim() === '') i--;
  if (i >= 0 && BACKGROUND_HINT.test(all[i])) i--;
  const hit = i >= 0 ? TOOL_LINE.exec(all[i]) : null;
  if (!hit) return null;
  const segment = hit[1].split('·').map(s => s.trim()).find(s => /^timeout\s/iu.test(s));
  const timeoutMs = segment ? parseTimeout(segment.replace(/^timeout\s+/iu, '')) : null;
  return timeoutMs == null ? null : { key: `Running… timeout ${timeoutMs}ms`, timeoutMs };
}
