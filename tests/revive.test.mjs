import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TARGETS, REVIVE_CAP, REVIVE_WINDOW_MS, readReviveState, markStopped, clearForUp, acquireReviveLock,
  prepareRevive, finishRevive, changedOutput, scrubScreen, unmarkStopped, recoverCorruptState,
} from '../src/revive.mjs';
import {startFakeDiscord, FAKE} from './helpers/fake-discord-api.mjs';
import {createChat, runWatch, CONNECT_OUTAGE_MS} from '../src/discord-chat.mjs';
import {DiscordError} from '../src/discord-bot.mjs';

const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), `kadan-revive-${prefix}-`));
const T0 = Date.parse('2026-10-16T09:00:00Z');

// 가짜 바닥: 세션 상태를 표로 두고 호출을 모은다. 실제 tmux·알림·원장에는 닿지 않는다.
function fakeOps(sessions = {}, extra = {}) {
  const calls = {killed: [], notices: [], records: [], captured: []};
  const ops = {
    sessionOf: target => `kadan-${target}`,
    exists: session => session in sessions,
    paneState: session => sessions[session]?.panes ?? (sessions[session]?.dead === true ? 'dead' : 'live'),
    capture: session => { calls.captured.push(session); return sessions[session]?.screen ?? ''; },
    kill: session => { calls.killed.push(session); delete sessions[session]; },
    applicable: () => true,
    stuck: () => null,
    notify: (message, options) => { calls.notices.push({message, ...options}); return {via: 'discord'}; },
    record: entry => calls.records.push(entry),
    ...extra,
  };
  return {ops, calls, sessions};
}
const resultsOf = (value) => Object.fromEntries(TARGETS.map(t => [t, value]));

test('대상은 기반 프로세스 4개뿐이다', () => {
  assert.deepEqual(TARGETS, ['비서', '대시보드', '디코', 'watch']);
});

test('세션 없음 → 되살림 대상, 띄운 뒤 revive 사건(start 아님)·조용한 알림 1건·횟수 1', () => {
  const home = tmp('basic'), {ops, calls} = fakeOps({'kadan-비서': {}, 'kadan-대시보드': {}, 'kadan-watch': {}});
  const prep = prepareRevive({home, auto: true, now: T0, ops});
  assert.deepEqual([...prep.pending.keys()], ['디코']);
  assert.equal(prep.pending.get('디코').reason, '세션 없음');
  const lines = finishRevive({home, pending: prep.pending, results: {...resultsOf('reused'), 디코: 'started'}, now: T0, ops});
  assert.equal(calls.records.length, 1);
  assert.deepEqual([calls.records[0].kind, calls.records[0].target, calls.records[0].result, calls.records[0].count, calls.records[0].by],
    ['revive', '디코', 'started', 1, 'autostart']);
  assert.notEqual(calls.records[0].kind, 'start');
  assert.equal(calls.notices.length, 1);
  assert.equal(calls.notices[0].ring, false, '조용한 알림(멘션 없음)');
  assert.match(calls.notices[0].message, /디코 다리가 꺼져 있어 다시 띄웠습니다\(이번 1시간 1번째\)/);
  assert.match(lines.join(), /디코 다리/);
});

test('모두 살아 있으면 아무것도 하지 않는다 — 기록·알림·출력 0', () => {
  const home = tmp('alive'), {ops, calls} = fakeOps({'kadan-비서': {}, 'kadan-대시보드': {}, 'kadan-디코': {}, 'kadan-watch': {}});
  const prep = prepareRevive({home, auto: true, now: T0, ops});
  assert.equal(prep.pending.size, 0);
  assert.equal(prep.skip.size, 0);
  assert.deepEqual(prep.lines, []);
  assert.deepEqual(changedOutput(home, prep.lines), []);
  assert.deepEqual([calls.records.length, calls.notices.length, calls.killed.length], [0, 0, 0]);
});

