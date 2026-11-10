import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {ledgerHome, appendLedger, readLedger} from '../src/ledger.mjs';
import {stopRole} from '../src/role-stop.mjs';
import {stopConversationFields, budgetedRun, launchStart, lookupDeps, MISSING_REASONS} from '../src/role-conversation.mjs';
import {paneInfo} from '../src/commands/restart.mjs';
import {processTree} from '../src/process-tree.mjs';
import {startDigest} from '../src/secretary-resume.mjs';
import {Handover} from '../src/handover.mjs';
import {settingsWith} from './helpers/runner-table.mjs';

// 가짜 바닥·가짜 프로세스 조회로 "끌 때 대화 번호 남기기"를 시험한다. 실제 tmux·ps·lsof 왕복은 stop-reopen-tmux.test.mjs.
const ID = '0197aaaa-1111-4222-8333-444455556666', OTHER = '0197bbbb-1111-4222-8333-444455556666';
const CLAUDE = 'claude --model claude-haiku-5-5 --effort low --dangerously-skip-permissions';
const CODEX = 'codex -p lite --model gpt-6-sol -c model_reasoning_effort="low"';
const rollout = id => `/h/.codex/sessions/2026/11/10/rollout-2026-11-10T01-02-03-${id}.jsonl`;
const lock = id => `/h/.codex/thread-writer-locks/${id}.lock`;
let seq = 0;

// 역할 하나의 시작 기록과, 그 pane 아래 프로세스·열린 파일을 흉내 낸다.
function fixture({cmd = CODEX, role = `w${++seq}`, held = {150: [rollout(ID), lock(ID)]}, extraTree = [], profile = 'worker'} = {}) {
  const home = ledgerHome(), session = `kadan-${role}`;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-stop-cwd-'));
  appendLedger({kind: 'start', floor: 'tmux', role, session, cmd, cwd, panePid: '100', roleProfile: profile, by: 'boss'}, home);
  const calls = [], lines = {out: [], err: []};
  let alive = true;
  const floor = {name: 'tmux', alive: () => alive, pid: () => '100', stop: s => { calls.push(['stop', s]); alive = false; }};
  const deps = {
    paneInfo: () => { calls.push(['paneInfo']); return {panePid: '100', location: `${session}:@1.%1`}; },
    processTree: () => { calls.push(['processTree']); return [{pid: '100', ppid: '1', args: '-zsh'}, {pid: '150', ppid: '100', args: cmd}, ...extraTree]; },
    openFiles: pids => { calls.push(['openFiles']); return pids.flatMap(pid => held[pid] ?? []); },
    processStartedAt: () => 1000, readJson: file => JSON.parse(fs.readFileSync(file, 'utf8')),
  };
  const lookup = input => stopConversationFields({...input, readSettings: () => settingsWith(), deps});
  const run = (extra = {}) => stopRole({role, session, home, floor, lookup, log: line => lines.out.push(line), warn: line => lines.err.push(line), ...extra});
  const stops = () => readLedger(home).filter(e => e.session === session && e.kind === 'stop');
  const start = () => readLedger(home).find(e => e.session === session && e.kind === 'start');
  return {home, role, session, calls, lines, floor, deps, run, stops, start, cwd};
}

test('stop은 끄기 앞에서 대화 번호를 찾아 stop 사건에 세대 지문과 함께 남긴다', () => {
  const f = fixture();
  const result = f.run();
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls.map(c => c[0]), ['paneInfo', 'processTree', 'openFiles', 'stop'], '조회가 끄기보다 앞이다');
  const [stop] = f.stops();
  assert.equal(stop.conversation, ID);
  assert.equal(stop.conversationStart, startDigest(f.start()));
  assert.equal(stop.conversationMissing, undefined);
  assert.deepEqual(f.lines.out, [`종료됨: ${f.session}`]);
});

test('프로세스 조회가 던져도 끄고 "못 찾음 + 이유 낱말"을 남긴다', () => {
  const f = fixture();
  f.deps.processTree = () => { throw new Error('프로세스 조회 실패'); };
  assert.equal(f.run().ok, true);
  assert.deepEqual(f.calls.at(-1), ['stop', f.session]);
  const [stop] = f.stops();
  assert.equal(stop.conversation, undefined);
  assert.equal(stop.conversationMissing, 'lookup-failed');
  assert.equal(stop.conversationStart, startDigest(f.start()), '어느 세대였는지는 남는다');
});

