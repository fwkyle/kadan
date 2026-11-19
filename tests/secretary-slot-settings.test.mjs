// 실행 모델 설정의 비서 자리(roles.secretary): 저장·보기·내보내기·대시보드 응답·화면 저장.
// 다시 열 때의 동작은 tests/secretary-runner-setting.test.mjs가 본다. 모델 이름은 모두 가짜다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createWallServer} from '../src/wall.mjs';
import {DEFAULT_FAMILIES, OPTIONAL_ROLES, PROFILE_ROLES, SETTINGS_ROLES, launchFor, readSettings} from '../src/runner-settings.mjs';
import {runnersData} from '../src/dashboard/settings.mjs';
import {RUNNER_ROLE_LABELS} from '../src/runner-settings-wall.mjs';
import {secretaryCommandLabel} from '../src/secretary-settings.mjs';
import {replaceModelOptions} from '../src/codex-option-merge.mjs';
import {readLedger} from '../src/ledger.mjs';

const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
const SOL = {runner: 'codex', model: 'gpt-6-sol', effort: 'medium'};

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-secretary-slot-'));
  fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify({version: 1, revision: 1, activePreset: 'A',
    families: DEFAULT_FAMILIES, blocked: [],
    runners: {
      codex: {spawn: 'codex --model {model} -c model_reasoning_effort="{effort}"',
        models: ['gpt-6-luna', 'gpt-6-sol'].map(model => ({model, efforts: ['medium', 'high']}))},
      devin: {spawn: 'devin --model {model}', models: [{model: 'swe-test', efforts: []}]},
    },
    presets: {A: {label: '시험', roles: {worker: {runner: 'codex', model: 'gpt-6-luna', effort: 'high'}}}}}));
  return home;
}

function runner(home) {
  const env = {...process.env, KADAN_HOME: home, KADAN_ROLE: '시험-슈퍼'};
  delete env.KADAN_LITE_HOME;
  const run = (...args) => spawnSync(process.execPath, [cli, 'runners', ...args], {env, encoding: 'utf8', timeout: 15000});
  const ok = (...args) => { const p = run(...args); assert.equal(p.status, 0, p.stderr); return p.stdout; };
  return {run, ok, show: () => JSON.parse(ok('show'))};
}

test('비서는 설정의 자리이지만 start --profile 대상도 기본 채우기 대상도 아니다', () => {
  assert.ok(SETTINGS_ROLES.includes('secretary'));
  assert.deepEqual(OPTIONAL_ROLES, ['worker-hard', 'secretary']);
  assert.equal(Object.hasOwn(PROFILE_ROLES, 'secretary'), false);
  assert.equal(RUNNER_ROLE_LABELS.secretary, '비서');
  assert.equal(Object.keys(RUNNER_ROLE_LABELS).at(-1), 'secretary', '표의 맨 아래 줄');
  const home = makeHome();
  runner(home).ok('set', 'secretary', '--runner', 'codex', '--model', 'gpt-6-sol', '--effort', 'medium', '--revision', '1', '--reason', '시험');
  assert.equal(launchFor(readSettings(home), 'secretary'), null, '띄우는 명령은 만들지 않는다');
});

