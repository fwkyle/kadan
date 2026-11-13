import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MACHINE_MEMORY_KEYS, MACHINE_MEMORY_LIMITS, MACHINE_MEMORY_RECOVERY_GAP_MS, MACHINE_MEMORY_MAX_PCT,
  parseMachineMemory, readMachineMemory,
  assessMachineMemory, topMachineProcesses, machineMemoryBody, createMachineMemoryWatch,
} from '../src/watch-machine-memory.mjs';
import {accumulateMachineMemory} from '../src/watch-cycle.mjs';
import {runWatch} from '../src/watch-runner.mjs';
import {notifyUser} from '../src/user-notify.mjs';

const raw = ({segments = 900, limit = 1000, pages = 200, pageLimit = 1000, pressure = 1} = {}) => [
  `kern.memorystatus_vm_pressure_level: ${pressure}`,
  'vm.swapusage: total = 9216.00M  used = 7498.31M  free = 1717.69M  (encrypted)',
  `vm.compressor.segment.total: ${segments}`, `vm.compressor.segment.limit: ${limit}`,
  `vm.compressor.pages_compressed: ${pages}`, `vm.compressor.pages_compressed_limit: ${pageLimit}`,
].join('\n') + '\n';
const sample = pct => parseMachineMemory(raw({segments: pct * 10}));
const missing = {known: false, reason: 'read'};
const without = (output, ...keys) => output.split('\n')
  .filter(line => !keys.some(key => line.startsWith(key + ':'))).join('\n');
const assessed = (pct, state = {}) => assessMachineMemory(state, sample(pct), 1000);

test('패닉 끝점·저녁 두 음성 표본·경계·페이지 축을 각각 판정한다', () => {
  assert.deepEqual(MACHINE_MEMORY_LIMITS, {critical: 90, imminent: 97, recovery: 80});
  assert.equal(assessed(100).alert.stage, 2);
  for (const segments of [311322, 374500]) {
    const evening = parseMachineMemory(raw({segments, limit: 922863}));
    assert.equal(assessMachineMemory({}, evening, 0).alert, undefined);
  }
  assert.equal(assessed(89.9).alert, undefined);
  assert.equal(assessed(90).alert.stage, 1);
  assert.equal(assessed(96.9).alert.stage, 1);
  assert.equal(assessed(97).alert.stage, 2);
  const pagesOnly = parseMachineMemory(raw({segments: 100, pages: 970}));
  assert.equal(assessMachineMemory({}, pagesOnly, 0).alert.stage, 2);
  assert.match(machineMemoryBody({stage: 2, sample: pagesOnly}), /97\.0%.*보관 페이지/);
  const pressureOnly = parseMachineMemory(raw({segments: 100, pressure: 4}));
  assert.equal(assessMachineMemory({}, pressureOnly, 0).alert, undefined, '압박·스왑은 울림 기준이 아니다');
});

test('위급 첫 관측·임박 상승만 울리고 회복 2번 뒤 새 사고가 된다', () => {
  let state = {}, now = 0;
  const alerts = [], closed = [];
  for (const pct of [90, 91, 89, 85, 90, 97, 98, 96, 97, 80, 79, 81, 79, 79, 90]) {
    const result = assessMachineMemory(state, sample(pct), ++now);
    state = result.state;
    if (result.alert) alerts.push([result.alert.since, result.alert.stage]);
    if (result.resolved) closed.push(now);
  }
  assert.deepEqual(alerts, [[1, 1], [1, 2], [15, 1]]);
  assert.deepEqual(closed, [14], '80% 미만만 회복이며 중간 반등은 회복 연속을 끊는다');
});

