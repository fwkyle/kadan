// 실행 모델 설정의 비서 자리(roles.secretary)가 비서를 다시 여는 세 길에 같은 값으로 들어가는지 본다.
// 세 길: (1) kadan restart 비서 (2) kadan up / up --auto 복원(resumeSecretary) (3) 로티 탭 복원(restoreRecovery).
// 모델·대화 ID는 모두 가짜 값이고, 실행기·tmux·로티는 부르지 않는다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {checkpointSecretary, resumeSecretary} from '../src/secretary-resume.mjs';
import {commandWords, launchIdentityOf} from '../src/ai-identity.mjs';
import {inspectRecovery, restoreRecovery} from '../src/recovery.mjs';
import {restartRole} from '../src/restart.mjs';
import {DEFAULT_FAMILIES, checkChoice, readSettings} from '../src/runner-settings.mjs';

const LUNA = 'codex --model gpt-6-luna -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox';
const SOL = {runner: 'codex', model: 'gpt-6-sol', effort: 'medium'};
const PATHS = ['restart', 'up', 'rottie'];
// 자리가 비어 있을 때 세 길이 띄우는 명령. 이 기능을 넣기 전 코드가 낸 값을 그대로 옮긴 것이다(글자 단위 비교).
const BEFORE = {
  restart: "'codex' 'resume' 'exact-conversation' '--model' 'gpt-6-luna' '-c' 'model_reasoning_effort=high'"
    + " '--dangerously-bypass-approvals-and-sandbox' --no-alt-screen",
  up: "'codex' 'resume' 'exact-conversation' '--model' 'gpt-6-luna' '-c' 'model_reasoning_effort=high'"
    + " '--dangerously-bypass-approvals-and-sandbox' --no-alt-screen",
  rottie: "'codex' 'resume' 'exact-conversation' '--model' 'gpt-6-luna' '-c' 'model_reasoning_effort=high'"
    + " '--dangerously-bypass-approvals-and-sandbox' --no-alt-screen",
};

const settingsFile = home => path.join(home, 'runner-settings.json');
const CODEX_LISTED = {spawn: 'codex --model {model} -c model_reasoning_effort="{effort}"',
  models: ['gpt-6-luna', 'gpt-6-sol'].map(model => ({model, efforts: ['medium', 'high']}))};
// codex: 실행기 표의 codex 줄(기본은 등록 목록에 luna·sol, 강도 medium·high). revision: 설정 버전.
function writeSettings(home, secretary, {codex = CODEX_LISTED, revision = 7} = {}) {
  fs.writeFileSync(settingsFile(home), JSON.stringify({version: 1, revision, activePreset: 'A',
    families: DEFAULT_FAMILIES, blocked: [],
    runners: {
      codex,
      claude: {spawn: 'claude --model {model} --effort {effort}', models: [{model: 'claude-test', efforts: ['high']}]},
    },
    presets: {A: {label: '시험', roles: secretary ? {secretary} : {}}}}));
}

