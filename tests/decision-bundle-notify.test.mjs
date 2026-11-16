import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {stopChild} from './helpers/child-cleanup.mjs';
import {bundleHome, partialRow, fullRow, submission} from './helpers/decision-bundle.mjs';
import {DecisionStore} from '../src/decisions.mjs';
import {appendStream, transaction} from '../src/storage.mjs';
import {notifyUser} from '../src/user-notify.mjs';
import {readDecisions} from '../src/notify-threads.mjs';

test('가짜 디코 요청 글: 일부 답은 답 수만 고치고 모든 답 뒤에만 해결 표시', async t => {
  const {home, row} = bundleHome();
  const log = path.join(home, 'webhook-requests.jsonl');
  const child = spawn(process.execPath, [new URL('./helpers/fake-webhook.mjs', import.meta.url).pathname,
    log, '[{"status":204}]', '{"forum":true,"known":[]}'], {stdio: ['ignore', 'pipe', 'inherit']});
  const port = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', chunk => resolve(Number(String(chunk).match(/PORT (\d+)/)[1])));
  });
  const old = process.env.KADAN_NOTIFY;
  try {
    const envFile = path.join(home, 'fake.env');
    const hook = `http://127.0.0.1:${port}/api/webhooks/333/FAKETOKEN-abc123`;
    fs.writeFileSync(envFile, `DISCORD_WEBHOOK_URL=${hook}\nDISCORD_WEBHOOK_URL_REPO=${hook}\n` +
      'DISCORD_USER_ID=424242424242\n', {mode: 0o600});
    const env = {KADAN_NOTIFY: '', KADAN_NOTIFY_ENV_FILE: envFile};
    let osCalls = 0;
    const store = new DecisionStore(home, {userNotify: (message, opts) => notifyUser(message,
      () => {osCalls++; return {status: 0};}, {...opts, home, env})});
    delete process.env.KADAN_NOTIFY;
    assert.equal(store.announce('request', row).discord.outcome, 'sent');
    assert.notEqual(readDecisions(home)[row.id].resolved, true);
    const partial = partialRow(row);
    transaction(home, () => {
      appendStream(home, 'decisions/events.jsonl', partial);
      appendStream(home, `decisions/${row.id}/detail.jsonl`, submission());
    });
    assert.equal(store.announce('answer', partial).discord.outcome, 'sent');
    assert.notEqual(readDecisions(home)[row.id].resolved, true);
    const requests = () => fs.readFileSync(log, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line)).map(row => ({...row, body: JSON.parse(row.body)}));
    const patch = requests().filter(row => row.method === 'PATCH').at(-1);
    assert.match(patch.body.content, /항목 2개 · 답 1개/);
    assert.doesNotMatch(patch.body.content, /해결됨|선택지:|추천:|카드 null/);
    const full = fullRow(row);
    transaction(home, () => {
      appendStream(home, 'decisions/events.jsonl', full);
      appendStream(home, `decisions/${row.id}/detail.jsonl`, submission(3, {A2: {choice: null, note: '자료 필요'}}));
    });
    assert.equal(store.announce('answer', full).discord.outcome, 'sent');
    assert.equal(readDecisions(home)[row.id].resolved, true);
    assert.match(requests().filter(row => row.method === 'PATCH').at(-1).body.content, /해결됨/);
    assert.equal(osCalls, 0);
  } finally {
    if (old === undefined) delete process.env.KADAN_NOTIFY;
    else process.env.KADAN_NOTIFY = old;
    await stopChild(child);
    if (process.platform === 'darwin') assert.equal(spawnSync('lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {encoding: 'utf8'}).stdout.trim(), '');
    t.diagnostic(`fake webhook PID=${child.pid} port=${port} 127.0.0.1 stopped; lsof empty`);
  }
});
