// 우편 단순화 1단계: 실제 CLI로 보내기 경로(아는 역할 보관 / 오타 실패 / --mailbox 무시 / 비서 저장 전용 / 바로 넣기).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {MailWatch} from '../src/watch-mail.mjs';
import {MAIL_RULE} from '../src/mail-rule.mjs';

const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
const hasTmux = spawnSync('tmux', ['-V']).status === 0;
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-mail-simplify-'));
  const socket = path.basename(home);
  const env = {...process.env, KADAN_HOME: home, KADAN_SOCKET: socket, KADAN_WINDOW: 'none',
    KADAN_FLOOR: 'tmux', KADAN_ROLE: 'boss', KADAN_NOTIFY: 'off'};
  const call = (...args) => spawnSync(process.execPath, [cli, ...args], {env, cwd: os.tmpdir(), encoding: 'utf8', input: '', timeout: 10000});
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

test('C1: 꺼진 아는 역할에 보낸 우편은 표지가 붙고, 새 start 뒤 하루가 지나도 알림이 1회 나간다', () => {
  const f = fixture(); knownOffline(f);
  const result = f.call('mail', 'worker', '안녕');
  assert.equal(result.status, 0, result.stderr);
  const [mail] = f.sends();
  assert.equal(mail.mailRule, MAIL_RULE, '새 코드가 쓴 보관 우편에는 규칙 표지가 붙는다');
  const sentAt = Date.parse(mail.t);
  const entries = readLedger(f.home);
  entries.push({kind: 'start', role: 'worker', session: 'kadan-worker', panePid: 9001, t: new Date(sentAt + 60_000).toISOString()});
  const sent = [], records = [];
  const watch = new MailWatch({record: e => { records.push(e); entries.push(e); }, send: (...args) => sent.push(args)});
  watch.tick({entries: [...entries], cards: [], works: [], now: sentAt + 86_400_000,
    floor: {list: () => [{session: 'kadan-worker', alive: true, pid: 9001}]},
    readEntries: () => [...entries], readCards: () => [], readWorks: () => []});
  assert.equal(sent.length, 1, '보관 성공 → 알림 0회가 되면 안 된다');
  // 같은 상황에서 표지 없는 옛 우편은 옛 규칙대로 새 세대에게 알리지 않는다.
  const old = entries.map(e => e.mailId === mail.mailId && e.kind === 'send' ? (({mailRule, ...rest}) => rest)(e) : e).filter(e => e.kind !== 'watch-mail-reminder');
  const oldSent = [];
  new MailWatch({record: () => {}, send: (...args) => oldSent.push(args)}).tick({entries: old, cards: [], works: [], now: sentAt + 86_400_000,
    floor: {list: () => [{session: 'kadan-worker', alive: true, pid: 9001}]},
    readEntries: () => old, readCards: () => [], readWorks: () => []});
  assert.equal(oldSent.length, 0);
});

test('비서·사람 앞 저장 우편에도 표지가 붙는다(감시기는 받는 역할로 비서를 따로 거른다)', () => {
  const f = fixture();
  assert.equal(f.call('mail', '비서', '보고').status, 0);
  assert.equal(f.sends()[0].mailRule, MAIL_RULE);
});

const hierarchyFor = (f, table) => {
  const file = path.join(f.home, 'hierarchy.json');
  fs.writeFileSync(file, JSON.stringify(table));
  appendLedger({kind: 'hierarchy-loaded', path: file}, f.home);
};
const liveBareSession = (f, name) => spawnSync('tmux', ['-L', f.socket, 'new-session', '-d', '-s', name, 'sleep 60'], {env: f.env});

test('F1: 시작 PID 기록이 없는 슈퍼 앞 우편은 같은 이름 세션이 살아 있어도 보관하고 보내지 않는다', { skip: !hasTmux }, () => {
  const f = fixture();
  hierarchyFor(f, {'peer-a': '@user', 'peer-b': '@user'});
  try {
    assert.equal(liveBareSession(f, 'kadan-peer-b').status, 0);
    const env = {...f.env, KADAN_ROLE: 'peer-a'};
    const peer = spawnSync(process.execPath, [cli, 'mail', 'peer-b', 'PID 기록 없는 슈퍼 앞 우편'], {env, cwd: f.home, encoding: 'utf8', input: ''});
    assert.equal(peer.status, 0, peer.stderr);
    assert.equal(JSON.parse(peer.stdout).wake, 'watch-required');
    const peerMail = f.sends().find(e => e.by === 'peer-a');
    assert.equal(peerMail.transport, 'mailbox'); assert.equal(peerMail.keyDelivery, undefined);
    assert.doesNotMatch(peer.stderr, /PID 대조 생략/);
    // 일반 발신자도 시작 PID를 모르면 같은 보관 경로를 쓴다.
    const plain = f.call('mail', 'peer-b', '일반 우편');
    assert.equal(plain.status,0,plain.stderr);
    assert.equal(JSON.parse(plain.stdout).wake,'watch-required');
    assert.doesNotMatch(plain.stderr, /PID 대조 생략/);
    assert.equal(f.sends().filter(e => e.by === 'boss' && e.keyDelivery === 'sent').length,0);
  } finally {
    spawnSync('tmux', ['-L', f.socket, 'kill-session', '-t', 'kadan-peer-b'], {env: f.env});
  }
});

test('위치 인자와 파일 표준 입력을 함께 주면 거절하고 원장에 아무것도 쓰지 않는다', () => {
  const f = fixture(); knownOffline(f);
  const body = path.join(f.home, 'body.txt'); fs.writeFileSync(body, '긴 본문\n');
  for (const command of ['mail', 'send']) {
    const result = spawnSync(process.execPath, [cli, command, 'worker', '--expect-reply', '질문'],
      {env: f.env, cwd: os.tmpdir(), encoding: 'utf8', stdio: [fs.openSync(body, 'r'), 'pipe', 'pipe'], timeout: 10000});
    assert.notEqual(result.status, 0, command);
    assert.match(result.stderr, /본문이 두 곳에 있다/, command);
  }
  assert.equal(f.sends().length, 0);
});

test('위치 인자만, 파일 표준 입력만, 위치 인자 + 빈 파일은 정상 보관한다', () => {
  const f = fixture(); knownOffline(f);
  const body = path.join(f.home, 'body.txt'), empty = path.join(f.home, 'empty.txt');
  fs.writeFileSync(body, '파일 본문\n'); fs.writeFileSync(empty, '');
  const run = (args, file) => spawnSync(process.execPath, [cli, 'mail', 'worker', ...args],
    {env: f.env, cwd: os.tmpdir(), encoding: 'utf8', stdio: [file ? fs.openSync(file, 'r') : 'pipe', 'pipe', 'pipe'], input: undefined, timeout: 10000});
  for (const [args, file] of [[['위치 본문'], null], [[], body], [['위치 본문'], empty]]) {
    const result = run(args, file); assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(f.sends().length, 3);
});
