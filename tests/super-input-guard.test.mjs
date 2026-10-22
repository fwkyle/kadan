// 슈퍼감독 창 사람 입력 보호 2분(2026-10-22 [kyle]). 기준은 start 기록의 roleProfile === 'super' 하나다.
// 모두 가짜 시계·가짜 tmux·가짜 바닥으로 확인한다(실제 알림·부하 없음).
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HUMAN_IDLE_MS, SUPER_HUMAN_IDLE_MS, forcedIdleMsFor, humanIdleMsFor,
} from '../src/notification-guard.mjs';
import {makeHerdrFloor} from '../src/floor-herdr.mjs';
import {sendTmux, tmuxFloor} from '../src/floor-tmux.mjs';
import {herdrNotificationGuard} from '../src/herdr-notification.mjs';
import {guardedSend} from '../src/cli-guarded-send.mjs';
import {
  sendWatchMailReminder, sendWatchMessage, sendWatchNudge, watchMailHold,
} from '../src/commands/watch.mjs';
import {NotifyHoldTracker, NOTIFY_FORCE_AT} from '../src/watch-notify-hold.mjs';

const SUPER = {roleProfile: 'super', panePid: '111'};
const WORKER = {roleProfile: 'worker', panePid: '111'};
const NO_PROFILE = {panePid: '111'};

test('값 고르기: super 프로필만 2분, 나머지·기록 없음·읽기 실패는 30초', () => {
  assert.equal(SUPER_HUMAN_IDLE_MS, 120_000);
  assert.equal(HUMAN_IDLE_MS, 30_000);
  assert.equal(humanIdleMsFor(SUPER), 120_000);
  for (const start of [WORKER, NO_PROFILE, {roleProfile: 'supervisor'}, null, undefined]) {
    assert.equal(humanIdleMsFor(start), 30_000, JSON.stringify(start));
  }
});