test('조회가 시간 상한을 넘으면 "timeout"으로 적고 끈다 — 실제 조회 함수에 남은 시간만 넘긴다', () => {
  const f = fixture();
  let clock = 0;
  const seen = [];
  // 첫 ps가 상한(3초)을 다 쓰고 시간 초과로 끝난 것처럼 흉내 낸다.
  const budget = budgetedRun(3000, {now: () => clock, run: (command, args, options) => {
    seen.push([command, options.timeout]); clock += 3000; return {status: null, error: {code: 'ETIMEDOUT'}}; }});
  f.deps.budget = budget;
  f.deps.processTree = pid => processTree(pid, budget.run);
  assert.equal(f.run().ok, true);
  assert.deepEqual(seen, [['ps', 2000]], 'ps는 자기 상한(2초)과 남은 시간 중 작은 값으로 한 번만 돈다');
  assert.equal(f.stops()[0].conversationMissing, 'timeout');
  // 상한이 이미 지났으면 프로세스를 띄우지도 않는다.
  assert.throws(() => budget.run('lsof', []), error => error.reason === 'timeout');
  assert.equal(seen.length, 1);
});

// 검수 F3: 끌 때 조회의 첫 단계인 tmux 호출(pane 확인)에도 남은 예산이 timeout으로 넘어가야 한다.
// 실제 조회 묶음(lookupDeps + paneInfo)을 쓰고, 프로세스 실행만 가짜로 바꿔 고정 지연을 넣는다(실제 부하·실제 tmux 없음).
test('tmux 조회가 늦어도 예산 안에서 포기하고 끈다 — tmux 호출에 남은 예산이 timeout으로 넘어간다', () => {
  const original = cp.spawnSync;
  const calls = [];
  let delayMs = 0;
  // 실제 spawnSync처럼 timeout이 있으면 그 시간까지만 기다리고 ETIMEDOUT으로 끝낸다. 없으면 지연을 다 기다린다.
  cp.spawnSync = (executable, args, options = {}) => {
    calls.push({executable, timeout: options.timeout ?? null});
    if (executable === 'tmux' && args.includes('list-panes')) {
      const limit = options.timeout ?? Infinity;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(delayMs, limit));
      return delayMs > limit ? {status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawnSync tmux ETIMEDOUT'), {code: 'ETIMEDOUT'})}
        : {status: 0, stdout: '100\tkadan-x:@1.%1\n', stderr: ''};
    }
    if (executable === 'ps') return {status: 0, stdout: '', stderr: ''};
    throw new Error(`예상 밖 프로세스: ${executable}`);
  };
  syncBuiltinESMExports();
  try {
    const BUDGET = 300;
    for (const injected of [0, 1500]) {
      delayMs = injected; calls.length = 0;
      const f = fixture({cmd: CLAUDE});
      const began = performance.now();
      const result = f.run({lookup: input => stopConversationFields({...input, readSettings: () => settingsWith(),
        deps: lookupDeps({paneInfo, budgetMs: BUDGET})})});
      const elapsed = performance.now() - began;
      assert.equal(result.ok, true);
      assert.deepEqual(f.calls.at(-1), ['stop', f.session], '조회가 늦어도 끈다');
      const tmuxCall = calls.find(call => call.executable === 'tmux');
      assert.ok(tmuxCall, 'pane 확인은 실제 tmux 호출 경로를 지난다');
      assert.ok(Number.isFinite(tmuxCall.timeout) && tmuxCall.timeout > 0 && tmuxCall.timeout <= BUDGET,
        `tmux 호출의 timeout은 남은 예산이어야 한다(받은 값 ${tmuxCall.timeout})`);
      if (injected) {
        assert.equal(f.stops()[0].conversationMissing, 'timeout');
        assert.ok(elapsed < injected, `예산(${BUDGET}ms) 근처에서 포기해야 한다 — 걸린 시간 ${Math.round(elapsed)}ms, 주입한 지연 ${injected}ms`);
        assert.equal(calls.some(call => call.executable === 'ps'), false, '예산이 끝난 뒤에는 다음 조회를 띄우지 않는다');
      }
    }
  } finally {
    cp.spawnSync = original;
    syncBuiltinESMExports();
  }
});

