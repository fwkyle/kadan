import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {startFakeDiscord, FAKE} from './helpers/fake-discord-api.mjs';
import {createChat, runWatch} from '../src/discord-chat.mjs';
import {createMailOut} from '../src/discord-mail.mjs';
import {createDecisionAnswerer, matchChoice, writtenAfter, LATE_ANSWER_MS, HANDLED_FILE} from '../src/discord-decision.mjs';
import {DecisionStore} from '../src/decisions.mjs';
import {CardStore} from '../src/card-store.mjs';
import {Mailbox} from '../src/mailbox.mjs';
import {setDecision, readDecisions} from '../src/notify-threads.mjs';
import {readStream, appendStream} from '../src/storage.mjs';
import {isUserActor} from '../src/actors.mjs';

// 가짜 값만 쓴다. 결정 기록은 시험의 격리 홈에서만 한다.
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), `kadan-ddec-${prefix}-`));
const noSleep = async () => {};
const SUPER = 'kadan-슈퍼감독';

// 포럼 하나 + 글 하나, 결정 저장소(알림은 가짜), 다리의 한 바퀴를 돌리는 함수를 만든다.
async function world(fake, {register = true, resolve} = {}) {
  const home = tmp('home'), botFile = path.join(home, 'bot.env'), hookFile = path.join(home, 'hook.env');
  const forum = fake.addForum('kadan'), post = fake.addForumPost(forum, {name: '[kadan] 결정'});
  fs.writeFileSync(botFile, `DISCORD_BOT_TOKEN=${FAKE.token}\nDISCORD_APPLICATION_ID=${FAKE.appId}\n`, {mode: 0o600});
  const baseHook = `DISCORD_USER_ID=${FAKE.userId}\nDISCORD_WEBHOOK_URL_SECRETARY=https://discord.com/api/webhooks/${FAKE.hookId}/${FAKE.hookToken}\n${register ? `DISCORD_WEBHOOK_URL_KADAN=${forum.url}\n` : ''}`;
  fs.writeFileSync(hookFile, baseHook, {mode: 0o600});
  const env = {KADAN_SECRET_DISCORD_BOT_FILE: botFile, KADAN_SECRET_DISCORD_FILE: hookFile, KADAN_DISCORD_API_BASE: fake.base, KADAN_NOTIFY: 'off'};
  let chat = createChat({home, env, sleep: noSleep});
  new CardStore(home).create({repo: 'kadan', id: 'card-a', repoPath: home, body: '# 시험'});
  const calls = {notify: [], user: []};
  const store = new DecisionStore(home, {notify: (role, message) => calls.notify.push({role, message}), userNotify: (message, opts) => { calls.user.push({message, opts}); return null; }});
  const errs = [];
  let decide = createDecisionAnswerer({home, chat, env, log: e => errs.push(e), store});
  const mailOut = createMailOut({home, ...(resolve ? {resolve} : {})});
  const emit = async line => { const done = await decide(line); return done === true ? undefined : mailOut(line, done || {}); };
  const w = {home, fake, forum, post, get chat() { return chat; }, store, calls, errs, get decide() { return decide; }, env,
    run: () => runWatch(chat, {once: true, out: emit, err: e => errs.push(e)}),
    // 나중에 포럼 키를 비밀 파일에 더하고 새 프로세스처럼 다시 만든다(옛 모양 상태 파일 위에 새 채널 등록)
    hookFile,
    rebuild() {                                                       // 새 프로세스처럼 chat·처리기를 다시 만든다
      chat = createChat({home, env, sleep: noSleep});
      decide = createDecisionAnswerer({home, chat, env, log: e => errs.push(e), store});
    },
    disableForum() {                                                  // 포럼 키를 비밀 파일에서 뺀다(등록 해제)
      fs.writeFileSync(hookFile, baseHook.split('\n').filter(l => !l.startsWith('DISCORD_WEBHOOK_URL_KADAN=')).join('\n'), {mode: 0o600});
      chat = createChat({home, env, sleep: noSleep});
      decide = createDecisionAnswerer({home, chat, env, log: e => errs.push(e), store});
    },
    enableForum() {
      fs.writeFileSync(hookFile, baseHook.split('\n').filter(l => !l.startsWith('DISCORD_WEBHOOK_URL_KADAN=')).join('\n'), {mode: 0o600});
      fs.appendFileSync(hookFile, `DISCORD_WEBHOOK_URL_KADAN=${forum.url}\n`);
      chat = createChat({home, env, sleep: noSleep});
      decide = createDecisionAnswerer({home, chat, env, log: e => errs.push(e), store});
    },
    mails: () => new Mailbox(home, '비서').list({all: true}),
    // 결정 요청을 만들고 요청 메시지(봇 글)가 post에 있는 것처럼 기록한다(notify-threads의 decisions)
    decision(question, options = ['합침', '보류'], thread = post) {
      const d = store.request('kadan/card-a', {question: `${question}\n- 확인 경로 없음: 시험`, options, recommendation: options[0], reason: '이유', work: '없음'}, SUPER);
      const msg = fake.add(thread.id, {content: `결정 요청: ${question}`, author: {id: FAKE.botId, bot: true}});
      setDecision(home, d.id, {threadId: thread.id, messageId: msg.id, forum: true});
      return {d, msg};
    },
    botPosts: (thread = post) => fake.messages.get(thread.id).filter(m => m._body),
    answers: () => store.list().filter(d => d.status === 'answered'),   // 결정마다 최신 상태 하나
  };
  await w.run();                                                   // 기준선
  return w;
}

