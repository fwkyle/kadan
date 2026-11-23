// Claude Code 2.1.330 선택 질문 창(AskUserQuestion) 화면의 고정 입력. 모양만 실제 화면에서 가져오고 글은 뜻 없는 글로 바꿨다(공개 레포).
// 모양의 출처: 실제 슈퍼감독 창의 출력 기록(폭 152)을 격리 tmux에 다시 그려 `capture-pane -p -J`로 뜬 화면.
//   (가) 여러 질문 창·선택지 커서 / (나) 직접 입력 칸 커서 — 기록 바이트 1,213,500 근처와 1,091,500 근처에서 확정.
//   (다) ↑/↓ 꼴 — 바닥 안내 조각은 바이트 1,109,357, 검토 단계(Review your answers) 줄은 바이트 1,096,800에서 확인했다.
//        두 조각을 한 장으로 다시 그린 화면은 얻지 못해 이 화면은 그 줄들을 이어 붙인 것이다(결과 파일에 적음).
// 원본 그대로의 캡처는 카드 evidenceDir에만 둔다.
const RULE = '─'.repeat(60);
const TABS = '←  ☒ 갑  ☐ 을  ☐ 병  ✔ Submit  →';
const PREVIOUS = ['⏺ 가나다 라마바 사아자', '  ⎿  차카타 파하 (3줄 더 보기)', RULE];
const QUESTION = ['│ 가나다 라마바 사아자 차카타 파하?', '│ 거너더 러머버 서어저.'];
const OPTIONS = (cursor, third = 'Type something.') => [
  `${cursor === 1 ? '❯' : ' '} 1. 가가 (추천)`, '     나나나 다다다 라라라.',
  `${cursor === 2 ? '❯' : ' '} 2. 마마`, '     바바바 사사사.',
  `${cursor === 3 ? '❯' : ' '} 3. ${third}`,
  RULE,
  '  4. Chat about this',
];
const FOOTER_TAB = 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel';
const FOOTER_TAB_VIM = 'Enter to select · Tab/Arrow keys to navigate · ctrl+g to edit in Vim · Esc to cancel';
const FOOTER_ARROW = 'Enter to select · ↑/↓ to navigate · Esc to cancel';
const screen = (...lines) => `${[...PREVIOUS, ...lines.flat()].join('\n')}\n`;

// (가) 여러 질문 창: 선택지(1번)에 커서
export const MULTI_CHOICE = screen(TABS, '', QUESTION, '', OPTIONS(1), '', FOOTER_TAB);
// (나) 직접 입력 칸에 커서(이번 사고의 실제 경우). 바닥 안내에 `ctrl+g to edit in Vim`이 끼고, 입력한 글이 있으면 칸에 보인다.
export const TYPE_SOMETHING = screen(TABS, '', QUESTION, '', OPTIONS(3), '', FOOTER_TAB_VIM);
export const TYPE_SOMETHING_TYPED = screen(TABS, '', QUESTION, '', OPTIONS(3, '아 가나다 라마바'), '', FOOTER_TAB_VIM);
// (다) ↑/↓ 꼴: 검토·제출 단계
export const REVIEW_ARROW = screen(
  '←  ☒ 갑  ☒ 을  ☒ 병  ✔ Submit  →', '', 'Review your answers', '',
  ' │ ● 가나다 라마바 사아자 차카타 파하?', '   → 가가 (추천)', ' │ ● 거너더 러머버 서어저?', '   → 마마', '',
  '❯ 1. Submit answers', '  2. Cancel', '', FOOTER_ARROW,
);
// (다') ↑/↓ 바닥 안내만 있고 이 창의 선택지가 없는 화면: 다른 창일 수 있어 막지 않는다.
export const ARROW_OTHER_DIALOG = screen('Do you want to proceed?', '❯ 1. Yes', '  2. No', '', FOOTER_ARROW);

// 평소 빈 입력창(바닥 상태 줄 포함)
export const INPUT_BOX = [RULE, '❯ ', RULE, '  ~/work[main]', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n');
export const IDLE = `${PREVIOUS.join('\n')}\n${INPUT_BOX}\n`;
// 창 문구(바닥 안내·탭 줄)를 인용한 응답 아래에 평소 입력창이 이어지는 화면
export const QUOTED_THEN_INPUT = `${[
  '⏺ 그 창은 이렇게 보입니다:', '  ```', `  ${TABS}`, `  ${FOOTER_TAB}`, `  ${FOOTER_TAB_VIM}`, `  ${FOOTER_ARROW}`, '  ```',
].join('\n')}\n${INPUT_BOX}\n`;
// 응답 끝에 안내 한 줄을 이어 쓴 꼴(줄 처음이 아니다)
export const QUOTED_AT_LINE_END = `⏺ 바닥에 ${FOOTER_TAB}`;
