import "./helpers/isolated-home.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {restartInfra, ROLE_RESTART_CAP} from '../src/infra-restart.mjs';
import {readReviveState, writeReviveState, prepareRevive, acquireReviveLock} from '../src/revive.mjs';
import {autopilotGuard, guardedReason} from '../src/autopilot-guard.mjs';
import {normalizeForRevive, callWithoutExit, insideSession} from '../src/commands/infra-restart.mjs';
import {wrapInfraEnv} from '../src/floor-tmux.mjs';
import {spawnSync} from 'node:child_process';
import {summarizeAutopilot} from '../src/autopilot-summary.mjs';

// 가짜 끄기·시작·생존 확인·알림만 쓴다. 운영 홈·tmux·창·알림에 닿지 않는다.
const T0 = Date.parse('2026-11-11T03:00:00.000Z');
const newHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-infra-restart-'));
function world({startResult = 'started', startThrows = null, alive = true, home = newHome()} = {}) {
  const calls = [], notices = [], records = [];
  const deps = {
    stop: (t) => { calls.push(['stop', t]); },
    start: (t) => { calls.push(['start', t]); if (startThrows) throw new Error(startThrows); return startResult; },
    verify: async (t) => { calls.push(['verify', t]); return alive; },
    notify: (message, opts) => { notices.push({message, opts}); },
    record: (entry) => { records.push(entry); appendLedger(entry, home); },
  };
  const run = (target, byRole = null, extra = {}) => restartInfra({home, target, byRole, deps, now: () => T0, waitMs: 20, pollMs: 5, stableMs: 5, ...extra});
  return {home, calls, notices, records, deps, run};
}

test('1 Autopilot 켜짐 + 역할 세션: restart watch|대시보드는 통과, stop·restart --force는 거절하고 이유와 새 명령을 알린다', () => {
  const home = newHome();
  appendLedger({kind: 'autopilot', phase: 'on', by: '사람', text: 't', t: new Date(T0).toISOString(), to: [], delivered: []}, home);
  const entries = readLedger(home), env = {KADAN_ROLE: 'a-감독'}, base = {home, now: T0 + 1000, entries, env};
  for (const target of ['watch', '대시보드']) {
    assert.equal(guardedReason('restart', [target], {}), null);
    autopilotGuard({...base, command: 'restart', args: [target], flags: {}});
  }
  for (const target of ['watch', '대시보드', '디코', '비서']) {
    assert.throws(() => autopilotGuard({...base, command: 'stop', args: [target], flags: {}}), error => {
      assert.equal(error.exitCode, 2);
      assert.match(error.message, /자리를 비운 동안 아무도 못 봅니다/);
      if (['watch', '대시보드'].includes(target)) assert.match(error.message, new RegExp(`kadan restart ${target}`));
      else assert.match(error.message, /역할 세션이 재시작할 수 없습니다/);
      return true;
    }, target);
  }
  for (const target of ['watch', '대시보드'])
    assert.throws(() => autopilotGuard({...base, command: 'restart', args: [target], flags: {force: true}}), error => error.exitCode === 2 && /restart --force/.test(error.message));
});

test('2 재시작 성공: 멈춤 표시·되살리기 횟수 불변, revive 사건에 reason restart와 부른 쪽', async () => {
  const w = world();
  for (const target of ['watch', '대시보드']) {
    const r = await w.run(target, 'a-감독');
    assert.equal(r.ok, true, r.message);
    assert.equal(r.result, 'started');
  }
  const state = readReviveState(w.home);
  assert.deepEqual(state.targets, {});
  assert.deepEqual(state.history, {}, '되살리기 횟수는 그대로');
  assert.equal(state.restarts.watch.length, 1);
  const revives = readLedger(w.home).filter(e => e.kind === 'revive');
  assert.deepEqual(revives.map(e => [e.target, e.reason, e.result, e.by]), [['watch', 'restart', 'started', 'a-감독'], ['대시보드', 'restart', 'started', 'a-감독']]);
  assert.deepEqual(w.calls.filter(c => c[0] !== 'verify').slice(0, 2), [['stop', 'watch'], ['start', 'watch']]);
  assert.equal(w.notices.length, 0);
});