test('pane 죽음 → 마지막 화면 저장(비밀값 가림) → 죽은 세션 정리 → 재생성 대상', () => {
  const home = tmp('dead');
  const screen = '네트워크 오류\nhttps://discord.com/api/webhooks/123456/abcDEF_token-xyz\nAuthorization: Bot abcdefghijklmnop\nMTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.abcdefghijklmnopqrstuvwxyz0123';
  const {ops, calls} = fakeOps({'kadan-비서': {}, 'kadan-대시보드': {}, 'kadan-watch': {}, 'kadan-디코': {dead: true, screen}});
  const prep = prepareRevive({home, auto: true, now: T0, ops});
  assert.deepEqual(calls.killed, ['kadan-디코']);
  const info = prep.pending.get('디코');
  assert.equal(info.reason, 'pane 죽음');
  assert.ok(fs.existsSync(info.screenPath) && info.screenPath.startsWith(path.join(home, 'revive')));
  const saved = fs.readFileSync(info.screenPath, 'utf8');
  assert.match(saved, /네트워크 오류/);
  assert.doesNotMatch(saved, /abcDEF_token|abcdefghijklmnop|GabcDE/);
  finishRevive({home, pending: prep.pending, results: {디코: 'started'}, now: T0, ops});
  assert.match(calls.notices[0].message, /마지막 화면: .*revive/);
  assert.equal(calls.records[0].screenPath, info.screenPath);
});

test('살아 있는 pane인데 일을 못 하는 막힘은 건드리지 않고, 두 번째 회차에 한 번만 알린다(울림)', () => {
  const home = tmp('stuck'), {ops, calls} = fakeOps({'kadan-비서': {}, 'kadan-대시보드': {}, 'kadan-watch': {}, 'kadan-디코': {}},
    {stuck: target => (target === '디코' ? '세션은 있는데 받기 프로세스(잠금)가 없습니다' : null)});
  const first = prepareRevive({home, auto: true, now: T0, ops});
  assert.equal(calls.notices.length, 0, '막 뜨는 중일 수 있어 첫 회차는 알리지 않는다');
  for (let i = 1; i <= 3; i++) prepareRevive({home, auto: true, now: T0 + i * 60_000, ops});
  assert.equal(calls.notices.length, 1, '상태가 바뀔 때 한 번만');
  assert.equal(calls.notices[0].ring, true);
  assert.deepEqual([calls.killed.length, first.pending.size, calls.records.length], [0, 0, 0], '세션을 죽이거나 다시 만들지 않는다');
  // 풀리면 표시가 지워지고, 다시 막히면 다시 두 회차를 센다
  const ok = fakeOps({'kadan-비서': {}, 'kadan-대시보드': {}, 'kadan-watch': {}, 'kadan-디코': {}});
  prepareRevive({home, auto: true, now: T0 + 5 * 60_000, ops: ok.ops});
  assert.deepEqual(readReviveState(home).blocked, {});
});

test('지난 60분에 3번 되살렸으면 4번째는 안 띄운다 — ring 경보 1번, capped 멈춤, 다음 회차에 다시 안 울린다', () => {
  const home = tmp('cap'), {ops, calls} = fakeOps({'kadan-비서': {}, 'kadan-대시보드': {}, 'kadan-watch': {}});
  for (let i = 0; i < REVIVE_CAP; i++) {
    const now = T0 + i * 10 * 60_000;
    const prep = prepareRevive({home, auto: true, now, ops});
    assert.equal(prep.pending.get('디코').count, i + 1);
    finishRevive({home, pending: prep.pending, results: {디코: 'started'}, now, ops});
  }
  assert.equal(calls.records.filter(r => r.result === 'started').length, 3);
  const fourthAt = T0 + 30 * 60_000;
  const fourth = prepareRevive({home, auto: true, now: fourthAt, ops});
  assert.equal(fourth.pending.size, 0);
  assert.ok(fourth.skip.has('디코'));
  const ringing = calls.notices.filter(n => n.ring === true);
  assert.equal(ringing.length, 1);
  assert.match(ringing[0].message, /1시간에 3번 넘게 꺼져 더 띄우지 않습니다/);
  assert.equal(calls.records.at(-1).result, 'capped');
  assert.equal(readReviveState(home).targets.디코.state, 'capped');
  const fifth = prepareRevive({home, auto: true, now: fourthAt + 60_000, ops});
  assert.ok(fifth.skip.has('디코'));
  assert.equal(calls.notices.filter(n => n.ring === true).length, 1, '매분 다시 울리지 않는다');
  // 사람이 친 up이 푼다. 상한 집계도 새로 센다
  assert.equal(clearForUp(home), true);
  const after = prepareRevive({home, auto: true, now: fourthAt + 120_000, ops});
  assert.equal(after.pending.get('디코').count, 1);
});

