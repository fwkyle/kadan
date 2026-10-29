import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {stopChild} from './helpers/child-cleanup.mjs';
import {startFakeDiscord, FAKE} from './helpers/fake-discord-api.mjs';
import {splitDiscord, apiBase, discordRequest, DiscordError} from '../src/discord-bot.mjs';
import {
  createChat, loadChatConfig, runWatch, pollOnce, sendText, editThread, checkChat, classifyMessage, STATE_FILE, LOCK_DIR,
} from '../src/discord-chat.mjs';

// 가짜 값만 쓴다. 어떤 값도 실제 주소·토큰·ID가 아니다.
const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), `kadan-dchat-${prefix}-`));
const noSleep = async () => {};

// 비밀 파일 두 개와 환경을 만든다. webhook:false면 키로 채널을 준다.
function setup(fake, {webhook = true, extraBot = ''} = {}) {
  const dir = tmp('home');
  const botFile = path.join(dir, 'bot.env'), hookFile = path.join(dir, 'hook.env');
  fs.writeFileSync(botFile, `DISCORD_BOT_TOKEN=${FAKE.token}\nDISCORD_APPLICATION_ID=${FAKE.appId}\n${extraBot}`, {mode: 0o600});
  fs.writeFileSync(hookFile, `DISCORD_USER_ID=${FAKE.userId}\n${webhook
    ? `DISCORD_WEBHOOK_URL_SECRETARY=https://discord.com/api/webhooks/${FAKE.hookId}/${FAKE.hookToken}\n`
    : `DISCORD_SECRETARY_CHANNEL_ID=${FAKE.channelId}\n`}`, {mode: 0o600});
  const env = {KADAN_SECRET_DISCORD_BOT_FILE: botFile, KADAN_SECRET_DISCORD_FILE: hookFile, KADAN_DISCORD_API_BASE: fake.base, KADAN_NOTIFY: 'off'};
  return {home: dir, env, botFile, hookFile};
}
const chatOf = (fake, opts = {}) => {
  const s = setup(fake, opts);
  return {...s, chat: createChat({home: s.home, env: s.env, sleep: noSleep})};
};
async function watchOnce(chat, extra = {}) {
  const lines = [], errs = [];
  await runWatch(chat, {once: true, out: l => lines.push(l), err: e => errs.push(e), ...extra});
  return {lines, errs};
}
const allText = (home, ...more) => {
  const parts = [...more];
  for (const f of [STATE_FILE]) try { parts.push(fs.readFileSync(path.join(home, f), 'utf8')); } catch { /* 없음 */ }
  return parts.join('\n');
};
const SECRET_VALUES = [FAKE.token, FAKE.hookToken, FAKE.hookId, FAKE.userId, FAKE.appId];
const assertNoSecrets = (text, label = '') => { for (const v of SECRET_VALUES) assert.ok(!String(text).includes(v), `${label} 에 비밀값(${v.slice(0, 6)}…)이 있다`); };

test('1 채널 ID: 웹훅 조회로 얻고(봇 인증 없이), 키가 있으면 조회 없이 키를 쓴다', async () => {
  const fake = await startFakeDiscord();
  try {
    const a = chatOf(fake);
    assert.equal(await a.chat.channelIdOf(), FAKE.channelId);
    assert.equal(a.chat.channelVia, 'webhook');
    const hookReq = fake.requests.find(r => r.path.startsWith('/webhooks/'));
    assert.equal(hookReq.auth, null);
    const before = fake.requests.length;
    const b = chatOf(fake, {webhook: false});
    assert.equal(await b.chat.channelIdOf(), FAKE.channelId);
    assert.equal(b.chat.channelVia, 'key');
    assert.equal(fake.requests.length, before);
  } finally { await fake.close(); }
});

test('2 설정이 없거나 틀리면 값 없이 이유만 말한다', () => {
  const dir = tmp('cfg');
  const bot = path.join(dir, 'b.env'), hook = path.join(dir, 'h.env');
  const env = {KADAN_SECRET_DISCORD_BOT_FILE: bot, KADAN_SECRET_DISCORD_FILE: hook};
  assert.throws(() => loadChatConfig(env, dir), /discord-bot|읽을 수 없다/);
  fs.writeFileSync(bot, `DISCORD_BOT_TOKEN=${FAKE.token}\n`);
  fs.writeFileSync(hook, `DISCORD_USER_ID=notnumber\n`);
  assert.throws(() => loadChatConfig(env, dir), error => { assertNoSecrets(error.message); return /DISCORD_USER_ID/.test(error.message); });
  fs.writeFileSync(hook, `DISCORD_USER_ID=${FAKE.userId}\n`);
  assert.throws(() => loadChatConfig(env, dir), /#비서 채널을 알 수 없다/);
});

test('3 받기: kyle 글만 오름차순으로, 인용·전달·빈 글을 표시하고 읽음 반응을 달며, 재시작해도 중복이 없다', async () => {
  const fake = await startFakeDiscord();
  try {
    fake.add(FAKE.channelId, {content: '옛 글 — 기준선 이전'});
    const {chat, home} = chatOf(fake);
    const first = await watchOnce(chat);
    assert.deepEqual(first.lines, [], '처음 실행은 기준선만 잡고 옛 글을 내지 않는다');

    fake.add(FAKE.channelId, {content: '다른 사람', author: {id: FAKE.otherId}});
    fake.add(FAKE.channelId, {content: '봇 글', author: {id: FAKE.botId, bot: true}});
    const plain = fake.add(FAKE.channelId, {content: '오늘 뭐 막혔어?'});
    fake.add(FAKE.channelId, {content: '스레드가 생겼습니다', type: 18});
    const reply = fake.add(FAKE.channelId, {content: '이거 해줘', type: 19, message_reference: {message_id: '1'},
      referenced_message: {content: '다른 사람의 말', author: {id: FAKE.otherId}}});
    const fwd = fake.add(FAKE.channelId, {content: '', message_snapshots: [{message: {content: '전달된 글'}}], message_reference: {type: 1}});
    const empty = fake.add(FAKE.channelId, {content: ''});
    const r = await watchOnce(chat);
    assert.deepEqual(r.lines.map(l => l.id), [plain.id, reply.id, fwd.id, empty.id], '오름차순, kyle 글만');
    const [p, q, f, e] = r.lines;
    assert.deepEqual([p.where, p.threadId, p.quoted], ['channel', null, false]);
    assert.equal(p.content, '오늘 뭐 막혔어?');
    assert.deepEqual([q.quoted, q.quotedKind, q.quotedAuthor, q.quotedContent], [true, 'reply', 'other', '다른 사람의 말']);
    assert.deepEqual([f.quoted, f.quotedKind, f.quotedContent], [true, 'forward', '전달된 글']);
    assert.equal(e.empty, true);
    assert.ok(r.errs.some(m => /Message Content Intent/.test(m)), '빈 본문이면 Intent 안내를 stderr로 낸다');
    assert.ok(!('empty' in p));
    // 읽음 반응 요청
    assert.equal(fake.count(/PUT .*reactions/), 4);
    const state = JSON.parse(fs.readFileSync(path.join(home, STATE_FILE), 'utf8'));
    assert.deepEqual(state.skipped, {others: 1, bots: 1, system: 1});
    // 재시작: 새 프로세스처럼 새 객체로
    const again = await watchOnce(chatOf(fake).chat);
    assert.deepEqual(again.lines, []);
  } finally { await fake.close(); }
});

test('4 받기: 같은 홈을 쓰는 새 chat도 이어서 받고(상태 파일), 이미 👀를 단 글은 다시 내지 않는다', async () => {
  const fake = await startFakeDiscord();
  try {
    const s = setup(fake);
    const mk = () => createChat({home: s.home, env: s.env, sleep: noSleep});
    await watchOnce(mk());
    const m1 = fake.add(FAKE.channelId, {content: '하나'});
    assert.deepEqual((await watchOnce(mk())).lines.map(l => l.id), [m1.id]);
    // 상태 파일을 잃어도(처음처럼) 👀가 달린 글은 다시 내지 않는다 — 기준선이 새로 잡히므로 옛 글은 어차피 안 나온다.
    const m2 = fake.add(FAKE.channelId, {content: '둘', reactions: [{emoji: {name: '👀'}, me: true}]});
    const m3 = fake.add(FAKE.channelId, {content: '셋'});
    assert.deepEqual((await watchOnce(mk())).lines.map(l => l.id), [m3.id], `m2(${m2.id})는 이미 읽음 표시`);
  } finally { await fake.close(); }
});

test('5 받기: 스레드 안 글은 스레드로 구분하고, 새로 생긴 스레드는 첫 글부터 받으며, 바뀐 게 없는 스레드는 조회하지 않는다', async () => {
  const fake = await startFakeDiscord();
  try {
    const old = fake.add(FAKE.channelId, {content: '이미 있던 주제'});
    const oldThread = fake.addThread(old);
    fake.add(oldThread.id, {content: '기준선 전 스레드 글'});
    const {chat} = chatOf(fake);
    assert.deepEqual((await watchOnce(chat)).lines, [], '처음 실행: 기존 스레드 글도 기준선');

    // 실행 중 새 주제 → 비서가 스레드를 열고 → kyle이 스레드에 답한다
    const topic = fake.add(FAKE.channelId, {content: '새 주제'});
    let r = await watchOnce(chat);
    assert.deepEqual(r.lines.map(l => [l.id, l.where]), [[topic.id, 'channel']]);
    const th = fake.addThread(topic);
    const inThread = fake.add(th.id, {content: '이어서 질문'});
    fake.requests.length = 0;
    r = await watchOnce(chat);
    assert.deepEqual(r.lines.map(l => [l.id, l.where, l.threadId, l.channelId]), [[inThread.id, 'thread', th.id, th.id]]);
    assert.equal(fake.count(new RegExp(`GET /channels/${oldThread.id}/messages`)), 0, '바뀐 게 없는 스레드는 조회하지 않는다');
    // 같은 글을 두 번 내지 않는다
    assert.deepEqual((await watchOnce(chat)).lines, []);
    const reactPath = fake.requests.find(x => x.method === 'PUT').path;
    assert.ok(reactPath.startsWith(`/channels/${th.id}/messages/${inThread.id}/reactions/`), '스레드 글의 반응은 스레드 채널로 간다');
  } finally { await fake.close(); }
});

test('6 받기: 이미 도는 watch가 있으면 두 번째는 거절하고, 주인이 죽은 잠금은 넘겨받는다', async () => {
  const fake = await startFakeDiscord();
  try {
    const {chat, home} = chatOf(fake);
    const lock = path.join(home, LOCK_DIR);
    fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), String(process.pid)); // 살아 있는 주인
    await assert.rejects(watchOnce(chat), /이미 다른 kadan discord watch/);
    fs.writeFileSync(path.join(lock, 'pid'), '2147483646'); // 죽은 주인
    await watchOnce(chat);
    assert.ok(!fs.existsSync(lock), '끝나면 잠금을 푼다');
  } finally { await fake.close(); }
});

test('7 재시도: 429는 retry_after를 지켜 다시, 4xx는 재시도 없이, 네트워크 끊김은 같은 지점 3회에서 멈춘다', async () => {
  const fake = await startFakeDiscord();
  try {
    const waits = [];
    const sleep = async ms => { waits.push(ms); };
    const a = (method, p, body, opts) => discordRequest({base: fake.base, token: FAKE.token, method, path: p, body, sleep, ...opts});
    fake.inject({match: /GET \/users/, status: 429, body: {retry_after: 1.5}});
    assert.equal((await a('GET', '/users/@me')).status, 200);
    assert.deepEqual(waits, [1500]);

    fake.inject({match: /GET \/users/, status: 401, body: {code: 0}, times: 5});
    const before = fake.count(/GET \/users/);
    await assert.rejects(a('GET', '/users/@me'), error => error.kind === 'http' && error.status === 401 && !error.exhausted);
    assert.equal(fake.count(/GET \/users/) - before, 1, '4xx는 재시도하지 않는다');

    fake.inject({match: /GET \/applications/, destroy: true, times: 9});
    const b4 = fake.count(/GET \/applications/);
    await assert.rejects(a('GET', '/applications/@me'), error => error instanceof DiscordError && error.exhausted && error.kind === 'network');
    assert.equal(fake.count(/GET \/applications/) - b4, 3, '같은 지점 3회에서 멈춘다');

    // 새 글(POST)은 연결 뒤 끊기면 불확실로 멈춘다 — 중복 글 방지
    fake.inject({match: /POST \/channels/, destroy: true, times: 9});
    const b5 = fake.count(/POST \/channels/);
    await assert.rejects(a('POST', `/channels/${FAKE.channelId}/messages`, {content: 'x'}), error => error.kind === 'uncertain');
    assert.equal(fake.count(/POST \/channels/) - b5, 1);
    // 429가 상한(30초)을 넘으면 기다리지 않고 멈춘다
    fake.inject({match: /GET \/guilds/, status: 429, body: {retry_after: 90}});
    waits.length = 0;
    await assert.rejects(a('GET', `/guilds/${FAKE.guildId}/threads/active`), error => error.kind === 'rate' && error.exhausted);
    assert.deepEqual(waits, []);
  } finally { await fake.close(); }
});

test('8 연결 거부는 쓰기도 3회까지 재시도하고 시간 예산을 지킨다', async () => {
  const waits = [];
  const sleep = async ms => { waits.push(ms); };
  const fetchFn = async () => { const e = new TypeError('fetch failed'); e.cause = {code: 'ECONNREFUSED'}; throw e; };
  await assert.rejects(discordRequest({base: 'http://127.0.0.1:9', token: FAKE.token, method: 'POST', path: '/x', body: {}, sleep, fetchFn}),
    error => error.exhausted && error.code === 'ECONNREFUSED');
  assert.equal(waits.length, 2);
  let t = 0;
  await assert.rejects(discordRequest({base: 'http://x', token: 't', path: '/x', sleep, fetchFn, budgetMs: 5, now: () => (t += 10)}), error => error.kind === 'budget');
});

test('9 watch는 읽기 실패가 같은 지점에서 3회면 반복하지 않고 멈춘다', async () => {
  const fake = await startFakeDiscord();
  try {
    const {chat, home} = chatOf(fake);
    await watchOnce(chat); // 기준선
    fake.inject({match: /GET \/channels\/\d+\/messages/, destroy: true, times: 99});
    fake.requests.length = 0;
    await assert.rejects(runWatch(chat, {intervalS: 2, out() {}, err() {}, sleep: noSleep}), error => error.exhausted);
    assert.equal(fake.count(/GET \/channels\/\d+\/messages/), 3);
    assert.ok(!fs.existsSync(path.join(home, LOCK_DIR)), '멈춘 뒤 잠금을 푼다');
  } finally { await fake.close(); }
});

const QUIET = {allowed_mentions: {parse: []}, flags: 4096};
const RING = {allowed_mentions: {users: [FAKE.userId]}};
const isRing = b => b.content.startsWith(`<@${FAKE.userId}> `) && b.flags === undefined && JSON.stringify(b.allowed_mentions) === JSON.stringify(RING.allowed_mentions);
const isQuiet = b => !b.content.includes('<@') && b.flags === 4096 && JSON.stringify(b.allowed_mentions) === JSON.stringify(QUIET.allowed_mentions);
const posts = fake => fake.requests.filter(r => r.method === 'POST' && /messages$/.test(r.path)).map(r => r.body);

test('10 보내기: 2,000자 넘는 글은 문단 경계로 나눠 순서대로, 첫 조각만 kyle을 멘션하고 나머지는 조용하다', async () => {
  const fake = await startFakeDiscord();
  try {
    const {chat} = chatOf(fake);
    const para = n => `문단${n} ` + '가'.repeat(900);
    const text = [para(1), para(2), para(3), para(4), para(5)].join('\n\n');
    const sent = await sendText(chat, text);
    assert.equal(sent.length, 3);
    const ps = posts(fake);
    assert.ok(isRing(ps[0]) && isQuiet(ps[1]) && isQuiet(ps[2]), JSON.stringify(ps.map(b => [b.flags, b.allowed_mentions])));
    assert.ok(ps.every(b => b.content.length <= 2000));
    const ringPrefix = `<@${FAKE.userId}> `;
    assert.deepEqual([ps[0].content.slice(ringPrefix.length), ps[1].content, ps[2].content].join('\n\n'), text);
    assert.ok(ps[0].content.slice(ringPrefix.length).startsWith('문단1') && ps[1].content.startsWith('문단3'));
    assert.deepEqual(sent.map(s => [s.part, s.parts]), [[1, 3], [2, 3], [3, 3]]);
    assert.equal(fake.requests.find(r => r.method === 'POST' && /messages$/.test(r.path)).auth, `Bot ${FAKE.token}`);
  } finally { await fake.close(); }
});

test('10b 보내기: 멘션 몫을 빼고 나눠 정확히 2,000자짜리 첫 조각도 2,000자를 넘지 않는다', async () => {
  const fake = await startFakeDiscord();
  try {
    const {chat} = chatOf(fake);
    await sendText(chat, 'ㅋ'.repeat(2000)); // 공백이 없어 강제로 자른다
    const ps = posts(fake);
    assert.equal(ps.length, 2);
    assert.ok(isRing(ps[0]) && isQuiet(ps[1]));
    assert.ok(ps.every(b => b.content.length <= 2000));
  } finally { await fake.close(); }
});

test('10c 보내기: 새 글 기본은 울림(멘션·flags 없음), quiet면 멘션 없이 flags 4096 — 새 주제 스레드(replyTo)와 스레드(thread) 모두', async () => {
  const fake = await startFakeDiscord();
  try {
    const {chat} = chatOf(fake);
    const topic = fake.add(FAKE.channelId, {content: '주제'});
    await sendText(chat, '최종 답', {replyTo: topic.id});
    await sendText(chat, '하는 중', {replyTo: topic.id, quiet: true});
    const th = fake.addThread(fake.add(FAKE.channelId, {content: '또 주제'}));
    await sendText(chat, '최종 답', {thread: th.id});
    await sendText(chat, '하는 중', {thread: th.id, quiet: true});
    await sendText(chat, '채널 최종');
    await sendText(chat, '채널 하는 중', {quiet: true});
    const ps = posts(fake);
    assert.deepEqual(ps.map(b => (isRing(b) ? 'ring' : isQuiet(b) ? 'quiet' : 'other')), ['ring', 'quiet', 'ring', 'quiet', 'ring', 'quiet']);
  } finally { await fake.close(); }
});

test('10d 고치기(PATCH)는 quiet 여부와 상관없이 멘션·flags가 없다(디스코드는 고치기로 푸시를 보내지 않는다)', async () => {
  const fake = await startFakeDiscord();
  try {
    const {chat} = chatOf(fake);
    const th = fake.addThread(fake.add(FAKE.channelId, {content: '주제'}));
    const [first] = await sendText(chat, '하는 중', {thread: th.id, quiet: true});
    await sendText(chat, '고침', {thread: th.id, edit: first.id});
    await sendText(chat, '또 고침', {thread: th.id, edit: first.id, quiet: true});
    const patches = fake.requests.filter(r => r.method === 'PATCH' && /messages\//.test(r.path)).map(r => r.body);
    assert.equal(patches.length, 2);
    for (const b of patches) assert.deepEqual(b, {content: b.content, allowed_mentions: {parse: []}});
  } finally { await fake.close(); }
});

test('11 보내기: 나누기 순서·경계 규칙(문단 > 줄 > 공백 > 강제, 서로게이트 쌍 보존)', () => {
  assert.deepEqual(splitDiscord('짧다'), ['짧다']);
  const lines = Array.from({length: 40}, (_, i) => `줄${i} ` + 'x'.repeat(95)).join('\n');
  const parts = splitDiscord(lines);
  assert.ok(parts.every(p => p.length <= 2000) && parts.join('\n') === lines);
  const emoji = '😀'.repeat(1500); // 3,000 UTF-16 단위, 공백 없음
  const cut = splitDiscord(emoji);
  assert.ok(cut.every(p => p.length <= 2000 && !/[\ud800-\udbff]$/.test(p)));
  assert.equal(cut.join(''), emoji);
});

test('12 보내기: 스레드 지정·자기 메시지 수정, #비서 밖 스레드는 거절한다', async () => {
  const fake = await startFakeDiscord();
  try {
    const {chat} = chatOf(fake);
    const topic = fake.add(FAKE.channelId, {content: '주제'});
    const th = fake.addThread(topic);
    const [first] = await sendText(chat, '스레드 답', {thread: th.id});
    assert.equal(first.channelId, th.id);
    assert.ok(fake.requests.some(r => r.method === 'POST' && r.path === `/channels/${th.id}/messages`));
    const [edited] = await sendText(chat, '고친 답', {thread: th.id, edit: first.id});
    assert.equal(edited.id, first.id);
    assert.equal(fake.messages.get(th.id).find(m => m.id === first.id).content, '고친 답');
    await assert.rejects(sendText(chat, 'x'.repeat(2001), {thread: th.id, edit: first.id}), /2000자/);
    // 다른 채널(#비서 아님)로는 가지 않는다
    const before = fake.count(/POST .*messages$/);
    await assert.rejects(sendText(chat, '새면 안 됨', {thread: FAKE.otherChannelId}), /스레드가 아니다/);
    assert.equal(fake.count(/POST .*messages$/), before);
    await assert.rejects(sendText(chat, '   '), /비었다/);
  } finally { await fake.close(); }
});

test('13 스레드 열기: 새 주제에는 스레드를 만들어 그 안에 답하고, 이미 있으면 그 스레드로 간다. 이름은 글 앞부분', async () => {
  const fake = await startFakeDiscord();
  try {
    const {chat} = chatOf(fake);
    const topic = fake.add(FAKE.channelId, {content: '  이번 주\n배포 일정이 어떻게 돼?  ' + 'ㅋ'.repeat(80)});
    const [a] = await sendText(chat, '확인 중입니다', {replyTo: topic.id});
    assert.equal(a.channelId, topic.id);
    const made = fake.requests.find(r => /\/threads$/.test(r.path));
    assert.ok(made.body.name.startsWith('이번 주 배포 일정이 어떻게 돼?') && made.body.name.length <= 50);
    assert.equal(fake.threads.get(topic.id).name, made.body.name);
    const [b] = await sendText(chat, '결과입니다', {replyTo: topic.id}); // 이미 스레드가 있음(160004)
    assert.equal(b.channelId, topic.id);
    assert.equal(fake.count(/POST .*\/threads$/), 2);
    assert.equal(fake.messages.get(topic.id).length, 2);
    await assert.rejects(sendText(chat, '없는 글', {replyTo: '999'}), /HTTP 404/);
    // 스레드 이름 바꾸기·보관
    await editThread(chat, topic.id, {rename: '새 이름', archive: true});
    assert.equal(fake.threads.get(topic.id).name, '새 이름');
    assert.equal(fake.threads.get(topic.id).archived, true);
    await assert.rejects(editThread(chat, FAKE.otherChannelId, {rename: 'x'}), /스레드가 아니다/);
    await assert.rejects(editThread(chat, topic.id, {}), /--rename 또는 --archive/);
  } finally { await fake.close(); }
});

test('14 점검: 봇·채널·Message Content Intent를 값 없이 알려 준다', async () => {
  for (const intent of [true, false]) {
    const fake = await startFakeDiscord({intent});
    try {
      const {chat} = chatOf(fake);
      const lines = await checkChat(chat);
      const text = lines.join('\n');
      assertNoSecrets(text, 'check');
      assert.ok(!text.includes(FAKE.channelId) && !text.includes(FAKE.guildId));
      assert.match(text, intent ? /Message Content Intent: 켜져 있음/ : /Message Content Intent: 꺼져 있음/);
      assert.match(text, /봇 로그인: 정상/);
    } finally { await fake.close(); }
  }
});

test('15 비밀값(토큰·웹훅·사용자 ID)이 출력·오류·상태 파일·잠금에 남지 않는다', async () => {
  const fake = await startFakeDiscord();
  try {
    const {chat, home} = chatOf(fake);
    const seen = [];
    await watchOnce(chat, {out: l => seen.push(JSON.stringify(l)), err: e => seen.push(e)});
    fake.add(FAKE.channelId, {content: '질문', reactions: undefined});
    const r = await watchOnce(chat, {out: l => seen.push(JSON.stringify(l)), err: e => seen.push(e)});
    seen.push(...r.errs);
    for (const rule of [/GET \/channels\/\d+\/messages/, /GET \/guilds/]) fake.inject({match: rule, status: 403, body: {code: 50001, message: `Missing ${FAKE.token} ${FAKE.userId}`}});
    for (const p of [pollOnce(chat, {version: 1, channel: 'x', main: '1', threads: {}, skipped: {others: 0, bots: 0, system: 0}}, {out() {}}),
      sendText(chat, '글').catch(e => e)]) { const res = await p.catch(e => e); seen.push(res?.message ?? JSON.stringify(res)); }
    assertNoSecrets(allText(home, ...seen), 'out/state');
    assert.ok(!fs.readdirSync(home).some(f => f.endsWith('.tmp')));
    for (const f of fs.readdirSync(home)) if (f !== 'bot.env' && f !== 'hook.env' && fs.statSync(path.join(home, f)).isFile()) assertNoSecrets(fs.readFileSync(path.join(home, f), 'utf8'), f);
  } finally { await fake.close(); }
});

test('16 실제 디스코드 방지: 가짜 서버 주소 없이 KADAN_NOTIFY=off면 요청하지 않고, 주소는 https나 루프백 http만', async () => {
  assert.throws(() => apiBase({KADAN_NOTIFY: 'off'}), /실제 디스코드로 요청하지 않는다/);
  assert.throws(() => apiBase({KADAN_DISCORD_API_BASE: 'http://example.com/api'}), /https이거나 루프백/);
  assert.equal(apiBase({KADAN_DISCORD_API_BASE: 'http://127.0.0.1:1/'}), 'http://127.0.0.1:1');
  assert.equal(apiBase({}), 'https://discord.com/api/v10');
  const fake = await startFakeDiscord();
  try {
    const s = setup(fake);
    const env = {...s.env}; delete env.KADAN_DISCORD_API_BASE;
    assert.throws(() => createChat({home: s.home, env}), /요청하지 않는다/);
  } finally { await fake.close(); }
});

test('17 메시지 분류: 시스템·봇·타인·읽음 표시를 거르고 첨부만 있는 글은 빈 글이 아니다', () => {
  const base = {id: '5', channel_id: 'c', timestamp: 't', author: {id: FAKE.userId}, type: 0};
  const ctx = {userId: FAKE.userId, where: 'channel'};
  assert.deepEqual(classifyMessage({...base, type: 21}, ctx), {skip: 'system'});
  assert.deepEqual(classifyMessage({...base, author: {id: FAKE.botId, bot: true}}, ctx), {skip: 'bot'});
  assert.deepEqual(classifyMessage({...base, author: {id: FAKE.otherId}}, ctx), {skip: 'other'});
  assert.deepEqual(classifyMessage({...base, content: 'a', reactions: [{emoji: {name: '👀'}, me: true}]}, ctx), {skip: 'handled'});
  const att = classifyMessage({...base, content: '', attachments: [{}]}, ctx).line;
  assert.equal(att.attachments, 1);
  assert.ok(!('empty' in att));
  assert.deepEqual(Object.keys(classifyMessage({...base, content: 'a'}, ctx).line), ['id', 'channelId', 'threadId', 'where', 'at', 'content', 'quoted']);
});

// 실제 CLI를 자식 프로세스로 돌린다(가짜 서버는 이 프로세스에서 응답한다).
function runCli(args, env, input) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {env: {PATH: process.env.PATH, ...env}, stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', code => resolve({code, stdout, stderr}));
    child.stdin.end(input ?? '');
  });
}

test('18 CLI 끝에서 끝: watch --once 줄, send(나눔·스레드·수정), thread, check', async () => {
  const fake = await startFakeDiscord();
  try {
    const s = setup(fake);
    const env = {...s.env, KADAN_HOME: s.home};
    assert.equal((await runCli(['discord', 'watch', '--once'], env)).code, 0); // 기준선
    const topic = fake.add(FAKE.channelId, {content: '진행 상황 알려줘'});
    const w = await runCli(['discord', 'watch', '--once'], env);
    assert.equal(w.code, 0, w.stderr);
    const lines = w.stdout.trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(lines.map(l => [l.id, l.where, l.content, l.quoted]), [[topic.id, 'channel', '진행 상황 알려줘', false]]);

    const sent = await runCli(['discord', 'send', '--reply-to', topic.id, '--quiet', '하는 중입니다'], env);
    assert.equal(sent.code, 0, sent.stderr);
    const finalAns = await runCli(['discord', 'send', '--thread', topic.id, '최종 답입니다'], env);
    assert.equal(finalAns.code, 0, finalAns.stderr);
    const cliPosts = posts(fake);
    assert.ok(isQuiet(cliPosts[0]) && cliPosts[0].content === '하는 중입니다', JSON.stringify(cliPosts[0]));
    assert.ok(isRing(cliPosts[1]) && cliPosts[1].content.endsWith(' 최종 답입니다'), JSON.stringify(cliPosts[1]));
    const one = JSON.parse(sent.stdout.trim());
    assert.equal(one.channelId, topic.id);
    const fromStdin = await runCli(['discord', 'send', '--thread', topic.id, '--stdin'], env, '표준입력 글\n둘째 줄');
    assert.equal(fromStdin.code, 0, fromStdin.stderr);
    const id2 = JSON.parse(fromStdin.stdout.trim()).id;
    const ed = await runCli(['discord', 'send', '--thread', topic.id, '--edit', id2, '고친', '글'], env);
    assert.equal(ed.code, 0, ed.stderr);
    assert.equal(fake.messages.get(topic.id).find(m => m.id === id2).content, '고친 글');
    const th = await runCli(['discord', 'thread', topic.id, '--rename', '이름', '--archive'], env);
    assert.equal(th.code, 0, th.stderr);
    const chk = await runCli(['discord', 'check'], env);
    assert.equal(chk.code, 0, chk.stderr);
    assert.match(chk.stdout, /Message Content Intent: 켜져 있음/);
    const bad = await runCli(['discord', 'send', '--thread', FAKE.otherChannelId, '안 됨'], env);
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /스레드가 아니다/);
    assert.equal((await runCli(['discord', 'nothing'], env)).code, 2);
    for (const r of [w, sent, finalAns, fromStdin, ed, th, chk, bad]) { assertNoSecrets(r.stdout, 'cli stdout'); assertNoSecrets(r.stderr, 'cli stderr'); }
    assertNoSecrets(allText(s.home), 'state');
  } finally { await fake.close(); }
});

test('18b CLI: --quiet이 앞·뒤·--stdin 어디에 있어도 본문 순서를 지키고 조용히 보낸다', async () => {
  const fake = await startFakeDiscord();
  try {
    const s = setup(fake);
    const env = {...s.env, KADAN_HOME: s.home};
    for (const [args, input] of [[['--quiet', '앞에', '둔다'], ''], [['뒤에', '--quiet', '둔다'], ''], [['본문', '끝에', '--quiet'], ''], [['--quiet', '--stdin'], '표준입력 본문']]) {
      const r = await runCli(['discord', 'send', ...args], env, input);
      assert.equal(r.code, 0, r.stderr);
    }
    const ps = posts(fake);
    assert.deepEqual(ps.map(b => b.content), ['앞에 둔다', '뒤에 둔다', '본문 끝에', '표준입력 본문']);
    assert.ok(ps.every(isQuiet));
  } finally { await fake.close(); }
});

test('19 CLI: 가짜 서버 주소 없이 시험 환경(KADAN_NOTIFY=off)이면 네트워크로 나가지 않는다', async () => {
  const fake = await startFakeDiscord();
  try {
    const s = setup(fake);
    const env = {...s.env, KADAN_HOME: s.home}; delete env.KADAN_DISCORD_API_BASE;
    const r = await runCli(['discord', 'check'], env);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /실제 디스코드로 요청하지 않는다/);
    assert.equal(fake.requests.length, 0);
  } finally { await fake.close(); }
});

// ---------- 2라운드: 질문 유실 3경로·붙여넣은 인용·본문 비밀 ----------
const EPOCH = 1420070400000n;
const idAt = ms => String((BigInt(ms) - EPOCH) << 22n);

test('20 R1 오래된 글에서 지금 연 새 스레드의 첫 질문도 받는다(스레드 ID 나이로 새것을 판단하지 않는다)', async () => {
  const fake = await startFakeDiscord();
  try {
    const {chat, home} = chatOf(fake);
    await watchOnce(chat); // 기준선
    const oldPost = fake.add(FAKE.channelId, {id: idAt(Date.now() - 31 * 24 * 3600 * 1000), content: '31일 전 글', author: {id: FAKE.otherId}});
    const th = fake.addThread(oldPost);
    const q = fake.add(th.id, {content: '지금 묻는 질문'});
    const r = await watchOnce(chat);
    assert.deepEqual(r.lines.map(l => [l.id, l.where, l.threadId]), [[q.id, 'thread', th.id]]);
    const state = JSON.parse(fs.readFileSync(path.join(home, STATE_FILE), 'utf8'));
    assert.equal(state.threads[th.id], q.id);
    // 처음 실행(상태 없음)이면 이미 있던 스레드는 기준선이라 옛 글을 내지 않는다.
    const s2 = setup(fake), c2 = createChat({home: s2.home, env: s2.env, sleep: noSleep});
    assert.deepEqual((await watchOnce(c2)).lines, []);
  } finally { await fake.close(); }
});

test('21 R2 출력이 끝난 뒤에만 cursor를 올린다 — 읽지 않는 파이프를 끊어도 질문이 다음 실행에서 나온다', async t => {
  const fake = await startFakeDiscord();
  try {
    const s = setup(fake);
    const env = {...s.env, KADAN_HOME: s.home};
    assert.equal((await runCli(['discord', 'watch', '--once'], env)).code, 0); // 기준선
    const ids = Array.from({length: 120}, (_, i) => fake.add(FAKE.channelId, {content: `질문${i} ` + 'x'.repeat(1900)}).id);
    // 소비자가 읽지 않는 파이프(스트림을 흘리지 않는다)
    const child = spawn(process.execPath, [CLI, 'discord', 'watch', '--once'], {env: {PATH: process.env.PATH, ...env}, stdio: ['ignore', 'pipe', 'pipe']});
    t.after(() => stopChild(child));
    await new Promise(resolve => setTimeout(resolve, 2500));
    let buffered = '';
    child.stdout.on('data', c => { buffered += c; }); // 끊긴 뒤 파이프에 남은 것을 소비자가 마저 받는 상황
    child.kill('SIGKILL');
    await new Promise(resolve => child.on('close', resolve));
    const state = JSON.parse(fs.readFileSync(path.join(s.home, STATE_FILE), 'utf8'));
    assert.ok(BigInt(state.main) < BigInt(ids.at(-1)), '소비되지 않은 글까지 cursor를 올리지 않았다');
    // 파이프에 남아 있던 첫 실행의 출력 + 다음 실행의 출력 = 전부(유실 0)
    const next = await runCli(['discord', 'watch', '--once'], env);
    assert.equal(next.code, 0, next.stderr);
    const seen = new Set([...buffered.split('\n'), ...next.stdout.split('\n')].filter(l => l.startsWith('{')).map(l => { try { return JSON.parse(l).id; } catch { return null; } }));
    assert.deepEqual(ids.filter(id => !seen.has(id)), [], '유실 0');
    // 정상 소비 뒤 재시작: 중복 0
    assert.equal((await runCli(['discord', 'watch', '--once'], env)).stdout, '');
  } finally { await fake.close(); }
});

test('22 R2 출력이 끝나기 전에는 cursor·읽음 반응이 앞서지 않고, 중단 신호 뒤에는 더 올리지 않는다', async () => {
  const fake = await startFakeDiscord();
  try {
    const {chat, home} = chatOf(fake);
    await watchOnce(chat);
    const [a, b, c] = ['가', '나', '다'].map(content => fake.add(FAKE.channelId, {content}));
    const order = [];
    const controller = new AbortController();
    const out = async line => {
      const before = JSON.parse(fs.readFileSync(path.join(home, STATE_FILE), 'utf8')).main;
      order.push(`out:${line.content}:cursor<${BigInt(before) < BigInt(line.id)}:reacts=${fake.count(/PUT .*reactions/)}`);
      await new Promise(resolve => setTimeout(resolve, 5));
      if (line.id === b.id) controller.abort();
    };
    await runWatch(chat, {once: true, out, err() {}, signal: controller.signal});
    assert.deepEqual(order, ['out:가:cursor<true:reacts=0', 'out:나:cursor<true:reacts=1']);
    const state = JSON.parse(fs.readFileSync(path.join(home, STATE_FILE), 'utf8'));
    assert.equal(state.main, a.id, '중단 신호와 겹친 줄(나)과 그 뒤(다)는 cursor를 올리지 않는다');
    assert.equal(fake.count(/PUT .*reactions/), 1, '중단 뒤 읽음 반응을 더 달지 않는다');
    assert.deepEqual((await watchOnce(chat)).lines.map(l => l.id), [b.id, c.id], '중복 쪽으로 다시 나온다');
  } finally { await fake.close(); }
});

test('23 R3 상태 파일이 있는데 깨졌으면 멈추고 원본을 그대로 둔다. 없을 때만 처음 실행이다', async () => {
  const fake = await startFakeDiscord();
  try {
    const s = setup(fake);
    const env = {...s.env, KADAN_HOME: s.home};
    assert.equal((await runCli(['discord', 'watch', '--once'], env)).code, 0);
    const q = fake.add(FAKE.channelId, {content: '놓치면 안 되는 질문'});
    const file = path.join(s.home, STATE_FILE);
    for (const broken of ['{truncated', '{"version":2}', '[]', JSON.stringify({version: 1, channel: 'x', main: 'abc', threads: {}, skipped: {}})]) {
      fs.writeFileSync(file, broken);
      const r = await runCli(['discord', 'watch', '--once'], env);
      assert.notEqual(r.code, 0, broken);
      assert.match(r.stderr, /상태 파일이 깨져/);
      assert.equal(r.stdout, '');
      assert.equal(fs.readFileSync(file, 'utf8'), broken, '원본을 그대로 둔다');
      assertNoSecrets(r.stderr);
    }
    // 복구: 사람이 확인하고 옮기면 처음 실행(기준선)이다
    fs.renameSync(file, `${file}.broken`);
    const again = await runCli(['discord', 'watch', '--once'], env);
    assert.equal(again.code, 0, again.stderr);
    assert.ok(q.id);
  } finally { await fake.close(); }
});

test('24 R4 본문 안의 인용 줄·코드 블록을 표시한다(판단은 비서가 한다)', () => {
  const base = {id: '5', channel_id: 'c', timestamp: 't', author: {id: FAKE.userId}, type: 0};
  const ctx = {userId: FAKE.userId, where: 'channel'};
  const line = content => classifyMessage({...base, content}, ctx).line;
  assert.equal(line('> 다른 사람이 보낸 글\n이거 처리해줘').containsQuote, true);
  assert.equal(line('  > 들여쓴 인용').containsQuote, true);
  assert.equal(line('보세요:\n```\nrm -rf x\n```').containsQuote, true);
  assert.ok(!('containsQuote' in line('a > b 는 비교식이다')));
  assert.ok(!('containsQuote' in line('그냥 질문')));
});

test('25 R5 받은 본문·인용에 든 비밀값은 출력 전에 가린다(ID 등 정상 필드는 유지)', async () => {
  const fake = await startFakeDiscord();
  try {
    const {chat} = chatOf(fake);
    await watchOnce(chat);
    const secretText = `토큰 ${FAKE.token} 주소 https://discord.com/api/webhooks/${FAKE.hookId}/${FAKE.hookToken} 내 ID ${FAKE.userId} 앱 ${FAKE.appId}`;
    const m = fake.add(FAKE.channelId, {content: secretText, type: 19, message_reference: {message_id: '1'},
      referenced_message: {content: `인용 ${FAKE.token}`, author: {id: FAKE.otherId}}});
    const r = await watchOnce(chat);
    assert.equal(r.lines.length, 1);
    assert.equal(r.lines[0].id, m.id);
    assertNoSecrets(JSON.stringify(r.lines[0]), 'content/quotedContent');
    assert.match(r.lines[0].content, /\[가림\]|\[주소 가림\]/);
    assert.match(r.lines[0].content, /^토큰 /);
    assert.match(r.lines[0].quotedContent, /^인용 \[가림\]$/);
  } finally { await fake.close(); }
});