test('5 결정 답: (가) 답장+번호, (가) 답장+정확한 문구, (나) 열린 결정 하나+번호 → 사람 명의·source discord·글 id로 기록, 기록됨 조용한 글 1개', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    const a = w.decision('A를 합칠까요?');
    const mine = fake.add(w.post.id, {content: ' 2 ', type: 19, message_reference: {message_id: a.msg.id}});
    await w.run();
    let e = w.store.get(a.d.id);
    assert.equal(e.status, 'answered');
    assert.deepEqual([e.answer.by, e.answer.choice, e.answer.text, e.answer.source, e.answer.messageId], ['사람', '보류', '보류', 'discord', mine.id]);
    assert.ok(isUserActor(e.answer.by));
    assert.equal(w.calls.notify.length, 1, '요청한 감독에게 통지가 한 번');
    assert.match(w.calls.notify[0].message, /결정 답변/);
    const posts = w.botPosts().filter(m => m.content.startsWith('기록됨'));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].content, '기록됨: 보류');
    assert.equal(posts[0]._body.flags, 4096, '조용히');
    assert.deepEqual(posts[0]._body.allowed_mentions, {parse: []});
    assert.equal(w.mails().length, 0, '우편 0통');
    assert.ok(fake.messages.get(w.post.id).find(m => m.id === mine.id).reactions?.some(r => r.emoji.name === '👀'));
    assert.equal(w.answers().length, 1);

    const b = w.decision('B를 켤까요?', ['켠다', '끈다']);
    fake.add(w.post.id, {content: '켠다', type: 19, message_reference: {message_id: b.msg.id}});
    await w.run();
    assert.equal(w.store.get(b.d.id).answer.choice, '켠다');

    const c = w.decision('C는요?', ['예', '아니오']);               // 이제 열린 결정이 이것 하나뿐이다
    fake.add(w.post.id, {content: '1'});                            // 답장 아님
    await w.run();
    assert.equal(w.store.get(c.d.id).answer.choice, '예');
    assert.equal(w.mails().length, 0);
    assert.equal(w.answers().length, 3);
  } finally { await fake.close(); }
});

test('5b 답이 기록되면 기존 경로가 그대로 돈다: 요청 감독 통지와 사용자 알림(요청 메시지 해결 고치기)', async () => {
  const fake = await startFakeDiscord();
  const before = process.env.KADAN_NOTIFY;
  try {
    const w = await world(fake);
    const a = w.decision('A를 합칠까요?');
    process.env.KADAN_NOTIFY = '';                                   // announce는 KADAN_NOTIFY=off면 아무것도 보내지 않는다 — 이 시험에서만 끈다
    fake.add(w.post.id, {content: '1', type: 19, message_reference: {message_id: a.msg.id}});
    w.calls.user.length = 0;
    await w.run();
    const answered = w.calls.user.filter(c => c.opts.kind === 'decision-answer');
    assert.equal(answered.length, 1);
    assert.equal(answered[0].opts.decision.id, a.d.id);
    assert.match(answered[0].opts.decision.edit, /해결됨/);
  } finally { process.env.KADAN_NOTIFY = before; await fake.close(); }
});

test('6 (가) 답장+맞지 않는 글 → 되묻지 않고 자유 답(text)으로 기록: 사람 명의·source discord·글 id, 요청 감독 통지에 본문, 기록됨(기타 답) 조용한 글 1개', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    const a = w.decision('A를 합칠까요?', ['합침', '보류']);
    const body = '합침 — 이유는 이렇다\n둘째 줄';
    const mine = fake.add(w.post.id, {content: body, type: 19, message_reference: {message_id: a.msg.id}});
    fake.add(w.post.id, {content: '또 다른 말', type: 19, message_reference: {message_id: a.msg.id}});   // 이미 답변됨 → 기록 바꾸지 않음
    await w.run();
    const e = w.store.get(a.d.id);
    assert.equal(e.status, 'answered');
    assert.deepEqual([e.answer.by, e.answer.choice, e.answer.text, e.answer.source, e.answer.messageId], ['사람', null, body, 'discord', mine.id]);
    assert.ok(isUserActor(e.answer.by));
    assert.equal(w.calls.notify.length, 1, '요청 감독에게 통지 한 번');
    assert.ok(w.calls.notify[0].message.includes(body), '통지에 kyle 글 본문 전체');
    const logged = w.botPosts().filter(m => m.content.startsWith('기록됨(기타 답)'));
    assert.equal(logged.length, 1);
    assert.equal(logged[0].content, '기록됨(기타 답): 합침 — 이유는 이렇다 둘째 줄');
    assert.equal(logged[0]._body.flags, 4096, '조용히');
    assert.deepEqual(logged[0]._body.allowed_mentions, {parse: []});
    assert.equal(w.botPosts().filter(m => /기록하지 않았습니다|열린 결정이 여러 개/.test(m.content)).length, 0, '되묻기 0');
    assert.equal(w.mails().length, 0);
    // 요청 감독이 이것이 답이 아니었다고 보면 취소할 수 있다 → 같은 질문을 다시 요청
    assert.equal(w.answers().length, 1);
  } finally { await fake.close(); }
});