test('60분이 지난 되살림은 상한에서 빠진다', () => {
  const home = tmp('window'), {ops} = fakeOps({'kadan-비서': {}, 'kadan-대시보드': {}, 'kadan-watch': {}});
  for (let i = 0; i < REVIVE_CAP; i++) {
    const now = T0 + i * 60_000;
    finishRevive({home, pending: prepareRevive({home, auto: true, now, ops}).pending, results: {디코: 'started'}, now, ops});
  }
  const later = prepareRevive({home, auto: true, now: T0 + REVIVE_WINDOW_MS + 3 * 60_000, ops});
  assert.equal(later.pending.get('디코').count, 1);
});

test('사람이 끈 대상은 --auto가 건너뛰고, 명시 up(auto 아님)은 멈춤을 풀며 죽은 창만 치운다', () => {
  const home = tmp('stop');
  assert.ok(markStopped(home, '디코'));
  assert.equal(markStopped(home, '작업자'), null, '4개 밖의 역할은 표시하지 않는다');
  assert.deepEqual(Object.keys(readReviveState(home).targets), ['디코']);
  const {ops, calls} = fakeOps({'kadan-비서': {}, 'kadan-대시보드': {}, 'kadan-watch': {}});
  const prep = prepareRevive({home, auto: true, now: T0, ops});
  assert.ok(prep.skip.has('디코'));
  assert.equal(prep.pending.size, 0);
  assert.equal(calls.records.length, 0);
  // 명시 up
  assert.equal(clearForUp(home), true);
  const dead = fakeOps({'kadan-디코': {dead: true, screen: '화면'}});
  const manual = prepareRevive({home, auto: false, now: T0, ops: dead.ops});
  assert.deepEqual(dead.calls.killed, ['kadan-디코'], '명시 up도 죽은 창은 치워야 다시 뜬다');
  assert.equal(manual.pending.size, 0, '명시 up은 상한·기록을 쓰지 않는다');
  assert.equal(dead.calls.records.length + dead.calls.notices.length, 0);
});

test('비서·대시보드가 대상 밖 조건(감시 프로필·디코 비밀값 없음)이면 감시기·다리는 건너뛴다', () => {
  const home = tmp('na'), {ops} = fakeOps({}, {applicable: target => !['watch', '디코'].includes(target)});
  const prep = prepareRevive({home, auto: true, now: T0, ops});
  assert.deepEqual([...prep.pending.keys()].sort(), ['대시보드', '비서']);
  assert.deepEqual([...prep.skip].sort(), ['watch', '디코']);
});

test('띄우지 못한 결과(막힘·실패)는 센 횟수에 넣지 않고, 같은 결과를 매분 다시 기록하지 않는다', () => {
  const home = tmp('fail'), {ops, calls} = fakeOps({'kadan-비서': {}, 'kadan-대시보드': {}, 'kadan-watch': {}});
  for (let i = 0; i < 5; i++) {
    const now = T0 + i * 60_000;
    finishRevive({home, pending: prepareRevive({home, auto: true, now, ops}).pending, results: {디코: 'failed'}, now, ops});
  }
  assert.equal(calls.records.length, 1);
  assert.equal(calls.notices.length, 0);
  assert.equal(readReviveState(home).history.디코, undefined);
});

