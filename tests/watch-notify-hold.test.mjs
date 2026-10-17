import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {runWatch} from '../src/watch-runner.mjs';
import {guardedSend} from '../src/cli-guarded-send.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {sendWatchMailReminder, sendWatchMessage, watchMailHold} from '../src/commands/watch.mjs';
import {NotifyHoldTracker, NOTIFY_FORCE_AT, NOTIFY_WARN_AT, notifyHeldAlertId} from '../src/watch-notify-hold.mjs';
import {explainAlertRoute} from '../src/watch.mjs';
import {sendTmux, notificationHold} from '../src/floor-tmux.mjs';
import {openAlerts} from '../src/dashboard-band.mjs';
import {formatAlertBody} from '../src/watch-alert-body.mjs';

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

test('강제로 넣으려다 입력 보호 밖의 이유로 실패하면 횟수를 유지하고, 붙여넣기 뒤 기록 실패는 전달로 본다', () => {
  const tracker = new NotifyHoldTracker({record: () => {}});
  for (let i = 0; i < NOTIFY_FORCE_AT; i++) cycle(tracker, {held: ['w']});
  tracker.beginCycle();
  assert.equal(tracker.guardFor('w', {humanIdleMs: 1}).force, true);
  tracker.endCycle(0); // 복사 모드처럼 미룸도 전달도 아닌 실패
  assert.equal(tracker.forced('w'), true);
  const floor = {name: 'fake', alive: () => true, pid: () => '1', send: () => ({})};
  const send = options => guardedSend({...options, env: {KADAN_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-notify-sent-'))},
    readEntries: () => [], saveBody: () => {}, record: () => { throw new Error('ledger down'); }});
  tracker.beginCycle();
  assert.throws(() => sendWatchMessage('w', '경보', {selectedFloor: floor, readStart: () => ({panePid: 1}), send, tracker}),
    e => e.delivery === 'sent');
  tracker.endCycle(0);
  assert.equal(tracker.forced('w'), false);
});

test('tmux 강제 알림은 입력 검사만 건너뛰고 기록보기(복사 모드) 확인은 그대로 한다', () => {
  const calls = [];
  const fakeRun = mode => (args) => {
    calls.push(args[0]);
    if (args[0] === 'display-message') return mode;
    return '';
  };
  const ok = sendTmux('kadan-w', '알림', {run: fakeRun('0'), spawn: () => ({status: 0}), pid: 1, hrtime: () => 1n,
    notificationGuard: {humanIdleMs: 30_000, force: true}});
  assert.equal(ok.keyDelivery, 'sent');
  assert.equal(calls.includes('list-clients'), false, '사람 입력·입력창 검사를 하지 않는다');
  calls.length = 0;
  assert.throws(() => sendTmux('kadan-w', '알림', {run: fakeRun('1'), spawn: () => ({status: 0}), pid: 1, hrtime: () => 1n,
    notificationGuard: {humanIdleMs: 30_000, force: true}}), e => e.code === 'KADAN_PANE_IN_MODE' && e.delivery === 'not-sent');
  assert.equal(calls.includes('paste-buffer'), false);
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
      if (options.notificationGuard && !options.notificationGuard.force && n < holdUntil) throw hold();
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
  assert.equal(pastes[0].guard?.force, true, '5번 밀린 뒤에는 입력 보호만 뺀다(guard 자체를 빼지 않는다)');
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
  assert.notEqual(pastes[0].guard?.force, true);
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
  let started = false, human;
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
    // 걸림 → 보관, 창은 그대로. 사람이 붙은 창은 제어 모드 client로 대신한다(붙은 시각이 client_activity가 된다).
    human = spawn('tmux', ['-L', socket, '-C', 'attach', '-t', target.replace(/:$/, '')], {env, stdio: ['pipe', 'ignore', 'ignore']});
    waitFor(() => tmuxCmd(['list-clients', '-t', target.replace(/:$/, ''), '-F', '#{client_activity}']).stdout.trim() !== '');
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
    human?.kill();
    if (started) call('q-super', 'stop', 'q-super');
  }
});

