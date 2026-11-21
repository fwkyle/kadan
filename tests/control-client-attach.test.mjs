import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {attachHuman} from './helpers/human-client.mjs';
import {clientAttached, sendTmux, sessionClientCount} from '../src/floor-tmux.mjs';
import {attachHiddenSecretary, openSecretaryTab} from '../src/secretary-tab.mjs';

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

// 검수 재현 3형태(2026-11-21): 화면 0개를 읽고 새 탭을 만드는 사이에 옛 탭 client가 늦게 붙는 경합.
// openWindow는 "그 세션에 client가 하나라도 있나"만 보므로 옛 탭의 연결을 새 탭의 성공으로 오인했다.
// 로티는 가짜(호출 순서 기록), 화면 수는 실제 격리 tmux의 제어 client로 만든다.
test('비서 탭 경합: 옛 탭만 늦게 붙음·둘 다 붙음은 새 탭을 치우고 성공으로 기록하지 않고, 정상은 탭 하나만 기록한다', {skip: !socket.startsWith('kadan-test-')}, () => {
  const name = `kadan-race-${process.pid}`;
  const setting = {version: 1, window: 'rottie', rottieBin: '/fixture/rottie'};
  const readers = [];
  const screens = () => sessionClientCount(name);
  const attachControl = expected => {
    const child = spawn('tmux', ['-L', socket, '-C', 'attach', '-t', `=${name}`], {stdio: ['pipe', 'ignore', 'ignore']});
    child.stdin.on('error', () => {});
    readers.push(child);
    for (let i = 0; i < 250 && screens().count !== expected; i++) sleep(20);
    assert.equal(screens().count, expected);
  };
  const detachAll = () => {
    for (const child of readers.splice(0)) child.kill();
    for (let i = 0; i < 250 && screens().count !== 0; i++) sleep(20);
    assert.deepEqual(screens(), {ok: true, count: 0});
  };
  const json = (value, status = 0) => ({status, stdout: JSON.stringify(value), stderr: ''});
  const cycle = ({onCreate, oldRemoval}) => {
    const entries = [{kind: 'start', role: '비서', session: name, cwd: process.cwd(), window: 'hidden', panePid: '321',
      rottieTerminalId: 'old-tab'}];
    const calls = []; const recorded = [];
    const run = (bin, args) => {
      const id = args.includes('--terminal') ? args[args.indexOf('--terminal') + 1] : null;
      calls.push(args[0] === 'status' ? 'status' : `${args[1]}${id ? ` ${id}` : ''}`);
      if (args[0] === 'status') return json({ok: true});
      if (args[1] === 'show') return json({ok: true, result: {terminal: {state: 'unknown'}}}); // 로티는 계속 unknown이라 답한다
      if (args[1] === 'create') { onCreate(); return json({ok: true, result: {terminal: {id: 'new-tab', pid: 1}}}); }
      if (args[1] === 'remove' && id === 'old-tab') return oldRemoval;                           // 살아 있을 수 있는 탭은 로티가 거부한다
      return json({ok: true});                                                                    // 새 탭 close·remove
    };
    const result = attachHiddenSecretary({home: process.env.KADAN_HOME, floor: {pid: () => '321'}, session: name,
      readEntries: () => entries, record: entry => { recorded.push(entry); entries.push(entry); },
      env: {KADAN_WINDOW: 'rottie'}, readSetting: () => setting,
      open: opts => openSecretaryTab({...opts, platform: 'darwin', readSetting: () => setting, run})});
    return {result, calls, recorded, entries};
  };
  const refused = json({ok: false, error: {code: 'ROTTIE_TERMINAL_RUNNING'}}, 3);
  const cleaned = ['status', 'show old-tab', 'create', 'show old-tab', 'remove old-tab', 'close new-tab', 'remove new-tab'];
  try {
    assert.equal(tmux('new-session', '-d', '-s', name, '-x', '100', '-y', '30', 'cat').status, 0);
    assert.deepEqual(screens(), {ok: true, count: 0});

    // (1) 0개를 읽은 뒤 옛 탭만 붙음(새 탭 client는 시작 전): 새 탭을 치우고 성공 기록·has-tab 없음.
    const oldOnly = cycle({onCreate: () => attachControl(1), oldRemoval: refused});
    assert.deepEqual([oldOnly.result.attached, oldOnly.result.reason], [false, 'tab-raced']);
    assert.deepEqual(oldOnly.calls, cleaned);
    assert.equal(oldOnly.recorded.length, 0);
    assert.equal(screens().count, 1, '옛 탭 client는 그대로(우리는 tmux client를 건드리지 않는다)');
    assert.equal(oldOnly.entries.some(e => e.kind === 'window'), false);
    detachAll();

    // (2) 옛 탭과 새 탭이 둘 다 붙음: 같은 결과(탭을 둘 남기지 않는다).
    const both = cycle({onCreate: () => { attachControl(1); attachControl(2); }, oldRemoval: refused});
    assert.deepEqual([both.result.attached, both.result.reason], [false, 'tab-raced']);
    assert.deepEqual(both.calls, cleaned);
    assert.equal(both.recorded.length, 0);
    detachAll();

    // (3) 정상: 새 탭 client만 붙고 옛 탭 제거는 성공 → 성공 기록 1개, 새 탭 정리 없음, 다음 주기 has-tab.
    const normal = cycle({onCreate: () => attachControl(1), oldRemoval: json({ok: true})});
    assert.deepEqual([normal.result.attached, normal.result.rottieTerminalId], [true, 'new-tab']);
    assert.deepEqual(normal.calls, ['status', 'show old-tab', 'create', 'show old-tab', 'remove old-tab']);
    assert.deepEqual(normal.recorded.map(e => [e.kind, e.rottieTerminalId, e.restoredFrom, e.oldState]), [['window', 'new-tab', 'old-tab', 'unknown']]);
    assert.equal(screens().count, 1);
  } finally {
    for (const child of readers.splice(0)) child.kill();
    tmux('kill-session', '-t', `=${name}`);
  }
});
