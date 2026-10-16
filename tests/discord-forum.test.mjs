import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startFakeDiscord, FAKE} from './helpers/fake-discord-api.mjs';
import {createChat, runWatch, sendText, checkChat, STATE_FILE} from '../src/discord-chat.mjs';
import {createMailOut} from '../src/discord-mail.mjs';
import {Mailbox} from '../src/mailbox.mjs';
import {setThread} from '../src/notify-threads.mjs';

// 가짜 값만 쓴다. 레포 포럼 채널·웹훅은 모두 가짜 서버 안에서 만든다.
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), `kadan-dforum-${prefix}-`));
const noSleep = async () => {};
const suffix = name => name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
const REPOS = ['sample-app', 'kadan', 'rottie', 'sample-shorts'];

// forums: 비밀 파일에 키를 넣을 가짜 포럼 목록(fake.addForum의 반환값).
function setup(fake, forums = [], home = tmp('home')) {
  const botFile = path.join(home, 'bot.env'), hookFile = path.join(home, 'hook.env');
  fs.writeFileSync(botFile, `DISCORD_BOT_TOKEN=${FAKE.token}\nDISCORD_APPLICATION_ID=${FAKE.appId}\n`, {mode: 0o600});
  fs.writeFileSync(hookFile, `DISCORD_USER_ID=${FAKE.userId}\nDISCORD_WEBHOOK_URL_SECRETARY=https://discord.com/api/webhooks/${FAKE.hookId}/${FAKE.hookToken}\n`
    + forums.map(f => `DISCORD_WEBHOOK_URL_${suffix(f.name)}=${f.url}\n`).join(''), {mode: 0o600});
  const env = {KADAN_SECRET_DISCORD_BOT_FILE: botFile, KADAN_SECRET_DISCORD_FILE: hookFile, KADAN_DISCORD_API_BASE: fake.base, KADAN_NOTIFY: 'off'};
  return {home, env, chat: createChat({home, env, sleep: noSleep})};
}
const mailsOf = home => new Mailbox(home, '비서').list({all: true});
const bodyOf = (home, mail) => new Mailbox(home, '비서').read(mail.mailId).body;
const stateOf = home => JSON.parse(fs.readFileSync(path.join(home, STATE_FILE), 'utf8'));
const watchOnce = (chat, out, errs = []) => runWatch(chat, {once: true, out, err: e => errs.push(e)});
const lineSink = lines => line => { lines.push(line); };

test('1 레포 포럼 스레드의 kyle 새 글 → 비서 우편 1통(출처·스레드·업무 키), 재시작해도 다시 받지 않는다', async () => {
  const fake = await startFakeDiscord();
  try {
    const kadan = fake.addForum('kadan');
    const post = fake.addForumPost(kadan, {name: '[kadan] work-x 업무'});          // 웹훅이 올린 업무 글
    const {home, chat, env} = setup(fake, [kadan]);
    setThread(home, 'kadan/work-x', {threadId: post.id, statusMessageId: null});
    const out = createMailOut({home});
    await watchOnce(chat, out);                                                  // 기준선
    assert.equal(mailsOf(home).length, 0);
    const mine = fake.add(post.id, {content: '이거 어떻게 됐어?'});
    await watchOnce(chat, out);
    const [mail] = mailsOf(home);
    assert.equal(mailsOf(home).length, 1);
    assert.equal(mail.sourceKey, `discord:${mine.id}`);
    const body = bodyOf(home, mail);
    assert.match(body, /\[디코 kadan 포럼 새 글\]/);
    assert.match(body, /출처: 레포 포럼 kadan/);
    assert.match(body, new RegExp(`threadId: ${post.id}`));
    assert.match(body, /스레드 이름: \[kadan\] work-x 업무/);
    assert.match(body, /업무 키: kadan\/work-x/);
    assert.match(body, new RegExp(`kadan discord send --thread ${post.id} "<답>"`));
    assert.match(body, /슈퍼감독에게 kadan send로 넘긴다/);
    assert.equal(fake.count(/PUT .*reactions/), 1, '👀 읽음 반응');
    // 재시작(새 프로세스처럼): 같은 글을 다시 우편으로 만들지 않는다
    await watchOnce(createChat({home, env, sleep: noSleep}), createMailOut({home}));
    assert.equal(mailsOf(home).length, 1);
  } finally { await fake.close(); }
});