test('26 N1 첫 실행: 기준선을 출력 전에 저장하므로 첫 출력이 실패해도 재시작에서 질문이 나온다', async () => {
  const fake = await startFakeDiscord();
  try {
    fake.add(FAKE.channelId, {content: '기준선 이전 글'});
    const s = setup(fake);
    let injected = null;
    const fetchFn = async (url, init) => {
      const res = await fetch(url, init);
      if (!injected && /\/channels\/\d+$/.test(new URL(url).pathname) && (init?.method ?? 'GET') === 'GET') injected = fake.add(FAKE.channelId, {content: '기준선 직후 질문'});
      return res;
    };
    const chat = createChat({home: s.home, env: s.env, sleep: noSleep, fetchFn});
    await assert.rejects(runWatch(chat, {once: true, out: async () => { throw new Error('소비자 오류'); }, err() {}}), /소비자 오류/);
    assert.ok(injected, '기준선을 읽은 직후 질문이 들어왔다');
    const state = JSON.parse(fs.readFileSync(path.join(s.home, STATE_FILE), 'utf8'));
    assert.ok(BigInt(state.main) < BigInt(injected.id), '질문 앞의 기준선이 저장돼 있다');
    const again = await watchOnce(createChat({home: s.home, env: s.env, sleep: noSleep}));
    assert.deepEqual(again.lines.map(l => l.id), [injected.id]);
  } finally { await fake.close(); }
});

