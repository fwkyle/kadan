import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startFakeDiscord, FAKE} from './helpers/fake-discord-api.mjs';
import {createChat} from '../src/discord-chat.mjs';
import {createAutopilotWordHandler, parseAutopilotWord} from '../src/discord-autopilot.mjs';
import {readLedger, appendLedger} from '../src/ledger.mjs';
import {Mailbox} from '../src/mailbox.mjs';

// 가짜 값만 쓴다. 가짜 디스코드(루프백)·격리 홈·가짜 메일/알림. 실제 Autopilot·디코 호출 없음.
async function world(fake, extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-dautopilot-'));
  const botFile = path.join(home, 'bot.env'), hookFile = path.join(home, 'hook.env');
  fs.writeFileSync(botFile, `DISCORD_BOT_TOKEN=${FAKE.token}\nDISCORD_APPLICATION_ID=${FAKE.appId}\n`, {mode: 0o600});
  fs.writeFileSync(hookFile, `DISCORD_USER_ID=${FAKE.userId}\nDISCORD_WEBHOOK_URL_SECRETARY=https://discord.com/api/webhooks/${FAKE.hookId}/${FAKE.hookToken}\n`, {mode: 0o600});
  const env = {KADAN_SECRET_DISCORD_BOT_FILE: botFile, KADAN_SECRET_DISCORD_FILE: hookFile, KADAN_DISCORD_API_BASE: fake.base, KADAN_NOTIFY: 'off'};
  const chat = createChat({home, env, sleep: async () => {}});
  const sent = [], errs = [];
  // 슈퍼감독 1명(관계표 + 시작 기록 + 열린 업무)
  const table = {'a-슈퍼감독': '@user', 'a-감독': 'a-슈퍼감독'};
  const hfile = path.join(home, 'hierarchy.json');
  fs.writeFileSync(hfile, JSON.stringify(table));
  appendLedger({kind: 'hierarchy-loaded', path: hfile, hash: 'x', by: 'watch'}, home);
  appendLedger({kind: 'start', role: 'a-슈퍼감독', session: 'kadan-a-슈퍼감독', roleProfile: 'super'}, home);
  const works = [{key: 'a/w1', status: 'open', owner: 'a-감독', executions: []}];
  const deps = {readWorks: () => works, sendMail: (role, message) => { sent.push({role, message}); return {ok: true}; }, notify: () => null};
  const handler = createAutopilotWordHandler({home, chat, env, log: e => errs.push(e), deps, ...extra});
  // 디코에 실제로 쓴 글처럼 id를 받고, 다리가 만드는 줄 모양으로 넘긴다
  const say = (content, over = {}) => {
    const msg = fake.add(FAKE.channelId, {content});
    return {id: msg.id, channelId: FAKE.channelId, threadId: null, where: 'channel', at: null, content, quoted: false, ...over};
  };
  const autopilots = () => readLedger(home).filter(e => e.kind === 'autopilot');
  const posts = () => fake.messages.get(FAKE.channelId).filter(m => m._body);
  const secretaryMail = () => new Mailbox(home, '비서').list({all: true});
  return {home, handler, say, autopilots, posts, sent, errs, secretaryMail};
}

test('1 잘게 → on 사건 1줄(사람 명의·글 id·cruise·끝 시각 없음), 조용한 답 1통, 비서 우편 0통', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    const line = w.say('잘게');
    assert.equal(await w.handler(line), true);
    const [on] = w.autopilots();
    assert.deepEqual([on.phase, on.by, on.discordMessageId, on.level, on.viaChat], ['on', '사람', line.id, 'cruise', false]);
    assert.equal('until' in on, false, '끝 시각 기본값 없음');
    assert.match(on.text, /디코 한 마디로 켬: "잘게"/);
    assert.equal(w.posts().length, 1);
    assert.match(w.posts()[0].content, /^Autopilot 켬: Cruise · 끝 없음\(직접 끌 때까지\) · 슈퍼감독 1명에게 전달 · 끄려면 '일어남'$/);
    assert.equal(w.posts()[0]._body.flags, 4096, '조용히');
    assert.equal(w.secretaryMail().length, 0);
  } finally { await fake.close(); }
});