test('3 시작 실패: 종료 코드 1·알림 1회·재시도 없음·표시 없음 → 다음 up --auto 되살리기 대상', async () => {
  const w = world({startThrows: '창 만들기 실패'});
  const r = await w.run('watch', 'a-감독');
  assert.equal(r.ok, false);
  assert.equal(r.code, 1);
  assert.equal(r.result, 'failed');
  assert.equal(w.calls.filter(c => c[0] === 'start').length, 1, '재시도 없음');
  assert.equal(w.notices.length, 1);
  assert.match(w.notices[0].message, /다음 자동 되살리기 주기/);
  assert.equal(w.notices[0].opts.ring, true);
  const state = readReviveState(w.home);
  assert.deepEqual(state.targets, {}, '사람이 끔 표시 없음');
  assert.deepEqual(state.history, {});
  // 끈 뒤 세션이 없는 상태에서 평소 되살리기 주기가 이 대상을 되살릴 대상으로 잡는다
  const ops = {sessionOf: t => `kadan-${t}`, exists: () => false, paneState: () => 'dead', capture: () => '', kill: () => {},
    applicable: () => true, stuck: () => null, notify: () => ({}), record: () => {}};
  const prepared = prepareRevive({home: w.home, auto: true, now: T0 + 60_000, ops});
  assert.ok(prepared.pending.has('watch'));
  assert.ok(prepared.pending.has('대시보드'));
  assert.equal(prepared.skip.has('watch'), false);
  const failed = readLedger(w.home).filter(e => e.kind === 'revive');
  assert.deepEqual(failed.map(e => [e.result, e.reason, e.by]), [['failed', 'restart', 'a-감독']]);
});

test('4 stopped·capped·corrupt: 역할 세션 재시작은 거절, 사람이 친 것은 up처럼 멈춤을 풀고 손상 파일은 .trash로', async () => {
  for (const mark of ['stopped', 'capped']) {
    const w = world();
    const state = readReviveState(w.home);
    state.targets.watch = {state: mark, at: new Date(T0).toISOString(), by: 'user'};
    writeReviveState(w.home, state);
    const r = await w.run('watch', 'a-감독');
    assert.equal(r.ok, false, mark);
    assert.equal(r.result, 'refused');
    assert.match(r.message, /kyle이 kadan up으로 푼 뒤에/);
    assert.equal(w.calls.length, 0, '끄지도 시작하지도 않음');
    assert.equal(readReviveState(w.home).targets.watch.state, mark);
    const human = await w.run('watch', null);
    assert.equal(human.ok, true, `${mark} 사람`);
    assert.equal(readReviveState(w.home).targets.watch, undefined, '사람이 친 재시작은 그 대상의 멈춤을 푼다');
  }
  const w = world();
  fs.writeFileSync(path.join(w.home, 'revive-state.json'), '{깨짐');
  const r = await w.run('대시보드', 'a-감독');
  assert.equal(r.ok, false);
  assert.match(r.message, /손상/);
  assert.equal(w.calls.length, 0);
  assert.equal(fs.readFileSync(path.join(w.home, 'revive-state.json'), 'utf8'), '{깨짐', '역할 세션은 손상 파일을 건드리지 않는다');
  const human = await w.run('대시보드', null);
  assert.equal(human.ok, true);
  assert.equal(readReviveState(w.home).corrupt, undefined);
  assert.ok(fs.readdirSync(path.join(w.home, '.trash')).some(n => n.startsWith('revive-state-')));
});