test('모름은 울리지도 닫지도 않고 정상 연속을 끊는다', () => {
  const open = assessed(90).state;
  const once = assessed(79, open).state;
  const unknown = assessMachineMemory(once, missing, 2000);
  assert.equal(unknown.alert, undefined);
  assert.equal(unknown.resolved, undefined);
  assert.equal(unknown.state.normalCycles, 0);
  const second = assessed(79, unknown.state);
  assert.equal(second.resolved, undefined);
  assert.ok(assessed(79, second.state).resolved);
});

test('sysctl 한 번·여섯 키·2초 상한으로 읽고 macOS가 아니면 실행하지 않는다', () => {
  const calls = [];
  const spawn = (...args) => { calls.push(args); return {status: 0, stdout: raw()}; };
  assert.equal(readMachineMemory(spawn, 'linux').known, false);
  assert.equal(calls.length, 0);
  assert.equal(readMachineMemory(spawn, 'darwin').known, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/usr/sbin/sysctl');
  assert.deepEqual(calls[0][1], MACHINE_MEMORY_KEYS);
  assert.equal(calls[0][2].timeout, 2000);
  assert.equal(calls[0][2].maxBuffer, 16384);
});

test('공간 키 없음·숫자 아님·0 한도·음수는 공간 모름, 실행 실패·시간 초과는 전체 모름이다', () => {
  for (const output of [raw().split('\n').slice(0, 4).join('\n'), raw({limit: 0}), raw({pageLimit: 0}),
    raw({segments: 'NaN'}), raw({pages: -1}), raw({pageLimit: 'Infinity'}),
    raw() + '\nvm.compressor.segment.limit: 1000']) {
    assert.equal(parseMachineMemory(output).known, false, output);
  }
  for (const result of [{status: 1, stdout: raw()}, {status: null, error: {code: 'ETIMEDOUT'}},
    {status: null, signal: 'SIGTERM'}, {status: 0, signal: 'SIGTERM', stdout: raw({segments: 1000})},
    {status: 0, error: {code: 'ENOBUFS'}, stdout: raw({segments: 1000})},
    {status: 0, error: {code: 'ENOENT'}, stdout: raw({segments: 1000})}, {status: 0, stdout: ''}]) {
    assert.equal(readMachineMemory(() => result, 'darwin').known, false);
  }
  assert.equal(readMachineMemory(() => { throw Error('no sysctl'); }, 'darwin').known, false);
});

test('울릴 때 ps 1번으로 이름·RSS 상위 3개만 붙이고 ps 실패에도 울린다', () => {
  const calls = [], messages = [], records = [];
  const spawn = (cmd, args) => {
    calls.push([cmd, args]);
    return {status: 0, stdout: [
      '1024 /usr/bin/small', '5138022 /usr/bin/node',
      '4299161 /Applications/Browser.app/Chrome Helper (Renderer)', '2097152 /usr/bin/other',
    ].join('\n')};
  };
  const watch = createMachineMemoryWatch({spawn, read: () => sample(92),
    notify: (text, unused, opts) => { messages.push({text, opts}); return {via: 'system', error: null}; }});
  for (let now = 0; now < 3; now++) watch.tick({now, record: e => records.push(e)});
  assert.deepEqual(calls, [['ps', ['-axo', 'rss=,comm=']]]);
  assert.match(messages[0].text, /92\.0%.*스왑 7\.3G.*압박 단계 정상.*node 4\.9G, Chrome Helper \(Renderer\) 4\.1G/);
  assert(!messages[0].text.includes('/Applications/'));
  assert.equal(messages[0].opts.ring, true);
  assert.equal(messages[0].opts.kind, 'alert');
  assert.equal(messages[0].opts.alertKind, '기기메모리');
  assert.equal(records[0].delivered, true);
  assert.equal(records[0].recipient, '@user');
  assert.deepEqual(topMachineProcesses(() => ({status: 1})), []);
  const failedPs = createMachineMemoryWatch({spawn: () => { throw Error('ps'); }, read: () => sample(90),
    notify: text => { assert(!text.includes('큰 프로세스')); return {via: 'system', error: null}; }});
  assert.equal(failedPs.tick({now: 0, record: () => {}}).known, true);
});

test('새 감시기·부팅에서는 같은 위급도 다시 울리고 키가 다르다', () => {
  const keys = [];
  const options = {spawn: () => ({status: 1}), read: () => sample(97),
    notify: (text, spawn, opts) => { keys.push(opts.key); return {via: 'system', error: null}; }};
  createMachineMemoryWatch(options).tick({now: 1, record: () => {}});
  createMachineMemoryWatch(options).tick({now: 2, record: () => {}});
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
});

test('기존 notifyUser 길은 알림 off와 가짜 실행만 사용해 통과한다', () => {
  const nativeCalls = [];
  const sink = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-machine-')), 'notify.jsonl');
  const spawn = (cmd, args) => { nativeCalls.push([cmd, args]); return {status: 0, stdout: ''}; };
  const watch = createMachineMemoryWatch({spawn, read: () => sample(90),
    notify: (text, exec, opts) => notifyUser(text, exec, {...opts,
      env: {KADAN_NOTIFY: 'off', KADAN_TEST_NOTIFY_SINK: sink}})});
  watch.tick({now: 0, record: () => {}});
  assert.equal(nativeCalls.filter(([cmd]) => cmd === 'osascript').length, 0);
  assert.match(JSON.parse(fs.readFileSync(sink, 'utf8')).message, /맥 메모리 위급/);
});

test('주기 집계는 마지막·최대·실패 횟수만 보관하고 고정 크기다', () => {
  let window = accumulateMachineMemory(null, sample(90));
  window = accumulateMachineMemory(window, sample(97));
  window = accumulateMachineMemory(window, sample(40));
  assert.equal(window.last.segmentPct, 40);
  assert.equal(window.max.segmentPct, 97);
  window = accumulateMachineMemory(window, missing);
  assert.equal(window.last, null);
  assert.equal(window.failures, 1);
  assert.equal(window.max.segmentPct, 97);
  for (let n = 0; n < 100; n++) window = accumulateMachineMemory(window, sample(40));
  assert.equal(Object.keys(window).length, 3);
  assert.equal(Object.keys(window.max).length, 4);
  assert(Buffer.byteLength(JSON.stringify({machineMemory: window})) < 300);
});

// 가짜 원장·화면·AI 단계와 가짜 시계만 쓴다. 실제 프로세스·알림·메모리 압박은 만들지 않는다.
async function run(samples, {failure = false, old = [], times = null} = {}) {
  let cycle = 0, clock = 0;
  const order = [], records = [], notices = [], roleMails = [], calls = [];
  const controller = new AbortController();
  const starts = ['worker', 'boss'].map((role, n) => ({kind: 'start', role,
    session: `kadan-${role}`, panePid: n + 1, t: new Date(0).toISOString()}));
  const spawn = () => ({status: 0, stdout: ''});
  const machine = createMachineMemoryWatch({spawn, read: () => {
    order.push(`read:${cycle}`); return samples[cycle];
  }, notify: (text, exec, opts) => {
    order.push(`notify:${cycle}`); notices.push(opts);
    if (failure) throw Error('delivery failed');
    return {via: 'system', error: null};
  }});
  await runWatch({machineMemory: machine, spawn, signal: controller.signal,
    floor: {list: () => {
      order.push(`screen:${cycle}`); clock += 50;
      return starts.map(s => ({session: s.session, pid: s.panePid}));
    }, read: () => `healthy output ${cycle}`},
    readEntries: () => { order.push(`ledger:${cycle}`); clock += 72_000; return [...starts, ...old]; },
    record: e => records.push(e), sendAlert: (...args) => roleMails.push(args),
    parents: new Map([['worker', 'boss'], ['boss', '@user']]), superRole: 'boss',
    ai: {run: () => calls.push('ai')}, judgeCmd: 'fake', print: () => {}, intervalMs: 1000, stallN: 2,
    now: () => times?.[cycle] ?? 1_000_000 + cycle * 60_000, measure: () => clock,
    sleep: async () => { if (++cycle >= samples.length) controller.abort(); },
  });
  return {order, records, notices, roleMails, calls};
}

test('첫 복원 읽기를 포함해 매 순회 원장·화면·AI보다 먼저 사용자에게 울린다', async () => {
  const out = await run([sample(90), sample(97)]);
  for (let cycle = 0; cycle < 2; cycle++) {
    assert(out.order.indexOf(`read:${cycle}`) < out.order.indexOf(`notify:${cycle}`));
    assert(out.order.indexOf(`notify:${cycle}`) < out.order.indexOf(`ledger:${cycle}`));
    assert(out.order.indexOf(`notify:${cycle}`) < out.order.indexOf(`screen:${cycle}`));
  }
  assert.deepEqual(out.roleMails, []);
  assert.deepEqual(out.calls, []);
  assert.equal(out.notices.length, 2);
  assert.equal(new Set(out.notices.map(n => n.key)).size, 2);
  assert.deepEqual([...new Set(out.records.map(e => e.kind))].sort(), ['alert', 'watch-cycle']);
  const cycle = out.records.find(e => e.kind === 'watch-cycle');
  assert.equal(cycle.timing.machineMemory.last.segmentPct, 90);
  assert.equal(cycle.timing.ledgerMs, 72_000, '느린 원장 읽기를 기기 측정 시간과 나눠 잰다');
});

test('알림·읽기 실패에도 순회가 계속되고 모름은 사고를 닫지 않는다', async () => {
  const out = await run([sample(90), sample(79), missing, sample(79), sample(79), sample(90)], {failure: true});
  assert.equal(out.order.filter(s => s.startsWith('ledger:')).length, 6);
  const alerts = out.records.filter(e => e.kind === 'alert');
  assert.deepEqual(alerts.map(e => Boolean(e.resolved)), [false, true, false]);
  assert(alerts.every(e => !e.delivered));
  assert.deepEqual(out.calls, []);
  assert.deepEqual(out.roleMails, []);
  const cycle = out.records.filter(e => e.kind === 'watch-cycle').at(-1);
  assert.equal(cycle.timing.machineMemory.failures, 1);
  assert.equal(cycle.timing.machineMemory.max.segmentPct, 90);
});

test('기기 경보의 과거 원장 기록은 일반 승급·해소·AI 경로로 들어가지 않는다', async () => {
  const old = [{kind: 'alert', id: 'machine:memory', alertKind: '기기메모리',
    recipient: '@user', delivered: true, stage: 1, since: 1, level: 'RED'}];
  const out = await run([sample(40)], {old});
  assert.deepEqual(out.records.filter(e => e.kind === 'alert'), []);
  assert.deepEqual(out.notices, []);
  assert.deepEqual(out.roleMails, []);
  assert.deepEqual(out.calls, []);
});

test('F1: 검수 재현 — 압박 단계만 모름이어도 세그먼트100%는 울린다', () => {
  const notices = [], records = [];
  const watch = createMachineMemoryWatch({read: () => parseMachineMemory(raw({segments: 1000, pressure: 8})),
    spawn: () => ({status: 1}), notify: (...args) => {
      notices.push(args); return {via: 'system', error: null};
    }});
  watch.tick({now: 1, record: e => records.push(e)});
  assert.equal(notices.length, 1);
  assert.match(notices[0][0], /압박 단계 모름/);
  assert.equal(records[0].stage, 2);
});

test('F2: 검수 재현 — 24시간 공백을 넘어 회복 한 번씩을 이어 세지 않는다', async () => {
  const out = await run([sample(97), sample(79), sample(79)],
    {times: [1_000_000, 1_060_000, 87_400_000]});
  assert.equal(out.records.filter(e => e.kind === 'alert' && e.resolved).length, 0);
});

test('F1: 압박·스왑의 모름은 공간 울림을 막지 않고 본문·기록에서 모름으로 남는다', () => {
  for (const output of [raw({pressure: 0}), raw({pressure: 3}), raw({pressure: 8}),
    without(raw(), MACHINE_MEMORY_KEYS[0]), without(raw(), 'vm.swapusage'),
    raw().replace('7498.31M', 'NaNM')]) {
    const parsed = parseMachineMemory(output);
    assert.equal(parsed.known, true);
    const alert = assessMachineMemory({}, parsed, 1).alert;
    assert.equal(alert.stage, 1);
    const body = machineMemoryBody(alert);
    assert.match(body, /압박 단계 모름|스왑 모름/);
    const summary = accumulateMachineMemory(null, parsed);
    assert.equal(summary.failures, 0, '보조 값만 모르면 공간 읽기 실패로 세지 않는다');
    if (parsed.pressure === null) assert.equal(summary.last.pressure, null);
    if (parsed.swapUsedMb === null) assert.equal(summary.last.swapUsedMb, null);
  }
});

test('F1: 공간 한 축이 위급이면 울리고, 한 축만 낮으면 회복으로 세지 않는다', () => {
  for (const output of [without(raw({segments: 970}), 'vm.compressor.pages_compressed'),
    without(raw({pages: 970}), 'vm.compressor.segment.total')]) {
    const parsed = parseMachineMemory(output);
    assert.equal(parsed.known, false);
    assert.equal(assessMachineMemory({}, parsed, 1).alert.stage, 2);
    const summary = accumulateMachineMemory(null, parsed);
    assert.equal(summary.failures, 1);
    assert.equal(summary.last.segmentPct === null || summary.last.pagePct === null, true);
    assert.equal(summary.max.segmentPct === null || summary.max.pagePct === null, true);
  }
  const open = assessMachineMemory({}, sample(97), 1).state;
  const recovering = assessMachineMemory(open, sample(79), 2).state;
  for (const output of [without(raw({segments: 500}), 'vm.compressor.pages_compressed'),
    without(raw({pages: 500}), 'vm.compressor.segment.total'),
    without(raw(), 'vm.compressor.segment.total', 'vm.compressor.pages_compressed')]) {
    const unknown = assessMachineMemory(recovering, parseMachineMemory(output), 3);
    assert.equal(unknown.alert, undefined);
    assert.equal(unknown.resolved, undefined);
    assert.equal(unknown.state.normalCycles, 0);
    assert.equal(assessMachineMemory(unknown.state, sample(79), 4).resolved, undefined);
  }
});

test('F1: sysctl의 일부 키 누락 종료1에서도 읽힌 공간 97%를 버리지 않는다', () => {
  for (const output of [without(raw({segments: 970}), MACHINE_MEMORY_KEYS[0]),
    without(raw({segments: 970}), 'vm.compressor.pages_compressed')]) {
    const parsed = readMachineMemory(() => ({status: 1, stdout: output}), 'darwin');
    assert.equal(assessMachineMemory({}, parsed, 1).alert.stage, 2);
  }
});

test('F2: 회복 10분 경계·공백 뒤 첫 관측·단계 상승을 구분한다', () => {
  assert.equal(MACHINE_MEMORY_RECOVERY_GAP_MS, 600_000);
  const open = assessMachineMemory({}, sample(97), 1_000_000).state;
  const once = assessMachineMemory(open, sample(79), 1_060_000).state;
  assert.ok(assessMachineMemory(once, sample(79), 1_660_000).resolved, '정확히 10분은 이어 센다');
  const afterGap = assessMachineMemory(once, sample(79), 1_660_001);
  assert.equal(afterGap.resolved, undefined);
  assert.equal(afterGap.state.normalCycles, 1);
  assert.ok(assessMachineMemory(afterGap.state, sample(79), 1_720_001).resolved);
  const same = assessMachineMemory(once, sample(97), 87_400_000);
  assert.equal(same.alert, undefined);
  assert.equal(same.state.since, open.since);
  const critical = assessMachineMemory({}, sample(90), 1_000_000).state;
  const raised = assessMachineMemory(critical, sample(97), 87_400_000);
  assert.equal(raised.alert.stage, 2);
  assert.equal(raised.alert.since, critical.since);
});

test('F3a: 종료0·키 누락 종료1만 쓰고 종료2 이상은 위급·회복 모두 버린다', () => {
  const open = assessMachineMemory({}, sample(97), 0).state;
  const once = assessMachineMemory(open, sample(79), 1).state;
  for (const status of [0, 1, 2, 3, 137]) for (const pct of [40, 100]) {
    const stdout = without(raw({segments: pct * 10}), MACHINE_MEMORY_KEYS[0]);
    const parsed = readMachineMemory(() => ({status, stdout}), 'darwin');
    const initial = assessMachineMemory({}, parsed, 2);
    const recovering = assessMachineMemory(once, parsed, 2);
    assert.equal(parsed.known, status < 2);
    assert.equal(Boolean(initial.alert), status < 2 && pct === 100);
    assert.equal(Boolean(recovering.resolved), status < 2 && pct === 40);
    if (status >= 2) assert.equal(recovering.state.normalCycles, 0);
  }
});

test('F3b: 잘린 한도 숫자는 버리고 온전한 반대 축의 위급만 살린다', () => {
  const open = assessMachineMemory({}, sample(97), 0).state;
  const once = assessMachineMemory(open, sample(79), 1).state;
  for (const pct of [40, 97]) {
    const complete = without(raw({segments: pct * 10}), MACHINE_MEMORY_KEYS[0]);
    const stdout = complete.slice(0, complete.lastIndexOf('1000') + 1);
    const parsed = readMachineMemory(() => ({status: 1, stdout}), 'darwin');
    assert.equal(parsed.pagePct, null);
    assert.equal(parsed.segmentPct, pct);
    assert.equal(parsed.recoveryAllowed, false);
    assert.equal(assessMachineMemory({}, parsed, 2).alert?.stage, pct === 97 ? 2 : undefined);
    assert.equal(assessMachineMemory(once, parsed, 2).resolved, undefined);
  }
});

test('F3: 150% 방어선·숫자 뒤 손상·중복·미완결 보조 줄을 구분한다', () => {
  assert.equal(MACHINE_MEMORY_MAX_PCT, 150);
  for (const pct of [101, 150]) assert.equal(assessed(pct).alert.stage, 2);
  for (const output of [raw({segments: 400, pageLimit: 1}), raw({segments: 400, pages: 1501}),
    raw({segments: 400}).replace('pages_compressed_limit: 1000', 'pages_compressed_limit: 1broken'),
    raw({segments: 400}) + 'vm.compressor.pages_compressed_limit: 1\n']) {
    const parsed = parseMachineMemory(output);
    assert.equal(parsed.pagePct, null);
    assert.equal(assessMachineMemory({}, parsed, 1).alert, undefined);
  }
  const validOpposite = parseMachineMemory(raw({segments: 970, pageLimit: 1}));
  assert.equal(assessMachineMemory({}, validOpposite, 1).alert.stage, 2);
  const tail = parseMachineMemory(raw({segments: 790, pages: 790}) + 'vm.swapusage: total = 8');
  assert.equal(tail.known, true);
  assert.equal(tail.swapUsedMb, null);
  const open = assessMachineMemory({}, sample(97), 0).state;
  const once = assessMachineMemory(open, sample(79), 1).state;
  assert.equal(assessMachineMemory(once, tail, 2).resolved, undefined);
  assert.equal(assessMachineMemory(once, tail, 2).state.normalCycles, 0);
});