test('kadan runners set secretary: 저장하면 show·내보내기·대시보드 응답에 보이고, 비우면 사라진다', () => {
  const home = makeHome(), r = runner(home);
  const url = new URL('http://local/api/dashboard/runners');
  const before = r.show();
  assert.equal('secretary' in before.roles, false);
  assert.equal(before.launch.secretary, '비어 있음 — 저장된 명령 그대로 다시 연다');
  const empty = runnersData({home, entries: []}, url, {});
  assert.equal(empty.roles.secretary, '비서');
  assert.equal(empty.commands.secretary, '비어 있음 — 저장된 명령 그대로 다시 연다');
  assert.deepEqual(empty.secretary, {runner: 'codex'});

  r.ok('set', 'secretary', '--runner', 'codex', '--model', 'gpt-6-sol', '--effort', 'medium', '--revision', '1', '--reason', '비서 모델');
  const shown = r.show();
  assert.deepEqual(shown.roles.secretary, SOL);
  assert.match(shown.launch.secretary, /--model gpt-6-sol -c model_reasoning_effort="medium"$/);
  assert.equal(shown.launch.worker, before.launch.worker, '다른 역할의 명령은 그대로다');
  const filled = runnersData({home, entries: readLedger(home)}, url, {});
  assert.deepEqual(filled.settings.presets.A.roles.secretary, SOL);
  assert.equal(filled.commands.secretary, shown.launch.secretary);
  const exported = JSON.parse(r.ok('export', 'A'));
  assert.deepEqual(exported.preset.roles.secretary, SOL);
  const event = readLedger(home).findLast(e => e.kind === 'runner-settings');
  assert.deepEqual([event.action, event.role, event.before, event.after], ['set', 'secretary', null, SOL]);

  r.ok('set', 'secretary', '--clear', '--revision', '2', '--reason', '비움');
  const cleared = r.show();
  assert.equal('secretary' in cleared.roles, false);
  assert.equal(cleared.launch.secretary, before.launch.secretary);
  assert.equal(runnersData({home, entries: []}, url, {}).commands.secretary, empty.commands.secretary);
  assert.equal('secretary' in JSON.parse(r.ok('export', 'A')).preset.roles, false);
  assert.match(r.run('set', 'secretary', '--clear', '--revision', '3', '--reason', '또 비움').stderr, /바뀐 것 없음/);
});

test('비서 자리는 codex만 받고 대체 후보·지원하지 않는 강도를 거절한다', () => {
  const home = makeHome(), r = runner(home);
  const refused = (pattern, ...args) => {
    const p = r.run(...args);
    assert.notEqual(p.status, 0); assert.match(p.stderr, pattern);
  };
  refused(/비서 자리는 codex 실행기만/, 'set', 'secretary', '--runner', 'devin', '--model', 'swe-test', '--revision', '1', '--reason', '시험');
  refused(/지원하지 않는 강도/, 'set', 'secretary', '--runner', 'codex', '--model', 'gpt-6-sol', '--effort', 'xhigh', '--revision', '1', '--reason', '시험');
  refused(/고를 수 없는 모델/, 'set', 'secretary', '--runner', 'codex', '--model', 'gpt-nowhere', '--effort', 'high', '--revision', '1', '--reason', '시험');
  refused(/비서는 대체 후보가 없다/, 'fallback', 'secretary', '--set', 'codex:gpt-6-sol:medium', '--revision', '1', '--reason', '시험');
  assert.equal(readSettings(home).revision, 1, '거절은 설정을 바꾸지 않는다');
  assert.equal(readLedger(home).length, 0);
});