test('출력은 바뀐 것이 있을 때만: 같은 줄은 한 번, 달라지면 다시, 조용해지면 비운다', () => {
  const home = tmp('out');
  assert.deepEqual(changedOutput(home, ['비서: 확인 필요']), ['비서: 확인 필요']);
  assert.deepEqual(changedOutput(home, ['비서: 확인 필요']), []);
  assert.deepEqual(changedOutput(home, []), []);
  assert.deepEqual(changedOutput(home, ['비서: 확인 필요']), ['비서: 확인 필요']);
});

test('동시 실행 잠금: 잡혀 있으면 자동은 건너뛰고(null), 해제하면 다시 얻고, 주인이 죽은 잠금은 넘겨받는다', () => {
  const home = tmp('lock');
  const release = acquireReviveLock(home);
  assert.equal(typeof release, 'function');
  assert.equal(acquireReviveLock(home), null, '자동 실행은 이번 회차를 건너뛴다');
  assert.equal(acquireReviveLock(home, {waitMs: 300, sleep: () => {}}), null, '기다려도 안 풀리면 null');
  release();
  const again = acquireReviveLock(home);
  assert.equal(typeof again, 'function');
  again();
  // 주인이 없는 잠금(프로세스 죽음)
  fs.symlinkSync(JSON.stringify({pid: 999999, startedAt: 1}), path.join(home, 'revive.lock2'));
  assert.equal(typeof acquireReviveLock(home), 'function');
});

test('scrubScreen: 웹훅 주소·토큰 모양을 가린다', () => {
  assert.doesNotMatch(scrubScreen('x https://discord.com/api/webhooks/1/zzzz y'), /webhooks\/1\/zzzz/);
});

// ---------- 다리 조회 루프: 연결 단계 실패에 안 죽는다 ----------
const connectError = () => { const e = new TypeError('fetch failed'); e.cause = {code: 'ECONNREFUSED'}; return e; };
test('다리 루프: 연결 실패가 이어져도 상한 전까지 안 죽고(두 배씩 기다림, 최대 60초), 복구되면 이어 돈다', async () => {
  const fake = await startFakeDiscord();
  try {
    const home = tmp('loop1');
    const botFile = path.join(home, 'bot.env'), hookFile = path.join(home, 'hook.env');
    fs.writeFileSync(botFile, `DISCORD_BOT_TOKEN=${FAKE.token}\nDISCORD_APPLICATION_ID=${FAKE.appId}\n`, {mode: 0o600});
    fs.writeFileSync(hookFile, `DISCORD_USER_ID=${FAKE.userId}\nDISCORD_SECRETARY_CHANNEL_ID=${FAKE.channelId}\n`, {mode: 0o600});
    const env = {KADAN_SECRET_DISCORD_BOT_FILE: botFile, KADAN_SECRET_DISCORD_FILE: hookFile, KADAN_DISCORD_API_BASE: fake.base, KADAN_NOTIFY: 'off'};
    let clock = 1_000_000, down = true;
    const sleeps = [], errs = [];
    const controller = new AbortController();
    const fetchFn = async (...args) => { if (down) throw connectError(); return globalThis.fetch(...args); };
    const sleep = async ms => {
      sleeps.push(ms); clock += ms;
      if (sleeps.length === 7) down = false; // 7번 기다린 뒤 네트워크가 돌아온다
      if (sleeps.length >= 9) controller.abort();
    };
    const chat = createChat({home, env, fetchFn, sleep: async () => {}, now: () => clock});
    const result = await runWatch(chat, {intervalS: 5, out() {}, err: l => errs.push(l), sleep, signal: controller.signal});
    assert.equal(result, 'done', '프로세스가 죽지 않고 정상 종료 사유로 끝난다');
    assert.deepEqual(sleeps.slice(0, 7).map(ms => ms / 1000), [5, 10, 20, 40, 60, 60, 60]);
    assert.equal(errs.filter(e => /^연결 실패\(ECONNREFUSED\)/.test(e)).length, 7);
    assert.ok(sleeps.length >= 8, '복구 뒤에는 조회 주기(5초)로 이어 돈다');
    assert.equal(sleeps[7], 5000);
    // 복구 뒤 새 실패는 처음(5초)부터 센다 — 한 번 성공하면 이어진 시간을 다시 센다
    assert.ok(fs.existsSync(path.join(home, 'discord-chat-state.json')));
  } finally { await fake.close(); }
});