test('열린 알림밀림 경보는 대시보드 응답에 횟수·사유·처음 밀린 시각이 실리고 해소되면 빠진다', async () => {
  const {records} = await watchRun({cycles: 9});
  const open = openAlerts(records.filter(e => e.kind === 'alert'));
  assert.equal(open.count, 0, '해소 뒤에는 목록에서 빠진다');
  const upto = records.findIndex(e => e.alertKind === '알림밀림' && e.resolved);
  const during = openAlerts(records.slice(0, upto).filter(e => e.kind === 'alert'));
  const [item] = during.items;
  assert.deepEqual([item.kind, item.role, item.holdCount, item.holdCode, item.holdReason],
    ['알림밀림', 'worker', 3, 'KADAN_PANE_INPUT_PENDING', '입력창에 쓰다 만 글이 있음']);
  assert.ok(Date.parse(item.heldSince) > 0);
  // 다른 경보 종류의 항목 모양은 그대로다.
  const other = openAlerts([{kind: 'alert', id: 'x', alertKind: '정지', t: '2026-10-05T00:00:00Z'}]).items[0];
  assert.equal('holdCount' in other, false);
});

test('입력 보호 코드가 아닌 사전 조회 오류는 미룸으로 세지 않는다', () => {
  const tracker = new NotifyHoldTracker();
  const floor = code => ({notificationHold: () => ({code, message: 'x'})});
  tracker.beginCycle();
  assert.equal(watchMailHold('w', {selectedFloor: floor('KADAN_AI_PROCESS_UNVERIFIED'), tracker}).code, 'KADAN_AI_PROCESS_UNVERIFIED');
  tracker.endCycle(0);
  assert.equal(tracker.streaks.size, 0);
  tracker.beginCycle();
  watchMailHold('w', {selectedFloor: floor('KADAN_PANE_INPUT_PENDING'), tracker});
  tracker.endCycle(0);
  assert.equal(tracker.streaks.get('w').count, 1);
});

test('알림밀림 문구는 5번 밀린 다음 시도에 넣는다고 말한다', () => {
  const text = formatAlertBody({kind: '알림밀림', role: 'w', holdCount: 3, holdCode: 'C', heldSince: 'T'});
  assert.match(text, /5번 밀린 다음 시도에 입력 보호 없이 넣음/);
  assert.doesNotMatch(text, /5번째부터/);
});

// tmux 복사 모드(2026-10-14): 감시기 알림에서는 실패가 아니라 미룸이고, 5번째 강제 차례에만 해제하고 넣는다.
const modeRun = (modes, calls) => args => {
  calls.push(args.join(' '));
  if (args[0] === 'display-message') return String(modes.length > 1 ? modes.shift() : modes[0]);
  return '';
};
const sendWith = (modes, guard, calls = []) => sendTmux('kadan-w', '알림',
  {run: modeRun(modes, calls), spawn: () => ({status: 0}), pid: 1, hrtime: () => 1n, notificationGuard: guard});

test('복사 모드·모드 조회 실패는 미룸 코드라 카운터가 센다 (입력 보호와 한 카운터)', () => {
  const tracker = new NotifyHoldTracker();
  const inMode = Object.assign(new Error('복사모드'), {code: 'KADAN_PANE_IN_MODE', delivery: 'not-sent'});
  const unknown = Object.assign(new Error('조회 실패'), {code: 'KADAN_PANE_MODE_UNKNOWN', delivery: 'not-sent'});
  for (const error of [inMode, hold(), unknown]) {
    tracker.beginCycle(); tracker.heldIfGuard('w', error); tracker.endCycle(0);
  }
  const [alert] = tracker.alerts();
  assert.deepEqual([alert.holdCount, alert.holdCode], [3, 'KADAN_PANE_MODE_UNKNOWN']);
  // 전달 안 된 일반 오류는 여전히 세지 않는다.
  tracker.beginCycle(); tracker.heldIfGuard('x', Object.assign(new Error('x'), {code: 'KADAN_PANE_DEAD', delivery: 'not-sent'}));
  tracker.endCycle(0);
  assert.equal(tracker.streaks.has('x'), false);
});

