import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { autostartCommand, autostartPlist, AUTOSTART_LABEL } from '../src/autostart.mjs';

const env = { PATH: '/opt/bin:/usr/bin', KADAN_WINDOW: 'rottie', KADAN_ROTTIE_BIN: '/apps/r&d/rottie', SECRET_TOKEN: 'nope' };
const base = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-autostart-'));
  return { home: path.join(root, 'kadan'), userHome: root, cli: '/repo/src/cli.mjs', node: '/node/bin/node', cwd: '/work', env };
};

test('로그인 때와 60초마다 kadan up --hidden --auto — KeepAlive 없음, 필요한 환경만 옮김', () => {
  const plist = autostartPlist({ node: '/node/bin/node', cli: '/repo/src/cli.mjs', cwd: '/work', env, logPath: '/k/autostart.log' });
  assert.match(plist, new RegExp(`<string>${AUTOSTART_LABEL}</string>`));
  assert.match(plist, /<string>\/node\/bin\/node<\/string>\s*<string>\/repo\/src\/cli\.mjs<\/string>\s*<string>up<\/string>\s*<string>--hidden<\/string>\s*<string>--auto<\/string>/);
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/, '1분마다 up --auto');
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.doesNotMatch(plist, /KeepAlive/, 'KeepAlive 대신 주기 up이 죽은 기반 프로세스만 되살린다');
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/opt\/bin:\/usr\/bin<\/string>/);
  assert.match(plist, /<key>KADAN_WINDOW<\/key>\s*<string>none<\/string>/, '로그인 때는 로티가 없으니 창 없이 숨김(로티 설정이어도)');
  assert.match(plist, /<key>KADAN_ROTTIE_BIN<\/key>\s*<string>\/apps\/r&amp;d\/rottie<\/string>/, 'XML 특수문자를 바꾼다');
  assert.doesNotMatch(plist, /SECRET_TOKEN|nope/, '카단과 무관한 환경 변수는 옮기지 않는다');
});

test('show는 쓰지 않고, install은 없을 때만 쓰고, 같은 내용이면 그대로, 다르면 거부, remove는 .trash로 옮긴다', () => {
  const opts = base();
  const file = path.join(opts.userHome, 'Library', 'LaunchAgents', AUTOSTART_LABEL + '.plist');
  assert.equal(autostartCommand('show', opts).installed, false);
  assert.equal(fs.existsSync(file), false, 'show는 파일을 만들지 않는다');
  assert.deepEqual(autostartCommand('status', opts), { file, installed: false, current: null });
  assert.equal(autostartCommand('install', opts).changed, true);
  assert.equal(fs.readFileSync(file, 'utf8'), autostartCommand('show', opts).content);
  assert.equal(autostartCommand('install', opts).changed, false, '같은 내용 재설치는 그대로');
  assert.equal(autostartCommand('status', opts).current, true);
  assert.throws(() => autostartCommand('install', { ...opts, cwd: '/elsewhere' }), /이미 다른 내용으로 설치돼 있다/);
  assert.equal(autostartCommand('status', { ...opts, cwd: '/elsewhere' }).current, false);
  const removed = autostartCommand('remove', { ...opts, now: new Date('2026-10-06T00:00:00Z') });
  assert.equal(fs.existsSync(file), false);
  assert.ok(fs.existsSync(removed.movedTo), '지우지 않고 .trash로 옮긴다');
  assert.ok(removed.movedTo.startsWith(path.join(opts.home, '.trash')));
  assert.equal(autostartCommand('remove', opts).changed, false);
  assert.throws(() => autostartCommand('bogus', opts), /사용법/);
});

// 낡은 경로 검사: 가짜 경로만 쓴다. plist는 임시 userHome 안에 직접 쓴다.
const stalePlist = (userHome, { node, cli, rottie }) => {
  const file = path.join(userHome, 'Library', 'LaunchAgents', AUTOSTART_LABEL + '.plist');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, autostartPlist({ node, cli, cwd: '/work', env: { ...env, KADAN_ROTTIE_BIN: rottie }, logPath: '/k/autostart.log' }));
};
const touch = (dir, name) => { const p = path.join(dir, name); fs.writeFileSync(p, ''); return p; };

test('status: 경로가 모두 있으면 stale 없음, 하나라도 없으면 항목별로 알리고 다시 만드는 명령을 준다', () => {
  const opts = base();
  const bins = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-autostart-bins-'));
  const [node, cli, rottie] = ['node', 'cli.mjs', 'rottie'].map((n) => touch(bins, n));
  stalePlist(opts.userHome, { node, cli, rottie });
  assert.deepEqual(autostartCommand('status', opts).stale, []);
  for (const [key, label] of [['node', 'node'], ['cli', 'cli'], ['rottie', 'KADAN_ROTTIE_BIN']]) {
    const paths = { node, cli, rottie, [key]: path.join(bins, 'gone-' + key) };
    stalePlist(opts.userHome, paths);
    const s = autostartCommand('status', opts);
    assert.deepEqual(s.stale, [{ what: label, path: paths[key] }], `${label} 없음`);
    assert.match(s.fix, /kadan autostart remove.*kadan autostart install/s);
  }
});

test('status: plist가 없으면 stale 검사를 하지 않고, 검사는 파일을 바꾸지 않는다', () => {
  const opts = base();
  assert.equal(autostartCommand('status', opts).stale, undefined);
  stalePlist(opts.userHome, { node: '/gone/node', cli: '/gone/cli.mjs', rottie: '/gone/rottie' });
  const file = autostartCommand('status', opts).file;
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(autostartCommand('status', opts).stale.length, 3);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'status는 읽기만 한다');
});