test('다리 루프: 연결 실패가 상한(10분)을 넘으면 지금처럼 멈춘다', async () => {
  const fake = await startFakeDiscord();
  try {
    const home = tmp('loop2');
    const botFile = path.join(home, 'bot.env'), hookFile = path.join(home, 'hook.env');
    fs.writeFileSync(botFile, `DISCORD_BOT_TOKEN=${FAKE.token}\n`, {mode: 0o600});
    fs.writeFileSync(hookFile, `DISCORD_USER_ID=${FAKE.userId}\nDISCORD_SECRETARY_CHANNEL_ID=${FAKE.channelId}\n`, {mode: 0o600});
    const env = {KADAN_SECRET_DISCORD_BOT_FILE: botFile, KADAN_SECRET_DISCORD_FILE: hookFile, KADAN_DISCORD_API_BASE: fake.base, KADAN_NOTIFY: 'off'};
    let clock = 1_000_000, slept = 0;
    const fetchFn = async () => { throw connectError(); };
    const chat = createChat({home, env, fetchFn, sleep: async () => {}, now: () => clock});
    await assert.rejects(runWatch(chat, {intervalS: 5, out() {}, err() {}, sleep: async ms => { slept += ms; clock += ms; }}),
      error => error instanceof DiscordError && error.exhausted && error.code === 'ECONNREFUSED');
    assert.ok(slept > CONNECT_OUTAGE_MS - 60_000 && slept <= CONNECT_OUTAGE_MS + 60_000, `기다린 시간 ${slept}ms가 상한 근처`);
  } finally { await fake.close(); }
});

test('다리 루프: 복구된 뒤 다시 끊기면 이어진 시간을 처음부터 센다', async () => {
  const fake = await startFakeDiscord();
  try {
    const home = tmp('loop3');
    const botFile = path.join(home, 'bot.env'), hookFile = path.join(home, 'hook.env');
    fs.writeFileSync(botFile, `DISCORD_BOT_TOKEN=${FAKE.token}\n`, {mode: 0o600});
    fs.writeFileSync(hookFile, `DISCORD_USER_ID=${FAKE.userId}\nDISCORD_SECRETARY_CHANNEL_ID=${FAKE.channelId}\n`, {mode: 0o600});
    const env = {KADAN_SECRET_DISCORD_BOT_FILE: botFile, KADAN_SECRET_DISCORD_FILE: hookFile, KADAN_DISCORD_API_BASE: fake.base, KADAN_NOTIFY: 'off'};
    let clock = 1_000_000, mode = 'down1';
    const sleeps = [];
    const controller = new AbortController();
    const fetchFn = async (...a) => { if (mode.startsWith('down')) throw connectError(); return globalThis.fetch(...a); };
    const sleep = async ms => {
      sleeps.push(ms); clock += ms;
      const n = sleeps.length;
      if (n === 5) mode = 'up';         // 5초 5번(5+10+20+40+60=135초) 뒤 복구
      if (n === 7) mode = 'down2';      // 복구 뒤 다시 끊김
      if (n === 10) { mode = 'up'; controller.abort(); }
    };
    const chat = createChat({home, env, fetchFn, sleep: async () => {}, now: () => clock});
    await runWatch(chat, {intervalS: 5, out() {}, err() {}, sleep, signal: controller.signal});
    assert.deepEqual(sleeps.slice(0, 5).map(ms => ms / 1000), [5, 10, 20, 40, 60]);
    // 두 번째 끊김은 다시 5초부터
    const second = sleeps.slice(7, 10).map(ms => ms / 1000);
    assert.equal(second[0], 5);
    assert.deepEqual(second.slice(0, 3), [5, 10, 20]);
  } finally { await fake.close(); }
});

