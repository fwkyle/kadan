import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDatabase, writeStorageMarker} from '../src/storage.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {CardStore} from '../src/card-store.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {closeWorkRoles} from '../src/work-role-cleanup.mjs';
import {workCommand} from '../src/work-command.mjs';

// Why: 업무 마감 때 작업자·검수자를 함께 끄는 코어(work-role-cleanup)와 CLI 연결(work-command)을 가짜 바닥·가짜 원장으로 시험한다.
// 실물(tmux) 왕복은 격리 소켓 증거로 따로 남긴다.
const IDLE = '\n❯ \n';
const FUTURE = '2999-01-01T00:00:00Z';

function world({profiles = {}, extraOpenWork = null} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-wrc-'));
  createDatabase(home); writeStorageMarker(home, 'sqlite');
  const store = new WorkStore(home), cards = new CardStore(home);
  const mk = (key, owner = '감독') => store.create({key, title: '업무', goal: '결과', scope: '범위', acceptance: '조건', owner, repoPath: home});
  mk('repo/w');
  const roles = {'작업A': 'worker', '검수B': 'reviewer', ...profiles};
  const change = (key, action, fields) => store.change(key, action, fields, {revision: store.get(key).revision, by: '감독', note: '확인'});
  const link = (key, role) => {
    change(key, 'execute', {title: `실행 ${role}`, body: '본문', phase: 'implementation', round: '1'});
    const ex = store.get(key).executions.at(-1).key, id = ex.split('/')[1];
    cards.update(ex, {status: 'assigned', role, board: 'b', scope: '범위', rallyId: 'r', rallyTitle: 'r', rallyRound: '1', rallyStep: 'implementation'}, {revision: cards.get(ex).revision, note: '배정', by: '감독'});
    appendLedger({kind: 'send', by: '감독', role, taskId: id, executionKey: ex, digest: `${role}-${id}`, t: FUTURE}, home);
    appendLedger({kind: 'done', by: role, role, taskId: id, executionKey: ex, result: 'ok', t: FUTURE}, home);
    return {ex, id};
  };
  const pids = {}, alive = {}, stopped = [], screens = {};
  for (const [role, profile] of Object.entries(roles)) {
    pids[`kadan-${role}`] = '100'; alive[`kadan-${role}`] = true; screens[`kadan-${role}`] = IDLE;
    const start = {kind: 'start', floor: 'tmux', role, session: `kadan-${role}`, cmd: 'echo', cwd: home, panePid: '100', by: '감독'};
    if (profile) start.roleProfile = profile;
    appendLedger(start, home);
    link('repo/w', role);
  }
  if (extraOpenWork) { mk('repo/other'); link('repo/other', extraOpenWork); }
  const floor = {name: 'tmux', alive: s => alive[s] === true, pid: s => pids[s], read: s => screens[s], assertHumanIdle: () => {},
    stop: s => { stopped.push(s); alive[s] = false; }};
  const stopCalls = [];
  const stopRole = input => { stopCalls.push(input.role); return {ok: true, session: input.session, entry: {conversation: `conv-${input.role}`}}; };
  const done = () => change('repo/w', 'complete', {result: '근거'});
  return {home, store, floor, pids, alive, screens, stopped, stopCalls, stopRole, done, change, mk, link, cards};
}
const run = (w, extra = {}) => closeWorkRoles({home: w.home, work: w.store.get('repo/w'), floor: w.floor, stopRole: w.stopRole, callerRole: '감독', ...extra});

test('마감 뒤 대상 작업자·검수자를 끄고 대화 번호와 다시 열기 안내를 보인다', () => {
  const w = world(); w.done();
  const out = run(w);
  assert.deepEqual(w.stopCalls.sort(), ['검수B', '작업A']);
  assert.equal(out.closed.length, 2);
  assert.match(out.lines.join('\n'), /끈 역할 2개: .*작업A\(대화 conv-작업A — 다시 열기: kadan reopen 작업A\)/);
});

test('끄지 않음: 프로필이 감독이거나 기록이 없으면 끄지 않고 이유와 kadan stop 안내를 낸다', () => {
  const w = world({profiles: {'작업A': 'conductor', '검수B': ''}}); w.done();
  const out = run(w);
  assert.deepEqual(w.stopCalls, []);
  assert.match(out.skipped.find(s => s.role === '작업A').reason, /conductor/);
  assert.match(out.skipped.find(s => s.role === '검수B').reason, /프로필 기록 없음/);
  assert.match(out.lines.join('\n'), /끄려면 kadan stop 작업A/);
});

test('끄지 않음: 명령을 부른 역할 자신', () => {
  const w = world(); w.done();
  const out = run(w, {callerRole: '작업A'});
  assert.deepEqual(w.stopCalls, ['검수B']);
  assert.match(out.skipped[0].reason, /부른 역할 자신/);
});

