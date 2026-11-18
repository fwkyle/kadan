// Why: Claude 화면의 한도 줄 판정을 claude-refresh(미리보기·재시작)와 감시 낱말표(watch-stop-phrases)가 같이 쓴다.
// claude-refresh가 감시 쪽 모듈을 거쳐 낱말표를 다시 부르는 순환 참조를 피하려고 순수 화면 판정만 이 파일로 옮겼다(내용 변경 없음).
import { claudeLimitMenu } from "./claude-limit-menu.mjs";

// 한도 줄은 '줄 맨 앞'이 아래 머리말로 시작할 때만 본다. 문장 중간에 문구가 든 줄은 설명·인용이라 버린다.
// 출처: Claude Code 2.1.309 프로그램(~/.local/share/claude/versions/2.1.309)의 한도 오류 판별 목록 `i4r`
// (`["You've hit your","You've reached your",…]`를 `startsWith`로 비교). 이름 목록은 가져오지 않는다.
// `Usage limit reached`는 같은 프로그램의 목표 상태 줄(`Usage limit reached · continuing …`) 머리말이다.
// 실제 한도 화면은 2.1.308 이미지 전사 1장(`●`/`⏺` 변형)만 확인했다. 다른 버전·한도 종류의 기호는 미확인이라 아래 기호 5개를 선택적으로 걷어 낸다.
// 아포스트로피는 `'`와 `’` 둘 다 받고 대소문자는 원문 그대로 본다. 감시기 STOP_PHRASES에는 붙이지 않는다(이번 범위 밖).
export const CLAUDE_LIMIT_HEADS = [/^You['’]ve hit your /u, /^You['’]ve reached your /u, /^Usage limit reached/u];
const LEAD_SYMBOL = /^\s*(?:[⏺⎿●✗⚠]\s+)?/u;

const CLAUDE_INPUT = /^\s*[❯>]\s*$/u;
const ANY_COMPOSER = /^\s*[›❯]/u;
const USER_INPUT_LINE = /^\s*[❯>]\s+\S/u;
const RESPONSE_LINE = /^\s*⏺(?:\s|$)/u;
const TURN_DONE = /^✻\s+\S+\s+for\s+\d/u;
const FENCE = /^\s*(```|~~~)/u;
const RULE_OR_BLANK = /^[\s─━—-]*$/u;
const FOOTER_LINES = 5;

function trimmedLines(screen) {
  if (typeof screen !== "string") return [];
  const lines = screen.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
}

const limitHeadOf = (line) => {
  const rest = line.replace(LEAD_SYMBOL, "");
  return CLAUDE_LIMIT_HEADS.find((head) => head.test(rest)) ? rest : null;
};

// 한도 줄 찾기. 마지막 빈 입력창(또는 그 위 턴 끝 줄) 위쪽에서, 입력창과의 사이에 빈 줄·가로선·턴 끝 줄·들여쓴 이어진 줄만 있는
// 첫 한도 줄을 돌려준다. 확정할 수 없으면 null(놓치는 쪽으로 기울인다 — 오검출은 곧 엉뚱한 세션 재시작이다).
// 버리는 경우: 사이에 다른 응답 문단(`⏺ `)·사용자 입력 줄·들여쓰지 않은 다른 글이 있음, 코드 울타리 안,
// 줄 위쪽 덩어리(빈 줄 전까지)나 바로 위 줄이 `⏺ ` 응답/도구 호출이라 응답 안의 글일 수 있음.
// 알려진 한계(고치지 않음, 판정은 추천이다): 여러 줄 응답·도구 출력 뒤 빈 줄을 건너 나온 문구(F5), 문구로 시작하는 응답 첫 줄
// `⏺ You've hit your …`(F7)은 한도로 잘못 보일 수 있다. 실제 표본이 2.1.308 이미지 전사 1장뿐이라 규칙을 더 다듬지 않는다.
// 반환: {line, head, at} — at은 화면(줄 나눔)에서 그 한도 줄의 번호다.
export function claudeLimitLine(screen) {
  const menu = claudeLimitMenu(screen);
  if (menu) {
    const above = screen.split('\n').slice(0, menu.title);
    let command = above.length - 1;
    while (command >= 0 && RULE_OR_BLANK.test(above[command])) command--;
    // 확인된 메뉴 바로 앞의 이 명령 한 줄만 예외다. 다른 입력은 기존 탐색 경계로 남긴다.
    if (command >= 0 && /^\s*❯ \/rate-limit-options\s*$/u.test(above[command])) {
      let at = command - 1;
      while (at >= 0 && (RULE_OR_BLANK.test(above[at]) || TURN_DONE.test(above[at]))) at--;
      const line = above[at];
      const head = line == null ? null : limitHeadOf(line);
      // 실제 메뉴와 정확한 명령이 바로 뒤따른 한도는 앞선 도구 응답의 들여쓰기 문맥과 구분한다.
      return head && !insideFence(above, at) ? { line: line.trim(), head, at } : null;
    }
    return claudeLimitLine(above.join('\n') + '\n❯');
  }
  const lines = trimmedLines(screen);
  const composer = lines.findLastIndex((line) => ANY_COMPOSER.test(line));
  if (composer < 0 || !CLAUDE_INPUT.test(lines[composer])) return null;
  const footer = lines.slice(composer + 1).filter((line) => !RULE_OR_BLANK.test(line));
  if (footer.length > FOOTER_LINES || footer.some((line) => ANY_COMPOSER.test(line) || FENCE.test(line) || /^\s*[•⏺]\s/u.test(line))) return null;
  for (let at = composer - 1; at >= 0; at--) {
    const line = lines[at];
    if (RULE_OR_BLANK.test(line) || TURN_DONE.test(line)) continue;
    if (FENCE.test(line) || USER_INPUT_LINE.test(line)) return null;
    const head = limitHeadOf(line);
    if (head) return precededByResponse(lines, at) || insideFence(lines, at) ? null : { line: line.trim(), head, at };
    if (RESPONSE_LINE.test(line) || !/^\s+\S/u.test(line)) return null; // 들여쓴 이어진 줄만 건너뛴다
  }
  return null;
}

function insideFence(lines, at) {
  let open = false;
  for (const line of lines.slice(0, at)) if (FENCE.test(line)) open = !open;
  return open;
}

// 한도 줄과 같은 덩어리(빈 줄 전까지) 위쪽에 응답 머리표가 있거나, 빈 줄을 건너 바로 위 글줄이 응답 머리표 줄이면 응답 안의 글이다.
// 위로 훑다가 사용자 입력 줄(`❯ 글`)이나 턴 끝 줄(`✻ … for …`)을 만나면 거기서 멈춘다 — 그 앞의 응답은 이전 턴이다(F6).
// 응답 머리표 줄이 그 자체로 한도 머리말이면(실측 2.1.308: `⏺ Usage limit reached again · continuing automatically …`) 응답 문맥이 아니라
// 한도 덩어리의 일부로 본다.
function precededByResponse(lines, at) {
  const boundary = (line) => USER_INPUT_LINE.test(line) || TURN_DONE.test(line);
  const response = (line) => RESPONSE_LINE.test(line) && !limitHeadOf(line);
  let above = at - 1;
  while (above >= 0 && !RULE_OR_BLANK.test(lines[above])) {
    if (boundary(lines[above])) return false;
    if (response(lines[above])) return true;
    above--;
  }
  while (above >= 0 && RULE_OR_BLANK.test(lines[above])) above--;
  return above >= 0 && !boundary(lines[above]) && response(lines[above]);
}
