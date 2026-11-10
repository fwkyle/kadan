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
  const link = (key, role, t = FUTURE, tDone = FUTURE) => {
    change(key, 'execute', {title: `실행 ${role}`, body: '본문', phase: 'implementation', round: '1'});
    const ex = store.get(key).executions.at(-1).key, id = ex.split('/')[1];
    cards.update(ex, {status: 'assigned', role, board: 'b', scope: '범위', rallyId: 'r', rallyTitle: 'r', rallyRound: '1', rallyStep: 'implementation'}, {revision: cards.get(ex).revision, note: '배정', by: '감독'});
    appendLedger({kind: 'send', by: '감독', role, taskId: id, executionKey: ex, digest: `${role}-${id}`, t, header: true, keyDelivery: 'sent', dispatchId: `d-${id}`}, home);
    appendLedger({kind: 'done', by: role, role, taskId: id, executionKey: ex, result: 'ok', t: tDone}, home);
    return {ex, id};
  };
  const pids = {}, alive = {}, stopped = [], screens = {};
  for (const [role, profile] of Object.entries(roles)) {
    pids[`kadan-${role}`] = '100'; alive[`kadan-${role}`] = true; screens[`kadan-${role}`] = IDLE;
    const start = {kind: 'start', floor: 'tmux', role, session: `kadan-${role}`, cmd: 'codex --model m', cwd: home, panePid: '100', by: '감독'};
    if (profile) start.roleProfile = profile;
    appendLedger(start, home);
    link('repo/w', role);
  }
  if (extraOpenWork) { mk('repo/other'); link('repo/other', extraOpenWork); }
  const floor = {name: 'tmux', alive: s => alive[s] === true, pid: s => pids[s], read: s => screens[s], assertHumanIdle: () => {},
    stop: s => { stopped.push(s); alive[s] = false; }};
  const stopCalls = [];
  const stopRole = input => { try { input.beforeStop?.(); } catch (error) { return {ok: false, code: 1, message: error.message}; } stopCalls.push(input.role); return {ok: true, session: input.session, entry: {conversation: `conv-${input.role}`}}; };
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
  assert.match(out.skipped.find(s => s.role === '작업A').reason, /다시 띄우거나 이어 연 세션/);
});

