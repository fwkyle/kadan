// Why: Rottie가 탭 여러 개를 한 번에 묻고, 실패가 거절인지 판단 불가인지 기계가 읽게 한다. 그 출력 모양과 종류를 고정한다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {inspectRecovery, inspectRecoveryBatch, recoveryBatchOutput, recoveryErrorKind} from '../src/recovery.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {createDatabase, writeStorageMarker} from '../src/storage.mjs';

const CLI = path.resolve(import.meta.dirname, '../src/cli.mjs');
const home = fs.mkdtempSync(path.join(process.env.KADAN_HOME, 'batch-'));
const socketDir = path.join(fs.realpathSync(process.env.TMUX_TMPDIR || '/tmp'), `tmux-${process.getuid()}`);
const ownSocket = path.join(socketDir, process.env.KADAN_SOCKET || process.env.KADAN_LITE_SOCKET || 'kadan');
const start = (role, terminal, extra = {}) => ({kind: 'start', floor: 'tmux', role, session: `kadan-${role}`,
  cwd: '/work', cmd: 'claude --model opus --effort high', panePid: '20', by: 'lead',
  ...(terminal ? {rottieTerminalId: terminal} : {}), ...extra});
// 역할마다 조회 경로의 실패 지점 하나씩을 밟게 만든 원장.
const entries = [
  start('ok', 'tab-ok'),
  start('swapped', 'tab-old'), {kind: 'window', session: 'kadan-swapped', panePid: '20', rottieTerminalId: 'tab-new'},
  start('stopped', 'tab-stopped'), {kind: 'stop', session: 'kadan-stopped'},
  start('broken', 'tab-broken', {panePid: undefined}),
  {...start('named', 'tab-named'), session: 'kadan-other-name'},
  start('many', 'tab-many'),
  start('garbled', 'tab-garbled'),
  start('badeffort', 'tab-badeffort', {cmd: 'claude --effort nonsense'}),
  start('lost', 'tab-lost', {cmd: 'claude --resume x', restoredFrom: 'nowhere'}),
  start('loop', 'tab-loop-1', {cmd: 'claude --resume x', restoredFrom: 'tab-loop-2'}),
  start('loop', 'tab-loop-2', {cmd: 'claude --resume x', restoredFrom: 'tab-loop-1'}),
  {kind: 'window', session: 'kadan-ghost', panePid: '20', rottieTerminalId: 'tab-ghost'},
];
const tmuxOk = stdout => ({status: 0, stdout, stderr: ''});
const paneLines = {'kadan-ok': ['20\t0\t111'], 'kadan-many': ['20\t0\t1', '21\t0\t1'], 'kadan-garbled': ['x\t0\t1'],
  'kadan-badeffort': ['20\t0\t5'], 'kadan-lost': ['20\t0\t6'], 'kadan-loop': ['20\t0\t7']};
// 가짜 tmux: 단건의 세션별 조회와 묶음의 전체 조회에 같은 서버 상태를 답한다. 부른 횟수를 센다.
function fakeTmux(mode = 'ok') {
  const calls = [];
  const run = args => {
    calls.push(args);
    if (mode === 'throw') throw new TypeError('모르는 예외');
    if (mode === 'down') return {status: 1, stdout: '', stderr: 'lost server'};
    if (mode === 'none') return {status: 1, stdout: '', stderr: 'no server running on /x'};
    if (args.includes('-a')) {
      const all = Object.entries(paneLines).flatMap(([name, lines]) => lines.map(line => `${line}\t${name}`));
      return tmuxOk(all.join('\n'));
    }
    const lines = paneLines[args[args.indexOf('-t') + 1].slice(1, -1)];
    return lines ? tmuxOk(lines.join('\n')) : {status: 1, stdout: '', stderr: "can't find session: x"};
  };
  return {run, calls};
}
// 단건 한 번의 결과를 묶음 항목 꼴로 낸다.
function single(flags, mode) {
  try { return {ok: true, result: inspectRecovery(flags, {home, entries, tmux: fakeTmux(mode).run})}; }
  catch (error) { return {ok: false, error: {message: error.message, kind: recoveryErrorKind(error)}}; }
}
const toFlags = item => ({terminal: item.terminal, session: item.session, cwd: item.cwd,
  'pane-pid': item.panePid, 'socket-path': item.socketPath});
