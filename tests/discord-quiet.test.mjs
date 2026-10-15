import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {notifyUser, resetDiscordBlock, postDiscordWebhook, SUPPRESS_NOTIFICATIONS} from '../src/user-notify.mjs';
import {DecisionStore} from '../src/decisions.mjs';

// 울림 기준 시험: 사용자를 멘션하는 요청(결정 요청·경보)만 flags가 없고, 나머지는 모두 flags 4096이다.
// 가짜 값과 로컬 가짜 웹훅 서버만 쓴다. 실제 디스코드 전송은 없다.
const TOKEN = 'FAKETOKEN-quiet', USER_ID = '515151515151';
const helper = new URL('./helpers/fake-webhook.mjs', import.meta.url).pathname;
const live = [];
process.on('exit', () => { for (const c of live) c.kill('SIGKILL'); });

async function world(forumKnown = null) {
  resetDiscordBlock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-quiet-test-'));
  const home = path.join(dir, 'home'), logFile = path.join(dir, 'requests.jsonl');
  fs.mkdirSync(home);
  const forumOptions = forumKnown ? {forum: true, known: forumKnown} : {};
  const child = spawn(process.execPath, [helper, logFile, JSON.stringify([{status: 204}]), JSON.stringify(forumOptions)], {stdio: ['ignore', 'pipe', 'inherit']});
  live.push(child);
  const port = await new Promise(resolve => child.stdout.once('data', d => resolve(Number(String(d).match(/PORT (\d+)/)[1]))));
  const envFile = path.join(dir, 'secret.env');
  const url = `http://127.0.0.1:${port}/api/webhooks/111/${TOKEN}`;
  fs.writeFileSync(envFile, `DISCORD_WEBHOOK_URL=${url}\nDISCORD_USER_ID="${USER_ID}"\n${forumKnown ? `DISCORD_WEBHOOK_URL_REPO=${url}\n` : ''}`);
  const env = {KADAN_NOTIFY: '', KADAN_NOTIFY_ENV_FILE: envFile};
  const requests = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const fakeSpawn = () => () => ({status: 0});
  return {home, env, requests, fakeSpawn, stop: () => child.kill('SIGTERM')};
}
// DecisionStore는 프로세스 환경의 KADAN_NOTIFY=off를 따른다(시험 공용 격리 값) — 알림 경로를 시험할 때만 푼다.
const withNotifyOn = fn => {
  const prev = process.env.KADAN_NOTIFY; delete process.env.KADAN_NOTIFY;
  try { return fn(); } finally { if (prev !== undefined) process.env.KADAN_NOTIFY = prev; }
};
const bodyOf = r => JSON.parse(r.body);
const quiet = b => b.flags === SUPPRESS_NOTIFICATIONS && JSON.stringify(b.allowed_mentions) === '{"parse":[]}';
const rings = b => b.flags === undefined && JSON.stringify(b.allowed_mentions) === JSON.stringify({users: [USER_ID]}) && b.content.includes(`<@${USER_ID}>`);

test('울리는 것: 결정 요청과 사용자 경보(ring)만 flags 없이 멘션이 붙는다', async () => {
  const w = await world();
  try {
    const store = new DecisionStore(w.home, {userNotify: (m, o) => notifyUser(m, w.fakeSpawn(), {...o, home: w.home, env: w.env})});
    withNotifyOn(() => store.announce('request', {id: 'dec-1', card: 'repo/card-1', work: 'repo/work-1', question: '질문', options: ['가', '나'], recommendation: '가', reason: '이유'}));
    notifyUser('경보 하나', w.fakeSpawn(), {kind: 'alert', ring: true, key: 'alert:a1:RED', tagRepo: 'repo', home: w.home, env: w.env});
    notifyUser('겹알림 하나', w.fakeSpawn(), {kind: 'alert', ring: true, key: 'alert:a1:RED:겹알림', tagRepo: 'repo', home: w.home, env: w.env});
    const bodies = w.requests().map(bodyOf);
    assert.equal(bodies.length, 3);
    for (const b of bodies) assert.ok(rings(b), JSON.stringify(b.allowed_mentions));
  } finally { w.stop(); }
});

