import './helpers/isolated-home.mjs';
import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {stopChild} from './helpers/child-cleanup.mjs';
import {runWatch} from './helpers/watch-runner.mjs';
import {resetDiscordBlock} from '../src/user-notify.mjs';

// F2: 공통 notifyUser 중복 검사(같은 키 10분)까지 지나게 한다. 가짜 웹훅 서버가 받은 요청 수로 센다.
const helper = new URL('./helpers/fake-webhook.mjs', import.meta.url).pathname;
const live = [];
afterEach(async () => { await Promise.all(live.map(c => stopChild(c))); live.length = 0; });

const lt = n => [...String(n)].map(d => 'ghijklmnop'[d]).join('');
const t = '2026-10-31T00:00:00.000Z';
const parents = new Map([['p-작업자', 'p-감독'], ['p-감독', 'p-슈퍼감독'], ['p-슈퍼감독', '@user']]);
const starts = [...parents.keys()].map((role, i) => ({kind: 'start', role, session: `kadan-${role}`, panePid: i + 1, t}));
const A = {nodeMb: 13 * 1024, nodes: 1}, B = {nodeMb: 13 * 1024, nodes: 31};
const psFor = ({nodeMb, nodes}) => ['  100     1   2048  05:00:00 /usr/bin/tmux', '  200   100   4096  05:00:00 /bin/zsh',
  ...Array.from({length: nodes}, (_, i) => `  ${300 + i}   200 ${i === 0 ? nodeMb * 1024 : 1024} 01:00 /usr/bin/node`)].join('\n');

async function world() {
  resetDiscordBlock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-process-notify-'));
  const logFile = path.join(dir, 'requests.jsonl');
  const child = spawn(process.execPath, [helper, logFile, '[{"status":204}]', '{}'], {stdio: ['ignore', 'pipe', 'inherit']});
  live.push(child);
  const port = await new Promise(resolve => child.stdout.once('data', d => resolve(Number(String(d).match(/PORT (\d+)/)[1]))));
  const envFile = path.join(dir, 'secret.env');
  fs.writeFileSync(envFile, `DISCORD_WEBHOOK_URL=http://127.0.0.1:${port}/api/webhooks/111/FAKETOKEN-abc123\nDISCORD_USER_ID="424242424242"\n`);
  const requests = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length : 0;
  return {envFile, requests};
}

async function run(samples, entries, records) {
  let cycle = 0;
  const stop = Error('end');
  await assert.rejects(() => runWatch({
    floor: {list: () => starts.map(s => ({session: s.session, pid: s.panePid})), read: () => `정상 작업 ${lt(cycle)}`},
    readEntries: () => entries, readCards: () => [], parents,
    intervalMs: 1000, stallN: 2, routes: {p: 'p-감독'}, superRole: 'p-슈퍼감독', userNotify: true, processEveryMs: 0,
    now: () => Date.parse(t) + cycle * 1000, record: e => records.push(e), print: () => {},
    sendAlert: () => {},
    spawn: (command) => {
      if (command === 'sleep') { if (++cycle === samples.length) throw stop; return {status: 0, stdout: ''}; }
      if (command === 'tmux') return {status: 0, stdout: '100 s 200\n'};
      if (command === 'ps') return {status: 0, stdout: psFor(samples[cycle])};
      return {status: 0, stdout: ''};
    },
  }), error => error === stop);
}

test('A→B→A가 10분 안에 일어나도 전이마다 3번 알리고, 같은 상태 반복과 재시작 복원은 0번', async () => {
  const w = await world();
  const saved = {n: process.env.KADAN_NOTIFY, f: process.env.KADAN_NOTIFY_ENV_FILE};
  process.env.KADAN_NOTIFY = ''; process.env.KADAN_NOTIFY_ENV_FILE = w.envFile;
  try {
    const records = [];
    await run([A, A, B, B, A, A], starts, records);
    assert.equal(w.requests(), 3, '열림 A, 집합 바뀜 B, 다시 A — 같은 상태 반복(A,A / B,B / A,A)은 없음');
    // 감시기 재시작: 원장에 남은 마지막 경보 줄로 복원하면 같은 상태 A는 다시 알리지 않는다.
    const opened = records.filter(r => r.kind === 'alert' && r.alertKind === '프로세스');
    await run([A, A, A], [...starts, ...opened.slice(-1)], []);
    assert.equal(w.requests(), 3, '재시작 복원은 새 알림 0건');
  } finally {
    for (const [k, v] of [['KADAN_NOTIFY', saved.n], ['KADAN_NOTIFY_ENV_FILE', saved.f]]) v === undefined ? delete process.env[k] : process.env[k] = v;
  }
});