test('2 포럼 스레드의 웹훅·봇 글과 다른 사람 글 → 우편 0통', async () => {
  const fake = await startFakeDiscord();
  try {
    const kadan = fake.addForum('kadan');
    const post = fake.addForumPost(kadan);
    const {home, chat} = setup(fake, [kadan]);
    const out = createMailOut({home});
    await watchOnce(chat, out);
    fake.add(post.id, {content: '웹훅 경보', author: {id: kadan.hookId, bot: true}, webhook_id: kadan.hookId});
    fake.add(post.id, {content: '웹훅인데 봇 표시가 빠진 글', author: {id: kadan.hookId}, webhook_id: kadan.hookId});
    fake.add(post.id, {content: '봇 글', author: {id: FAKE.botId, bot: true}});
    fake.add(post.id, {content: '다른 사람', author: {id: FAKE.otherId}});
    fake.add(post.id, {content: '스레드 시스템 글', type: 21});
    await watchOnce(chat, out);
    assert.equal(mailsOf(home).length, 0);
    assert.deepEqual(stateOf(home).skipped, {others: 1, bots: 3, system: 1});
  } finally { await fake.close(); }
});

test('3 옛 모양 상태 파일 + 새 채널 4개 첫 회차 → 우편 0통, #비서 cursor 유지. 그 뒤 새 글부터, 등록 뒤 새 글은 시작 글부터', async () => {
  const fake = await startFakeDiscord();
  try {
    const forums = REPOS.map(n => fake.addForum(n));
    // 옛 글: 이미 열려 있는 글 4개(결정 요청 글의 옛 "1"·"2" 포함), 닫혀 있는 옛 글 1개
    const olds = forums.map((f, i) => {
      const t = fake.addForumPost(f, {name: `${f.name} 결정`});
      fake.add(t.id, {content: '1'}); fake.add(t.id, {content: i % 2 ? '2' : '옛 질문'});
      return t;
    });
    const sleeping = fake.addForumPost(forums[1], {name: '닫힌 옛 글'});
    fake.add(sleeping.id, {content: '1'});
    fake.threads.get(sleeping.id).archived = true;
    // 옛 상태 파일: 포럼 키가 없는 설정으로 한 번 돌려 만든다(forums 칸이 없는 모양으로 고쳐 둔다)
    const topic = fake.add(FAKE.channelId, {content: '#비서 옛 주제'});
    const first = setup(fake, []);
    const home = first.home;
    await watchOnce(first.chat, createMailOut({home}));
    const legacy = stateOf(home);
    delete legacy.forums;
    fs.writeFileSync(path.join(home, STATE_FILE), JSON.stringify(legacy) + '\n');
    const mainBefore = legacy.main;
    assert.ok(mainBefore);
    // 이제 포럼 4개를 등록하고 첫 회차
    const second = setup(fake, forums, home);
    const mails = createMailOut({home});
    const errs = [];
    await watchOnce(second.chat, mails, errs);
    assert.equal(mailsOf(home).length, 0, '옛 글 재생 0');
    const st = stateOf(home);
    assert.equal(st.main, mainBefore, '#비서 cursor 그대로');
    assert.equal(Object.keys(st.forums).length, 4);
    for (const t of olds) assert.ok(st.threads[t.id], '열려 있던 글은 기준선이 잡혔다');
    // 등록된 상태에서 새 kyle 글만 받는다
    fake.add(olds[0].id, {content: '새 질문'});
    await watchOnce(second.chat, mails);
    assert.deepEqual(mailsOf(home).map(m => bodyOf(home, m).split('---\n')[1].trim()), ['새 질문']);
    // 닫혀 있던 옛 글이 다시 열려도 옛 "1"은 받지 않고, 다시 연 새 글만 받는다
    fake.threads.get(sleeping.id).archived = false;
    fake.add(sleeping.id, {content: '다시 열며 쓰는 글'});
    await watchOnce(second.chat, mails);
    assert.deepEqual(mailsOf(home).map(m => bodyOf(home, m).split('---\n')[1].trim()).sort(), ['다시 열며 쓰는 글', '새 질문'].sort());
    // 등록 뒤에 kyle이 포럼에 직접 올린 새 글(시작 글이 kyle 글)은 첫 글부터 받는다
    const mine = fake.addForumPost(forums[2], {name: 'kyle이 올린 글', content: '새 글 시작', webhook: false});
    await watchOnce(second.chat, mails);
    assert.equal(mailsOf(home).length, 3);
    assert.ok(mailsOf(home).some(m => m.sourceKey === `discord:${mine.id}`));
    void topic;
  } finally { await fake.close(); }
});

test('3b 처음 실행(상태 없음)도 포럼의 옛 글을 받지 않는다', async () => {
  const fake = await startFakeDiscord();
  try {
    const kadan = fake.addForum('kadan');
    const t = fake.addForumPost(kadan);
    fake.add(t.id, {content: '1'});
    const {home, chat} = setup(fake, [kadan]);
    await watchOnce(chat, createMailOut({home}));
    assert.equal(mailsOf(home).length, 0);
    assert.ok(stateOf(home).threads[t.id]);
  } finally { await fake.close(); }
});

