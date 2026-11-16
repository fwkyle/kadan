import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {startFakeDiscord, FAKE} from './helpers/fake-discord-api.mjs';
import {bundleHome} from './helpers/decision-bundle.mjs';
import {createChat} from '../src/discord-chat.mjs';
import {createDecisionAnswerer} from '../src/discord-decision.mjs';
import {setDecision} from '../src/notify-threads.mjs';
import {DecisionStore} from '../src/decisions.mjs';
import {CardStore} from '../src/card-store.mjs';

test('디코 후보: 단일 1 / 단일+묶음 / 단일 2 / 묶음만 / 묶음 명시 답장', async t => {
  const fake = await startFakeDiscord();
  const port = Number(new URL(fake.base).port);
  try {
    for (const mode of ['single', 'mixed', 'two', 'bundle', 'reply']) {
      const hasBundle = ['mixed', 'bundle', 'reply'].includes(mode);
      const {home, row} = bundleHome(hasBundle ? {} : {history: [], detail: []});
      const store = new DecisionStore(home, {notify: () => {}});
      new CardStore(home).create({repo: 'repo', id: 'a', repoPath: home, body: '# 시험'});
      const forum = fake.addForum('repo'), thread = fake.addForumPost(forum, {name: mode});
      const bot = path.join(home, 'bot.env');
      const hook = path.join(home, 'hook.env');
      fs.writeFileSync(bot, `DISCORD_BOT_TOKEN=${FAKE.token}\nDISCORD_APPLICATION_ID=${FAKE.appId}\n`, {mode: 0o600});
      fs.writeFileSync(hook, `DISCORD_USER_ID=${FAKE.userId}\n` +
        `DISCORD_WEBHOOK_URL_SECRETARY=https://discord.com/api/webhooks/${FAKE.hookId}/${FAKE.hookToken}\n` +
        `DISCORD_WEBHOOK_URL_REPO=${forum.url}\n`, {mode: 0o600});
      const env = {KADAN_SECRET_DISCORD_BOT_FILE: bot, KADAN_SECRET_DISCORD_FILE: hook,
        KADAN_DISCORD_API_BASE: fake.base, KADAN_NOTIFY: 'off'};
      const chat = createChat({home, env, sleep: async () => {}});
      const bind = d => {
        const msg = fake.add(thread.id, {content: d.question, author: {id: FAKE.botId, bot: true}});
        setDecision(home, d.id, {threadId: thread.id, messageId: msg.id, forum: true});
        return msg.id;
      };
      const bundleMessage = hasBundle ? bind(row) : null;
      const singles = [];
      const count = mode === 'two' ? 2 : ['single', 'mixed', 'reply'].includes(mode) ? 1 : 0;
      for (let i = 0; i < count; i++) {
        const single = store.request('repo/a', {question: `단일 질문 ${i}`, options: ['예', '아니오'],
          recommendation: '예', reason: '확인 경로 없음: 시험', work: '없음'}, 'test-슈퍼감독');
        singles.push(single); bind(single);
      }
      const before = fake.requests.length;
      const message = fake.add(thread.id, {content: '1', author: {id: FAKE.userId}});
      const handle = createDecisionAnswerer({home, chat, env, store});
      const result = await handle({where: 'thread', channel: 'repo', threadId: thread.id,
        id: message.id, content: '1', ...(mode === 'reply' ? {replyTo: bundleMessage} : {})});
      const posted = fake.requests.slice(before).filter(r => r.method === 'POST')
        .map(r => r.body?.content ?? '').join('\n');
      if (['single', 'mixed'].includes(mode)) {
        assert.equal(result, true, mode);
        assert.equal(store.get(singles[0].id).status, 'answered', mode);
        assert.match(posted, /기록됨: 예/, mode);
      } else if (mode === 'two') {
        assert.match(result.note, /열린 결정 2개/);
        assert.equal(store.list().filter(d => d.status === 'answered').length, 0);
      } else {
        assert.equal(result, true, mode);
        assert.match(posted, /대시보드.*#decision-/, mode);
        assert.doesNotMatch(posted, /기록됨/, mode);
        assert.equal(store.list().filter(d => d.status === 'answered').length, 0);
      }
      if (hasBundle) assert.equal(store.get(row.id).revision, 1, mode);
    }
  } finally {
    await fake.close();
    if (process.platform === 'darwin') {
      assert.equal(spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'],
        {encoding: 'utf8'}).stdout.trim(), '');
    }
    t.diagnostic(`fake Discord PID=${process.pid} port=${port} 127.0.0.1 stopped; lsof empty`);
  }
});
