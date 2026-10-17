import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startFakeDiscord, FAKE} from './helpers/fake-discord-api.mjs';
import {createChat, loadChatConfig, runWatch} from '../src/discord-chat.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {CardStore} from '../src/card-store.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {setThread} from '../src/notify-threads.mjs';
import {resolveMailTarget} from '../src/discord-route.mjs';

// 가짜 역할·레포·비밀 값만 쓴다(운영 이름 금지). 실제 디코는 가짜 서버다.
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), `kadan-droute-owner-${prefix}-`));
const noSleep = async () => {};
const live = (...roles) => () => new Set(roles.map(r => `kadan-${r}`));
const suffix = name => name.toUpperCase().replace(/[^A-Z0-9]/g, '_');

function hierarchy(home, table, roles = {}) {
  const file = path.join(home, `hierarchy-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(table));
  appendLedger({kind: 'hierarchy-loaded', path: file}, home);
  for (const [role, roleProfile] of Object.entries(roles)) {
    appendLedger({kind: 'start', role, session: `kadan-${role}`, panePid: 1, roleProfile}, home);
  }
}
const later = ms => new Date(Date.now() + ms).toISOString();

// 가짜 비밀 파일 → loadChatConfig → 수신기(runWatch)가 붙이는 channel 값을 그대로 라우터에 넣는다.
function chatSetup(fake, forums, home) {
  const botFile = path.join(home, 'bot.env'), hookFile = path.join(home, 'hook.env');
  fs.writeFileSync(botFile, `DISCORD_BOT_TOKEN=${FAKE.token}\nDISCORD_APPLICATION_ID=${FAKE.appId}\n`, {mode: 0o600});
  fs.writeFileSync(hookFile, `DISCORD_USER_ID=${FAKE.userId}\nDISCORD_WEBHOOK_URL_SECRETARY=https://discord.com/api/webhooks/${FAKE.hookId}/${FAKE.hookToken}\n`
    + forums.map(f => `DISCORD_WEBHOOK_URL_${suffix(f.name)}=${f.url}\n`).join(''), {mode: 0o600});
  const env = {KADAN_SECRET_DISCORD_BOT_FILE: botFile, KADAN_SECRET_DISCORD_FILE: hookFile, KADAN_DISCORD_API_BASE: fake.base, KADAN_NOTIFY: 'off'};
  return {env, chat: createChat({home, env, sleep: noSleep})};
}
const watchLines = async chat => {
  const lines = [];
  await runWatch(chat, {once: true, out: l => lines.push(l), err: () => {}});
  return lines;
};

test('1 설정 키 SAMPLE_VIBE → 수신기 channel → 라우터: 밑줄 레포 포럼 글이 그 레포의 슈퍼감독에게 간다', async () => {
  const fake = await startFakeDiscord();
  try {
    const home = tmp('home');
    const forum = fake.addForum('sample_vibe');
    const post = fake.addForumPost(forum, {name: '[vibe] 알림'});
    const {chat} = chatSetup(fake, [forum], home);
    hierarchy(home, {'vibe-슈퍼감독': '@user', 'vibe-감독': 'vibe-슈퍼감독'}, {'vibe-슈퍼감독': 'super', 'vibe-감독': 'conductor'});
    const cards = new CardStore(home);
    cards.create({repo: 'sample_vibe', id: 'card-1', repoPath: home, body: '# 시험'});
    cards.update('sample_vibe/card-1', {role: 'vibe-감독'}, {revision: 1, note: '담당 지정'});
    await watchLines(chat);                                           // 기준선
    fake.add(post.id, {content: '답입니다'});
    const [line, ...rest] = await watchLines(chat);
    assert.equal(rest.length, 0);
    assert.equal(line.channel, 'sample-vibe', '수신기가 붙이는 값은 포럼 상태 키 그대로');
    const route = resolveMailTarget(line, {home, liveSessions: live('vibe-슈퍼감독')});
    assert.deepEqual([route.to, route.reason], ['vibe-슈퍼감독', null]);
  } finally { await fake.close(); }
});