test('5 호출 환경(KADAN_ROLE·KADAN_WINDOW·TMUX·TMUX_PANE·현재 폴더)이 새 프로세스로 안 넘어간다', () => {
  const env = {KADAN_ROLE: 'a-감독', KADAN_WINDOW: 'rottie', TMUX: '/tmp/x,1,0', TMUX_PANE: '%3', KADAN_PANE_SOCKET: 'kadan',
    KADAN_RESTART_REASON: '이유', KADAN_RESTART_EXPECT_PID: '123', KADAN_HOME: '/h', PATH: '/bin'};
  const chdirs = [];
  const workdir = normalizeForRevive({env, chdir: dir => chdirs.push(dir), workdir: '/code/root'});
  assert.equal(workdir, '/code/root');
  assert.deepEqual(chdirs, ['/code/root']);
  for (const name of ['KADAN_ROLE', 'TMUX', 'TMUX_PANE', 'KADAN_PANE_SOCKET', 'KADAN_RESTART_REASON', 'KADAN_RESTART_EXPECT_PID']) assert.equal(name in env, false, name);
  assert.equal(env.KADAN_WINDOW, 'none');
  assert.equal(env.KADAN_WINDOW_FORCE, '1');
  assert.equal(env.KADAN_HOME, '/h', '홈·PATH는 그대로');
});

test('6 재시작 중에는 up --auto와 같은 잠금을 쥔다: 겹친 자동 주기는 건너뛰고 끝나면 잠금이 풀린다', async () => {
  const w = world();
  let during = 'unset';
  w.deps.start = (t) => { const rel = acquireReviveLock(w.home, {waitMs: 0}); during = rel; if (rel) rel(); return 'started'; };
  const r = await w.run('watch', null);
  assert.equal(r.ok, true);
  assert.equal(during, null, '재시작 도중 자동 주기는 잠금을 못 잡는다');
  const after = acquireReviveLock(w.home, {waitMs: 0});
  assert.equal(typeof after, 'function', '끝나면 풀린다');
  after();
});

test('7 역할 세션 1시간 3번 상한: 실패도 세고, 4번째는 거절, 사람이 친 것은 세지 않고, 1시간 뒤 다시 센다', async () => {
  const w = world();
  for (let i = 0; i < ROLE_RESTART_CAP; i++) assert.equal((await w.run('대시보드', 'a-감독')).ok, true);
  const fourth = await w.run('대시보드', 'a-감독');
  assert.equal(fourth.ok, false);
  assert.equal(fourth.result, 'refused');
  assert.match(fourth.message, /1시간에 3번까지/);
  assert.equal((await w.run('watch', 'a-감독')).ok, true, '대상마다 따로 센다');
  assert.equal((await w.run('대시보드', null)).ok, true, '사람은 세지 않는다');
  assert.equal(readReviveState(w.home).restarts['대시보드'].length, ROLE_RESTART_CAP);
  assert.deepEqual(readReviveState(w.home).history, {});
  const later = await w.run('대시보드', 'a-감독', {now: () => T0 + 61 * 60_000});
  assert.equal(later.ok, true);
});

test('8 생존 확인 시간 초과 → 모름(unverified): 종료 코드 1·알림 1회·재시도 없음', async () => {
  const w = world({alive: false});
  const r = await w.run('대시보드', null);
  assert.equal(r.ok, false);
  assert.equal(r.code, 1);
  assert.equal(r.result, 'unverified');
  assert.match(r.message, /확인 시간 초과\(모름\)/);
  assert.equal(w.calls.filter(c => c[0] === 'start').length, 1);
  assert.equal(w.notices.length, 1);
  assert.deepEqual(readLedger(w.home).filter(e => e.kind === 'revive').map(e => [e.result, e.reason, e.by]), [['unverified', 'restart', '사람']]);
});

