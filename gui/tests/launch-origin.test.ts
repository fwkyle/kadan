import test from 'node:test';
import assert from 'node:assert/strict';
import {originLine, type OriginSession} from '../src/launch-origin.ts';

// 역할 줄의 '값의 출처': 살아 있는 그 프로필 세션들이 어떻게 떴는지의 요약(설정값 자체의 출처가 아니다).
const s = (profile: string, launch: OriginSession['launch'], pidState = 'match'): OriginSession =>
  ({role: `x-${Math.random()}`, profile, launch, pidState});

test('살아 있는 세션을 출처별로 센다 — 설정 2 · 대체 1번 1', () => {
  const live = [
    s('worker', {source: 'settings'}), s('worker', {source: 'settings'}), s('worker', {source: 'fallback', fallbackIndex: 1}),
    s('reviewer', {source: 'override'}),
  ];
  assert.equal(originLine(live, 'worker'), '떠 있는 3개 · 설정 2 · 대체 1번 1');
  assert.equal(originLine(live, 'reviewer'), '떠 있는 1개 · 덮어쓰기 1');
});

test('살아 있는 세션이 없거나 세션 상태를 모르면 표시 없음', () => {
  assert.equal(originLine([], 'worker'), null);
  assert.equal(originLine(null, 'worker'), null);
  assert.equal(originLine(undefined, 'worker'), null);
  assert.equal(originLine([s('worker', {source: 'settings'})], 'super'), null, '그 프로필 세션이 없다');
});

test('세션을 띄우지 않는 자리(감시·시니어·설명 AI·비서)는 표시 없음', () => {
  const live = [s('worker', {source: 'settings'})];
  for (const row of ['watch', 'senior', 'explain', 'secretary']) assert.equal(originLine(live, row), null);
});

test('어려운 일 작업자 줄은 어려운 일 자리로 뜬 작업자만, 작업자 줄은 나머지를 센다', () => {
  const live = [
    s('worker', {source: 'settings'}), s('worker', {source: 'fallback', fallbackIndex: 2, hard: true}),
    s('worker', {source: 'settings', hard: true}),
  ];
  assert.equal(originLine(live, 'worker'), '떠 있는 1개 · 설정 1');
  assert.equal(originLine(live, 'worker-hard'), '떠 있는 2개 · 설정 1 · 대체 2번 1');
});

test('대체 번호는 번호순, 그 밖 갈래는 정해진 순서로 센다', () => {
  const live = [
    s('worker', {source: 'resume'}), s('worker', {source: 'fallback', fallbackIndex: 2}), s('worker', {source: 'review-for'}),
    s('worker', {source: 'fallback', fallbackIndex: 1}), s('worker', {source: 'settings'}), s('worker', {source: 'unknown'}),
  ];
  assert.equal(originLine(live, 'worker'),
    '떠 있는 6개 · 설정 1 · 대체 1번 1 · 대체 2번 1 · 검수 지정 1 · 다시 띄움 1 · 기록 없음 1');
});

test('start 기록의 PID와 달라졌거나 출처 기록이 없으면 출처를 믿지 않고 기록 없음으로 센다', () => {
  const live = [s('worker', {source: 'settings'}, 'changed'), s('worker', null), s('worker', {source: 'fallback'})];
  assert.equal(originLine(live, 'worker'), '떠 있는 3개 · 기록 없음 3');
});
