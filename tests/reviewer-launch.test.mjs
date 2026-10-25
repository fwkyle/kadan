import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {reviewerLaunch} from '../src/reviewer-launch.mjs';
import {DEFAULT_FAMILIES} from '../src/runner-settings.mjs';
import {readLedger} from '../src/ledger.mjs';

const models = ['gpt-6-astra', 'gpt-6.1-sol', 'command-code/deepseek-test', 'claude-test'];
const choice = model => ({runner: 'codex', model});
const settings = () => ({version: 1, revision: 1, activePreset: 'A', families: DEFAULT_FAMILIES,
  runners: {codex: {spawn: 'codex --model {model}', models: models.map(model => ({model, efforts: []}))}},
  presets: {A: {roles: {worker: choice(models[0]), reviewer: choice(models[1])},
    fallback: {reviewer: [choice(models[2]), choice(models[3])]}}}});
const start = (cmd, pid = '41') => ({kind: 'start', session: 'kadan-test-worker', panePid: pid, cmd});
const select = (s = settings(), entries = [start('codex --model gpt-6-astra')], currentPid = '41') =>
  reviewerLaunch({settings: s, entries, workerRole: 'test-worker', workerSession: 'kadan-test-worker', currentPid});

test('실제 작업자가 astra면 gpt 검수자를 건너뛰고 첫 다른 계열 deepseek를 고른다', () => {
  const got = select();
  assert.equal(got.model, models[2]); assert.equal(got.fallbackIndex, 1);
  assert.equal(got.reviewFor.family, 'gpt'); assert.equal(got.reviewFor.reviewerFamily, 'deepseek');
  assert.match(got.reviewFor.skipped[0], /같은 계열/);
  const s = settings(); s.presets.A.roles.reviewer = choice(models[3]);
  s.presets.A.fallback.reviewer.push({runner: 'missing', model: 'unknown'});
  assert.equal(select(s).fallbackIndex, undefined);
});

test('cmd 빈 재사용 start를 무시하고 마지막 stop 이후 현재 PID의 실제 명령만 읽는다', () => {
  const entries = [start('codex --model claude-test'), {kind: 'stop', session: 'kadan-test-worker'},
    start('codex --model claude-test', '99'), start('codex --model gpt-6-astra'), start(undefined)];
  assert.equal(select(settings(), entries).reviewFor.model, models[0]);
  assert.throws(() => select(settings(), entries, '100'), /실행 모델 확인 실패/);
  assert.throws(() => select(settings(), [...entries, {kind: 'stop', session: 'kadan-test-worker'}]), /확인 실패/);
  assert.throws(() => select(settings(), [start('codex --model mystery')]), /계열을 모른다/);
});

test('모든 후보가 같은 계열·차단·미등록이면 시작 거절, 유효한 뒤 후보는 선택한다', () => {
  const s = settings();
  s.blocked = [{model: models[2], roles: ['reviewer'], reason: '시험 차단'}];
  assert.equal(select(s).model, models[3]);
  s.presets.A.fallback.reviewer.pop();
  assert.throws(() => select(s), /다른 계열 검수자 없음/);
  s.presets.A.fallback.reviewer = [];
  assert.throws(() => select(s), /다른 계열 검수자 없음/);
});

test('실제 CLI --for: 가짜 실행기·격리 소켓에서 선택 기록, 무옵션 유지, 실패 시 세션 생성 없음', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-for-'));
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexec sleep 60\n', {mode: 0o755});
  const file = path.join(home, 'runner-settings.json');
  const config = settings(); fs.writeFileSync(file, JSON.stringify(config));
  const socket = `review-for-${process.pid}-${Date.now()}`;
  const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, KADAN_HOME: home,
    KADAN_SOCKET: socket, KADAN_FLOOR: 'tmux', KADAN_WINDOW: 'none'};
  const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], {env, encoding: 'utf8', timeout: 15000});
  const ok = (...args) => { const p = run(...args); assert.equal(p.status, 0, p.stderr); return p; };
  const args = role => ['start', role, '--hidden', '--no-prompt', '--profile', 'reviewer'];
  try {
    ok('start', 'test-worker', '--hidden', '--no-prompt', '--profile', 'worker');
    ok('start', 'test-worker', '--hidden', '--no-prompt', '--profile', 'worker');
    ok(...args('test-reviewer'), '--for', 'test-worker');
    const event = readLedger(home).findLast(e => e.kind === 'start' && e.role === 'test-reviewer');
    assert.equal(event.model, models[2]); assert.equal(event.fallbackIndex, 1);
    assert.equal(event.launchSource, 'review-for'); assert.equal(event.reviewFor.model, models[0]);
    assert.match(event.fallbackReason, /다른 계열/);
    ok(...args('test-default'));
    assert.equal(readLedger(home).findLast(e => e.role === 'test-default' && e.kind === 'start').model, models[1]);
    for (const extra of [['--for'], ['--for', 'absent'], ['--for', 'test-worker', '--cmd', 'cat'],
      ['--for', 'test-worker', '--fallback', '1']]) {
      assert.notEqual(run(...args('test-refused'), ...extra).status, 0);
    }
    assert.notEqual(run(...args('test-reviewer'), '--for', 'test-worker').status, 0, '재사용 거절');
    config.presets.A.fallback.reviewer = [];
    fs.writeFileSync(file, JSON.stringify(config));
    const failed = run(...args('test-refused'), '--for', 'test-worker');
    assert.notEqual(failed.status, 0); assert.match(failed.stderr, /다른 계열 검수자 없음/);
    assert.equal(readLedger(home).some(e => e.kind === 'start' && e.role === 'test-refused'), false);
    assert.notEqual(spawnSync('tmux', ['-L', socket, 'has-session', '-t', '=kadan-test-refused'], {env}).status, 0);
  } finally { spawnSync('tmux', ['-L', socket, 'kill-server'], {env}); }
});
