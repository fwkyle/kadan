import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {looksLikeTestProcess, postDiscordWebhook, TEST_REFUSED} from '../src/user-notify.mjs';

// 2026-11-23 사고: 시험 파일을 `node tests/<파일>`로 날것 실행하면 운영 홈·실제 웹훅을 물려받아 경보가 실제 디스코드로 나갔다.
// 관문: 시험으로 보이면 웹훅은 루프백 주소로만 나간다. 이 파일은 사고와 같은 꼴(주 스크립트가 tests/*.test.mjs, `node <파일>`,
// KADAN_NOTIFY·KADAN_TEST_RUN·NODE_TEST_CONTEXT 없음)을 시험 안의 자식 프로세스로만 재현한다. 가짜 값만 쓴다.
const SRC = new URL('../src/user-notify.mjs', import.meta.url).href;
const TOKEN = 'FAKETOKEN-guard-123';
let seq = 0;

// 고정 파일을 레포 tests/ 아래에 두면 실행기가 시험으로 주워 가므로, 임시 폴더의 tests/ 아래에 쓴다.
function scene(webhook) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-webhook-guard-'));
  fs.mkdirSync(path.join(dir, 'tests')); fs.mkdirSync(path.join(dir, 'home'));
  const envFile = path.join(dir, 'secret.env');
  fs.writeFileSync(envFile, `DISCORD_WEBHOOK_URL=${webhook}/api/webhooks/111/${TOKEN}\nDISCORD_USER_ID="424242424242"\n`, {mode: 0o600});
  const script = path.join(dir, 'tests', 'leak-shape.test.mjs');
  fs.writeFileSync(script, `import {notifyUser} from ${JSON.stringify(SRC)};
const r = notifyUser('시험 경보', () => ({status: 0}), {home: process.env.KADAN_HOME, kind: 'alert', key: ${JSON.stringify(`guard-${process.pid}-${++seq}`)}});
console.log(JSON.stringify({via: r.via, outcome: r.discord?.outcome, attempts: r.discord?.attempts}));
`);
  // 자식 env는 처음부터 짠다: 임시 홈, 설정 파일 위치만. KADAN_NOTIFY·KADAN_TEST_RUN·NODE_TEST_CONTEXT는 넣지 않는다.
  const env = {PATH: process.env.PATH, HOME: dir, TMPDIR: dir, KADAN_HOME: path.join(dir, 'home'), KADAN_NOTIFY_ENV_FILE: envFile};
  return {dir, script, env};
}

const runChild = ({script, env}) => new Promise(resolve => {
  const child = spawn(process.execPath, [script], {env, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  child.on('close', status => resolve({status, stdout, stderr}));
});

const lastJson = text => JSON.parse(text.trim().split('\n').at(-1));
const cleanup = dir => fs.rmSync(dir, {recursive: true, force: true}); // 이 시험이 만든 임시 폴더(다시 만들 수 있는 캐시)

test('사고 꼴 자식: 비루프백 웹훅은 보내지 않고 흔적 한 줄만 남긴다', async () => {
  const s = scene('https://kadan-guard.invalid'); // .invalid는 해석되지 않는다 — 가드가 없어도 실제 서버로 가지 않는다
  try {
    const out = await runChild(s);
    assert.equal(out.status, 0, out.stderr);
    const r = lastJson(out.stdout);
    assert.equal(r.outcome, TEST_REFUSED);
    assert.equal(r.attempts, 0);
    const lines = out.stderr.split('\n').filter(l => l.includes('시험 중이라 루프백이 아닌 웹훅'));
    assert.equal(lines.length, 1, out.stderr);
    assert.match(lines[0], /kadan-guard\.invalid/);
    assert.equal(out.stderr.includes(TOKEN), false, '주소·토큰이 흔적에 남으면 안 된다');
    assert.equal(out.stderr.includes('/api/webhooks'), false);
  } finally { cleanup(s.dir); }
});

test('사고와 같은 꼴 자식: 루프백 가짜 서버로는 그대로 1건 도착한다', async () => {
  const hits = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { hits.push(`${req.method} ${req.url}`); res.writeHead(204); res.end(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const s = scene(`http://127.0.0.1:${server.address().port}`);
  try {
    const out = await runChild(s);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(lastJson(out.stdout).outcome, 'sent');
    assert.equal(hits.length, 1, `도착 ${hits.length}건`);
    assert.match(hits[0], /^POST \/api\/webhooks\/111\//);
    assert.equal(out.stderr.includes('시험 중이라'), false);
  } finally { server.close(); cleanup(s.dir); }
});

test('postDiscordWebhook: 표시가 있으면 비루프백은 거절, 루프백 이름들은 거절하지 않는다', () => {
  const saved = process.env.KADAN_TEST_RUN;
  const errors = [];
  const write = process.stderr.write;
  process.stderr.write = chunk => { errors.push(String(chunk)); return true; };
  try {
    process.env.KADAN_TEST_RUN = '1';
    for (const host of ['discord.invalid', 'example.invalid', '127.0.0.1.example.invalid', 'localhost.example.invalid', 'a.b.invalid']) {
      const r = postDiscordWebhook({webhook: `https://${host}/api/webhooks/1/x`, content: 'x', budgetMs: 1000});
      assert.equal(r.outcome, TEST_REFUSED, host);
    }
    assert.equal(postDiscordWebhook({webhook: 'not a url', content: 'x', budgetMs: 1000}).outcome, TEST_REFUSED);
    // opts.env 쪽 표시로도 막는다(시험 실행기 아래에서는 NODE_TEST_CONTEXT 때문에 process.env 표시도 다시 켜진다).
    delete process.env.KADAN_TEST_RUN;
    assert.equal(postDiscordWebhook({webhook: 'https://discord.invalid/api/webhooks/1/x', content: 'x', budgetMs: 1000, env: {KADAN_TEST_RUN: '1'}}).outcome, TEST_REFUSED);
  } finally {
    process.stderr.write = write;
    if (saved === undefined) delete process.env.KADAN_TEST_RUN; else process.env.KADAN_TEST_RUN = saved;
  }
  assert.equal(errors.length, 7);
});

test('시험으로 보는 조건: NODE_TEST_CONTEXT 또는 주 스크립트가 tests/*.test.mjs일 때만(운영 argv[1]은 해당 없음)', () => {
  assert.equal(looksLikeTestProcess({NODE_TEST_CONTEXT: 'child-v8'}, '/x/src/cli.mjs'), true);
  assert.equal(looksLikeTestProcess({}, '/home/u/Dev/kadan/tests/chat-decision-watch.test.mjs'), true);
  assert.equal(looksLikeTestProcess({}, 'C:\\repo\\tests\\a.test.mjs'), true);
  // 운영: launchd(dev.kadan.up)는 .../kadan/src/cli.mjs, 터미널의 kadan은 .nvm/.../bin/kadan 링크, 대시보드·감시기도 src 아래.
  for (const main of ['/home/u/Dev/kadan/src/cli.mjs', '/home/u/.nvm/versions/node/v24/bin/kadan', '/x/src/dashboard.mjs',
    '/x/tests/run.mjs', '/x/tests/helpers/notify-child.mjs', '/x/tests-app/src/a.test.mjs', null]) {
    assert.equal(looksLikeTestProcess({}, main), false, String(main));
  }
});
