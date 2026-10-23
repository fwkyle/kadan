import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn, spawnSync} from 'node:child_process';
import {startFakeDiscord, FAKE} from './helpers/fake-discord-api.mjs';
import {acquireReviveLock, readReviveState, STALE_LOCK_MS} from '../src/revive.mjs';

// PR #167 2라운드 검수가 격리 환경에서 재현한 세 건을 같은 모양으로 고정한다. 격리 tmux 소켓·격리 KADAN_HOME·가짜 디코 API.
// 맥 알림은 KADAN_TEST_NOTIFY_SINK 파일에 적는다(osascript는 실행되지 않는다).
const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function world(t) {
  if (spawnSync('tmux', ['-V']).status !== 0) { t.skip('tmux 없음'); return null; }
  const fake = await startFakeDiscord();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-revive-fix2-'));
  const home = path.join(root, 'home'), notices = path.join(root, 'notices.log');
  fs.mkdirSync(home);
  const socket = `kadan-fix2-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  const port = await new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const botFile = path.join(root, 'bot.env'), hookFile = path.join(root, 'hook.env');
  fs.writeFileSync(botFile, `DISCORD_BOT_TOKEN=${FAKE.token}\nDISCORD_APPLICATION_ID=${FAKE.appId}\n`, {mode: 0o600});
  fs.writeFileSync(hookFile, `DISCORD_USER_ID=${FAKE.userId}\nDISCORD_WEBHOOK_URL_SECRETARY=https://discord.com/api/webhooks/${FAKE.hookId}/${FAKE.hookToken}\n`, {mode: 0o600});
  const env = {...process.env, KADAN_HOME: home, KADAN_SOCKET: socket, KADAN_FLOOR: 'tmux',
    KADAN_WINDOW: 'none', KADAN_NOTIFY: 'off', KADAN_TEST_NOTIFY_SINK: notices, KADAN_DISCORD_API_BASE: fake.base,
    KADAN_SECRET_DISCORD_BOT_FILE: botFile, KADAN_SECRET_DISCORD_FILE: hookFile};
  const kadan = (envExtra, ...args) => spawnSync(process.execPath, [CLI, ...args], {env: {...env, ...envExtra}, encoding: 'utf8', timeout: 60000});
  const up = (...extra) => kadan({}, 'up', '--cmd', 'sh', '--port', String(port), '--hidden', '--no-prompt', ...extra);
  const tmux = (...args) => spawnSync('tmux', ['-u', '-L', socket, ...args], {encoding: 'utf8'});
  return {
    fake, root, home, env, up, tmux, kadan,
    sessions: () => tmux('list-sessions', '-F', '#{session_name}').stdout.split('\n').filter(Boolean).sort(),
    noticeCount: () => (fs.existsSync(notices) ? fs.readFileSync(notices, 'utf8').split('\n').filter(Boolean).length : 0),
    close: async () => { tmux('kill-server'); await fake.close(); },
  };
}
const waitFor = async (check, label) => { for (let i = 0; i < 80; i++) { if (check()) return; await sleep(250); } assert.fail(`시간 안에 안 됨: ${label}`); };

test('F1 화면 2개 중 하나만 죽은 다리 세션은 --auto가 지우지 않고(살아 있는 화면 보존) 막힘으로 한 번만 알린다', async (t) => {
  const w = await world(t); if (!w) return;
  try {
    // 창 0은 바로 끝나(죽은 화면 남김), 창 1은 살아 있는 화면. 활성 창은 죽은 쪽 — 첫 화면만 보면 "죽음"으로 오판한다.
    const made = w.tmux('new-session', '-d', '-s', 'kadan-디코', 'exit 0', ';', 'set-option', '-t', '=kadan-디코:', 'remain-on-exit', 'on', ';',
      'new-window', '-t', '=kadan-디코:', 'sleep 300', ';', 'select-window', '-t', '=kadan-디코:0');
    assert.equal(made.status, 0, made.stderr);
    await waitFor(() => w.tmux('list-panes', '-s', '-t', '=kadan-디코', '-F', '#{pane_dead}').stdout.trim().split('\n').sort().join() === '0,1', '창 0 죽음·창 1 살아 있음');
    assert.equal(w.tmux('display-message', '-p', '-t', '=kadan-디코:', '#{pane_dead}').stdout.trim(), '1', '활성 창은 죽은 쪽');
    for (let i = 0; i < 3; i++) {
      const run = w.up('--auto');
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.doesNotMatch(run.stdout, /프로세스가 죽은 창을 치웠습니다/);
    }
    assert.ok(w.sessions().includes('kadan-디코'), '살아 있는 화면이 있는 세션은 그대로다');
    assert.ok(w.tmux('list-panes', '-s', '-t', '=kadan-디코', '-F', '#{pane_dead}').stdout.includes('0'));
    assert.equal(fs.existsSync(path.join(w.home, 'revive')), false, '화면 저장·정리 없음');
    assert.equal(w.noticeCount(), 1, '막힘 알림(울림)은 한 번만');
  } finally { await w.close(); }
});