// slot: undefined면 설정 파일 없음, null이면 파일은 있고 비서 자리만 비어 있음.
// codex: 실행기 표의 codex 줄을 바꿀 때. beforeStop(home): restart가 끄기 직전 확인하는 순간에 끼워 넣을 일.
function fixture({slot, startCmd = LUNA, codex, beforeStop = () => {}} = {}) {
  const home = fs.mkdtempSync(path.join(process.env.KADAN_HOME, 'secretary-setting-'));
  if (slot !== undefined) writeSettings(home, slot, {codex});
  const transcript = path.join(home, 'rollout-exact.jsonl');
  fs.writeFileSync(transcript, [
    {type: 'session_meta', payload: {id: 'exact-conversation', cwd: home}},
    {type: 'turn_context', payload: {model: 'gpt-6-luna', effort: 'high'}},
  ].map(line => JSON.stringify(line)).join('\n') + '\n');
  const entries = [{kind: 'start', floor: 'tmux', role: '비서', session: 'kadan-비서', panePid: '20', cwd: home,
    roleProfile: 'secretary', rottieTerminalId: 'tab-1', cmd: startCmd, by: '사람'}];
  let pane = {pid: '20', dead: false, created: '100'}, nextPid = 30, tabs = 1, stops = 0;
  const launched = [], warnings = [];
  const floor = {name: 'tmux', alive: () => Boolean(pane), pid: () => pane?.pid,
    stop: () => { stops += 1; pane = null; },
    create: options => {
      launched.push(options.cmd);
      pane = {pid: String(nextPid), dead: false, created: String(nextPid * 10)};
      nextPid += 10;
      return {panePid: pane.pid};
    }};
  const record = entry => entries.push(entry);
  const deps = {home, floor, read: () => entries, record, findTranscript: () => transcript,
    startNew: () => assert.fail('새 비서를 만들면 안 된다'), pendingCards: () => [], closeWindow: () => ({}),
    openWindow: () => ({method: 'manual'}), beforeStop: () => beforeStop(home)};
  const recoveryDeps = {home, entries, read: () => entries, record, livePane: () => pane, create: floor.create,
    secretaryConversation: () => 'exact-conversation', warn: line => warnings.push(line),
    spawn: () => ({status: 0, stdout: JSON.stringify({ok: true, result: {terminal: {id: `tab-${++tabs}`}}})})};
  const kill = () => { pane = null; };
  const latestStart = () => entries.findLast(e => e.kind === 'start');
  const run = {
    restart: (flags = {}) => restartRole({home, role: '비서', session: 'kadan-비서', flags, floor, settings: null, deps}),
    up: () => { checkpointSecretary(deps); kill(); assert.equal(resumeSecretary(deps), 'restored'); },
    // 로티가 준 명령은 옵션 없는 맨 명령일 수 있다. 저장된 체크포인트의 옵션으로 채워진다.
    // checkpoint: false면 체크포인트를 다시 만들지 않는다(실제로는 로티 복원 두 번 사이에 아무도 다시 만들지 않는다).
    rottie: ({command = "'codex' 'resume' 'exact-conversation'", checkpoint = true} = {}) => {
      const tab = latestStart().rottieTerminalId;
      const context = inspectRecovery({terminal: tab}, recoveryDeps);
      if (checkpoint) checkpointSecretary(deps);
      kill();
      return restoreRecovery({context: JSON.stringify(context), command, 'rottie-bin': '/fixture/rottie'}, recoveryDeps);
    },
  };
  return {home, entries, launched, warnings, deps, recoveryDeps, run, kill, latestStart, stops: () => stops};
}

const isModelOption = word => word === '--model' || word === '-m' || word.startsWith('--model=');
const effortWords = words => words.filter(word => word.startsWith('model_reasoning_effort='));
const effortValue = word => word.slice(word.indexOf('=') + 1).replace(/^"(.*)"$/, '$1');
// 모델 값과 강도 값만 지운 낱말 목록. 두 값 말고는 아무것도 달라지지 않았는지 볼 때 쓴다.
function withoutChoice(command) {
  const words = commandWords(command);
  const at = words.findIndex(isModelOption);
  return words.filter((word, i) => i !== at + 1).map(word => word.startsWith('model_reasoning_effort=') ? 'EFFORT' : word);
}

function assertChoice(command, {model, effort}) {
  const words = commandWords(command);
  assert.deepEqual(words.slice(0, 3), ['codex', 'resume', 'exact-conversation'], '같은 대화를 잇는다');
  assert.equal(words.filter(isModelOption).length, 1, `모델 옵션은 하나다: ${command}`);
  assert.equal(words[words.indexOf('--model') + 1], model);
  assert.deepEqual(effortWords(words).map(effortValue), [effort], `강도 옵션은 하나다: ${command}`);
}

