import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {processStartedAt} from '../src/process-tree.mjs';
import {restartDeps} from '../src/commands/restart.mjs';

test('시작 시각: ps lstart를 C 로케일로 읽고 Unix 밀리초로 반환한다', () => {
  const output = 'Tue Nov 10 11:00:00 2026';
  const actual = processStartedAt('200', (command, args, options) => {
    assert.equal(command, 'ps');
    assert.deepEqual(args, ['-o', 'lstart=', '-p', '200']);
    assert.equal(options.env.LC_ALL, 'C');
    assert.equal(options.timeout, 2000);
    return {status: 0, stdout: `  ${output}\n`};
  });
  assert.equal(actual, new Date(2026, 10, 10, 11, 0, 0).getTime());
  assert.equal(restartDeps(process.env.KADAN_HOME, {env: {KADAN_WINDOW: 'none'}}).processStartedAt,
    processStartedAt);
});

test('시작 시각: 없는 프로세스·명령 실패·시간 초과·해석 불가·잘못된 PID는 거절한다', () => {
  for (const result of [
    {status: 1, stdout: ''}, {status: null, error: new Error('timeout')},
    {status: 0, stdout: ''}, {status: 0, stdout: 'not a date'},
  ]) {
    assert.throws(() => processStartedAt('200', () => result), /시작 시각 조회 실패/);
  }
  for (const pid of ['0', '-1', '1,2', '']) {
    assert.throws(() => processStartedAt(pid, () => assert.fail('ps 호출 금지')), /시작 시각/);
  }
});