test('6b (나) 열린 결정 하나+맞지 않는 글 → 자유 답으로 기록(결정과 무관한 말도 답이 된다 — kyle 해석). 본문 없는 글은 답이 아니라 우편', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    const a = w.decision('A를 합칠까요?', ['합침', '보류']);
    const mine = fake.add(w.post.id, {content: '1번이 좋아 보이네'});
    await w.run();
    const e = w.store.get(a.d.id);
    assert.deepEqual([e.status, e.answer.choice, e.answer.text, e.answer.messageId], ['answered', null, '1번이 좋아 보이네', mine.id]);
    assert.equal(w.botPosts().filter(m => m.content.startsWith('기록됨(기타 답)')).length, 1);
    assert.equal(w.mails().length, 0);
    const b = w.decision('B를 켤까요?', ['켠다', '끈다']);
    fake.add(w.post.id, {content: '', attachments: [{id: '1', url: 'x'}]});
    await w.run();
    assert.equal(w.store.get(b.d.id).status, 'open', '본문 없는 글은 기록하지 않는다');
    assert.equal(w.mails().length, 1);
  } finally { await fake.close(); }
});

test('6c 열린 결정 둘 이상+답장 없음 → 기록 0건, 되묻기 0, 일반 우편 1통(머리에 열린 결정 N개 — 어느 결정인지 특정 안 됨)', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake, {resolve: () => ({to: 'zeta-슈퍼감독', reason: null, workKey: null})});   // 받는이 찾기는 discord-route 시험이 맡는다
    w.decision('A를 합칠까요?', ['합침', '보류']);
    w.decision('B를 켤까요?', ['켠다', '끈다']);
    fake.add(w.post.id, {content: '2'});                             // 선택지처럼 보이는 글
    await w.run();
    assert.equal(w.answers().length, 0);
    assert.equal(w.botPosts().filter(m => /기록하지 않았습니다|열린 결정이 여러 개/.test(m.content)).length, 0, '되묻기 0');
    assert.equal(w.mails().length, 0, '비서 우편 0통');
    const box = new Mailbox(w.home, 'zeta-슈퍼감독'), mails = box.list({all: true});
    assert.equal(mails.length, 1, '레포 슈퍼 우편 1통');
    assert.match(box.read(mails[0].mailId).body, /열린 결정 2개 — 어느 결정인지 특정 안 됨/);
  } finally { await fake.close(); }
});

test('7 이미 답변·취소된 결정에 답장 → 기록 0건, 조용한 안내 1개. 같은 글을 다시 처리해도 추가 기록·글 0', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    const a = w.decision('A를 합칠까요?');
    const b = w.decision('B를 켤까요?', ['켠다', '끈다']);
    w.store.answer(a.d.id, {revision: 1, text: '합침', choice: '합침'}, '사람');
    w.store.cancel(b.d.id, {revision: 1, reason: '필요 없어짐'}, SUPER);
    const events = readStream(w.home, 'decisions/events.jsonl', {optional: true}).length;
    const r1 = fake.add(w.post.id, {content: '2', type: 19, message_reference: {message_id: a.msg.id}});
    const r2 = fake.add(w.post.id, {content: '1', type: 19, message_reference: {message_id: b.msg.id}});
    await w.run();
    assert.equal(readStream(w.home, 'decisions/events.jsonl', {optional: true}).length, events, '기록 0건');
    const notes = w.botPosts().filter(m => /이미 (답변|취소)됨/.test(m.content));
    assert.equal(notes.length, 2);
    assert.match(notes[0].content, /^이미 답변됨: 합침/);
    assert.match(notes[1].content, /^이미 취소됨/);
    for (const n of notes) { assert.equal(n._body.flags, 4096); assert.deepEqual(n._body.allowed_mentions, {parse: []}); }
    assert.equal(w.mails().length, 0);
    // 같은 글을 다시 처리(재시작 뒤 중복 포함): 새 처리기로 같은 줄을 넣는다
    const again = createDecisionAnswerer({home: w.home, chat: w.chat, env: w.env, store: w.store});
    const line = id => ({id, where: 'thread', threadId: w.post.id, channel: 'kadan', content: '2', replyTo: a.msg.id});
    const posts = w.botPosts().length;
    assert.equal(await again(line(r1.id)), true);
    assert.equal(await again(line(r2.id)), true);
    assert.equal(w.botPosts().length, posts, '추가 글 0');

    // 기록된 답의 글 id를 다시 처리해도(처리 표시가 없어도) 추가 기록·글이 없다
    const c = w.decision('C는요?', ['예', '아니오']);
    const mine = fake.add(w.post.id, {content: '1', type: 19, message_reference: {message_id: c.msg.id}});
    await w.run();
    assert.equal(w.answers().length, 2);
    fs.rmSync(path.join(w.home, HANDLED_FILE));
    const afterRecord = w.botPosts().length;
    assert.equal(await again({id: mine.id, where: 'thread', threadId: w.post.id, channel: 'kadan', content: '1', replyTo: c.msg.id}), true);
    assert.equal(w.answers().length, 2);
    assert.equal(w.botPosts().length, afterRecord);
  } finally { await fake.close(); }
});

test('8 비서 이름으로는 여전히 거절되고, 출처 칸이 없는 옛 이력도 읽힌다. 알 수 없는 출처는 거절', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    const a = w.decision('A를 합칠까요?');
    for (const by of ['비서', '디코', SUPER]) assert.throws(() => w.store.answer(a.d.id, {revision: 1, choice: '합침', source: 'discord', messageId: '1'}, by), /사람 명의/);
    assert.throws(() => w.store.answer(a.d.id, {revision: 1, choice: '합침', source: 'slack'}, '사람'), /출처/);
    assert.equal(w.store.get(a.d.id).status, 'open');
    // CLI 방식(출처 없음) 답은 그대로 기록되고 필드가 붙지 않는다
    const done = w.store.answer(a.d.id, {revision: 1, text: '합침', choice: '합침'}, '사람');
    assert.ok(done);
    const rec = w.store.get(a.d.id);
    assert.equal(rec.answer.source, undefined);
    assert.equal(rec.answer.messageId, undefined);
    assert.equal(w.store.list().length, 1);
    // 손상된 출처 칸은 이력 손상으로 본다
    const b = w.decision('B를 켤까요?', ['켠다', '끈다']);
    appendStream(w.home, 'decisions/events.jsonl', {...w.store.get(b.d.id), revision: 2, status: 'answered', answer: {by: '사람', text: '켠다', choice: '켠다', at: new Date().toISOString(), source: 'slack'}});
    assert.throws(() => w.store.list(), /결정 이력 손상/);
  } finally { await fake.close(); }
});