test('화면 저장(프리셋 통째): 비서 자리를 넣고 빼며, 다른 실행기·대체 후보는 거절한다', async () => {
  const home = makeHome();
  const server = createWallServer(() => ({center: null, entries: readLedger(home), tree: [], ledgerLines: 0,
    collectedAt: new Date()}), {home, cacheSec: 0});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = (await (await fetch(base)).text()).match(/name="token" value="([a-f0-9]+)"/)[1];
    const post = (preset, revision) => fetch(base + '/runners/preset-save', {method: 'POST',
      headers: {'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', origin: base},
      body: new URLSearchParams({token, preset: 'A', value: JSON.stringify(preset), revision: String(revision), reason: '화면 저장'})});
    const saved = structuredClone(readSettings(home).presets.A);
    const withSlot = {...saved, roles: {...saved.roles, secretary: SOL}};
    assert.equal((await post({...withSlot, roles: {...saved.roles, secretary: {runner: 'devin', model: 'swe-test'}}}, 1)).status, 409);
    assert.equal((await post({...withSlot, fallback: {secretary: [SOL]}}, 1)).status, 409);
    assert.equal(readSettings(home).revision, 1);
    assert.equal((await post(withSlot, 1)).status, 200);
    assert.deepEqual(readSettings(home).presets.A.roles.secretary, SOL);
    assert.equal((await post(saved, 2)).status, 200);
    assert.equal('secretary' in readSettings(home).presets.A.roles, false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('한 줄 설명: 비어 있으면 없고, codex가 아니면 적용되지 않는다고 말한다', () => {
  assert.equal(secretaryCommandLabel(undefined), null);
  assert.match(secretaryCommandLabel(SOL), /--model gpt-6-sol -c model_reasoning_effort="medium"$/);
  assert.match(secretaryCommandLabel({runner: 'codex', model: 'gpt-6-sol'}), /--model gpt-6-sol$/);
  assert.match(secretaryCommandLabel({runner: 'claude', model: 'claude-test'}), /^적용 안 됨/);
});

// 모델·강도 두 값만 바꾸는 함수. 키 판정은 중복 걷기(dedupe)와 같다.
test('replaceModelOptions: 값만 바꾸고 다른 낱말·순서·`--` 뒤는 그대로 둔다', () => {
  const to = {model: 'new', effort: 'medium'};
  const cases = [
    [['--model', 'old', '-c', 'model_reasoning_effort="high"', '--flag'], ['--model', 'new', '-c', 'model_reasoning_effort="medium"', '--flag']],
    [['-m', 'old', '--config', 'model_reasoning_effort=high'], ['-m', 'new', '--config', 'model_reasoning_effort="medium"']],
    [['--model=old', '--config=model_reasoning_effort=high', '-c', 'approval_policy="never"'],
      ['--model=new', '--config=model_reasoning_effort="medium"', '-c', 'approval_policy="never"']],
    // 옵션이 없으면 `--` 앞 끝에 한 번만 넣는다.
    [['--flag', '--', '--model', 'prompt'], ['--flag', '--model', 'new', '-c', 'model_reasoning_effort="medium"', '--', '--model', 'prompt']],
  ];
  for (const [from, expected] of cases) {
    const result = replaceModelOptions(from, to);
    assert.deepEqual(result.args, expected);
    assert.equal(result.changed, true);
    // 다시 넣어도 더 바뀌지 않는다(한 벌).
    const again = replaceModelOptions(result.args, to);
    assert.equal(again.changed, false);
    assert.deepEqual(again.args, expected);
    assert.deepEqual(again.rest, result.rest, '두 값 말고는 그대로다');
  }
  const kept = replaceModelOptions(['--model', 'old', '-c', 'model_reasoning_effort="high"'], {model: 'new'});
  assert.deepEqual(kept.args, ['--model', 'new', '-c', 'model_reasoning_effort="high"'], '강도 값이 없으면 강도는 그대로');
  assert.deepEqual(kept.previous, {model: 'old', effort: 'high'});
  const same = replaceModelOptions(['--model', 'new', '-c', 'model_reasoning_effort=medium'], to);
  assert.equal(same.changed, false, '따옴표만 다른 같은 강도는 바꾸지 않는다');
  assert.deepEqual(same.args, ['--model', 'new', '-c', 'model_reasoning_effort=medium']);
});

test('replaceModelOptions: 자리를 하나로 읽지 못하면 바꾸지 않는다(null)', () => {
  const to = {model: 'new', effort: 'medium'};
  for (const args of [
    ['--model', 'a', '--model', 'b'],
    ['--model', 'a', '-m', 'b'],
    ['-c', 'model_reasoning_effort=low', '--config', 'model_reasoning_effort=high'],
    ['-mold'],
    ['-cmodel_reasoning_effort=high'],
    ['-c', 'model="old"'],
    ['--model'],
    ['-c', 'model_reasoning_effort'],
  ]) assert.equal(replaceModelOptions(args, to), null, JSON.stringify(args));
});
