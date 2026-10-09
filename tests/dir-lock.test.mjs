import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {acquireDirLock, waitDirUnlocked} from '../src/dir-lock.mjs';
import {readSystemLedger} from '../src/ledger.mjs';

// 2026-10-08: JSONL 잠금을 즉시 포기해 동시에 띄운 작업자 일부가 시작 기록 없이 세션만 남았다.
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
// 다른 프로세스가 잠금을 잡고 있다가 ms 뒤에 놓는다(같은 프로세스는 동기 대기 중이라 타이머가 돌지 않는다).
const holdFor = (lock, ms) => { fs.mkdirSync(lock); return spawn(process.execPath, ['-e', `setTimeout(()=>require('fs').renameSync(${JSON.stringify(lock)},${JSON.stringify(lock + '-released')}),${ms})`]); };

test('잠금이 곧 풀리면 기다렸다가 얻고, 풀리지 않으면 예산 뒤 실패한다(멈춘 잠금은 지우지 않는다)', async () => {
  const dir = tmp('kadan-dirlock-'), lock = path.join(dir, '.lock');
  const child = holdFor(lock, 300);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(acquireDirLock(lock, {waitMs: 3000}), true);
  await new Promise(r => child.on('exit', r));
  assert.equal(acquireDirLock(lock, {waitMs: 100}), false, '아무도 놓지 않으면 실패');
  assert.ok(fs.existsSync(lock), '멈춘 잠금은 그대로 둔다');
  assert.equal(waitDirUnlocked(lock, {waitMs: 100}), false);
  assert.equal(waitDirUnlocked(path.join(dir, 'none'), {waitMs: 100}), true);
});

test('JSONL 저장소에서 같은 상위가 작업자를 동시에 띄워도 모두 시작 기록이 남는다', {skip: spawnSync('tmux', ['-V']).status !== 0}, async () => {
  const home = tmp('kadan-start-race-'), socket = `kadan-race-${process.pid}`, cli = new URL('../src/cli.mjs', import.meta.url).pathname;
  const env = {...process.env, KADAN_HOME: home, KADAN_SOCKET: socket, KADAN_FLOOR: 'tmux', KADAN_WINDOW: 'none'};
  delete env.KADAN_ROLE;
  const run = (args, role) => new Promise(resolve => {
    const child = spawn(process.execPath, [cli, ...args], {env: role ? {...env, KADAN_ROLE: role} : env});
    let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
    child.on('exit', code => resolve({code, out}));
  });
  try {
    assert.equal((await run(['start', 'race-boss', '--hidden', '--cmd', 'sh'])).code, 0);
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map(i => run(['start', `race-w${i}`, '--hidden', '--cmd', 'sh'], 'race-boss')));
    assert.deepEqual(results.filter(r => r.code !== 0).map(r => r.out), []);
    const starts = readSystemLedger(home).filter(e => e.kind === 'start').map(e => e.role).sort();
    assert.deepEqual(starts, ['race-boss', ...[1, 2, 3, 4, 5, 6].map(i => `race-w${i}`)].sort());
  } finally {
    spawnSync('tmux', ['-L', socket, 'kill-server']);
  }
});