test('끄지 않음: 판정 뒤 끄기 직전에 세션이 다른 프로세스로 바뀌면 끄지 않는다', () => {
  const w = world(); w.done();
  let calls = 0;
  const pid = w.floor.pid;
  w.floor.pid = s => { calls += 1; return calls >= 2 && s === 'kadan-작업A' ? '777' : pid(s); };
  const out = run(w);
  assert.deepEqual(w.stopCalls, ['검수B']);
  assert.match(out.skipped.find(s => s.role === '작업A').reason, /다시 띄우거나 이어 연 세션|프로세스가 바뀜/);
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

// ---- 독립검수 F1~F3 수정 (PR #378) ----
const realStop = async () => (await import('../src/role-stop.mjs')).stopRole;
const T = m => `2999-${m}`; // 시각을 직접 정해 세대 경계를 만든다
const startOf = (w, role, extra = {}) => appendLedger({kind: 'start', floor: 'tmux', role, session: `kadan-${role}`, cmd: 'codex --model m', cwd: w.home, panePid: '100', roleProfile: 'worker', by: '감독', ...extra}, w.home);
// F1 순서: 발령·done → stop → 같은 이름으로 다시 start → 옛 업무 마감
const reuse = (w, extra) => { appendLedger({kind: 'stop', role: '작업A', session: 'kadan-작업A', by: '감독', t: T('03-01T00:00:00Z')}, w.home); startOf(w, '작업A', {t: T('06-01T00:00:00Z'), ...extra}); };

test('F1: 같은 이름을 새 대화로 다시 쓴 세션은 이 업무와 무관하니 끄지 않는다', () => {
  const w = world(); w.done(); reuse(w, {conversationMode: 'new'});
  const out = run(w);
  assert.deepEqual(w.stopCalls, ['검수B']);
  assert.match(out.skipped.find(s => s.role === '작업A').reason, /발령을 받은 대화 세대가 아님/);
});

for (const [name, extra] of [['kadan reopen(resume)', {conversationMode: 'resume', reopenOf: 'x'}], ['kadan restart', {restartOf: 'x'}]]) {
  test(`범위 좁힘: ${name}으로 이은 세션은 남기고 kadan stop 안내를 낸다`, () => {
    const w = world(); w.done(); reuse(w, extra);
    const out = run(w);
    assert.deepEqual(w.stopCalls, ['검수B']);
    assert.match(out.skipped.find(s => s.role === '작업A').reason, /다시 띄우거나 이어 연 세션 — 직접 끄려면 kadan stop/);
  });
}

test('F1: fork·새 대화로 뜬 세션은 끊긴 세대라 끄지 않는다', () => {
  for (const mode of ['fork', 'new']) {
    const w = world(); w.done(); reuse(w, {conversationMode: mode});
    run(w);
    assert.deepEqual(w.stopCalls, ['검수B'], mode);
  }
});

test('F1: 새 대화 세션이 이 업무의 새 실행을 받았다면(지금 세대 안의 발령) 대상이다', () => {
  const w = world({profiles: {}}); // 옛 실행 없이 새 세대에서 처음 받는다
  reuse(w, {conversationMode: 'new'});
  w.link('repo/w', '작업A', T('07-01T00:00:00Z'), T('07-02T00:00:00Z'));
  w.done();
  run(w);
  assert.ok(w.stopCalls.includes('작업A'));
});

const handover = (w, from, to, key, t = T('02-01T00:00:00Z')) =>
  appendLedger({kind: 'handover', phase: 'transferred', from, to, taskIds: [key.split('/')[1]], t}, w.home);

test('범위 좁힘: 확정 인계로 받은 후임도, 인계한 선임 이름도 끄지 않는다', () => {
  const w = world();
  startOf(w, '후임'); w.alive['kadan-후임'] = true; w.pids['kadan-후임'] = '100'; w.screens['kadan-후임'] = IDLE;
  const ex = w.store.get('repo/w').executions.find(x => w.cards.get(x.key).role === '작업A').key;
  handover(w, '작업A', '후임', ex);
  w.done();
  const out = run(w);
  assert.deepEqual(w.stopCalls, ['검수B']);
  assert.match(out.skipped.find(s => s.role === '후임').reason, /인계에 관련된 세션|발령을 받은 대화 세대가 아님/);
});

test('F2: 다른 열린 업무의 실행을 인계받은 후임이 이번 업무도 맡았으면 후임을 끄지 않는다', () => {
  const w = world({extraOpenWork: '작업A'});
  startOf(w, '후임'); w.alive['kadan-후임'] = true; w.pids['kadan-후임'] = '100'; w.screens['kadan-후임'] = IDLE;
  const mine = w.store.get('repo/w').executions.find(x => w.cards.get(x.key).role === '작업A').key;
  const other = w.store.get('repo/other').executions[0].key;
  handover(w, '작업A', '후임', mine); handover(w, '작업A', '후임', other);
  w.done();
  run(w);
  assert.ok(!w.stopCalls.includes('후임'));
});

// F3: 실제 stopRole로, 대화 번호 조회(lookup) 도중 상황을 바꾼다.
const withLookup = (w, change) => async input => (await realStop())({...input, lookup: () => { change(input.role); return {conversationMissing: 'timeout'}; }});
const wrap = fn => input => { let r; fn(input).then(x => { r = x; }); return r; };
const syncStop = (w, change) => input => {
  // stopRole은 동기 함수다. 동적 import를 피하려고 모듈을 미리 불러 둔다.
  return realStopSync({...input, lookup: () => { change(input.role); return {conversationMissing: 'timeout'}; }});
};
const {stopRole: realStopSync} = await import('../src/role-stop.mjs');

test('F3: 조회 도중 같은 세션에 새 업무의 실행이 발령되면 끄지 않고 stop 사건도 남기지 않는다', () => {
  const w = world(); w.done();
  const out = run(w, {stopRole: syncStop(w, role => {
    if (role === '작업A') appendLedger({kind: 'send', by: '감독', role: '작업A', taskId: 'late-1', digest: 'late-1', t: T('09-01T00:00:00Z')}, w.home);
  })});
  assert.deepEqual(w.stopped, ['kadan-검수B']);
  assert.match(out.skipped.find(s => s.role === '작업A').reason, /미확정 카드 1건/);
  assert.equal(readLedger(w.home).filter(e => e.kind === 'stop' && e.session === 'kadan-작업A').length, 0);
});

test('F3: 조회 도중 화면이 응답 생성 중으로 바뀌면 끄지 않는다', () => {
  const w = world(); w.done();
  const out = run(w, {stopRole: syncStop(w, role => { if (role === '작업A') w.screens['kadan-작업A'] = '✢ Grooving… (32s · ↓ 1.7k tokens)\n❯ \n'; })});
  assert.deepEqual(w.stopped, ['kadan-검수B']);
  assert.match(out.skipped.find(s => s.role === '작업A').reason, /응답 생성 중/);
});

test('F3: 끄기 직전 확인 함수가 던지면 끄지 않는다 / 인자가 없는 stopRole 호출은 예전과 같다', () => {
  const w = world(); w.done();
  const base = {role: '작업A', session: 'kadan-작업A', home: w.home, floor: w.floor, log: () => {}, warn: () => {}, lookup: () => ({conversationMissing: 'timeout'})};
  const refused = realStopSync({...base, beforeStop: () => { throw new Error('확인 실패'); }});
  assert.equal(refused.ok, false); assert.match(refused.message, /확인 실패/);
  assert.deepEqual(w.stopped, []);
  assert.equal(readLedger(w.home).filter(e => e.kind === 'stop').length, 0);
  const plain = realStopSync(base);
  assert.equal(plain.ok, true);
  assert.deepEqual(w.stopped, ['kadan-작업A']);
});

// ---- 재검수 R1~R3: 끄려면 "증명"돼야 한다. 모름·읽기 실패·모양이 다름은 끄지 않는다 ----
const oldKey = w => w.store.get('repo/w').executions.find(x => w.cards.get(x.key).role === '작업A').key;
const sendTo = (w, extra) => appendLedger({kind: 'send', by: '감독', role: '작업A', digest: `x${Math.random()}`, t: T('08-01T00:00:00Z'), ...extra}, w.home);
// 새 대화로 다시 쓴 세션에, 옛 실행 주소가 붙은 우편(발령이 아닌 것)만 쌓인 상태.
function reusedWith(extra) {
  const w = world(); w.done(); reuse(w, {conversationMode: 'new'});
  const key = oldKey(w); sendTo(w, {executionKey: key, ...(typeof extra === 'function' ? extra(key) : extra)});
  return w;
}
const skipsA = (w, pattern = /발령을 받은 대화 세대가 아님/) => {
  const out = run(w);
  assert.ok(!w.stopCalls.includes('작업A'), '작업A를 끄면 안 된다');
  assert.match(out.skipped.find(s => s.role === '작업A').reason, pattern);
};

test('R1: 실행 주소만 붙은 일반 우편은 발령이 아니다', () => skipsA(reusedWith({})));
for (const [name, extra] of [
  ['답장', {replyTo: 'm1'}], ['최종 답장', {replyFinal: true}], ['알림', {notificationOnly: true}],
  ['--raw 전달 읽음', {deliveredRead: true}],  ['메일함 전송', {transport: 'mailbox', mailKind: 'report'}], ['전달이 확정 아님', {keyDelivery: 'unknown'}],
]) {
  test(`R1: taskId가 풀려도 ${name}은 발령이 아니다`, () => {
    const w = reusedWith(key => ({taskId: key.split('/')[1], ...extra}));
    skipsA(w, /발령을 받은 대화 세대가 아님|미확정 카드/);
  });
}
for (const [name, extra, pattern] of [
  ['시작 시각이 해석 불가', {t: 'not-a-date'}, /시작 시각을 확정할 수 없음/],
  ['시작 시각이 비어 있음', {t: ''}, /시작 시각을 확정할 수 없음/],
  ['resume만 적고 이어짐 증거(reopenOf·restartOf)가 없음', {conversationMode: 'resume', t: T('06-01T00:00:00Z')}, /발령을 받은 대화 세대가 아님/],
]) {
  test(`R3: 새 세대 ${name} → 끄지 않는다`, () => {
    const w = world(); w.done();
    appendLedger({kind: 'stop', role: '작업A', session: 'kadan-작업A', by: '감독', t: T('03-01T00:00:00Z')}, w.home);
    startOf(w, '작업A', {conversationMode: 'new', ...extra});
    skipsA(w, pattern);
  });
}
test('호출 역할을 알 수 없으면(빈 값) 아무것도 끄지 않는다', () => {
  const w = world(); w.done();
  const out = run(w, {callerRole: ''});
  assert.deepEqual(w.stopCalls, []);
  assert.equal(out.skipped.length, 2);
  assert.match(out.skipped[0].reason, /부른 역할을 알 수 없음/);
});

test('보류(hold) 업무의 실행에 배정된 역할도 다른 열린 업무로 보호한다', () => {
  const w = world({extraOpenWork: '작업A'});
  w.store.change('repo/other', 'update', {status: 'hold'}, {revision: w.store.get('repo/other').revision, by: '감독', note: '보류'});
  w.done();
  run(w);
  assert.ok(!w.stopCalls.includes('작업A'));
});

// R2: 진행 중인 인계
const stateFile = (w, name, body) => {
  const dir = path.join(w.home, 'handovers'); fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
};
for (const phase of ['preparing', 'prepared', 'accepted', 'routes-pending', 'transferred', 'stopped', 'activation-pending']) {
  test(`R2: 인계 단계 ${phase}에 묶인 선임·후임은 끄지 않는다`, () => {
    for (const side of ['from', 'to']) {
      const w = world();
      stateFile(w, 'h1.json', {id: 'h1', phase, from: side === 'from' ? '작업A' : '다른선임', to: side === 'to' ? '작업A' : '다른후임'});
      w.done();
      const out = run(w);
      assert.ok(!w.stopCalls.includes('작업A'), `${phase}/${side}`);
      assert.match(out.skipped.find(s => s.role === '작업A').reason, /인계에 관련된 세션/);
    }
  });
}
test('R2: 끝난 인계 상태 파일과 모양이 맞는 인수 근거 파일만 있으면(원장 인계 사건 없음) 막지 않는다', () => {
  const w = world();
  stateFile(w, 'a.json', {id: 'a', phase: 'complete', from: '작업A', to: 'x'});
  stateFile(w, 'b.json', {id: 'b', phase: 'aborted', from: '작업A', to: 'y'});
  stateFile(w, 'c.json', {taskIds: [], evidencePaths: ['/x'], nextAction: '다음'});
  w.done(); run(w);
  assert.ok(w.stopCalls.includes('작업A'));
});

test('S3: 읽지 못하거나 모양을 알 수 없는 인계 파일이 하나라도 있으면 아무도 끄지 않는다', () => {
  for (const body of ['{깨짐', {id: 'z', phase: 7}, {id: 'z', phase: 'complete'}, {id: 'z', phase: 'complete', from: {}, to: 'x'},
    [], {아무거나: 1}, {taskIds: [], evidencePaths: [], nextAction: '', phase: 'x'}]) {
    const w = world(); stateFile(w, 'bad.json', body); w.done();
    const out = run(w);
    assert.deepEqual(w.stopCalls, [], JSON.stringify(body));
    assert.match(out.skipped[0].reason, /인계 상태를 읽지 못함/);
  }
});
test('원장에 그 역할이 관련된 인계 사건이 start 뒤에 있으면 끝난 인계(complete)여도 끄지 않는다', () => {
  for (const phases of [['prepared'], ['prepared', 'complete'], ['prepared', 'aborted']]) {
    const w = world(); w.done();
    for (const phase of phases) appendLedger({kind: 'handover', phase, handoverId: 'hh', from: '작업A', to: '신입', taskIds: []}, w.home);
    run(w);
    assert.ok(!w.stopCalls.includes('작업A'), phases.join());
  }
});

test('S2: 잘못된 참조 문자열(reopenOf: 숫자·객체·true)이어도 이어 연 표시로 보고 끄지 않는다', () => {
  for (const extra of [{reopenOf: 123}, {reopenOf: {}}, {restartOf: true}, {restoredFrom: 'x'}, {secretaryResumeSource: 'x'}, {inheritMail: true}]) {
    const w = world(); w.done(); reuse(w, extra);
    run(w);
    assert.ok(!w.stopCalls.includes('작업A'), JSON.stringify(extra));
  }
});

test('S2: stop 없이 같은 PID로 다시 기록된 start는 재사용으로 무시하고 보통 세션은 꺼진다 / PID가 다르면 끄지 않는다', () => {
  const w = world(); startOf(w, '작업A'); w.done(); // 같은 pane PID 100의 재사용 기록
  run(w);
  assert.ok(w.stopCalls.includes('작업A'));
  const w2 = world(); startOf(w2, '작업A', {panePid: '200'}); w2.pids['kadan-작업A'] = '200'; w2.done(); // PID가 다른 새 start(stop 없음)
  run(w2);
  assert.ok(!w2.stopCalls.includes('작업A'));
});

test('S2: stop 없이 같은 PID로 기록된 새 대화(재사용 기록에 resume·모름)도 첫 start가 새 대화면 꺼진다 — 판정은 첫 start 기준', () => {
  const w = world(); startOf(w, '작업A', {cmd: 'codex resume abc'}); w.done();
  run(w);
  assert.ok(w.stopCalls.includes('작업A'));
});

test('모름: 띄운 start의 명령을 알 수 없거나 resume이면(새 대화로 확실하지 않으면) 끄지 않는다', () => {
  for (const cmd of ['echo', 'codex resume abc', 'codex --unknown-option x', '']) {
    const w = world();
    // 같은 세션의 첫 start를 바꿀 수 없으니 stop 뒤에 새 명령으로 다시 띄운 것으로 만든다.
    appendLedger({kind: 'stop', role: '작업A', session: 'kadan-작업A', by: '감독', t: T('03-01T00:00:00Z')}, w.home);
    startOf(w, '작업A', {cmd, t: T('04-01T00:00:00Z')});
    w.link('repo/w', '작업A', T('05-01T00:00:00Z'), T('05-02T00:00:00Z'));
    w.done();
    run(w);
    assert.ok(!w.stopCalls.includes('작업A'), cmd);
  }
});
