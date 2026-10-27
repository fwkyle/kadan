import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runNudge, formatNudgeResult } from '../src/claude-nudge.mjs';
import { claudeLimitMenu } from '../src/claude-limit-menu.mjs';
import { buildPreview, formatPreview } from '../src/claude-refresh.mjs';
import { sendTmuxKey } from '../src/floor-tmux.mjs';
import { guardedSend } from '../src/cli-guarded-send.mjs';
import { appendLedger, readLedger } from '../src/ledger.mjs';

// 문구는 2.1.311 실행 파일 2081826줄에서 추출. 레이아웃은 합성, 실세션 QA가 아니다.
const LIMIT = "You've hit your weekly limit · resets Oct 28 at 11pm (Asia/Seoul)";
const INPUT = `${LIMIT}\n\n❯ `;
const IDLE = '❯ ';
const MENU = `${LIMIT}\n\nWhat do you want to do?\n` +
  '❯ 1. Stop and wait for limit to reset\n' +
  '  2. Wait here, then continue automatically at Oct 28, 11pm\n\nEsc to cancel';
const FIXTURES = JSON.parse(fs.readFileSync(new URL('./fixtures/claude-limit-screens.json', import.meta.url)));

function world(screen = MENU, { afterEscape = INPUT, afterSend = IDLE } = {}) {
  const entries = [{ kind: 'start', session: 'kadan-nudge-test', role: 'nudge-test', panePid: '101',
    cmd: 'claude --model claude-haiku-5-5', roleProfile: 'worker' }];
  const keys = [], sends = [], records = [], sleeps = [];
  let current = screen;
  const floor = { name: 'tmux', list: () => [{ session: 'kadan-nudge-test', alive: true }],
    alive: () => true, pid: () => '101', read: () => current,
    send: (session, message) => { sends.push({ session, message }); current = afterSend;
      return { keyDelivery: 'sent', inputAcceptance: 'unconfirmed' }; } };
  const args = { entriesOf: () => entries, floor, self: 'test-sender', pendingCards: () => [],
    intervalSec: 2, sleep: ms => sleeps.push(ms),
    pressKey: (session, key, options) => { options.beforeKey(); keys.push(key); current = afterEscape; },
    send: ({ escaped, ...options }) => guardedSend({ ...options, raw: true,
      readEntries: () => entries, saveBody: () => {},
      record: entry => records.push({ ...entry, nudge: true, ...(escaped ? { escaped: true } : {}) }) }) };
  return { args, entries, floor, keys, sends, records, sleeps, set: value => { current = value; } };
}

test('실제 메뉴 문구의 합성 화면: Escape 1회, 기존 send 1회, stop/start 없이 깨움', () => {
  const w = world();
  const results = runNudge(w.args);
  assert.equal(results[0].outcome, 'nudged');
  assert.deepEqual(w.keys, ['Escape']);
  assert.equal(w.sends.length, 1);
  assert.deepEqual(w.sleeps, [2000]);
  assert.deepEqual(w.records.map(r => r.kind), ['send']);
  assert.equal(w.records[0].nudge, true);
  assert.equal(w.records[0].escaped, true);
  assert.match(formatNudgeResult(results), /깨움/);
});

test('메뉴 없이 한도·빈 입력창이면 Escape 없이 우편, 남은 한도는 그대로 한도', () => {
  const w = world(INPUT, { afterSend: INPUT });
  assert.equal(runNudge(w.args)[0].outcome, 'limited');
  assert.equal(w.keys.length, 0);
  assert.equal(w.sends.length, 1);
  assert.equal(w.records[0].escaped, undefined);
});

test('Escape 뒤 메뉴가 남으면 우편 없음', () => {
  const w = world(MENU, { afterEscape: MENU });
  assert.equal(runNudge(w.args)[0].outcome, 'limited');
  assert.equal(w.keys.length, 1);
  assert.equal(w.sends.length, 0);
});