test('일반 알림은 복사 모드면 붙여넣지 않고 not-sent, 사전 확인도 복사 모드를 미룸으로 돌려준다', () => {
  const calls = [];
  assert.throws(() => sendWith([1], {humanIdleMs: 30_000}, calls),
    e => e.code === 'KADAN_PANE_IN_MODE' && e.delivery === 'not-sent');
  assert.equal(calls.some(c => c.startsWith('paste-buffer') || c.includes('-X cancel')), false);
  const held = notificationHoldFor('1');
  assert.equal(held.code, 'KADAN_PANE_IN_MODE');
});
function notificationHoldFor(mode) {
  return notificationHold('kadan-w', {humanIdleMs: 30_000}, {run: modeRun([mode], [])});
}

test('강제 차례: 복사 모드를 해제하고 다시 0을 확인한 뒤 넣고, 해제 사실을 영수증에 남긴다', () => {
  const calls = [];
  const receipt = sendWith([1, 0], {humanIdleMs: 30_000, force: true}, calls);
  assert.equal(receipt.copyModeReleased, true);
  const cancel = calls.findIndex(c => c === 'send-keys -t =kadan-w: -X cancel');
  assert.ok(cancel >= 0 && cancel < calls.findIndex(c => c.startsWith('load-buffer')), '붙여넣기 전에 해제');
  assert.equal(calls.some(c => c.startsWith('paste-buffer')), true);
  // 복사 모드가 아니면 해제하지 않는다.
  const quiet = [];
  assert.equal(sendWith([0], {humanIdleMs: 30_000, force: true}, quiet).copyModeReleased, undefined);
  assert.equal(quiet.some(c => c.includes('-X cancel')), false);
});

test('강제 차례라도 해제 뒤에도 모드면 넣지 않고 미룸이며, cancel이 실패해도 마찬가지다', () => {
  const calls = [];
  assert.throws(() => sendWith([1], {humanIdleMs: 30_000, force: true}, calls),
    e => e.code === 'KADAN_PANE_IN_MODE' && e.delivery === 'not-sent');
  assert.equal(calls.some(c => c.startsWith('load-buffer') || c.startsWith('paste-buffer')), false);
  const failing = args => { if (args.includes('-X')) throw new Error('not in a mode'); return args[0] === 'display-message' ? '1' : ''; };
  assert.throws(() => sendTmux('kadan-w', '알림', {run: failing, spawn: () => ({status: 0}), pid: 1, hrtime: () => 1n,
    notificationGuard: {humanIdleMs: 30_000, force: true}}), e => e.code === 'KADAN_PANE_IN_MODE' && e.delivery === 'not-sent');
  // 카드 전송은 force가 있어도 해제하지 않는다.
  const card = [];
  assert.throws(() => sendTmux('kadan-w', '카드', {run: modeRun([1], card), spawn: () => ({status: 0}), pid: 1, hrtime: () => 1n,
    cardIdentity: {currentPid: 1}, notificationGuard: {force: true}}), e => e.code === 'KADAN_PANE_IN_MODE');
  assert.equal(card.some(c => c.includes('-X cancel')), false);
});

test('강제 전달 기록에 복사 모드 해제 사실이 남는다', () => {
  const records = [];
  const tracker = new NotifyHoldTracker({record: e => records.push(e)});
  for (let i = 0; i < NOTIFY_FORCE_AT; i++) cycle(tracker, {held: ['w']});
  tracker.beginCycle();
  tracker.guardFor('w', {humanIdleMs: 1});
  tracker.delivered('w', {copyModeReleased: true});
  assert.equal(records[0].copyModeReleased, true);
});