test('9 사람이 친 재시작과 세션이 없던 경우: 표시 없이 그대로 동작하고, 이미 남은 프로세스(reused)는 성공으로 치지 않는다', async () => {
  const w = world();
  assert.equal((await w.run('watch', null)).ok, true);
  assert.deepEqual(readReviveState(w.home).restarts, {}, '사람은 상한에 세지 않는다');
  const stray = world({startResult: 'reused'});
  const r = await stray.run('watch', 'a-감독');
  assert.equal(r.ok, false);
  assert.equal(r.result, 'failed');
  assert.equal(stray.notices.length, 1);
  const bad = await world().run('디코', 'a-감독');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 2, '디코 다리·비서는 이 명령의 대상이 아니다');
});

test('10 시작 명령이 die()로 프로세스를 끝내려 해도 오류로 받아 끈 뒤 실패를 알리고 기록한다', async () => {
  const fake = {exit: () => { throw new Error('진짜 종료됨'); }};
  const real = fake.exit;
  assert.throws(() => callWithoutExit(() => fake.exit(1), fake), /종료 코드 1로 끝남/);
  assert.equal(fake.exit, real, '끝나면 원래 exit로 되돌린다');
  const w = world();
  w.deps.start = () => callWithoutExit(() => fake.exit(1), fake);
  const r = await w.run('대시보드', 'a-감독');
  assert.equal(r.result, 'failed');
  assert.equal(w.notices.length, 1);
  assert.deepEqual(readLedger(w.home).filter(e => e.kind === 'revive').map(e => e.result), ['failed']);
  // 잠금은 풀렸다
  const rel = acquireReviveLock(w.home, {waitMs: 0});
  assert.equal(typeof rel, 'function');
  rel();
});

const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;

test('11 화면 버튼: 감시기·대시보드는 HTTP 처리부와 CLI 둘 다 아무것도 끄기 전에 거절한다', async () => {
  const {createWallServer} = await import('../src/wall.mjs');
  const home = newHome();
  appendLedger({kind: 'start', floor: 'tmux', role: '대시보드', session: 'kadan-대시보드', panePid: '100', cwd: home, cmd: 'node', by: 'test'}, home);
  let calls = 0;
  const server = createWallServer(() => ({center: null, entries: [], tree: [], ledgerLines: 0, collectedAt: new Date()}), {home, cacheSec: 0, restart: () => { calls++; return Promise.resolve({output: 'x'}); }});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = (await (await fetch(base)).text()).match(/name="token" value="([a-f0-9]+)"/)[1];
    for (const role of ['대시보드', 'watch']) {
      const r = await fetch(base + '/roles/restart', {method: 'POST', redirect: 'manual', headers: {'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', origin: base},
        body: new URLSearchParams({token, role, reason: '느려서', expectPid: '100'})});
      assert.equal(r.status, 409, role);
      assert.match(await r.text(), /화면에서는 감시기·대시보드를 다시 띄울 수 없습니다/);
    }
    assert.equal(calls, 0, '요청이 restart를 한 번도 실행하지 않는다');
    assert.equal((await fetch(base)).status, 200, '서버는 그대로 응답한다');
  } finally { server.close(); }
  // CLI: 화면이 넘기는 환경값이 있으면 floor를 보기 전에 거절한다(끄지 않는다)
  for (const target of ['watch', '대시보드']) {
    const r = spawnSync(process.execPath, [CLI, 'restart', target], {env: {...process.env, KADAN_HOME: home, KADAN_RESTART_REASON: '이유', KADAN_RESTART_EXPECT_PID: '1', KADAN_RESTART_SCREEN_PID: String(process.pid), KADAN_ROLE: ''}, encoding: 'utf8', timeout: 30000});
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /화면에서는 감시기·대시보드를 다시 띄울 수 없습니다/);
  }
});