// ---- tmux 바닥: 카드·알림·일반 우편이 같은 기준을 쓴다 ----
const NOW = Math.floor(Date.now() / 1000); // 초, 시험 시작 때 한 번 읽는다
const identity = {harness: 'codex', model: 'test-model', currentPid: '11'};
function tmuxFixture({ago, card}) {
  const calls = [];
  return {calls, options: {...(card ? {cardIdentity: identity} : {}), pid: 1, hrtime: () => 1n,
    run(args) {
      calls.push(args);
      if (args.includes('#{pane_in_mode}')) return '0';
      if (args.includes('#{pane_pid}|#{pane_dead}')) return '11|0';
      if (args[0] === 'list-clients') return `${NOW - 3600} ${NOW - ago}`;
      return '';
    },
    spawn: bin => bin === 'ps' ? {status: 0, stdout: '11 1 11 11 /opt/bin/codex --model test-model'} : {status: 0},
  }};
}
const pastes = f => f.calls.filter(a => a[0] === 'paste-buffer').length;
// 경로마다 호출부가 값을 넘기는 방식이 다르다: 알림은 notificationGuard.humanIdleMs, 카드·일반 우편은 humanIdleMs.
const PATHS = {
  '카드': (f, start) => sendTmux('kadan-r', 'CARD', {...f.options, humanIdleMs: humanIdleMsFor(start)}),
  '알림': (f, start) => sendTmux('kadan-r', 'MAIL', {...f.options,
    notificationGuard: {humanIdleMs: humanIdleMsFor(start), now: NOW * 1000}}),
  '일반 우편': (f, start) => sendTmux('kadan-r', 'MAIL', {...f.options, humanIdleMs: humanIdleMsFor(start)}),
};
for (const [name, send] of Object.entries(PATHS)) {
  const card = name === '카드';
  // 시계는 시험 시작 때 한 번 읽어 고정한다(알림은 now로, 카드·일반 우편은 Date.now()라 흐르는 1~2초는 90/150초 경계에 영향이 없다).
  test(`${name}: 슈퍼감독이 90초 전에 입력 → 보류`, () => {
    const f = tmuxFixture({ago: 90, card});

    assert.throws(() => send(f, SUPER), e => e.code === 'KADAN_HUMAN_ACTIVE' && e.delivery === 'not-sent');
    assert.equal(pastes(f), 0);
  });
  test(`${name}: 작업자가 90초 전에 입력 → 전달`, () => {
    const f = tmuxFixture({ago: 90, card});
    send(f, WORKER);
    assert.equal(pastes(f), 1);
  });
  test(`${name}: 슈퍼감독이 150초 전에 입력 → 전달`, () => {
    const f = tmuxFixture({ago: 150, card});
    send(f, SUPER);
    assert.equal(pastes(f), 1);
  });
  test(`${name}: 프로필을 모르면(기록 없음) 30초 기준: 20초 전 입력은 보류, 40초 전은 전달`, () => {
    const held = tmuxFixture({ago: 20, card});
    assert.throws(() => send(held, null), e => e.code === 'KADAN_HUMAN_ACTIVE');
    const ok = tmuxFixture({ago: 40, card});
    send(ok, null);
    assert.equal(pastes(ok), 1);
  });
}
test('Enter 직전 재검사도 같은 값을 쓴다: 붙인 뒤 90초 전 입력이 보이면 슈퍼감독은 Enter를 보내지 않는다', () => {
  const now = Math.floor(Date.now() / 1000);
  const calls = [];
  let listed = 0;
  const run = args => {
    calls.push(args);
    if (args.includes('#{pane_in_mode}')) return '0';
    if (args[0] === 'list-clients') { listed += 1; return listed < 3 ? '' : `${now - 3600} ${now - 90}`; }
    return '';
  };
  assert.throws(() => sendTmux('kadan-r', 'MAIL', {run, spawn: () => ({status: 0}), pid: 1, hrtime: () => 1n,
    humanIdleMs: SUPER_HUMAN_IDLE_MS}), e => e.enterWithheld === true && e.code === 'KADAN_HUMAN_ACTIVE');
  assert.equal(calls.filter(a => a[0] === 'send-keys').length, 0);
});

test('notificationHold(바닥 보류 조회)도 넘겨받은 값으로 판정한다', () => {
  const clients = ago => args => args.includes('#{pane_in_mode}') ? '0'
    : args[0] === 'list-clients' ? `${NOW - 3600} ${NOW - ago}` : '';
  const hold = (ms, ago) => tmuxFloor.notificationHold('kadan-r', {humanIdleMs: ms, now: NOW * 1000}, {run: clients(ago)});
  assert.equal(hold(SUPER_HUMAN_IDLE_MS, 90)?.code, 'KADAN_HUMAN_ACTIVE');
  assert.equal(hold(SUPER_HUMAN_IDLE_MS, 150), null);
  assert.equal(hold(HUMAN_IDLE_MS, 90), null);
});

// ---- herdr: 대기 화면 안정 시간이 호출부 값(2분)까지 흐른다 ----
test('herdr 알림 보호: 슈퍼감독 2분이면 119.999초는 보류, 120초에 통과. 일반은 30초', () => {
  const view = {record: {herdrSocket: 's', panePid: '1'}, pane: {terminal_id: 't', pane_id: 'p'}, visible: {revision: 1, text: 'idle'}};
  const guard = herdrNotificationGuard(() => view);
  assert.throws(() => guard('a', {humanIdleMs: SUPER_HUMAN_IDLE_MS, now: 0}), e => e.code === 'KADAN_HUMAN_ACTIVE'); // 첫 관측
  assert.throws(() => guard('a', {humanIdleMs: SUPER_HUMAN_IDLE_MS, now: 119_999}), e => e.code === 'KADAN_HUMAN_ACTIVE');
  assert.equal(guard('a', {humanIdleMs: SUPER_HUMAN_IDLE_MS, now: 120_000}), view);
  const plain = herdrNotificationGuard(() => view);
  assert.throws(() => plain('b', {humanIdleMs: HUMAN_IDLE_MS, now: 0}), e => e.code === 'KADAN_HUMAN_ACTIVE');
  assert.throws(() => plain('b', {humanIdleMs: HUMAN_IDLE_MS, now: 29_999}), e => e.code === 'KADAN_HUMAN_ACTIVE');
  assert.equal(plain('b', {humanIdleMs: HUMAN_IDLE_MS, now: 30_000}), view);
});

