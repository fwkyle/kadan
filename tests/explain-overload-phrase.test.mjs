import test from 'node:test';
import assert from 'node:assert/strict';
import {wordIds, WORD_IDS} from '../src/explain-diag.mjs';
import {
  OVERLOAD_PATTERN, STOP_PHRASES, SUPERVISOR_ERROR_PATTERN, WORKER_SIGNATURES,
  anyStopWordInBottom, currentErrorBlock, currentStopPhrases,
} from '../src/watch-stop-phrases.mjs';

// 최종안 6번: 설명 AI의 과부하 문구를 공용 상수로 옮겨도 원장 id와 감시 경보는 그대로다.
const COMPOSER = '› Ask Codex to do anything';

test('설명 AI: 과부하 문구는 id overloaded 그대로, 낱말 순서도 그대로', () => {
  assert.deepEqual(wordIds('Model is overloaded, try again'), ['overloaded']);
  assert.deepEqual(wordIds('At capacity right now'), ['overloaded']);
  assert.deepEqual(wordIds('hello'), []);
  const ids = WORD_IDS;
  assert.equal(ids.indexOf('overloaded'), ids.indexOf('context_length') + 1);
  assert.equal(ids.indexOf('empty_response'), ids.indexOf('overloaded') + 1);
});

test('감시 불변: 과부하 문구는 STOP_PHRASES·감시 판정에 들어가지 않는다', () => {
  assert.ok(!STOP_PHRASES.some(p => p.id === 'overloaded'));
  assert.ok(!STOP_PHRASES.some(p => p.pattern && OVERLOAD_PATTERN.source === p.pattern.source));
  for (const text of ['overloaded', 'capacity', 'server overloaded, at capacity']) {
    WORKER_SIGNATURES.lastIndex = 0;
    assert.equal(WORKER_SIGNATURES.test(text), false, text);
    assert.equal(SUPERVISOR_ERROR_PATTERN.test(text), false, text);
  }
});

test('감시 불변: overloaded·capacity가 든 화면의 판정이 main과 같다', () => {
  const screens = [
    `■ Model is overloaded, retry later\n  └ capacity exceeded\n\n${COMPOSER}`,
    `• Working (1m 00s • esc to interrupt)\n  server at capacity\n\n${COMPOSER}`,
    `• 정상 응답: overloaded 와 capacity 는 흔한 낱말입니다.\n\n${COMPOSER}`,
  ];
  for (const screen of screens) {
    assert.equal(anyStopWordInBottom(screen), false);
    assert.equal(currentStopPhrases(screen).size, 0);
  }
  // 오류 덩어리 판정은 낱말과 무관하게 구조로만 정해진다.
  assert.deepEqual(currentErrorBlock(screens[0]).lines, ['■ Model is overloaded, retry later', '  └ capacity exceeded']);
  assert.equal(currentErrorBlock(screens[1]), null);
  assert.equal(currentErrorBlock(screens[2]), null);
});