for (const name of PATHS) {
  test(`${name}: 비서 자리가 있으면 그 모델·강도로 같은 대화를 다시 연다`, () => {
    const f = fixture({slot: SOL});
    f.run[name]();
    assert.equal(f.launched.length, 1);
    assertChoice(f.launched[0], {model: 'gpt-6-sol', effort: 'medium'});
    assert.deepEqual(withoutChoice(f.launched[0]), withoutChoice(BEFORE[name]), '모델·강도 값 말고는 그대로다');
    const start = f.latestStart();
    assert.equal(start.cmd, f.launched[0]);
    assert.equal(launchIdentityOf(start.cmd).model, 'gpt-6-sol', '원장의 시작 명령에서 읽는 모델도 설정값이다');
    assert.equal(start.modelFromSettings, true);
    assert.equal(start.settingsRevision, 7);
    assert.equal(start.settingsPreset, 'A');
    assert.deepEqual(start.runnerChoice, SOL);
    assert.equal(start.previousModel, 'gpt-6-luna');
    assert.equal(start.previousEffort, 'high');
    assert.equal('modelFromSettingsSkipped' in start, false);
  });

  test(`${name}: 비서 자리가 비어 있으면 바꾸기 전과 글자 하나 다르지 않다`, () => {
    for (const slot of [undefined, null]) {
      const f = fixture({slot});
      f.run[name]();
      assert.deepEqual(f.launched, [BEFORE[name]]);
      const start = f.latestStart();
      assert.equal(start.cmd, BEFORE[name]);
      for (const key of ['modelFromSettings', 'settingsRevision', 'settingsPreset', 'runnerChoice', 'previousModel',
        'previousEffort', 'modelFromSettingsSkipped']) assert.equal(key in start, false, key);
    }
  });

  test(`${name}: 설정을 쓸 수 없으면 저장된 명령 그대로 열고 이유를 남긴다`, () => {
    const broken = home => fs.writeFileSync(settingsFile(home), '{"version": 1, "revision":');
    const cases = [
      ['값이 무효(옵션 꼴 모델)', {slot: {runner: 'codex', model: '--print', effort: 'medium'}}, 'slot-invalid'],
      ['값이 무효(강도에 공백)', {slot: {runner: 'codex', model: 'gpt-6-sol', effort: 'very high'}}, 'slot-invalid'],
      ['실행기가 codex가 아님', {slot: {runner: 'claude', model: 'claude-test', effort: 'high'}}, 'runner-differs'],
      ['설정 파일 깨짐', {slot: null, after: broken}, 'settings-unreadable'],
    ];
    for (const [label, {slot, after}, reason] of cases) {
      const f = fixture({slot});
      after?.(f.home);
      f.run[name]();
      assert.deepEqual(f.launched, [BEFORE[name]], label);
      const start = f.latestStart();
      assert.equal(start.modelFromSettingsSkipped, reason, label);
      assert.equal('modelFromSettings' in start, false, label);
      assert.equal(launchIdentityOf(start.cmd).model, 'gpt-6-luna', label);
    }
  });
}

test('restart → 체크포인트 → restart를 되풀이해도 모델·강도 옵션은 한 벌이다', () => {
  const f = fixture({slot: SOL});
  f.run.restart();
  f.run.restart();
  f.run.up();
  assert.equal(f.launched.length, 3);
  for (const command of f.launched) assertChoice(command, {model: 'gpt-6-sol', effort: 'medium'});
  // 낱말로 비교한다: 시작 명령에서 다시 만든 체크포인트는 인라인 화면 옵션을 따옴표로 감싸 적는다(기존 동작, 낱말은 같다).
  assert.equal(new Set(f.launched.map(command => JSON.stringify(commandWords(command)))).size, 1, '세 번 모두 같은 명령이다');
  // 두 번째부터는 이미 설정값이라 바뀐 것이 없다: 설정 칸은 남고 이전 값 칸은 없다.
  const start = f.latestStart();
  assert.equal(start.modelFromSettings, true);
  assert.equal('previousModel' in start, false);
  assert.equal('previousEffort' in start, false);
});

test('로티 탭 복원을 연달아 두 번 해도 두 번째가 거절되지 않고 설정값으로 열린다', () => {
  const f = fixture({slot: SOL});
  f.run.rottie();
  // 두 번째는 첫 복원이 남긴 체크포인트만으로 연다. 체크포인트가 옛 모델로 남아 있으면 원본 start(설정 모델)와 어긋나 거절된다.
  const saved = JSON.parse(fs.readFileSync(path.join(f.home, 'secretary-resume.json'), 'utf8'));
  assertChoice(saved.command, {model: 'gpt-6-sol', effort: 'medium'});
  f.run.rottie({checkpoint: false});
  assert.equal(f.launched.length, 2);
  for (const command of f.launched) assertChoice(command, {model: 'gpt-6-sol', effort: 'medium'});
  // 로티 복원 바로 뒤 up 복원도 체크포인트를 다시 만들지 않고 이어진다.
  f.kill();
  assert.equal(resumeSecretary(f.deps), 'restored');
  assertChoice(f.launched[2], {model: 'gpt-6-sol', effort: 'medium'});
});

