import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {stopChild} from './helpers/child-cleanup.mjs';
import {cwdOwned, ownership, sweepRun} from './helpers/run-sweep.mjs';

delete process.env.TMUX;
delete process.env.TMUX_PANE;
const skipTmux = spawnSync('tmux', ['-L', `sweep-probe-${process.pid}`, '-V']).status !== 0;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async fn => {
  const end = Date.now() + 5000;
  while (!fn() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(fn(), '자식의 준비 또는 종료 확인');
};
function folders(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-boundary-')));
  const a = path.join(base, 'kadan-run-AB'), outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(a, 'child'), {recursive: true});
  fs.mkdirSync(outside);
  // 실행별 캐시 폴더는 tests/run.mjs가 자식·소켓 정리 뒤 지운다.
  return {base, a, outside};
}

test('소속 근거는 실제 cwd뿐: 명령줄·환경값·옵션·따옴표로는 종료하지 않는다', t => {
  const {a, outside} = folders(t);
  const commands = [
    `node ${a}`, `node ${a}/child/x`, `node --x=${a}/child`, `node -f${a}/child`,
    `node "'${a}/child'"`, `node "${a}/child with space"`,
    `node TMPDIR=${a}`, `node TMPDIR=${a} other`, `node TMPDIR=${a}:other`,
    `node PATH=/bin:${a}/bin`,
  ];
  for (const command of commands) {
    assert.equal(ownership({identity: command}, a, {cwd: outside}), null, command);
    assert.equal(ownership({identity: command}, a), null, command);
  }
  assert.equal(cwdOwned('relative/path', a), false);
  assert.equal(cwdOwned(path.join(a, 'missing'), a), false);
});

test('실제 프로세스: 외부 cwd·TMPDIR 경계 반례는 보존하고 A·자식·별칭 cwd만 종료한다', async t => {
  const {base, a, outside} = folders(t);
  const children = [];
  t.after(async () => { for (const child of children) await stopChild(child); });
  const start = async (label, cwd, tmpdir = outside, args = []) => {
    fs.mkdirSync(cwd, {recursive: true});
    const ready = path.join(base, `ready-${children.length}`);
    const code = `require('fs').writeFileSync(process.argv[1], 'ready'); setTimeout(() => {}, 60000);`;
    const child = spawn(process.execPath, ['-e', code, ready, ...args], {
      cwd, env: {...process.env, TMPDIR: tmpdir}, stdio: 'ignore',
    });
    children.push(child);
    await waitFor(() => fs.existsSync(ready));
    return {label, child};
  };
  const foreign = [];
  for (const suffix of ['C', ':other', '=other', ' other']) {
    foreign.push(await start(`cwd ${suffix}`, `${a}${suffix}`, `${a}${suffix}`));
  }
  foreign.push(await start('다른 경로 안의 A', path.join(outside, a), outside));
  foreign.push(await start('외부 cwd TMPDIR 공백', outside, `${a} other`));
  foreign.push(await start('외부 cwd TMPDIR 콜론', outside, `${a}:other`));
  foreign.push(await start('명령줄만 A', outside, outside, [path.join(a, 'child')]));
  const owned = [await start('A', a), await start('A/child', path.join(a, 'child'))];
  if (a.startsWith('/private/tmp/')) owned.push(await start('/tmp 별칭', a.slice('/private'.length)));
  const swept = sweepRun(a);
  for (const {label, child} of foreign) {
    assert.equal(swept.signaled.includes(child.pid), false, label);
    assert.equal(alive(child.pid), true, label);
  }
  for (const {label, child} of owned) {
    assert.ok(swept.signaled.includes(child.pid), label);
    await waitFor(() => !alive(child.pid));
  }
});

test('실제 고아 꼴: 소켓 아래 tmux·gzip/split 자식과 cwd 아래 watch를 정리한다', {skip: skipTmux}, async t => {
  const {base, a, outside} = folders(t);
  const tmuxRoot = path.join(a, 'tmux');
  fs.mkdirSync(tmuxRoot);
  const config = path.join(a, 'tmux.conf');
  fs.writeFileSync(config, 'set -g exit-empty on\n');
  const name = `sweep-${process.pid}`;
  const env = {...process.env, TMUX_TMPDIR: tmuxRoot};
  const tmux = (...args) => spawnSync('tmux', ['-u', '-L', name, ...args], {
    cwd: outside, env, encoding: 'utf8', timeout: 5000,
  });
  t.after(() => {
    console.error(`격리 소켓 kill-server: ${tmuxRoot}/tmux-${process.getuid()}/${name}`);
    tmux('kill-server');
  });
  assert.equal(tmux('-f', config, 'new-session', '-d', '-s', 'qa', 'sleep 60').status, 0);
  const server = Number(tmux('display', '-p', '#{pid}').stdout);
  const socket = tmux('display', '-p', '#{socket_path}').stdout.trim();
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const pipe = `gzip -c | split -b 1024 - ${quote(path.join(a, 'capture-'))}`;
  assert.equal(tmux('pipe-pane', '-t', 'qa', `bash -c ${quote(pipe)}`).status, 0);
  let pipePids = [];
  await waitFor(() => {
    const output = spawnSync('ps', ['-axo', 'pid=,ppid=,comm='], {encoding: 'utf8'}).stdout;
    const rows = output.trim().split('\n').map(line => line.trim().split(/\s+/));
    const descendants = new Set([server]);
    for (let i = 0; i < 4; i++) {
      for (const [pid, ppid] of rows) if (descendants.has(Number(ppid))) descendants.add(Number(pid));
    }
    pipePids = rows.filter(([pid, , cmd]) => descendants.has(Number(pid)) && /(?:gzip|split)$/.test(cmd))
      .map(([pid]) => Number(pid));
    return pipePids.length === 2;
  });
  const ready = path.join(base, 'watch-ready');
  const watch = spawn(process.execPath, ['-e',
    `process.title='kadan-watch:qa-sweep';require('fs').writeFileSync(process.argv[1],'ok');` +
    'setTimeout(() => {}, 60000);', ready], {cwd: path.join(a, 'child'), env, stdio: 'ignore'});
  t.after(() => stopChild(watch));
  await waitFor(() => fs.existsSync(ready));
  const swept = sweepRun(a);
  assert.ok(swept.sockets.includes(socket));
  assert.ok(swept.signaled.includes(watch.pid));
  for (const pid of [server, ...pipePids, watch.pid]) await waitFor(() => !alive(pid));
});

test('소켓·cwd가 밖인 tmux는 -f 설정 경로만 A여도 보존하고 시험이 직접 정리한다', {skip: skipTmux}, t => {
  const {a, outside} = folders(t);
  const socket = path.join(outside, 'tmux.sock'), config = path.join(a, 'tmux.conf');
  fs.writeFileSync(config, '');
  const tmux = (...args) => spawnSync('tmux', ['-u', '-S', socket, ...args], {
    cwd: outside, encoding: 'utf8', timeout: 5000,
  });
  t.after(() => { console.error(`격리 소켓 kill-server: ${socket}`); tmux('kill-server'); });
  assert.equal(tmux('-f', config, 'new-session', '-d', 'sleep 60').status, 0);
  const server = Number(tmux('display', '-p', '#{pid}').stdout);
  const swept = sweepRun(a);
  assert.equal(swept.signaled.includes(server), false);
  assert.equal(alive(server), true);
});
