import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createDatabase, writeStorageMarker} from '../src/storage.mjs';
import {readLedger, readTaskLedger, readMailBody} from '../src/ledger.mjs';
import {CardStore} from '../src/card-store.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {buildWatchScope} from '../src/watch-scope.mjs';

const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
const hasTmux = spawnSync('tmux', ['-V']).status === 0;
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const rally = {rallyId: 'rally', rallyTitle: '묶음', rallyRound: '1', rallyStep: 'implementation'};

function fixture(backend = 'sqlite') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-mail-dispatch-'));
  if (backend === 'sqlite') {
    createDatabase(home);
    writeStorageMarker(home, 'sqlite');
  }
  const socket = path.basename(home);
  const env = {
    ...process.env, KADAN_HOME: home, KADAN_SOCKET: socket, KADAN_WINDOW: 'none',
    KADAN_FLOOR: 'tmux', KADAN_ROLE: '', KADAN_NOTIFY: 'off',
  };
  const call = (...args) => spawnSync(process.execPath, [cli, ...args], {
    env, cwd: home, encoding: 'utf8', input: '', timeout: 10000,
  });
  const run = (...args) => {
    const result = call(...args);
    assert.equal(result.status, 0, `${args[0]}: ${result.stderr}`);
    return result;
  };
  return {home, socket, env, call, run, store: new CardStore(home)};
}

function assign(f, id, role = 'worker') {
  const card = f.store.create({repo: 'r', id, repoPath: f.home, body: '# 지시'});
  return f.store.update(card.key, {
    status: 'assigned', role, board: 'r', scope: '시험 범위', ...rally,
  }, {revision: card.revision, note: '시험 배정'});
}

