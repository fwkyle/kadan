import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {tmuxFloor} from '../src/floor-tmux.mjs';

test('tmux 목록은 한 호출로 PID까지 읽고 조회 실패 계약을 유지한다', () => {
  const calls = [];
  const run = args => {
    calls.push(args);
    return {status: 0, stdout: 'kadan-a\t0\t123\t456\nkadan-b\t1\t124\t789\n'};
  };
  assert.deepEqual(tmuxFloor.list({run}), [
    {session: 'kadan-a', alive: true, pid: '456', attached: '0', created: 123},
    {session: 'kadan-b', alive: true, pid: '789', attached: '1', created: 124},
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'list-sessions');
  assert.ok(calls[0].at(-1).includes('#{pane_pid}'));
  const failed = () => ({status: 1, stdout: ''});
  assert.deepEqual(tmuxFloor.list({run: failed}), []);
  assert.throws(() => tmuxFloor.list({run: failed, strict: true}), /생존 상태 모름/);
});

test('실제 tmux: 현재 창·활성 pane·연결 창·한글 이름의 PID가 개별 조회와 같다', {
  skip: spawnSync('tmux', ['-V']).status !== 0,
}, t => {
  const socket = `kadan-batch-${randomUUID()}`;
  const old = process.env.KADAN_SOCKET;
  process.env.KADAN_SOCKET = socket;
  t.after(() => {
    spawnSync('tmux', ['-L', socket, 'kill-server']);
    if (old === undefined) delete process.env.KADAN_SOCKET;
    else process.env.KADAN_SOCKET = old;
  });
  const run = args => {
    const result = spawnSync('tmux', ['-u', '-L', socket, '-f', '/dev/null', ...args], {
      encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const a = 'kadan-시험', b = 'kadan-시험-peer';
  run(['new-session', '-d', '-s', a, '-n', 'first', 'cat']);
  run(['new-session', '-d', '-s', b, '-n', 'other', 'cat']);
  run(['new-window', '-t', `=${a}:`, '-n', 'second', 'cat']);
  run(['split-window', '-h', '-t', `=${a}:second`, 'cat']);
  run(['link-window', '-s', `=${a}:second`, '-t', `=${b}:9`]);
  const verify = () => {
    const listed = tmuxFloor.list({strict: true});
    assert.equal(listed.length, 2);
    for (const row of listed) {
      assert.equal(row.pid, run(['display-message', '-p', '-t', `=${row.session}:`, '#{pane_pid}']));
      assert.match(row.pid, /^\d+$/);
    }
  };
  verify();
  run(['select-window', '-t', `=${a}:first`]);
  run(['select-window', '-t', `=${b}:9`]);
  run(['select-pane', '-t', `=${b}:9.0`]);
  verify();
  run(['kill-session', '-t', `=${a}`]);
  assert.deepEqual(tmuxFloor.list({strict: true}).map(x => x.session), [b]);
  run(['kill-session', '-t', `=${b}`]);
  assert.deepEqual(tmuxFloor.list(), []);
  assert.throws(() => tmuxFloor.list({strict: true}), /생존 상태 모름/);
});