const batch = (items, mode, deps = {}) => {
  const tmux = fakeTmux(mode);
  const results = inspectRecoveryBatch({schemaVersion: 1, items}, {home, entries, tmux: tmux.run, ...deps});
  return {results, calls: tmux.calls};
};

// 조회 경로의 실패 지점 → 종류. 새 실패 지점을 더하면 이 표에도 더한다.
const TABLE = [
  [{terminal: 'tab-none'}, 'refused', /현재 카단 역할을 확인하지 못했습니다/],
  [{terminal: 'tab-old'}, 'refused', /교체됐을/],
  [{terminal: 'tab-ghost'}, 'refused', /현재 카단 역할을 확인하지 못했습니다/],
  [{terminal: 'tab-stopped'}, 'refused', /직접 종료한/],
  [{terminal: 'tab-broken'}, 'refused', /시작 기록이 불완전/],
  [{terminal: 'tab-named'}, 'refused', /역할 주소가 다릅니다/],
  [{terminal: 'tab-ok', session: 'kadan-else'}, 'refused', /역할 주소가 다릅니다/],
  [{terminal: 'tab-ok', cwd: '/elsewhere'}, 'refused', /작업 폴더가 다릅니다/],
  [{terminal: 'tab-ok', panePid: '99'}, 'refused', /pane PID가 다릅니다/],
  [{terminal: 'tab-many'}, 'refused', /여러 pane/],
  [{terminal: 'tab-swapped-missing'}, 'refused', /확인하지 못했습니다/],
  [{terminal: 'tab-new', panePid: '20'}, 'refused', /관찰한 카단 pane과 시작 기록이 다릅니다/],
  [{terminal: 'tab-badeffort'}, 'refused', /저장된 Claude 추론 강도/],
  [{terminal: 'tab-lost'}, 'refused', /추론 강도의 원본 역할 기록/],
  [{terminal: 'tab-loop-2'}, 'refused', /추론 강도 복원 기록이 순환/],
  [{terminal: 'tab-garbled'}, 'unavailable', /pane 정보를 확인하지 못했습니다/],
  [{terminal: ''}, 'invalid', /탭 ID가 필요합니다/],
  [{terminal: 'tab-ok', socketPath: '/other/tmux-1/kadan'}, 'invalid', /tmux 서버 경로가 다릅니다/],
  [{terminal: 'tab-none', socketPath: '/other/tmux-1/kadan'}, 'invalid', /tmux 서버 경로가 다릅니다/],
  [{terminal: 'tab-stopped', socketPath: '/other/tmux-1/kadan'}, 'invalid', /tmux 서버 경로가 다릅니다/],
];

test('조회 경로의 실패 지점마다 종류가 표대로이고 묶음 항목은 같은 입력의 단건과 같다', () => {
  const items = [{terminal: 'tab-ok'}, {terminal: 'tab-ok', session: 'kadan-ok', cwd: '/work', panePid: '20',
    socketPath: ownSocket}, {terminal: 'tab-new'}, ...TABLE.map(row => row[0])];
  const {results, calls} = batch(items);
  assert.equal(results.length, items.length);
  assert.equal(calls.length, 1); // 살아 있는 pane 확인은 목록 조회 한 번
  assert.deepEqual(calls[0].slice(0, 3), ['-N', 'list-panes', '-a']);
  for (const [index, item] of items.entries()) {
    assert.deepEqual(results[index], {terminal: item.terminal, ...single(toFlags(item))}, JSON.stringify(item));
  }
  assert.deepEqual(results.slice(0, 3).map(row => [row.ok, row.result?.role, row.result?.sessionCreated]),
    [[true, 'ok', '111'], [true, 'ok', '111'], [true, 'swapped', null]]);
  for (const [index, [item, kind, message]] of TABLE.entries()) {
    const row = results[index + 3];
    assert.equal(row.ok, false, JSON.stringify(item));
    assert.equal(row.error.kind, kind, `${JSON.stringify(item)} → ${row.error.message}`);
    assert.match(row.error.message, message);
    assert.deepEqual(Object.keys(row), ['terminal', 'ok', 'error']);
    assert.deepEqual(Object.keys(row.error), ['message', 'kind']);
  }
});

