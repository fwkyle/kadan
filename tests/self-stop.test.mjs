import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {ledgerHome, appendLedger, readLedger} from '../src/ledger.mjs';
import {stopRole} from '../src/role-stop.mjs';
import {ancestorsOf, isInPaneTree, readProcessTable, runSelfStopTail, handoffSelfStop} from '../src/self-stop.mjs';
import {markStopped, unmarkStopped, readReviveState} from '../src/revive.mjs';

const table = rows => new Map(rows.map(([pid, ppid, pgid = pid]) => [pid, {ppid, pgid}]));
const lines = file => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const fakeFloor = (over = {}) => ({name: 'fake', alive: () => true, pid: () => '500', stop() { this.stopped = (this.stopped ?? 0) + 1; }, ...over});

test('조상 사슬: 부모를 따라가고 1·표에 없는 곳·고리에서 멈춘다', () => {
  const t = table([[300, 200], [200, 100], [100, 1], [1, 0]]);
  assert.deepEqual(ancestorsOf(300, t), [200, 100, 1]);
  assert.deepEqual(ancestorsOf(999, t), []);
  assert.deepEqual(ancestorsOf(300, null), []);
  assert.deepEqual(ancestorsOf(10, table([[10, 20], [20, 10]])), [20], '고리가 있어도 끝난다(이미 본 PID는 다시 쓰지 않는다)');
});

test('자기 세션 판정: pane PID의 자손이면 참, 자손이 아니거나 pane PID가 이상하면 거짓', () => {
  const t = table([[300, 200], [200, 100], [100, 1], [400, 1], [1, 0]]);
  assert.equal(isInPaneTree(200, {table: t, pid: 300}), true);
  assert.equal(isInPaneTree(100, {table: t, pid: 300}), true, '손자도 자손이다');
  assert.equal(isInPaneTree(200, {table: t, pid: 300}), true);
  assert.equal(isInPaneTree(300, {table: t, pid: 300}), true, 'pane 프로세스가 직접 stop을 쳐도 자기 세션이다');
  assert.equal(isInPaneTree(200, {table: t, pid: 400}), false, '다른 갈래의 프로세스는 아니다');
  assert.equal(isInPaneTree(1, {table: t, pid: 300}), false, '모든 프로세스가 1의 자손이라 1은 판정하지 않는다');
  assert.equal(isInPaneTree(0, {table: t, pid: 300}), false);
  assert.equal(isInPaneTree('abc', {table: t, pid: 300}), false);
  assert.equal(isInPaneTree(undefined, {table: t, pid: 300}), false);
  assert.equal(isInPaneTree(200, {table: null, pid: 300}), false, '표를 못 읽으면 자기 세션으로 보지 않는다(예전 경로)');
});

test('readProcessTable: ps 출력을 해석하고 해석 못 하면 null', () => {
  const ok = readProcessTable({spawnFn: () => ({stdout: '  10  1  10\n  11 10  10\n'})});
  assert.deepEqual(ok.get(11), {ppid: 10, pgid: 10});
  assert.equal(readProcessTable({spawnFn: () => ({stdout: '/x/rottie\n'})}), null);
  assert.equal(readProcessTable({spawnFn: () => { throw new Error('없음'); }}), null);
  assert.ok(readProcessTable() instanceof Map, '진짜 ps도 읽힌다');
});

function seed(role, session, panePid = 500) {
  const home = ledgerHome();
  unmarkStopped(home, role, null); // 시험끼리 멈춤 표시를 물려주지 않는다
  appendLedger({kind: 'start', floor: 'fake', role, session, panePid, roleProfile: 'worker', by: 'test'}, home);
  return home;
}

test('stopRole: selfStop이 없거나 판정이 거짓이면 예전 경로 그대로 끈다(넘기지 않는다)', () => {
  for (const [name, selfStop] of [['none', null], ['false', {isSelf: () => false, handoff: () => assert.fail('넘기면 안 된다')}]]) {
    const role = `plain-${name}`, session = `kadan-${role}`;
    const home = seed(role, session);
    const floor = fakeFloor();
    const out = [];
    const result = stopRole({role, session, home, floor, selfStop, log: l => out.push(l)});
    assert.equal(result.ok, true);
    assert.equal(result.handedOff, undefined);
    assert.equal(floor.stopped, 1);
    assert.deepEqual(out, [`종료됨: ${session}`]);
    assert.equal(readLedger(home).filter(e => e.kind === 'stop' && e.session === session).length, 1);
  }
});

