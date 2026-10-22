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

// begin의 초기화와 end의 해제를 따로 검사한다: begin이 매번 캐시를 지우므로 end만 비워 두어도 begin 뒤 횟수는 같기 때문이다.
function assertCycleReadsRelease(makeReads) {
  let reads = 0;
  const reader = makeReads({readEntries: () => (reads++, new Array(10).fill({})), version: () => 1});
  reader.begin();
  reader.readEntries();
  reader.readEntries();
  assert.equal(reads, 1, '같은 주기 안 두 번째 읽기는 재사용');
  reader.end();
  reader.readEntries(); // end 직후·다음 begin 전: 해제했다면 다시 읽는다
  assert.equal(reads, 2, 'end()가 재사용 자료를 놓지 않았다');
  reader.begin();
  reader.readEntries();
  assert.equal(reads, 3, 'begin()이 재사용 자료를 지우지 않았다');
  for (let i = 0; i < CYCLES; i++) { reader.begin(); reader.readEntries(); reader.readEntries(); reader.end(); }
  assert.equal(reads, 3 + CYCLES, '주기마다 정확히 한 번만 읽는다');
}

test('주기 읽기 재사용: end 직후와 begin 직후 모두 원장 사본을 쥐지 않는다', () => {
  assertCycleReadsRelease(cycleReads);
});

test('주기 읽기 재사용 시험은 end()를 비운 변형을 잡아낸다(메모리 안 치환, 소스 파일은 그대로)', async () => {
  const source = fs.readFileSync(new URL('../src/watch-reads.mjs', import.meta.url), 'utf8');
  const mutated = source.replace('end() { cache.clear(); }', 'end() {}');
  assert.notEqual(mutated, source, '치환 대상 줄이 있어야 한다');
  const {cycleReads: broken} = await import(`data:text/javascript;base64,${Buffer.from(mutated).toString('base64')}`);
  assert.throws(() => assertCycleReadsRelease(broken), /end\(\)가 재사용 자료를 놓지 않았다/);
  const noBegin = source.replace('begin() { cache.clear();', 'begin() {');
  assert.notEqual(noBegin, source);
  const {cycleReads: broken2} = await import(`data:text/javascript;base64,${Buffer.from(noBegin).toString('base64')}`);
  assert.throws(() => assertCycleReadsRelease(broken2), /재사용|begin/);
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
