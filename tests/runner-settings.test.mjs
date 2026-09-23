import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {blockModel, checkFamilies, initSettings, launchFor, modelFamily, readSettings, setRole, setRunner, setRunnerModel} from '../src/runner-settings.mjs';
import {readLedger} from '../src/ledger.mjs';

const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
const codexModels = [
  {slug:'xai/grok-4.7-build-fast', supported_reasoning_levels:['low','medium','high','xhigh'].map(effort=>({effort}))},
  {slug:'gpt-6-sol', supported_reasoning_levels:['low','medium','high'].map(effort=>({effort}))},
  {slug:'gpt-6-astra', supported_reasoning_levels:['low','medium'].map(effort=>({effort}))},
];
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-runner-settings-'));
  fs.writeFileSync(path.join(home, 'agent-runners.json'), JSON.stringify({runners:[
    {name:'codex', spawn:'codex -p lite --model {model} -c model_reasoning_effort="{effort}"'},
    {name:'devin', spawn:'devin --model {model} --permission-mode dangerous'},
  ]}));
  const cache = path.join(home, 'models_cache.json');
  fs.writeFileSync(cache, JSON.stringify({models:codexModels}));
  const records = [];
  const record = e => records.push(e);
  const options = {readCodexModels: () => ({models:codexModels})};
  return {home, cache, records, record, options};
}
const initialize = f => initSettings(f.home, {by:'kyle', reason:'1단계 시작', record:f.record});

test('처음 만들기는 실행기 틀만 옮기고 역할 값은 비워 두며, 이유 없이는 만들지 않는다', () => {
  const f = fixture();
  assert.throws(() => initSettings(f.home, {by:'kyle', reason:' ', record:f.record}), /이유/);
  const value = initialize(f);
  assert.equal(value.revision, 1);
  assert.deepEqual(Object.keys(value.runners).sort(), ['codex', 'devin']);
  assert.deepEqual(value.presets.B.roles, {});
  assert.throws(() => initialize(f), /이미 있다/);
  assert.equal(f.records.filter(e => e.kind === 'runner-settings' && e.action === 'init').length, 1);
});

test('역할 값은 목록의 모델·지원 강도만 받고, 바꾸기 전→후와 이유를 원장에 남긴다', () => {
  const f = fixture(); initialize(f);
  const set = (role, model, effort, revision, extra={}) => setRole(f.home, {role, runner:'codex', model, effort, revision, by:'kyle', reason:'kyle 결정', record:f.record, ...f.options, ...extra});
  assert.throws(() => set('worker', 'xai/grok-9', 'xhigh', 1), /고를 수 없는 모델/);
  assert.throws(() => set('reviewer', 'gpt-6-sol', 'xhigh', 1), /지원하지 않는 강도/);
  assert.throws(() => set('worker', 'xai/grok-4.7-build-fast', 'xhigh', 1, {reason:''}), /이유/);
  assert.throws(() => set('secretary', 'gpt-6-sol', 'medium', 1), /역할은/);
  set('worker', 'xai/grok-4.7-build-fast', 'xhigh', 1);
  assert.throws(() => set('reviewer', 'gpt-6-sol', 'medium', 1), /설정이 바뀌었다/);
  set('reviewer', 'gpt-6-sol', 'medium', 2);
  const last = f.records.at(-1);
  assert.equal(last.action, 'set'); assert.equal(last.role, 'reviewer'); assert.equal(last.before, null);
  assert.deepEqual(last.after, {runner:'codex', model:'gpt-6-sol', effort:'medium'});
  assert.equal(readSettings(f.home).revision, 3);
});

test('작업자와 검수자가 같은 계열이면 저장하지 않는다, 모르는 계열끼리는 막지 않는다', () => {
  const f = fixture(); initialize(f);
  setRole(f.home, {role:'worker', runner:'codex', model:'gpt-6-astra', effort:'medium', revision:1, by:'kyle', reason:'시험', record:f.record, ...f.options});
  assert.throws(() => setRole(f.home, {role:'reviewer', runner:'codex', model:'gpt-6-sol', effort:'medium', revision:2, by:'kyle', reason:'시험', record:f.record, ...f.options}), /같은 계열\(gpt\)/);
  assert.equal(modelFamily('xai/grok-4.7-build-fast'), 'grok');
  assert.equal(modelFamily('mystery-model'), null);
  assert.doesNotThrow(() => checkFamilies({worker:{model:'a-model'}, reviewer:{model:'b-model'}}));
});

