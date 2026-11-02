import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {runWatch} from './helpers/watch-runner.mjs';

// 큰 프로세스 경보는 같은 PID가 오래 넘을 때만. 가짜 시계(60초 간격)·가짜 ps/tmux·격리 홈만 쓴다.
const lt = n => [...String(n)].map(d => 'ghijklmnop'[d]).join('');
const epoch = Date.parse('2026-11-02T00:00:00.000Z');
const stamp = cycle => new Date(epoch + cycle * 60_000).toISOString();
const parents = new Map([['p-작업자', 'p-감독'], ['p-감독', 'p-슈퍼감독'], ['p-슈퍼감독', '@user']]);
const starts = [...parents.keys()].map((role, i) => ({kind: 'start', role, session: `kadan-${role}`, panePid: i + 1, t: stamp(0)}));
const MB = 1024;

// plan[cycle] = 그 주기에 서버 아래 있는 node PID 목록(각 1.5G). 합계는 12G 아래로 둔다.
// 항목은 PID 숫자 또는 {pid, etime}. etime을 안 주면 1분 된 프로세스다.
function psFor(pids) {
  const lines = ['  100     1   2048  05:00:00 /usr/bin/tmux', '  200   100   4096  05:00:00 /bin/zsh'];
  for (const item of pids) {
    const {pid, etime = '01:00'} = typeof item === 'number' ? {pid: item} : item;
    lines.push(`  ${pid}   200 ${1536 * MB} ${etime} /usr/bin/node`);
  }
  return lines.join('\n');
}

async function simulate(plan, {entries = starts, start = 0} = {}) {
  let cycle = 0;
  const stop = Error('end'), sent = [], records = [], notified = [];
  await assert.rejects(() => runWatch({
    floor: {list: () => starts.map(s => ({session: s.session, pid: s.panePid})), read: () => `정상 작업 ${lt(cycle)}`},
    readEntries: () => entries, readCards: () => [], parents,
    intervalMs: 60_000, stallN: 2, routes: {p: 'p-감독'}, superRole: 'p-슈퍼감독', userNotify: true, processEveryMs: 0,
    now: () => epoch + (start + cycle) * 60_000, record: e => records.push(e), print: () => {},
    sendAlert: (role, message, key) => sent.push({role, message, key}),
    spawn: (command, args) => {
      if (command === 'sleep') { if (++cycle === plan.length) throw stop; return {status: 0, stdout: ''}; }
      if (command === 'tmux') return {status: 0, stdout: '100 s 200\n'};
      if (command === 'ps') return {status: 0, stdout: psFor(plan[cycle])};
      if (command === 'osascript') notified.push(args.join(' '));
      return {status: 0, stdout: ''};
    },
  }), error => error === stop);
  const alerts = records.filter(r => r.kind === 'alert' && r.alertKind === '프로세스');
  return {sent, notified: notified.filter(m => /프로세스/.test(m)), alerts, records};
}

const range = (from, to) => Array.from({length: to - from}, (_, i) => from + i);

test('(a) 짧게 사는 큰 node가 차례로 나타났다 사라져도 경보·해소 알림 모두 0건', async () => {
  // PID 300(6주기) → 301(4주기) → 302(4주기): 모두 10분 미만, 마지막에 정상
  const plan = [...range(0, 6).map(() => [300]), ...range(0, 4).map(() => [301]), ...range(0, 4).map(() => [302]), [], [], []];
  const r = await simulate(plan);
  assert.deepEqual(r.notified, [], '사용자 알림 0건(열림도 해소도)');
  assert.deepEqual(r.alerts, [], '프로세스 경보 기록 0건');
  assert.deepEqual(r.sent, []);
});