test('2 포럼 상태 키 불변: loadChatConfig의 repoWebhooks[].repo는 소문자·하이픈 그대로', () => {
  const home = tmp('cfg');
  const botFile = path.join(home, 'bot.env'), hookFile = path.join(home, 'hook.env');
  fs.writeFileSync(botFile, `DISCORD_BOT_TOKEN=${FAKE.token}\n`, {mode: 0o600});
  fs.writeFileSync(hookFile, `DISCORD_USER_ID=${FAKE.userId}\nDISCORD_WEBHOOK_URL_SECRETARY=https://discord.com/api/webhooks/1/x\n`
    + 'DISCORD_WEBHOOK_URL_SAMPLE_VIBE=https://discord.com/api/webhooks/2/y\nDISCORD_WEBHOOK_URL_SAMPLE_SHORTS=https://discord.com/api/webhooks/3/z\n', {mode: 0o600});
  const cfg = loadChatConfig({KADAN_SECRET_DISCORD_BOT_FILE: botFile, KADAN_SECRET_DISCORD_FILE: hookFile}, home);
  assert.equal(JSON.stringify(cfg.repoWebhooks.map(w => w.repo)), '["sample-vibe","sample-shorts"]');
});

test('3 레포 이름이 같은 키로 겹치면(a_b·a-b) 비서로 간다(레포 이름 충돌 2개)', () => {
  const home = tmp('clash');
  hierarchy(home, {'ab-슈퍼감독': '@user', 'ab-감독': 'ab-슈퍼감독'}, {'ab-슈퍼감독': 'super'});
  const cards = new CardStore(home);
  for (const repo of ['a_b', 'a-b']) {
    cards.create({repo, id: 'c', repoPath: home, body: '# 시험'});
    cards.update(`${repo}/c`, {role: 'ab-감독'}, {revision: 1, note: '담당 지정'});
  }
  const r = resolveMailTarget({id: '1', where: 'thread', threadId: 'T', channel: 'a-b', content: 'x'}, {home, liveSessions: live('ab-슈퍼감독')});
  assert.deepEqual([r.to, r.reason], ['비서', '레포 이름 충돌 2개 → 비서']);
});

test('4 인계된 업무 owner·카드 담당은 후임의 슈퍼감독에게 간다', () => {
  const home = tmp('handover');
  hierarchy(home, {'zeta-슈퍼감독': '@user', 'zeta-감독-2': 'zeta-슈퍼감독', 'zeta-작업자-2': 'zeta-슈퍼감독'},
    {'zeta-슈퍼감독': 'super', 'zeta-감독-2': 'conductor'});
  new WorkStore(home).create({key: 'zeta_app/work-1', title: 't', goal: 'g', scope: 's', acceptance: 'a', owner: 'zeta-감독', repoPath: home});
  setThread(home, 'zeta_app/work-1', {threadId: 'T-WORK', statusMessageId: null});
  appendLedger({kind: 'handover', phase: 'transferred', from: 'zeta-감독', to: 'zeta-감독-2', t: later(5000)}, home);
  const opts = {home, liveSessions: live('zeta-슈퍼감독')};
  const line = (threadId, channel = 'zeta-app') => ({id: '1', where: 'thread', threadId, channel, content: 'x'});
  // 업무 글: 원장의 owner 원문(zeta-감독)은 관계표에 없다 → 인계를 따라가야 후임이 나온다
  assert.deepEqual([resolveMailTarget(line('T-WORK'), opts).to, resolveMailTarget(line('T-WORK'), opts).reason], ['zeta-슈퍼감독', null]);
  // 일반 글(업무 목록 쪽): 같은 업무의 owner 인계
  assert.equal(resolveMailTarget(line('T-OTHER'), opts).to, 'zeta-슈퍼감독');
  // 카드 담당 인계
  const home2 = tmp('handover-card');
  hierarchy(home2, {'zeta-슈퍼감독': '@user', 'zeta-작업자-2': 'zeta-슈퍼감독'}, {'zeta-슈퍼감독': 'super'});
  const cards = new CardStore(home2);
  cards.create({repo: 'zeta_app', id: 'card-1', repoPath: home2, body: '# 시험'});
  cards.update('zeta_app/card-1', {role: 'zeta-작업자'}, {revision: 1, note: '담당 지정'});
  appendLedger({kind: 'handover', phase: 'transferred', from: 'zeta-작업자', to: 'zeta-작업자-2', taskIds: ['zeta_app/card-1'], t: later(5000)}, home2);
  assert.equal(resolveMailTarget(line('T-OTHER'), {home: home2, liveSessions: live('zeta-슈퍼감독')}).to, 'zeta-슈퍼감독');
});
