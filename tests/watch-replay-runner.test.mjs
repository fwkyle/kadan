import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {runWatch} from '../src/watch-runner.mjs';
import {createWatchReplayMetrics, watchMetric} from '../src/watch-replay-metrics.mjs';

const values = [800, 900, 1100, 600, 700, 1000, 500];
async function run({failedWrite = false, broken = false} = {}) {
  let cycle = 0, reads = 0;
  const controller = new AbortController();
  const records = [], alerts = [];
  const memoryUsage = () => ({rss: values[cycle] * 1048576,
    heapUsed: (values[cycle] - 100) * 1048576, heapTotal: values[cycle] * 1048576,
    external: 0, arrayBuffers: 0});
  const metrics = createWatchReplayMetrics({memoryUsage});
  const observer = broken ? {...metrics, replay() { throw new Error('fake metric failure'); }} : metrics;
  await runWatch({metrics: observer, memoryUsage, signal: controller.signal,
    floor: {list: () => [], read: () => ''},
    readEntries: () => {
      reads++;
      watchMetric(observer, 'replay', 'projection', 'address');
      return [];
    },
    record: entry => {
      if (entry.kind === 'watch-cycle' && failedWrite && cycle === 0) throw new Error('fake record failure');
      records.push(entry);
    },
    sendAlert: (...args) => alerts.push(args),
    spawn: () => ({status: 0, stdout: ''}), print: () => {},
    intervalMs: 60_000, now: () => 1700000000000 + cycle * 60_000,
    sleep: async () => {
      if (++cycle === values.length) controller.abort();
      else watchMetric(observer, 'count', 'sweep', 'moved');
    },
  });
  return {records, alerts, reads, after: metrics.snapshot()};
}

test('5순회 최대·마지막 값과 쓰기 실패 보존·성공 뒤 비우기를 실제 감시 루프로 확인한다', async () => {
  const result = await run({failedWrite: true});
  assert.equal(result.reads, 7);
  const cycles = result.records.filter(row => row.kind === 'watch-cycle');
  assert.equal(cycles.length, 2);
  assert.deepEqual(cycles[0].timing.processMemory, {
    last: {rss: 900, heapUsed: 800, heapTotal: 900},
    max: {rss: 900, heapUsed: 800, heapTotal: 900}, samples: 4, failures: 0,
  });
  assert.equal(cycles[0].timing.replay.projection.full, 2);
  assert.deepEqual(cycles[1].timing.processMemory, {
    last: {rss: 500, heapUsed: 400, heapTotal: 500},
    max: {rss: 1100, heapUsed: 1000, heapTotal: 1100}, samples: 10, failures: 0,
  });
  assert.equal(cycles[1].timing.replay.projection.full, 5);
  assert.equal(cycles[1].timing.replay.sweep.moved, 5, '순회 사이 관측도 다음 기록에 포함한다');
  assert.equal(cycles[1].timing.memoryMb.rss, 500);
  assert.deepEqual(result.after.processMemory, {last: null, max: null, samples: 0, failures: 0});
  assert.equal(result.after.replay.projection.full, 0);
});

test('계수 예외를 주입해도 순회 수·성공 판정·기존 경보가 같다', async () => {
  const plain = await run();
  const broken = await run({broken: true});
  assert.equal(broken.reads, plain.reads);
  assert.deepEqual(broken.alerts, plain.alerts);
  assert.deepEqual(broken.records.filter(row => row.kind !== 'watch-cycle'),
    plain.records.filter(row => row.kind !== 'watch-cycle'));
  const cycles = broken.records.filter(row => row.kind === 'watch-cycle');
  assert.ok(cycles.every(row => row.ok));
  assert.ok(cycles.every(row => row.timing.processMemory.failures > 0));
});