test('조회 함수 자체가 던져도(예상 밖 오류) 끄기는 진행한다', () => {
  const f = fixture();
  const result = f.run({lookup: () => { throw new Error('boom'); }});
  assert.equal(result.ok, true);
  assert.equal(f.stops()[0].conversationMissing, 'error');
  assert.deepEqual(f.calls, [['stop', f.session]]);
});

test('남의 대화를 적지 않는다: 하위 에이전트·도구가 연 대화, 서로 다른 흔적, 본체가 둘인 경우', () => {
  // 본체(150)는 A의 lock만, 자식 도구(170)가 B 대화 파일을 열었다 → 본체가 연 대화 파일이 없어 확정하지 않는다.
  const child = fixture({held: {150: [lock(ID)], 170: [rollout(OTHER)]}, extraTree: [{pid: '170', ppid: '150', args: 'node tool.js'}]});
  child.run();
  assert.equal(child.stops()[0].conversationMissing, 'undetermined');
  assert.equal(child.stops()[0].conversation, undefined);
  // 본체 사슬이 A 대화 파일과 B lock을 함께 열었다 → 하나로 정할 수 없다.
  const mixed = fixture({held: {150: [rollout(ID), lock(OTHER)]}});
  mixed.run();
  assert.equal(mixed.stops()[0].conversationMissing, 'undetermined');
  // 같은 실행기·모델 프로세스가 pane 아래 나란히 둘(뿌리 2개) → 주인을 모른다.
  const twin = fixture({extraTree: [{pid: '160', ppid: '100', args: CODEX}]});
  twin.run();
  assert.equal(twin.stops()[0].conversationMissing, 'no-executor');
  for (const f of [child, mixed, twin]) assert.deepEqual(f.calls.at(-1), ['stop', f.session], '못 찾아도 끈다');
});

test('실행기가 아닌 명령·conversation 칸 없는 실행기·tmux가 아닌 바닥은 정해진 낱말로 남는다', () => {
  const shell = fixture({cmd: 'sh'});
  shell.run();
  assert.equal(shell.stops()[0].conversationMissing, 'not-ai-runner');
  assert.deepEqual(shell.calls, [['stop', shell.session]], '조회할 것이 없으면 프로세스를 보지 않는다');
  const devin = fixture({cmd: 'devin --model d1 --permission-mode dangerous'});
  devin.run();
  assert.equal(devin.stops()[0].conversationMissing, 'unsupported');
  const herdr = fixture();
  herdr.floor.name = 'herdr';
  herdr.run();
  assert.equal(herdr.stops()[0].conversationMissing, 'non-tmux');
  for (const f of [shell, devin, herdr]) assert.ok(MISSING_REASONS.includes(f.stops()[0].conversationMissing));
});

test('기반 프로세스는 조회하지 않고 그 사실이 기록에서 구분된다', () => {
  const home = ledgerHome(), role = '대시보드', session = 'kadan-대시보드';
  let alive = true, looked = 0;
  const floor = {name: 'tmux', alive: () => alive, pid: () => '900', stop: () => { alive = false; }};
  const lookup = input => stopConversationFields({...input, readSettings: () => { looked++; return settingsWith(); },
    deps: {paneInfo: () => { looked++; throw new Error('조회하면 안 된다'); }}});
  const result = stopRole({role, session, home, floor, lookup, log() {}, warn() {}});
  assert.equal(result.ok, true);
  assert.equal(looked, 0);
  const stop = readLedger(home).findLast(e => e.session === session && e.kind === 'stop');
  assert.equal(stop.conversationSkipped, 'infrastructure');
  assert.equal(stop.conversation, undefined); assert.equal(stop.conversationMissing, undefined);
});