test('9 결정 답 후보가 아닌 곳: 다른 스레드·#비서 스레드·요청 메시지가 기록되지 않은 결정은 일반 글(우편)', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    const other = fake.addForumPost(w.forum, {name: '다른 글'});
    const a = w.decision('A를 합칠까요?');
    const topic = fake.add(FAKE.channelId, {content: '#비서 주제', author: {id: FAKE.botId, bot: true}});
    const th = fake.addThread(topic);
    await w.run();                                                   // 새 글(다른 글·#비서 스레드)의 기준선
    fake.add(other.id, {content: '1'});                              // 요청 글이 없는 다른 스레드
    fake.add(th.id, {content: '1'});                                 // #비서 스레드
    await w.run();
    assert.equal(w.answers().length, 0);
    assert.equal(w.mails().length, 2);
    assert.equal(w.store.get(a.d.id).status, 'open');
    // 요청 메시지 위치가 기록되지 않은 결정은 후보가 아니다
    w.store.request('kadan/card-a', {question: '기록 없는 결정?\n- 확인 경로 없음: 시험', options: ['예', '아니오'], recommendation: '예', reason: '이유', work: '없음'}, SUPER);
    assert.equal(Object.keys(readDecisions(w.home)).length, 1);
  } finally { await fake.close(); }
});

test('10 정확히 맞춤 규칙: 번호는 1부터 선택지 수까지, 문구는 앞뒤 공백만 무시', () => {
  const o = ['합침', '보류', '나중에'];
  assert.equal(matchChoice(o, '1'), '합침');
  assert.equal(matchChoice(o, ' 3\n'), '나중에');
  assert.equal(matchChoice(o, '보류'), '보류');
  for (const bad of ['0', '4', '01', '1번', '1 — 이유', '합', '합침 ', '보류!', '', '1.', '１']) {
    if (bad === '합침 ') assert.equal(matchChoice(o, bad), '합침', '앞뒤 공백만 지운다');
    else assert.equal(matchChoice(o, bad), null, JSON.stringify(bad));
  }
});

test('11 옛 모양 상태 파일 위에 포럼을 새로 등록한 첫 회차: 결정 요청 글의 옛 "1"·"2"는 기록 0건·우편 0통, 그 뒤 새 답은 기록', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake, {register: false});                // #비서만 받던 때의 상태 파일
    const a = w.decision('A를 합칠까요?');
    fake.add(w.post.id, {content: '1'});                           // 등록 전에 kyle이 써 둔 옛 답
    fake.add(w.post.id, {content: '2', type: 19, message_reference: {message_id: a.msg.id}});
    const mainBefore = JSON.parse(fs.readFileSync(path.join(w.home, 'discord-chat-state.json'), 'utf8')).main;
    w.enableForum();
    await w.run();
    assert.equal(w.answers().length, 0, '결정 기록 0건');
    assert.equal(w.mails().length, 0, '우편 0통');
    assert.equal(w.botPosts().filter(m => /기록|열린 결정/.test(m.content)).length, 0, '디코 응답 글 0');
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.home, 'discord-chat-state.json'), 'utf8')).main, mainBefore, '#비서 cursor 유지');
    fake.add(w.post.id, {content: '2', type: 19, message_reference: {message_id: a.msg.id}});
    await w.run();
    assert.equal(w.store.get(a.d.id).answer.choice, '보류');
  } finally { await fake.close(); }
});

function runCli(args, env) {
  const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cli, ...args], {env: {PATH: process.env.PATH, ...env}, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', code => resolve({code, stdout, stderr}));
  });
}

test('12 실제 CLI(watch --once --to-mail): 포럼 스레드의 결정 답은 기록되고 우편이 되지 않으며, 일반 글은 우편이 된다', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    const a = w.decision('A를 합칠까요?');
    const env = {...w.env, KADAN_HOME: w.home};
    const base = await runCli(['discord', 'watch', '--once', '--to-mail'], env);
    assert.equal(base.code, 0, base.stderr);
    const mine = fake.add(w.post.id, {content: '1', type: 19, message_reference: {message_id: a.msg.id}});
    fake.add(w.post.id, {content: '결정 말고 다른 질문이야'});
    const r = await runCli(['discord', 'watch', '--once', '--to-mail'], env);
    assert.equal(r.code, 0, r.stderr);
    const d = w.store.get(a.d.id);
    assert.equal(d.status, 'answered');
    assert.deepEqual([d.answer.by, d.answer.choice, d.answer.source, d.answer.messageId], ['사람', '합침', 'discord', mine.id]);
    assert.equal(w.mails().length, 1, '일반 글만 우편');
    assert.equal(w.botPosts().filter(m => m.content === '기록됨: 합침').length, 1);
    for (const v of [FAKE.token, FAKE.hookToken, FAKE.userId]) assert.ok(!(r.stdout + r.stderr).includes(v), '출력에 비밀값 없음');
  } finally { await fake.close(); }
});

