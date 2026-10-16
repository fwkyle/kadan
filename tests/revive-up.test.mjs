import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawnSync} from 'node:child_process';
import {startFakeDiscord, FAKE} from './helpers/fake-discord-api.mjs';
import {readLedger} from '../src/ledger.mjs';

// 격리 tmux 소켓·격리 KADAN_HOME·가짜 디코 API. 맥 알림은 PATH 앞의 가짜 osascript가 받아 파일에 적는다(실제 알림 0).
const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('격리 tmux: kadan up --auto가 꺼진 기반 프로세스만 되살리고, 멈춤·상한·죽은 창을 처리한다', async (t) => {
  if (spawnSync('tmux', ['-V']).status !== 0) return t.skip('tmux 없음');
  const fake = await startFakeDiscord();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-revive-up-'));
  const home = path.join(root, 'home'), bin = path.join(root, 'bin'), notices = path.join(root, 'notices.log');
  fs.mkdirSync(home); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'osascript'), `#!/bin/sh\necho "$@" >> '${notices}'\n`, {mode: 0o755});
  const socket = `kadan-revive-${process.pid}`;
  const port = await new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const botFile = path.join(root, 'bot.env'), hookFile = path.join(root, 'hook.env');
  fs.writeFileSync(botFile, `DISCORD_BOT_TOKEN=${FAKE.token}\nDISCORD_APPLICATION_ID=${FAKE.appId}\n`, {mode: 0o600});
  fs.writeFileSync(hookFile, `DISCORD_USER_ID=${FAKE.userId}\nDISCORD_WEBHOOK_URL_SECRETARY=https://discord.com/api/webhooks/${FAKE.hookId}/${FAKE.hookToken}\n`, {mode: 0o600});
  const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, KADAN_HOME: home, KADAN_SOCKET: socket, KADAN_FLOOR: 'tmux',
    KADAN_WINDOW: 'none', KADAN_NOTIFY: 'off', KADAN_DISCORD_API_BASE: fake.base,
    KADAN_SECRET_DISCORD_BOT_FILE: botFile, KADAN_SECRET_DISCORD_FILE: hookFile};
  const kadan = (...args) => spawnSync(process.execPath, [CLI, ...args], {env, encoding: 'utf8', timeout: 60000});
  const up = (...extra) => kadan('up', '--cmd', 'sh', '--port', String(port), '--hidden', '--no-prompt', ...extra);
  const tmux = (...args) => spawnSync('tmux', ['-u', '-L', socket, ...args], {encoding: 'utf8'});
  const sessions = () => tmux('list-sessions', '-F', '#{session_name}').stdout.split('\n').filter(Boolean).sort();
  const revives = () => readLedger(home).filter(e => e.kind === 'revive');
  const noticeCount = () => (fs.existsSync(notices) ? fs.readFileSync(notices, 'utf8').split('\n').filter(Boolean).length : 0);
  const paneOf = session => tmux('display-message', '-p', '-t', `=${session}:`, '#{pane_pid}').stdout.trim();
  const reviveState = () => JSON.parse(fs.readFileSync(path.join(home, 'revive-state.json'), 'utf8'));
  const waitFor = async (check, label) => { for (let i = 0; i < 60; i++) { if (check()) return; await sleep(250); } assert.fail(`시간 안에 안 됨: ${label}`); };

  // 잠금 주인이 살아 있어야 새 다리가 떴다고 본다(SIGKILL로 죽은 다리의 낡은 잠금 파일은 남는다).
  const lockAlive = () => { try { process.kill(Number(fs.readFileSync(path.join(home, 'discord-chat.lock', 'pid'), 'utf8')), 0); return true; } catch { return false; } };
  // 다리 프로세스(잠금을 쥔 node)를 직접 죽인다. 껍데기만 죽이면 리눅스에서는 자식이 남아 잠금을 쥔다.
  const killBridge = async () => {
    const lockPid = Number(fs.readFileSync(path.join(home, 'discord-chat.lock', 'pid'), 'utf8'));
    process.kill(lockPid, 'SIGKILL');
    await waitFor(() => tmux('display-message', '-p', '-t', '=kadan-디코:', '#{pane_dead}').stdout.trim() === '1', 'pane 죽음');
  };
  try {
    // 1) 모두 없음 → 자동이 비서·대시보드·다리를 띄운다(감시 프로필 없음 → 감시기는 대상 아님)
    const first = up('--auto');
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.deepEqual(sessions(), ['kadan-대시보드', 'kadan-디코', 'kadan-비서']);
    assert.match(first.stdout, /디코 다리: 다시 띄움\(이번 1시간 1번째\)/);
    assert.equal(noticeCount(), 0, '조용한 알림은 디코로만 간다 — 디코 설정이 없는 격리 환경에서도 맥 알림 0건');
    await waitFor(lockAlive, '다리 잠금');

    // 2) 다 살아 있으면 아무것도 안 한다(출력·알림·세션 변화 0)
    const idle = up('--auto');
    assert.equal(idle.status, 0);
    assert.equal(idle.stdout.trim(), '', `살아 있으면 로그가 없다: ${idle.stdout}`);
    assert.equal(noticeCount(), 0);

    // 3) 다리 프로세스가 죽어 창만 남은 경우(remain-on-exit) → 화면 저장 → 정리 → 재생성
    await killBridge();
    const revived = up('--auto');
    assert.match(revived.stdout, /프로세스가 죽은 창을 치웠습니다\(마지막 화면 .*revive\/디코-/);
    assert.match(revived.stdout, /디코 다리: 다시 띄움\(이번 1시간 2번째\)/);
    assert.ok(fs.readdirSync(path.join(home, 'revive')).some(f => f.startsWith('디코-')));
    assert.ok(sessions().includes('kadan-디코'));
    await waitFor(lockAlive, '다리 잠금(재생성)');
    assert.equal(noticeCount(), 0);

    // 4) 사람이 kadan stop 디코 → 자동이 건너뛴다. 명시 up은 멈춤을 풀고 다시 띄운다
    assert.equal(kadan('stop', '디코').status, 0);
    assert.equal(reviveState().targets.디코.state, 'stopped');
    const skipped = up('--auto');
    assert.equal(skipped.stdout.trim(), '');
    assert.ok(!sessions().includes('kadan-디코'), '멈춤 상태의 다리는 되살리지 않는다');
    const manual = up();
    assert.match(manual.stdout, /디코 다리 시작됨/);
    assert.ok(sessions().includes('kadan-디코'));
    assert.deepEqual(reviveState().targets, {}, '명시 up이 멈춤을 푼다');
    await waitFor(lockAlive, '다리 잠금(명시 up)');

    // 5) revive 사건은 대상마다 남고(by autostart), 다리·감시기는 start 사건으로 기록되지 않는다
    const kinds = revives();
    assert.ok(kinds.every(e => e.notice === 'none'), '디코로 못 보낸 조용한 알림은 사건에 남는다');
    assert.deepEqual(kinds.map(e => [e.target, e.result, e.by]), [['비서', 'started', 'autostart'], ['대시보드', 'started', 'autostart'], ['디코', 'started', 'autostart'], ['디코', 'started', 'autostart']]);
    assert.equal(kinds.at(-1).reason, 'pane 죽음');
    assert.match(kinds.at(-1).screenPath, /revive\/디코-/);
    assert.equal(readLedger(home).some(e => e.kind === 'start' && (e.session === 'kadan-디코' || e.session === 'kadan-watch')), false);
    assert.equal(readLedger(home).filter(e => e.kind === 'start').map(e => e.role).sort().join(), '대시보드,비서');

    // 6) 1시간에 3번 넘게 죽으면 4번째는 안 띄우고 멈춤 상태가 된다(다음 회차에도 그대로, 알림 추가 없음)
    await killBridge(); // 명시 up은 횟수에 안 들어간다 → 자동 되살림 1번째
    assert.match(up('--auto').stdout, /이번 1시간 1번째/);
    await waitFor(lockAlive, '다리 잠금');
    await killBridge();
    assert.match(up('--auto').stdout, /이번 1시간 2번째/);
    await waitFor(lockAlive, '다리 잠금');
    await killBridge();
    assert.match(up('--auto').stdout, /이번 1시간 3번째/);
    await waitFor(lockAlive, '다리 잠금');
    await killBridge();
    const before = noticeCount();
    const capped = up('--auto');
    assert.match(capped.stdout, /디코 다리: 1시간 3번 상한 — 멈춤/);
    assert.equal(reviveState().targets.디코.state, 'capped');
    assert.equal(revives().at(-1).result, 'capped');
    assert.equal(noticeCount(), before + 1, '상한 알림 1건');
    const again = up('--auto');
    assert.equal(again.stdout.trim(), '', '멈춤 상태는 조용히 건너뛴다');
    assert.equal(noticeCount(), before + 1);
    assert.equal(up().status, 0, '사람이 친 up이 푼다');
    assert.deepEqual(reviveState().targets, {});
  } finally {
    tmux('kill-server');
    await fake.close();
  }
});