// ---- 감시기 경로: 호출부가 start 기록으로 값을 고른다 ----
const fakeFloor = (extra = {}) => ({name: 'tmux', alive: () => true, pid: () => '111', ...extra});
function captured(call) {
  const seen = [];
  call(options => { seen.push(options.notificationGuard); return {session: 'kadan-x', digest: 'd', bytes: 1}; });
  assert.equal(seen.length, 1);
  return seen[0].humanIdleMs;
}
const watchPaths = {
  '감시 경보': (start, send) => sendWatchMessage('r', '경보', {selectedFloor: fakeFloor(), readStart: () => start, send}),
  '미확인 우편 안내(watch-mail-reminder, 10/22 사고 경로)': (start, send) =>
    sendWatchMailReminder('r', 'inbox 확인', '111', {selectedFloor: fakeFloor(), readStart: () => start, send}),
  '놀고 있음 본인 알림': (start, send) => sendWatchNudge('r', '알림', {selectedFloor: fakeFloor(), readStart: () => start, send}),
};
for (const [name, call] of Object.entries(watchPaths)) {
  test(`${name}: super 2분 / 작업자 30초 / 프로필 모름 30초`, () => {
    assert.equal(captured(send => call(SUPER, send)), 120_000);
    assert.equal(captured(send => call(WORKER, send)), 30_000);
    assert.equal(captured(send => call(NO_PROFILE, send)), 30_000);
  });
}

test('보류 사전 확인(watchMailHold)도 start 프로필로 값을 고른다', () => {
  const seen = [];
  const selectedFloor = {notificationHold: (_session, guard) => { seen.push(guard.humanIdleMs); return null; }};
  watchMailHold('r', {selectedFloor, readStart: () => SUPER});
  watchMailHold('r', {selectedFloor, readStart: () => WORKER});
  watchMailHold('r', {selectedFloor, readStart: () => null});
  assert.deepEqual(seen, [120_000, 30_000, 30_000]);
});

// ---- guardedSend: 카드·일반 우편(알림 보호 객체 없음)은 원장의 start로 값을 정해 바닥에 넘긴다 ----
function guardedSeen(start) {
  const seen = [];
  const floor = fakeFloor({send: (_s, _m, options) => { seen.push(options.humanIdleMs); return {keyDelivery: 'sent'}; }});
  guardedSend({floor, session: 'kadan-r', role: 'r', message: '일반 우편', recordedPid: '111', raw: true,
    record: () => {}, saveBody: () => ({}), readEntries: () => start ? [{kind: 'start', session: 'kadan-r', role: 'r', ...start}] : [],
    env: {...process.env}});
  return seen[0];
}
test('guardedSend: 일반 우편·카드 경로 값은 받는 역할의 start 프로필이 정한다', () => {
  assert.equal(guardedSeen(SUPER), 120_000);
  assert.equal(guardedSeen(WORKER), 30_000);
  assert.equal(guardedSeen(null), 30_000);
});

