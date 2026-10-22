// adopt 사용법 오류는 비서 우편함에 알림을 쌓지 않고, 준비 이후 실패·accept 실패는 계속 저장한다.
// 격리 홈의 자식 프로세스만 쓴다. 실제 AI·운영 소켓은 건드리지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ADOPT_USAGE, runAdopt} from '../src/adopt.mjs';
import {readMailLedger} from '../src/ledger.mjs';

const cli = new URL('../src/cli.mjs', import.meta.url).pathname;

function adopt(...args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-adopt-usage-'));
  const env = {...process.env, KADAN_HOME: home, KADAN_SOCKET: `t-${process.pid}-${Math.random().toString(36).slice(2)}`,
    KADAN_WINDOW: 'none', KADAN_NOTIFY: 'off'};
  for (const key of ['KADAN_ROLE', 'KADAN_ROTTIE_BIN', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_EFFORT']) delete env[key];
  const run = spawnSync(process.execPath, [cli, 'adopt', ...args], {env, encoding: 'utf8', timeout: 20000});
  const letters = readMailLedger(home).filter(event => event.kind === 'send' && event.role === '비서');
  return {run, letters};
}

for (const [name, args] of [
  ['인자 없음', []],
  ['--model 빠짐', ['new', '--resume', 'abc', '--harness', 'codex']],
  ['잘못된 --harness', ['new', '--resume', 'abc', '--harness', 'gemini', '--model', 'm']],
  ['잘못된 --profile', ['new', '--resume', 'abc', '--harness', 'codex', '--model', 'm', '--profile', 'x']],
]) {
  test(`adopt 사용법 오류(${name}): 종료 코드 2, 비서 우편 0개`, () => {
    const {run, letters} = adopt(...args);
    assert.equal(run.status, 2, run.stderr);
    assert.doesNotMatch(run.stdout, /비서 우편함에 확인 요청 저장/);
    assert.equal(letters.length, 0);
  });
}

test('adopt accept 실패는 지금처럼 비서 우편 1개', () => {
  const {run, letters} = adopt('accept', 'no-such-id', '--summary', '이어받은 목표');
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stdout, /비서 우편함에 확인 요청 저장/);
  assert.equal(letters.length, 1);
});

test('준비 이후 실패(첫 안내 전송 실패)는 사용법 표시 없이 인수 ID가 붙는다', () => {
  const floor = {alive: () => false, read: () => '› '};
  let caught;
  try {
    runAdopt({role: 'new', flags: {model: 'opus', resume: 'abc', harness: 'codex'}, floor,
      sessionName: role => `kadan-${role}`, start: () => {}, sleep: () => {}, log: () => {},
      prepare: () => ({id: 'adopt-1', instruction: ''}),
      send: () => { throw new Error('전송 실패'); }});
  } catch (error) { caught = error; }
  assert.equal(caught.adoptionId, 'adopt-1');
  assert.notEqual(caught.code, ADOPT_USAGE);
});
