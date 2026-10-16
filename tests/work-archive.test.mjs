import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {notifyUser, refreshWorkStatus, resetDiscordBlock, scrubSecrets, NOTIFY_LOG_FILE} from '../src/user-notify.mjs';
import {readThreads} from '../src/notify-threads.mjs';
import {botSecrets} from '../src/thread-archive.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {workCommand} from '../src/work-command.mjs';
import {createChat, checkChat} from '../src/discord-chat.mjs';
import {startFakeDiscord, FAKE} from './helpers/fake-discord-api.mjs';

// 끝난 업무의 디코 포럼 글 보관·재개. 가짜 서버(웹훅+봇)와 가짜 비밀 파일만 쓴다 — 실제 디코로는 나가지 않는다.
const helper = new URL('./helpers/fake-forum-bot.mjs', import.meta.url).pathname;
const TOKEN = 'FAKE-BOT-TOKEN-zz99', USER_ID = '424242424242', WORK = 'kadan/work-x';
const live = [];
process.on('exit', () => { for (const c of live) c.kill('SIGKILL'); });

async function world(options = {}) {
  resetDiscordBlock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-archive-test-')), home = path.join(dir, 'home'), logFile = path.join(dir, 'requests.jsonl');
  fs.mkdirSync(home);
  const child = spawn(process.execPath, [helper, logFile, JSON.stringify({token: TOKEN, ...options})], {stdio: ['ignore', 'pipe', 'inherit']});
  live.push(child);
  const port = await new Promise(resolve => child.stdout.once('data', d => resolve(Number(String(d).match(/PORT (\d+)/)[1]))));
  const envFile = path.join(dir, 'secret.env'), botFile = path.join(dir, 'bot.env');
  fs.writeFileSync(envFile, `DISCORD_WEBHOOK_URL=http://127.0.0.1:${port}/api/webhooks/111/HOOKTOKEN\nDISCORD_USER_ID=${USER_ID}\n`
    + `DISCORD_WEBHOOK_URL_KADAN=http://127.0.0.1:${port}/api/webhooks/333/HOOKTOKEN\n`, {mode: 0o600});
  fs.writeFileSync(botFile, `DISCORD_BOT_TOKEN=${TOKEN}\n`, {mode: 0o600});
  const env = {KADAN_NOTIFY: '', KADAN_NOTIFY_ENV_FILE: envFile, KADAN_SECRET_DISCORD_BOT_FILE: botFile, KADAN_DISCORD_API_BASE: `http://127.0.0.1:${port}`};
  const requests = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  const channelPatches = () => requests().filter(r => r.method === 'PATCH' && r.url.startsWith('/channels/'));
  const log = () => (fs.existsSync(path.join(home, NOTIFY_LOG_FILE)) ? fs.readFileSync(path.join(home, NOTIFY_LOG_FILE), 'utf8') : '');
  const logLines = () => log().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const record = (work = WORK) => readThreads(home)[work];
  const store = new WorkStore(home);
  const make = (key = WORK) => store.create({key, title: '보관 시험', goal: '목표', scope: '범위', acceptance: '조건', owner: 'kadan-감독', repoPath: os.tmpdir()});
  const finish = (action = 'complete', key = WORK) => store.change(key, action, {result: '끝남'}, {revision: store.get(key).revision, note: '시험'});
  const reopen = (key = WORK) => store.change(key, 'reopen', {}, {revision: store.get(key).revision, note: '다시 엶'});
  const refresh = (opts = {}, key = WORK) => refreshWorkStatus(home, key, {env, ...opts});
  const alert = (key = WORK) => notifyUser('경보', () => ({status: 0}), {home, env, work: key, workTitle: '보관 시험', kind: 'mail', key: `mail:${Math.random()}`});
  // 글 + 상태 메시지를 먼저 만든다(알림 한 번).
  const open = (key = WORK) => { make(key); assert.equal(alert(key).via, 'discord'); };
  // 봇이 아닌 사람이 손으로 보관한 것처럼 가짜 서버의 글을 보관한다(시험 → 가짜 서버로만 나간다).
  const manualArchive = async threadId => {
    const r = await fetch(`http://127.0.0.1:${port}/channels/${threadId}`, {method: 'PATCH', headers: {authorization: `Bot ${TOKEN}`, 'x-fake-manual': '1', 'content-type': 'application/json'}, body: '{"archived":true}'});
    assert.equal(r.status, 200);
  };
  return {dir, home, env, envFile, botFile, port, requests, channelPatches, log, logLines, record, store, make, finish, reopen, refresh, alert, open, manualArchive, stop: () => child.kill('SIGTERM')};
}

