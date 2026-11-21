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

// 재검수(2026-11-21) 뒤 순서: 화면 0개 확인 → 옛 탭 remove 먼저 → 성공·NOT_FOUND일 때만 create. 사후 되돌리기는 없다.
// 화면 수는 실제 격리 tmux의 제어 client로 만들고 로티만 가짜(호출 순서 기록). 옛 탭이 0개 확인 뒤 늦게 붙는 경합은
// 로티 remove가 살아 있는 탭을 거부하는 것(ROTTIE_TERMINAL_RUNNING)으로 잡히고, 그러면 새 탭을 만들지 않는다.
test('비서 탭(실제 격리 tmux 화면 수): 화면이 붙어 있거나 옛 탭 remove가 거절되면 만들지 않고, 정상이면 새 탭 하나만 기록한다', {skip: !socket.startsWith('kadan-test-')}, () => {
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
  const cycle = ({onRemove = () => {}, onCreate = () => {}, oldRemoval = json({ok: true}), entries = null} = {}) => {
    entries ??= [{kind: 'start', role: '비서', session: name, cwd: process.cwd(), window: 'hidden', panePid: '321', rottieTerminalId: 'old-tab'}];
    const calls = []; const recorded = [];
    const run = (bin, args) => {
      const id = args.includes('--terminal') ? args[args.indexOf('--terminal') + 1] : null;
      calls.push(args[0] === 'status' ? 'status' : `${args[1]}${id ? ` ${id}` : ''}`);
      if (args[0] === 'status') return json({ok: true});
      if (args[1] === 'show') return json({ok: true, result: {terminal: {state: 'unknown'}}});   // 로티는 계속 unknown이라 답한다
      if (args[1] === 'remove') { onRemove(); return oldRemoval; }
      if (args[1] === 'create') { onCreate(); return json({ok: true, result: {created: true, terminal: {id: 'new-tab', pid: 1}}}); }
      return json({ok: true});
    };
    const result = attachHiddenSecretary({home: process.env.KADAN_HOME, floor: {pid: () => '321'}, session: name,
      readEntries: () => entries, record: entry => { recorded.push(entry); entries.push(entry); },
      env: {KADAN_WINDOW: 'rottie'}, readSetting: () => setting,
      open: opts => openSecretaryTab({...opts, platform: 'darwin', readSetting: () => setting, run})});
    return {result, calls, recorded, entries};
  };
  const refused = json({ok: false, error: {code: 'ROTTIE_TERMINAL_RUNNING'}}, 5);
  try {
    assert.equal(tmux('new-session', '-d', '-s', name, '-x', '100', '-y', '30', 'cat').status, 0);
    assert.deepEqual(screens(), {ok: true, count: 0});

    // (1) 화면이 이미 붙어 있다(살아 있는 로티 탭은 제어 client로 붙는다): show까지만 하고 remove·create 0회.
    attachControl(1);
    const attached = cycle();
    assert.deepEqual([attached.result.attached, attached.result.reason], [false, 'tab-unknown']);
    assert.deepEqual(attached.calls, ['status', 'show old-tab']);
    assert.match(attached.result.detail, /tmux 붙은 화면 1개$/);
    assert.equal(attached.recorded.length, 0);
    detachAll();

    // (2) 0개를 읽은 뒤 remove 직전에 옛 탭이 늦게 붙는다: 로티가 살아 있는 탭이라 remove를 거부 → 새 탭을 만들지 않는다.
    //     우리는 아무것도 닫거나 지우지 않는다(옛 탭 client는 그대로 1개).
    const late = cycle({onRemove: () => attachControl(1), oldRemoval: refused});
    assert.deepEqual([late.result.attached, late.result.reason], [false, 'tab-unknown']);
    assert.deepEqual(late.calls, ['status', 'show old-tab', 'remove old-tab']);
    assert.match(late.result.detail, /tmux 붙은 화면 0개 · 옛 탭 제거 거절 code=ROTTIE_TERMINAL_RUNNING$/);
    assert.equal(late.recorded.length, 0);
    assert.equal(screens().count, 1);
    detachAll();

    // (3) 정상: 화면 0, remove 성공, create 때 새 탭 client만 붙음 → 성공 기록 1개(restoredFrom 포함), 다음 주기 has-tab.
    const normal = cycle({onCreate: () => attachControl(1)});
    assert.deepEqual([normal.result.attached, normal.result.rottieTerminalId], [true, 'new-tab']);
    assert.deepEqual(normal.calls, ['status', 'show old-tab', 'remove old-tab', 'create']);
    assert.deepEqual(normal.recorded.map(e => [e.kind, e.rottieTerminalId, e.restoredFrom, e.oldState]), [['window', 'new-tab', 'old-tab', 'unknown']]);
    assert.equal(screens().count, 1);
    const next = cycle({entries: normal.entries});
    assert.deepEqual([next.result.reason, next.calls.length], ['has-tab', 0]);
  } finally {
    for (const child of readers.splice(0)) child.kill();
    tmux('kill-session', '-t', `=${name}`);
  }
});