test('순서와 중복 탭을 그대로 답하고 항목 형식 오류는 그 항목만 invalid다', () => {
  const items = [{terminal: 'tab-stopped'}, {terminal: 'tab-ok'}, {terminal: 'tab-ok'}, null, 'tab-ok', {terminal: 7},
    {terminal: 'tab-ok', cwd: 5}, {terminal: 'tab-ok', panePid: 20}, {terminal: 'tab-ok', session: null, cwd: null},
    {terminal: 'tab-ok', socketPath: ['x']}, {}];
  const {results} = batch(items);
  assert.deepEqual(results.map(row => row.terminal),
    ['tab-stopped', 'tab-ok', 'tab-ok', null, null, null, 'tab-ok', 'tab-ok', 'tab-ok', 'tab-ok', null]);
  assert.deepEqual(results.map(row => row.ok ? 'ok' : row.error.kind), ['refused', 'ok', 'ok', 'invalid', 'invalid',
    'invalid', 'invalid', 'invalid', 'ok', 'invalid', 'invalid']);
  assert.deepEqual(results[1], results[2]);
  assert.deepEqual(Object.keys(results[1]), ['terminal', 'ok', 'result']);
  assert.match(results[6].error.message, /cwd 칸은 문자열/);
  assert.match(results[7].error.message, /panePid 칸은 문자열/);
  assert.deepEqual(batch([]).results, []);
});

test('tmux 목록 조회가 일시 실패하면 pane 확인이 필요한 항목만 unavailable이고 확정된 거절은 그대로다', () => {
  const items = [{terminal: 'tab-ok'}, {terminal: 'tab-stopped'}, {terminal: 'tab-old'}, {terminal: 'tab-many'},
    {terminal: 'tab-ok', cwd: '/elsewhere'}, {terminal: 'tab-ok', socketPath: '/other/tmux-1/kadan'},
    {terminal: 'tab-new'}];
  const expected = ['unavailable', 'refused', 'refused', 'unavailable', 'refused', 'invalid', 'unavailable'];
  for (const mode of ['down', 'throw']) {
    const {results, calls} = batch(items, mode);
    assert.deepEqual(results.map(row => row.error?.kind), expected, mode);
    assert.equal(calls.length, 1, '실패해도 tmux는 한 번만 부른다');
    for (const [index, item] of items.entries()) {
      assert.deepEqual(results[index].error, single(toFlags(item), mode).error);
    }
  }
  assert.match(batch(items, 'down').results[0].error.message, /카단 tmux 조회 실패: lost server/);
  // 서버가 없으면 실패가 아니다: 원장만으로 답하고 sessionCreated는 null이다.
  const none = batch([{terminal: 'tab-ok'}, {terminal: 'tab-many'}], 'none').results;
  assert.deepEqual(none.map(row => [row.ok, row.result.sessionCreated]), [[true, null], [true, null]]);
  assert.deepEqual(none[0], {terminal: 'tab-ok', ...single({terminal: 'tab-ok'}, 'none')});
  // 모든 항목이 원장만으로 끝나면 tmux를 부르지 않는다.
  assert.equal(batch([{terminal: 'tab-stopped'}, {terminal: 'tab-none'}]).calls.length, 0);
});

test('분류하지 않은 예외는 unavailable이다', () => {
  assert.equal(recoveryErrorKind(new Error('x')), 'unavailable');
  assert.equal(recoveryErrorKind(Object.assign(new Error('x'), {recoveryKind: 'weird'})), 'unavailable');
  assert.equal(recoveryErrorKind(null), 'unavailable');
  const boom = batch([{terminal: 'tab-ok'}], 'ok', {livePane: () => { throw new RangeError('boom'); }}).results[0];
  assert.deepEqual(boom.error, {message: 'boom', kind: 'unavailable'});
});