test('27 N2 상태 파일 내부 값이 틀리면(스레드 위치 bad-id 등) 출력 0·원본 동일·종료 1 — 직접과 실제 CLI', async () => {
  const fake = await startFakeDiscord();
  try {
    const s = setup(fake);
    const env = {...s.env, KADAN_HOME: s.home};
    assert.equal((await runCli(['discord', 'watch', '--once'], env)).code, 0);
    const file = path.join(s.home, STATE_FILE);
    const good = JSON.parse(fs.readFileSync(file, 'utf8'));
    fake.add(FAKE.channelId, {content: '놓치면 안 되는 질문'});
    const variants = [
      {...good, threads: {123: 'bad-id'}}, {...good, threads: {abc: '123'}}, {...good, threads: []},
      {...good, skipped: {others: 'x', bots: 0, system: 0}}, {...good, skipped: {others: -1, bots: 0, system: 0}}, {...good, main: 12},
    ];
    for (const v of variants) {
      const text = JSON.stringify(v);
      fs.writeFileSync(file, text);
      const r = await runCli(['discord', 'watch', '--once'], env);
      assert.equal(r.code, 1, text);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /상태 파일이 깨져/);
      assert.equal(fs.readFileSync(file, 'utf8'), text, '원본 그대로');
      const { chat } = chatOf(fake);
      assert.ok(chat);
    }
    fs.writeFileSync(file, JSON.stringify({...good, threads: {123: 'bad-id'}}));
    const direct = chatOf(fake);
    fs.copyFileSync(file, path.join(direct.home, STATE_FILE));
    const lines = [];
    await assert.rejects(runWatch(direct.chat, {once: true, out: l => lines.push(l), err() {}}), /상태 파일이 깨져/);
    assert.deepEqual(lines, []);
  } finally { await fake.close(); }
});

