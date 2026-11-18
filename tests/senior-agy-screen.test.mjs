import test from 'node:test';
import assert from 'node:assert/strict';
import {agyComposerHolds, agyComposerReady, agyScreenWorking, findAgyBoundary, readAgyAnswer, readAgyComposer,
  readAgyTrust} from '../src/senior-agy-screen.mjs';
import {ANSWER_LIMIT_BYTES} from '../src/senior-screen.mjs';

// agy 대화창 화면 판정(순수 함수). 화면 모양은 agy 1.5.10 조사 화면(2026-11-18)을 따르되 경로·계정·출처는 가짜 값이다.
const RULE = '─'.repeat(150);
const RIGHT = 'auto · kadan-noexec (Fake Model · medium)  /agents';
const foot = left => left + ' '.repeat(150 - left.length - RIGHT.length) + RIGHT;
const screen = (...rows) => rows.flat().join('\n');
const BANNER = ['', '      ▄▀▀▄        Fake Antigravity CLI 0.0.0', '     ▀▀▀▀▀▀       fake-account (Fake Plan)',
  '    ▀▀▀▀▀▀▀▀      Fake Model (Medium)', '   ▄▀▀    ▀▀▄     ~/fake/senior-agy', '  ▄▀▀      ▀▀▄', ''];
const INTRO = [' ┃ Introducing Fake Model', ' ┃ A fake daily driver for tests!', ' ┃ esc to dismiss'];
const LINE = '다음 파일을 끝까지 읽고 거기 적힌 대로 수행하라: /fake/home/senior-agy/asks/11111111-2222-3333-4444-555555555555-1.txt';
// 길어서 화면에서 감긴 꼴: 둘째 줄부터 두 칸 들여 이어진다.
const LINE_ROWS = [`> ${LINE.slice(0, 60)}`, `  ${LINE.slice(60)}`];
const MARKER = 'KADAN-SENIOR-END-0a1b2c3d';
const IDLE = screen(BANNER, RULE, '>', RULE, foot('? for shortcuts'));
// 첫 기동: 배너와, 글이 든 것처럼 보이는 빈 입력칸(안내 글). 바닥글은 빈 입력칸과 같다.
const FIRST = screen(BANNER, INTRO, RULE, '> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)', RULE, foot('? for shortcuts'));
const TYPED = screen(BANNER, RULE, ...LINE_ROWS, RULE, foot(''));
// 생성 중: 빈 `>`가 보이지만 바닥글이 `esc to cancel`이고 가로줄 위에 일하는 표시가 있다.
const WORKING = screen(BANNER, RULE, ...LINE_ROWS, '⣟  Generating...', RULE, '>', RULE, foot('esc to cancel'));
// 모르는 선택 화면(명령 완성 목록): 입력칸 아래가 한 줄이 아니다.
const MENU = screen(BANNER, RULE, '> /permissions', RULE, '> /permissions  Manage tool permissions', '',
  '  ↑/↓ Navigate · enter Select · tab Complete', foot('esc to cancel'));
const trust = (paths, options = ['> Yes, I trust this folder', '  No, exit']) => screen('Accessing workspace:', '', ...paths, '',
  'Do you trust the contents of this project?', '', 'Fake Antigravity CLI requires permission to read, edit, and execute files here.', '',
  ...options, '', '  ↑/↓ Navigate · enter Confirm', ' '.repeat(110) + 'auto · Fake Model · medium');
const TRUST = trust(['/fake/home/senior-agy']);

test('빈 입력칸(붙여넣기 직전): 바닥글이 ? for shortcuts일 때만 통과한다 — 첫 기동 배너·안내 글은 통과, 생성 중의 빈 >·글이 든 칸·선택 화면·신뢰 창은 거절', () => {
  assert.deepEqual(agyComposerReady(IDLE), {ok: true});
  assert.deepEqual(agyComposerReady(FIRST), {ok: true}, '첫 기동 배너와 입력칸 안내 글');
  assert.deepEqual(agyComposerReady(WORKING), {ok: false, why: 'working'}, '생성 중에도 보이는 빈 >');
  assert.deepEqual(agyComposerReady(TYPED), {ok: false, why: 'composer-has-text'});
  assert.deepEqual(agyComposerReady(MENU), {ok: false, why: 'lines-below-composer'});
  assert.deepEqual(agyComposerReady(TRUST), {ok: false, why: 'no-composer'});
  assert.deepEqual(agyComposerReady(''), {ok: false, why: 'no-composer'});
  // 바닥글에 우리가 띄운 에이전트 이름이 없으면(다른 화면·다른 에이전트) 통과하지 못한다.
  assert.deepEqual(agyComposerReady(screen(BANNER, RULE, '>', RULE, '? for shortcuts' + ' '.repeat(90) + 'auto · Fake Model · medium')),
    {ok: false, why: 'unknown-footer'});
  // 바닥글이 없거나, 가로줄 사이가 입력칸 모양이 아니면 아니다.
  assert.deepEqual(agyComposerReady(screen(BANNER, RULE, '>', RULE)), {ok: false, why: 'no-footer'});
  assert.deepEqual(agyComposerReady(screen(BANNER, RULE, '답의 한 줄', RULE, foot('? for shortcuts'))), {ok: false, why: 'no-composer'});
  // 일하는 표시가 가로줄 위에 있으면 바닥글이 무엇이든 쉬는 화면이 아니다.
  assert.deepEqual(agyComposerReady(screen(BANNER, '⣯  Working...', RULE, '>', RULE, foot('? for shortcuts'))), {ok: false, why: 'working'});
  assert.equal(agyScreenWorking(WORKING), true);
  for (const idle of [IDLE, FIRST, TYPED, MENU, TRUST]) assert.equal(agyScreenWorking(idle), false);
});