test('13 F1 결정과 무관한 글에 대한 답장은 결정 답이 아니다(경보 글·다른 스레드 결정·모르는 메시지) → 기록 0, 우편', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    const other = fake.addForumPost(w.forum, {name: '다른 글'});
    const a = w.decision('A를 합칠까요?');                            // 이 스레드의 열린 결정은 하나
    const b = w.decision('B를 켤까요?', ['켠다', '끈다'], other);     // 다른 스레드의 결정
    await w.run();
    const alert = fake.add(w.post.id, {content: '경보', author: {id: FAKE.botId, bot: true}});
    fake.add(w.post.id, {content: '1', type: 19, message_reference: {message_id: alert.id}});      // 경보 글에 답장
    fake.add(w.post.id, {content: '1', type: 19, message_reference: {message_id: b.msg.id}});      // 다른 스레드 결정의 요청 글을 가리킴
    fake.add(w.post.id, {content: '1', type: 19, message_reference: {message_id: '1'}});           // 모르는 메시지
    await w.run();
    assert.equal(w.answers().length, 0);
    assert.equal(w.store.get(a.d.id).status, 'open');
    assert.equal(w.store.get(b.d.id).status, 'open');
    assert.equal(w.mails().length, 3, '일반 글로 우편');
    assert.equal(w.botPosts().filter(m => /기록됨/.test(m.content)).length, 0);
  } finally { await fake.close(); }
});

test('14 0번 규칙: 결정 요청 메시지보다 먼저 쓰인 글은 어떤 상태에서도 그 결정의 답이 아니다', async () => {
  assert.equal(writtenAfter('6', '5'), true);
  assert.equal(writtenAfter('5', '5'), false, '같은 id');
  assert.equal(writtenAfter('4', '5'), false);
  assert.equal(writtenAfter('abc', '5'), false);
  assert.equal(writtenAfter('5', undefined), false);
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    const old = fake.add(w.post.id, {content: '1'});                  // 요청보다 먼저 쓴 글
    const a = w.decision('A를 합칠까요?');
    const line = {id: old.id, where: 'thread', threadId: w.post.id, channel: 'kadan', content: '1'};
    assert.equal(await w.decide(line), false, '일반 글');
    assert.equal(w.answers().length, 0);
    const reply = {...line, replyTo: a.msg.id};                       // 요청에 답장한 척해도 id가 앞서면 아니다
    assert.equal(await w.decide(reply), false);
    assert.equal(w.answers().length, 0);
  } finally { await fake.close(); }
});

test('15 F4 우편으로 이미 저장된 글은 다시 분류하지 않는다(우편 저장 직후 cursor 저장 전에 죽은 뒤 새 결정이 생겨도 기록 0)', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    const mine = fake.add(w.post.id, {content: '1'});                 // 열린 결정이 없을 때 받은 글
    const line = {id: mine.id, where: 'thread', threadId: w.post.id, channel: 'kadan', content: '1'};
    assert.equal(await w.decide(line), false);
    createMailOut({home: w.home})(line);                              // 우편 저장까지 됐고 cursor는 아직(죽음)
    // 요청 메시지 위치만 이 글보다 앞선 것으로 둔 결정(바탕 규칙을 통과하는 경우): 우편으로 저장된 글이라 다시 분류하지 않는다
    const a = w.store.request('kadan/card-a', {question: 'A?\n- 확인 경로 없음: 시험', options: ['예', '아니오'], recommendation: '예', reason: '이유', work: '없음'}, SUPER);
    setDecision(w.home, a.id, {threadId: w.post.id, messageId: String(BigInt(mine.id) - 1n), forum: true});
    const restarted = createDecisionAnswerer({home: w.home, chat: w.chat, env: w.env, store: w.store});
    assert.equal(await restarted(line), true, '이미 처리된 글: 아무것도 하지 않는다');
    assert.equal(w.answers().length, 0);
    assert.equal(w.botPosts().length, 0);
    assert.equal(w.mails().length, 1);
  } finally { await fake.close(); }
});

test('16 F2-A 포럼 등록이 풀린 사이에 쓴 kyle 답은 다시 등록해도 재생되지 않는다(우편 0·기록 0·응답 0)', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    const a = w.decision('A를 합칠까요?');
    w.disableForum();
    await w.run();                                                    // 등록이 빠진 한 회차
    fake.add(w.post.id, {content: '2', type: 19, message_reference: {message_id: a.msg.id}});   // 제외 중에 쓴 답
    w.enableForum();
    await w.run();                                                    // 키 복원 뒤 첫 회차
    assert.equal(w.answers().length, 0);
    assert.equal(w.store.get(a.d.id).status, 'open');
    assert.equal(w.mails().length, 0);
    assert.equal(w.botPosts().filter(m => /기록|이미|열린 결정/.test(m.content)).length, 0);
    // 재등록 뒤 새로 쓴 답은 받는다
    fake.add(w.post.id, {content: '2', type: 19, message_reference: {message_id: a.msg.id}});
    await w.run();
    assert.equal(w.store.get(a.d.id).answer.choice, '보류');
  } finally { await fake.close(); }
});

test('17 F2-B 빈 forums와 옛 스레드 cursor가 함께 남은 상태에서 대기 중인 답은 재생되지 않는다', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    const a = w.decision('A를 합칠까요?');
    const file = path.join(w.home, 'discord-chat-state.json');
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(Object.keys(st.threads).length);
    fs.writeFileSync(file, JSON.stringify({...st, forums: {}, forumRepos: {}}) + '\n');   // 형식은 정상, 등록만 비었다
    fake.add(w.post.id, {content: '1', type: 19, message_reference: {message_id: a.msg.id}});
    w.enableForum();                                                  // 새 프로세스처럼
    await w.run();
    assert.equal(w.answers().length, 0);
    assert.equal(w.mails().length, 0);
    assert.equal(w.store.get(a.d.id).status, 'open');
  } finally { await fake.close(); }
});