test('28 N3 중단 신호가 막힌 출력 대기를 끝낸다 — 대기가 풀려도 cursor·반응은 그대로', async () => {
  const fake = await startFakeDiscord();
  try {
    const {chat, home} = chatOf(fake);
    await watchOnce(chat);
    const [a, b] = ['가', '나'].map(content => fake.add(FAKE.channelId, {content}));
    const controller = new AbortController();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const started = Date.now();
    const running = runWatch(chat, {once: true, out: () => { setTimeout(() => controller.abort(), 20); return gate; }, err() {}, signal: controller.signal});
    await running;
    assert.ok(Date.now() - started < 2000, '소비자가 안 읽어도 곧 끝난다');
    assert.ok(!fs.existsSync(path.join(home, LOCK_DIR)), '잠금을 돌려준다');
    const snap = fs.readFileSync(path.join(home, STATE_FILE), 'utf8');
    const reacts = fake.count(/PUT .*reactions/);
    release(); await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(fs.readFileSync(path.join(home, STATE_FILE), 'utf8'), snap);
    assert.equal(fake.count(/PUT .*reactions/), reacts);
    assert.deepEqual((await watchOnce(chat)).lines.map(l => l.id), [a.id, b.id], '다시 나온다(중복 쪽)');
  } finally { await fake.close(); }
});