test('정책으로 막은 모델이 비서 자리에 있으면 그 값을 쓰지 않고 저장된 명령 그대로 연다', () => {
  for (const name of PATHS) {
    const f = fixture({slot: SOL});
    const settings = JSON.parse(fs.readFileSync(settingsFile(f.home), 'utf8'));
    settings.blocked = [{model: 'gpt-6-sol', roles: ['secretary'], reason: '시험'}];
    fs.writeFileSync(settingsFile(f.home), JSON.stringify(settings));
    f.run[name]();
    assert.deepEqual(f.launched, [BEFORE[name]]);
    assert.equal(f.latestStart().modelFromSettingsSkipped, 'model-blocked');
  }
});

test('띄운 명령이 체크포인트에 남는다: 로티 복원 뒤 up 복원, 자리를 비운 뒤에도 옛 모델로 돌아가지 않는다', () => {
  for (const first of ['rottie', 'up', 'restart']) {
    const f = fixture({slot: SOL});
    f.run[first]();
    const saved = JSON.parse(fs.readFileSync(path.join(f.home, 'secretary-resume.json'), 'utf8'));
    assertChoice(saved.command, {model: 'gpt-6-sol', effort: 'medium'});
    // 자리를 비운다(값 없음 = 건드리지 않는다). 마지막으로 띄운 값이 이어진다.
    writeSettings(f.home, null);
    f.kill();
    assert.equal(resumeSecretary(f.deps), 'restored');
    assertChoice(f.launched.at(-1), {model: 'gpt-6-sol', effort: 'medium'});
    assert.equal('modelFromSettings' in f.latestStart(), false, first);
  }
});

test('설정 자리의 강도가 비어 있으면 강도는 바꾸지 않는다', () => {
  // 강도 없는 값은 강도 자리가 없는 실행기 틀에서만 저장된다(저장 단계 checkChoice와 같은 판정). 그 틀로 본다.
  const codex = {spawn: 'codex --model {model}', models: ['gpt-6-luna', 'gpt-6-sol'].map(model => ({model, efforts: []}))};
  for (const name of PATHS) {
    const f = fixture({slot: {runner: 'codex', model: 'gpt-6-sol'}, codex});
    f.run[name]();
    assertChoice(f.launched[0], {model: 'gpt-6-sol', effort: 'high'});
    const start = f.latestStart();
    assert.deepEqual(start.runnerChoice, {runner: 'codex', model: 'gpt-6-sol'});
    assert.equal(start.previousModel, 'gpt-6-luna');
    assert.equal('previousEffort' in start, false);
  }
});

test('저장된 명령에 모델·강도 옵션이 없으면 한 번만 넣고, 읽지 못하는 꼴이면 건드리지 않는다', () => {
  const bare = fixture({slot: SOL, startCmd: 'codex --dangerously-bypass-approvals-and-sandbox'});
  // 대화 기록의 모델·강도(luna/high)가 체크포인트에 들어온 뒤 설정값으로 바뀐다.
  bare.run.up();
  assertChoice(bare.launched[0], {model: 'gpt-6-sol', effort: 'medium'});
  // 붙여 쓴 짧은 옵션(-m값)은 카단의 중복 판정이 읽지 못한다. 잘못 덧붙이면 모델 옵션이 둘이 되므로 그대로 둔다.
  const attached = fixture({slot: SOL, startCmd: 'codex -mgpt-6-luna --dangerously-bypass-approvals-and-sandbox'});
  fs.writeFileSync(path.join(attached.home, 'rollout-exact.jsonl'),
    JSON.stringify({type: 'session_meta', payload: {id: 'exact-conversation', cwd: attached.home}}) + '\n');
  attached.run.up();
  assert.deepEqual(commandWords(attached.launched[0]).slice(3),
    ['-mgpt-6-luna', '--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen']);
  assert.equal(attached.latestStart().modelFromSettingsSkipped, 'command-shape');
});

test('restart 비서 --model-from-settings: 자리가 비었거나 쓸 수 없으면 끄기 전에 거절하고, 있으면 설정값으로 연다', () => {
  for (const slot of [undefined, null]) {
    const f = fixture({slot});
    assert.throws(() => f.run.restart({'model-from-settings': true}), /비서 자리가 비어 있다/);
    assert.equal(f.stops(), 0, '기존 세션을 끄지 않는다');
    assert.equal(f.launched.length, 0);
  }
  const wrong = fixture({slot: {runner: 'claude', model: 'claude-test', effort: 'high'}});
  assert.throws(() => wrong.run.restart({'model-from-settings': true}), /비서 자리 값을 적용할 수 없다/);
  assert.equal(wrong.stops(), 0);
  const f = fixture({slot: SOL});
  const receipt = f.run.restart({'model-from-settings': true});
  assertChoice(f.launched[0], {model: 'gpt-6-sol', effort: 'medium'});
  assert.deepEqual(receipt.modelFromSettings, {changed: true, model: 'gpt-6-sol', effort: 'medium',
    previousModel: 'gpt-6-luna', previousEffort: 'high', revision: 7, preset: 'A'});
  // 옵션 없이도 같은 값이 쓰이고, 결과에 같은 보고가 실린다.
  const plain = fixture({slot: SOL});
  assert.equal(plain.run.restart().modelFromSettings.changed, true);
  assert.deepEqual(plain.launched, f.launched);
});