test('18 R1 손상된 요청 메시지 id(0x1·+1·-1·공백·소수)나 글 id는 결정 답 후보에서 뺀다 → 기록 0, 일반 글', async () => {
  assert.equal(writtenAfter('6', '5'), true);
  for (const bad of ['0x1', '+1', '-1', ' 1', '1 ', '1.5', '', '0', '01', 'abc', '1e3', '١', undefined, null, 5]) {
    assert.equal(writtenAfter('99', bad), false, `요청 id ${JSON.stringify(bad)}`);
    assert.equal(writtenAfter(bad, '1'), false, `글 id ${JSON.stringify(bad)}`);
  }
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    for (const bad of ['0x1', '+1', '-1', ' 1', '1.5']) {
      const d = w.decision(`손상 ${bad}?`);
      setDecision(w.home, d.d.id, {threadId: w.post.id, messageId: bad, forum: true});
      const mine = fake.add(w.post.id, {content: '1'});
      const reply = fake.add(w.post.id, {content: '2', type: 19, message_reference: {message_id: bad}});
      await w.run();
      assert.equal(w.store.get(d.d.id).status, 'open', `요청 id ${bad}`);
      assert.ok(w.mails().some(m => m.sourceKey === `discord:${mine.id}`) && w.mails().some(m => m.sourceKey === `discord:${reply.id}`));
      w.store.cancel(d.d.id, {revision: 1, reason: '시험 정리'}, SUPER);
    }
    assert.equal(w.answers().length, 0);
    assert.equal(w.botPosts().filter(m => /기록됨|열린 결정|이미/.test(m.content)).length, 0);
  } finally { await fake.close(); }
});

test('19 R2 중간 형식 상태(forums 있고 forumRepos 없음)에서 등록을 해제했다 다시 넣어도 그 사이 쓴 답은 재생되지 않는다', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    const a = w.decision('A를 합칠까요?');
    const file = path.join(w.home, 'discord-chat-state.json');
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(Object.keys(st.forums).length === 1 && Object.keys(st.threads).length);
    delete st.forumRepos;                                             // 이전 버전이 쓴 모양: forums 해시와 cursor만 있다
    fs.writeFileSync(file, JSON.stringify(st) + '\n');
    w.disableForum();
    await w.run();                                                    // 키를 뺀 회차: 해제로 보고 기록·cursor를 지운다
    const mid = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(mid.forums), []);
    fake.add(w.post.id, {content: '2', type: 19, message_reference: {message_id: a.msg.id}});  // 제외 중에 쓴 답
    w.enableForum();
    await w.run();
    assert.equal(w.answers().length, 0);
    assert.equal(w.store.get(a.d.id).status, 'open');
    assert.equal(w.mails().length, 0);
    assert.equal(w.botPosts().filter(m => /기록|이미|열린 결정/.test(m.content)).length, 0);
    fake.add(w.post.id, {content: '2', type: 19, message_reference: {message_id: a.msg.id}});
    await w.run();
    assert.equal(w.store.get(a.d.id).answer.choice, '보류', '재등록 뒤 새 답은 받는다');
  } finally { await fake.close(); }
});

test('20 5라운드: 중간 형식(forums 있고 forumRepos 없음)은 읽을 때 포럼 기록을 버리고 기준선부터 다시 시작한다. #비서 cursor는 그대로, 한 줄 알림, 못 풀어도 재생 없음', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    const a = w.decision('A를 합칠까요?');
    const topic = fake.add(FAKE.channelId, {content: '#비서 주제', author: {id: FAKE.botId, bot: true}});
    const sec = fake.addThread(topic);
    await w.run();
    const file = path.join(w.home, 'discord-chat-state.json');
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(st.threads[sec.id] && st.threads[w.post.id]);
    delete st.forumRepos;
    fs.writeFileSync(file, JSON.stringify(st) + '\n');
    fake.add(w.post.id, {content: '2', type: 19, message_reference: {message_id: a.msg.id}});     // 대기 중인 옛 답
    fake.inject({match: new RegExp(`GET /channels/${w.forum.id}$`), status: 403, body: {code: 50001}, times: 1});
    w.rebuild();
    const errs = [];
    await runWatch(w.chat, {once: true, out: async l => ((await w.decide(l)) ? undefined : createMailOut({home: w.home})(l)), err: e => errs.push(e)});
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(errs.some(e => /forumRepos 없음.*기준선부터 다시 시작/.test(e)), errs.join('\n'));
    assert.deepEqual(after.forums, {}, '포럼 기록 버림');
    assert.equal(after.threads[w.post.id], undefined, '포럼 스레드 cursor 버림');
    assert.equal(after.threads[sec.id], st.threads[sec.id], '#비서 스레드 cursor 보존');
    assert.equal(after.main, st.main, '#비서 cursor 보존');
    assert.equal(w.answers().length, 0);
    assert.equal(w.mails().length, 0);
  } finally { await fake.close(); }
});

