import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createWatchProcessTop, parseProcessTop} from '../src/watch-process-top.mjs';
import {createWatchReplayMetrics} from '../src/watch-replay-metrics.mjs';
import {runWatch} from '../src/watch-runner.mjs';

const bytes = value => value * 1048576;
const output = 'Processes: fixture\nPID MEM CMPRS\n42 633M+ 568M-\n';
function fixture(options = {}) {
  let clock = 1000, heap = 350;
  const calls = [], timers = new Set();
  const top = createWatchProcessTop({
    platform: 'darwin', pid: 42, now: () => clock,
    memoryUsage: () => ({heapUsed: bytes(heap)}),
    spawn: (...args) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.unrefs = 0; child.pipeUnrefs = 0; child.kills = [];
      child.unref = () => child.unrefs++;
      child.stdout.unref = () => child.pipeUnrefs++;
      child.kill = signal => child.kills.push(signal);
      calls.push({args, child});
      return child;
    },
    setTimer: (fn, ms) => {
      const timer = {fn, ms, unrefs: 0, unref() { this.unrefs++; }};
      timers.add(timer); return timer;
    },
    clearTimer: timer => timers.delete(timer),
    ...options,
  });
  return {top, calls, timers, at: value => { clock = value; }, heap: value => { heap = value; },
    finish: (text = output, code = 0) => {
      const child = calls.at(-1).child;
      child.stdout.emit('data', Buffer.from(text)); child.emit('close', code);
    }};
}

test('머리줄 열 순서·B/K/M/G 단위·증감 꼬리를 읽고 자기 PID만 고른다', () => {
  for (const [value, expected] of [['1024B', 0], ['1024K+', 1], ['633M-', 633], ['1.5G', 1536]]) {
    assert.deepEqual(parseProcessTop(`CMPRS PID MEM\n2G 99 9G\n${value} 42 ${value}`, 42),
      {mem: expected, cmprs: expected});
  }
  assert.deepEqual(parseProcessTop(output, 42), {mem: 633, cmprs: 568});
  for (const text of ['', 'PID MEM CMPRS\n99 1G 1M', 'PID MEM CMPRS\n42 x 1M',
    'PID MEM CMPRS\n42 1M', 'PID MEM\n42 1G', 'PID MEM CMPRS\n42 1T 1M']) {
    assert.equal(parseProcessTop(text, 42), null, text);
  }
});

test('절대경로·C 로케일·파이프 상한·unref와 구간당 한 번을 지킨다', () => {
  const f = fixture();
  assert.deepEqual(f.top.snapshot(), {top: null, topFailures: 0});
  f.top.sample(); f.top.sample();
  assert.equal(f.calls.length, 1);
  const {args, child} = f.calls[0];
  assert.equal(args[0], '/usr/bin/top');
  assert.deepEqual(args[1], ['-l', '1', '-pid', '42', '-stats', 'pid,mem,cmprs']);
  assert.equal(args[2].env.LC_ALL, 'C');
  assert.deepEqual(args[2].stdio, ['ignore', 'pipe', 'ignore']);
  assert.equal(child.unrefs, 1); assert.equal(child.pipeUnrefs, 1);
  assert.equal([...f.timers][0].ms, 5000); assert.equal([...f.timers][0].unrefs, 1);
  f.finish();
  assert.equal(f.timers.size, 0);
  f.at(300999); f.top.clear(); f.top.sample();
  assert.equal(f.calls.length, 1, 'clear나 기록 재시도가 5분 제한을 풀지 않는다');
  f.at(301000); f.top.sample();
  assert.equal(f.calls.length, 2);
  f.finish(); f.top.stop(); f.at(601000); f.top.sample();
  assert.equal(f.calls.length, 2, '종료 뒤에는 새로 띄우지 않는다');
});

test('clear 뒤 늦은 결과는 원래 힙과 나이로 남고 두 구간 뒤에는 null이다', () => {
  const f = fixture();
  const metrics = createWatchReplayMetrics({top: f.top});
  metrics.sampleTop();
  metrics.clear(); f.at(2500); f.heap(700); f.finish();
  assert.deepEqual(metrics.snapshot().processMemory.top,
    {mem: 633, cmprs: 568, heapUsed: 350, ageMs: 1500});
  metrics.clear(); f.at(301000);
  assert.equal(metrics.snapshot().processMemory.top.ageMs, 300000);
  metrics.sampleTop(); f.finish();
  assert.equal(metrics.snapshot().processMemory.top.heapUsed, 700);
  f.at(901000);
  assert.equal(metrics.snapshot().processMemory.top, null);
  assert.equal(metrics.snapshot().processMemory.topFailures, 0);
});

