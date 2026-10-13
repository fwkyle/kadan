import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {runWatch} from '../src/watch-runner.mjs';
import {guardedSend} from '../src/cli-guarded-send.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {sendWatchMailReminder, sendWatchMessage, watchMailHold} from '../src/commands/watch.mjs';
import {NotifyHoldTracker, NOTIFY_FORCE_AT, NOTIFY_WARN_AT, notifyHeldAlertId} from '../src/watch-notify-hold.mjs';
import {explainAlertRoute} from '../src/watch.mjs';

const hold = (code = 'KADAN_PANE_INPUT_PENDING') =>
  Object.assign(new Error('알림 미룸: 미제출 입력이 있음'), {code, delivery: 'not-sent'});
const cycle = (tracker, {held = [], sent = [], now = 0} = {}) => {
  tracker.beginCycle();
  for (const role of held) tracker.held(role, hold());
  for (const role of sent) tracker.delivered(role);
  tracker.endCycle(now);
};

test('3번 연속 밀려야 경보가 열리고, 한 주기의 여러 미룸은 1로 센다', () => {
  const tracker = new NotifyHoldTracker();
  cycle(tracker, {held: ['w', 'w']}); // 우편 재알림과 감시 경보가 같은 주기에 함께 밀림
  cycle(tracker, {held: ['w']});
  assert.deepEqual(tracker.alerts(), []);
  cycle(tracker, {held: ['w', 'w', 'w']});
  const [alert] = tracker.alerts();
  assert.equal(NOTIFY_WARN_AT, 3);
  assert.deepEqual([alert.id, alert.kind, alert.role, alert.holdCount, alert.holdCode],
    [notifyHeldAlertId('w'), '알림밀림', 'w', 3, 'KADAN_PANE_INPUT_PENDING']);
  assert.equal(tracker.forced('w'), false);
});

test('전달 성공이나 보낼 것 없음은 0으로 되돌리고, 같은 주기의 성공은 밀림보다 앞선다', () => {
  for (const reset of [{sent: ['w']}, {}, {held: ['w'], sent: ['w']}]) {
    const tracker = new NotifyHoldTracker();
    for (let i = 0; i < 4; i++) cycle(tracker, {held: ['w']});
    assert.equal(tracker.alerts().length, 1);
    cycle(tracker, reset);
    assert.deepEqual(tracker.alerts(), []);
    cycle(tracker, {held: ['w']});
    assert.deepEqual(tracker.alerts(), []); // 다시 1부터
  }
});

test('연속 횟수는 창마다 따로 센다', () => {
  const tracker = new NotifyHoldTracker();
  for (let i = 0; i < 3; i++) cycle(tracker, {held: ['a', ...(i === 2 ? ['b'] : [])]});
  assert.deepEqual(tracker.alerts().map(a => a.role), ['a']);
});

test('입력 보호가 아닌 오류는 밀림으로 세지 않는다', () => {
  const tracker = new NotifyHoldTracker();
  tracker.beginCycle();
  tracker.heldIfGuard('w', Object.assign(new Error('없음'), {code: 'KADAN_SESSION_MISSING', delivery: 'not-sent'}));
  tracker.endCycle(0);
  assert.deepEqual([tracker.forced('w'), tracker.alerts()], [false, []]);
});

test('알림밀림 경보는 밀리는 그 창이 아니라 사용자에게만 간다', () => {
  const alert = new NotifyHoldTracker();
  for (let i = 0; i < 3; i++) cycle(alert, {held: ['w']});
  const parents = new Map([['w', 'boss'], ['boss', '@user']]);
  const route = explainAlertRoute(alert.alerts()[0], new Map([['w', 'boss']]), ['kadan-w', 'kadan-boss'], 'boss', parents);
  assert.deepEqual([route.recipient, route.basis], ['@user', 'notify-held']);
});

