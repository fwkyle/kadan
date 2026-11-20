// 새 비서의 첫 시작(kadan up이 비서를 새로 만드는 길)도 실행 모델 설정의 비서 자리(모델·강도)를 쓰는지 본다(TODO 17행).
// 같은 대화로 다시 여는 세 길은 tests/secretary-runner-setting.test.mjs가 본다. 모델 이름은 모두 가짜이고 실행기·tmux는 부르지 않는다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {runUp, SECRETARY_ROLE} from '../src/quickstart.mjs';
import {describeStartCmd} from '../src/cli-start-support.mjs';
import {DEFAULT_FAMILIES} from '../src/runner-settings.mjs';
import {freshSecretarySettings, secretaryCommandFromSettings} from '../src/secretary-settings.mjs';

const SOL = {runner: 'codex', model: 'gpt-6-sol', effort: 'medium'};
const CODEX_LISTED = {spawn: 'codex --model {model} -c model_reasoning_effort="{effort}"',
  models: ['gpt-6-luna', 'gpt-6-sol'].map(model => ({model, efforts: ['medium', 'high']}))};

// secretary: 비서 자리 값. undefined면 설정 파일을 만들지 않고, null이면 파일은 있고 자리만 비워 둔다.
function homeWith(secretary, {codex = CODEX_LISTED} = {}) {
  const home = fs.mkdtempSync(path.join(process.env.KADAN_HOME, 'qs-secretary-'));
  if (secretary !== undefined) {
    fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify({version: 1, revision: 7, activePreset: 'A',
      families: DEFAULT_FAMILIES, blocked: [], runners: {codex},
      presets: {A: {label: '시험', roles: secretary ? {secretary} : {}}}}));
  }
  return home;
}

// runUp이 새 비서를 띄우는 것만 본다. 복원할 비서가 없는 홈이라 startNew가 바로 불린다.
function up(home) {
  const started = [], logs = [];
  const floor = {name: 'fake', alive: s => started.some(x => `kadan-${x.role}` === s), attach: s => s};
  const out = runUp({home, flags: {}, floor, secretarySettings: freshSecretarySettings(home),
    start: (argv, startFlags) => started.push({role: argv[0], ...startFlags}),
    cliPath: '/repo/src/cli.mjs', sessionName: r => `kadan-${r}`, log: line => logs.push(line)});
  return {started, logs, out, secretary: started.find(x => x.role === SECRETARY_ROLE)};
}
// 실행기 명령은 kadan init이 quickstart.json에 적어 둔 값이다.
const withRunner = (home, runner) => { fs.writeFileSync(path.join(home, 'quickstart.json'), JSON.stringify({runner})); return home; };

test('비서 자리가 있으면 새 비서의 첫 시작 명령에 설정의 모델·강도가 들어가고 원장에 남길 칸이 따라간다', () => {
  const {secretary, logs} = up(withRunner(homeWith(SOL), 'codex'));
  assert.equal(secretary.cmd, `'codex' '--model' 'gpt-6-sol' '-c' 'model_reasoning_effort="medium"'`);
  assert.deepEqual(secretary.startExtra, {modelFromSettings: true, settingsRevision: 7, settingsPreset: 'A',
    runnerChoice: SOL});
  assert.equal(secretary.profile, 'secretary');
  assert.match(logs.join('\n'), /비서 실행 모델 설정 반영: gpt-6-sol · medium/);
  // 원장 start가 읽을 모델·실행기 칸도 설정값이다(따옴표 친 명령 — TODO 18행과 같은 길).
  const described = describeStartCmd(secretary.cmd);
  assert.equal(described.harness, 'codex');
  assert.equal(described.model, 'gpt-6-sol');
});

test('명령에 이미 다른 모델·강도가 있으면 두 값만 바꾸고 나머지 옵션과 순서는 그대로다', () => {
  const home = withRunner(homeWith(SOL), 'codex --model gpt-6-luna -c model_reasoning_effort="high" --search');
  const {secretary} = up(home);
  assert.equal(secretary.cmd, `'codex' '--model' 'gpt-6-sol' '-c' 'model_reasoning_effort="medium"' '--search'`);
});