// ---- 2라운드(검수 exec-7ecc53fa 중요 1): 다시 열 때도 저장 단계와 같은 판정(checkChoice)을 쓴다 ----
const UNLISTED = {runner: 'codex', model: 'gpt-not-in-catalog', effort: 'medium'};
const UNSUPPORTED = {runner: 'codex', model: 'gpt-6-sol', effort: 'xhigh'};
// 강도가 필요한 틀인데 강도가 없는 값. 저장 단계가 거절하므로 다시 열 때도 쓰지 않는다.
const NO_EFFORT = {runner: 'codex', model: 'gpt-6-sol'};

for (const name of PATHS) {
  test(`${name}: 목록에 없는 모델·지원하지 않는 강도는 쓰지 않고 저장된 명령 그대로 연다`, () => {
    for (const slot of [UNLISTED, UNSUPPORTED, NO_EFFORT]) {
      const f = fixture({slot});
      assert.throws(() => checkChoice(readSettings(f.home), 'secretary', slot), /고를 수 없는 모델|지원하지 않는 강도/,
        '저장 단계가 거절하는 값이다');
      f.run[name]();
      assert.deepEqual(f.launched, [BEFORE[name]], JSON.stringify(slot));
      const start = f.latestStart();
      assert.equal(start.modelFromSettingsSkipped, 'choice-rejected');
      assert.equal('modelFromSettings' in start, false);
    }
  });

  test(`${name}: 모델 목록 파일을 읽지 못하면 확인 못 한 값을 쓰지 않고 저장된 명령 그대로 연다`, t => {
    const prior = process.env.KADAN_CODEX_MODELS_CACHE;
    t.after(() => {
      if (prior === undefined) delete process.env.KADAN_CODEX_MODELS_CACHE; else process.env.KADAN_CODEX_MODELS_CACHE = prior;
    });
    // codex처럼 모델 목록을 파일에서 읽는 실행기 줄. 운영 설정의 꼴이다.
    const codex = {spawn: 'codex --model {model} -c model_reasoning_effort="{effort}"', catalog: 'codex-models-cache'};
    const cacheOf = home => path.join(home, 'models_cache.json');
    const models = {models: [{slug: 'gpt-6-sol', supported_reasoning_levels: [{effort: 'medium'}, {effort: 'high'}]}]};
    for (const [label, prepare, reason] of [
      ['파일 없음', () => {}, 'catalog-unreadable'],
      ['깨진 파일', home => fs.writeFileSync(cacheOf(home), '{"models": ['), 'catalog-unreadable'],
      ['목록 모양이 아님', home => fs.writeFileSync(cacheOf(home), '{"other": 1}'), 'catalog-unreadable'],
    ]) {
      const f = fixture({slot: SOL, codex});
      process.env.KADAN_CODEX_MODELS_CACHE = cacheOf(f.home);
      prepare(f.home);
      f.run[name]();
      assert.deepEqual(f.launched, [BEFORE[name]], label);
      assert.equal(f.latestStart().modelFromSettingsSkipped, reason, label);
    }
    // 목록을 읽을 수 있으면 그 목록으로 판정한다: 있는 모델·강도는 쓰고, 없는 강도는 쓰지 않는다.
    const ok = fixture({slot: SOL, codex});
    process.env.KADAN_CODEX_MODELS_CACHE = cacheOf(ok.home);
    fs.writeFileSync(cacheOf(ok.home), JSON.stringify(models));
    ok.run[name]();
    assertChoice(ok.launched[0], {model: 'gpt-6-sol', effort: 'medium'});
    const low = fixture({slot: {...SOL, effort: 'low'}, codex});
    process.env.KADAN_CODEX_MODELS_CACHE = cacheOf(low.home);
    fs.writeFileSync(cacheOf(low.home), JSON.stringify(models));
    low.run[name]();
    assert.deepEqual(low.launched, [BEFORE[name]]);
    assert.equal(low.latestStart().modelFromSettingsSkipped, 'choice-rejected');
  });
}

