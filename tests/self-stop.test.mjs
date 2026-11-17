import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {ledgerHome, appendLedger, readLedger} from '../src/ledger.mjs';
import {stopRole} from '../src/role-stop.mjs';
import {ancestorsOf, isInPaneTree, readProcessTable, runSelfStopTail, handoffSelfStop, selfStopLogPath} from '../src/self-stop.mjs';
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

test('readProcessTable: ps 출력을 해석하고, 실패·시간 초과·해석 불가는 null이며, 시간 상한을 건다', () => {
  let seen;
  const ok = readProcessTable({spawnFn: (...args) => { seen = args; return {status: 0, stdout: '  10  1  10\n  11 10  10\n'}; }});
  assert.deepEqual(ok.get(11), {ppid: 10, pgid: 10});
  assert.equal(seen[2].timeout, 2000, 'ps에 2초 상한을 건다');
  assert.equal(readProcessTable({spawnFn: () => ({status: 0, stdout: '/x/rottie\n'})}), null);
  assert.equal(readProcessTable({spawnFn: () => ({status: 1, stdout: '  10  1  10\n'})}), null, '실패 종료는 모름이다');
  assert.equal(readProcessTable({spawnFn: () => ({error: Object.assign(new Error('ETIMEDOUT'), {code: 'ETIMEDOUT'}), status: null, stdout: ''})}), null, '시간 초과는 모름이다');
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

test('stopRole: 판정이 참이면 표시도 대화 조회도 끄기도 하지 않고 넘기며 한 줄만 출력한다 — 넘기는 값은 역할뿐이다', () => {
  const role = 'watch', session = 'kadan-watch';
  const home = seed(role, session);
  const floor = fakeFloor();
  const out = [], seen = [];
  const result = stopRole({role, session, home, floor, log: l => out.push(l), lookup: () => assert.fail('앞쪽은 대화를 조회하지 않는다'),
    selfStop: {isSelf: pane => { seen.push(pane); return true; }, handoff: payload => { seen.push(payload); return {logPath: '/log/x'}; }}});
  assert.equal(result.ok, true); assert.equal(result.handedOff, true); assert.equal(result.logPath, '/log/x');
  assert.equal(floor.stopped, undefined, '앞쪽은 끄지 않는다');
  assert.deepEqual(out, ['자기 세션 종료를 분리된 프로세스로 넘김(기록: /log/x)']);
  assert.equal(seen[0], '500');
  assert.deepEqual(seen[1], {role, session, home});
  assert.equal(readReviveState(home).targets.watch, undefined, '멈춤 표시는 넘겨받은 쪽이 저장한다');
  assert.equal(readLedger(home).filter(e => e.kind === 'stop' && e.session === session).length, 0);
});

test('stopRole: 앞쪽의 거절은 넘기기 전에 그대로 난다(시작 기록 없음·PID 다름)', () => {
  const home = ledgerHome();
  const handoff = () => assert.fail('거절되면 넘기지 않는다');
  const selfStop = {isSelf: () => true, handoff};
  const none = stopRole({role: 'nostart-role', session: 'kadan-nostart-role', home, floor: fakeFloor(), log() {}, selfStop});
  assert.equal(none.ok, false); assert.match(none.message, /시작 PID 기록 없음/);
  const home2 = seed('pid-role', 'kadan-pid-role', 777);
  const diff = stopRole({role: 'pid-role', session: 'kadan-pid-role', home: home2, floor: fakeFloor(), log() {}, selfStop});
  assert.equal(diff.ok, false); assert.match(diff.message, /다른 프로세스다/);
});

test('stopRole: 넘기지 못하면 아무것도 바꾸지 않고 거절한다', () => {
  const role = '비서', session = 'kadan-비서';
  const home = seed(role, session);
  const floor = fakeFloor();
  const result = stopRole({role, session, home, floor, log() {},
    selfStop: {isSelf: () => true, handoff: () => { throw new Error('spawn 실패'); }}});
  assert.equal(result.ok, false);
  assert.match(result.message, /자기 세션 종료를 넘기지 못했습니다: spawn 실패/);
  assert.equal(floor.stopped, undefined);
  assert.equal(readReviveState(home).targets[role], undefined, '표시를 저장하기 전이라 되돌릴 것도 없다');
});

// 넘겨받은 쪽: 실제 stopRole을 가짜 바닥 위에서 돌린다(원장·주인 확인·멈춤 표시는 진짜).
const bodyFor = (over = {}) => ({role: undefined, parentPid: 2 ** 22 + 12345, ...over});
const tail = (role, session, home, deps, over) =>
  runSelfStopTail(bodyFor({role, ...over}), {role, session, home}, {waitMs: 50, readTable: () => table([[process.pid, 1, 77], [1, 0]]), ...deps});
const logOf = (home, session, parentPid = bodyFor().parentPid) => lines(selfStopLogPath(home, session, parentPid));

test('넘겨받은 쪽: 부모가 끝났고 pane 밖이면 일반 stop처럼 끄고 기록하며, 끄기 직전 근거를 로그에 남긴다', () => {
  const role = 'watch', session = 'kadan-watch-tail';
  const home = seed(role, session);
  const floor = fakeFloor();
  const result = tail(role, session, home, {floor});
  assert.equal(result.ok, true);
  assert.equal(floor.stopped, 1);
  const stop = readLedger(home).findLast(e => e.kind === 'stop' && e.session === session);
  assert.equal(stop.by, '사람', 'by는 이 프로세스의 환경(KADAN_ROLE)으로 정한다');
  assert.equal(stop.conversationSkipped, 'infrastructure', '기반 프로세스 여부는 역할로 다시 정한다');
  const log = logOf(home, session);
  const before = log.find(l => l.step === 'before-stop');
  assert.equal(before.inPaneTree, false); assert.equal(before.pgid, 77); assert.equal(before.panePid, 500);
  assert.equal(log.filter(l => l.step === 'handoff').length, 0, '넘겨받은 쪽은 넘기기를 하지 않는다');
  assert.equal(log.at(-1).step, 'done');
  assert.equal(readReviveState(home).targets[role].state, 'stopped', '끈 것의 표시는 남는다');
});

test('넘겨받은 쪽: 아직 pane 안이면 끄지 않고 멈춤 표시를 되돌리고 로그에 남긴다', () => {
  const role = 'watch', session = 'kadan-watch-inpane';
  const home = seed(role, session);
  const floor = fakeFloor();
  const result = tail(role, session, home, {floor, readTable: () => table([[process.pid, 500, 500], [500, 1], [1, 0]])});
  assert.equal(result.ok, false);
  assert.equal(floor.stopped, undefined);
  assert.equal(readReviveState(home).targets[role], undefined);
  const log = logOf(home, session);
  assert.equal(log.find(l => l.step === 'before-stop').inPaneTree, true);
  assert.match(log.at(-1).message, /아직 pane 안/);
});

test('넘겨받은 쪽: ps 표를 못 읽으면 pane 밖으로 보지 않고 끄지 않으며 표시를 되돌리고 로그에 남긴다', () => {
  const role = 'watch', session = 'kadan-watch-nops';
  const home = seed(role, session);
  const floor = fakeFloor();
  const result = tail(role, session, home, {floor, readTable: () => null});
  assert.equal(result.ok, false);
  assert.equal(floor.stopped, undefined);
  assert.equal(readReviveState(home).targets[role], undefined, '표시가 되돌려졌다');
  assert.equal(readLedger(home).filter(e => e.kind === 'stop' && e.session === session).length, 0);
  assert.match(logOf(home, session).at(-1).message, /ps 표를 읽지 못해/);
});

test('넘겨받은 쪽: 앞쪽이 끝나지 않으면 끄지 않는다', () => {
  const role = 'watch', session = 'kadan-watch-parent';
  const home = seed(role, session);
  const floor = fakeFloor();
  const result = tail(role, session, home, {floor, waitMs: 60}, {parentPid: process.ppid});
  assert.equal(result.ok, false);
  assert.equal(floor.stopped, undefined);
  assert.equal(readReviveState(home).targets[role], undefined);
  assert.match(logOf(home, session, process.ppid).at(-1).message, /끝나지 않아 끄지 않았다/);
});

test('넘겨받은 쪽: 명령의 역할과 payload의 역할이 다르거나 앞쪽 PID가 이상하면 아무것도 하지 않는다', () => {
  const role = 'watch', session = 'kadan-watch-bad';
  const home = seed(role, session);
  const floor = fakeFloor();
  assert.equal(tail(role, session, home, {floor}, {role: 'other'}).ok, false);
  assert.equal(tail(role, session, home, {floor}, {parentPid: 'x'}).ok, false);
  assert.equal(tail(role, session, home, {floor}, {parentPid: 1}).ok, false);
  assert.equal(runSelfStopTail(null, {role, session, home}, {floor}).ok, false);
  assert.equal(floor.stopped, undefined);
  assert.equal(readReviveState(home).targets[role], undefined);
  assert.match(logOf(home, session).at(-1).message, /명령의 역할\(watch\)과 넘겨받은 역할\(other\)이 달라/);
});

test('넘겨받은 쪽: 원장의 시작 기록이 없거나 PID가 다르면 일반 stop처럼 거절한다 — payload는 믿지 않는다', () => {
  const home = ledgerHome();
  const floor = fakeFloor();
  const none = tail('ghost', 'kadan-ghost', home, {floor});
  assert.equal(none.ok, false); assert.match(none.message, /시작 PID 기록 없음/);
  const home2 = seed('pidchg', 'kadan-pidchg', 777);
  const diff = tail('pidchg', 'kadan-pidchg', home2, {floor});
  assert.equal(diff.ok, false); assert.match(diff.message, /다른 프로세스다/);
  assert.equal(floor.stopped, undefined);
});

test('넘겨받은 쪽: 끄기가 실패하면 표시를 되돌리고 로그에 남긴다', () => {
  const role = 'watch', session = 'kadan-watch-stopfail';
  const home = seed(role, session);
  const floor = fakeFloor({stop() { throw new Error('종료 실패: x'); }});
  const result = tail(role, session, home, {floor});
  assert.equal(result.ok, false);
  assert.equal(readReviveState(home).targets[role], undefined);
  assert.match(logOf(home, session).find(l => l.step === 'done').message, /종료 실패: x/);
});

test('넘기기: 새 세션으로 떼고 입출력을 로그 파일로 보내며, 넘기는 값은 역할과 앞쪽 PID뿐이다', () => {
  const role = 'worker-x', session = 'kadan-worker-x';
  const home = ledgerHome();
  let call;
  const result = handoffSelfStop({home, role, session},
    {spawnFn: (exe, args, opts) => { call = {exe, args, opts}; return {pid: 4242, unref() {}, on() {}}; }});
  assert.equal(result.logPath, selfStopLogPath(home, session, process.pid));
  assert.equal(call.opts.detached, true);
  assert.equal(typeof call.opts.stdio[1], 'number', '파이프가 아니라 파일 디스크립터다');
  assert.equal(call.opts.stdio[1], call.opts.stdio[2]);
  const flagAt = call.args.indexOf('--self-stop-tail');
  assert.equal(call.args[flagAt - 1], role, '명령 인자의 역할도 같이 간다');
  assert.deepEqual(JSON.parse(call.args[flagAt + 1]), {role, parentPid: process.pid});
  assert.equal(lines(result.logPath)[0].step, 'handoff');
  assert.throws(() => handoffSelfStop({home, role, session: 'kadan-nospawn'}, {spawnFn: () => ({on() {}, unref() {}})}), /띄우지 못했다/);
});
