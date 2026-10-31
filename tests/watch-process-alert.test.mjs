import test from 'node:test';
import assert from 'node:assert/strict';
import {runWatch} from './helpers/watch-runner.mjs';

const lt = n => [...String(n)].map(d => 'ghijklmnop'[d]).join('');
const t = '2026-10-31T00:00:00.000Z';
const parents = new Map([['p-작업자', 'p-감독'], ['p-감독', 'p-슈퍼감독'], ['p-슈퍼감독', '@user']]);
const starts = [...parents.keys()].map((role, i) => ({kind: 'start', role, session: `kadan-${role}`, panePid: i + 1, t}));
const MB = 1024;
// 주기별 서버 아래 node RSS(MB)와 개수. 13GB 1개 → 집합 바뀜(node 개수 추가) → 정상 3번 → 닫힘.
const samples = [
  {nodeMb: 100, nodes: 1},
  {nodeMb: 13 * 1024, nodes: 1},
  {nodeMb: 13 * 1024, nodes: 1},
  {nodeMb: 13 * 1024, nodes: 31},
  {nodeMb: 100, nodes: 1},
  {nodeMb: 100, nodes: 1},
  {nodeMb: 100, nodes: 1},
];

function psFor(sample) {
  const lines = ['  100     1   2048  05:00:00 /usr/bin/tmux', '  200   100   4096  05:00:00 /bin/zsh'];
  for (let i = 0; i < sample.nodes; i++) lines.push(`  ${300 + i}   200 ${i === 0 ? sample.nodeMb * MB : MB} 01:00 /usr/bin/node`);
  return lines.join('\n');
}

test('프로세스 경보: 열림 → 같은 상태 반복 없음 → 기준 집합 바뀔 때만 다시 → 내려가면 닫힘, @user에게만', async () => {
  let cycle = 0;
  const stop = Error('end'), sent = [], records = [], psCalls = [];
  const notified = [];
  await assert.rejects(() => runWatch({
    floor: {list: () => starts.map(s => ({session: s.session, pid: s.panePid})), read: () => `정상 작업 ${lt(cycle)}`},
    readEntries: () => starts, readCards: () => [], parents,
    intervalMs: 1000, stallN: 2, routes: {p: 'p-감독'}, superRole: 'p-슈퍼감독', userNotify: true, processEveryMs: 0,
    now: () => Date.parse(t) + cycle * 1000, record: e => records.push(e), print: () => {},
    sendAlert: (role, message, key) => sent.push({role, message, key}),
    spawn: (command, args) => {
      if (command === 'sleep') { if (++cycle === samples.length) throw stop; return {status: 0, stdout: ''}; }
      if (command === 'tmux') return {status: 0, stdout: '100 s 200\n'};
      if (command === 'ps') { psCalls.push(args.join(' ')); return {status: 0, stdout: psFor(samples[cycle])}; }
      if (command === 'osascript') notified.push(args.join(' '));
      return {status: 0, stdout: ''};
    },
  }), error => error === stop);
  const mine = notified.filter(m => /프로세스/.test(m));
  // 열림 1번 + 집합이 바뀐 1번. 같은 상태의 반복(2번째 주기)은 없다.
  assert.equal(mine.length, 2, JSON.stringify(mine));
  assert.deepEqual(sent, [], 'AI 역할에게는 아무것도 보내지 않는다');
  assert.match(mine[0], /node#300 13\.0G/);
  assert.match(mine[1], /node 개수/);
  const alerts = records.filter(r => r.kind === 'alert' && r.alertKind === '프로세스');
  assert.deepEqual(alerts.map(r => !!r.resolved), [false, false, true], '열림, 집합 바뀜, 닫힘');
  const mineCalls = psCalls.filter(c => c.includes('rss='));
  assert.equal(mineCalls.length, samples.length, '주기마다 ps 1회');
  assert(mineCalls.every(c => c.includes('comm=') && !/args|command/.test(c)));
  assert(!JSON.stringify(records).includes('SECRET'));
});

test('tmux를 못 읽는 주기에는 경보도 해소도 만들지 않는다', async () => {
  let cycle = 0;
  const stop = Error('end'), records = [], sent = [];
  await assert.rejects(() => runWatch({
    floor: {list: () => starts.map(s => ({session: s.session, pid: s.panePid})), read: () => `정상 작업 ${lt(cycle)}`},
    readEntries: () => starts, readCards: () => [], parents,
    intervalMs: 1000, stallN: 2, routes: {p: 'p-감독'}, superRole: 'p-슈퍼감독', userNotify: true, processEveryMs: 0,
    now: () => Date.parse(t) + cycle * 1000, record: e => records.push(e), print: () => {},
    sendAlert: (role, message) => sent.push({role, message}),
    spawn: command => {
      if (command === 'sleep') { if (++cycle === 3) throw stop; return {status: 0, stdout: ''}; }
      if (command === 'tmux') return {status: 1, stdout: ''};
      return {status: 0, stdout: ''};
    },
  }), error => error === stop);
  assert.equal(records.filter(r => r.alertKind === '프로세스').length, 0);
  assert.equal(sent.length, 0);
});

test('프로세스 경보는 슈퍼감독이 살아 있어도 @user에게만 간다', async () => {
  const {routeAlert} = await import('../src/watch.mjs');
  assert.equal(routeAlert({id: 'process:memory', kind: '프로세스'}, new Map(), ['kadan-슈퍼'], '슈퍼'), '@user');
});