test('자기 한 줄(Enter 직전): 입력칸의 글이 방금 붙인 줄과 같고 바닥글 왼쪽이 비어 있을 때만 통과한다(감긴 줄은 이어 견준다)', () => {
  assert.deepEqual(agyComposerHolds(TYPED, LINE), {ok: true});
  assert.equal(readAgyComposer(TYPED).text.replace(/\s+/gu, ''), LINE.replace(/\s+/gu, ''));
  assert.deepEqual(agyComposerHolds(TYPED, `${LINE} 덧붙임`), {ok: false, why: 'composer-not-own-line'});
  assert.deepEqual(agyComposerHolds(screen(BANNER, RULE, `> 먼저 있던 글 ${LINE}`, RULE, foot('')), LINE), {ok: false, why: 'composer-not-own-line'});
  assert.deepEqual(agyComposerHolds(IDLE, LINE), {ok: false, why: 'composer-empty'});
  assert.deepEqual(agyComposerHolds(WORKING, LINE), {ok: false, why: 'working'});
  assert.deepEqual(agyComposerHolds(MENU, '/permissions'), {ok: false, why: 'lines-below-composer'}, '완성 목록이 뜬 화면');
  assert.deepEqual(agyComposerHolds(TRUST, LINE), {ok: false, why: 'no-composer'});
  assert.deepEqual(agyComposerHolds(TYPED, ''), {ok: false, why: 'composer-not-own-line'});
});

test('신뢰 창: 조사 화면의 구조일 때만 신뢰 창이고 경로 한 줄·선택 하나를 읽는다 — 경로 두 줄·선택 모호·다른 창은 통과 조건이 되지 못한다', () => {
  assert.deepEqual(readAgyTrust(TRUST), {found: true, path: '/fake/home/senior-agy', selected: 'yes'});
  assert.deepEqual(readAgyTrust(trust(['/fake/home/senior-agy'], ['  Yes, I trust this folder', '> No, exit'])),
    {found: true, path: '/fake/home/senior-agy', selected: 'no'});
  assert.deepEqual(readAgyTrust(trust(['/fake/home/senior-agy', '/fake/other'])), {found: true, path: null, selected: 'yes'}, '경로가 두 줄이면 읽지 않는다');
  assert.deepEqual(readAgyTrust(trust(['/fake/home/senior-agy'], ['> Yes, I trust this folder', '> No, exit'])).selected, null);
  assert.deepEqual(readAgyTrust(trust(['/fake/home/senior-agy'], ['  Yes, I trust this folder', '  No, exit'])).selected, null);
  // 신뢰 창이 아닌 것: 빈 화면, 입력칸, 경로 줄 없음, 선택지가 다름, 확인 안내가 다름, 신뢰 창 아래에 다른 줄이 더 있음.
  for (const other of ['', IDLE, FIRST, MENU, trust([]), trust(['/p'], ['> Yes, always', '  No, exit']),
    TRUST.replace('enter Confirm', 'enter Select'), `${TRUST}\n> 1. Update now\n  2. Skip`, `Notice: something else\n${TRUST}`]) {
    assert.deepEqual(readAgyTrust(other), {found: false}, other.slice(0, 60));
  }
});

// 스크롤 기록 꼴: 배너 → 되찍힌 질문 → 생각 줄 → 두 칸 들인 답 → 표지 → (출처 묶음) → 입력칸.
const history = (answer, {tail = [], question = LINE_ROWS, before = []} = {}) => screen(BANNER, before, RULE, ...question, '',
  '○ Thought for 2.0s (fake thinking about the question...)', '● Explored 1 file (AGENTS.md) (ctrl+o to expand)', '', '▸ Thought for 3s, 40 tokens', '',
  ...answer, ...tail, '', RULE, '>', RULE, foot('? for shortcuts'));
const BODY = ['  결론: 그대로 간다', '  근거: 파일을 읽었다', '', '  • 첫째', '  • 둘째'];
const read = capture => readAgyAnswer(capture, {line: LINE, marker: MARKER});