test('12 자기 세션 안에서 부른 재시작은 끄기 전에 거절하고, 판정 못 하면 거절하지 않는다', async () => {
  const chain = new Map([[500, 400], [400, 300], [300, 1]]);
  assert.equal(insideSession('대시보드', {pidOf: () => 400, alive: () => true, parentOf: pid => chain.get(pid), self: 500}), true);
  assert.equal(insideSession('대시보드', {pidOf: () => 999, alive: () => true, parentOf: pid => chain.get(pid), self: 500}), false);
  assert.equal(insideSession('대시보드', {pidOf: () => 400, alive: () => false, parentOf: pid => chain.get(pid), self: 500}), false);
  assert.equal(insideSession('대시보드', {pidOf: () => 400, alive: () => true, parentOf: () => NaN, self: 500}), null);
  const w = world();
  w.deps.insideTarget = () => true;
  const r = await w.run('대시보드', 'a-감독');
  assert.equal(r.ok, false);
  assert.equal(r.result, 'refused');
  assert.match(r.message, /세션 안에서 부른 명령/);
  assert.equal(w.calls.length, 0, '끄지 않았다');
  w.deps.insideTarget = () => null;
  assert.equal((await w.run('대시보드', 'a-감독')).ok, true, '판정 불가는 거절하지 않는다');
});

test('13 새 기반 세션 환경은 자식 쪽에서 고정된다: 서버 전역 환경에 이전 역할·창 값이 남아도 새 프로세스에는 안 들어간다', (t) => {
  if (spawnSync('tmux', ['-V']).status !== 0) return t.skip('tmux 없음');
  const socket = `kadan-env-${process.pid}`, out = path.join(newHome(), 'env.txt');
  const tmux = (...a) => spawnSync('tmux', ['-u', '-L', socket, ...a], {encoding: 'utf8', env: {...process.env, TMUX: '', TMUX_PANE: ''}});
  try {
    tmux('new-session', '-d', '-s', 'seed', 'sleep 30');
    tmux('set-environment', '-g', 'KADAN_ROLE', 'qa-old-caller');
    tmux('set-environment', '-g', 'KADAN_WINDOW', 'rottie');
    const cmd = wrapInfraEnv(`printf '%s|%s|%s' "$KADAN_ROLE" "$KADAN_WINDOW" "$KADAN_WINDOW_FORCE" > '${out}'`);
    const bare = path.join(path.dirname(out), 'bare.txt');
    tmux('new-session', '-d', '-s', 'bare', `printf '%s|%s' "$KADAN_ROLE" "$KADAN_WINDOW" > '${bare}'`);   // 수정 전 모양: 서버 환경이 그대로 들어간다
    tmux('new-session', '-d', '-s', 'clean', cmd);
    for (let i = 0; i < 40 && !(fs.existsSync(out) && fs.existsSync(bare)); i++) spawnSync('sleep', ['0.1']);
    assert.equal(fs.readFileSync(bare, 'utf8'), 'qa-old-caller|rottie', '대조: 고정하지 않으면 이전 값이 들어간다');
    assert.equal(fs.readFileSync(out, 'utf8'), '|none|1');
  } finally { spawnSync('tmux', ['-u', '-L', socket, 'kill-server']); }
});

test('14 성공 직후 죽는 감시기: 안정 구간 뒤 표식이 바뀌거나 사라지면 모름(unverified)으로 끝낸다', async () => {
  const w = world();
  let n = 0;
  w.deps.verify = async () => (++n === 1 ? 'pid-1' : null);   // 첫 확인은 살아 있고, 안정 구간 뒤에는 죽음
  const dead = await w.run('watch', 'a-감독');
  assert.equal(dead.ok, false);
  assert.equal(dead.result, 'unverified');
  assert.equal(w.notices.length, 1);
  const w2 = world();
  let k = 0;
  w2.deps.verify = async () => (++k === 1 ? 'pid-1' : 'pid-2');   // 다른 프로세스로 바뀜
  assert.equal((await w2.run('watch', null)).result, 'unverified');
  const w3 = world();
  w3.deps.verify = async () => 'pid-1';
  assert.equal((await w3.run('watch', null)).ok, true);
});