test('restart 비서 --model-from-settings: 저장 단계가 거절하는 값이면 끄기 전에 거절한다', () => {
  for (const slot of [UNLISTED, UNSUPPORTED, NO_EFFORT]) {
    const f = fixture({slot});
    assert.throws(() => f.run.restart({'model-from-settings': true}), /비서 자리 값을 적용할 수 없다.*기존 세션은 그대로 둔다/);
    assert.equal(f.stops(), 0, JSON.stringify(slot));
    assert.equal(f.launched.length, 0);
  }
});

// ---- 2라운드(중요 2): --model-from-settings는 끄기 전에 확인한 값을 그대로 이어 써서 연다 ----
test('restart 비서 --model-from-settings: 끄기 전 확인과 끄기 사이에 설정이 바뀌어도 확인한 값으로 연다', () => {
  const edits = {
    '자리를 비움': home => writeSettings(home, null, {revision: 8}),
    '다른 값으로 바꿈': home => writeSettings(home, {runner: 'codex', model: 'gpt-6-luna', effort: 'medium'}, {revision: 8}),
    '설정 파일이 깨짐': home => fs.writeFileSync(settingsFile(home), '{"version": 1,'),
    '설정 파일이 사라짐': home => fs.renameSync(settingsFile(home), settingsFile(home) + '.moved'),
  };
  for (const [label, edit] of Object.entries(edits)) {
    const f = fixture({slot: SOL, beforeStop: edit});
    const receipt = f.run.restart({'model-from-settings': true});
    assert.equal(f.stops(), 1, label);
    assertChoice(f.launched[0], {model: 'gpt-6-sol', effort: 'medium'});
    const start = f.latestStart();
    assert.deepEqual([start.modelFromSettings, start.settingsRevision, start.settingsPreset, start.runnerChoice],
      [true, 7, 'A', SOL], `${label}: 원장에는 끄기 전에 확인한 설정 버전이 남는다`);
    assert.equal('modelFromSettingsSkipped' in start, false, label);
    assert.deepEqual(receipt.modelFromSettings, {changed: true, model: 'gpt-6-sol', effort: 'medium',
      previousModel: 'gpt-6-luna', previousEffort: 'high', revision: 7, preset: 'A'}, label);
    assertChoice(JSON.parse(fs.readFileSync(path.join(f.home, 'secretary-resume.json'), 'utf8')).command,
      {model: 'gpt-6-sol', effort: 'medium'});
  }
});

test('옵션 없는 restart 비서는 다시 여는 순간의 설정을 읽는다(끄기 직전에 바뀌면 바뀐 값)', () => {
  const cleared = fixture({slot: SOL, beforeStop: home => writeSettings(home, null, {revision: 8})});
  cleared.run.restart();
  assert.deepEqual(cleared.launched, [BEFORE.restart]);
  assert.equal('modelFromSettings' in cleared.latestStart(), false);
  const changed = fixture({slot: null, beforeStop: home => writeSettings(home, SOL, {revision: 8})});
  changed.run.restart();
  assertChoice(changed.launched[0], {model: 'gpt-6-sol', effort: 'medium'});
  assert.equal(changed.latestStart().settingsRevision, 8);
});

test('restart 비서 --model-from-settings: 모델 목록을 읽지 못해 값을 확인할 수 없으면 끄기 전에 거절한다', t => {
  const prior = process.env.KADAN_CODEX_MODELS_CACHE;
  t.after(() => {
    if (prior === undefined) delete process.env.KADAN_CODEX_MODELS_CACHE; else process.env.KADAN_CODEX_MODELS_CACHE = prior;
  });
  const codex = {spawn: 'codex --model {model} -c model_reasoning_effort="{effort}"', catalog: 'codex-models-cache'};
  const f = fixture({slot: SOL, codex});
  process.env.KADAN_CODEX_MODELS_CACHE = path.join(f.home, 'no-such-models-cache.json');
  assert.throws(() => f.run.restart({'model-from-settings': true}),
    /비서 자리 값을 적용할 수 없다\(비서 자리 실행기의 모델 목록을 읽지 못해 값을 확인할 수 없음\).*기존 세션은 그대로 둔다/);
  assert.equal(f.stops(), 0);
  assert.equal(f.launched.length, 0);
});