test('끄지 않음: 다른 열린 업무의 실행에 배정된 역할(그 카드가 done이어도)', () => {
  const w = world({extraOpenWork: '작업A'}); w.done();
  const out = run(w);
  assert.deepEqual(w.stopCalls, ['검수B']);
  assert.match(out.skipped.find(s => s.role === '작업A').reason, /다른 열린 업무 repo\/other/);
});

test('끄지 않음: 미확정 카드(끝났다는 기록이 없는 발령)가 있는 역할', () => {
  const w = world(); w.done();
  appendLedger({kind: 'send', by: '감독', role: '작업A', taskId: 'x1', digest: 'x1', t: FUTURE}, w.home);
  const out = run(w);
  assert.deepEqual(w.stopCalls, ['검수B']);
  assert.match(out.skipped.find(s => s.role === '작업A').reason, /미확정 카드 1건/);
});

test('끄지 않음: 응답 생성 중·사람 입력·화면 읽기 실패', () => {
  const w = world(); w.done();
  w.screens['kadan-작업A'] = '✢ Grooving… (32s · ↓ 1.7k tokens)\n❯ \n';
  w.screens['kadan-검수B'] = IDLE;
  w.floor.assertHumanIdle = () => { throw Object.assign(new Error('active'), {code: 'KADAN_HUMAN_ACTIVE'}); };
  const out = run(w);
  assert.deepEqual(w.stopCalls, []);
  assert.equal(out.skipped.length, 2);
  assert.match(out.skipped.map(s => s.reason).join('|'), /working: 응답 생성 중/);
  assert.match(out.skipped.map(s => s.reason).join('|'), /입력 중/);
  w.screens['kadan-작업A'] = undefined; w.floor.assertHumanIdle = () => {};
  assert.match(run(w).skipped.find(s => s.role === '작업A').reason, /화면을 읽지 못함/);
});

test('끄지 않음: 세션 소유 확인 실패(시작 PID와 현재 PID가 다름)', () => {
  const w = world(); w.done();
  w.pids['kadan-작업A'] = '999';
  const out = run(w);
  assert.deepEqual(w.stopCalls, ['검수B']);
  assert.match(out.skipped.find(s => s.role === '작업A').reason, /다른 프로세스/);
});

test('끄지 않음: 판정 뒤 끄기 직전에 세션이 다른 프로세스로 바뀌면 끄지 않는다', () => {
  const w = world(); w.done();
  let calls = 0;
  const pid = w.floor.pid;
  w.floor.pid = s => { calls += 1; return calls >= 2 && s === 'kadan-작업A' ? '777' : pid(s); };
  const out = run(w);
  assert.deepEqual(w.stopCalls, ['검수B']);
  assert.match(out.skipped.find(s => s.role === '작업A').reason, /프로세스가 바뀜/);
});

test('끄지 않음: 판정 뒤 끄기 직전에 다른 열린 업무가 생기면(역할마다 다시 읽음) 그 역할은 끄지 않는다', () => {
  const w = world(); w.done();
  const stopRole = input => {
    if (input.role === '작업A') { w.mk('repo/late'); w.link('repo/late', '검수B'); }
    return w.stopRole(input);
  };
  const out = run(w, {stopRole});
  assert.deepEqual(w.stopCalls, ['작업A']);
  assert.match(out.skipped.find(s => s.role === '검수B').reason, /다른 열린 업무 repo\/late/);
});

test('--keep-roles: 아무것도 끄지 않고 꺼졌을 대상만 보인다', () => {
  const w = world(); w.done();
  const out = run(w, {keep: true});
  assert.deepEqual(w.stopCalls, []);
  assert.deepEqual(out.wouldClose.sort(), ['검수B', '작업A']);
  assert.match(out.lines.join('\n'), /꺼졌을 역할 2개\(--keep-roles: 끄지 않음\)/);
});

test('이미 꺼진 세션은 끄기 대상이 아니고 따로 적는다', () => {
  const w = world(); w.done(); w.alive['kadan-작업A'] = false;
  const out = run(w);
  assert.deepEqual(out.already, ['작업A']);
  assert.deepEqual(w.stopCalls, ['검수B']);
});

test('끄기가 던져도 코어는 던지지 않고 이유를 남기며 다음 역할을 계속한다', () => {
  const w = world(); w.done();
  const out = run(w, {stopRole: input => { if (input.role === '작업A') throw new Error('boom'); return w.stopRole(input); }});
  assert.match(out.skipped.find(s => s.role === '작업A').reason, /끄기 실패: boom/);
  assert.deepEqual(w.stopCalls, ['검수B']);
});

