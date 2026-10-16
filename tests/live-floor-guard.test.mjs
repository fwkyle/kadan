import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {liveFloorReason, assertNotLiveFloor} from '../src/live-floor-guard.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-floor-guard-'));
const liveHome = path.join(tmp, 'live'); fs.mkdirSync(liveHome);
const linkHome = path.join(tmp, 'link'); fs.symlinkSync(liveHome, linkHome);
const other = path.join(tmp, 'other'); fs.mkdirSync(other);

test('기본 아닌 홈 + 기본 소켓 → 거절', () => {
  assert.match(liveFloorReason({KADAN_HOME: other}, liveHome), /KADAN_SOCKET/);
  assert.match(liveFloorReason({KADAN_HOME: other, KADAN_SOCKET: 'kadan'}, liveHome), /KADAN_SOCKET=kadan/);
  assert.throws(() => assertNotLiveFloor({KADAN_HOME: other}, liveHome), /KADAN_LIVE_FLOOR_DENIED.*KADAN_SOCKET/);
});

test('KADAN_SOCKET 없음·빈 값·undefined로 덮어도 기본 아닌 홈이면 거절', () => {
  for (const env of [{KADAN_HOME: other}, {KADAN_HOME: other, KADAN_SOCKET: ''}, {KADAN_HOME: other, KADAN_SOCKET: undefined},
    {KADAN_HOME: other, KADAN_LITE_SOCKET: 'kadan'}]) {
    assert.throws(() => assertNotLiveFloor(env, liveHome), /KADAN_LIVE_FLOOR_DENIED/, JSON.stringify(env));
  }
});

test('기본 홈(링크 포함) + 기본 소켓 → 통과', () => {
  assert.equal(liveFloorReason({KADAN_HOME: liveHome}, liveHome), null);
  assert.equal(liveFloorReason({KADAN_HOME: linkHome}, liveHome), null);
  assert.equal(liveFloorReason({}, liveHome), null);
});

test('기본 아닌 홈 + 격리 소켓 → 통과, 운영 창 설정이면 거절', () => {
  assert.equal(liveFloorReason({KADAN_HOME: other, KADAN_SOCKET: 'iso-1', KADAN_WINDOW: 'none'}, liveHome), null);
  assert.match(liveFloorReason({KADAN_HOME: other, KADAN_SOCKET: 'iso-1', KADAN_WINDOW: 'rottie'}, liveHome), /KADAN_WINDOW=rottie/);
});

test('허용 변수 → 통과', () => {
  assert.equal(liveFloorReason({KADAN_HOME: other, KADAN_ALLOW_LIVE_FLOOR: '1'}, liveHome), null);
});

test('샌 모양(notify 대역 없는 DecisionStore)이 기본 소켓 환경에서 tmux를 한 번도 부르지 않는다', () => {
  // 가짜 tmux가 호출을 기록한다. 소켓·창은 일부러 운영 기본값으로 둔다(격리 setup이 없는 상태).
  const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
  const calls = path.join(tmp, 'tmux-calls.txt');
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\nexit 0\n`, {mode: 0o755});
  const home = path.join(tmp, 'leak-home'); fs.mkdirSync(home);
  const env = {PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, KADAN_HOME: home, KADAN_NOTIFY: 'off', KADAN_FLOOR: 'tmux'};
  const script = `import {DecisionStore} from ${JSON.stringify(new URL('../src/decisions.mjs', import.meta.url).href)};
    const s = new DecisionStore(${JSON.stringify(home)}, {userNotify: () => null});
    try { s.notify('시험-슈퍼감독', '가짜'); } catch (e) { console.log('ERR ' + e.message); }`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {env, encoding: 'utf8'});
  assert.ok(!fs.existsSync(calls), `tmux가 불렸다: ${fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : ''}`);
  assert.match(r.stdout + r.stderr, /통지 실패|KADAN_LIVE_FLOOR_DENIED/);
});

test('npm test 실행기(tests/run.mjs)가 격리 환경을 만들고 시험 프로세스가 물려받는다', () => {
  const out = path.join(tmp, 'seen-env.json');
  const probe = path.join(tmp, 'probe.test.mjs');
  fs.writeFileSync(probe, `import fs from 'node:fs';
import test from 'node:test';
test('probe', () => { const k = ['KADAN_SOCKET', 'KADAN_WINDOW', 'KADAN_NOTIFY', 'KADAN_ROLE', 'KADAN_ROTTIE_BIN', 'KADAN_HOME'];
  fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(Object.fromEntries(k.map(n => [n, process.env[n] ?? null])))); });\n`);
  const env = {...process.env, KADAN_SOCKET: 'kadan', KADAN_WINDOW: 'rottie', KADAN_ROLE: 'kadan-슈퍼감독',
    KADAN_ROTTIE_BIN: '/opt/rottie', KADAN_HOME: path.join(os.homedir(), '.kadan')};
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [new URL('./run.mjs', import.meta.url).pathname, probe], {env, encoding: 'utf8'});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.match(seen.KADAN_SOCKET, /^kadan-test-\d+-/);
  assert.deepEqual([seen.KADAN_WINDOW, seen.KADAN_NOTIFY, seen.KADAN_ROLE, seen.KADAN_ROTTIE_BIN, seen.KADAN_HOME],
    ['none', 'off', null, null, null]);
});