test('다른 PID·빈 출력·깨진 출력·비정상 종료는 null과 실패 한 번이다', () => {
  for (const [text, code] of [['PID MEM CMPRS\n99 1G 2M', 0], ['', 0], ['broken', 0], [output, 1]]) {
    const f = fixture(); f.top.sample(); f.finish(text, code);
    assert.deepEqual(f.top.snapshot(), {top: null, topFailures: 1});
    f.top.clear(); assert.equal(f.top.snapshot().topFailures, 0);
  }
});

test('출력을 나눠 받아도 읽고 새 구간의 실패는 앞 표본을 null로 바꾼다', () => {
  const f = fixture(); f.top.sample();
  const child = f.calls[0].child;
  child.stdout.emit('data', Buffer.from('PID MEM '));
  child.stdout.emit('data', Buffer.from('CMPRS\n42 633M 568M\n'));
  child.emit('close', 0);
  assert.equal(f.top.snapshot().top.mem, 633);
  f.at(301000); f.top.sample(); f.top.clear();
  f.calls[1].child.emit('error', new Error('late spawn error'));
  assert.deepEqual(f.top.snapshot(), {top: null, topFailures: 1});
  f.calls[1].child.emit('close', 1);
  assert.equal(f.top.snapshot().topFailures, 1);
});

test('시간 상한·출력 초과·error의 겹침에도 한 번만 실패하고 종료 전 중복 실행하지 않는다', () => {
  for (const kind of ['timeout', 'overflow', 'error', 'pipe-error']) {
    const f = fixture(); f.top.sample();
    const child = f.calls[0].child;
    if (kind === 'timeout') [...f.timers][0].fn();
    if (kind === 'overflow') child.stdout.emit('data', Buffer.alloc(16385));
    if (kind === 'error') child.emit('error', new Error('fake spawn error'));
    if (kind === 'pipe-error') child.stdout.emit('error', new Error('fake pipe error'));
    assert.deepEqual(f.top.snapshot(), {top: null, topFailures: 1}, kind);
    if (kind !== 'error') assert.deepEqual(child.kills, ['SIGKILL']);
    assert.equal(f.timers.size, 0);
    f.at(601000); f.top.sample();
    assert.equal(f.calls.length, 1, '시간이 지나도 앞 자식이 종료되지 않았으면 하나다');
    child.emit('error', new Error('late error')); f.finish();
    assert.equal(f.top.snapshot().topFailures, 1);
    f.top.sample(); assert.equal(f.calls.length, 2);
    f.finish();
  }
});

test('동기 spawn 예외와 잘못된 힙도 감시기로 새지 않고 다음 구간까지 재시도하지 않는다', () => {
  for (const options of [{spawn: () => { throw new Error('fake spawn throw'); }},
    {memoryUsage: () => { throw new Error('fake memory error'); }},
    {memoryUsage: () => ({heapUsed: NaN})}]) {
    const f = fixture(options);
    assert.doesNotThrow(() => f.top.sample());
    assert.deepEqual(f.top.snapshot(), {top: null, topFailures: 1});
    f.top.sample(); assert.equal(f.top.snapshot().topFailures, 1);
  }
});

test('macOS 밖에서는 프로세스도 힙도 읽지 않고 null·실패 0이다', () => {
  const f = fixture({platform: 'linux', memoryUsage: () => { throw new Error('must not read'); }});
  f.top.sample(); f.at(601000); f.top.sample();
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.top.snapshot(), {top: null, topFailures: 0});
});

test('끝나지 않는 가짜 top을 기다리지 않고 감시가 정상 간격으로 12순회 돈다', async () => {
  const f = fixture();
  const metrics = createWatchReplayMetrics({top: f.top});
  const controller = new AbortController(), records = [], sleeps = [];
  let cycle = 0, reads = 0;
  await runWatch({metrics, signal: controller.signal,
    floor: {list: () => [], read: () => ''}, readEntries: () => { reads++; return []; },
    record: entry => records.push({...entry, cycle}), sendAlert: () => {},
    spawn: () => ({status: 0, stdout: ''}), print: () => {}, intervalMs: 60000,
    now: () => 1700000000000 + cycle * 60000,
    sleep: async ms => {
      sleeps.push(ms); f.at(1000 + ++cycle * 60000);
      if (cycle === 12) controller.abort();
    },
  });
  assert.equal(reads, 12);
  assert.deepEqual(sleeps, Array(12).fill(60000));
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].child.kills, ['SIGKILL'], '감시 종료 때 자기 자식도 종료한다');
  assert.equal(f.timers.size, 0);
  const cycles = records.filter(row => row.kind === 'watch-cycle');
  assert.deepEqual(cycles.map(row => row.cycle), [0, 5, 10]);
  assert.ok(cycles.every(row => row.ok && row.timing.processMemory.top === null));
});
