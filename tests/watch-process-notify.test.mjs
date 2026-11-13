import './helpers/isolated-home.mjs';
import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {stopChild} from './helpers/child-cleanup.mjs';
import {runWatch} from './helpers/watch-runner.mjs';
import {resetDiscordBlock, NOTIFY_LOG_FILE} from '../src/user-notify.mjs';

// 한 사고(경보가 열린 시각) = 디코 글 하나. 공통 notifyUser(정책·중복 막기·글 고치기)까지 지나게 하고,
// 가짜 웹훅 서버가 받은 요청을 새 글(POST)·고치기(PATCH)·멘션으로 나눠 센다. 가짜 값만 쓴다.
const helper = new URL('./helpers/fake-webhook.mjs', import.meta.url).pathname;
const live = [];
const saved = {};
const ENV = ['KADAN_NOTIFY', 'KADAN_NOTIFY_ENV_FILE', 'KADAN_HOME'];
afterEach(async () => {
  await Promise.all(live.map(c => stopChild(c)));
  live.length = 0;
  for (const k of ENV) if (k in saved) { saved[k] === undefined ? delete process.env[k] : process.env[k] = saved[k]; delete saved[k]; }
});

const lt = n => [...String(n)].map(d => 'ghijklmnop'[d]).join('');
const t = '2026-10-31T00:00:00.000Z';
const parents = new Map([['p-작업자', 'p-감독'], ['p-감독', 'p-슈퍼감독'], ['p-슈퍼감독', '@user']]);
const starts = [...parents.keys()].map((role, i) => ({kind: 'start', role, session: `kadan-${role}`, panePid: i + 1, t}));
// 합계 13G(RED)·node 31개(10분 이어지면 개수 신호). R=둘 다, r=합계만, a=개수만(AMBER), n=정상.
const R = {nodeMb: 13 * 1024, nodes: 31}, r = {nodeMb: 13 * 1024, nodes: 1}, a = {nodeMb: 100, nodes: 31}, n = {nodeMb: 100, nodes: 1};
const psFor = ({nodeMb, nodes}) => ['  100     1   2048  05:00:00 /usr/bin/tmux', '  200   100   4096  05:00:00 /bin/zsh',
  ...Array.from({length: nodes}, (_, i) => `  ${300 + i}   200 ${i === 0 ? nodeMb * 1024 : 1024} 01:00 /usr/bin/node`)].join('\n');