test('15 Autopilot 요약의 재시작 수: 감시기 revive(reason restart 성공)와 AI 역할 restart를 세고 대시보드는 한 번만 센다', () => {
  const start = {kind: 'autopilot', phase: 'on', t: new Date(T0).toISOString(), by: '사람', text: 't', to: [], delivered: []};
  const at = ms => new Date(T0 + ms).toISOString();
  const entries = [
    {kind: 'revive', target: 'watch', reason: 'restart', result: 'started', by: 'a-감독', t: at(1000)},
    {kind: 'revive', target: 'watch', reason: 'restart', result: 'failed', by: 'a-감독', t: at(2000)},
    {kind: 'stop', role: '대시보드', restart: true, reason: 'infra-restart', t: at(3000)},
    {kind: 'revive', target: '대시보드', reason: 'restart', result: 'started', by: 'a-감독', t: at(3500)},
    {kind: 'stop', role: 'w', restart: true, t: at(4000)},
  ];
  const s = summarizeAutopilot({start, phase: 'off', endedAt: T0 + 10_000, entries, decisionEvents: [], readBody: () => null});
  assert.equal(s.counts.restarts, 3);
});

test('16 재시작·자동 되살리기의 대시보드 세션만 자식 쪽 환경을 고정하고, 사람 up·다른 역할은 그대로다', async () => {
  const {buildTmuxCreateArgv, setCleanInfraDashboard} = await import('../src/floor-tmux.mjs');
  const cmdOf = argv => argv.at(-1);
  try {
    setCleanInfraDashboard(false);
    assert.doesNotMatch(cmdOf(buildTmuxCreateArgv({session: 'kadan-대시보드', role: '대시보드', cwd: '/x', cmd: 'node cli dashboard', home: '/h'})), /KADAN_WINDOW=none/, '사람이 친 up은 그대로');
    setCleanInfraDashboard(true);
    const dash = cmdOf(buildTmuxCreateArgv({session: 'kadan-대시보드', role: '대시보드', cwd: '/x', cmd: 'node cli dashboard', home: '/h'}));
    assert.match(dash, /unset TMUX TMUX_PANE KADAN_RESTART_REASON KADAN_RESTART_EXPECT_PID KADAN_RESTART_SCREEN_PID; export KADAN_WINDOW=none KADAN_WINDOW_FORCE=1; node cli dashboard/);
    assert.doesNotMatch(dash, /KADAN_ROLE /, '대시보드 자기 역할 값(-e)은 지우지 않는다');
    const other = buildTmuxCreateArgv({session: 'kadan-w', role: 'w', cwd: '/x', cmd: 'claude', home: '/h'});
    assert.doesNotMatch(cmdOf(other), /KADAN_WINDOW=none/, '다른 역할은 그대로');
    assert.ok(buildTmuxCreateArgv({session: 'kadan-대시보드', role: '대시보드', cwd: '/x', cmd: 'c', home: '/h'}).includes('KADAN_ROLE=대시보드'));
  } finally { setCleanInfraDashboard(false); }
});

test('17 화면 요청 판정은 그 호출 하나의 표식(부모 pid)이 맞을 때만: 세션에 남은 옛 KADAN_RESTART_* 값에는 속지 않는다', () => {
  const home = newHome();
  const run = extra => spawnSync(process.execPath, [CLI, 'restart', 'watch', '--bogus'], {env: {...process.env, KADAN_HOME: home, KADAN_ROLE: '', KADAN_RESTART_REASON: '옛 이유', KADAN_RESTART_EXPECT_PID: '777', ...extra}, encoding: 'utf8', timeout: 30000});
  const stale = run({KADAN_RESTART_SCREEN_PID: '1'});          // 옛 표식: 내 부모 pid와 다르다
  assert.doesNotMatch(stale.stderr, /화면에서는 감시기·대시보드를 다시 띄울 수 없습니다/);
  const screen = run({KADAN_RESTART_SCREEN_PID: String(process.pid)});   // 이 호출의 부모(이 시험 프로세스)가 붙인 표식
  assert.equal(screen.status, 2);
  assert.match(screen.stderr, /화면에서는 감시기·대시보드를 다시 띄울 수 없습니다/);
});