test('stopRole: 판정이 참이면 끄지 않고 넘기며, 한 줄만 출력한다 — 앞에서 계산한 값이 그대로 넘어간다', () => {
  const role = 'watch', session = 'kadan-watch';
  const home = seed(role, session);
  const floor = fakeFloor();
  const out = [], seen = [];
  const result = stopRole({role, session, home, floor, log: l => out.push(l),
    selfStop: {isSelf: pane => { seen.push(pane); return true; }, handoff: payload => { seen.push(payload); return {logPath: '/log/x'}; }}});
  assert.equal(result.ok, true); assert.equal(result.handedOff, true); assert.equal(result.logPath, '/log/x');
  assert.equal(floor.stopped, undefined, '앞쪽은 끄지 않는다');
  assert.deepEqual(out, ['자기 세션 종료를 분리된 프로세스로 넘김(기록: /log/x)']);
  assert.equal(seen[0], '500');
  const payload = seen[1];
  assert.equal(payload.infrastructure, true);
  assert.deepEqual(payload.marked, {previous: null}, '멈춤 표시를 저장했고 되돌릴 이전 값을 넘긴다');
  assert.equal(payload.owner.start.panePid, 500);
  assert.equal(readReviveState(home).targets.watch.state, 'stopped');
  assert.equal(readLedger(home).filter(e => e.kind === 'stop' && e.session === session).length, 0, '기록은 끄고 난 뒤 넘겨받은 쪽이 쓴다');
});

test('stopRole: 넘기지 못하면 멈춤 표시를 되돌리고 끄지 않는다', () => {
  const role = '비서', session = 'kadan-비서';
  const home = seed(role, session);
  const floor = fakeFloor();
  const result = stopRole({role, session, home, floor, log() {},
    selfStop: {isSelf: () => true, handoff: () => { throw new Error('spawn 실패'); }}});
  assert.equal(result.ok, false);
  assert.match(result.message, /자기 세션 종료를 넘기지 못했습니다: spawn 실패/);
  assert.equal(floor.stopped, undefined);
  assert.equal(readReviveState(home).targets[role], undefined, '표시가 되돌려졌다');
});

function tailBody(role, session, logPath, over = {}) {
  return {role, session, logPath, parentPid: 2 ** 22 + 12345, infrastructure: true,
    owner: {role, session, revive: null, start: {panePid: 500}}, marked: {previous: null}, conversation: {conversationMissing: 'test'}, owned: [], by: 'caller-role', ...over};
}

test('넘겨받은 쪽: 부모가 끝났고 pane 밖이면 끄고 기록하며, 끄기 직전 근거를 로그에 남긴다 (다시 넘기지 않는다)', () => {
  const role = 'watch', session = 'kadan-watch-tail';
  const home = seed(role, session);
  markStopped(home, role);
  const logPath = path.join(home, 'tail-ok.log');
  const floor = fakeFloor();
  // 조상 사슬에 pane(500)이 없는 표
  const result = runSelfStopTail(tailBody(role, session, logPath), {home, floor, waitMs: 50,
    readTable: () => table([[process.pid, 1, 77], [1, 0]])});
  assert.equal(result.ok, true);
  assert.equal(floor.stopped, 1);
  const stop = readLedger(home).findLast(e => e.kind === 'stop' && e.session === session);
  assert.equal(stop.conversationMissing, 'test');
  assert.equal(stop.by, 'caller-role', '명령을 친 쪽(by)이 그대로 기록된다');
  const log = lines(logPath);
  const before = log.find(l => l.step === 'before-stop');
  assert.equal(before.inPaneTree, false); assert.equal(before.pgid, 77); assert.equal(before.panePid, 500);
  assert.equal(log.filter(l => l.step === 'handoff').length, 0, '넘겨받은 쪽은 넘기기를 하지 않는다');
  assert.equal(log.at(-1).step, 'done');
  assert.equal(readReviveState(home).targets[role].state, 'stopped', '끈 것의 표시는 남는다');
});

test('넘겨받은 쪽: 아직 pane 안이면 끄지 않고 멈춤 표시를 되돌리고 로그에 남긴다', () => {
  const role = 'watch', session = 'kadan-watch-inpane';
  const home = seed(role, session);
  const marked = markStopped(home, role);
  const logPath = path.join(home, 'tail-inpane.log');
  const floor = fakeFloor();
  const result = runSelfStopTail(tailBody(role, session, logPath, {marked}), {home, floor, waitMs: 50,
    readTable: () => table([[process.pid, 500, 500], [500, 1], [1, 0]])});
  assert.equal(result.ok, false);
  assert.equal(floor.stopped, undefined);
  assert.equal(readReviveState(home).targets[role], undefined);
  const log = lines(logPath);
  assert.equal(log.find(l => l.step === 'before-stop').inPaneTree, true);
  assert.match(log.at(-1).message, /아직 pane 안/);
});