test('(b) 대조: 같은 PID가 10분 넘게 붙어 있으면 열리고 @user에게 한 번 간다', async () => {
  const r = await simulate(range(0, 13).map(() => [300]));
  assert.equal(r.notified.length, 1);
  assert.match(r.notified[0], /node#300 1\.5G/);
  assert.equal(r.alerts.length, 1);
});

const open = (extra = {}) => ({
  kind: 'alert', id: 'process:memory', alertKind: '프로세스', level: 'RED', signals: ['process'],
  text: '카단 tmux 프로세스 2개·1.5G · 넘은 기준: 큰 프로세스', since: epoch, delivered: true, recipient: '@user', t: stamp(0), ...extra,
});

const aged = (pid, etime) => ({pid, etime});
const readLedger = records => [...starts, ...records];

test('재시작: 지금도 큰 PID의 나이가 지속 시간 이상이면 해소·재경보·새 알림 0건', async () => {
  const r = await simulate(range(0, 8).map(() => [aged(300, '20:00')]), {entries: [...starts, open()]});
  assert.deepEqual(r.notified, []);
  assert.deepEqual(r.alerts, [], '해소 기록도 새 경보 기록도 없다');
});

test('재시작 대조: 3분 된 3G 빌드만 있으면 채우지 않아 평소대로 3주기 뒤 닫힌다', async () => {
  const r = await simulate(range(0, 6).map(() => [aged(400, '03:00')]), {entries: [...starts, open()]});
  assert.deepEqual(r.alerts.map(a => !!a.resolved), [true]);
  assert.deepEqual(r.notified, []);
});

// 오래 넘은 PID가 A(300)→B(301)로 바뀌어도 신호·since·알림 키는 같다.
const swapPlan = Array.from({length: 18}, (_, i) => (i < 5 ? [300] : i < 16 ? [300, 301] : [301]));

test('F2 A꼴: 교대 동안 원장의 alert 줄은 실제 알림 수와 같은 1줄', async () => {
  const r = await simulate(swapPlan);
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].delivered, true);
  assert.equal(r.notified.length, 1);
});

test('F2 B꼴: 전달 못 한 열린 경보를 복원해도 새 알림 0건이고 원장 줄은 하나도 안 는다', async () => {
  const undelivered = open({delivered: false, recipient: null});
  const r = await simulate(range(0, 12).map(() => [aged(300, '20:00')]), {entries: [...starts, undelivered]});
  assert.deepEqual(r.alerts, [], '원장 delivered·recipient가 바뀔 일이 없다');
  assert.deepEqual(r.notified, []);
});

test('F1 꼴: A 0분·B 5분부터, A 16분에 사라지고 18분 재시작 — 해소·재경보·새 알림 0건', async () => {
  const before = await simulate(swapPlan);
  const after = await simulate(range(0, 12).map(() => [aged(301, '13:00')]), {entries: readLedger(before.alerts), start: 18});
  assert.deepEqual(after.alerts, []);
  assert.deepEqual(after.notified, []);
});

test('설정 20분: 재시작 때 나이 15분은 채우지 않아 닫히고, 25분은 채워 이어진다', async () => {
  const settings = path.join(process.env.KADAN_HOME, 'runner-settings.json');
  // 설정 파일은 모양이 맞아야 읽힌다(깨진 파일은 시작값으로 돈다). 모양: version·revision·activePreset·presets·runners.
  fs.writeFileSync(settings, JSON.stringify({version: 1, revision: 0, activePreset: 'p', presets: {p: {roles: {}}}, runners: {}, processWatch: {processSustainMin: 20}}));
  try {
    const young = await simulate(range(0, 6).map(() => [aged(300, '15:00')]), {entries: [...starts, open()]});
    assert.deepEqual(young.alerts.map(a => !!a.resolved), [true]);
    const old = await simulate(range(0, 6).map(() => [aged(300, '25:00')]), {entries: [...starts, open()]});
    assert.deepEqual(old.alerts, []);
  } finally { fs.rmSync(settings, {force: true}); }
});

test('같은 지속 PID가 이어지는 동안은 원장에 다시 쓰지 않는다', async () => {
  const r = await simulate(range(0, 20).map(() => [300]));
  assert.equal(r.alerts.length, 1);
});

// 디코 글 게시 성공 대역이 필요한 양성 대조는 모듈 대역 플래그가 있는 자식 프로세스에서 돈다.
test('양성 대조: 긴 PID는 alert→alert-resolved 각 1건, 짧은 PID 교대는 둘 다 0건', () => {
  const script = new URL('./helpers/process-sustain-posted.mjs', import.meta.url).pathname;
  const run = spawnSync(process.execPath, ['--experimental-test-module-mocks', script], {encoding: 'utf8', env: process.env});
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout.trim().split('\n').pop());
  assert.deepEqual(out.long, ['alert', 'alert-resolved']);
  assert.deepEqual(out.short, []);
});