test('감독 한 줄: 책임 감독의 열린 업무가 0건이면 알리고, 남아 있으면 말하지 않는다', () => {
  const w = world(); w.done();
  assert.match(run(w).lines.join('\n'), /이 감독\(감독\)은 열린 업무 0건/);
  const w2 = world(); w2.mk('repo/more'); w2.done();
  assert.doesNotMatch(run(w2).lines.join('\n'), /열린 업무 0건/);
});

// ---- CLI 연결(work-command) ----
const ctx = (w, closeRoles) => ({home: w.home, by: '감독', floor: w.floor, closeRoles});
const stderrOf = fn => {
  const orig = process.stderr.write.bind(process.stderr), chunks = [];
  process.stderr.write = s => { chunks.push(String(s)); return true; };
  try { return {value: fn(), stderr: chunks.join('')}; } finally { process.stderr.write = orig; }
};
const completeArgs = w => [['complete', 'repo/w'], {revision: w.store.get('repo/w').revision, result: '근거', note: '확인'}];

test('work complete: 마감 기록 뒤에 끄고 결과에 roleCleanup 칸을 더한다', () => {
  const w = world();
  const order = [];
  const [args, flags] = completeArgs(w);
  const {value, stderr} = stderrOf(() => workCommand(args, flags, ctx(w, input => {
    order.push(w.store.get('repo/w').status);
    return closeWorkRoles({...input, floor: w.floor, stopRole: w.stopRole, callerRole: '감독'});
  })));
  assert.deepEqual(order, ['done']);
  assert.equal(value.status, 'done');
  assert.equal(value.roleCleanup.closed.length, 2);
  assert.match(stderr, /끈 역할 2개/);
});

test('work complete: 끄기가 던져도 마감 결과·상태는 그대로이고 roleCleanup.error만 더해진다', () => {
  const w = world();
  const [args, flags] = completeArgs(w);
  const {value, stderr} = stderrOf(() => workCommand(args, flags, ctx(w, () => { throw new Error('죽음'); })));
  assert.equal(value.status, 'done');
  assert.equal(w.store.get('repo/w').status, 'done');
  assert.equal(value.roleCleanup.error, '죽음');
  assert.match(stderr, /업무 마감은 기록됨/);
});

test('work complete: --keep-roles는 closeRoles에 keep=true를 넘긴다', () => {
  const w = world();
  const [args, flags] = completeArgs(w);
  let seen;
  stderrOf(() => workCommand(args, {...flags, 'keep-roles': true}, ctx(w, input => { seen = input.keep; return {lines: [], kept: true}; })));
  assert.equal(seen, true);
});

test('work complete: 마감 자체가 거절되면(끝나지 않은 실행) 아무것도 끄지 않는다', () => {
  const w = world();
  w.change('repo/w', 'execute', {title: '미완료', body: '본문', phase: 'implementation', round: '2'});
  const [args, flags] = completeArgs(w);
  let called = false;
  assert.throws(() => workCommand(args, flags, ctx(w, () => { called = true; return {lines: []}; })), /끝나지 않은 실행/);
  assert.equal(called, false);
});

test('대시보드 경로(저장소 층 직접 마감)와 closeRoles를 넘기지 않은 호출은 끄지 않는다', () => {
  const w = world();
  w.done();
  assert.deepEqual(w.stopCalls, []);
  const w2 = world();
  const [args, flags] = completeArgs(w2);
  const value = workCommand(args, flags, {home: w2.home, by: '감독', floor: w2.floor});
  assert.equal(value.status, 'done');
  assert.equal('roleCleanup' in value, false);
  assert.deepEqual(w2.stopCalls, []);
});

test('work cancel은 끄지 않는다', () => {
  const w = world();
  let called = false;
  workCommand(['cancel', 'repo/w'], {revision: w.store.get('repo/w').revision, result: '근거', note: '확인'}, ctx(w, () => { called = true; return {lines: []}; }));
  assert.equal(called, false);
});

test('실제 stopRole로 끄면 stop 사건이 원장에 남는다(가짜 바닥)', async () => {
  const w = world(); w.done();
  const {stopRole} = await import('../src/role-stop.mjs');
  const out = closeWorkRoles({home: w.home, work: w.store.get('repo/w'), floor: w.floor, stopRole, callerRole: '감독'});
  assert.deepEqual(w.stopped.sort(), ['kadan-검수B', 'kadan-작업A']);
  assert.equal(out.closed.length, 2);
  const stops = readLedger(w.home).filter(e => e.kind === 'stop');
  assert.equal(stops.length, 2);
  assert.ok(stops.every(e => 'conversation' in e || 'conversationMissing' in e));
});
