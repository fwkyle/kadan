import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {NotifyHoldTracker} from '../src/watch-notify-hold.mjs';
import {SupervisorHealth} from '../src/watch-supervisor-health.mjs';
import {cycleReads} from '../src/watch-reads.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDatabase, writeStorageMarker, appendStream, readStream} from '../src/storage.mjs';

// 감시기는 몇 달씩 켜져 있다. 역할·세션 이름이 계속 바뀌어도(2026-10 실측: 역할 수백 개가 오가는 판) 주기 사이에
// 붙잡는 자료가 지금 살아 있는 역할 수를 넘지 않아야 한다. 시간이 아니라 주기 횟수로 센다.
const CYCLES = 300;

test('알림 밀림 추적: 역할이 계속 바뀌어도 연속 구간이 끝난 역할은 남지 않는다', () => {
  const tracker = new NotifyHoldTracker();
  const hold = Object.assign(new Error('미룸'), {code: 'KADAN_PANE_INPUT_PENDING', delivery: 'not-sent'});
  for (let i = 0; i < CYCLES; i++) {
    tracker.beginCycle();
    tracker.held(`role-${i}`, hold); // 이번 주기에만 밀리고 다음 주기에는 사라지는 역할
    tracker.endCycle(i * 1000);
    assert.ok(tracker.streaks.size <= 2, `주기 ${i}: streaks ${tracker.streaks.size}`);
  }
  tracker.beginCycle();
  tracker.endCycle(CYCLES * 1000);
  assert.equal(tracker.streaks.size, 0);
});

test('감독 건강 추적: 범위에서 빠진 세션은 다음 주기에 지운다', () => {
  const health = new SupervisorHealth();
  for (let i = 0; i < CYCLES; i++) {
    const session = `kadan-sup-${i}`;
    const observations = new Map([[session, {alive: true, screen: `화면 ${i}\n`, pid: i, expectedPid: i, startedAt: new Date(0).toISOString()}]]);
    health.select({scope: {sessions: new Set([session]), entries: []}, observations, entries: [], cards: [], now: i * 60_000, enabled: false});
    assert.ok(health.states.size <= 1, `주기 ${i}: states ${health.states.size}`);
  }
});

test('주기 읽기 재사용: begin·end 뒤에는 원장 사본을 쥐지 않는다', () => {
  let reads = 0;
  const reader = cycleReads({readEntries: () => (reads++, new Array(10).fill({})), version: () => 1});
  for (let i = 0; i < CYCLES; i++) {
    reader.begin();
    reader.readEntries();
    reader.readEntries(); // 같은 주기 안 두 번째는 재사용
    reader.end();
  }
  assert.equal(reads, CYCLES, '주기마다 정확히 한 번만 읽는다');
});

// readStream은 사건을 한 줄씩 해석한다(원문 문자열 배열을 쥐지 않으려고). 결과는 같은 사건·같은 순서여야 한다.
test('readStream: 순서·slim·빈 stream 동작이 그대로다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-readstream-'));
  createDatabase(home); writeStorageMarker(home, 'sqlite');
  const rows = Array.from({length: 50}, (_, i) => ({kind: i % 2 ? 'watch-ai-request' : 'plan', i, screen: 'x'.repeat(20), keep: true}));
  for (const row of rows) appendStream(home, 's/a.jsonl', row);
  appendStream(home, 's/b.jsonl', {kind: 'plan', i: 'other'});
  assert.deepEqual(readStream(home, 's/a.jsonl'), rows, '같은 사건·같은 순서');
  const slim = readStream(home, 's/a.jsonl', {slim: [{kind: 'watch-ai-request', drop: ['screen']}]});
  assert.deepEqual(slim.map(r => r.i), rows.map(r => r.i));
  assert.ok(slim.every(r => r.kind === 'watch-ai-request' ? !('screen' in r) && r.keep === true : r.screen === 'x'.repeat(20)));
  assert.deepEqual(readStream(home, 's/none.jsonl', {optional: true}), []);
  assert.throws(() => readStream(home, 's/none.jsonl'), /기록 없음: s\/none\.jsonl/);
  appendStream(home, 's/c.jsonl', {kind: 'plan'});
  assert.equal(readStream(home, 's/c.jsonl').length, 1, '읽은 뒤에도 연결이 닫혀 다음 쓰기·읽기가 된다');
});