// 시험마다 새 홈(알림 기록·글 장부)과 새 가짜 웹훅. 웹훅은 메시지 id를 돌려줘야 글 장부에 남고 고치기를 할 수 있다.
async function world() {
  resetDiscordBlock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-process-notify-'));
  const home = path.join(dir, 'home'), logFile = path.join(dir, 'requests.jsonl');
  fs.mkdirSync(home);
  const child = spawn(process.execPath, [helper, logFile, JSON.stringify([{status: 200, body: {id: 'M1', channel_id: 'C1'}}])],
    {stdio: ['ignore', 'pipe', 'inherit']});
  live.push(child);
  const port = await new Promise(resolve => child.stdout.once('data', d => resolve(Number(String(d).match(/PORT (\d+)/)[1]))));
  const envFile = path.join(dir, 'secret.env');
  fs.writeFileSync(envFile, `DISCORD_WEBHOOK_URL=http://127.0.0.1:${port}/api/webhooks/111/FAKETOKEN-abc123\nDISCORD_USER_ID="424242424242"\n`);
  for (const k of ENV) saved[k] = process.env[k];
  process.env.KADAN_NOTIFY = ''; process.env.KADAN_NOTIFY_ENV_FILE = envFile; process.env.KADAN_HOME = home;
  const requests = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : []).map(l => {
    const q = JSON.parse(l), body = JSON.parse(q.body);
    return {edit: /\/messages\//.test(q.url), mention: (body.allowed_mentions?.users ?? []).length > 0, content: body.content};
  });
  // 세는 값: 새 글 수, 그중 멘션(울림) 수, 고치기 수.
  const counts = () => {
    const all = requests(), posts = all.filter(q => !q.edit);
    return {posts: posts.length, rings: posts.filter(q => q.mention).length, edits: all.length - posts.length};
  };
  const log = () => fs.readFileSync(path.join(home, NOTIFY_LOG_FILE), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  return {home, requests, counts, log};
}

// node 개수는 10분 넘게 이어질 때만 신호라서, jump번째 주기부터 가짜 시계를 10분 앞으로 보낸다(알림 중복 막기는 진짜 시계라 영향 없음).
// baseMs: 재시작 뒤 실행이 앞 실행보다 뒤 시각에서 돌게 한다.
async function run(samples, entries, records, {jump = 3, baseMs = 0, osCalls = []} = {}) {
  let cycle = 0;
  const stop = Error('end');
  await assert.rejects(() => runWatch({
    floor: {list: () => starts.map(s => ({session: s.session, pid: s.panePid})), read: () => `정상 작업 ${lt(cycle)}`},
    readEntries: () => entries, readCards: () => [], parents,
    intervalMs: 1000, stallN: 2, routes: {p: 'p-감독'}, superRole: 'p-슈퍼감독', userNotify: true, processEveryMs: 0,
    now: () => Date.parse(t) + baseMs + cycle * 1000 + (cycle >= jump ? 10 * 60_000 : 0), record: e => records.push(e), print: () => {},
    sendAlert: () => {},
    spawn: (command, args) => {
      if (command === 'sleep') { if (++cycle === samples.length) throw stop; return {status: 0, stdout: ''}; }
      if (command === 'tmux') return {status: 0, stdout: '100 s 200\n'};
      if (command === 'ps') return {status: 0, stdout: psFor(samples[cycle])};
      if (command === 'osascript') osCalls.push(args.join(' '));
      return {status: 0, stdout: ''};
    },
  }), error => error === stop);
}
const processAlerts = records => records.filter(e => e.kind === 'alert' && e.alertKind === '프로세스');

test('RED↔AMBER를 오가도 글은 1개·울림 1번이고, 바뀔 때마다 그 글만 고친다', async () => {
  const w = await world();
  const records = [], osCalls = [];
  // 열림(합계) → 개수 신호 추가 → 개수만(AMBER) → 다시 RED → AMBER → RED
  await run([R, R, R, R, a, R, a, R], starts, records, {osCalls});
  assert.deepEqual(w.counts(), {posts: 1, rings: 1, edits: 5});
  const [first, ...edits] = w.requests();
  assert.match(first.content, /^<@424242424242> \[감시sh \d\d:\d\d\] 메모리 13\.0G \/ 기준 12G \(카단 세션 1개 · 그 아래 프로세스 33개\)/, '첫 줄이 결론');
  assert(!first.content.includes('node#300'), 'PID 목록은 디코 글에 없다');
  assert(edits.every(q => q.edit && !q.mention), '고치기에는 멘션이 없다');
  assert.match(edits[1].content, /카단 세션 1개 · 그 아래 node 프로세스 31개 \/ 기준 30개/, 'AMBER가 되면 그 상태로 고친다');
  assert.deepEqual(osCalls, [], '맥 알림 없음');
  // 원장에는 전이마다 줄이 남고 세션·PID 목록 전체는 text에 그대로 있다(대시보드·복원이 읽는다). since는 한 사고 내내 같다.
  const lines = processAlerts(records);
  assert.equal(lines.length, 6);
  assert.equal(new Set(lines.map(e => e.since)).size, 1);
  assert.match(lines[0].text, /상위 세션 s 13\.0G\(프로세스 32개: node#300 13\.0G/);
  const keys = w.log().filter(e => e.kind === 'alert' && e.outcome === 'sent').map(e => e.key);
  assert.deepEqual(keys, [`alert:process:memory:${lines[0].since}`], '키는 등급·기준이 아니라 사고가 열린 시각');
});

test('AMBER(개수 기준만)로 열렸다 닫히면 디코 요청 0건·맥 알림 0건이고, 원장과 알림 기록에는 남는다', async () => {
  const w = await world();
  const records = [], osCalls = [];
  await run([a, a, a, a, a, n, n, n, n], starts, records, {osCalls});
  assert.deepEqual(w.counts(), {posts: 0, rings: 0, edits: 0});
  assert.deepEqual(osCalls, []);
  assert.deepEqual(processAlerts(records).map(e => [e.level, !!e.resolved]), [['AMBER', false], ['AMBER', true]], '대시보드가 읽는 원장 줄은 그대로');
  const skips = w.log().filter(e => e.outcome === 'policy-skip');
  assert.equal(skips.length, 1);
  assert.match(skips[0].reason, /AMBER/);
});

test('AMBER로 열린 사고가 RED가 되면 그때 새 글 1개·울림 1번(AMBER 건너뛰기가 키를 쓰지 않는다)', async () => {
  const w = await world();
  const records = [];
  await run([a, a, a, a, R, a, R], starts, records);
  assert.deepEqual(w.counts(), {posts: 1, rings: 1, edits: 2}, 'RED에서 새 글, 그 뒤 AMBER·RED는 고치기');
  const lines = processAlerts(records);
  assert.deepEqual(lines.map(e => e.level), ['AMBER', 'RED', 'AMBER', 'RED']);
  const log = w.log().filter(e => e.key === `alert:process:memory:${lines[0].since}`);
  assert.deepEqual(log.map(e => e.outcome), ['policy-skip', 'sent'], '같은 키: AMBER는 건너뜀, RED는 보냄');
});

test('닫힌 뒤 다시 열리면 새 사고라 새 글이 간다(앞 글은 해결됨으로 고친다)', async () => {
  const w = await world();
  const records = [];
  await run([r, n, n, n, r, r], starts, records);
  assert.deepEqual(w.counts(), {posts: 2, rings: 2, edits: 1});
  assert.match(w.requests().find(q => q.edit).content, /✅ 해결됨/);
  const keys = w.log().filter(e => e.kind === 'alert' && e.outcome === 'sent').map(e => e.key);
  assert.equal(new Set(keys).size, 2, '사고마다 다른 키');
});

test('사고 중 감시기 재시작: 새 글·울림 0건 추가, 재시작 뒤 변화와 해결도 같은 글을 고친다', async () => {
  const w = await world();
  const records = [];
  await run([r, r], starts, records);
  assert.deepEqual(w.counts(), {posts: 1, rings: 1, edits: 0});
  // 재시작: 원장의 마지막 경보 줄로 복원한다. 같은 상태는 아무것도 보내지 않는다.
  const restored = [...starts, ...processAlerts(records).slice(-1)];
  await run([r, r, r], restored, [], {baseMs: 60_000});
  assert.deepEqual(w.counts(), {posts: 1, rings: 1, edits: 0}, '재시작 복원은 요청 0건');
  // 재시작 뒤 기준 집합이 바뀌고(개수 추가), AMBER로 내려가고, 닫힌다 — 메모리의 글 연결이 없어도 장부에서 같은 글을 찾는다.
  const after = [];
  await run([R, R, R, R, a, n, n, n, n], restored, after, {baseMs: 120_000});
  assert.deepEqual(w.counts(), {posts: 1, rings: 1, edits: 3});
  assert.match(w.requests().at(-1).content, /✅ 해결됨/);
  assert.equal(new Set([...processAlerts(records), ...processAlerts(after)].map(e => e.since)).size, 1, '재시작 뒤에도 같은 사고 시각');
});

test('사고 키에는 10분 창이 없다: 두 시간 전에 보낸 사고의 글 기록이 없어도 다시 울리지 않는다', async () => {
  const w = await world();
  const since = Date.parse(t);
  fs.writeFileSync(path.join(w.home, NOTIFY_LOG_FILE), JSON.stringify({at: new Date(Date.now() - 2 * 3600_000).toISOString(),
    key: `alert:process:memory:${since}`, kind: 'alert', via: 'discord', outcome: 'sent'}) + '\n');
  const open = {kind: 'alert', id: 'process:memory', alertKind: '프로세스', level: 'RED', signals: ['total'], text: 'x', since,
    recipient: '@user', delivered: true, t};
  const records = [];
  // 복원한 사고(합계)에 큰 프로세스·개수 신호가 더해져 다시 알릴 차례가 와도, 같은 사고 키로 이미 보냈으므로 새 글은 없다.
  await run([R, R, R, R, R], [...starts, open], records);
  assert.deepEqual(processAlerts(records).map(e => e.signals.join('+')), ['total+process+node'], '집합이 바뀐 줄은 원장에 남는다');
  assert.deepEqual(w.counts(), {posts: 0, rings: 0, edits: 0});
});