test('다리 루프: once(짧게 끝나는 실행)는 기다리지 않고 지금처럼 바로 던진다', async () => {
  const fake = await startFakeDiscord();
  try {
    const home = tmp('loop4');
    const botFile = path.join(home, 'bot.env'), hookFile = path.join(home, 'hook.env');
    fs.writeFileSync(botFile, `DISCORD_BOT_TOKEN=${FAKE.token}\n`, {mode: 0o600});
    fs.writeFileSync(hookFile, `DISCORD_USER_ID=${FAKE.userId}\nDISCORD_SECRETARY_CHANNEL_ID=${FAKE.channelId}\n`, {mode: 0o600});
    const env = {KADAN_SECRET_DISCORD_BOT_FILE: botFile, KADAN_SECRET_DISCORD_FILE: hookFile, KADAN_DISCORD_API_BASE: fake.base, KADAN_NOTIFY: 'off'};
    let slept = 0;
    const chat = createChat({home, env, fetchFn: async () => { throw connectError(); }, sleep: async () => {}});
    await assert.rejects(runWatch(chat, {once: true, intervalS: 5, out() {}, err() {}, sleep: async ms => { slept += ms; }}), error => error.exhausted);
    assert.equal(slept, 0);
  } finally { await fake.close(); }
});

test('다리 루프: 4xx·연결 뒤 끊김은 기다리지 않고 지금처럼 멈춘다', async () => {
  const fake = await startFakeDiscord();
  try {
    const home = tmp('loop5');
    const botFile = path.join(home, 'bot.env'), hookFile = path.join(home, 'hook.env');
    fs.writeFileSync(botFile, `DISCORD_BOT_TOKEN=${FAKE.token}\n`, {mode: 0o600});
    fs.writeFileSync(hookFile, `DISCORD_USER_ID=${FAKE.userId}\nDISCORD_SECRETARY_CHANNEL_ID=${FAKE.channelId}\n`, {mode: 0o600});
    const env = {KADAN_SECRET_DISCORD_BOT_FILE: botFile, KADAN_SECRET_DISCORD_FILE: hookFile, KADAN_DISCORD_API_BASE: fake.base, KADAN_NOTIFY: 'off'};
    let slept = 0;
    const unauthorized = async () => new Response(JSON.stringify({message: '401: Unauthorized', code: 0}), {status: 401, headers: {'content-type': 'application/json'}});
    const chat = createChat({home, env, fetchFn: unauthorized, sleep: async () => {}});
    await assert.rejects(runWatch(chat, {intervalS: 5, out() {}, err() {}, sleep: async ms => { slept += ms; }}), error => error.kind === 'http' && error.status === 401);
    assert.equal(slept, 0, '4xx는 연결 실패가 아니라 기다리지 않는다');
  } finally { await fake.close(); }
});

// ---------- 2라운드 검수 수정 ----------
test('F1: 세션에 죽은 창과 살아 있는 창이 섞여 있으면(또는 조회 실패) 지우지 않고 막힘 알림 통로로 한 번 알린다', () => {
  for (const panes of ['mixed', 'unknown']) {
    const home = tmp(`f1-${panes}`), {ops, calls} = fakeOps({'kadan-비서': {}, 'kadan-대시보드': {}, 'kadan-watch': {}, 'kadan-디코': {panes}});
    for (let i = 0; i < 4; i++) prepareRevive({home, auto: true, now: T0 + i * 60_000, ops});
    assert.deepEqual(calls.killed, [], `${panes}: 세션을 지우지 않는다`);
    assert.equal(calls.captured.length, 0);
    assert.equal(calls.notices.filter(n => n.ring === true).length, 1, `${panes}: 알림은 한 번`);
    assert.equal(calls.records.length, 0);
  }
  // 명시 up도 지우지 않는다
  const home = tmp('f1-manual'), {ops, calls} = fakeOps({'kadan-디코': {panes: 'mixed'}});
  prepareRevive({home, auto: false, now: T0, ops});
  assert.deepEqual(calls.killed, []);
});