test('2 잘게 자동 HH:MM까지 · 잘게 6시간 · 잘게 자동 → 단계와 끝 시각을 맞게 넘긴다', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    const t = new Date(Date.now() + 3 * 3600_000), hhmm = `${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}`;
    await w.handler(w.say(`잘게 자동 ${hhmm}까지`));
    let [on] = w.autopilots();
    assert.equal(on.level, 'autopilot');
    assert.ok(Math.abs(Date.parse(on.until) - t.getTime()) < 60_001);
    await w.handler(w.say('일어남'));
    const w2 = await world(fake);
    const before = Date.now();
    await w2.handler(w2.say('잘게 6시간'));
    [on] = w2.autopilots();
    assert.equal(on.level, 'cruise');
    assert.ok(Math.abs(Date.parse(on.until) - (before + 6 * 3600_000)) < 60_000);
    const w3 = await world(fake);
    await w3.handler(w3.say('잘게 자동'));
    assert.equal(w3.autopilots()[0].level, 'autopilot');
  } finally { await fake.close(); }
});

test('3 일어남 → off, 꺼져 있을 때는 오류를 답하고 우편 0통', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    await w.handler(w.say('일어남'));
    assert.deepEqual(w.autopilots(), []);
    assert.match(w.posts().at(-1).content, /^끄지 못했습니다: 이미 꺼져 있습니다/);
    await w.handler(w.say('잘게'));
    await w.handler(w.say('일어남'));
    assert.deepEqual(w.autopilots().map(e => e.phase), ['on', 'off']);
    assert.match(w.posts().at(-1).content, /^Autopilot 끔 — 요약은 슈퍼감독 우편·알림으로 갑니다$/);
    assert.equal(w.secretaryMail().length, 0);
  } finally { await fake.close(); }
});

test('4 잘게 바이패스 … → 켜지지 않고 거절을 답한다', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    assert.equal(await w.handler(w.say('잘게 바이패스 07:00까지')), true);
    assert.deepEqual(w.autopilots(), []);
    assert.match(w.posts().at(-1).content, /완전자율은 아직 없습니다/);
  } finally { await fake.close(); }
});

test('5 잘게요·잘게 자동으로·공백 두 칸·범위 밖 시각은 일반 글(시각이 틀리면 이유 답) — 공백 여럿은 받지 않는다', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    for (const text of ['잘게요', '잘게 자동으로', '잘게  자동', ' 잘게 자동 ', '1번', '일어남!']) {
      const line = w.say(text);
      const r = await w.handler(line);
      if (text === ' 잘게 자동 ') assert.equal(r, true, '앞뒤 공백만 지운 글 전체가 맞으면 받는다');
      else assert.equal(r, false, text);
    }
    assert.equal(w.autopilots().length, 1, '앞뒤 공백 글 하나만 켜졌다');
    assert.equal(parseAutopilotWord('잘게  자동'), null);
    const w2 = await world(fake);
    assert.equal(await w2.handler(w2.say('잘게 99:99까지')), true, '문구 모양은 맞고 시각이 틀리면 켜지 않고 이유를 답한다');
    assert.match(w2.posts().at(-1).content, /HH:MM 꼴/);
    assert.equal(await w2.handler(w2.say('잘게 0시간')), true);
    assert.deepEqual(w2.autopilots(), []);
    assert.match(w2.posts().at(-1).content, /뒤여야 합니다|꼴/);
    const w3 = await world(fake);
    assert.equal(await w3.handler(w3.say('잘게 13시간')), true, '12시간 상한은 없다');
    assert.equal(w3.autopilots().length, 1);
  } finally { await fake.close(); }
});