test('F2 끄는 도중 자동 실행이 겹쳐도 stop이 끝난 뒤 세션은 없고 상태는 stopped이며, 잠금을 못 잡으면 끄지 않고 안내한다', async (t) => {
  const w = await world(t); if (!w) return;
  try {
    const first = w.up('--auto');
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.ok(w.sessions().includes('kadan-디코'));
    await waitFor(() => fs.existsSync(path.join(w.home, 'discord-chat.lock', 'pid')), '다리 잠금');

    // 잠금이 잡혀 있는 동안(자동 실행이 도는 중) stop은 기다린다 — 자동 실행도 그 회차를 건너뛴다
    const release = acquireReviveLock(w.home);
    assert.equal(typeof release, 'function');
    const stopper = spawn(process.execPath, [CLI, 'stop', '디코'], {env: w.env, stdio: ['ignore', 'pipe', 'pipe']});
    let out = ''; stopper.stdout.on('data', d => { out += d; }); stopper.stderr.on('data', d => { out += d; });
    const closed = new Promise(res => stopper.on('close', res));
    await sleep(1500);
    assert.ok(w.sessions().includes('kadan-디코'), '잠금을 잡기 전에는 끄지 않는다(끄고 나서 자동 실행이 되살리는 틈이 없다)');
    assert.equal(w.up('--auto').stdout.trim(), '', '잠금이 잡혀 있으면 자동 실행은 이번 회차를 건너뛴다');
    release();
    assert.equal(await closed, 0, out);
    assert.ok(!w.sessions().includes('kadan-디코'));
    assert.equal(readReviveState(w.home).targets.디코.state, 'stopped');
    assert.equal(w.up('--auto').stdout.trim(), '', 'stop이 끝난 뒤 자동 실행은 되살리지 않는다');
    assert.ok(!w.sessions().includes('kadan-디코'));

    // 잠금을 못 잡으면 끄지 않고 안내한다(사람 명령을 조용히 무시하지 않는다). 표시도 남기지 않는다
    assert.equal(w.up().status, 0);
    await waitFor(() => fs.existsSync(path.join(w.home, 'discord-chat.lock', 'pid')), '다리 잠금(명시 up)');
    const hold = acquireReviveLock(w.home);
    const refused = w.kadan({KADAN_REVIVE_LOCK_WAIT_MS: '300'}, 'stop', '디코');
    hold();
    assert.notEqual(refused.status, 0);
    assert.match(refused.stdout + refused.stderr, /끄지 않았습니다/);
    assert.ok(w.sessions().includes('kadan-디코'));
    assert.equal(readReviveState(w.home).targets.디코, undefined);
  } finally { await w.close(); }
});

test('F3 pid 없는 오래된 잠금은 자동 실행이 되찾아 로그 한 줄을 남기고, 막 만든 잠금은 그대로 둔다', async (t) => {
  const w = await world(t); if (!w) return;
  try {
    const lock = path.join(w.home, 'revive.lock');
    fs.mkdirSync(lock);
    const skipped = w.up('--auto');
    assert.equal(skipped.status, 0);
    assert.equal(skipped.stdout.trim(), '', '막 만든 잠금은 주인이 있을 수 있어 이번 회차만 건너뛴다');
    assert.deepEqual(w.sessions(), []);
    const old = new Date(Date.now() - STALE_LOCK_MS - 60_000);
    fs.utimesSync(lock, old, old);
    const run = w.up('--auto');
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /낡은 revive\.lock을 되찾음: pid 파일이 없거나 깨진 채/);
    assert.ok(w.sessions().includes('kadan-비서'), '되찾은 뒤 평소대로 되살린다');
    assert.equal(fs.existsSync(lock), false, '일이 끝나면 잠금을 풀었다');
  } finally { await w.close(); }
});

test('R2-F4 구조가 틀린 상태 파일(targets:[])에서도 stop 대시보드가 멈춤 표시를 남겨 다음 up --auto가 되살리지 않는다', async (t) => {
  const w = await world(t); if (!w) return;
  try {
    assert.equal(w.up('--auto').status, 0);
    assert.ok(w.sessions().includes('kadan-대시보드'));
    fs.writeFileSync(path.join(w.home, 'revive-state.json'), '{"targets":[]}');
    const stopped = w.kadan({}, 'stop', '대시보드');
    assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
    assert.ok(!w.sessions().includes('kadan-대시보드'));
    assert.equal(readReviveState(w.home).targets.대시보드.state, 'stopped', '배열이 아닌 객체에 표시가 저장됐다');
    const auto = w.up('--auto');
    assert.equal(auto.status, 0, auto.stdout + auto.stderr);
    assert.ok(!w.sessions().includes('kadan-대시보드'), 'kyle이 끈 대시보드는 되살아나지 않는다');
    assert.ok(fs.readdirSync(path.join(w.home, '.trash')).some(f => f.startsWith('revive-state-')), '깨진 파일은 .trash로 옮겼다');
  } finally { await w.close(); }
});