test('살아 있는 세션을 다시 연 start(명령 없음)가 사이에 있어도 실제로 띄운 start의 세대로 적는다', () => {
  const f = fixture();
  appendLedger({kind: 'start', floor: 'tmux', role: f.role, session: f.session, cwd: '/somewhere/else', panePid: '100', by: 'boss'}, f.home);
  f.run();
  const [stop] = f.stops();
  assert.equal(stop.conversation, ID);
  assert.equal(stop.conversationStart, startDigest(f.start()), '명령이 있는 첫 start의 지문이다');
  // pane PID가 다른 start(다른 세대)나 stop을 넘어서는 거슬러 가지 않는다.
  const launched = {kind: 'start', session: 's', cmd: CODEX, panePid: '1'};
  assert.equal(launchStart([launched, {kind: 'start', session: 's', panePid: '2'}]), null);
  assert.equal(launchStart([launched, {kind: 'stop', session: 's'}, {kind: 'start', session: 's', panePid: '1'}]), null);
  assert.equal(launchStart([launched, {kind: 'start', session: 's', panePid: '1'}]), launched);
});

test('끄지 못하는 경우의 문구와 종료 코드는 예전과 같고, 끝나지 않은 카드 안내는 stdout 첫 줄이다', () => {
  const gone = fixture();
  gone.floor.alive = () => false;
  assert.deepEqual(gone.run(), {ok: false, code: 1, message: `세션 없음: ${gone.session}`});
  assert.equal(gone.stops().length, 0);
  const other = fixture();
  other.floor.pid = () => '777';
  const refused = other.run();
  assert.equal(refused.ok, false);
  assert.match(refused.message, /이름은 같은데 다른 프로세스다/);
  assert.equal(other.stops().length, 0);
  assert.equal(other.calls.some(c => c[0] === 'stop'), false);
  const pending = fixture();
  appendLedger({kind: 'send', role: pending.role, session: pending.session, taskId: 'card-x', by: 'boss'}, pending.home);
  pending.run();
  assert.equal(pending.lines.out.length, 2);
  assert.match(pending.lines.out[0], /^미확정 카드 1건: card-x — 종료하면 화면이 사라진다/);
  assert.equal(pending.lines.out[1], `종료됨: ${pending.session}`);
});

test('조회하는 사이 pane이 다른 프로세스로 바뀌면 끄기 직전 소유 재확인이 막는다', () => {
  const f = fixture();
  let pid = '100';
  f.floor.pid = () => pid;
  const result = f.run({lookup: () => { pid = '555'; return {conversation: ID}; }});
  assert.equal(result.ok, false);
  assert.equal(f.calls.some(c => c[0] === 'stop'), false);
  assert.equal(f.stops().length, 0);
});

test('인계는 선임을 끄기 직전 같은 조회를 부르고 stop 사건에 남긴다(이미 꺼져 있으면 session-gone)', () => {
  for (const alive of [true, false]) {
    const order = [], records = [];
    let up = alive;
    const handover = new Handover({home: ledgerHome(),
      floor: {alive: name => name === 'kadan-new' || up, pid: name => name === 'kadan-new' ? '200' : '100',
        stop: () => { order.push('stop'); up = false; }},
      readEntries: () => [], record: entry => records.push(entry), start() {}, send() {},
      stopFields: role => { order.push(`lookup:${role}`); return {conversation: ID, conversationStart: 'digest'}; }});
    // finish()의 'transferred' 단계만 떼어 본다: 그 단계의 끄기·기록 코드가 stopFields를 쓰는지 확인한다.
    const state = {id: '11111111-1111-4111-8111-111111111111', phase: 'transferred', from: 'old', to: 'new', oldPid: '100', newPid: '200',
      sourceEnded: !alive, taskIds: []};
    handover.lastStart = () => ({panePid: '100'});
    handover.save = () => { if (state.phase === 'stopped') throw new Error('여기까지만'); };
    handover.status = () => state;
    handover.locked = fn => fn();
    assert.throws(() => handover.finish(state.id), /여기까지만/);
    const stop = records.find(entry => entry.kind === 'stop');
    assert.equal(stop.handoverId, state.id);
    if (alive) {
      assert.deepEqual(order, ['lookup:old', 'stop']);
      assert.equal(stop.conversation, ID);
    } else {
      assert.deepEqual(order, []);
      assert.equal(stop.conversationMissing, 'session-gone');
    }
  }
});
