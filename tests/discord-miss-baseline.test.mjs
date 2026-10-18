import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startFakeDiscord, FAKE} from './helpers/fake-discord-api.mjs';
import {DiscordError} from '../src/discord-bot.mjs';
import {createChat, runWatch} from '../src/discord-chat.mjs';

// 가짜 값만 쓴다. 항목 1: 연결 장애에서 복구될 때 기준선을 '지금'으로 다시 올리지 않는다.
const noSleep = async () => {};
function chatOf(fake) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-dchat-base-'));
  const botFile = path.join(dir, 'bot.env'), hookFile = path.join(dir, 'hook.env');
  fs.writeFileSync(botFile, `DISCORD_BOT_TOKEN=${FAKE.token}\nDISCORD_APPLICATION_ID=${FAKE.appId}\n`, {mode: 0o600});
  fs.writeFileSync(hookFile, `DISCORD_USER_ID=${FAKE.userId}\nDISCORD_SECRETARY_CHANNEL_ID=${FAKE.channelId}\n`, {mode: 0o600});
  const env = {KADAN_SECRET_DISCORD_BOT_FILE: botFile, KADAN_SECRET_DISCORD_FILE: hookFile, KADAN_DISCORD_API_BASE: fake.base, KADAN_NOTIFY: 'off'};
  return createChat({home: dir, env, sleep: noSleep});
}

test('1 기준선을 저장한 뒤 연결이 끊겼다 돌아와도, 끊긴 동안 올라온 질문을 낸다', async () => {
  const fake = await startFakeDiscord();
  try {
    const root = fake.add(FAKE.channelId, {content: '옛 글(기준선 이전)'});
    const thread = fake.addThread(root);
    fake.add(thread.id, {content: '옛 댓글(기준선 이전)'});
    const real = chatOf(fake);
    let failed = false, outageMsg = null;
    // 기준선 저장 뒤 첫 메시지 조회에서 연결 실패를 한 번 낸다. 장애 중에 kyle이 질문을 올린 것으로 한다.
    const chat = {...real, api: async (method, apiPath, ...rest) => {
      if (!failed && method === 'GET' && /\/messages\?/.test(apiPath)) {
        failed = true;
        outageMsg = fake.add(thread.id, {content: '장애 중에 쓴 질문'});
        throw new DiscordError('연결 거부', {kind: 'network', code: 'ECONNREFUSED'});
      }
      return real.api(method, apiPath, ...rest);
    }};
    const lines = [], controller = new AbortController();
    let waits = 0;
    // 질문을 못 받아도 끝나도록 대기 5번 뒤에는 멈춘다.
    const sleep = async () => { if (++waits >= 5) controller.abort(); };
    await runWatch(chat, {intervalS: 1, out: l => { lines.push(l); controller.abort(); }, err() {}, sleep, signal: controller.signal});
    assert.ok(failed, '연결 실패를 실제로 지났다');
    assert.deepEqual(lines.map(l => l.content), ['장애 중에 쓴 질문']);
    assert.equal(lines[0].id, outageMsg.id);
  } finally { await fake.close(); }
});
