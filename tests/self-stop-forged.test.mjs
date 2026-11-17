import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {ledgerHome, appendLedger, readLedger} from '../src/ledger.mjs';
import {tmuxFloor, tmux} from '../src/floor-tmux.mjs';

// 숨은 인자 `--self-stop-tail`은 일반 `kadan stop <역할>`보다 힘이 세면 안 된다.
// 꾸민 JSON으로 불러도 일반 stop처럼 거절돼야 한다(세션은 살아 있고 stop 기록이 없다). 격리 홈·격리 tmux 서버만 쓴다.
const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
const skip = spawnSync('tmux', ['-V']).status !== 0;
const DEAD_PARENT = 2 ** 22 + 4321; // 없는 PID라 앞쪽 종료 대기는 바로 통과한다

function setup(t, name) {
  const home = ledgerHome();
  const prior = {socket: process.env.KADAN_SOCKET, tmpdir: process.env.TMUX_TMPDIR};
  const socket = `o${process.pid}${name}`;
  process.env.KADAN_SOCKET = socket;
  const sockDir = fs.mkdtempSync('/tmp/kf-');
  process.env.TMUX_TMPDIR = sockDir;
  t.after(() => {
    tmux(['kill-server']); // 이 시험의 격리 소켓 서버만 끈다
    fs.rmSync(sockDir, {recursive: true, force: true});
    for (const [key, value] of [['KADAN_SOCKET', prior.socket], ['TMUX_TMPDIR', prior.tmpdir]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const env = {...process.env, KADAN_HOME: home, KADAN_SOCKET: socket, TMUX_TMPDIR: sockDir, KADAN_FLOOR: 'tmux',
    KADAN_WINDOW: 'none', KADAN_NOTIFY: 'off', KADAN_ROLE: ''};
  const session = (role, {start = true, panePid} = {}) => {
    const name = `kadan-${role}`;
    const created = tmuxFloor.create({session: name, role, cwd: sockDir, cmd: 'sleep 300'});
    if (start) appendLedger({kind: 'start', floor: 'tmux', role, session: name, roleProfile: 'worker', by: 'test',
      panePid: panePid ?? created.panePid}, home);
    return {name, panePid: created.panePid};
  };
  // 옛 모양(호출자가 소유 확인 값을 통째로 준다)의 꾸민 payload. 새 모양은 이 값들을 믿지 않으므로 같은 JSON으로 두 모양을 모두 시험한다.
  const forged = (role, over = {}) => JSON.stringify({role, session: `kadan-${role}`, logPath: `${sockDir}/crafted.log`,
    parentPid: DEAD_PARENT, infrastructure: true, owner: {role, session: `kadan-${role}`, revive: null, start: null},
    marked: null, conversation: {conversationMissing: 'crafted'}, owned: [], by: 'crafted', ...over});
  const run = (argvRole, json, extraEnv = {}) => spawnSync(process.execPath, [cli, 'stop', argvRole, '--self-stop-tail', json],
    {encoding: 'utf8', env: {...env, ...extraEnv}, timeout: 30000});
  const stops = name => readLedger(home).filter(e => e.kind === 'stop' && e.session === name);
  return {home, session, forged, run, stops};
}

test('꾸민 JSON: 시작 기록이 없는 세션은 infrastructure·owner.start:null을 주어도 끌 수 없다', {skip}, t => {
  const s = setup(t, 'nostart');
  const victim = s.session('nostart', {start: false});
  const plain = spawnSync(process.execPath, [cli, 'stop', 'nostart'], {encoding: 'utf8',
    env: {...process.env, KADAN_HOME: s.home, KADAN_FLOOR: 'tmux', KADAN_WINDOW: 'none', KADAN_NOTIFY: 'off', KADAN_ROLE: ''}});
  assert.notEqual(plain.status, 0, '일반 stop은 시작 기록이 없으면 거절한다');
  const crafted = s.run('nostart', s.forged('nostart'));
  assert.notEqual(crafted.status, 0, crafted.stdout + crafted.stderr);
  assert.equal(tmuxFloor.alive(victim.name), true, '세션은 살아 있다');
  assert.equal(s.stops(victim.name).length, 0, 'stop 기록이 없다(꾸민 by도 없다)');
});

test('꾸민 JSON: 명령의 역할과 payload의 역할이 다르면 거절한다', {skip}, t => {
  const s = setup(t, 'mismatch');
  const victim = s.session('victim');
  const crafted = s.run('somebody-else', s.forged('victim', {owner: {role: 'victim', session: victim.name, revive: null, start: {panePid: victim.panePid}}}));
  assert.notEqual(crafted.status, 0, crafted.stdout + crafted.stderr);
  assert.equal(tmuxFloor.alive(victim.name), true);
  assert.equal(s.stops(victim.name).length, 0);
});

test('꾸민 JSON: 원장의 기대 PID와 현재 pane PID가 다르면 payload가 무엇이든 거절한다', {skip}, t => {
  const s = setup(t, 'pidchg');
  const victim = s.session('pidchg', {panePid: 999999});
  const crafted = s.run('pidchg', s.forged('pidchg', {owner: {role: 'pidchg', session: victim.name, revive: null, start: {panePid: victim.panePid}}}));
  assert.notEqual(crafted.status, 0, crafted.stdout + crafted.stderr);
  assert.equal(tmuxFloor.alive(victim.name), true);
  assert.equal(s.stops(victim.name).length, 0);
});

test('꾸민 JSON: payload 역할을 watch로 줘도 Autopilot 가드가 일반 stop과 같게 막는다', {skip}, t => {
  const s = setup(t, 'guard');
  const watch = s.session('watch');
  appendLedger({kind: 'autopilot', phase: 'on', by: 'test'}, s.home);
  const asRole = {KADAN_ROLE: 'some-supervisor'};
  const plain = spawnSync(process.execPath, [cli, 'stop', 'watch'], {encoding: 'utf8', env: {...process.env, KADAN_HOME: s.home,
    KADAN_SOCKET: process.env.KADAN_SOCKET, TMUX_TMPDIR: process.env.TMUX_TMPDIR, KADAN_FLOOR: 'tmux', KADAN_WINDOW: 'none', KADAN_NOTIFY: 'off', ...asRole}});
  assert.equal(plain.status, 2, `일반 stop은 가드가 거절한다: ${plain.stdout}${plain.stderr}`);
  assert.equal(s.run('watch', s.forged('watch'), asRole).status, 2, '같은 역할을 숨은 인자로 불러도 같은 가드가 거절한다');
  const disguised = s.run('decoy-role', s.forged('watch'), asRole);
  assert.notEqual(disguised.status, 0, disguised.stdout + disguised.stderr);
  assert.equal(tmuxFloor.alive(watch.name), true, '기반 세션은 살아 있다');
  assert.equal(s.stops(watch.name).length, 0);
});