test('6 늦은 글(11분 전)·미래 id는 켜지지 않고 조용한 안내 1통, 우편 0통(처리 표시)', async () => {
  const fake = await startFakeDiscord();
  try {
    const late = await world(fake, {now: () => Date.now() + 11 * 60_000});
    const l = late.say('잘게');
    assert.equal(await late.handler(l), true);
    assert.equal(await late.handler(l), true, '다시 받아도 안내는 한 번');
    assert.deepEqual(late.autopilots(), []);
    assert.equal(late.posts().length, 1);
    assert.match(late.posts()[0].content, /늦게 받은 글이라 켜지 않았습니다/);
    assert.equal(late.secretaryMail().length, 0);
    const future = await world(fake, {now: () => Date.now() - 2 * 3600_000});
    assert.equal(await future.handler(future.say('잘게')), true);
    assert.deepEqual(future.autopilots(), []);
  } finally { await fake.close(); }
});

test('7 같은 글 id를 두 번 받아도 on은 1번(처리 표시와 원장 글 id 둘 다 막는다)', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    const line = w.say('잘게');
    await w.handler(line);
    await w.handler(line);
    assert.equal(w.autopilots().length, 1);
    assert.equal(w.posts().length, 1);
    // 처리 표시 파일이 없어도(켠 뒤 표시 전에 죽은 경우) 원장의 글 id가 막는다
    fs.rmSync(path.join(w.home, 'discord-decision-handled.json'), {force: true});
    assert.equal(await w.handler(line), true);
    assert.equal(w.autopilots().length, 1);
    assert.equal(w.posts().length, 1);
  } finally { await fake.close(); }
});

test('8 레포 포럼 스레드 글·스레드 안 글·답장 글의 잘게는 처리하지 않는다', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    assert.equal(await w.handler(w.say('잘게', {where: 'thread', threadId: '440000000000000555', channel: 'kadan'})), false);
    assert.equal(await w.handler(w.say('잘게', {where: 'thread', threadId: '440000000000000555'})), false);
    assert.equal(await w.handler(w.say('잘게', {quoted: true, replyTo: '1'})), false);
    assert.deepEqual(w.autopilots(), []);
    assert.equal(w.posts().length, 0);
  } finally { await fake.close(); }
});

test('9 이미 켜져 있을 때 잘게는 덮어쓰지 않고 오류를 답한다', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    await w.handler(w.say('잘게'));
    await w.handler(w.say('잘게 자동'));
    assert.equal(w.autopilots().length, 1);
    assert.equal(w.autopilots()[0].level, 'cruise');
    assert.match(w.posts().at(-1).content, /^켜지 않았습니다: 이미 켜져 있습니다/);
    assert.ok(w.posts().at(-1).content.length <= 320);
  } finally { await fake.close(); }
});

test('10 답 글 올리기가 실패해도 on 사건은 남는다', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake);
    fake.inject({match: /POST \/channels\/.*\/messages/, status: 403, body: {code: 50001}, times: 20});
    assert.equal(await w.handler(w.say('잘게')), true);
    assert.equal(w.autopilots().length, 1);
    assert.ok(w.errs.some(e => /응답 글을 못 올렸다/.test(e)));
  } finally { await fake.close(); }
});

test('11 일어남: 요약 알림이 실패해도 끝 사건이 남아 꺼지고, 답 글에 실패가 드러난다', async () => {
  const fake = await startFakeDiscord();
  try {
    const w = await world(fake, {deps: {readWorks: () => [{key: 'a/w1', status: 'open', owner: 'a-감독', executions: []}],
      sendMail: () => ({ok: true}), notify: () => { throw new Error('알림 실패 주입'); }}});
    await w.handler(w.say('잘게'));
    assert.equal(w.autopilots().length, 1);
    await w.handler(w.say('일어남'));
    assert.deepEqual(w.autopilots().map(e => e.phase), ['on', 'off'], '끝 사건이 원장에 남았다');
    assert.match(w.posts().at(-1).content, /^Autopilot 끔\(끝 기록 완료\) — 단, 요약 알림을 보내지 못했습니다/);
  } finally { await fake.close(); }
});