test('자리가 비어 있거나 설정 파일이 없으면 명령이 글자 하나 바뀌지 않고 추가 칸도 없다', () => {
  for (const secretary of [null, undefined]) {
    for (const runner of ['codex', 'codex --model gpt-6-luna -c model_reasoning_effort="high"', '/opt/bin/claude --effort low']) {
      const {secretary: started, logs} = up(withRunner(homeWith(secretary), runner));
      assert.equal(started.cmd, runner);
      assert.equal('startExtra' in started, false);
      assert.deepEqual(logs.filter(line => /비서 실행 모델 설정/.test(line)), []);
    }
  }
});

test('설정이 깨졌거나 쓸 수 없으면 원래 명령으로 시작하고 이유를 한 번 남긴다 — 시작은 막지 않는다', () => {
  const broken = home => { fs.writeFileSync(path.join(home, 'runner-settings.json'), '{"presets": ['); return home; };
  const cases = [
    ['깨진 설정 파일', withRunner(broken(homeWith(undefined)), 'codex'), /설정 파일을 읽지 못함/, 'settings-unreadable'],
    ['실행기가 codex가 아닌 자리', withRunner(homeWith({runner: 'claude', model: 'claude-test', effort: 'high'},
      {codex: CODEX_LISTED}), 'codex'), /codex가 아님/, 'runner-differs'],
    ['목록에 없는 모델', withRunner(homeWith({...SOL, model: 'gpt-nope'}), 'codex'), /목록에 없거나/, 'choice-rejected'],
    ['지원하지 않는 강도', withRunner(homeWith({...SOL, effort: 'low'}), 'codex'), /목록에 없거나/, 'choice-rejected'],
    ['실행기 명령이 codex가 아님', withRunner(homeWith(SOL), '/opt/bin/claude --effort low'), /resume 꼴이 아니거나/, 'command-shape'],
    ['모델 옵션 자리를 하나로 읽지 못함', withRunner(homeWith(SOL), 'codex -m gpt-6-luna --model gpt-6-sol'), /하나로 읽지 못함/, 'command-shape'],
  ];
  for (const [label, home, reason, word] of cases) {
    const runner = JSON.parse(fs.readFileSync(path.join(home, 'quickstart.json'), 'utf8')).runner;
    const {secretary, logs, out} = up(home);
    assert.equal(secretary.cmd, runner, label);
    assert.deepEqual(secretary.startExtra, {modelFromSettingsSkipped: word}, label); // 이유 낱말만 원장에 남는다
    assert.equal(out.secretary, 'started', label);
    const warnings = logs.filter(line => /^경고: 비서 실행 모델 설정을 적용하지 못해/.test(line));
    assert.equal(warnings.length, 1, label);
    assert.match(warnings[0], reason, label);
  }
});

test('사람이 kadan up --cmd로 직접 준 명령은 설정과 상관없이 그대로 쓴다', () => {
  const home = withRunner(homeWith(SOL), 'codex');
  const direct = 'codex --model gpt-6-luna -c model_reasoning_effort="high"';
  const started = [];
  const floor = {name: 'fake', alive: () => false, attach: s => s};
  runUp({home, flags: {cmd: direct}, floor, secretarySettings: freshSecretarySettings(home), start: (argv, flags) => started.push({role: argv[0], ...flags}),
    cliPath: '/c', sessionName: r => `kadan-${r}`, log: () => {}});
  assert.equal(started[0].cmd, direct);
  assert.equal('startExtra' in started[0], false);
});

test('공용 함수: fresh 없이 부르면 resume 꼴만 받는다(다시 여는 길은 그대로)', () => {
  const home = homeWith(SOL);
  assert.equal(secretaryCommandFromSettings({home, command: 'codex'}).skipped, 'command-shape');
  const resumed = secretaryCommandFromSettings({home, command: 'codex resume abc --model gpt-6-luna'});
  assert.equal(resumed.skipped, null);
  assert.equal(resumed.command, `'codex' 'resume' 'abc' '--model' 'gpt-6-sol' '-c' 'model_reasoning_effort="medium"'`);
  assert.equal(secretaryCommandFromSettings({home, command: 'codex', fresh: true}).skipped, null);
});
