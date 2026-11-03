// 카단 pane 안에서 물려받은 KADAN_WINDOW=none은 기계 설정이 이긴다(2026-11-03). 가짜 TMUX 값과 격리 홈만 쓰고 tmux·로티는 부르지 않는다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {adoptMachineWindow, setWindowSetting} from '../src/window-setting.mjs';
import {TMUX_CLIENT_ENV_STRIP} from '../src/floor-tmux.mjs';

const SOCKET = 'kadan-test-socket', SETTING_BIN = '/apps/setting/rottie', ENV_BIN = '/apps/env/rottie';
const pane = `/tmp/tmux-501/${SOCKET},123,0`;
const home = (setting) => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-inherit-'));
  if (setting === 'rottie') setWindowSetting(h, {window: 'rottie', rottieBin: SETTING_BIN});
  if (setting === 'none') setWindowSetting(h, {window: 'none'});
  return h;
};
const run = (env, h, socket = SOCKET) => { const warns = []; adoptMachineWindow(env, h, {socket, warn: l => warns.push(l)}); return {env, warns}; };

test('1. pane 안 + none + 설정 rottie → rottie, 로티 경로도 설정 값(env의 다른 경로 무시), 알림 한 줄', () => {
  const {env, warns} = run({TMUX: pane, KADAN_WINDOW: 'none', KADAN_ROTTIE_BIN: ENV_BIN}, home('rottie'));
  assert.equal(env.KADAN_WINDOW, 'rottie');
  assert.equal(env.KADAN_ROTTIE_BIN, SETTING_BIN);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /물려받은 KADAN_WINDOW=none 대신 기계 설정 rottie를 쓴다.*KADAN_WINDOW_FORCE=1/);
});

test('2. pane 안 + none + FORCE → none 그대로', () => {
  const {env, warns} = run({TMUX: pane, KADAN_WINDOW: 'none', KADAN_WINDOW_FORCE: '1'}, home('rottie'));
  assert.equal(env.KADAN_WINDOW, 'none');
  assert.deepEqual(warns, []);
});

test('3. pane 밖 + none → none', () => {
  assert.equal(run({KADAN_WINDOW: 'none'}, home('rottie')).env.KADAN_WINDOW, 'none');
});

test('4. pane 안이라도 다른 소켓 이름이면 none (격리 소켓 시험 보호)', () => {
  const env = {TMUX: '/tmp/tmux-501/other-socket,1,0', KADAN_WINDOW: 'none'};
  assert.equal(run(env, home('rottie')).env.KADAN_WINDOW, 'none');
});

test('5. pane 안 + env rottie + 설정 none → env rottie 그대로', () => {
  const {env} = run({TMUX: pane, KADAN_WINDOW: 'rottie', KADAN_ROTTIE_BIN: ENV_BIN}, home('none'));
  assert.equal(env.KADAN_WINDOW, 'rottie');
  assert.equal(env.KADAN_ROTTIE_BIN, ENV_BIN);
});

test('6. pane 안 + none + 설정 없음 → none / 설정이 none이어도 none', () => {
  assert.equal(run({TMUX: pane, KADAN_WINDOW: 'none'}, home(null)).env.KADAN_WINDOW, 'none');
  assert.equal(run({TMUX: pane, KADAN_WINDOW: 'none'}, home('none')).env.KADAN_WINDOW, 'none');
});

test('6b. 소켓 이름을 모르면(socket 없음) 바꾸지 않는다', () => {
  assert.equal(run({TMUX: pane, KADAN_WINDOW: 'none'}, home('rottie'), null).env.KADAN_WINDOW, 'none');
});

test('7. KADAN_WINDOW_FORCE가 tmux 클라이언트 환경 제거 목록에 있다', () => {
  assert.ok(TMUX_CLIENT_ENV_STRIP.includes('KADAN_WINDOW_FORCE'));
});

test('8. 명시 none 호출부(autostart·대시보드 켜기)는 FORCE를 같이 줘서 pane 안에서도 창 없이 뜬다', async () => {
  const {autostartPlist} = await import('../src/autostart.mjs');
  const plist = autostartPlist({node: '/n', cli: '/c.mjs', cwd: '/w', env: {PATH: '/p'}, logPath: '/l'});
  assert.match(plist, /<key>KADAN_WINDOW<\/key>\s*<string>none<\/string>/);
  assert.match(plist, /<key>KADAN_WINDOW_FORCE<\/key>\s*<string>1<\/string>/);
  const {startSecretaryDefault} = await import('../src/center-wall.mjs');
  let seen;
  await startSecretaryDefault({cli: '/c.mjs', env: {TMUX: pane}, run: async (_c, _a, opts) => { seen = opts.env; return {stdout: ''}; }});
  assert.equal(seen.KADAN_WINDOW, 'none');
  assert.equal(seen.KADAN_WINDOW_FORCE, '1');
  // 그 env로 들어온 자식은 pane 안이어도 none을 유지한다.
  assert.equal(run({...seen}, home('rottie')).env.KADAN_WINDOW, 'none');
});

// 알림 줄은 창을 고르는 명령에서만. 환경 채우기와 손상 경고는 모든 명령에서 그대로다.
const runCmd = async (command, env, h) => {
  const {adoptWindowForCommand} = await import('../src/cli.mjs');
  const warns = [];
  adoptWindowForCommand(command, env, h, {socket: SOCKET, warn: l => warns.push(l)});
  return {env, warns};
};

test('9. 창과 무관한 명령(decision·inbox·log)은 알림 줄 없이 환경만 rottie로 채운다', async () => {
  for (const command of ['decision', 'inbox', 'log']) {
    const {env, warns} = await runCmd(command, {TMUX: pane, KADAN_WINDOW: 'none'}, home('rottie'));
    assert.deepEqual(warns, [], command);
    assert.equal(env.KADAN_WINDOW, 'rottie', command);
    assert.equal(env.KADAN_ROTTIE_BIN, SETTING_BIN, command);
  }
});

test('10. 창을 고르는 명령(start·attach·restart·restore·handover·adopt·up·init·senior)은 알림 한 줄', async () => {
  const {WINDOW_NOTICE_COMMANDS} = await import('../src/cli.mjs');
  for (const command of WINDOW_NOTICE_COMMANDS) {
    const {env, warns} = await runCmd(command, {TMUX: pane, KADAN_WINDOW: 'none'}, home('rottie'));
    assert.equal(warns.length, 1, command);
    assert.equal(env.KADAN_WINDOW, 'rottie', command);
  }
  assert.deepEqual(WINDOW_NOTICE_COMMANDS.filter(c => ['decision', 'inbox', 'log', 'send', 'card'].includes(c)), []);
});

test('11. 손상 설정 경고는 창과 무관한 명령에서도, 창 명령에서도 나온다', async () => {
  for (const command of ['decision', 'start']) {
    const h = home(null);
    fs.writeFileSync(path.join(h, 'window-setting.json'), '{깨짐');
    const {warns} = await runCmd(command, {TMUX: pane, KADAN_WINDOW: ''}, h);
    assert.equal(warns.length, 1, command);
    assert.match(warns[0], /창 선택 설정 손상/);
  }
});