test('24 5라운드 F5 재현: 중간 형식 + 다른 포럼 웹훅 조회 실패 중에 등록이 빠졌다 돌아와도 옛 답은 기록 0·우편 0·응답 0', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    const other = fake.addForum('other-repo');
    fake.addForumPost(other);
    const base = fs.readFileSync(w.hookFile, 'utf8').split('\n').filter(l => l && !/^DISCORD_WEBHOOK_URL_(KADAN|OTHER_REPO)=/.test(l)).join('\n') + '\n';
    const setKeys = ({kadan, otherRepo}) => fs.writeFileSync(w.hookFile, base + (kadan ? `DISCORD_WEBHOOK_URL_KADAN=${w.forum.url}\n` : '') + (otherRepo ? `DISCORD_WEBHOOK_URL_OTHER_REPO=${other.url}\n` : ''), {mode: 0o600});
    const stateFile = path.join(w.home, 'discord-chat-state.json');
    setKeys({kadan: true, otherRepo: true}); w.rebuild(); await w.run();
    const a = w.decision('A를 합칠까요?'); await w.run();
    const mid = JSON.parse(fs.readFileSync(stateFile, 'utf8')); delete mid.forumRepos;
    fs.writeFileSync(stateFile, JSON.stringify(mid) + '\n');
    setKeys({kadan: false, otherRepo: true});
    fake.inject({match: new RegExp(`GET /webhooks/${other.hookId}/`), status: 403, body: {code: 50001}, times: 40});   // 다른 포럼의 웹훅 조회 실패
    w.rebuild(); await w.run();
    fake.add(w.post.id, {content: '2', type: 19, message_reference: {message_id: a.msg.id}});
    setKeys({kadan: true, otherRepo: true});
    w.rebuild(); await w.run();
    assert.equal(w.answers().length, 0);
    assert.equal(w.store.get(a.d.id).status, 'open');
    assert.equal(w.mails().length, 0);
    assert.equal(w.botPosts().filter(m => /기록|이미|열린 결정|늦게/.test(m.content)).length, 0);
  } finally { await fake.close(); }
});

test('25 5라운드: forumRepos가 깨졌어도(배열) 멈추지 않고 포럼 기록을 버리고 다시 시작한다. 운영 형식(forums 키 없음)은 지금처럼 기준선부터', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    const a = w.decision('A를 합칠까요?');
    await w.run();
    const file = path.join(w.home, 'discord-chat-state.json');
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({...st, forumRepos: []}) + '\n');
    fake.add(w.post.id, {content: '1', type: 19, message_reference: {message_id: a.msg.id}});
    w.rebuild(); await w.run();
    assert.equal(w.answers().length, 0);
    assert.equal(w.mails().length, 0);
    // 운영 형식: forums·forumRepos 키가 모두 없다
    const prod = JSON.parse(fs.readFileSync(file, 'utf8')); delete prod.forums; delete prod.forumRepos;
    fs.writeFileSync(file, JSON.stringify(prod) + '\n');
    fake.add(w.post.id, {content: '2', type: 19, message_reference: {message_id: a.msg.id}});     // 올라오기 전에 쓴 답
    const errs = [];
    w.rebuild();
    await runWatch(w.chat, {once: true, out: async l => ((await w.decide(l)) ? undefined : createMailOut({home: w.home})(l)), err: e => errs.push(e)});
    assert.equal(errs.filter(e => /다시 시작한다/.test(e)).length, 0, '운영 형식은 중간 형식 알림이 없다');
    assert.equal(w.answers().length, 0);
    assert.equal(w.mails().length, 0);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).main, prod.main);
    fake.add(w.post.id, {content: '2', type: 19, message_reference: {message_id: a.msg.id}});
    await w.run();
    assert.equal(w.store.get(a.d.id).answer.choice, '보류', '올라온 뒤 새 답은 받는다');
  } finally { await fake.close(); }
});

test('26 5라운드 F6: 늦은 안내는 한 번만 — 안내 직후 우편 저장 전에 죽어 다시 처리해도 안내 1개, 우편은 그때 1통', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    const N0 = Date.now();
    const d = w.decision('늦은 안내?');
    setDecision(w.home, d.d.id, {threadId: w.post.id, messageId: sf(N0 - 2 * 86400e3), forum: true});
    const line = {id: sf(N0 - 20 * 60e3), where: 'thread', threadId: w.post.id, channel: 'kadan', content: '1', replyTo: sf(N0 - 2 * 86400e3)};
    const first = createDecisionAnswerer({home: w.home, chat: w.chat, env: w.env, store: w.store, now: () => N0});
    assert.equal(await first(line), false);                           // 안내를 올렸고 우편은 아직(죽음)
    assert.equal(w.botPosts().length, 1);
    const second = createDecisionAnswerer({home: w.home, chat: w.chat, env: w.env, store: w.store, now: () => N0});
    assert.equal(await second(line), false, '재처리: 일반 글로 우편');
    assert.equal(w.botPosts().length, 1, '안내는 다시 올리지 않는다');
    createMailOut({home: w.home})(line);
    assert.equal(w.mails().length, 1);
    assert.equal(await second(line), true, '우편이 저장된 글은 더 하지 않는다');
    assert.equal(w.botPosts().length, 1);
    assert.equal(w.answers().length, 0);
  } finally { await fake.close(); }
});

const sf = ms => String((BigInt(ms) - 1420070400000n) << 22n);     // 시각(ms) → 디코 글 id