test('3c 상태 파일의 forums 칸이 틀리면 멈춘다(원본 그대로)', async () => {
  const fake = await startFakeDiscord();
  try {
    const {home, chat} = setup(fake, []);
    await watchOnce(chat, () => {});
    const bad = {...stateOf(home), forums: {notahash: 1}};
    fs.writeFileSync(path.join(home, STATE_FILE), JSON.stringify(bad) + '\n');
    const before = fs.readFileSync(path.join(home, STATE_FILE), 'utf8');
    await assert.rejects(watchOnce(setup(fake, [], home).chat, () => {}), /깨져 있어/);
    assert.equal(fs.readFileSync(path.join(home, STATE_FILE), 'utf8'), before);
  } finally { await fake.close(); }
});

test('4 send --thread: 등록된 포럼 스레드는 허용, 등록 안 된 채널·다른 서버·채널 직접 글은 거절. 울림은 #비서와 같다', async () => {
  const fake = await startFakeDiscord();
  try {
    const kadan = fake.addForum('kadan');
    const stranger = fake.addForum('not-registered');
    const post = fake.addForumPost(kadan), foreign = fake.addForumPost(stranger);
    const {chat} = setup(fake, [kadan]);
    await sendText(chat, '최종 답', {thread: post.id});
    await sendText(chat, '하는 중', {thread: post.id, quiet: true});
    const posts = fake.messages.get(post.id).filter(m => m._body);
    assert.match(posts[0].content, /^<@\d+> 최종 답$/);
    assert.deepEqual(posts[0]._body.allowed_mentions, {users: [FAKE.userId]});
    assert.equal(posts[0]._body.flags, undefined);
    assert.equal(posts[1]._body.flags, 4096);
    assert.deepEqual(posts[1]._body.allowed_mentions, {parse: []});
    const before = fake.count(/POST .*messages$/);
    await assert.rejects(sendText(chat, '새면 안 됨', {thread: foreign.id}), /등록된 레포 포럼/);
    assert.equal(fake.count(/POST .*messages$/), before);
    // 채널 본문에 바로 쓰는 새 글은 #비서만(스레드 없이 보내면 #비서)
    const [direct] = await sendText(chat, '직접 글');
    assert.equal(direct.channelId, FAKE.channelId);
  } finally { await fake.close(); }
});

test('5 다른 서버의 포럼과 포럼이 아닌 채널은 빼고 경고한다. 푼 채널은 계속 받는다', async () => {
  const fake = await startFakeDiscord();
  try {
    const good = fake.addForum('kadan');
    const otherGuild = fake.addForum('rottie', {guildId: '550000000000000099'});
    const text = fake.addForum('sample-app', {type: 0});
    const {home, chat} = setup(fake, [good, otherGuild, text]);
    const errs = [];
    const lines = [];
    await watchOnce(chat, lineSink(lines), errs);
    assert.ok(errs.some(e => /rottie.*다른 서버/.test(e)), errs.join('\n'));
    assert.ok(errs.some(e => /sample-app.*포럼 채널이 아니다/.test(e)));
    assert.equal(errs.filter(e => /레포 포럼 kadan/.test(e)).length, 0);
    assert.equal(Object.keys(stateOf(home).forums).length, 1);
    const check = await checkChat(chat);
    assert.ok(check.some(l => /레포 포럼 kadan: 받는 중/.test(l)));
    assert.ok(check.some(l => /레포 포럼 rottie: 받지 않음/.test(l)));
    for (const l of check) { assert.ok(!l.includes(good.id) && !l.includes(good.hookToken)); }
  } finally { await fake.close(); }
});

test('6 포럼 읽기 권한이 아직 없으면 #비서는 그대로 받고, 권한이 생기면 그때 기준선부터 등록한다', async () => {
  const fake = await startFakeDiscord();
  try {
    const kadan = fake.addForum('kadan');
    const post = fake.addForumPost(kadan);
    fake.add(post.id, {content: '1'});
    let now = Date.now();
    const s = setup(fake, [kadan]);
    const chat = createChat({home: s.home, env: s.env, sleep: noSleep, now: () => now});
    // 포럼 채널 조회만 한 번 거절한다(봇 권한이 아직 없는 상태)
    fake.inject({match: new RegExp(`GET /channels/${kadan.id}$`), status: 403, body: {code: 50001}, times: 1});
    const lines = [], errs = [];
    const top = fake.add(FAKE.channelId, {content: '#비서 글은 계속 받는다'});
    await watchOnce(chat, lineSink(lines), errs);
    assert.ok(errs.some(e => /레포 포럼 kadan: 받지 않는다/.test(e)));
    const again = [];
    now += 6 * 60 * 1000;                                                    // 다시 풀 시각
    await watchOnce(chat, lineSink(again), errs);
    assert.equal(lines.concat(again).filter(l => l.channel === 'kadan').length, 0, '옛 글 재생 0');
    assert.ok(Object.keys(stateOf(s.home).forums).length === 1);
    void top;
  } finally { await fake.close(); }
});