// 감시기가 쓰는 실제 전송 함수에 가짜 바닥을 붙여 3·5번 경계를 끝까지 돌린다.
const at = n => new Date(n).toISOString();
async function watchRun({cycles, holdUntil = Infinity, floorAlive = true}) {
  const entries = [{kind: 'start', role: 'worker', session: 'kadan-worker', panePid: 1, t: at(0)},
    {kind: 'send', mailId: 'q', role: 'worker', by: 'boss', t: at(0), expectReply: true}];
  const records = [], pastes = [], osNotices = [];
  const tracker = new NotifyHoldTracker({record: e => records.push(e)});
  let n = 0;
  const floor = {name: 'fake', list: () => [{session: 'kadan-worker', alive: true, pid: 1}], read: () => '›',
    alive: () => floorAlive, pid: () => '1',
    notificationHold: () => n < holdUntil ? {code: 'KADAN_PANE_INPUT_PENDING', message: '알림 미룸: 미제출 입력이 있음'} : null,
    send: (session, text, options) => {
      if (options.notificationGuard && n < holdUntil) throw hold();
      pastes.push({n, guard: options.notificationGuard});
      return {};
    }};
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-notify-hold-'));
  const send = options => guardedSend({...options, env: {KADAN_HOME: home}, readEntries: () => entries,
    saveBody: () => {}, record: () => {}});
  const controller = new AbortController();
  await runWatch({floor, readEntries: () => [...entries, ...records], readCards: () => [], readWorks: () => [],
    holdTracker: tracker, record: e => records.push(e), mailUnreadGraceMs: 300_000, sendAlert: () => {},
    sendMailReminder: (role, message, pid) => sendWatchMailReminder(role, message, pid,
      {selectedFloor: floor, readStart: () => ({panePid: 1}), send, tracker}),
    mailHold: role => watchMailHold(role, {selectedFloor: floor, tracker}),
    intervalMs: 1000, stallN: 100, routes: new Map(), now: () => 300_000 + n * 1000,
    spawn: (command, args) => {
      if (command === 'osascript') osNotices.push(args.join(' '));
      return {status: 0, stdout: String(process.pid)};
    },
    signal: controller.signal, print: () => {}, sleep: async () => { if (++n >= cycles) controller.abort(); }});
  return {records, pastes, osNotices};
}

test('미룸 3번 → 사용자에게 알림 한 번(4·5번째는 다시 내지 않음), 6번째에 입력 보호 없이 전달하고 경보가 풀린다', async () => {
  const {records, pastes, osNotices} = await watchRun({cycles: 9});
  const alerts = records.filter(e => e.kind === 'alert' && e.alertKind === '알림밀림');
  const opened = alerts.filter(e => !e.resolved);
  assert.equal(opened.length, 1, JSON.stringify(alerts));
  assert.deepEqual([opened[0].recipient, opened[0].delivered, opened[0].holdCount, opened[0].holdCode, opened[0].role],
    ['@user', true, NOTIFY_WARN_AT, 'KADAN_PANE_INPUT_PENDING', 'worker']);
  assert.ok(opened[0].heldSince);
  assert.equal(osNotices.length, 1);
  assert.match(osNotices[0], /worker 창에 3번 연속 밀림/);
  assert.equal(pastes.length, 1);
  assert.equal(pastes[0].guard, undefined, '5번 밀린 뒤에는 입력 보호만 뺀다');
  assert.ok(pastes[0].n >= NOTIFY_FORCE_AT);
  const forced = records.filter(e => e.kind === 'watch-notify-forced');
  assert.deepEqual([forced.length, forced[0].role, forced[0].count, forced[0].code],
    [1, 'worker', NOTIFY_FORCE_AT, 'KADAN_PANE_INPUT_PENDING']);
  assert.equal(alerts.filter(e => e.resolved).length, 1, '전달 뒤 경보가 열린 목록에서 빠진다');
});

test('2번만 밀리고 풀리면 경보도 강제 전달도 없다', async () => {
  const {records, pastes, osNotices} = await watchRun({cycles: 6, holdUntil: 2});
  assert.equal(records.some(e => e.alertKind === '알림밀림' || e.kind === 'watch-notify-forced'), false);
  assert.equal(osNotices.length, 0);
  assert.equal(pastes.length, 1);
  assert.notEqual(pastes[0].guard, undefined);
});

test('강제 전달도 세션이 없으면 넣지 않는다 — 생존·PID 확인은 그대로', () => {
  const tracker = new NotifyHoldTracker();
  for (let i = 0; i < NOTIFY_FORCE_AT; i++) cycle(tracker, {held: ['worker']});
  assert.equal(tracker.forced('worker'), true);
  const pastes = [];
  const floor = {name: 'fake', alive: () => false, pid: () => '1', send: () => pastes.push(1)};
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-notify-force-'));
  const send = options => guardedSend({...options, env: {KADAN_HOME: home}, readEntries: () => [],
    saveBody: () => {}, record: () => {}});
  assert.throws(() => sendWatchMessage('worker', '경보', {selectedFloor: floor, readStart: () => ({panePid: 1}), send, tracker}),
    e => e.code === 'KADAN_SESSION_MISSING');
  const pidFloor = {...floor, alive: () => true, pid: () => '2'};
  assert.throws(() => sendWatchMessage('worker', '경보', {selectedFloor: pidFloor, readStart: () => ({panePid: 1}), send, tracker}),
    e => e.code === 'KADAN_PID_MISMATCH');
  assert.deepEqual(pastes, []);
});

