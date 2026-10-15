import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {capturePane, sendTmux, sendTmuxEnter} from '../src/floor-tmux.mjs';

const hasTmux = spawnSync('tmux', ['-V']).status === 0;

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-exact-target-'));
  const socket = `kadan-exact-${randomUUID()}`;
  const session = 'kadan-prefix';
  const peer = `${session}-peer`;
  const before = {KADAN_HOME: process.env.KADAN_HOME, KADAN_SOCKET: process.env.KADAN_SOCKET};
  process.env.KADAN_HOME = home;
  process.env.KADAN_SOCKET = socket;
  const run = (args, input) => {
    const result = spawnSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], {
      encoding: 'utf8', input, timeout: 5000,
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  t.after(() => {
    spawnSync('tmux', ['-L', socket, 'kill-server']);
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const name of [session, peer]) run(['new-session', '-d', '-s', name, 'cat']);
  const stopTarget = () => run(['kill-session', '-t', `=${session}`]);
  const peerScreen = () => run(['capture-pane', '-p', '-t', `=${peer}:`]);
  return {run, session, peer, stopTarget, peerScreen};
}

for (const stage of ['paste-buffer', 'send-keys']) {
  test(`전송 직전 대상 소멸: ${stage}가 비슷한 이름의 세션에 전달되지 않는다`, {skip: !hasTmux}, t => {
    const f = fixture(t);
    const before = f.peerScreen();
    const run = (args, input) => {
      if (args[0] === stage) f.stopTarget();
      return f.run(args, input);
    };
    assert.throws(() => sendTmux(f.session, 'WRONG_RECIPIENT', {run, spawn: () => {}}));
    assert.equal(f.peerScreen(), before);
  });
}

test('Enter 전용 전송·화면 읽기도 사라진 세션의 접두사에 연결하지 않는다', {skip: !hasTmux}, t => {
  const f = fixture(t);
  f.run(['send-keys', '-t', `=${f.peer}:`, '-l', 'PEER_PENDING']);
  const run = args => {
    if (args[0] === 'send-keys') f.stopTarget();
    return f.run(args);
  };
  assert.throws(() => sendTmuxEnter(f.session, {run}));
  assert.equal(capturePane(f.session), '');
  assert.match(f.peerScreen(), /PEER_PENDING/);
});

test('강제 알림의 복사 모드 해제도 다른 세션에 적용하지 않는다', {skip: !hasTmux}, t => {
  const f = fixture(t);
  for (const name of [f.session, f.peer]) f.run(['copy-mode', '-t', `=${name}:`]);
  const run = (args, input) => {
    if (args.includes('cancel')) f.stopTarget();
    return f.run(args, input);
  };
  assert.throws(() => sendTmux(f.session, 'WRONG_RECIPIENT', {
    run, spawn: () => {}, notificationGuard: {force: true},
  }));
  assert.equal(f.run(['display-message', '-p', '-t', `=${f.peer}:`, '#{pane_in_mode}']).trim(), '1');
});
