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
import {createDecisionAnswerer, matchChoice, writtenAfter, HANDLED_FILE} from '../src/discord-decision.mjs';
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
async function world(fake, {register = true} = {}) {
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
  const mailOut = createMailOut({home});
  const emit = async line => ((await decide(line)) ? undefined : mailOut(line));
  const w = {home, fake, forum, post, chat, store, calls, errs, decide, env,
    run: () => runWatch(chat, {once: true, out: emit, err: e => errs.push(e)}),
    // 나중에 포럼 키를 비밀 파일에 더하고 새 프로세스처럼 다시 만든다(옛 모양 상태 파일 위에 새 채널 등록)
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

test('6 (가) 답장+맞지 않는 글, 열린 결정 둘 이상+답장 없음 → 기록 0건, 되묻기 울림 글 1개. 맞지 않는 글은 일반 글', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    const a = w.decision('A를 합칠까요?', ['합침', '보류']);
    fake.add(w.post.id, {content: '1번', type: 19, message_reference: {message_id: a.msg.id}});
    fake.add(w.post.id, {content: '합침 — 이유는 이렇다', type: 19, message_reference: {message_id: a.msg.id}});
    fake.add(w.post.id, {content: '3', type: 19, message_reference: {message_id: a.msg.id}});
    await w.run();
    assert.equal(w.answers().length, 0);
    const asks = w.botPosts().filter(m => /기록하지 않았습니다/.test(m.content));
    assert.equal(asks.length, 3, '글마다 되묻기 하나');
    assert.match(asks[0].content, /^<@\d+> 기록하지 않았습니다\. 선택지 번호나 문구 그대로 답해 주세요: 1\) 합침 2\) 보류$/);
    assert.deepEqual(asks[0]._body.allowed_mentions, {users: [FAKE.userId]}, '울림');
    assert.equal(asks[0]._body.flags, undefined);
    assert.equal(w.mails().length, 0);

    // 둘 이상 열림: 답장 없이 선택지처럼 보이는 글 → 열린 결정 목록으로 되묻기
    const b = w.decision('B를 켤까요?', ['켠다', '끈다']);
    fake.add(w.post.id, {content: '2'});
    await w.run();
    assert.equal(w.answers().length, 0);
    const many = w.botPosts().filter(m => /열린 결정이 여러 개/.test(m.content));
    assert.equal(many.length, 1);
    assert.match(many[0].content, /1\) A를 합칠까요\?\n2\) B를 켤까요\?/);
    assert.deepEqual(many[0]._body.allowed_mentions, {users: [FAKE.userId]});
    // 선택지처럼 보이지 않는 일반 글은 비서 우편으로
    fake.add(w.post.id, {content: '지금 어디까지 됐어?'});
    await w.run();
    assert.equal(w.mails().length, 1);
    assert.equal(w.answers().length, 0);
    // 열린 결정이 하나일 때 (나) 맞지 않는 글도 일반 글
    w.store.cancel(b.d.id, {revision: w.store.get(b.d.id).revision, reason: '시험'}, SUPER);
    fake.add(w.post.id, {content: '1번이 좋아 보이네'});
    await w.run();
    assert.equal(w.mails().length, 2);
    assert.equal(w.answers().length, 0);
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

test('19 R2 이전 버전 상태(forumRepos 없음)에서 등록을 해제했다 다시 넣어도 그 사이 쓴 답은 재생되지 않는다', async () => {
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

test('20 R2 이름표 없는 옛 등록이라도 설정에는 있으나 이번에 못 푼 채널(403)은 해제로 보지 않는다. #비서 cursor는 그대로', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    const file = path.join(w.home, 'discord-chat-state.json');
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete st.forumRepos;
    fs.writeFileSync(file, JSON.stringify(st) + '\n');
    fake.inject({match: new RegExp(`GET /channels/${w.forum.id}$`), status: 403, body: {code: 50001}, times: 1});
    w.enableForum();                                                  // 새 프로세스: 못 푼 채널
    await w.run();
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(after.forums, st.forums, '못 푼 것은 해제가 아니다');
    assert.deepEqual(after.threads, st.threads, '포럼 cursor 보존');
    assert.equal(after.main, st.main, '#비서 cursor 보존');
  } finally { await fake.close(); }
});
