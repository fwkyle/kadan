import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startFakeDiscord, FAKE} from './helpers/fake-discord-api.mjs';
import {createChat, runWatch} from '../src/discord-chat.mjs';

// 항목 2: 마지막 조회 뒤 달린 댓글이 있는데 업무 완료로 글이 보관되면(활성 목록에서 빠짐) 그 댓글도 한 번 회수한다. 가짜 값만 쓴다.
function chatOf(fake) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-dchat-arch-'));
  const botFile = path.join(dir, 'bot.env'), hookFile = path.join(dir, 'hook.env');
  fs.writeFileSync(botFile, `DISCORD_BOT_TOKEN=${FAKE.token}\nDISCORD_APPLICATION_ID=${FAKE.appId}\n`, {mode: 0o600});
  fs.writeFileSync(hookFile, `DISCORD_USER_ID=${FAKE.userId}\nDISCORD_SECRETARY_CHANNEL_ID=${FAKE.channelId}\n`, {mode: 0o600});
  const env = {KADAN_SECRET_DISCORD_BOT_FILE: botFile, KADAN_SECRET_DISCORD_FILE: hookFile, KADAN_DISCORD_API_BASE: fake.base, KADAN_NOTIFY: 'off'};
  return createChat({home: dir, env, sleep: async () => {}});
}
const poll = async (chat, errs = []) => {
  const lines = [];
  await runWatch(chat, {once: true, out: l => lines.push(l.content), err: e => errs.push(e)});
  return lines;
};

test('2 보관 직전 마지막 댓글을 회수하고, 그 뒤 조회는 보관된 글을 부르지 않는다', async () => {
  const fake = await startFakeDiscord();
  try {
    const root = fake.add(FAKE.channelId, {content: '주제'});
    const thread = fake.addThread(root);
    const chat = chatOf(fake);
    assert.deepEqual(await poll(chat), [], '조회 1: 기준선');
    const threadMessages = new RegExp(`GET /channels/${thread.id}/messages`);
    fake.add(thread.id, {content: '마지막 댓글'});
    fake.threads.get(thread.id).archived = true;               // 업무 완료로 자동 보관: 활성 목록에서 빠진다
    assert.deepEqual(await poll(chat), ['마지막 댓글'], '조회 2: 보관된 글의 마지막 댓글 회수');
    fake.requests.length = 0;
    assert.deepEqual(await poll(chat), []);
    assert.deepEqual(await poll(chat), []);
    assert.equal(fake.count(threadMessages), 0, '조회 3 이후 보관된 글에는 호출이 없다');
  } finally { await fake.close(); }
});

test('2b 보관된 글을 못 읽으면(403) 로그만 남기고 다시 시도하지 않는다', async () => {
  const fake = await startFakeDiscord();
  try {
    const root = fake.add(FAKE.channelId, {content: '주제'});
    const thread = fake.addThread(root);
    const chat = chatOf(fake);
    await poll(chat);
    fake.add(thread.id, {content: '못 읽는 댓글'});
    fake.threads.get(thread.id).archived = true;
    fake.inject({match: new RegExp(`GET /channels/${thread.id}/messages`), status: 403, body: {code: 50001}, times: 99});
    const errs = [];
    assert.deepEqual(await poll(chat, errs), []);
    assert.ok(errs.some(e => /보관/.test(e)), errs.join('|'));
    fake.requests.length = 0;
    assert.deepEqual(await poll(chat), []);
    assert.equal(fake.count(new RegExp(`GET /channels/${thread.id}/messages`)), 0);
  } finally { await fake.close(); }
});

test('2c 옛 상태 파일(active 필드 없음)이면 첫 조회에서는 회수하지 않는다', async () => {
  const fake = await startFakeDiscord();
  try {
    const root = fake.add(FAKE.channelId, {content: '주제'});
    const thread = fake.addThread(root);
    const chat = chatOf(fake);
    await poll(chat);
    const file = path.join(chat.home, 'discord-chat-state.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete state.active;
    fs.writeFileSync(file, JSON.stringify(state));
    fake.add(thread.id, {content: '댓글'});
    fake.threads.get(thread.id).archived = true;
    fake.requests.length = 0;
    assert.deepEqual(await poll(chat), []);
    assert.equal(fake.count(new RegExp(`GET /channels/${thread.id}/messages`)), 0);
  } finally { await fake.close(); }
});
