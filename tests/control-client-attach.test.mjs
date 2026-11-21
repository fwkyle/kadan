import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {attachHuman} from './helpers/human-client.mjs';
import {clientAttached, sendTmux, sessionClientCount} from '../src/floor-tmux.mjs';

// 제어 모드(`tmux -C attach`) 연동 client는 "탭이 붙었다"에는 세고 "사람이 입력했다"에는 세지 않는다(2026-10-19 격리 소켓 실측).
// Rottie 연동 탭은 중계(제어 client)만 붙고 일반 attach는 뜨지 않으므로, clientAttached가 제어 client를 빼면
// openWindow의 붙음 기다림이 시간 초과로 실패한다. 사람 입력은 client_activity가 붙은 시각보다 뒤일 때만 센다.
// 운영 소켓으로 새지 않게 npm test가 깐 격리 소켓(kadan-test-*)에서만 돈다.
const socket = process.env.KADAN_SOCKET ?? '';
const session = `kadan-ctl-${process.pid}`;
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const tmux = (...args) => spawnSync('tmux', ['-L', socket, ...args], {encoding: 'utf8'});
const run = (args, input) => {
  const r = spawnSync('tmux', ['-L', socket, ...args], {encoding: 'utf8', input});
  if (r.status !== 0) throw new Error(`tmux ${args.join(' ')} 실패: ${r.stderr}`);
  return r.stdout;
};
const clients = () => tmux('list-clients', '-t', `=${session}`, '-F', '#{client_control_mode} #{client_created} #{client_activity}').stdout.trim();
const send = () => {
  try { sendTmux(session, 'probe', {run, spawn: () => ({status: 0}), pid: 1, hrtime: () => 1n}); return 'sent'; }
  catch (e) { return e.code ?? e.message; }
};

test('제어 모드 client는 붙음에는 세고 사람 입력에는 세지 않는다', {skip: !socket.startsWith('kadan-test-')}, () => {
  let control, human;
  try {
    assert.equal(tmux('new-session', '-d', '-s', session, '-x', '100', '-y', '30', 'cat').status, 0);
    assert.equal(clientAttached(session), false, '아무도 안 붙으면 미접속');

    control = spawn('tmux', ['-L', socket, '-C', 'attach', '-t', `=${session}`], {stdio: ['pipe', 'ignore', 'ignore']});
    control.stdin.on('error', () => {});
    for (let i = 0; i < 250 && !clients(); i++) sleep(20);
    sleep(2500); // 활동은 초 단위라 붙은 시각보다 1초 이상 뒤에 값을 본다
    assert.equal(clientAttached(session), true, '제어 client만 붙어도 탭이 붙은 것으로 센다');
    assert.equal(send(), 'sent', '붙기만 한 제어 client는 사람 입력이 아니다');

    control.stdin.write(`send-keys -t =${session}: -l 'from-control'\nrefresh-client -C 120x40\n`);
    sleep(1500);
    const [mode, created, activity] = clients().split(' ');
    assert.equal(mode, '1');
    assert.equal(activity, created, '제어 client의 send-keys·크기 변경은 client_activity를 올리지 않는다');
    assert.equal(send(), 'sent', '중계가 입력을 보내도 사람 입력으로 보류하지 않는다');

    human = attachHuman('tmux', socket, `=${session}`);
    human.type('y');
    assert.equal(send(), 'KADAN_HUMAN_ACTIVE', '일반 client의 키 입력은 제어 client가 같이 붙어 있어도 보류한다');
  } finally {
    human?.kill();
    control?.kill();
    tmux('kill-session', '-t', `=${session}`);
  }
});

// 비서 탭 판정(src/secretary-tab.mjs)이 쓰는 읽기: 안 붙음(0) · 붙음(N) · 모름(ok:false)을 따로 답한다. 격리 소켓에서만 돈다.
test('sessionClientCount: 화면이 없으면 0, 제어 client가 붙으면 1, 없는 세션·이름 앞부분만 같은 세션은 모름', {skip: !socket.startsWith('kadan-test-')}, () => {
  const name = `kadan-cnt-${process.pid}`;
  const countClients = () => tmux('list-clients', '-t', `=${name}`, '-F', '#{client_pid}').stdout.trim();
  let control;
  try {
    assert.equal(tmux('new-session', '-d', '-s', name, '-x', '100', '-y', '30', 'cat').status, 0);
    assert.deepEqual(sessionClientCount(name), {ok: true, count: 0}, '아무도 안 붙으면 0');
    control = spawn('tmux', ['-L', socket, '-C', 'attach', '-t', `=${name}`], {stdio: ['pipe', 'ignore', 'ignore']});
    control.stdin.on('error', () => {});
    for (let i = 0; i < 250 && !countClients(); i++) sleep(20);
    assert.deepEqual(sessionClientCount(name), {ok: true, count: 1}, '로티 탭처럼 제어 client만 붙어도 1');
    const prefix = sessionClientCount(name.slice(0, -1));
    assert.equal(prefix.ok, false, '`=`로 정확히 그 이름만 본다: 앞부분만 같은 이름은 그 세션을 세지 않는다');
  } finally {
    control?.kill();
    tmux('kill-session', '-t', `=${name}`);
  }
  const missing = sessionClientCount(`kadan-cnt-missing-${process.pid}`);
  assert.equal(missing.ok, false, '없는 세션은 0이 아니라 모름');
  assert.match(String(missing.code), /^tmux-exit-\d+$/);
});