test('1 완료·취소 각각: 상태 고치기 sent 뒤에 보관된다(고치기 → 보관 순서)', async () => {
  for (const action of ['complete', 'cancel']) {
    const w = await world();
    try {
      w.open(); w.finish(action);
      const before = w.requests().length;
      assert.equal(w.refresh().outcome, 'sent');
      assert.equal(w.requests().length - before, 2, '상태 고치기 1 + 보관 1');
      const [edit, archive] = w.requests().slice(before);
      assert.equal(edit.method, 'PATCH'); assert.match(edit.url, /\/api\/webhooks\/.*\/messages\//);
      assert.match(archive.url, /^\/channels\//);
      assert.match(JSON.parse(edit.body).content, action === 'complete' ? /상태: 완료/ : /상태: 취소/);
      assert.deepEqual(JSON.parse(archive.body), {archived: true});
      assert.equal(archive.authOk, true);
      assert.equal(w.record().archived, true);
      assert.equal(JSON.parse(fs.readFileSync(path.join(w.home, 'notify-threads.json'), 'utf8')).threads[WORK].archived, true);
    } finally { w.stop(); }
  }
});

test('2 __decisions__ 결정 글은 보관하지 않는다', async () => {
  const w = await world();
  try {
    const key = 'kadan/__decisions__';
    w.open(key); w.finish('complete', key);          // 업무로 읽혀 끝나 있어도 결정 글 키라서 건너뛴다
    const before = w.requests().length;
    w.refresh({}, key);
    assert.equal(w.channelPatches().length, 0);
    assert.equal(w.requests().length - before, 1, '상태 고치기만');
    assert.equal(w.record(key).archived, false);
  } finally { w.stop(); }
});

test('3 보관 403: 사유가 notify-log에 남고, 기록은 보관 안 됨, 알림 결과는 그대로, 60초 차단 없음', async () => {
  const w = await world({archiveStatus: 403});
  try {
    w.open(); w.finish();
    assert.equal(w.refresh().outcome, 'sent');                       // 알림(상태 고치기) 결과는 그대로 sent
    assert.equal(w.channelPatches().length, 1);
    assert.equal(w.record().archived, false);
    const entry = w.logLines().find(e => e.kind === 'archive');
    assert.equal(entry.outcome, 'failed'); assert.equal(entry.status, 403); assert.match(entry.reason, /403/);
    assert.equal(w.refresh().outcome, 'sent');                       // blockedUntil이 없으니 바로 다음 사건도 요청이 나간다
    assert.equal(w.channelPatches().length, 2, '보관은 다음 사건 때 다시 시도');
    const r = w.alert();                                             // 알림 호출의 결과도 바뀌지 않는다
    assert.equal(r.via, 'discord'); assert.equal(r.discord.outcome, 'sent');
  } finally { w.stop(); }
});

test('4 보관된 기록 + 새 알림(열린 업무): 재개 → 올리기 → 기록이 false가 된다', async () => {
  const w = await world();
  try {
    w.open(); w.finish(); w.refresh();
    assert.equal(w.record().archived, true);
    w.reopen();
    const before = w.requests().length;
    const r = w.alert();
    assert.equal(r.via, 'discord');
    const seq = w.requests().slice(before);
    assert.deepEqual(JSON.parse(seq[0].body), {archived: false});    // 재개가 먼저
    assert.match(seq[0].url, /^\/channels\//);
    assert.match(seq[1].url, /thread_id=/); assert.equal(seq[1].method, 'POST');   // 알림 올리기
    assert.equal(seq[2].method, 'PATCH');                                         // 상태 고치기
    assert.equal(w.record().archived, false);
    assert.equal(w.channelPatches().length, 2, '보관 1 + 재개 1');
  } finally { w.stop(); }
});

test('5 기록 없음 + 웹훅이 보관 오류(50083): 재개 → 한 번만 다시 시도', async () => {
  const w = await world();
  try {
    w.open();
    await w.manualArchive(w.record().threadId);                      // 손으로 보관: 기록은 여전히 false
    assert.equal(w.record().archived, false);
    const before = w.requests().length;
    const r = w.alert();
    assert.equal(r.via, 'discord');
    const seq = w.requests().slice(before).map(x => `${x.method} ${x.url.startsWith('/channels/') ? 'channel' : 'webhook'}`);
    assert.deepEqual(seq.slice(0, 3), ['POST webhook', 'PATCH channel', 'POST webhook'], '쓰기 → 재개 → 한 번만 다시');
    assert.equal(w.requests().slice(before).filter(x => x.method === 'POST').length, 2, '재시도는 한 번');
    assert.equal(w.channelPatches().filter(x => JSON.parse(x.body).archived === false).length, 1);
    // 재개가 403이면 다시 시도하지 않고 쓰기를 건너뛴다(대신 #브리핑·시스템 알림으로도 보내지 않는다)
    const w2 = await world({resumeStatus: 403});
    try {
      w2.open(); await w2.manualArchive(w2.record().threadId);
      const n = w2.requests().length;
      let osCalls = 0;
      const skipped = notifyUser('경보', () => { osCalls++; return {status: 0}; }, {home: w2.home, env: w2.env, work: WORK, workTitle: '보관 시험', kind: 'mail', key: 'mail:s'});
      assert.equal(skipped.via, 'none'); assert.equal(skipped.discord.outcome, 'archived-skip'); assert.equal(osCalls, 0);
      assert.equal(w2.requests().slice(n).filter(x => x.method === 'POST').length, 1, '다시 시도 없음');
      assert.match(w2.log(), /archived-skip/);
    } finally { w2.stop(); }
  } finally { w.stop(); }
});

test('6 work reopen: 보관된 글을 다시 연다', async () => {
  const w = await world();
  const saved = {...process.env};
  try {
    w.open(); w.finish(); w.refresh();
    assert.equal(w.record().archived, true);
    Object.assign(process.env, w.env);                               // workCommand → refreshWorkStatus는 process.env를 쓴다
    const n = w.requests().length;
    workCommand(['reopen', WORK], {revision: w.store.get(WORK).revision, note: '다시 엶'}, {home: w.home, by: '사람'});
    const seq = w.requests().slice(n);
    assert.deepEqual(JSON.parse(seq[0].body), {archived: false});
    assert.equal(seq[1].method, 'PATCH');
    assert.match(JSON.parse(seq[1].body).content, /상태: 열림/);
    assert.equal(w.record().archived, false);
    assert.equal(seq.length, 2, '열린 업무라 다시 보관하지 않는다');
  } finally { for (const k of Object.keys(w.env)) { if (k in saved) process.env[k] = saved[k]; else delete process.env[k]; } w.stop(); }
});

test('7 완료 뒤 늦은 실행 done: 고치기·재개 요청이 0건이다', async () => {
  const w = await world();
  try {
    w.open(); w.finish(); w.refresh();
    const n = w.requests().length;
    assert.equal(w.refresh().outcome, 'none');                       // done.mjs가 부르는 것과 같은 함수
    assert.equal(w.requests().length, n);
    assert.equal(w.record().archived, true);
  } finally { w.stop(); }
});

test('8 시간 예산 부족: 상태 고치기는 하고 보관은 건너뛴다', async () => {
  const w = await world({editDelayMs: 2000});
  try {
    w.open(); w.finish();
    assert.equal(w.refresh({totalMs: 3300}).outcome, 'sent');        // 고치기에 2초 → 남은 1.3초 < 최소 1.5초
    assert.equal(w.channelPatches().length, 0);
    assert.equal(w.record().archived, false);
    assert.match(w.log(), /시간 예산이 모자라 보관을 건너뜀/);
  } finally { w.stop(); }
});

test('9 상태 고치기 실패: 보관 0건', async () => {
  const w = await world({failEditStatus: 403});
  try {
    w.open(); w.finish();
    assert.equal(w.refresh().outcome, 'failed');
    assert.equal(w.channelPatches().length, 0);
    assert.equal(w.record().archived, false);
  } finally { w.stop(); }
});

test('10 봇 토큰이 notify-log·글 기록·반환값 어디에도 없고, 가림 목록에 들어 있다', async () => {
  const w = await world({archiveStatus: 403, resumeStatus: 403});
  try {
    w.open(); w.finish();
    const outs = [w.refresh(), w.refresh()];
    await w.manualArchive(w.record().threadId);
    outs.push(w.alert());                                            // 재개 403 → archived-skip 경로까지 지난다
    const everything = JSON.stringify(outs) + w.log() + fs.readFileSync(path.join(w.home, 'notify-threads.json'), 'utf8');
    assert.ok(w.requests().some(r => r.authOk), '봇 요청에는 토큰이 실제로 쓰였다');
    assert.ok(!everything.includes(TOKEN), '토큰 문자열이 새지 않는다');
    assert.deepEqual(botSecrets(w.home, w.env), [TOKEN]);
    assert.equal(scrubSecrets(`오류 ${TOKEN}`, botSecrets(w.home, w.env)), '오류 [가림]');
  } finally { w.stop(); }
});

test('11 옛 notify-threads 형식(문자열·archived 없음)을 archived:false로 읽고 이어 쓴다', async () => {
  const w = await world();
  try {
    w.open();
    const threadId = w.record().threadId;
    fs.writeFileSync(path.join(w.home, 'notify-threads.json'), JSON.stringify({version: 1, threads: {[WORK]: threadId, 'kadan/other': {threadId: '7', statusMessageId: 'M7'}}}));
    assert.deepEqual(readThreads(w.home), {
      [WORK]: {threadId, statusMessageId: null, archived: false},
      'kadan/other': {threadId: '7', statusMessageId: 'M7', archived: false},
    });
    w.finish();
    assert.equal(w.refresh().outcome, 'sent');                       // 옛 기록 그대로도 상태 → 보관이 돈다
    assert.equal(readThreads(w.home)[WORK].archived, true);
    assert.equal(readThreads(w.home)['kadan/other'].archived, false);
    const stored = JSON.parse(fs.readFileSync(path.join(w.home, 'notify-threads.json'), 'utf8')).threads;
    assert.ok(!('archived' in stored['kadan/other']), '보관 아닌 글은 archived를 파일에 쓰지 않는다');
  } finally { w.stop(); }
});

test('12 checkChat: 봇의 Manage Threads 권한을 읽기만으로 보여 준다(서버 권한·포럼 덮어쓰기)', async () => {
  const fake = await startFakeDiscord();
  try {
    const forum = fake.addForum('kadan');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-archive-check-')), home = path.join(dir, 'home');
    fs.mkdirSync(home);
    const botFile = path.join(dir, 'bot.env'), hookFile = path.join(dir, 'hook.env');
    fs.writeFileSync(botFile, `DISCORD_BOT_TOKEN=${FAKE.token}\nDISCORD_APPLICATION_ID=${FAKE.appId}\n`, {mode: 0o600});
    fs.writeFileSync(hookFile, `DISCORD_USER_ID=${FAKE.userId}\nDISCORD_WEBHOOK_URL_SECRETARY=https://discord.com/api/webhooks/${FAKE.hookId}/${FAKE.hookToken}\nDISCORD_WEBHOOK_URL_KADAN=${forum.url}\n`, {mode: 0o600});
    const env = {KADAN_SECRET_DISCORD_BOT_FILE: botFile, KADAN_SECRET_DISCORD_FILE: hookFile, KADAN_DISCORD_API_BASE: fake.base, KADAN_NOTIFY: 'off'};
    const line = async () => (await checkChat(createChat({home, env, sleep: async () => {}}))).find(l => l.startsWith('Manage Threads kadan'));
    const MANAGE = String(1n << 34n);
    assert.match(await line(), /없음/);                               // 기본: 권한 없음
    fake.guild.memberRoles = ['R1']; fake.guild.roles.push({id: 'R1', permissions: MANAGE});
    assert.match(await line(), /있음/);                               // 봇 역할에 권한
    fake.guild.roles.find(r => r.id === 'R1').permissions = '0';
    fake.guild.roles[0].permissions = MANAGE;                         // @everyone에 권한이 있어도
    assert.match(await line(), /있음/);
    fake.guild.roles[0].permissions = String(1n << 3n);               // 관리자는 덮어쓰기와 무관하게 통과
    assert.match(await line(), /있음/);
    assert.ok(!fake.requests.some(r => r.method === 'PATCH' && /^\/channels\//.test(r.path)), '실제 보관 요청은 나가지 않는다');
  } finally { await fake.close(); }
});
