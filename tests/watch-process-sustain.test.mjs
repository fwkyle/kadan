import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {runWatch} from './helpers/watch-runner.mjs';

// 큰 프로세스 경보는 같은 PID가 오래 넘을 때만. 가짜 시계(60초 간격)·가짜 ps/tmux·격리 홈만 쓴다.
const lt = n => [...String(n)].map(d => 'ghijklmnop'[d]).join('');
const epoch = Date.parse('2026-11-02T00:00:00.000Z');
const stamp = cycle => new Date(epoch + cycle * 60_000).toISOString();
const parents = new Map([['p-작업자', 'p-감독'], ['p-감독', 'p-슈퍼감독'], ['p-슈퍼감독', '@user']]);
const starts = [...parents.keys()].map((role, i) => ({kind: 'start', role, session: `kadan-${role}`, panePid: i + 1, t: stamp(0)}));
const MB = 1024;

// plan[cycle] = 그 주기에 서버 아래 있는 node PID 목록(각 1.5G). 합계는 12G 아래로 둔다.
function psFor(pids) {
  const lines = ['  100     1   2048  05:00:00 /usr/bin/tmux', '  200   100   4096  05:00:00 /bin/zsh'];
  for (const pid of pids) lines.push(`  ${pid}   200 ${1536 * MB} 01:00 /usr/bin/node`);
  return lines.join('\n');
}

async function simulate(plan, {entries = starts} = {}) {
  let cycle = 0;
  const stop = Error('end'), sent = [], records = [], notified = [];
  await assert.rejects(() => runWatch({
    floor: {list: () => starts.map(s => ({session: s.session, pid: s.panePid})), read: () => `정상 작업 ${lt(cycle)}`},
    readEntries: () => entries, readCards: () => [], parents,
    intervalMs: 60_000, stallN: 2, routes: {p: 'p-감독'}, superRole: 'p-슈퍼감독', userNotify: true, processEveryMs: 0,
    now: () => epoch + cycle * 60_000, record: e => records.push(e), print: () => {},
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
  return {sent, notified: notified.filter(m => /프로세스/.test(m)), alerts};
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

test('재시작: 오래 넘은 PID 목록이 적힌 열린 경보로 시작하면 같은 PID가 이어지는 동안 해소·재경보·새 알림 0건', async () => {
  const r = await simulate(range(0, 8).map(() => [300]), {entries: [...starts, open({pids: [300]})]});
  assert.deepEqual(r.notified, []);
  assert.deepEqual(r.alerts, [], '해소 기록도 새 경보 기록도 없다');
});

test('재시작 대조: 목록이 없는 옛 경보는 채우지 않아 평소대로 3주기 뒤 닫힌다', async () => {
  const r = await simulate(range(0, 5).map(() => [300]), {entries: [...starts, open()]});
  assert.deepEqual(r.alerts.map(a => !!a.resolved), [true]);
});