test('묶음 전체 실패는 code 5종 중 하나를 꼭 갖는다', () => {
  const run = (text, deps = {home, entries, tmux: fakeTmux().run}) => recoveryBatchOutput({read: () => text, deps});
  const code = output => {
    assert.equal(output.exitCode, 1);
    assert.deepEqual(Object.keys(output.body), ['schemaVersion', 'ok', 'error']);
    assert.deepEqual(Object.keys(output.body.error), ['message', 'code']);
    assert.equal(output.body.ok, false);
    assert.equal(typeof output.body.error.message, 'string');
    return output.body.error.code;
  };
  for (const text of ['', '  \n', '{', '[]', 'null', '7', '{"schemaVersion":1}', '{"schemaVersion":2,"items":[]}',
    '{"schemaVersion":1,"items":{}}', '{"items":[]}']) assert.equal(code(run(text)), 'batch-invalid', text);
  assert.equal(code(recoveryBatchOutput({read: () => { throw new Error('EAGAIN'); }})), 'batch-invalid');
  const many = count => JSON.stringify({schemaVersion: 1,
    items: Array.from({length: count}, () => ({terminal: 'tab-ok'}))});
  assert.equal(code(run(many(33))), 'batch-too-many');
  const full = run(many(32));
  assert.equal(full.exitCode, 0);
  assert.equal(full.body.results.length, 32);
  assert.deepEqual(Object.keys(full.body), ['schemaVersion', 'ok', 'results']);
  // 원장을 못 읽음: 저장소 표시는 있는데 DB 파일이 없다.
  const broken = fs.mkdtempSync(path.join(process.env.KADAN_HOME, 'batch-broken-'));
  writeStorageMarker(broken, 'sqlite');
  assert.equal(code(run(many(1), {home: broken})), 'store-unreadable');
  // 저장소가 아예 없는 홈: 묶음은 전체 실패, 단건은 같은 문구에 종류만 unavailable. 저장소가 있고 탭만 없으면 refused다.
  const empty = fs.mkdtempSync(path.join(process.env.KADAN_HOME, 'batch-empty-'));
  assert.equal(code(run(many(1), {home: empty})), 'store-unreadable');
  const kindOf = dir => { try { inspectRecovery({terminal: 'tab-x'}, {home: dir}); } catch (error) {
    return [recoveryErrorKind(error), error.message]; } };
  const stored = fs.mkdtempSync(path.join(process.env.KADAN_HOME, 'batch-stored-'));
  createDatabase(stored); writeStorageMarker(stored, 'sqlite');
  assert.deepEqual([kindOf(empty)[0], kindOf(stored)[0]], ['unavailable', 'refused']);
  assert.equal(kindOf(empty)[1], kindOf(stored)[1]);
  const present = run(many(1), {home: stored});
  assert.deepEqual([present.exitCode, present.body.results[0].error.kind], [0, 'refused']);
  assert.equal(code(run(many(1), {get home() { throw new Error('x'); }})), 'internal');
  const floor = process.env.KADAN_FLOOR;
  process.env.KADAN_FLOOR = 'herdr';
  try { assert.equal(code(run(many(1))), 'not-tmux'); }
  finally { if (floor === undefined) delete process.env.KADAN_FLOOR; else process.env.KADAN_FLOOR = floor; }
});

