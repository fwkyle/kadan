import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {notifyUser, resetDiscordBlock, postDiscordWebhook, SUPPRESS_NOTIFICATIONS} from '../src/user-notify.mjs';
import {DecisionStore} from '../src/decisions.mjs';
import {WatchReports} from '../src/watch-report.mjs';
import {sendWatchMessage} from '../src/commands/watch.mjs';
import {appendLedger} from '../src/ledger.mjs';

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

test('조용히 보내는 것: 결정 답변·취소, 울림 표시 없는 경보, 인계, 우편은 flags 4096과 빈 allowed_mentions다', async () => {
  const w = await world();
  try {
    const store = new DecisionStore(w.home, {userNotify: (m, o) => notifyUser(m, w.fakeSpawn(), {...o, home: w.home, env: w.env})});
    const d = {id: 'dec-2', card: 'repo/card-2', work: 'repo/work-2', question: '질문', options: ['가', '나'], recommendation: '가', reason: '이유'};
    withNotifyOn(() => {
      store.announce('answer', {...d, answer: {text: '가로', choice: '가'}});
      store.announce('cancel', {...d, id: 'dec-3'});
    });
    const send = (message, opts) => notifyUser(message, w.fakeSpawn(), {home: w.home, env: w.env, ...opts});
    send('표시 없는 경보 @everyone', {kind: 'alert'});
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

test('감시 AI 경로: 사용자 직행과 RED 겹알림(WatchReports.deliver → sendWatchMessage)이 멘션으로 울린다', async () => {
  const w = await world();
  const prev = {...process.env};
  Object.assign(process.env, w.env, {KADAN_HOME: w.home});
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-quiet-ai-'));
    appendLedger({kind: 'start', role: 'x-작업자', session: 'kadan-x-작업자', panePid: 1}, home);
    appendLedger({kind: 'send', role: 'x-작업자', taskId: 'a'}, home);
    appendLedger({kind: 'start', role: 'y-작업자', session: 'kadan-y-작업자', panePid: 3}, home);
    appendLedger({kind: 'send', role: 'y-작업자', taskId: 'b'}, home);
    const sent = [];
    // 사용자 직행만 실제 sendWatchMessage로 보낸다. 역할 전달은 기록만 한다.
    const send = (role, message) => { sent.push(role); if (role === '@user') sendWatchMessage(role, message); };
    const mk = live => new WatchReports({home, now: () => Date.now(), readCards: () => [{id: 'a', key: 'r/a', role: 'x-작업자', board: 'x', status: 'assigned', workType: 'execution'}, {id: 'b', key: 'r/b', role: 'y-작업자', board: 'y', status: 'assigned', workType: 'execution'}],
      floor: {list: () => [{session: 'kadan-x-작업자', pid: 1}, {session: 'kadan-y-작업자', pid: 3}, ...live.map(session => ({session, pid: 2}))]}, send});
    // (1) 경로가 없어 @user로 직행
    let r = mk([]), job = r.request({source: 'stall', role: 'y-작업자', parents: new Map(), routes: [['y', 'y-죽은감독']], superRole: '죽은-슈퍼'});
    r.submit(job.requestId, '정체', '입력 대기에서 멈춤');
    // (2) 감독에게 전달하다가 같은 문제가 2회 연속(RED) + userNotify → 사용자 겹알림
    r = mk(['kadan-x-감독']);
    for (const why of ['첫 보고', '둘째 보고']) {
      job = r.request({source: 'stall', role: 'x-작업자', parents: new Map(), routes: [['x', 'x-감독']], superRole: null, userNotify: true});
      r.submit(job.requestId, '조정', why);
    }
    assert.deepEqual(sent, ['@user', 'x-감독', 'x-감독', '@user']);
    const bodies = w.requests().map(bodyOf);
    assert.equal(bodies.length, 2);
    for (const b of bodies) assert.ok(rings(b), JSON.stringify(b));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
    w.stop();
  }
});

test('울림 표시(ring: true)는 감시기 두 곳과 watch @user 한 곳에만 있다', () => {
  const count = f => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8').match(/ring:\s*true/g)?.length ?? 0;
  assert.equal(count('watch-runner.mjs'), 2);
  assert.equal(count('commands/watch.mjs'), 1);
  for (const f of ['commands/handover.mjs', 'commands/send.mjs', 'decisions.mjs']) assert.equal(count(f), 0, f);
});

// 봇 답변(discord-chat.mjs sendText)은 웹훅이 아니라 봇 API로 나간다. 울리는 곳은 새 글 첫 조각의 `<@사용자>` 멘션 한 군데뿐이다.
test('울림 위치 고정: #비서 봇 답변은 discord-chat.mjs의 멘션 한 곳만 울리고, 나머지 조각·--quiet·고치기는 조용하다', () => {
  const src = fs.readFileSync(new URL('../src/discord-chat.mjs', import.meta.url), 'utf8');
  assert.equal(src.match(/<@\$\{/g)?.length, 1);
  assert.equal(src.match(/users:\s*\[userId\]/g)?.length, 1);
  assert.equal(src.match(/flags:\s*SUPPRESS_NOTIFICATIONS/g)?.length, 1);
  for (const f of ['commands/discord.mjs', 'discord-mail.mjs', 'discord-bot.mjs']) {
    const t = fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    assert.equal(/<@\$\{|users:\s*\[/.test(t), false, f);
  }
});

test('디스코드가 안 될 때 맥 알림 대체 경로는 그대로다', () => {
  resetDiscordBlock();
  const calls = [];
  const r = notifyUser('경보', (cmd, args) => { calls.push(cmd); return {status: 0}; }, {kind: 'alert', ring: true, env: {KADAN_NOTIFY: '', KADAN_NOTIFY_ENV_FILE: '/nonexistent/secret.env'}, home: fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-quiet-home-'))});
  assert.equal(r.via, 'system');
  assert.deepEqual(calls, ['osascript']);
});
