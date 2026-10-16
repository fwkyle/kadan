import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {liveFloorReason, assertNotLiveFloor, assertNotLiveRottie} from '../src/live-floor-guard.mjs';

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
test('probe', () => { const k = ['KADAN_SOCKET', 'KADAN_WINDOW', 'KADAN_NOTIFY', 'KADAN_ROLE', 'KADAN_ROTTIE_BIN', 'KADAN_HOME', 'KADAN_ALLOW_LIVE_FLOOR', 'KADAN_ALLOW_FAKE_ROTTIE'];
  fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(Object.fromEntries(k.map(n => [n, process.env[n] ?? null])))); });\n`);
  const env = {...process.env, KADAN_SOCKET: 'kadan', KADAN_WINDOW: 'rottie', KADAN_ROLE: 'kadan-슈퍼감독',
    KADAN_ROTTIE_BIN: '/opt/rottie', KADAN_ALLOW_LIVE_FLOOR: '1', KADAN_ALLOW_FAKE_ROTTIE: '1', KADAN_HOME: path.join(os.homedir(), '.kadan')};
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [new URL('./run.mjs', import.meta.url).pathname, probe], {env, encoding: 'utf8'});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.match(seen.KADAN_SOCKET, /^kadan-test-\d+-/);
  assert.deepEqual([seen.KADAN_WINDOW, seen.KADAN_NOTIFY, seen.KADAN_ROLE, seen.KADAN_ROTTIE_BIN, seen.KADAN_HOME],
    ['none', 'off', null, null, null]);
  // 부모 셸에 허용값이 남아 있어도 시험 자식에는 가지 않는다.
  assert.deepEqual([seen.KADAN_ALLOW_LIVE_FLOOR, seen.KADAN_ALLOW_FAKE_ROTTIE], [null, null]);
});

// R3: 운영 홈의 모든 표기(a~f)는 소켓(없음·kadan) × 창(none·rottie) 어느 조합에서도 막지 않는다. 계정 폴더 대신 격리 폴더와 호환 링크를 쓴다.
const acct = path.join(tmp, 'acct'); fs.mkdirSync(path.join(acct, '.kadan'), {recursive: true});
fs.symlinkSync(path.join(acct, '.kadan'), path.join(acct, '.kadan-lite'));
const defaultHome = path.join(acct, '.kadan');
const forms = {
  'a ~/.kadan': {KADAN_HOME: defaultHome},
  'b ~/.kadan-lite(링크)': {KADAN_HOME: path.join(acct, '.kadan-lite')},
  'c 끝에 /': {KADAN_HOME: defaultHome + '/'},
  'c2 호환 링크 끝 /': {KADAN_HOME: path.join(acct, '.kadan-lite') + '/'},
  'd KADAN_LITE_HOME만(호환 링크)': {KADAN_LITE_HOME: path.join(acct, '.kadan-lite')},
  'e 두 변수 모두': {KADAN_HOME: defaultHome, KADAN_LITE_HOME: path.join(acct, '.kadan-lite')},
  'f 둘 다 없음': {},
};
const caseInsensitive = fs.existsSync(path.join(acct, '.KADAN'));
if (caseInsensitive) forms['g 대문자 별칭'] = {KADAN_HOME: path.join(acct, '.KADAN')};
for (const [name, base] of Object.entries(forms)) {
  test(`운영 홈 표기 ${name}: 소켓·창 조합을 모두 허용`, () => {
    for (const socket of [undefined, 'kadan'])
      for (const window of ['none', 'rottie']) {
        const env = {...base, ...(socket ? {KADAN_SOCKET: socket} : {}), KADAN_WINDOW: window};
        assert.equal(liveFloorReason(env, defaultHome), null, JSON.stringify(env));
        assert.doesNotThrow(() => assertNotLiveRottie(env, defaultHome), JSON.stringify(env));
      }
  });
}

test('KADAN_LITE_HOME만 있는 기본 아닌 홈도 거절', () => {
  assert.throws(() => assertNotLiveFloor({KADAN_LITE_HOME: other}, defaultHome), /KADAN_LIVE_FLOOR_DENIED/);
});

// R1: 로티 길목. 시험 전용 허용은 로티 검사만 풀고 tmux 검사는 풀지 않는다.
test('로티 길목: 기본 아닌 홈은 거절, 시험 전용 허용·전체 허용은 통과, tmux 검사는 그대로', () => {
  assert.throws(() => assertNotLiveRottie({KADAN_HOME: other}, defaultHome), /KADAN_LIVE_FLOOR_DENIED.*로티/);
  assert.doesNotThrow(() => assertNotLiveRottie({KADAN_HOME: other, KADAN_ALLOW_FAKE_ROTTIE: '1'}, defaultHome));
  assert.doesNotThrow(() => assertNotLiveRottie({KADAN_HOME: other, KADAN_ALLOW_LIVE_FLOOR: '1'}, defaultHome));
  assert.match(liveFloorReason({KADAN_HOME: other, KADAN_ALLOW_FAKE_ROTTIE: '1'}, defaultHome) ?? '', /KADAN_SOCKET/);
});

test('로티 바닥 실행(runRottie)은 기본 아닌 홈이면 로티 실행 파일을 띄우지 않는다', () => {
  const marker = path.join(tmp, 'rottie-ran.txt');
  const fake = path.join(tmp, 'fake-rottie');
  fs.writeFileSync(fake, `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\necho '{"ok":true,"result":{"terminals":[]}}'\n`, {mode: 0o755});
  const base = {PATH: process.env.PATH, HOME: process.env.HOME, KADAN_HOME: other, KADAN_SOCKET: 'iso-r', KADAN_FLOOR: 'rottie', KADAN_ROTTIE_BIN: fake, KADAN_NOTIFY: 'off'};
  const script = `import {rottieFloor} from ${JSON.stringify(new URL('../src/floor-rottie.mjs', import.meta.url).href)};
    try { rottieFloor.create({session: 'kadan-x', role: 'x', cwd: '/tmp', cmd: 'cat'}); console.log('RAN'); } catch (e) { console.log('ERR ' + e.message); }`;
  const run = extra => spawnSync(process.execPath, ['--input-type=module', '-e', script], {env: {...base, ...extra}, encoding: 'utf8'});
  const denied = run({});
  assert.match(denied.stdout + denied.stderr, /KADAN_LIVE_FLOOR_DENIED/, denied.stdout + denied.stderr);
  assert.ok(!fs.existsSync(marker), '로티 실행 파일이 불렸다');
  run({KADAN_ALLOW_FAKE_ROTTIE: '1'});
  assert.ok(fs.existsSync(marker), '시험 전용 허용에서는 가짜 로티가 불려야 한다');
});