// 슈퍼 간 우편: 실제 CLI와 격리 tmux 소켓. 창은 입력줄(› )을 그리는 무해한 수신 스크립트다.
const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
const hasTmux = spawnSync('tmux', ['-V']).status === 0;
test('슈퍼 간 우편: 입력 보호 통과면 바로 들어가고, 걸리면 보관하고, 세션이 없어도 보관한다', {skip: !hasTmux}, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-peer-guard-'));
  const socket = `peer-guard-${process.pid}-${Date.now()}`;
  const table = {'p-super': '@user', 'q-super': '@user', 'z-super': '@user'};
  const file = path.join(home, 'hierarchy.json');
  fs.writeFileSync(file, JSON.stringify(table));
  appendLedger({kind: 'hierarchy-loaded', path: file}, home);
  const env = {...process.env, KADAN_HOME: home, KADAN_SOCKET: socket, KADAN_FLOOR: 'tmux', KADAN_WINDOW: 'none', KADAN_NOTIFY: 'off'};
  const run = (bin, args) => spawnSync(bin, args, {env, encoding: 'utf8', timeout: 10000, input: ''});
  const call = (by, ...args) => spawnSync(process.execPath, [cli, ...args],
    {env: {...env, KADAN_ROLE: by}, encoding: 'utf8', timeout: 10000, input: ''});
  const received = path.join(home, 'received');
  const receiver = path.join(home, 'receiver.mjs');
  fs.writeFileSync(receiver, `import fs from 'node:fs';import readline from 'node:readline';
process.stdout.write('\\n\\n› ');
readline.createInterface({input:process.stdin}).on('line',l=>{fs.appendFileSync(${JSON.stringify(received)},l+'\\n');process.stdout.write('› ');});`);
  const tmuxCmd = args => run('tmux', ['-L', socket, ...args]);
  const target = '=kadan-q-super:';
  const contents = () => fs.existsSync(received) ? fs.readFileSync(received, 'utf8') : '';
  const waitFor = pred => { const end = Date.now() + 4000; while (Date.now() < end && !pred()) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); };
  let started = false;
  try {
    const start = call('q-super', 'start', 'q-super', '--cmd', `'${process.execPath}' '${receiver}'`);
    assert.equal(start.status, 0, start.stderr);
    started = true;
    waitFor(() => /›/.test(tmuxCmd(['capture-pane', '-p', '-t', target]).stdout));
    // 통과 → 바로 들어감
    const passed = call('p-super', 'mail', 'q-super', 'PEER_PASS');
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(passed.stdout, /전달됨|키 전송됨/);
    waitFor(() => contents().includes('PEER_PASS'));
    assert.match(contents(), /PEER_PASS/);
    const sends = () => readLedger(home).filter(e => e.kind === 'send');
    assert.equal(sends().length, 1);
    assert.notEqual(sends()[0].transport, 'mailbox', '바로 들어간 편지는 보관 우편이 아니라 감시기가 따로 알리지 않는다');
    // 걸림 → 보관, 창은 그대로
    tmuxCmd(['send-keys', '-t', target, '-l', 'USER_PENDING_']);
    const before = contents();
    const held = call('p-super', 'mail', 'q-super', 'PEER_HELD');
    assert.equal(held.status, 0, held.stderr);
    assert.equal(JSON.parse(held.stdout).wake, 'watch-required');
    assert.equal(contents(), before);
    assert.equal(sends().at(-1).transport, 'mailbox');
    // 세션 없음(시작 기록도 없는 슈퍼) → 보관
    const none = call('p-super', 'mail', 'z-super', 'PEER_NOSESSION');
    assert.equal(none.status, 0, none.stderr);
    assert.equal(JSON.parse(none.stdout).wake, 'watch-required');
    // --raw는 여전히 거절
    assert.equal(call('p-super', 'mail', 'q-super', '--raw', 'x').status, 1);
  } finally {
    if (started) call('q-super', 'stop', 'q-super');
  }
});
