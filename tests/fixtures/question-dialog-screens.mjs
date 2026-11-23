// Claude Code 2.1.330 선택 질문 창(AskUserQuestion) 화면의 고정 입력.
// 실제 슈퍼감독 창의 출력 기록(gzip 조각, 폭 152)을 격리 tmux 창(폭 152)에 앞에서부터 다시 그리고 `capture-pane -p -J`로 뜬 화면에서
// 창 부분(탭 줄 또는 질문 줄부터 바닥 안내까지)만 잘랐다. 줄 구조·기호·고정 안내 문구는 그대로이고, 질문·선택지 글만 뜻 없는 글로 바꿨다(공개 레포).
// 풀린 기록의 바이트 위치(원본은 카드 evidenceDir에만 있다):
//   MULTI_CHOICE        (가) 여러 질문 창, 선택지 커서   — 바이트 1,091,500 직후 화면
//   TYPE_SOMETHING      (나) 직접 입력 칸 커서(사고의 실제 꼴) — 바이트 1,213,500 직후 화면
//   SINGLE_ARROW        (다) 질문 하나짜리 창, `↑/↓` 안내 — 바이트 1,338,900 직후 화면(안내 줄 자체는 1,338,811)
// 아래 줄은 위 캡처에서 파생했다. MULTI_CHOICE의 안내 줄이 두 번인 것도 다시 그린 화면 그대로다.
export const MULTI_CHOICE = [
  "←  ☒ 가가  ☐ 가  ☐ 가가  ☐ 가가 ETF  ✔ Submit  →",
  "│ 가가가 가가 가가 가가가 가가가? 가가 /aaaaaa 가가가 가가=가가, 가가=가가가가가 가가가 가가 가가, 가가 가가가가 가가가가가.",
  "❯ 1. 가가 가가/가가 가가 (가가가가)",
  "     /aaaaaa가 가가 가 가가 가가가가.",
  "  2. 가가 가가/가가 가가",
  "     가가 가가가 가가(가가가 가가)가 가가가가.",
  "  3. Type something.",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  4. Chat about this",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
].join('\n') + '\n';
export const TYPE_SOMETHING = [
  "←  ☐ 가가가  ☐ 가가 가가  ☐ 가 가가  ✔ Submit  →",
  "│ 가가 1. 111가가가 가가가 가가 가가 가가 가가가 가 가가가 가가가 가가가가? 가가 가가 aaa가 111가가가가 1.1% 가가가 가가가 가가가가, 가가 가가가가",
  "│ '가가'가 가가가가.",
  "  1. a. '가가가' 가가 (가가)",
  "     가가 가가 가가 가가 가가/가가가 가가가, 가가가 가가 '가가가' 가가가 가가가. aaa가 '가가가'가 가가가. 가가가 가가 가가가 가가가 가가 가가 가가",
  "     가가가 가가가가.",
  "  2. a. 111가가가 가가",
  "     가가가가 111가가 가가 가가, 가가가 가가가가가. 가가 가가가 가가가 가가 가가가가 가가가가.",
  "  3. a. 가가/가가 + '가가 가가'",
  "     가가가 111가가 가가 가가가 가가, 가가가 가가가가가 가가 가가 '가가 가가' 가가 가가가가 가가가가.",
  "❯ 4. Type something.",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  5. Chat about this",
  "Enter to select · Tab/Arrow keys to navigate · ctrl+g to edit in Vim · Esc to cancel",
].join('\n') + '\n';
export const SINGLE_ARROW = [
  "│ 가가 가가가 가가 aaa가 '111가가 가 + 가가 가가 + 가가가', 가가가 11가가가 '111가가 가가'가가가. 가 가가가 가가가가 가가가?",
  "❯ 1. 가가가 가가",
  "     가 가가 가가가가 가가가 가가가가.",
  "  2. 가가 가가가 가가가",
  "     '가가 가가' 가가 '111가가·가가' 가가 가가가 가가가. 가가가가 가가가 가가가.",
  "  3. 가가 가 가가",
  "     '가가'가 가가 가가가 가가 가가가.",
  "  4. Type something.",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  5. Chat about this",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join('\n') + '\n';
// (나)에서 사람이 칸에 글을 쓴 꼴: 칸의 `Type something.` 자리에 입력한 글이 보인다(손으로 바꾼 파생).
export const TYPE_SOMETHING_TYPED = TYPE_SOMETHING.replace('Type something.', '아 가나다 라마바');

// ---- 아래는 손으로 만든 화면(실제 창이 아닌 쪽) ----
const RULE = '─'.repeat(60);
// ↑/↓ 바닥 안내가 있어도 이 창의 선택지(`Chat about this`)가 없으면 다른 창일 수 있어 막지 않는다.
export const ARROW_OTHER_DIALOG = ['⏺ 가나다 라마바', 'Do you want to proceed?', '❯ 1. Yes', '  2. No', '', 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n') + '\n';
// 평소 빈 입력창(바닥 상태 줄 포함)
export const INPUT_BOX = [RULE, '❯ ', RULE, '  ~/work[main]', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n');
export const IDLE = `⏺ 가나다 라마바 사아자\n${INPUT_BOX}\n`;
// 창 문구(바닥 안내·탭 줄)를 인용한 응답 아래에 평소 입력창이 이어지는 화면
export const QUOTED_THEN_INPUT = `${[
  '⏺ 그 창은 이렇게 보입니다:', '  ```', '  Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
  '  Enter to select · Tab/Arrow keys to navigate · ctrl+g to edit in Vim · Esc to cancel',
  '  Enter to select · ↑/↓ to navigate · Esc to cancel', '  ```',
].join('\n')}\n${INPUT_BOX}\n`;
// 응답 끝에 안내 한 줄을 이어 쓴 꼴(줄 처음이 아니다)
export const QUOTED_AT_LINE_END = '⏺ 바닥에 Enter to select · Tab/Arrow keys to navigate · Esc to cancel';