test('29 N3 실제 CLI: 큰 질문 다수 + 파이프 미소비 + SIGTERM → 제한 시간 안에 종료·잠금 반환, 신호 뒤 cursor·반응 불변, 유실 0', async () => {
  const fake = await startFakeDiscord();
  let child;
  try {
    const s = setup(fake);
    const env = {...s.env, KADAN_HOME: s.home};
    assert.equal((await runCli(['discord', 'watch', '--once'], env)).code, 0);
    const ids = Array.from({length: 200}, (_, i) => fake.add(FAKE.channelId, {content: `질문${i} ` + 'x'.repeat(1900)}).id);
    child = spawn(process.execPath, [CLI, 'discord', 'watch'], {env: {PATH: process.env.PATH, ...env}, stdio: ['ignore', 'pipe', 'pipe']});
    let buffered = '';
    const closed = new Promise(resolve => child.on('exit', (code, signal) => resolve({code, signal}))); // 'close'는 파이프를 비워야 오므로 'exit'
    await new Promise(resolve => setTimeout(resolve, 2500)); // 파이프가 가득 차서 막힘
    const file = path.join(s.home, STATE_FILE);
    const snap1 = fs.readFileSync(file, 'utf8'), reacts1 = fake.count(/PUT .*reactions/);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(fs.readFileSync(file, 'utf8'), snap1, '막힌 동안 cursor는 멈춰 있다');
    assert.ok(fs.existsSync(path.join(s.home, LOCK_DIR)));
    const killedAt = Date.now();
    // 소비는 자식이 끝난 뒤에 재개한다. 신호 전에 재개하면 자식이 신호 처리 전에 남은 줄을 내고 cursor를 올려 snap1과 달라진다(시험 경합).
    child.kill('SIGTERM');
    const end = await Promise.race([closed, new Promise(resolve => setTimeout(() => resolve('timeout'), 6000))]);
    // 끝난 뒤 파이프에 남은 바이트를 소비자가 마저 받는다(파이프가 끝까지 비워질 때까지 기다린다)
    const drained = new Promise(resolve => { child.on('close', resolve); setTimeout(resolve, 3000); });
    child.stdout.on('data', c => { buffered += c; });
    await drained;
    assert.notEqual(end, 'timeout', 'SIGTERM 뒤 소비 재개 없이 종료한다');
    assert.ok(Date.now() - killedAt < 5000);
    assert.ok(!fs.existsSync(path.join(s.home, LOCK_DIR)), '잠금을 돌려준다');
    const cursorOf = text => { const v = JSON.parse(text); return JSON.stringify([v.main, v.threads]); };
    assert.equal(cursorOf(fs.readFileSync(file, 'utf8')), cursorOf(snap1), '신호 뒤 cursor 불변');
    assert.equal(fake.count(/PUT .*reactions/), reacts1, '신호 뒤 읽음 반응 불변');
    const next = await runCli(['discord', 'watch', '--once'], env); // 두 번째 watch 시작 가능
    assert.equal(next.code, 0, next.stderr);
    await new Promise(resolve => setTimeout(resolve, 100));
    const seen = new Set([...buffered.split('\n'), ...next.stdout.split('\n')].filter(l => l.startsWith('{')).map(l => { try { return JSON.parse(l).id; } catch { return null; } }));
    // 신호 전에 이미 파이프로 나간 줄(cursor 이하)은 소비자 몫이고, 그 뒤 줄은 다음 실행에서 다시 나와야 한다(유실 0).
    const emittedUpTo = BigInt(JSON.parse(snap1).main);
    assert.ok(ids.some(id => BigInt(id) <= emittedUpTo), '신호 전에 일부는 나갔다');
    assert.deepEqual(ids.filter(id => BigInt(id) > emittedUpTo && !seen.has(id)), [], '유실 0');
  } finally {
    try { await stopChild(child); } finally { await fake.close(); }
  }
});

