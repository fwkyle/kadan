// 슈퍼감독 창 사람 입력 보호 2분(2026-10-22 [kyle]). 기준은 start 기록의 roleProfile === 'super' 하나다.
// 모두 가짜 시계·가짜 tmux·가짜 바닥으로 확인한다(실제 알림·부하 없음).
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HUMAN_IDLE_MS, SUPER_HUMAN_IDLE_MS, humanIdleMsFor,
} from '../src/notification-guard.mjs';
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

// ---- 5번 강제 넣기(바꾸지 않음): 숫자로 보고만 한다 ----
test('5번 강제 시각 실측(가짜 시계): 감시 주기 60초, 슈퍼감독이 60초마다 키를 치면 강제가 2분 보호를 넘는다', () => {
  const CYCLE = 60_000;
  const tracker = new NotifyHoldTracker();
  const typedAt = t => t; // 슈퍼감독이 매 주기 직전(=60초 전)에 마지막 키를 쳤다고 둔다
  let forcedAt = null, ageAtForce = null, heldCycles = 0;
  for (let cycle = 0; cycle < 12 && forcedAt === null; cycle++) {
    const now = cycle * CYCLE;
    const lastKey = typedAt(now - 60_000 < 0 ? 0 : now - 60_000);
    tracker.beginCycle();
    if (tracker.forced('s')) { forcedAt = now; ageAtForce = now - lastKey; tracker.delivered('s'); }
    else if (now - lastKey < SUPER_HUMAN_IDLE_MS) { tracker.held('s', Object.assign(new Error('x'), {code: 'KADAN_HUMAN_ACTIVE', delivery: 'not-sent'})); heldCycles += 1; }
    else tracker.delivered('s');
    tracker.endCycle(now);
  }
  assert.equal(NOTIFY_FORCE_AT, 5);
  assert.equal(heldCycles, 5);
  assert.equal(forcedAt, 300_000, '첫 보류 뒤 5주기=300초에 강제 차례(주기 60초 × 5)');
  assert.equal(ageAtForce, 60_000, '마지막 키 입력 60초 뒤라 2분 보호 안에서 강제로 들어간다');
  assert.ok(ageAtForce < SUPER_HUMAN_IDLE_MS);
});