test('정책으로 막은 모델은 해당 역할에서 고를 수 없다', () => {
  const f = fixture(); initialize(f);
  const file = path.join(f.home, 'runner-settings.json');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  value.blocked = [{model:'gpt-6-astra', roles:['reviewer'], reason:'astra는 검수자로 쓰지 않는다(2026-09-23 [kyle])'}];
  fs.writeFileSync(file, JSON.stringify(value));
  assert.throws(() => setRole(f.home, {role:'reviewer', runner:'codex', model:'gpt-6-astra', effort:'medium', revision:1, by:'kyle', reason:'시험', record:f.record, ...f.options}), /정책으로 막은/);
  assert.doesNotThrow(() => setRole(f.home, {role:'worker', runner:'codex', model:'gpt-6-astra', effort:'medium', revision:1, by:'kyle', reason:'시험', record:f.record, ...f.options}));
});

test('발령 명령은 활성 프리셋의 역할 값으로 실행기 틀을 채운다', () => {
  const f = fixture(); initialize(f);
  setRole(f.home, {role:'worker', runner:'codex', model:'xai/grok-4.7-build-fast', effort:'xhigh', revision:1, by:'kyle', reason:'시험', record:f.record, ...f.options});
  const launch = launchFor(readSettings(f.home), 'worker');
  assert.equal(launch.cmd, 'codex -p lite --model xai/grok-4.7-build-fast -c model_reasoning_effort="xhigh"');
  assert.equal(launch.revision, 2);
  assert.equal(launchFor(readSettings(f.home), 'reviewer'), null);
  assert.equal(launchFor(readSettings(f.home), 'secretary'), null);
  assert.equal(launchFor(null, 'worker'), null);
});

test('CLI: runners set/show와 start --profile 자동 채움·다른 명령의 이유 필수', () => {
  const f = fixture();
  const socket = `runner-settings-test-${process.pid}-${Date.now()}`;
  const env = {...process.env, KADAN_HOME:f.home, KADAN_SOCKET:socket, KADAN_FLOOR:'tmux', KADAN_WINDOW:'none', KADAN_CODEX_MODELS_CACHE:f.cache, KADAN_ROLE:'시험-슈퍼'};
  delete env.KADAN_LITE_HOME;
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], {env, encoding:'utf8', timeout:15000});
  const ok = (...args) => { const p = run(...args); assert.equal(p.status, 0, p.stderr); return p.stdout; };
  try {
    ok('runners', 'init', '--reason', '시험');
    ok('runners', 'set', 'worker', '--runner', 'codex', '--model', 'xai/grok-4.7-build-fast', '--effort', 'xhigh', '--revision', '1', '--reason', '시험');
    const shown = JSON.parse(ok('runners', 'show'));
    assert.equal(shown.launch.worker, 'codex -p lite --model xai/grok-4.7-build-fast -c model_reasoning_effort="xhigh"');
    // 다른 명령은 이유 없이 거부하고 세션을 만들지 않는다.
    const refused = run('start', 'rs-worker-a', '--hidden', '--profile', 'worker', '--cmd', 'cat');
    assert.notEqual(refused.status, 0); assert.match(refused.stderr, /--reason/);
    assert.equal(spawnSync('tmux', ['-L', socket, 'has-session', '-t', '=kadan-rs-worker-a']).status, 1);
    ok('start', 'rs-worker-b', '--hidden', '--profile', 'worker', '--cmd', 'cat', '--reason', '시험용 대체 명령');
    const ledger = readLedger(f.home);
    const start = ledger.filter(e => e.kind === 'start' && e.role === 'rs-worker-b').at(-1);
    assert.equal(start.launchSource, 'override'); assert.equal(start.overrideReason, '시험용 대체 명령');
    assert.equal(start.settingsCmd, shown.launch.worker); assert.equal(start.cmd, 'cat');
    assert.equal(ledger.filter(e => e.kind === 'runner-settings').length, 2);
    // --cmd 없이 역할만 주면 설정의 실행 명령으로 띄운다(가짜 실행기로 실제 세션 확인).
    const fake = path.join(f.home, 'fake-codex');
    fs.writeFileSync(fake, '#!/bin/sh\nexec sleep 30\n', {mode:0o755});
    const file = path.join(f.home, 'runner-settings.json');
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    settings.runners.codex.spawn = `${fake} --model {model} -c model_reasoning_effort="{effort}"`;
    fs.writeFileSync(file, JSON.stringify(settings));
    ok('start', 'rs-worker-c', '--hidden', '--profile', 'worker');
    const auto = readLedger(f.home).filter(e => e.kind === 'start' && e.role === 'rs-worker-c').at(-1);
    assert.equal(auto.launchSource, 'settings'); assert.equal(auto.settingsRevision, 2);
    assert.equal(auto.cmd, `${fake} --model xai/grok-4.7-build-fast -c model_reasoning_effort="xhigh"`);
    assert.equal(spawnSync('tmux', ['-L', socket, 'has-session', '-t', '=kadan-rs-worker-c']).status, 0);
  } finally {
    spawnSync('tmux', ['-L', socket, 'kill-server']);
  }
});

