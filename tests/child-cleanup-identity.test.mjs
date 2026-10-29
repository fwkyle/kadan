import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {markedChildren, signalChild} from './helpers/child-cleanup.mjs';

test('정리: PID 재사용·종료·표지 소실·조회 실패에는 신호를 보내지 않는다', t => {
  const marker = 'KADAN_TEST_OWNER_fixture';
  const initial = `999999999 Thu Oct 29 10:00:00 2026 node fixture ${marker}=1`;
  let stdout = initial, status = 0;
  const calls = [];
  const ps = cp.spawnSync, kill = process.kill;
  t.after(() => { cp.spawnSync = ps; process.kill = kill; syncBuiltinESMExports(); });
  cp.spawnSync = () => ({status, stdout});
  process.kill = (pid, signal) => { calls.push({pid, signal}); return true; };
  syncBuiltinESMExports();

  const [row] = markedChildren(marker);
  assert.equal(signalChild(row, marker, 'SIGTERM'), true);
  stdout = initial.replace('10:00:00', '10:00:01');
  assert.equal(signalChild(row, marker, 'SIGKILL'), false, '같은 명령·표지여도 시작 시각 변경');
  stdout = initial.replace('node fixture', 'node unrelated');
  assert.equal(signalChild(row, marker, 'SIGKILL'), false, '명령 변경');
  stdout = initial.replace(`${marker}=1`, 'OTHER=1');
  assert.equal(signalChild(row, marker, 'SIGKILL'), false, '표지 소실');
  stdout = ''; status = 1;
  assert.equal(signalChild(row, marker, 'SIGKILL'), false, '이미 종료');
  status = 2;
  assert.throws(() => signalChild(row, marker, 'SIGKILL'), /신원 조회 실패/);
  status = 0; stdout = '999999999 unparseable';
  assert.equal(signalChild(row, marker, 'SIGKILL'), false, '해석 불가');
  stdout = `${initial}\n888888888 Thu Oct 29 10:00:00 2026 node OTHER=1`;
  assert.equal(markedChildren(marker).length, 1, '무관한 프로세스 제외');
  assert.equal(signalChild(row, marker, 'SIGKILL'), true, '같은 프로세스는 KILL 허용');
  assert.deepEqual(calls, [
    {pid: 999999999, signal: 'SIGTERM'}, {pid: 999999999, signal: 'SIGKILL'},
  ]);
  assert.ok(calls.every(call => call.pid > 0), '그룹 전체 신호 없음');
});