test('생성 중·입력 글·쉬는 화면·모호한 메뉴·메뉴 뒤 응답은 키/우편 없음', () => {
  for (const screen of [FIXTURES['neg-working'], `${INPUT}typed`, IDLE,
    MENU.replace('Stop and wait', 'Stop & wait'), `${MENU}\n❯ typed`, `${MENU}\n⏺ response`,
    `${MENU}\n❯`, `\`\`\`\n${MENU}`]) {
    const w = world(screen);
    assert.equal(runNudge(w.args)[0].outcome, 'skipped', screen);
    assert.equal(w.keys.length + w.sends.length, 0, screen);
  }
});

test('자기 자신·비서·기반·다른 실행기는 제외', () => {
  for (const change of [w => { w.args.self = 'nudge-test'; },
    w => { w.entries[0].roleProfile = 'secretary'; }, w => { w.entries.length = 0; },
    w => { w.entries[0].cmd = 'codex --model gpt-6'; }]) {
    const w = world(); change(w);
    assert.equal(runNudge(w.args)[0].outcome, 'skipped');
    assert.equal(w.keys.length + w.sends.length, 0);
  }
});

test('재읽기에서 화면 또는 PID 변경·PID 누락·세션 없음이면 키/우편 없음', () => {
  for (const mode of ['screen', 'pid', 'missing-pid', 'dead']) {
    const w = world(); let reads = 0;
    w.floor.read = () => ++reads === 1 || mode !== 'screen' ? MENU : IDLE;
    if (mode === 'pid') w.floor.pid = () => reads ? '999' : '101';
    if (mode === 'missing-pid') delete w.entries[0].panePid;
    if (mode === 'dead') w.floor.alive = () => false;
    assert.equal(runNudge(w.args)[0].outcome, 'skipped', mode);
    assert.equal(w.keys.length + w.sends.length, 0, mode);
  }
});

test('Escape 직전·우편 직전의 화면 변경도 차단', () => {
  const key = world();
  const press = key.args.pressKey;
  key.args.pressKey = (...args) => { key.set(IDLE); return press(...args); };
  runNudge(key.args);
  assert.equal(key.keys.length + key.sends.length, 0);
  const mail = world(INPUT);
  const send = mail.args.send;
  mail.args.send = args => { mail.set('❯ user text'); return send(args); };
  runNudge(mail.args);
  assert.equal(mail.sends.length, 0);
});

test('전송 실패는 가린 이유와 실패로 남고 재시도 없음', () => {
  const w = world(INPUT); let attempts = 0;
  w.args.send = () => { attempts++; throw Object.assign(new Error('Bearer abcdefghijklmnop'),
    { delivery: 'unknown' }); };
  const result = runNudge(w.args)[0];
  assert.equal(result.outcome, 'failed');
  assert.equal(attempts, 1);
  assert.ok(!result.reason.includes('abcdefghijklmnop'));
});

test('역할 필터·tmux 한정·미리보기의 리셋 시각', () => {
  const w = world();
  assert.equal(runNudge({ ...w.args, roles: ['absent'] })[0].outcome, 'skipped');
  assert.equal(w.keys.length + w.sends.length, 0);
  assert.throws(() => runNudge({ ...w.args, floor: { name: 'herdr' } }), /tmux/);
  const rows = buildPreview({ entries: w.entries, floor: w.floor, pendingCards: () => [] });
  assert.equal(rows[0].resetLine, LIMIT);
  assert.match(formatPreview(rows, null), /초기화 줄:.*Oct 28/);
  assert.equal(claudeLimitMenu(MENU)?.title, 2);
  assert.ok(claudeLimitMenu(MENU.replace('Esc to cancel', 'Enter to confirm · Esc to cancel')));
});