// ---- 5번 강제 넣기도 마지막 사람 입력 뒤 30초는 기다린다(kyle 결정 B, 2026-10-22). 5번·3번 값은 그대로다 ----
test('forcedIdleMsFor: 보호가 30초보다 긴 창만 30초, 30초 창·모르는 값은 null(검사 건너뜀)', () => {
  assert.equal(forcedIdleMsFor(SUPER_HUMAN_IDLE_MS), HUMAN_IDLE_MS);
  assert.equal(forcedIdleMsFor(HUMAN_IDLE_MS), null);
  for (const value of [undefined, null, NaN, 0, 10_000]) assert.equal(forcedIdleMsFor(value), null, String(value));
});

// 감시 주기 60초 가짜 시계. keys: 사람이 키를 친 시각 목록. phase: 각 주기가 마지막 키 뒤 몇 초 지점에서 도는가.
// 강제 차례의 기준은 sendTmux·watchMailHold가 쓰는 것과 같은 forcedIdleMsFor다.
function simulateForce({idleMs, lastKeyAt, cycles = 14, cycleMs = 60_000, startAt = 0}) {
  const tracker = new NotifyHoldTracker();
  const forcedAt = [];
  const hold = Object.assign(new Error('x'), {code: 'KADAN_HUMAN_ACTIVE', delivery: 'not-sent'});
  for (let cycle = 0; cycle < cycles; cycle++) {
    const now = startAt + cycle * cycleMs;
    const age = now - lastKeyAt(now);
    tracker.beginCycle();
    const forced = tracker.forced('s');
    const window = forced ? forcedIdleMsFor(idleMs) : idleMs;
    if (window !== null && age < window) tracker.held('s', hold);
    else { if (forced) forcedAt.push({at: now, age}); tracker.delivered('s'); }
    tracker.endCycle(now);
  }
  return {forcedAt, tracker};
}

test('B: 슈퍼감독이 60초마다 키를 치고 주기가 키 20초 뒤에 돌면 강제 넣기 0번(마지막 키 뒤 30초 미만이라 계속 밀림)', () => {
  // 키 시각 0, 60, 120, ... / 주기 20, 80, 140, ... → 마지막 키 뒤 항상 20초
  const {forcedAt, tracker} = simulateForce({idleMs: SUPER_HUMAN_IDLE_MS, startAt: 20_000, cycles: 20,
    lastKeyAt: now => Math.floor((now - 20_000) / 60_000) * 60_000 + 0});
  assert.deepEqual(forcedAt, []);
  assert.ok(tracker.streaks.get('s').count >= NOTIFY_FORCE_AT + 10, '밀림 횟수는 5 이상으로 계속 유지된다');
  assert.equal(tracker.forced('s'), true);
});

test('B: 키가 마지막 키 뒤 45초 지점에서 보이면 5번 밀린 다음 주기에 강제로 들어간다(2분까지 기다리지 않음)', () => {
  const {forcedAt} = simulateForce({idleMs: SUPER_HUMAN_IDLE_MS, startAt: 45_000, cycles: 10,
    lastKeyAt: now => Math.floor((now - 45_000) / 60_000) * 60_000});
  assert.equal(NOTIFY_FORCE_AT, 5);
  assert.deepEqual(forcedAt, [{at: 45_000 + 5 * 60_000, age: 45_000}], '첫 보류 뒤 5주기=345초, 마지막 키 뒤 45초(≥30초, <2분)');
});

test('B: 계속 치다 멈추면 마지막 키(600초) 뒤 30초 이상인 첫 주기(680초)에 강제로 들어간다', () => {
  const {forcedAt} = simulateForce({idleMs: SUPER_HUMAN_IDLE_MS, startAt: 20_000, cycles: 14,
    lastKeyAt: now => Math.min(Math.floor((now - 20_000) / 60_000) * 60_000, 600_000)});
  assert.deepEqual(forcedAt[0], {at: 680_000, age: 80_000}, '620초는 20초 뒤라 밀림, 680초는 80초 뒤라 강제 통과');
  assert.ok(forcedAt[0].age < SUPER_HUMAN_IDLE_MS, '2분을 다 기다리지 않는다');
});