test('조용히 보내는 것: 결정 답변·취소, watch @user, 인계, 우편은 flags 4096과 빈 allowed_mentions다', async () => {
  const w = await world();
  try {
    const store = new DecisionStore(w.home, {userNotify: (m, o) => notifyUser(m, w.fakeSpawn(), {...o, home: w.home, env: w.env})});
    const d = {id: 'dec-2', card: 'repo/card-2', work: 'repo/work-2', question: '질문', options: ['가', '나'], recommendation: '가', reason: '이유'};
    withNotifyOn(() => {
      store.announce('answer', {...d, answer: {text: '가로', choice: '가'}});
      store.announce('cancel', {...d, id: 'dec-3'});
    });
    const send = (message, opts) => notifyUser(message, w.fakeSpawn(), {home: w.home, env: w.env, ...opts});
    send('watch 메시지 @everyone', {kind: 'alert'});
    send('인계 통지', {kind: 'handover'});
    send('우편 알림', {kind: 'mail', key: 'mail:m1'});
    const bodies = w.requests().map(bodyOf);
    assert.equal(bodies.length, 5);
    for (const b of bodies) assert.ok(quiet(b), JSON.stringify(b));
  } finally { w.stop(); }
});

test('표시 없이 부른 새 종류는 기본으로 조용하다(postDiscordWebhook 직접 호출)', async () => {
  const w = await world();
  try {
    const url = `http://127.0.0.1:${fs.readFileSync(w.env.KADAN_NOTIFY_ENV_FILE, 'utf8').match(/127\.0\.0\.1:(\d+)/)[1]}/api/webhooks/111/${TOKEN}`;
    postDiscordWebhook({webhook: url, content: '새 종류', allowedMentions: {parse: []}});
    postDiscordWebhook({webhook: url, content: '멘션 없는 값 없음', allowedMentions: undefined});
    postDiscordWebhook({webhook: url, content: '사용자 멘션', allowedMentions: {users: [USER_ID]}});
    const [a, b, c] = w.requests().map(bodyOf);
    assert.equal(a.flags, 4096);
    assert.equal(b.flags, 4096);
    assert.equal(c.flags, undefined);
  } finally { w.stop(); }
});

test('포럼: 업무 글 생성·이어 붙이기는 조용히, 결정 답변이 고치는 요청(PATCH)에는 flags가 없다', async () => {
  const w = await world([]);
  try {
    const store = new DecisionStore(w.home, {userNotify: (m, o) => notifyUser(m, w.fakeSpawn(), {...o, home: w.home, env: w.env})});
    const send = (message, opts) => notifyUser(message, w.fakeSpawn(), {home: w.home, env: w.env, work: 'repo/work-1', workTitle: '제목', ...opts});
    send('첫 알림', {kind: 'mail', key: 'mail:a'});   // 새 글
    send('둘째 알림', {kind: 'mail', key: 'mail:b'}); // 이어 붙임
    const quietPosts = w.requests().filter(r => r.method === 'POST').map(bodyOf);
    assert.equal(quietPosts.length, 2);
    for (const b of quietPosts) assert.ok(quiet(b), JSON.stringify(b));
    const d = {id: 'dec-9', card: 'repo/card-9', work: 'repo/work-1', question: '질문', options: ['가', '나'], recommendation: '가', reason: '이유'};
    withNotifyOn(() => { store.announce('request', d); store.announce('answer', {...d, answer: {text: '가로', choice: '가'}}); });
    send('업무 경보', {kind: 'alert', ring: true, key: 'alert:w1:RED'});
    const reqs = w.requests();
    const patches = reqs.filter(r => r.method === 'PATCH');
    assert.equal(patches.length, 1);
    assert.equal(bodyOf(patches[0]).flags, undefined);
    assert.deepEqual(bodyOf(patches[0]).allowed_mentions, {parse: []});
    const ringing = reqs.filter(r => r.method === 'POST').map(bodyOf).filter(b => b.flags === undefined);
    assert.equal(ringing.length, 2); // 결정 요청 + 업무 경보
    for (const b of ringing) assert.ok(rings(b));
  } finally { w.stop(); }
});

test('감시기는 사용자 경보와 겹알림 두 곳에만 ring을 켠다', () => {
  const src = fs.readFileSync(new URL('../src/watch-runner.mjs', import.meta.url), 'utf8');
  assert.equal(src.match(/kind: "alert", ring: true/g)?.length, 2);
  for (const f of ['commands/watch.mjs', 'commands/handover.mjs', 'commands/send.mjs', 'decisions.mjs'])
    assert.doesNotMatch(fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'), /ring:\s*true/, f);
});

test('디스코드가 안 될 때 맥 알림 대체 경로는 그대로다', () => {
  resetDiscordBlock();
  const calls = [];
  const r = notifyUser('경보', (cmd, args) => { calls.push(cmd); return {status: 0}; }, {kind: 'alert', ring: true, env: {KADAN_NOTIFY: '', KADAN_NOTIFY_ENV_FILE: '/nonexistent/secret.env'}, home: fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-quiet-home-'))});
  assert.equal(r.via, 'system');
  assert.deepEqual(calls, ['osascript']);
});