// 3차 검수(2026-11-21): 앱만 재시작해 pane PID가 같으면 옛 탭 제거 직후 기본 키가 충돌한다. 충돌 재시도 키가 호출마다 달랐을 때는
// create가 적용됐는데 응답을 놓치면 다음 주기가 다른 키로 탭을 하나 더 만들었다. 재시도 키는 교체 대상 옛 탭 ID에서 정해져야 한다.
// 로티는 가짜(키 기억·응답 유실 흉내), 새 탭의 tmux client는 실제 격리 tmux의 제어 client로 만든다.
test('비서 탭(실제 격리 tmux): create가 적용됐는데 응답을 놓쳐도 다음 주기가 같은 키로 그 탭을 돌려받아 탭 하나·기록 1개로 끝난다', {skip: !socket.startsWith('kadan-test-')}, () => {
  const name = `kadan-lost-${process.pid}`;
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
  const json = (value, status = 0) => ({status, stdout: JSON.stringify(value), stderr: ''});
  const defaultKey = `kadan-${name}-321`;
  const keyToTab = new Map([[defaultKey, 'old-tab']]);       // 옛 탭은 기본 키로 만들어졌다(같은 pane PID)
  const removed = new Set(); const made = []; const keys = []; let lose = true;
  const run = (bin, args) => {
    const id = args.includes('--terminal') ? args[args.indexOf('--terminal') + 1] : null;
    if (args[0] === 'status') return json({ok: true});
    if (args[1] === 'show') return removed.has(id) ? json({ok: false, error: {code: 'ROTTIE_TERMINAL_NOT_FOUND'}}, 3) : json({ok: true, result: {terminal: {state: 'unknown'}}});
    if (args[1] === 'remove') { removed.add(id); return json({ok: true}); }
    if (args[1] === 'create') {
      const key = args[args.indexOf('--idempotency-key') + 1]; keys.push(key);
      if (keyToTab.has(key)) {
        const saved = keyToTab.get(key);
        return removed.has(saved) ? json({ok: false, error: {code: 'ROTTIE_IDEMPOTENCY_CONFLICT'}}, 2)
          : json({ok: true, result: {created: false, terminal: {id: saved, pid: 1}}});     // 같은 키·같은 인자: 살아 있는 그 탭을 돌려준다
      }
      const id2 = `tab-${made.length + 1}`; keyToTab.set(key, id2); made.push(id2);
      attachControl(made.length);                                                            // 새 탭의 client(적용됨)
      if (lose) { lose = false; return {status: null, stdout: '', stderr: '', error: Object.assign(new Error('timeout'), {code: 'ETIMEDOUT'})}; }
      return json({ok: true, result: {created: true, terminal: {id: id2, pid: 1}}});
    }
    return json({ok: true});
  };
  const entries = [{kind: 'start', role: '비서', session: name, cwd: process.cwd(), window: 'hidden', panePid: '321', rottieTerminalId: 'old-tab'}];
  const recorded = [];
  const cycle = () => attachHiddenSecretary({home: process.env.KADAN_HOME, floor: {pid: () => '321'}, session: name,
    readEntries: () => entries, record: entry => { recorded.push(entry); entries.push(entry); },
    env: {KADAN_WINDOW: 'rottie'}, readSetting: () => setting,
    open: opts => openSecretaryTab({...opts, platform: 'darwin', readSetting: () => setting, run})});
  try {
    assert.equal(tmux('new-session', '-d', '-s', name, '-x', '100', '-y', '30', 'cat').status, 0);
    const first = cycle();                                    // 옛 탭 제거 성공 → 기본 키 충돌 → 재시도 키로 적용됐지만 응답 유실
    assert.deepEqual([first.attached, first.reason, recorded.length], [false, 'open-failed', 0]);
    assert.deepEqual(made, ['tab-1']);
    assert.equal(screens().count, 1);
    const second = cycle();                                   // 다음 주기: 옛 탭은 NOT_FOUND, 같은 옛 탭 ID라 같은 재시도 키
    assert.deepEqual([second.attached, second.rottieTerminalId], [true, 'tab-1']);
    assert.deepEqual(keys, [defaultKey, `${defaultKey}-after-old-tab`, defaultKey, `${defaultKey}-after-old-tab`]);
    assert.deepEqual(made, ['tab-1'], '탭을 하나 더 만들지 않았다');
    assert.equal(screens().count, 1, 'client도 1개');
    assert.deepEqual(recorded.map(e => [e.kind, e.rottieTerminalId, e.restoredFrom, e.oldState]), [['window', 'tab-1', 'old-tab', '없음']]);
    assert.equal(cycle().reason, 'has-tab');
    assert.equal(made.length, 1);
  } finally {
    for (const child of readers.splice(0)) child.kill();
    tmux('kill-session', '-t', `=${name}`);
  }
});