test('넘겨받은 쪽: 앞쪽이 끝나지 않으면 끄지 않고 되돌린다', () => {
  const role = 'watch', session = 'kadan-watch-parent';
  const home = seed(role, session);
  const marked = markStopped(home, role);
  const logPath = path.join(home, 'tail-parent.log');
  const floor = fakeFloor();
  const result = runSelfStopTail(tailBody(role, session, logPath, {marked, parentPid: process.ppid}), {home, floor, waitMs: 60});
  assert.equal(result.ok, false);
  assert.equal(floor.stopped, undefined);
  assert.equal(readReviveState(home).targets[role], undefined);
  assert.match(lines(logPath).at(-1).message, /끝나지 않아 끄지 않았다/);
});

test('넘겨받은 쪽: 넘긴 뒤 주인 PID가 바뀌면 끄지 않고 표시를 되돌리고 로그에 남긴다', () => {
  const role = 'watch', session = 'kadan-watch-pidchg';
  const home = seed(role, session);
  const marked = markStopped(home, role);
  const logPath = path.join(home, 'tail-pid.log');
  const floor = fakeFloor({pid: () => '900'}); // 시작 기록은 500
  const result = runSelfStopTail(tailBody(role, session, logPath, {marked, owner: {role, session, revive: null, start: {panePid: 500}}}),
    {home, floor, waitMs: 50, readTable: () => table([[process.pid, 1], [1, 0]])});
  assert.equal(result.ok, false);
  assert.equal(floor.stopped, undefined);
  assert.equal(readReviveState(home).targets[role], undefined, '표시가 되돌려졌다');
  assert.equal(readLedger(home).filter(e => e.kind === 'stop' && e.session === session).length, 0);
  const log = lines(logPath);
  assert.match(log.at(-1).message, /다른 프로세스다/);
});

test('넘겨받은 쪽: 끄기가 실패하면 표시를 되돌리고 로그에 남긴다', () => {
  const role = 'watch', session = 'kadan-watch-stopfail';
  const home = seed(role, session);
  const marked = markStopped(home, role);
  const logPath = path.join(home, 'tail-stopfail.log');
  const floor = fakeFloor({stop() { throw new Error('종료 실패: x'); }});
  const result = runSelfStopTail(tailBody(role, session, logPath, {marked}), {home, floor, waitMs: 50,
    readTable: () => table([[process.pid, 1], [1, 0]])});
  assert.equal(result.ok, false);
  assert.equal(readReviveState(home).targets[role], undefined);
  assert.match(lines(logPath).find(l => l.step === 'refused').message, /종료 실패: x/);
});

test('넘기기: 새 세션으로 떼고 입출력을 로그 파일로 보내며 payload에 시작 기록 전체를 싣지 않는다', () => {
  const role = 'worker-x', session = 'kadan-worker-x';
  const home = ledgerHome();
  const owner = {role, session, revive: null, start: {panePid: 500, cmd: 'secret-looking-command', rottieTerminalId: 't'}};
  let call;
  const result = handoffSelfStop({home, role, session, owner, infrastructure: false, marked: null, conversation: {}, owned: []},
    {spawnFn: (exe, args, opts) => { call = {exe, args, opts}; return {pid: 4242, unref() {}, on() {}}; }, now: () => 111});
  assert.equal(result.logPath, path.join(home, 'diagnostics', `self-stop-${session}-111.log`));
  assert.equal(call.opts.detached, true);
  assert.equal(typeof call.opts.stdio[1], 'number', '파이프가 아니라 파일 디스크립터다');
  assert.equal(call.opts.stdio[1], call.opts.stdio[2]);
  const flagAt = call.args.indexOf('--self-stop-tail');
  assert.ok(flagAt > 1);
  const body = JSON.parse(call.args[flagAt + 1]);
  assert.equal(body.parentPid, process.pid);
  assert.deepEqual(body.owner.start, {panePid: 500}, '시작 기록 전체가 아니라 PID만 싣는다');
  assert.doesNotMatch(call.args[flagAt + 1], /secret-looking-command/);
  assert.equal(lines(result.logPath)[0].step, 'handoff');
  assert.throws(() => handoffSelfStop({home, role, session: 'kadan-nospawn', owner, infrastructure: false, marked: null, conversation: {}, owned: []},
    {spawnFn: () => ({on() {}, unref() {}})}), /띄우지 못했다/);
});