test('B: 30초 창(작업자·일반감독)의 강제는 지금과 같다: 마지막 키 뒤 20초여도 5번 밀린 다음 주기에 입력 보호 없이 들어간다', () => {
  const {forcedAt} = simulateForce({idleMs: HUMAN_IDLE_MS, startAt: 20_000, cycles: 10,
    lastKeyAt: now => Math.floor((now - 20_000) / 60_000) * 60_000 + 10_000});
  // 키 뒤 10초 → 30초 창에서는 계속 밀리다 5번 뒤 강제(검사 없음)로 들어간다
  assert.equal(forcedAt.length >= 1, true);
  assert.equal(forcedAt[0].age, 10_000, '10초 전 입력이어도 강제로 들어갔다(검사 건너뜀)');
});

// ---- 바닥 단위: 강제 차례 ----
const FORCE_SUPER = {force: true, humanIdleMs: SUPER_HUMAN_IDLE_MS};
const tmuxForced = (ago, guard, extra = {}) => {
  const f = tmuxFixture({ago});
  return {f, send: () => sendTmux('kadan-r', 'MAIL', {...f.options, notificationGuard: {...guard, now: NOW * 1000}, ...extra})};
};
test('B tmux: 강제 + 2분 창, 20초 전 입력 → 보류(붙이지 않음), 60초 전 → 통과', () => {
  const held = tmuxForced(20, FORCE_SUPER);
  assert.throws(held.send, e => e.code === 'KADAN_HUMAN_ACTIVE' && e.delivery === 'not-sent');
  assert.equal(pastes(held.f), 0);
  const ok = tmuxForced(60, FORCE_SUPER);
  ok.send();
  assert.equal(pastes(ok.f), 1);
});
test('B tmux: 강제 + 2분 창, 사람 입력으로 밀리는 차례는 복사 모드를 건드리지 않는다', () => {
  const f = tmuxFixture({ago: 20});
  const run = args => args.includes('#{pane_in_mode}') ? '1' : f.options.run(args);
  assert.throws(() => sendTmux('kadan-r', 'MAIL', {...f.options, run, notificationGuard: {...FORCE_SUPER, now: NOW * 1000}}),
    e => e.code === 'KADAN_HUMAN_ACTIVE');
  assert.equal(f.calls.some(a => a.includes('cancel')), false);
});
test('B tmux: 강제 + 2분 창, Enter 직전 재검사도 30초: 붙인 뒤 20초 전 입력이 보이면 Enter를 보내지 않는다', () => {
  const calls = [];
  let listed = 0;
  const run = args => {
    calls.push(args);
    if (args.includes('#{pane_in_mode}')) return '0';
    if (args[0] === 'list-clients') { listed += 1; return `${NOW - 3600} ${NOW - (listed < 4 ? 60 : 20)}`; }
    return '';
  };
  assert.throws(() => sendTmux('kadan-r', 'MAIL', {run, spawn: () => ({status: 0}), pid: 1, hrtime: () => 1n,
    notificationGuard: {...FORCE_SUPER, now: NOW * 1000}}), e => e.enterWithheld === true && e.code === 'KADAN_HUMAN_ACTIVE');
  assert.equal(calls.filter(a => a[0] === 'send-keys' && a.at(-1) === 'Enter').length, 0);
  assert.equal(listed, 4, '붙이기 전 2번 + 붙인 뒤 Enter 직전까지 모두 같은 기준');
});
test('B tmux: 강제 + 30초 창(작업자·일반감독·모름)은 사람 입력 검사를 아예 하지 않는다(지금과 같은 건너뜀)', () => {
  for (const guard of [{force: true, humanIdleMs: HUMAN_IDLE_MS}, {force: true}]) {
    const t = tmuxForced(1, guard);
    t.send();
    assert.equal(pastes(t.f), 1);
    assert.equal(t.f.calls.some(a => a[0] === 'list-clients'), false, JSON.stringify(guard));
    assert.equal(t.f.calls.some(a => a[0] === 'send-keys' && a.at(-1) === 'Enter'), true);
  }
});
test('B tmux notificationHold: 강제 + 2분 창은 20초 전 입력이면 보류, 60초 전이면 null. 복사 모드는 미리 밀지 않는다', () => {
  const clients = (ago, mode = '0') => args => args.includes('#{pane_in_mode}') ? mode
    : args[0] === 'list-clients' ? `${NOW - 3600} ${NOW - ago}` : '';
  const hold = (guard, ago, mode) => tmuxFloor.notificationHold('kadan-r', {...guard, now: NOW * 1000}, {run: clients(ago, mode)});
  assert.equal(hold(FORCE_SUPER, 20)?.code, 'KADAN_HUMAN_ACTIVE');
  assert.equal(hold(FORCE_SUPER, 60), null);
  assert.equal(hold(FORCE_SUPER, 60, '1'), null, '강제 차례는 복사 모드를 해제하고 넣는다');
  assert.equal(hold({force: true, humanIdleMs: HUMAN_IDLE_MS}, 1), null);
  assert.equal(hold({humanIdleMs: SUPER_HUMAN_IDLE_MS}, 60, '1')?.code, 'KADAN_PANE_IN_MODE', '강제 아닌 차례는 그대로 복사 모드로 밀린다');
});

