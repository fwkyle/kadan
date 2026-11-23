// 우편이 Claude Code 선택 질문 창(AskUserQuestion)의 입력 칸에 붙은 사고(2026-11-23)의 재발 방지.
// 고정 입력은 Claude Code 2.1.330 화면의 모양이다(tests/fixtures/question-dialog-screens.mjs, 글은 뜻 없는 글로 바꿈).
// 판정 동작 표 1~8과 이 파일의 시험 이름이 짝이다(번호는 시험 이름 앞의 `[표 N]`).
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {sendTmux, hasQuestionDialog} from '../src/floor-tmux.mjs';
import {isNotificationHold, isStorableMailHold} from '../src/notification-guard.mjs';
import {openAlerts} from '../src/dashboard-band.mjs';
import * as screens from './fixtures/question-dialog-screens.mjs';

const noopSpawn = () => ({});
function fakeRun(screen, calls) {
  return args => {
    calls.push(args);
    if (args[0] === 'capture-pane') { if (screen instanceof Error) throw screen; return screen; }
    if (args[0] === 'display-message') return '0\n';
    if (args[0] === 'list-clients') return '';
    return undefined;
  };
}
const keysSent = calls => calls.filter(c => ['load-buffer', 'paste-buffer', 'send-keys'].includes(c[0])).length;
const hardWrap = (text, width) => text.split('\n').flatMap(line => line === '' ? [''] : (line.match(new RegExp(`[\\s\\S]{1,${width}}`, 'gu')) ?? [''])).join('\n');
const identity = {currentPid: '1', harness: 'claude', model: 'm'};
const VARIANTS = {
  '일반 우편': {},
  '카드 발령(cardIdentity)': {cardIdentity: identity},
  '감시 알림(5번째 강제 차례)': {notificationGuard: {force: true, humanIdleMs: 30000}},
};

function assertHeld(screen, name, options = {}) {
  const calls = [];
  assert.throws(() => sendTmux('kadan-qd', '본문', {run: fakeRun(screen, calls), spawn: noopSpawn, ...options}), error => {
    assert.equal(error.code, 'KADAN_QUESTION_DIALOG', name);
    assert.equal(error.delivery, 'not-sent', name);
    assert.equal(error.inputAcceptance, 'unconfirmed');
    assert.match(error.message, /선택 질문 창/);
    return true;
  }, name);
  assert.equal(keysSent(calls), 0, `${name}: 키 0회`);
  assert.deepEqual(calls.map(c => c[0]), ['capture-pane'], `${name}: 화면 읽기 한 번뿐`);
}

test('[표 1] 여러 질문 창(선택지 커서)이면 보내지 않고 KADAN_QUESTION_DIALOG + not-sent', () => {
  assert.equal(hasQuestionDialog(screens.MULTI_CHOICE), true);
  assertHeld(screens.MULTI_CHOICE, '여러 질문 창');
});

test('[표 2] 직접 입력 칸(Type something.) 커서도 같다(이번 사고의 실제 경우, 입력한 글이 있어도)', () => {
  for (const [name, screen] of Object.entries({'빈 칸': screens.TYPE_SOMETHING, '글 입력됨': screens.TYPE_SOMETHING_TYPED})) {
    assert.equal(hasQuestionDialog(screen), true, name);
    assertHeld(screen, name);
  }
});

test('[표 3] ↑/↓ 꼴: 질문 하나짜리 창(선택지 `Chat about this`가 위에 있음)이면 같고, 다른 창으로 보이면 지금처럼 보낸다', () => {
  assert.equal(hasQuestionDialog(screens.SINGLE_ARROW), true);
  assertHeld(screens.SINGLE_ARROW, '질문 하나짜리 창');
  assert.equal(hasQuestionDialog(screens.ARROW_OTHER_DIALOG), false);
  const calls = [];
  assert.equal(sendTmux('kadan-qd', '본문', {run: fakeRun(screens.ARROW_OTHER_DIALOG, calls), spawn: noopSpawn}).keyDelivery, 'sent');
});

test('[표 4] 평소 빈 입력창이면 지금처럼 전달한다', () => {
  assert.equal(hasQuestionDialog(screens.IDLE), false);
  for (const screen of [screens.IDLE, '', '\n\n']) {
    const calls = [];
    const receipt = sendTmux('kadan-qd', '본문', {run: fakeRun(screen, calls), spawn: noopSpawn});
    assert.equal(receipt.keyDelivery, 'sent');
    assert.equal(calls.filter(c => c[0] === 'paste-buffer').length, 1);
    assert.equal(calls.filter(c => c[0] === 'send-keys').length, 1);
  }
  assert.equal(hasQuestionDialog(undefined), false);
});

test('[표 5] 창 문구를 인용한 응답 아래에 평소 입력창이 이어지면 전달한다(화면 끝 기준)', () => {
  for (const [name, screen] of Object.entries({'인용 뒤 입력창': screens.QUOTED_THEN_INPUT, '줄 끝에 이어 쓴 인용': screens.QUOTED_AT_LINE_END})) {
    assert.equal(hasQuestionDialog(screen), false, name);
    const calls = [];
    assert.equal(sendTmux('kadan-qd', '본문', {run: fakeRun(screen, calls), spawn: noopSpawn}).keyDelivery, 'sent', name);
  }
  // 안내 줄이 화면 끝이어도 아래에 빈 줄·공백 줄만 이어지면 창이 떠 있는 것이다(창 높이가 커서 생기는 빈 줄).
  assert.equal(hasQuestionDialog(`${screens.MULTI_CHOICE}${'   \n'.repeat(20)}`), true);
  // 안내 아래에 글이 한 줄이라도 있으면 창이 아니다.
  assert.equal(hasQuestionDialog(`${screens.MULTI_CHOICE}  ? for shortcuts\n`), false);
});

