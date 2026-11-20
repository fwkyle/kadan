import test from 'node:test';
import assert from 'node:assert/strict';
import {checkLaunchPermissions} from '../src/adopt-process.mjs';

// 가짜 ps 실행기: 실제 프로세스를 읽지 않고 준 명령 줄만 돌려준다.
const ai = {pid: '4242'};
const psWith = args => (cmd, argv) => {
  assert.equal(cmd, 'ps');
  assert.deepEqual(argv, ['-ww', '-p', '4242', '-o', 'args=']);
  return {status: 0, stdout: `${args}\n`};
};
const check = args => () => checkLaunchPermissions(ai, psWith(args));
const REJECT = /별도 도구·설정 권한 옵션/;

test('미리 허용 목록(--allowed-tools)은 거절하지 않는다: 공백 꼴·= 꼴·낙타 표기', () => {
  for (const args of [
    'claude --allowed-tools a b',
    'claude --allowed-tools=a',
    'claude --allowedTools a',
    'claude --allowedTools=Read,Edit --model opus',
    'claude --model opus --allowed-tools Bash(git diff:*) Edit --permission-mode plan',
  ]) {
    assert.doesNotThrow(check(args), args);
  }
});

test('옵션이 없거나 원본이 없으면 통과한다', () => {
  assert.doesNotThrow(check('claude --model opus --permission-mode acceptEdits'));
  assert.doesNotThrow(() => checkLaunchPermissions(null, () => assert.fail('원본이 없으면 ps를 부르지 않는다')));
});

test('진짜 제한 옵션과 --add-dir은 지금처럼 거절한다', () => {
  for (const args of [
    'claude --disallowed-tools Bash',
    'claude --disallowedTools Bash',
    'claude --disallowedTools=Bash',
    'claude --tools Read',
    'claude --tools=Read',
    'claude --restricted',
    'claude --settings /x/settings.json',
    'claude --setting-sources user',
    'claude --add-dir /x',
    'claude --permission-prompt-tool mcp__x__y',
  ]) {
    assert.throws(check(args), REJECT, args);
  }
});

test('허용 목록과 제한 옵션이 함께 있으면 제한 쪽 때문에 거절한다', () => {
  assert.throws(check('claude --allowed-tools a --disallowed-tools b'), REJECT);
  assert.throws(check('claude --disallowedTools b --allowedTools a'), REJECT);
  assert.throws(check('claude --allowed-tools a --tools Read'), REJECT);
});

test('허용 목록 값 안에 제한 옵션 이름이 있으면 인자 경계를 알 수 없어 거절한다(의도된 보수적 동작)', () => {
  const value = 'Bash(dotnet test --settings sample.runsettings *)';
  for (const option of ['--allowed-tools', '--allowedTools']) {
    assert.throws(check(`claude ${option} ${value}`), REJECT, `${option} 공백`);
    assert.throws(check(`claude ${option}=${value}`), REJECT, `${option}=`);
  }
});

test('ps 확인에 실패하면 옵션을 모른 채 통과시키지 않는다', () => {
  assert.throws(() => checkLaunchPermissions(ai, () => ({status: 1, stdout: ''})), /확인하지 못했습니다/);
});