test('실제 명령: 묶음은 한 줄 JSON·종료 코드 0, 단건은 kind만 더해진다', () => {
  const real = fs.mkdtempSync(path.join(process.env.KADAN_HOME, 'batch-cli-'));
  createDatabase(real); writeStorageMarker(real, 'sqlite');
  appendLedger(start('cli', 'tab-cli', {cwd: real}), real);
  appendLedger({kind: 'stop', role: 'gone', session: 'kadan-gone', rottieTerminalId: 'tab-gone'}, real);
  appendLedger(start('gone', 'tab-gone', {cwd: real}), real);
  appendLedger({kind: 'stop', role: 'gone', session: 'kadan-gone'}, real);
  const env = {...process.env, KADAN_HOME: real};
  const cli = (args, options = {}) => spawnSync(process.execPath, [CLI, 'recovery', ...args],
    {encoding: 'utf8', env, timeout: 20000, ...options});
  const items = [{terminal: 'tab-cli'}, {terminal: 'tab-gone'},
    {terminal: 'tab-cli', socketPath: '/other/tmux-1/kadan'}, {terminal: 'tab-none'}];
  const batched = cli(['inspect', '--batch'], {input: JSON.stringify({schemaVersion: 1, items})});
  assert.equal(batched.status, 0, batched.stderr);
  assert.equal(batched.stdout.trim().split('\n').length, 1);
  const body = JSON.parse(batched.stdout);
  assert.deepEqual(Object.keys(body), ['schemaVersion', 'ok', 'results']);
  assert.deepEqual(body.results.map(row => row.ok ? 'ok' : row.error.kind), ['ok', 'refused', 'invalid', 'refused']);
  // 묶음 항목 = 같은 입력의 단건(실제 명령끼리). 단건 실패는 종료 코드 1과 kind 칸.
  for (const [index, item] of items.entries()) {
    const socket = item.socketPath ? ['--socket-path', item.socketPath] : [];
    const one = cli(['inspect', '--terminal', item.terminal, ...socket]);
    const parsed = JSON.parse(one.stdout);
    assert.equal(one.status, parsed.ok ? 0 : 1);
    assert.deepEqual(Object.keys(parsed), ['schemaVersion', 'ok', parsed.ok ? 'result' : 'error']);
    const {schemaVersion, ...rest} = parsed;
    assert.equal(schemaVersion, 1);
    assert.deepEqual({terminal: item.terminal, ...rest}, body.results[index]);
  }
  // 표준 입력이 없거나 비면 기다리지 않고 batch-invalid로 끝난다.
  for (const options of [{stdio: ['ignore', 'pipe', 'pipe']}, {input: ''}, {input: 'not json'}]) {
    const failed = cli(['inspect', '--batch'], options);
    assert.equal(failed.status, 1);
    assert.equal(JSON.parse(failed.stdout).error.code, 'batch-invalid');
  }
  const herdr = cli(['inspect', '--batch'], {input: '{}', env: {...env, KADAN_FLOOR: 'herdr'}});
  assert.deepEqual([herdr.status, JSON.parse(herdr.stdout).error.code], [1, 'not-tmux']);
  // restore·report 실패 출력에는 kind가 붙지 않는다.
  const restore = JSON.parse(cli(['restore', '--context', '{}']).stdout);
  assert.deepEqual(Object.keys(restore.error), ['message']);
  assert.deepEqual(Object.keys(JSON.parse(cli(['nothing']).stdout).error), ['message']);
});

// 부모가 표준 입력을 늦게 쓰거나 늦게 닫아도 "입력 없음"으로 끝내지 않고 끝까지 읽는다.
test('표준 입력이 늦게 오거나 늦게 닫혀도 묶음 입력을 끝까지 읽는다', async () => {
  const real = fs.mkdtempSync(path.join(process.env.KADAN_HOME, 'batch-slow-'));
  createDatabase(real); writeStorageMarker(real, 'sqlite');
  appendLedger(start('slow', 'tab-slow', {cwd: real}), real);
  const text = JSON.stringify({schemaVersion: 1, items: [{terminal: 'tab-slow'}, {terminal: 'tab-none'}]});
  const slow = plan => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'recovery', 'inspect', '--batch'],
      {env: {...process.env, KADAN_HOME: real}, stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', status => resolve({status, stdout}));
    plan(child.stdin);
  });
  const late = await slow(stdin => setTimeout(() => stdin.end(text), 1500));
  const lateClose = await slow(stdin => { stdin.write(text.slice(0, 20));
    setTimeout(() => stdin.write(text.slice(20)), 800); setTimeout(() => stdin.end(), 1600); });
  for (const output of [late, lateClose]) {
    assert.equal(output.status, 0, output.stdout);
    assert.deepEqual(JSON.parse(output.stdout).results.map(row => row.ok ? 'ok' : row.error.kind), ['ok', 'refused']);
  }
});