test('tmux 키 도우미: 정확 주소·Escape만, 사람/복사모드/세대 확인 뒤 한 번', () => {
  for (const mode of ['ok', 'pid', 'dead', 'copy', 'human', 'missing']) {
    const calls = [];
    const run = args => {
      calls.push(args);
      if (args[0] === 'has-session' && mode === 'missing') throw new Error('missing');
      if (args.at(-1) === '#{pane_in_mode}') return mode === 'copy' ? '1' : '0';
      if (args[0] === 'list-clients') return mode === 'human' ? `1 ${Math.floor(Date.now() / 1000)}` : '';
      if (args.at(-1) === '#{pane_pid}|#{pane_dead}') return mode === 'pid' ? '999|0' :
        mode === 'dead' ? '101|1' : '101|0';
      return '';
    };
    const action = () => sendTmuxKey('kadan-nudge-test', 'Escape', { expectedPid: '101', run });
    if (mode === 'ok') action(); else assert.throws(action, undefined, mode);
    assert.equal(calls.filter(c => c[0] === 'send-keys').length, mode === 'ok' ? 1 : 0);
    if (mode === 'ok') assert.deepEqual(calls.at(-1), ['send-keys', '-t', '=kadan-nudge-test:', 'Escape']);
  }
  for (const [session, key] of [['kadan-x', 'Enter'], ['personal', 'Escape'], ['kadan-x:1', 'Escape']]) {
    assert.throws(() => sendTmuxKey(session, key, { expectedPid: '101', run: () => assert.fail() }));
  }
});

test('격리 CLI: 역할 안 nudge 허용, 충돌 옵션과 yes 사람 전용 유지', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-cli-'));
  const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
  const call = args => spawnSync(process.execPath, [cli, 'claude', 'refresh', ...args], {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, KADAN_HOME: home, KADAN_ROLE: 'nudge-test-sender',
      KADAN_SOCKET: `nudge-cli-${process.pid}` },
  });
  for (const args of [['--nudge', '--yes'], ['--nudge', '--switch'], ['--nudge', '--select', 'all'],
    ['--nudge', '--interval', '-1'], ['--nudge', 'value'], ['--yes', '--role', 'test']]) {
    assert.equal(call(args).status, 2, args.join(' '));
  }
  const result = call(['--nudge', '--json', '--interval', '0']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { results: [] });
});

test('가짜 tmux의 실제 CLI 왕복: Escape·Enter·send 표시·결과 JSON, 재시작 없음', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-roundtrip-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(home, 'screen'), MENU);
  fs.writeFileSync(path.join(bin, 'tmux'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.KADAN_HOME;
const args = process.argv.slice(2);
const commands = ['list-sessions', 'has-session', 'display-message', 'list-clients',
  'show-options', 'capture-pane', 'load-buffer', 'paste-buffer', 'send-keys'];
const at = args.findIndex(value => commands.includes(value));
const command = args[at];
fs.appendFileSync(path.join(home, 'calls'), JSON.stringify(args) + '\\n');
if (!command) process.exit(9);
if (command === 'list-sessions') process.stdout.write('kadan-nudge-test\\t0\\t1\\t101\\n');
if (command === 'display-message') {
  const field = args.at(-1);
  process.stdout.write(field === '#{pane_pid}' ? '101' : field === '#{pane_pid}|#{pane_dead}' ? '101|0' : '0');
}
if (command === 'capture-pane') process.stdout.write(fs.readFileSync(path.join(home, 'screen'), 'utf8'));
if (command === 'send-keys') fs.writeFileSync(path.join(home, 'screen'),
  args.at(-1) === 'Escape' ? ${JSON.stringify(INPUT)} : ${JSON.stringify(IDLE)});
`, { mode: 0o755 });
  appendLedger({ kind: 'start', session: 'kadan-nudge-test', role: 'nudge-test', panePid: '101',
    cmd: 'claude --model claude-haiku-5-5', roleProfile: 'worker' }, home);
  const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [cli, 'claude', 'refresh', '--nudge', '--interval', '0', '--json'], {
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, KADAN_HOME: home, KADAN_ROLE: 'nudge-test-sender',
      PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).results[0].outcome, 'nudged');
  const events = readLedger(home);
  assert.deepEqual(events.map(event => event.kind), ['start', 'send']);
  assert.equal(events[1].nudge, true);
  assert.equal(events[1].escaped, true);
  const calls = fs.readFileSync(path.join(home, 'calls'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.filter(call => call.includes('send-keys')).map(call => call.at(-1)), ['Escape', 'Enter']);
});
