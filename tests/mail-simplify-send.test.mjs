// 우편 단순화 1단계: 실제 CLI로 보내기 경로(아는 역할 보관 / 오타 실패 / --mailbox 무시 / 비서 저장 전용 / 바로 넣기).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {appendLedger, readLedger} from '../src/ledger.mjs';

const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
const hasTmux = spawnSync('tmux', ['-V']).status === 0;
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-mail-simplify-'));
  const socket = path.basename(home);
  const env = {...process.env, KADAN_HOME: home, KADAN_SOCKET: socket, KADAN_WINDOW: 'none',
    KADAN_FLOOR: 'tmux', KADAN_ROLE: 'boss', KADAN_NOTIFY: 'off'};
  const call = (...args) => spawnSync(process.execPath, [cli, ...args], {env, cwd: home, encoding: 'utf8', input: '', timeout: 10000});
  const sends = () => readLedger(home).filter(e => e.kind === 'send');
  return {home, socket, env, call, sends};
}
const knownOffline = f => appendLedger({kind: 'start', role: 'worker', session: 'kadan-worker', panePid: 4242,
  t: '2026-10-21T00:00:00Z'}, f.home);

test('모르는 역할(오타)은 조용히 저장하지 않고 실패한다 — --mailbox를 붙여도 같다', () => {
  const f = fixture();
  for (const extra of [[], ['--mailbox']]) {
    const result = f.call('mail', 'wokrer', ...extra, '안녕');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /알 수 없는 역할/);
  }
  assert.equal(f.sends().length, 0);
});

test('아는 역할인데 세션이 없으면 보관한다(종료 0, wake=watch-required)', () => {
  const f = fixture(); knownOffline(f);
  const result = f.call('mail', 'worker', '안녕');
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, 'stored'); assert.equal(receipt.wake, 'watch-required');
  const [mail] = f.sends();
  assert.equal(mail.transport, 'mailbox'); assert.equal(mail.keyDelivery, undefined);
});

test('계층표에만 있는 역할(시작 기록 없음)도 아는 역할이라 보관한다', () => {
  const f = fixture();
  const table = path.join(f.home, 'hierarchy.json');
  fs.writeFileSync(table, JSON.stringify({boss: '@user', worker: 'boss'}));
  appendLedger({kind: 'hierarchy-loaded', path: table}, f.home);
  const result = f.call('send', 'worker', '안녕');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'stored');
});

test('--mailbox는 경고만 하고 일반 경로를 탄다(send·mail 모두)', () => {
  const f = fixture(); knownOffline(f);
  for (const command of ['mail', 'send']) {
    const result = f.call(command, 'worker', '--mailbox', '안녕');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /--mailbox는 더 이상 쓰지 않습니다/);
    assert.equal(JSON.parse(result.stdout).status, 'stored');
  }
});

test('비서·사람 앞 우편은 지금처럼 저장 전용이고 --mailbox 경고도 없다', () => {
  const f = fixture();
  for (const target of ['비서', '사람']) {
    for (const extra of [[], ['--mailbox']]) {
      const result = f.call('mail', target, ...extra, '보고');
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /--mailbox/);
      assert.equal(JSON.parse(result.stdout).status, 'stored');
    }
  }
});

test('--raw는 보관될 수 있는 우편에서 계속 거절한다 — 세션이 없는 아는 역할에는 저장 없이 실패', () => {
  const f = fixture(); knownOffline(f);
  const result = f.call('mail', 'worker', '--raw', '원문');
  assert.notEqual(result.status, 0);
  assert.equal(f.sends().length, 0);
});

test('받는 세션이 살아 있으면 바로 넣는다(--mailbox를 붙여도)', { skip: !hasTmux }, () => {
  const f = fixture();
  const receiver = path.join(f.home, 'codex.mjs');
  fs.writeFileSync(receiver, `
import fs from 'node:fs';
import path from 'node:path';
const prompt = () => process.stdout.write('\\x1b[2J\\x1b[H› ');
prompt();
process.stdin.on('data', data => { fs.appendFileSync(path.join(process.env.KADAN_HOME, 'received'), data); prompt(); });
fs.writeFileSync(path.join(process.env.KADAN_HOME, 'ready'), 'ready');
`);
  const harness = path.join(f.home, 'codex');
  fs.writeFileSync(harness, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(receiver)} "$@"\n`);
  fs.chmodSync(harness, 0o755);
  try {
    const started = f.call('start', 'worker', '--hidden', '--cmd', `${quote(harness)} --model test-model`);
    assert.equal(started.status, 0, started.stderr);
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(path.join(f.home, 'ready')) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    assert.ok(fs.existsSync(path.join(f.home, 'ready')), '격리 수신기 준비 실패');
    for (const extra of [[], ['--mailbox']]) {
      const result = f.call('mail', 'worker', ...extra, '바로 전달');
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /키 전송됨/);
    }
    const sent = f.sends().filter(e => e.keyDelivery === 'sent');
    assert.equal(sent.length, 2);
    assert.ok(sent.every(e => e.transport !== 'mailbox'));
  } finally {
    spawnSync('tmux', ['-L', f.socket, 'kill-session', '-t', 'kadan-worker'], {env: f.env});
  }
});