function herdrFixture() {
  const env = {KADAN_HOME: '/tmp/kadan-herdr-force-test', KADAN_HERDR_SOCKET: '/tmp/herdr-force-test.sock'};
  const start = {kind: 'start', floor: 'herdr', session: 'kadan-판-감독', panePid: '123', harness: 'codex', model: 'm',
    herdrSocket: env.KADAN_HERDR_SOCKET, herdrWorkspaceId: 'w', herdrPaneId: 'p', herdrTerminalId: 't'};
  const pane = {pane_id: 'p', workspace_id: 'w', terminal_id: 't', scroll: {offset_from_bottom: 0, viewport_rows: 58}};
  const state = {status: 'idle', prompts: 0};
  const rpc = (_socket, method) => {
    if (method === 'session.snapshot') return {snapshot: {panes: [pane]}};
    if (method === 'pane.process_info') return {process_info: {shell_pid: 123, foreground_processes: [{pid: 123, argv: ['codex', '--model', 'm']}]}};
    if (method === 'agent.get') return {agent: {terminal_id: 't', agent_status: state.status}};
    if (method === 'pane.read') return {read: {text: '\n› \n\nstatus', revision: 7, truncated: false}};
    if (method === 'agent.prompt') { state.prompts += 1; return {type: 'ok'}; }
    throw new Error(`Unexpected request ${method}`);
  };
  return {floor: makeHerdrFloor({env, entries: () => [start], rpc, argsForPid: () => ''}), state, session: start.session};
}
test('B herdr: 강제 + 2분 창은 같은 화면 안정 검사를 30초로 돈다(29.999초 보류, 30초 통과). 응답 중이어도 관측한다', () => {
  const f = herdrFixture();
  const send = now => f.floor.send(f.session, '알림', {notificationGuard: {...FORCE_SUPER, now}});
  assert.throws(() => send(0), e => e.code === 'KADAN_HUMAN_ACTIVE' && e.delivery === 'not-sent');
  assert.throws(() => send(29_999), e => e.code === 'KADAN_HUMAN_ACTIVE');
  assert.equal(f.state.prompts, 0);
  f.state.status = 'working';
  assert.equal(send(30_000).keyDelivery, 'sent');
  assert.equal(f.state.prompts, 1);
  assert.equal(f.floor.notificationHold(f.session, {...FORCE_SUPER, now: 30_000}), null);
  assert.equal(f.floor.notificationHold(f.session, {...FORCE_SUPER, now: 59_999})?.code ?? null, null, '사전 확인도 같은 30초 기준');
});
test('B herdr: 강제 + 30초 창은 화면 안정 검사를 건너뛴다(첫 관측도 바로 통과)', () => {
  const f = herdrFixture();
  assert.equal(f.floor.send(f.session, '알림', {notificationGuard: {force: true, humanIdleMs: HUMAN_IDLE_MS, now: 0}}).keyDelivery, 'sent');
  assert.equal(f.state.prompts, 1);
  assert.equal(f.floor.notificationHold(f.session, {force: true, humanIdleMs: HUMAN_IDLE_MS, now: 0}), null);
});