test('답 회수: 시작 경계 뒤에서 표지가 단독 줄로 한 번이고 그 뒤가 agy 꼬리뿐일 때만 답이다. 들여쓰기를 걷고 생각·도구 줄은 뺀다', () => {
  const ok = read(history([...BODY, '', `  ${MARKER}`]));
  assert.deepEqual(ok, {ok: true, answer: '결론: 그대로 간다\n근거: 파일을 읽었다\n\n• 첫째\n• 둘째'});
  assert.ok(!ok.answer.includes(MARKER) && !ok.answer.includes('Thought'));
  // 표지 뒤의 출처 묶음·펼치기 안내는 버린다.
  const sources = ['', '  Sources:', '    ▸ source.invalid', '    ▸ source.invalid', '', '  (ctrl+o to expand)'];
  assert.deepEqual(read(history([...BODY, `  ${MARKER}`], {tail: sources})), ok);
  // 긴 답: 60줄이 순서대로 전부 온다.
  const long = Array.from({length: 60}, (_, index) => `  LINE-${String(index + 1).padStart(3, '0')}`);
  assert.equal(read(history([...long, `  ${MARKER}`])).answer, long.map(row => row.trim()).join('\n'));
});

test('ok 오판 막기: 표지 없음·둘·본문에 인용·단독 줄 아님·표지 뒤 본문·표지만·상한 초과는 답이 아니다', () => {
  assert.deepEqual(read(history(BODY)), {ok: false, why: 'no-marker'});
  assert.deepEqual(read(history([...BODY, `  ${MARKER}`, '  결론: 둘째 답', `  ${MARKER}`])), {ok: false, why: 'marker-repeated'});
  // 본문에 표지를 인용하고 끝에도 쓴 답: 어느 것이 끝인지 구조로 가를 수 없다.
  assert.deepEqual(read(history([`  결론: 끝 표지는 ${MARKER} 이다`, ...BODY, `  ${MARKER}`])), {ok: false, why: 'marker-repeated'});
  assert.deepEqual(read(history([...BODY, `  끝 ${MARKER}`])), {ok: false, why: 'marker-not-alone'});
  assert.deepEqual(read(history([...BODY, `  ${MARKER}`, '', '  덧붙임: 표지 뒤의 본문'])), {ok: false, why: 'text-after-marker'});
  // 출처 묶음 모양이 아닌 `▸` 줄(묶음 머리 없이)은 꼬리로 받지 않는다.
  assert.deepEqual(read(history([...BODY, `  ${MARKER}`], {tail: ['', '    ▸ source.invalid']})), {ok: false, why: 'text-after-marker'});
  assert.deepEqual(read(history([`  ${MARKER}`])), {ok: false, why: 'marker-only'});
  const big = Array.from({length: 3000}, () => `  ${'가'.repeat(40)}`);
  assert.ok(Buffer.byteLength(big.join('\n')) > ANSWER_LIMIT_BYTES);
  assert.deepEqual(read(history([...big, `  ${MARKER}`])), {ok: false, why: 'answer-too-big'});
});

test('시작 경계: 이번 질문 줄이 정확히 한 번 남아 있어야 한다 — 밀려나 없으면·둘이면·경계 뒤에 다른 입력이 있으면 회수를 믿지 않는다(lost)', () => {
  const answer = [...BODY, `  ${MARKER}`];
  // 경계가 밀려난 캡처: 답의 뒤쪽과 표지·빈 입력칸은 그대로 남아 있다(잘린 답을 ok로 받으면 안 되는 경우).
  const cut = screen(...answer.slice(2), '', RULE, '>', RULE, foot('? for shortcuts'));
  assert.deepEqual(read(cut), {ok: false, why: 'boundary-lost', lost: true});
  const twice = history(answer, {before: [RULE, ...LINE_ROWS, '', '  옛 답', `  ${MARKER}`, '']});
  assert.deepEqual(read(twice), {ok: false, why: 'boundary-repeated', lost: true});
  // 다른 질문의 경계와 표지는 이번 것이 아니다.
  const other = history(answer, {question: ['> 다른 질문이다']});
  assert.deepEqual(read(other), {ok: false, why: 'boundary-lost', lost: true});
  const more = history([...answer, '', RULE, '> 누군가 넣은 다른 입력', '', '  다른 답']);
  assert.deepEqual(read(more), {ok: false, why: 'other-input-after-boundary', lost: true});
  // 입력칸이 화면 끝에 없는 캡처(끝이 잘림)도 받지 않는다.
  assert.deepEqual(read(screen(BANNER, RULE, ...LINE_ROWS, '', ...answer)), {ok: false, why: 'no-composer', lost: true});
  // 경계 찾기: 한 줄로 온 것과 감긴 것을 같은 줄로 본다. 앞머리만 같은 줄은 경계가 아니다.
  assert.deepEqual(findAgyBoundary([`> ${LINE}`, '', '  답'], LINE), [0]);
  assert.deepEqual(findAgyBoundary([...LINE_ROWS, '  답 첫 줄'], LINE), [1]);
  assert.deepEqual(findAgyBoundary([`> ${LINE.slice(0, 40)}`, '', '  답'], LINE), []);
  assert.deepEqual(findAgyBoundary([`> ${LINE} 그리고 더`], LINE), []);
});
