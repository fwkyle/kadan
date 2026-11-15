import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createWatchMailReader} from '../src/watch-mail-reader.mjs';
import {createWatchReplayMetrics} from '../src/watch-replay-metrics.mjs';
import {fixture, card, fullEquivalent} from './helpers/watch-address-add.mjs';

test('건너뜀 계수 오류로 주소 판정·우편 결과가 바뀌지 않는다', () => {
  const s = fixture(), metrics = createWatchReplayMetrics();
  const broken = {...metrics, count() { throw new Error('fixture counter failure'); }};
  const reader = createWatchMailReader(s.home, null, {readCards: () => s.cards, metrics: broken});
  const first = reader.readEntries();reader.project(first, s.cards);metrics.clear();
  s.cards = [...s.cards, card('two')];
  const raw = reader.readEntries();
  assert.deepEqual(reader.project(raw, s.cards), s.first.projected);
  assert.equal(metrics.snapshot().processMemory.failures, 1);
  assert.equal(metrics.snapshot().replay.projection.full, 0);
  fullEquivalent(s);
});

test('건너뜀 계수는 전체 재생 계수와 섞이지 않고 clear 뒤 0이다', () => {
  const metrics = createWatchReplayMetrics();
  for (let n = 0; n < 3; n++) metrics.count('projection', 'skipped');
  assert.equal(metrics.snapshot().replay.projection.skipped, 3);
  assert.equal(metrics.snapshot().replay.projection.full, 0);
  metrics.clear();assert.equal(metrics.snapshot().replay.projection.skipped, 0);
});

test('SQL 색인 밖에서 주입한 원문은 안전한 SQL 추가 판정을 RAM에 재사용하지 않는다', () => {
  const s = fixture(), custom = [{kind: 'send', role: 'fixture-worker',
    taskId: 'two', executionKey: 'fixture/two', mailId: 'fixture-outside-source'}];
  const reader = createWatchMailReader(s.home, () => custom, {readCards: () => s.cards});
  const first = reader.readEntries();assert.equal(reader.project(first, s.cards).length, 0);
  s.cards = [...s.cards, card('two')];
  const next = reader.readEntries();
  assert.equal(reader.project(next, s.cards).length, 1);
});
