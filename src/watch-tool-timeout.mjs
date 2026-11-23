// 화면 끝 '살아 있는 상태 구역'의 도구 실행 줄에서 timeout을 읽는다(감독 관찰의 정기 후보 억제용).
// 구역 = 마지막 입력창 바로 위의 스피너 줄 + 그 바로 위의 도구 줄 `⎿  Running… (<경과> · timeout <T>)`.
// 응답 본문·우편 인용 속의 같은 모양은 이 자리에 없으므로 읽지 않는다. statusProgress·readStatusLine은 건드리지 않는다.
const BOTTOM_LINES = 14;
const INPUT_SYMBOL = /^\s*[❯›>]/u;
const BLANK_OR_RULE = /^[\s─━]*$/u;
// watch-status-line.mjs의 claude 일하는 줄(`✢ Grooving… (32s · ↓ 1.7k tokens)`)과 같은 모양. 끝난 턴 요약 줄은 걸리지 않는다.
const SPINNER = /^\s*[✻✶✳✢✽·*⏺]\s+\S+(?:…|\.\.\.)\s*\(/u;
const TOOL_LINE = /^\s*⎿\s+Running(?:…|\.\.\.)\s*\(([^()]*)\)\s*$/u;
const DURATION = /^(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?$/u;

// `4m` `6m 40s` `1h 2m` `30s`를 밀리초로. 다른 모양·빈 값·0은 null이다.
export function parseTimeout(text) {
  const trimmed = String(text ?? '').trim();
  const match = trimmed ? DURATION.exec(trimmed) : null;
  if (!match) return null;
  const sec = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return sec > 0 ? sec * 1000 : null;
}

// 반환: {key, timeoutMs} 또는 null(구역에 도구 줄이 없거나 timeout을 못 읽음 = 지금처럼).
// key는 도구 줄 글자 전체다. 같은 줄이 그대로 이어지는지 비교하는 데 쓴다.
export function readToolTimeout(screen) {
  if (typeof screen !== 'string') return null;
  const all = screen.split('\n');
  while (all.length > 0 && all[all.length - 1].trim() === '') all.pop();
  const bottomStart = Math.max(0, all.length - BOTTOM_LINES);
  let i = all.findLastIndex((line, n) => n >= bottomStart && INPUT_SYMBOL.test(line)) - 1;
  if (i < -1) return null;
  while (i >= 0 && BLANK_OR_RULE.test(all[i])) i--;
  if (i < 0 || !SPINNER.test(all[i])) return null;
  i--;
  while (i >= 0 && all[i].trim() === '') i--;
  const hit = i >= 0 ? TOOL_LINE.exec(all[i]) : null;
  if (!hit) return null;
  const segment = hit[1].split('·').map(s => s.trim()).find(s => /^timeout\s/iu.test(s));
  const timeoutMs = segment ? parseTimeout(segment.replace(/^timeout\s+/iu, '')) : null;
  return timeoutMs == null ? null : { key: all[i].trim(), timeoutMs };
}
