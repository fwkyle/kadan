import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {restartDeps} from '../src/commands/restart.mjs';

// restart의 실제 창 연결(restartDeps → openStartedWindow → openWindow → buildRottieCreateArgv)이
// 마지막 start의 작업 폴더를 로티 --workspace로 넘기는지 본다. 실제 로티·tmux는 쓰지 않는다.
test('restartDeps의 창 연결은 start 작업 폴더를 로티 --workspace로 넘긴다', {skip: process.platform !== 'darwin'}, () => {
  const calls = [];
  const env = {KADAN_WINDOW: 'rottie', KADAN_ROTTIE_BIN: '/fake/rottie'};
  const deps = restartDeps(os.tmpdir(), {env, windowDeps: {
    waitForClient: () => true,
    spawnFn: (bin, argv) => {
      calls.push(argv);
      return {status: 0, stdout: argv[0] === 'status' ? JSON.stringify({ok: true}) : JSON.stringify({ok: true, result: {terminal: {id: 't1', pid: 1}}})};
    }}});
  const cwd = '/work/other-repo';
  assert.notEqual(cwd, process.cwd());
  const opened = deps.openWindow({session: 'kadan-x', role: 'x', cwd, panePid: '42'});
  assert.equal(opened.method, 'rottie');
  const create = calls.find(argv => argv[0] === 'terminal' && argv[1] === 'create');
  assert.equal(create[create.indexOf('--workspace') + 1], cwd);
});
