// 중계가 남기는 세션 옵션 @kadan_human_input(epoch 초)을 사람 입력 판정에 합산한다. 격리 tmux 소켓으로 실측한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {notificationHold, sendTmux} from '../src/floor-tmux.mjs';

const hasTmux = spawnSync('tmux', ['-V']).status === 0;
const GUARD = {humanIdleMs: 30_000};

function fixture(t) {
  const socket = `kadan-test-human-input-${randomUUID()}`;
  const session = 'kadan-human-input';
  const tmuxRun = (args, input) => {
    const result = spawnSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], {encoding: 'utf8', input, timeout: 5000});
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  t.after(() => spawnSync('tmux', ['-L', socket, 'kill-server']));
  tmuxRun(['new-session', '-d', '-s', session, 'cat']);
  const setOption = value => tmuxRun(['set-option', '-t', `=${session}:`, '@kadan_human_input', String(value)]);
  const nowSec = () => Math.floor(Date.now() / 1000);
  return {session, run: tmuxRun, setOption, nowSec};
}

test('(1) 옵션이 없으면 오늘과 같다: 보류하지 않는다', {skip: !hasTmux}, t => {
  const f = fixture(t);
  assert.equal(notificationHold(f.session, GUARD, {run: f.run}), null);
});

test('(2) 옵션이 지금이면 보류한다: 알림 확인과 일반 우편 전송 모두', {skip: !hasTmux}, t => {
  const f = fixture(t);
  f.setOption(f.nowSec());
  assert.equal(notificationHold(f.session, GUARD, {run: f.run})?.code, 'KADAN_HUMAN_ACTIVE');
  assert.throws(() => sendTmux(f.session, '본문', {run: f.run, spawn: () => {}}),
    error => error.code === 'KADAN_HUMAN_ACTIVE' && error.delivery === 'not-sent');
});

test('(3) 옵션이 31초 전이면 보류하지 않는다', {skip: !hasTmux}, t => {
  const f = fixture(t);
  f.setOption(f.nowSec() - 31);
  assert.equal(notificationHold(f.session, GUARD, {run: f.run}), null);
});

test('(4) 숫자가 아니거나 미래 값이면 무시한다', {skip: !hasTmux}, t => {
  const f = fixture(t);
  for (const value of ['abc', '12abc', '-5', '1.5', '', f.nowSec() + 120, f.nowSec() + 100000]) {
    f.setOption(value);
    assert.equal(notificationHold(f.session, GUARD, {run: f.run}), null, `무시해야 함: ${JSON.stringify(value)}`);
  }
});

test('시계가 조금(60초 이내) 앞선 값은 사람 입력으로 본다', {skip: !hasTmux}, t => {
  const f = fixture(t);
  f.setOption(f.nowSec() + 30);
  assert.equal(notificationHold(f.session, GUARD, {run: f.run})?.code, 'KADAN_HUMAN_ACTIVE');
});

test('강제 차례(force)는 옵션이 있어도 건너뛴다', {skip: !hasTmux}, t => {
  const f = fixture(t);
  f.setOption(f.nowSec());
  assert.equal(notificationHold(f.session, {...GUARD, force: true}, {run: f.run}), null);
});