test('30 N3 실제 CLI: 소비자가 끝까지 안 읽어도 SIGTERM으로 제한 시간 안에 종료하고 잠금을 돌려준다', async () => {
  const fake = await startFakeDiscord();
  let child;
  try {
    const s = setup(fake);
    const env = {...s.env, KADAN_HOME: s.home};
    assert.equal((await runCli(['discord', 'watch', '--once'], env)).code, 0);
    for (let i = 0; i < 100; i++) fake.add(FAKE.channelId, {content: `질문${i} ` + 'x'.repeat(1900)});
    child = spawn(process.execPath, [CLI, 'discord', 'watch'], {env: {PATH: process.env.PATH, ...env}, stdio: ['ignore', 'pipe', 'pipe']});
    const closed = new Promise(resolve => child.on('close', () => resolve('closed')));
    await new Promise(resolve => setTimeout(resolve, 2000));
    child.kill('SIGTERM'); // stdout을 끝까지 읽지 않는다
    const end = await Promise.race([closed, new Promise(resolve => setTimeout(() => resolve('timeout'), 5000))]);
    child.kill('SIGKILL');
    assert.equal(end, 'closed');
    assert.ok(!fs.existsSync(path.join(s.home, LOCK_DIR)));
  } finally {
    try { await stopChild(child); } finally { await fake.close(); }
  }
});