// ---- 감시기: 사전 확인과 전송 경로가 같은 함수를 거친다 ----
function forcedTracker(records = []) {
  const tracker = new NotifyHoldTracker({record: entry => records.push(entry)});
  for (let i = 0; i < NOTIFY_FORCE_AT; i++) {
    tracker.beginCycle();
    tracker.held('r', Object.assign(new Error('x'), {code: 'KADAN_HUMAN_ACTIVE', delivery: 'not-sent'}));
    tracker.endCycle(i);
  }
  assert.equal(tracker.forced('r'), true);
  return tracker;
}
test('B watchMailHold: 2분 창 강제 차례에 20초 전 입력 → 밀림 반환, 횟수 유지, watch-notify-forced 기록 없음', () => {
  const records = [];
  const tracker = forcedTracker(records);
  const run = args => args.includes('#{pane_in_mode}') ? '0' : args[0] === 'list-clients' ? `${NOW - 3600} ${NOW - 20}` : '';
  const selectedFloor = {notificationHold: (session, guard) => tmuxFloor.notificationHold(session, guard, {run})};
  tracker.beginCycle();
  const held = watchMailHold('r', {selectedFloor, readStart: () => SUPER, tracker});
  assert.equal(held?.code, 'KADAN_HUMAN_ACTIVE');
  tracker.endCycle(99);
  assert.equal(tracker.streaks.get('r').count, NOTIFY_FORCE_AT + 1);
  assert.equal(tracker.forced('r'), true);
  assert.deepEqual(records, []);
});
test('B watchMailHold: 2분 창 강제 차례에 60초 전 입력 → 통과(null). 30초 창은 사전 확인 자체를 건너뛴다', () => {
  const run = args => args.includes('#{pane_in_mode}') ? '0' : args[0] === 'list-clients' ? `${NOW - 3600} ${NOW - 60}` : '';
  const seen = [];
  const selectedFloor = {notificationHold: (session, guard) => { seen.push(guard); return tmuxFloor.notificationHold(session, guard, {run}); }};
  assert.equal(watchMailHold('r', {selectedFloor, readStart: () => SUPER, tracker: forcedTracker()}), null);
  assert.deepEqual(seen, [{humanIdleMs: SUPER_HUMAN_IDLE_MS, force: true}], '값은 전송 경로와 같은 모양으로 넘기고 바닥이 30초로 줄인다');
  seen.length = 0;
  assert.equal(watchMailHold('r', {selectedFloor, readStart: () => WORKER, tracker: forcedTracker()}), null);
  assert.deepEqual(seen, [], '작업자 창 강제는 사전 확인을 하지 않는다(지금과 같음)');
});
test('B 전송 경로: 강제 차례의 알림은 force와 start 프로필 값(2분)을 바닥에 그대로 넘기고, 바닥이 30초로 줄인다', () => {
  const seen = [];
  const send = options => { seen.push(options.notificationGuard); return {session: 'kadan-x', digest: 'd', bytes: 1}; };
  sendWatchMessage('r', '경보', {selectedFloor: fakeFloor(), readStart: () => SUPER, send, tracker: forcedTracker()});
  assert.deepEqual(seen, [{humanIdleMs: SUPER_HUMAN_IDLE_MS, force: true}]);
});