function startReceiver(f) {
  const receiver = path.join(f.home, 'codex.mjs');
  fs.writeFileSync(receiver, `
import fs from 'node:fs';
import path from 'node:path';
const prompt = () => process.stdout.write('\\x1b[2J\\x1b[H› ');
prompt();
process.stdin.on('data', data => {
  fs.appendFileSync(path.join(process.env.KADAN_HOME, 'received'), data);
  prompt();
});
fs.writeFileSync(path.join(process.env.KADAN_HOME, 'ready'), 'ready');
`);
  const harness = path.join(f.home, 'codex');
  fs.writeFileSync(harness, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(receiver)} "$@"\n`);
  fs.chmodSync(harness, 0o755);
  f.run('start', 'worker', '--hidden', '--cmd', `${quote(harness)} --model test-model`);
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(f.home, 'ready')) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  assert.ok(fs.existsSync(path.join(f.home, 'ready')), '격리 수신기 준비 실패');
}

test('mail·dispatch는 도움말을 제공하고 잘못된 의도를 전송·기록 전에 거절한다', () => {
  const f = fixture();
  for (const command of ['mail', 'dispatch']) {
    assert.match(f.run(command, '--help').stdout, new RegExp(`kadan ${command}`));
  }
  const ledger = readLedger(f.home), tasks = readTaskLedger(f.home);
  const cases = [
    [['mail', 'worker', '--task', 'r/card', '맥락'], /mail.*--task/],
    [['mail', 'worker', '--task', '', '맥락'], /mail.*--task/],
    [['mail', 'worker', '맥락', '--task'], /mail.*--task/],
    [['dispatch', 'worker', '지시'], /dispatch.*--task/],
    [['dispatch', 'worker', '--execution', 'r/card', '지시'], /dispatch.*--task/],
    [['dispatch', 'worker', '--task', '', '지시'], /dispatch.*--task/],
    [['dispatch', 'worker', '지시', '--task'], /dispatch.*--task/],
    [['dispatch', 'worker', '--task', 'a b', '지시'], /dispatch.*--task/],
    [['dispatch', 'worker', '--task', 'a', '--task', 'b', '지시'], /dispatch.*--task/],
    [['dispatch', 'worker', '--task', 'a', '--mailbox', '지시'], /저장 우편|mailbox/],
    [['dispatch', '비서', '--task', 'a', '지시'], /저장 우편/],
    [['dispatch', 'worker', '--task', 'a', '--expect-reply', '질문'], /dispatch.*질문|답장/],
    [['dispatch', 'worker', '--task', 'a', '--reply-to', 'id', '답장'], /dispatch.*질문|답장/],
    [['dispatch', 'worker', '--task', 'a', '--reply-final', '답장'], /dispatch.*질문|답장/],
  ];
  for (const [args, error] of cases) {
    const result = f.call(...args);
    assert.notEqual(result.status, 0, args.join(' '));
    assert.match(result.stderr, error);
    assert.deepEqual(readLedger(f.home), ledger, '거절한 요청이 우편을 기록했다');
    assert.deepEqual(readTaskLedger(f.home), tasks, '거절한 요청이 작업을 기록했다');
  }
});

for (const backend of ['jsonl', 'sqlite']) {
  test(`${backend}: mail의 실행 연결은 우편이고 dispatch만 발령·감시 상태를 바꾼다`, {
    skip: !hasTmux,
  }, () => {
    const f = fixture(backend);
    try {
      startReceiver(f);
      const card = assign(f, 'current');
      const other = assign(f, 'other', 'someone-else');
      const works = new WorkStore(f.home);
      const work = works.create({
        key: 'r/work', title: '업무', goal: '결과', scope: '범위', acceptance: '확인',
        owner: 'boss', repoPath: f.home, board: 'r',
      });
      works.change(work.key, 'link', {execution: card.key, phase: 'implementation', round: 1}, {
        revision: work.revision, note: '실행 연결',
      });
      const sends = () => readLedger(f.home).filter(entry => entry.kind === 'send');
      const tasksBefore = readTaskLedger(f.home);
      f.run('mail', 'worker', '--execution', card.key, '참고 맥락');
      const first = sends().at(-1);
      assert.equal(first.taskId, undefined);
      assert.equal(first.executionKey, card.key);
      assert.equal(first.workKey, work.key);
      assert.deepEqual(readTaskLedger(f.home), tasksBefore);
      assert.match(readMailBody(first.digest, f.home), /참고 맥락/);

      f.run('dispatch', 'worker', '--task', card.key, '작업 시작');
      const dispatch = sends().at(-1);
      assert.equal(dispatch.taskId, card.id);
      assert.equal(dispatch.executionKey, card.key);
      assert.ok(readTaskLedger(f.home).some(entry => entry.mailId === dispatch.mailId));
      assert.ok(buildWatchScope(f.store.list(), readLedger(f.home)).sessions.has('kadan-worker'));
      const current = f.store.get(card.key);
      f.store.update(card.key, {activity: 'waiting'}, {
        revision: current.revision, note: '대기', noteKind: 'progress', by: 'worker',
      });
      const waitingTasks = readTaskLedger(f.home);
      for (const options of [[], ['--raw'], ['--expect-reply'], ['--mailbox']]) {
        f.run('mail', 'worker', '--execution', card.key, ...options, '대기 중 참고 맥락');
        const letter = sends().at(-1);
        assert.equal(letter.taskId, undefined);
        assert.equal(letter.executionKey, card.key);
        assert.deepEqual(readTaskLedger(f.home), waitingTasks);
        assert.equal(f.store.get(card.key).activity, 'waiting');
        assert.ok(!buildWatchScope(f.store.list(), readLedger(f.home)).sessions.has('kadan-worker'));
      }
      const beforeErrors = sends().length;
      for (const args of [
        ['dispatch', 'worker', '--task', other.key, '잘못된 담당'],
        ['dispatch', 'worker', '--task', card.key, '--execution', other.key, '서로 다른 카드'],
        ['dispatch', 'worker', '--task', 'r/missing', '없는 카드'],
        ['mail', 'worker', '--execution', 'r/missing', '없는 연결'],
      ]) {
        assert.notEqual(f.call(...args).status, 0);
        assert.equal(sends().length, beforeErrors);
        assert.deepEqual(readTaskLedger(f.home), waitingTasks);
      }
      // 기존 send의 자동 발령 추론은 호환을 위해 유지한다.
      f.run('send', 'worker', '--execution', card.key, '기존 발령');
      assert.equal(sends().at(-1).taskId, card.id);
      assert.ok(buildWatchScope(f.store.list(), readLedger(f.home)).sessions.has('kadan-worker'));
    } finally {
      spawnSync('tmux', ['-L', f.socket, 'kill-session', '-t', 'kadan-worker'], {env: f.env});
    }
  });
}