test('F3: 잠금 회수 — 주인이 죽었거나(좀비 포함) 주인 정보가 깨진 잠금은 되찾고, 산 주인은 둔다', () => {
  const reasons = [];
  const make = (home, target) => fs.symlinkSync(target, path.join(home, 'revive.lock2'));
  const owner = pid => JSON.stringify({pid, startedAt: 1});
  // 주인 정보가 깨진 잠금 → 회수
  let home = tmp('f3a'); make(home, 'abc');
  assert.equal(typeof acquireReviveLock(home, {onReclaim: r => reasons.push(r)}), 'function');
  // 산 주인 → 유지(오래돼도)
  home = tmp('f3d'); make(home, owner(4242));
  assert.equal(acquireReviveLock(home, {isAlive: pid => pid === 4242, onReclaim: r => reasons.push(r)}), null);
  // 죽은(좀비로 보이는) 주인 → 회수
  home = tmp('f3e'); make(home, owner(4243));
  assert.equal(typeof acquireReviveLock(home, {isAlive: () => false, onReclaim: r => reasons.push(r)}), 'function');
  assert.equal(reasons.length, 2);
  assert.match(reasons[1], /죽었다/);
});

test('F4: 상태 파일이 깨졌으면 --auto는 모두 건너뛰고 울림 1번(같은 파일이면 다시 안 울림), 파일은 그대로 둔다. 사람이 친 up은 .trash로 옮기고 새로 시작', () => {
  const home = tmp('f4'), {ops, calls} = fakeOps({});
  const file = path.join(home, 'revive-state.json');
  fs.writeFileSync(file, '{"targets": {"디코": {"state": "stopped"');
  const first = prepareRevive({home, auto: true, now: T0, ops});
  assert.equal(first.corrupt, true);
  assert.deepEqual([...first.skip].sort(), [...TARGETS].sort());
  assert.equal(first.pending.size, 0);
  assert.equal(calls.notices.filter(n => n.ring === true).length, 1);
  prepareRevive({home, auto: true, now: T0 + 60_000, ops});
  assert.equal(calls.notices.length, 1, '같은 손상은 다시 울리지 않는다');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"targets": {"디코": {"state": "stopped"', '자동 실행은 깨진 파일을 건드리지 않는다');
  assert.equal(calls.records.length + calls.killed.length, 0);
  // 파일이 다시 다른 모양으로 깨지면 다시 한 번 알린다
  fs.writeFileSync(file, 'not json at all');
  prepareRevive({home, auto: true, now: T0 + 120_000, ops});
  assert.equal(calls.notices.length, 2);
  // 사람이 친 up
  assert.equal(clearForUp(home), true);
  assert.ok(!fs.existsSync(file));
  assert.equal(fs.readdirSync(path.join(home, '.trash')).filter(f => f.startsWith('revive-state-')).length, 1);
  assert.equal(readReviveState(home).corrupt, undefined);
  // 사람이 친 stop도 깨진 파일을 옮기고 새로 표시한다
  fs.writeFileSync(file, '[1,2');
  assert.ok(markStopped(home, '디코'));
  assert.equal(readReviveState(home).targets.디코.state, 'stopped');
  assert.ok(recoverCorruptState(home) === null);
});

test('F2: markStopped/unmarkStopped — 끄기 실패 시 이전 표시로 되돌린다', () => {
  const home = tmp('f2');
  const token = markStopped(home, '디코');
  assert.equal(readReviveState(home).targets.디코.state, 'stopped');
  unmarkStopped(home, '디코', token);
  assert.equal(readReviveState(home).targets.디코, undefined);
  markStopped(home, '디코');
  const again = markStopped(home, '디코');
  unmarkStopped(home, '디코', again);
  assert.equal(readReviveState(home).targets.디코.state, 'stopped', '이전에도 멈춤이었으면 그대로 둔다');
});

test('F5: 조용한 되살림 알림은 디코로 못 보내도 사건·로그에 남기고, 맥 알림으로 넘어가지 않는다(notifyUser systemFallback:false)', async () => {
  const {notifyUser} = await import('../src/user-notify.mjs');
  const spawned = [];
  const spawn = (...args) => { spawned.push(args); return {status: 0, stdout: ''}; };
  const env = {...process.env, KADAN_NOTIFY: 'off'};
  const quiet = notifyUser('조용한 알림', spawn, {env, systemFallback: false});
  assert.equal(spawned.length, 0, '맥 알림 0회');
  assert.equal(quiet.via, 'none');
  assert.equal(quiet.error, null);
  const loud = notifyUser('울림 경보', spawn, {env, ring: true});
  assert.equal(spawned.length, 1, '기본 동작은 그대로 맥 알림으로 대신한다');
  assert.equal(loud.via, 'system');
  // finishRevive: 알림이 디코로 안 갔으면 사건에 notice를 남긴다
  const home = tmp('f5'), {ops, calls} = fakeOps({'kadan-비서': {}, 'kadan-대시보드': {}, 'kadan-watch': {}},
    {notify: () => ({via: 'none', reason: '디코 알림 설정 없음 또는 실패'})});
  const prep = prepareRevive({home, auto: true, now: T0, ops});
  const lines = finishRevive({home, pending: prep.pending, results: {디코: 'started'}, now: T0, ops});
  assert.equal(calls.records[0].notice, 'none');
  assert.match(calls.records[0].noticeReason, /디코/);
  assert.match(lines.join(), /조용한 알림을 디코로 보내지 못했습니다/);
});

test('R2-F4: 구조가 틀린 상태 파일(최상위 배열, targets가 null·문자열·배열, history 값이 배열 아님)은 손상이고, 필드가 없는 정상 파일은 정상이다', () => {
  const home = tmp('shape');
  const file = path.join(home, 'revive-state.json');
  const read = text => { fs.writeFileSync(file, text); return readReviveState(home); };
  assert.equal(read('[]').corrupt, true, '최상위가 배열');
  assert.equal(read('"x"').corrupt, true, '최상위가 문자열');
  assert.equal(read('null').corrupt, true, '최상위가 null');
  assert.equal(read('{"targets":null}').corrupt, true, 'targets가 null');
  assert.equal(read('{"targets":"stopped"}').corrupt, true, 'targets가 문자열');
  assert.equal(read('{"targets":[]}').corrupt, true, 'targets가 배열');
  assert.equal(read('{"history":{"디코":"x"}}').corrupt, true, 'history 값이 배열 아님');
  assert.equal(read('{"history":{"디코":[1,"a"]}}').corrupt, true, 'history 안이 숫자 아님');
  assert.equal(read('{"blocked":[]}').corrupt, true);
  assert.equal(read('{"targets":{"디코":"stopped"}}').corrupt, true, 'targets 값이 객체 아님');
  assert.equal(read('{}').corrupt, undefined, '필드가 없는 정상 파일');
  assert.equal(read('{"targets":{"디코":{"state":"stopped"}},"history":{"디코":[1,2]}}').corrupt, undefined);
  // 손상으로 보면 --auto는 전체를 건너뛰고 울림 1번, 사람이 친 stop은 .trash로 옮기고 표시를 저장한다
  fs.writeFileSync(file, '{"targets":[]}');
  const {ops, calls} = fakeOps({});
  const prep = prepareRevive({home, auto: true, now: T0, ops});
  assert.equal(prep.corrupt, true);
  assert.equal(calls.notices.filter(n => n.ring === true).length, 1);
  assert.ok(markStopped(home, '대시보드'));
  assert.equal(readReviveState(home).targets.대시보드.state, 'stopped');
  assert.equal(fs.readdirSync(path.join(home, '.trash')).filter(f => f.startsWith('revive-state-')).length, 1);
});