test('21 4라운드 바탕 규칙: 10분 넘게 늦게 받은 답은 기록하지 않고 조용히 다시 묻는다. 경계 9분59초/10분1초/미래 1시간 초과', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    const N0 = Date.now();
    const mk = (question, i) => {                                      // 요청 메시지는 이틀 전 id로 둔다(하루 전 답도 0번 규칙은 통과)
      const d = w.decision(question);
      setDecision(w.home, d.d.id, {threadId: w.post.id, messageId: sf(N0 - 2 * 86400e3 - i), forum: true});
      return {d: d.d, req: sf(N0 - 2 * 86400e3 - i)};
    };
    const answerer = createDecisionAnswerer({home: w.home, chat: w.chat, env: w.env, store: w.store, now: () => N0});
    const line = (at, req) => ({id: sf(at), where: 'thread', threadId: w.post.id, channel: 'kadan', content: '1', replyTo: req});
    const ok1 = mk('경계 9:59?', 1), ok2 = mk('미래 1초?', 2), ok3 = mk('미래 59분?', 3);
    assert.equal(await answerer(line(N0 - (LATE_ANSWER_MS - 1000), ok1.req)), true, '9분 59초는 인정');
    assert.equal(w.store.get(ok1.d.id).status, 'answered');
    assert.equal(await answerer(line(N0 + 1000, ok2.req)), true, '미래 1초(시계 차이)는 정상');
    assert.equal(await answerer(line(N0 + 59 * 60e3, ok3.req)), true, '미래 59분은 정상');
    for (const [name, at] of [['10분 1초', N0 - (LATE_ANSWER_MS + 1000)], ['미래 1시간 1초', N0 + 3601e3], ['하루 전', N0 - 86400e3]]) {
      const x = mk(`${name}?`, 10 + at % 7);
      const before = w.botPosts().length;
      assert.equal(await answerer(line(at, x.req)), false, `${name}: 일반 글로 우편`);
      assert.equal(w.store.get(x.d.id).status, 'open', `${name}: 기록 0`);
      const notes = w.botPosts().slice(before);
      assert.equal(notes.length, 1);
      assert.match(notes[0].content, /^늦게 받은 답이라 기록하지 않았습니다\. 다시 답해 주세요: 1\) 합침 2\) 보류$/);
      assert.equal(notes[0]._body.flags, 4096, '조용히');
      assert.deepEqual(notes[0]._body.allowed_mentions, {parse: []});
    }
  } finally { await fake.close(); }
});

test('22 늦게 받은 답은 실제 다리에서도 기록 0, 조용한 안내 1개, 비서 우편 1통이다(상태 경로와 무관한 상한)', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    const a = w.decision('A를 합칠까요?');
    const mine = fake.add(w.post.id, {content: '2', type: 19, message_reference: {message_id: a.msg.id}});
    const real = Date.now();
    const late = createDecisionAnswerer({home: w.home, chat: w.chat, env: w.env, store: w.store, now: () => real + 11 * 60e3});
    // world의 run은 처음 만든 처리기를 쓰므로 같은 방식으로 한 바퀴를 직접 돌린다
    const mailOut = createMailOut({home: w.home});
    await runWatch(w.chat, {once: true, out: async line => ((await late(line)) ? undefined : mailOut(line)), err: () => {}});
    assert.equal(w.answers().length, 0);
    assert.equal(w.store.get(a.d.id).status, 'open');
    assert.equal(w.botPosts().filter(m => /^늦게 받은 답이라/.test(m.content)).length, 1);
    assert.deepEqual(w.mails().map(m => m.sourceKey), [`discord:${mine.id}`]);
  } finally { await fake.close(); }
});

test('23 R2 복합 재현(5단계): 다른 포럼이 403인 동안 옛 형식 해제 정리가 미뤄져도 제외 중 답은 재생되지 않는다', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    const other = fake.addForum('other-repo');
    fake.addForumPost(other);
    const base = fs.readFileSync(w.hookFile, 'utf8').split('\n').filter(l => l && !/^DISCORD_WEBHOOK_URL_(KADAN|OTHER_REPO)=/.test(l)).join('\n') + '\n';
    const setKeys = ({kadan, otherRepo}) => fs.writeFileSync(w.hookFile, base + (kadan ? `DISCORD_WEBHOOK_URL_KADAN=${w.forum.url}\n` : '') + (otherRepo ? `DISCORD_WEBHOOK_URL_OTHER_REPO=${other.url}\n` : ''), {mode: 0o600});
    const stateFile = path.join(w.home, 'discord-chat-state.json');
    // 1. 두 포럼을 정상 등록하고 kadan 스레드에 열린 결정 요청을 둔다
    setKeys({kadan: true, otherRepo: true}); w.rebuild(); await w.run();
    const a = w.decision('A를 합칠까요?'); await w.run();
    // 2. forumRepos만 빼서 이전 버전 형식으로 만든다
    const legacy = JSON.parse(fs.readFileSync(stateFile, 'utf8')); delete legacy.forumRepos;
    fs.writeFileSync(stateFile, JSON.stringify(legacy) + '\n');
    // 3. kadan 키를 빼고 other-repo 채널 조회는 403으로 만든다
    setKeys({kadan: false, otherRepo: true});
    fake.inject({match: new RegExp(`GET /channels/${other.id}$`), status: 403, body: {code: 50001}, times: 20});
    w.rebuild(); await w.run();
    const removed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(Object.keys(removed.forums).length, 0, '중간 형식은 읽을 때 버린다(다른 포럼 403이어도 kadan 기록이 남지 않는다)');
    assert.equal(removed.threads[w.post.id], undefined, 'kadan 글 cursor 정리');
    // 4. 제외 중에 답을 단다
    fake.add(w.post.id, {content: '2', type: 19, message_reference: {message_id: a.msg.id}});
    // 5. other-repo가 아직 403인 채 kadan 키를 복원한다
    setKeys({kadan: true, otherRepo: true});
    w.rebuild(); await w.run();
    assert.equal(w.answers().length, 0);
    assert.equal(w.store.get(a.d.id).status, 'open');
    assert.equal(w.mails().length, 0);
    assert.equal(w.botPosts().filter(m => /기록|이미|열린 결정|늦게/.test(m.content)).length, 0);
  } finally { await fake.close(); }
});