test('감독 자리: 실행기 틀·실측 모델을 기록으로 등록한 뒤 claude-code 래퍼 명령으로 채운다', () => {
  const f = fixture(); initialize(f);
  const meta = revision => ({revision, by:'kyle', reason:'감독도 설정으로 띄운다', record:f.record});
  const spawn = '/opt/kadan/bin/kadan-claude --model {model} --effort {effort} --dangerously-skip-permissions';
  assert.throws(() => setRunner(f.home, {runner:'claude', spawn:'claude', ...meta(1)}), /\{model\}/);
  setRunner(f.home, {runner:'claude', spawn, ...meta(1)});
  assert.throws(() => setRole(f.home, {role:'conductor', runner:'claude', model:'claude-opus-5-5', effort:'high', ...meta(2)}), /고를 수 없는 모델/);
  assert.throws(() => setRunnerModel(f.home, {runner:'codex', model:'x', efforts:'low', ...meta(2)}), /목록 파일/);
  setRunnerModel(f.home, {runner:'claude', model:'claude-opus-5-5', efforts:'low,medium,high,xhigh,max', ...meta(2)});
  assert.throws(() => setRole(f.home, {role:'super', runner:'claude', model:'claude-opus-5-5', effort:'ultra', ...meta(3)}), /지원하지 않는 강도/);
  setRole(f.home, {role:'super', runner:'claude', model:'claude-opus-5-5', effort:'high', ...meta(3)});
  assert.equal(launchFor(readSettings(f.home), 'super').cmd, '/opt/kadan/bin/kadan-claude --model claude-opus-5-5 --effort high --dangerously-skip-permissions');
  assert.deepEqual(f.records.slice(-3).map(e => e.action), ['runner', 'model', 'set']);
});

test('정책 차단은 기록으로 추가하고 역할을 비우면 모든 역할에서 막는다', () => {
  const f = fixture(); initialize(f);
  assert.throws(() => blockModel(f.home, {model:'gpt-6-astra', roles:'secretary', revision:1, by:'kyle', reason:'시험', record:f.record}), /역할은/);
  blockModel(f.home, {model:'gpt-6-astra', roles:'reviewer', revision:1, by:'kyle', reason:'astra는 검수자로 쓰지 않는다', record:f.record});
  assert.deepEqual(readSettings(f.home).blocked, [{model:'gpt-6-astra', roles:['reviewer'], reason:'astra는 검수자로 쓰지 않는다'}]);
  assert.throws(() => setRole(f.home, {role:'reviewer', runner:'codex', model:'gpt-6-astra', effort:'medium', revision:2, by:'kyle', reason:'시험', record:f.record, ...f.options}), /정책으로 막은/);
  assert.equal(f.records.at(-1).action, 'block');
});
