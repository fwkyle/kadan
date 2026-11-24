import test from 'node:test';
import assert from 'node:assert/strict';
import {readAgyAnswer} from '../src/senior-agy-screen.mjs';

// agy 답 끝 표지 줄이 마크다운 강조 기호(`*` `_` `` ` ``)를 달고 그려져도 답을 회수하는지(표지 줄 판정만) 고정한다.
// 화면 모양은 운영 기록 5건의 상태 구역(표지 줄과 입력칸·바닥글)을 따르되 답 본문·경로·표지 id 말고는 뜻 없는 글이다.
const RULE = '─'.repeat(150);
const FOOT_RIGHT = 'auto · kadan-noexec (Gemini 4 Neon · xhigh)  /agents';
const foot = left => left + ' '.repeat(150 - left.length - FOOT_RIGHT.length) + FOOT_RIGHT;
const LINE = '다음 파일을 끝까지 읽고 거기 적힌 대로 수행하라: /fake/home/senior-agy/asks/11111111-2222-3333-4444-555555555555-1.txt';
const LINE_ROWS = [`> ${LINE.slice(0, 60)}`, `  ${LINE.slice(60)}`];
const BANNER = ['', '      ▄▀▀▄        Fake Antigravity CLI 0.0.0', '   ▄▀▀    ▀▀▄     ~/fake/senior-agy', ''];
const BODY = ['  결론: 그대로 간다', '  근거: 파일을 읽었다'];
const ANSWER = '결론: 그대로 간다\n근거: 파일을 읽었다';
const MARKER = 'KADAN-SENIOR-END-0a1b2c3d';
const IDLE_END = [RULE, '>', RULE, foot('? for shortcuts')];
const history = answer => [...BANNER, RULE, ...LINE_ROWS, '', '○ Thought for 2.0s (fake)', '', ...answer, '', ...IDLE_END].join('\n');
const read = (rows, marker = MARKER) => readAgyAnswer(history(rows), {line: LINE, marker});
const OK = {ok: true, answer: ANSWER};

// 운영 기록 `~/.kadan/advice/<앞 8자>-*/2-agy-gemini-4-neon-xhigh/screen-final.txt`에서 뜯은 표지 id. 줄 끝에 `*`가 붙어 있었다.
const REAL = [['e54bbd76', '37d6d105'], ['3fff25af', '81d8a242'], ['1b1525fb', 'bc8d231b'], ['0b095446', '888b001a'], ['eadb5c06', '2e575303']];

test('표 1: 표지만 있는 줄은 지금처럼 답을 회수한다', () => {
  assert.deepEqual(read([...BODY, '', `  ${MARKER}`]), OK);
});

test('표 2: 표지 줄 앞뒤에 강조 기호(* _ `)만 붙으면 표지로 인정하고 답 본문은 바뀌지 않는다', () => {
  for (const shape of ['{}*', '**{}**', '_{}_', '__{}__', '`{}`', '*{}*', '{}**', '{}* ']) {
    assert.deepEqual(read([...BODY, '', `  ${shape.replace('{}', MARKER)}`]), OK, shape);
  }
  // 출처 묶음 꼬리와 함께여도 같다.
  assert.deepEqual(read([...BODY, `  ${MARKER}*`, '', '  Sources:', '    ▸ source.invalid', '', '  (ctrl+o to expand)']), OK);
});

test('표 2 실측: 운영 기록 5건(e54bbd76·3fff25af·1b1525fb·0b095446·eadb5c06)의 `<표지>*` 줄 모양은 모두 답을 회수한다', () => {
  for (const [folder, id] of REAL) {
    const marker = `KADAN-SENIOR-END-${id}`;
    assert.deepEqual(read([...BODY, '', `  ${marker}*`], marker), OK, `${folder} ${marker}*`);
  }
});

test('표 3: 표지가 문장 안에 있으면(강조 기호 아닌 글이 앞뒤에 붙음) 강조 기호가 있어도 marker-not-alone이다', () => {
  for (const row of [`끝 ${MARKER}`, `끝 ${MARKER}*`, `**끝** ${MARKER}`, `${MARKER} 끝`, `*${MARKER}* 끝`, `-${MARKER}`, `${MARKER}:`]) {
    assert.deepEqual(read([...BODY, `  ${row}`]), {ok: false, why: 'marker-not-alone'}, row);
  }
});

test('표 4: 표지(강조 기호 붙은 것 포함) 뒤에 다른 글이 이어지면 text-after-marker다', () => {
  for (const shape of ['{}', '{}*', '**{}**']) {
    assert.deepEqual(read([...BODY, `  ${shape.replace('{}', MARKER)}`, '', '  덧붙임: 표지 뒤의 본문']), {ok: false, why: 'text-after-marker'}, shape);
  }
});

test('표 5: 표지가 둘 이상이면(강조 기호 붙은 것 포함) marker-repeated다', () => {
  assert.deepEqual(read([...BODY, `  ${MARKER}*`, '  결론: 둘째 답', `  ${MARKER}*`]), {ok: false, why: 'marker-repeated'});
  assert.deepEqual(read([...BODY, `  ${MARKER}`, '  결론: 둘째 답', `  **${MARKER}**`]), {ok: false, why: 'marker-repeated'});
  assert.deepEqual(read([...BODY, `  ${MARKER}`, `  ${MARKER}*`]), {ok: false, why: 'marker-repeated'});
});

test('표 6: 다른 id의 표지는 강조 기호가 붙어도 표지로 인정하지 않는다', () => {
  const other = 'KADAN-SENIOR-END-ffffffff';
  for (const shape of ['{}', '{}*', '**{}**', '`{}`']) {
    assert.deepEqual(read([...BODY, `  ${shape.replace('{}', other)}`]), {ok: false, why: 'no-marker'}, shape);
  }
  // 다른 id가 이번 표지로 시작해도(뒤에 글자가 더 붙음) 이번 표지가 아니다.
  assert.equal(read([...BODY, `  ${MARKER}0*`]).ok, false);
  assert.equal(read([...BODY, `  X${MARKER}*`]).ok, false);
});

test('표 7: 본문 인용 속 표지 언급은 강조 기호가 붙은 꼴이어도 언급으로 세어 진짜 표지 줄과 함께면 marker-repeated다', () => {
  const quoted = ['  결론: 끝 표지는 {} 이다', ...BODY];
  for (const shape of ['{}', '{}*', '**{}**', '`{}`']) {
    const rows = [quoted[0].replace('{}', shape.replace('{}', MARKER)), ...BODY];
    assert.deepEqual(read([...rows, `  ${MARKER}`]), {ok: false, why: 'marker-repeated'}, `${shape} + 진짜 표지`);
    assert.deepEqual(read([...rows, `  ${MARKER}*`]), {ok: false, why: 'marker-repeated'}, `${shape} + 강조 표지`);
  }
  // 인용만 있고 단독 표지 줄이 없으면 지금처럼 marker-not-alone이다.
  assert.deepEqual(read(['  결론: 끝 표지는 `' + MARKER + '` 이다', ...BODY]), {ok: false, why: 'marker-not-alone'});
});
