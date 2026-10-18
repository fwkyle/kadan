import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {attachHuman} from './helpers/human-client.mjs';
import {sendTmux} from '../src/floor-tmux.mjs';

// 경합: 붙여넣기 뒤 Enter 직전에 사람이 키를 누르면 Enter를 보내지 않는다(본문은 붙은 채, delivery=unknown). 가짜 값만 쓴다.
const NOW = 1_800_000_000; // 초
// 가짜 tmux: list-clients 값은 붙여넣기 전에는 "붙기만 함", paste-buffer 뒤에는 "방금 키를 누름"(sleep 1초 사이에 사람이 침)이다.
function fakeTmux({humanTypesAfterPaste}) {
  const calls = [];
  let pasted = false;
  const run = args => {
    calls.push(args[0]);
    if (args[0] === 'display-message') return '0';
    if (args[0] === 'list-clients') return pasted && humanTypesAfterPaste ? `${NOW - 60} ${NOW}` : `${NOW - 60} ${NOW - 60}`;
    if (args[0] === 'paste-buffer') pasted = true;
    return '';
  };
  return {run, calls};
}
const realNow = Date.now;
const withClock = fn => { Date.now = () => NOW * 1000 + 500; try { return fn(); } finally { Date.now = realNow; } };
const send = (run, extra = {}) => sendTmux('kadan-w', '우편 본문', {run, spawn: () => ({status: 0}), pid: 1, hrtime: () => 1n, ...extra});

for (const [label, extra] of [['일반 우편', {}], ['감시기 알림', {notificationGuard: {humanIdleMs: 30_000}}]]) {
  test(`경합 가짜 tmux(${label}): 붙여넣기와 Enter 사이에 사람이 키를 누르면 Enter 0회, delivery=unknown`, () => {
    const {run, calls} = fakeTmux({humanTypesAfterPaste: true});
    assert.throws(() => withClock(() => send(run, extra)), e => {
      assert.equal(e.code, 'KADAN_HUMAN_ACTIVE');
      assert.equal(e.delivery, 'unknown');
      assert.equal(e.sendStage, 'body-pasted');
      assert.match(e.message, /Enter는 보내지 않음/);
      return true;
    });
    assert.equal(calls.filter(c => c === 'send-keys').length, 0, 'Enter를 보내지 않는다');
    assert.equal(calls.includes('paste-buffer'), true);
  });
}

test('경합 강제 알림(force)은 Enter 직전 검사도 건너뛰어 지금처럼 보낸다', () => {
  const {run, calls} = fakeTmux({humanTypesAfterPaste: true});
  const result = withClock(() => send(run, {notificationGuard: {humanIdleMs: 30_000, force: true}}));
  assert.equal(result.keyDelivery, 'sent');
  assert.equal(calls.filter(c => c === 'send-keys').length, 1);
});

test('경합 사람이 안 쳤으면 Enter를 보낸다', () => {
  const {run, calls} = fakeTmux({humanTypesAfterPaste: false});
  assert.equal(withClock(() => send(run)).keyDelivery, 'sent');
  assert.equal(calls.filter(c => c === 'send-keys').length, 1);
});

test('경합 실제 격리 tmux: 붙여넣기와 Enter 사이 1초 안에 사람이 치면 함께 제출되지 않는다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-enter-'));
  const socket = `kadan-enter-${process.pid}`;
  const received = path.join(home, 'received');
  const receiver = path.join(home, 'receiver.mjs');
  fs.writeFileSync(receiver, `import fs from 'node:fs';import readline from 'node:readline';
process.stdout.write('\\n\\n› ');
readline.createInterface({input:process.stdin}).on('line',l=>{fs.appendFileSync(${JSON.stringify(received)},l+'\\n');process.stdout.write('› ');});`);
  const tmux = (...args) => spawnSync('tmux', ['-u', '-L', socket, ...args], {encoding: 'utf8'});
  const runIn = (args, input) => {
    const r = spawnSync('tmux', ['-u', '-L', socket, ...args], {encoding: 'utf8', input});
    if (r.status !== 0) throw new Error(`tmux ${args.join(' ')} 실패: ${r.stderr}`);
    return r.stdout;
  };
  const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const contents = () => fs.existsSync(received) ? fs.readFileSync(received, 'utf8') : '';
  let human;
  try {
    assert.equal(tmux('new-session', '-d', '-s', 'kadan-enter', '-x', '100', '-y', '30', process.execPath, receiver).status, 0);
    sleep(500);
    human = attachHuman('tmux', socket, '=kadan-enter');
    sleep(1300); // 붙은 뒤 1초 넘게 지나야 키 입력이 활동으로 센다
    // 붙여넣기 뒤 sleep 1초 자리에서 사람이 친다.
    const spawn = (cmd, args) => { if (cmd === 'sleep') human.type('x', 0); return {status: 0}; };
    assert.throws(() => sendTmux('kadan-enter', 'REAL_BODY', {run: runIn, spawn, pid: 1, hrtime: () => 1n}),
      e => e.code === 'KADAN_HUMAN_ACTIVE' && e.delivery === 'unknown');
    sleep(500);
    assert.doesNotMatch(contents(), /REAL_BODY/, 'Enter가 가지 않아 본문이 제출되지 않았다');
  } finally {
    human?.kill();
    tmux('kill-server');
  }
});