test('[표 6] 화면 읽기(capture-pane)가 실패하면 지금처럼 전달한다', () => {
  const calls = [];
  const receipt = sendTmux('kadan-qd', '본문', {run: fakeRun(new Error('capture 실패'), calls), spawn: noopSpawn});
  assert.equal(receipt.keyDelivery, 'sent');
  assert.equal(calls.filter(c => c[0] === 'paste-buffer').length, 1);
});

test('[표 7] 일반 우편·카드 발령·감시 알림(5번째 강제 차례) 모두 같은 검사로 키 0회 보류', () => {
  for (const screen of [screens.MULTI_CHOICE, screens.TYPE_SOMETHING, screens.SINGLE_ARROW]) {
    for (const [name, options] of Object.entries(VARIANTS)) assertHeld(screen, name, options);
  }
});

test('[표 7] 바닥 안내가 좁은 폭에서 여러 줄로 감기거나 공백이 빠져도 같다', () => {
  for (const width of [20, 30, 45]) {
    const wrapped = hardWrap(screens.TYPE_SOMETHING, width);
    assert.equal(hasQuestionDialog(wrapped), true, `폭 ${width}`);
  }
  assert.equal(hasQuestionDialog(screens.MULTI_CHOICE.replace(/ /gu, '')), true);
  // 터미널 응답 찌꺼기 줄이 맨 끝에 붙어도 창으로 본다(신뢰 창 검사와 같은 제어 시퀀스 걷기).
  assert.equal(hasQuestionDialog(`${screens.MULTI_CHOICE}\x1b[?1;2;4c`), true);
});

test('[표 8] 보류 코드는 기존 보관·재안내 길을 탄다(isNotificationHold·isStorableMailHold 참, 대시보드 문구 있음)', () => {
  let held;
  try { sendTmux('kadan-qd', '본문', {run: fakeRun(screens.TYPE_SOMETHING, []), spawn: noopSpawn}); } catch (error) { held = error; }
  assert.equal(held?.code, 'KADAN_QUESTION_DIALOG');
  assert.equal(isNotificationHold(held), true);
  assert.equal(isStorableMailHold(held), true);
  const alert = {kind: 'alert', id: 'a1', alertKind: '알림밀림', holdCode: 'KADAN_QUESTION_DIALOG', holdCount: 3, t: '2026-11-23T00:00:00.000Z'};
  const band = openAlerts([alert]);
  assert.match(band.items[0].holdReason, /선택 질문 창/);
});

// ---- PR #468 검수 발견 회귀(수정 카드 exec-65c6abfe) ----
test('[발견 1] 직접 입력 칸 안내의 편집기 이름이 Vim이 아니어도(nano·임의 낱말) 같은 판정이다', () => {
  for (const editor of ['Vim', 'nano', 'Helix', 'my-editor2']) {
    const screen = screens.TYPE_SOMETHING.replace('edit in Vim', `edit in ${editor}`);
    assert.equal(hasQuestionDialog(screen), true, editor);
    assertHeld(screen, `편집기 ${editor}`);
    for (const [name, options] of Object.entries(VARIANTS)) assertHeld(screen, `${name} / ${editor}`, options);
  }
  // 넓히지 않는다: 편집기 안내만 있고 앞의 `Enter to select · Tab/Arrow keys to navigate` 묶음이 없으면 창이 아니다.
  assert.equal(hasQuestionDialog('⏺ 응답\nctrl+g to edit in nano · Esc to cancel\n'), false);
  assert.equal(hasQuestionDialog(screens.IDLE.replace('? for shortcuts', 'ctrl+g to edit in nano')), false);
});

test('[발견 2] 방향키형 단서는 선택지 줄(`N. Chat about this`, 줄 처음부터)에서만 찾는다', () => {
  const prose = '⏺ The earlier reply mentioned Chat about this.\n';
  // 검수자 재현: 앞선 응답에서 이 말을 인용만 한 줄 + 다른 창(Yes/No) → 전달
  for (const screen of [`${prose}${screens.ARROW_OTHER_DIALOG}`, `${screens.ARROW_OTHER_DIALOG.replace('⏺ 가나다 라마바', '⏺ "5. Chat about this"를 눌러 보세요')}`]) {
    assert.equal(hasQuestionDialog(screen), false);
    const calls = [];
    assert.equal(sendTmux('kadan-qd', '본문', {run: fakeRun(screen, calls), spawn: noopSpawn}).keyDelivery, 'sent');
  }
  // 번호가 붙은 선택지 꼴은 커서 글자 있든 없든 참
  for (const option of ['  5. Chat about this', '❯ 5. Chat about this', '> 5. Chat about this']) {
    assert.equal(hasQuestionDialog(screens.SINGLE_ARROW.replace('  5. Chat about this', option)), true, option);
  }
  // 원래 방향키형 고정 입력(보류)은 그대로
  assert.equal(hasQuestionDialog(screens.SINGLE_ARROW), true);
  assertHeld(screens.SINGLE_ARROW, '질문 하나짜리 창');
});

test('[발견 3] 고정 입력에 마스크 경로·금융 용어가 남아 있지 않다', () => {
  for (const [name, value] of Object.entries(screens)) {
    if (typeof value !== 'string') continue;
    assert.doesNotMatch(value, /ETF|\/aaaaaa/u, name);
  }
});
