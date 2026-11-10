// kadan restart --model-from-settings: 마지막 start의 프로필과 지금 활성 프리셋 값으로 모델·강도만 바꿔 같은 대화를 이어 연다.
// 가짜 바닥·가짜 프로세스만 쓴다(실제 tmux·실행기 없음). 설정도 시험용 가짜 값이다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {restartRole} from '../src/restart.mjs';
import {inspectDispatchRunnerGuard} from '../src/dispatch-runner-guard.mjs';
import {inspectCardSendIdentity} from '../src/ai-identity.mjs';
import {settingsWith} from './helpers/runner-table.mjs';

const ID = '0197aaaa-1111-4222-8333-444455556666';
const OLD = 'claude --model claude-haiku-5-5 --effort low --dangerously-skip-permissions';
const NEW = 'claude --model claude-sonnet-5-5 --effort high --dangerously-skip-permissions';
const OLD_CODEX = 'codex -p lite --model gpt-6-sol -c model_reasoning_effort="low"';
const ROLLOUT = [`/h/.codex/sessions/2026/10/14/rollout-2026-10-14T16-35-00-${ID}.jsonl`];
const OPTION = {'model-from-settings': true};

// 활성 프리셋 B의 역할 값. 기본은 worker = claude 새 모델·새 강도.
function settingsOf(roles = {worker: {runner: 'claude', model: 'claude-sonnet-5-5', effort: 'high'}}) {
  return {...settingsWith(), revision: 7, presets: {B: {roles}}};
}

function fixture({cmd = OLD, role = 'w', profile = 'worker', extra = {}, openFiles = [], processArgs} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-restart-model-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-restart-model-user-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-restart-model-cwd-'));
  fs.mkdirSync(path.join(homeDir, '.claude/sessions'), {recursive: true});
  fs.mkdirSync(path.join(homeDir, '.claude/projects/-x'), {recursive: true});
  fs.writeFileSync(path.join(homeDir, '.claude/sessions/150.json'), JSON.stringify({sessionId: ID, tmux: 'kadan-w:@3.%3'}));
  fs.writeFileSync(path.join(homeDir, `.claude/projects/-x/${ID}.jsonl`), '{}');
  const session = `kadan-${role}`;
  const entries = [{kind: 'start', floor: 'tmux', role, session, cmd, cwd: dir, panePid: '100', by: 'boss',
    ...(profile ? {roleProfile: profile} : {}), ...extra, t: '2026-11-10T00:00:00Z'}];
  const log = [];
  let pid = '100';
  const floor = {name: 'tmux', alive: () => true, pid: () => pid,
    stop: s => log.push(['stop', s]), create: o => { log.push(['create', o]); pid = '200'; return {panePid: '200'}; }};
  let beforeStop = () => {};
  const deps = {read: () => entries, record: e => { log.push(['record', e.kind]); entries.push({t: new Date().toISOString(), ...e}); },
    pendingCards: () => [], closeWindow: () => ({}), openWindow: () => ({method: 'manual'}),
    paneInfo: () => ({panePid: '100', location: 'kadan-w:@3.%3'}),
    // 살아 있는 프로세스의 인자는 옛 명령 그대로다(설정을 바꿔도 프로세스는 옛 모델).
    processTree: () => [{pid: '100', ppid: '1', args: '-zsh'}, {pid: '150', ppid: '100', args: processArgs ?? cmd}],
    openFiles: () => openFiles, processStartedAt: () => 1000,
    readJson: f => JSON.parse(fs.readFileSync(f, 'utf8')), homeDir,
    beforeStop: s => { log.push(['beforeStop', s]); beforeStop(s); }};
  const run = (flags = OPTION, settings = settingsOf()) => restartRole({home, role, session, flags, floor, settings, deps});
  const stops = () => log.filter(([kind]) => kind === 'stop' || kind === 'create').length;
  return {home, entries, log, run, session, role, stops, setBeforeStop: fn => { beforeStop = fn; }};
}

test('옵션 + 설정 모델이 다름: 새 명령의 모델·강도가 설정값이고 같은 대화 resume이며, start에 설정 근거와 이전 값이 남는다', () => {
  const f = fixture();
  const receipt = f.run();
  assert.deepEqual(f.log.map(([kind]) => kind), ['beforeStop', 'stop', 'record', 'create', 'record']);
  const [stop, start] = f.entries.slice(1);
  assert.equal(start.cmd, `${NEW} --resume ${ID}`);
  assert.equal(start.model, 'claude-sonnet-5-5'); assert.equal(start.harness, 'claude');
  assert.equal(start.conversationMode, 'resume'); assert.equal(start.restartConversation, ID);
  assert.equal(start.roleProfile, 'worker');
  assert.equal(start.launchSource, 'settings'); assert.equal(start.modelFromSettings, true);
  assert.equal(start.settingsRevision, 7); assert.equal(start.settingsPreset, 'B');
  assert.deepEqual(start.runnerChoice, {runner: 'claude', model: 'claude-sonnet-5-5', effort: 'high'});
  assert.equal(start.previousModel, 'claude-haiku-5-5'); assert.equal(start.previousEffort, 'low');
  // stop에는 평소 restart 칸만 남는다.
  assert.equal(stop.restart, true);
  for (const key of ['launchSource', 'modelFromSettings', 'settingsRevision', 'previousModel']) assert.equal(stop[key], undefined, key);
  assert.equal(receipt.model, 'claude-sonnet-5-5');
  assert.deepEqual(receipt.modelFromSettings, {changed: true, model: 'claude-sonnet-5-5', effort: 'high',
    previousModel: 'claude-haiku-5-5', previousEffort: 'low', revision: 7, preset: 'B'});
});

test('옵션 없음: 설정이 달라도 원래 모델을 유지하고 설정 칸을 남기지 않는다(회귀)', () => {
  const f = fixture();
  const receipt = f.run({});
  const start = f.entries.at(-1);
  assert.equal(start.cmd, `${OLD} --resume ${ID}`);
  assert.equal(start.model, 'claude-haiku-5-5');
  for (const key of ['launchSource', 'modelFromSettings', 'settingsRevision', 'settingsPreset', 'runnerChoice', 'previousModel', 'previousEffort'])
    assert.equal(start[key], undefined, key);
  assert.equal(receipt.modelFromSettings, undefined);
});

test('프로세스 찾기는 옛 모델 기준이다: 프로세스 인자가 새 모델이면(옛 기록과 다름) 본체를 못 찾아 거절한다', () => {
  const f = fixture({processArgs: NEW});
  assert.throws(() => f.run(), /본체 프로세스를 하나의 사슬로 정할 수 없다/);
  assert.equal(f.stops(), 0);
});

test('codex: 옵션 이름·값이 한 낱말로 붙는 강도 자리도 설정 틀로 찾아 바꾼다', () => {
  const f = fixture({cmd: OLD_CODEX, openFiles: ROLLOUT});
  f.run(OPTION, settingsOf({worker: {runner: 'codex', model: 'gpt-6-1-sol', effort: 'high'}}));
  const start = f.entries.at(-1);
  assert.equal(start.cmd, `codex -p lite --model gpt-6-1-sol -c model_reasoning_effort=high resume ${ID} --no-alt-screen`);
  assert.equal(start.previousModel, 'gpt-6-sol'); assert.equal(start.previousEffort, 'low');
});

test('두 번째 restart: 이전 restart가 붙인 resume 꼬리가 있어도 설정 명령으로 바꾼다', () => {
  const f = fixture({cmd: `${OLD} --resume ${ID}`});
  f.run();
  assert.equal(f.entries.at(-1).cmd, `${NEW} --resume ${ID}`);
});

test('거절은 모두 끄기 전이다: 프로필 없음·설정 값 없음·실행기 다름·비교 모드·남는 옵션·잘못된 옵션 값', () => {
  const codexWorker = settingsOf({worker: {runner: 'codex', model: 'gpt-6-1-sol', effort: 'high'}});
  const cases = [
    ['프로필 없음', fixture({profile: null}), undefined, /시작 기록에 프로필이 없어/],
    ['설정에 역할 값 없음', fixture(), settingsOf({}), /역할 값이 없다/],
    ['설정 대상이 아닌 프로필', fixture({profile: 'secretary'}), undefined, /역할 값이 없다/],
    ['실행기 다름', fixture(), codexWorker, /실행기\(codex\)가 이 역할의 실행기\(claude\)와 다르다/],
    ['비교 모드 start', fixture({extra: {compareMode: true, settingsPreset: 'B', pickId: 'p1'}}), undefined, /비교 모드/],
    ['남는 옵션', fixture({cmd: `${OLD} --add-dir /x`}), undefined, /옛 명령에만 있는 옵션: --add-dir \/x/],
    ['다른 대화 지정', fixture({cmd: `${OLD} --continue`}), undefined, /대화 지정/],
    ['다른 이름의 실행 파일', fixture({cmd: OLD.replace(/^claude/, '/opt/bin/kadan-claude'), processArgs: OLD}), undefined,
      /설정 명령에만 있는 옵션: claude \/ 옛 명령에만 있는 옵션: \/opt\/bin\/kadan-claude/],
  ];
  for (const [name, f, settings, pattern] of cases) {
    assert.throws(() => f.run(OPTION, settings ?? settingsOf()), pattern, name);
    assert.deepEqual(f.log, [], name);
    assert.equal(f.entries.length, 1, name);
  }
  const bad = fixture();
  assert.throws(() => bad.run({'model-from-settings': 'x'}), /값을 받지 않는다/);
  assert.deepEqual(bad.log, []);
});

test('거절: 비서와 계정 전환 재시작에는 쓸 수 없다(끄기 0회)', () => {
  const secretary = fixture({role: '비서', profile: 'secretary'});
  assert.throws(() => secretary.run(), /비서는 --model-from-settings 대상이 아니다/);
  const refresh = fixture();
  assert.throws(() => refresh.run({...OPTION, accountRefresh: true}), /계정 전환 재시작과 --model-from-settings는 함께 쓸 수 없다/);
  assert.deepEqual([secretary.log, refresh.log], [[], []]);
});

test('통과: 손으로 되살린 꼴(절대경로 실행 파일·카단 정지 훅 설정·중간 --resume·순서 다름)', () => {
  const hand = `/opt/tools/bin/claude --settings '/h/.kadan/stop-hook/claude-settings.json' --resume ${ID} `
    + '--dangerously-skip-permissions --model claude-haiku-5-5 --effort low';
  const f = fixture({cmd: hand});
  f.run();
  const start = f.entries.at(-1);
  assert.equal(start.cmd, `${NEW} --resume ${ID}`);
  assert.equal(start.previousModel, 'claude-haiku-5-5'); assert.equal(start.previousEffort, 'low');
});

test('설정 모델·강도가 옛 것과 같으면 평소 restart와 같은 명령이고 이전 값 칸이 없다', () => {
  const same = settingsOf({worker: {runner: 'claude', model: 'claude-haiku-5-5', effort: 'low'}});
  const f = fixture(), plain = fixture();
  const receipt = f.run(OPTION, same);
  plain.run({}, same);
  const start = f.entries.at(-1);
  assert.equal(start.cmd, plain.entries.at(-1).cmd);
  assert.equal(start.previousModel, undefined); assert.equal(start.previousEffort, undefined);
  assert.equal(start.settingsRevision, 7); assert.equal(start.launchSource, 'settings');
  assert.equal(receipt.modelFromSettings.changed, false);
});

test('강도만 다르면 이전 강도만 남긴다', () => {
  const f = fixture();
  f.run(OPTION, settingsOf({worker: {runner: 'claude', model: 'claude-haiku-5-5', effort: 'high'}}));
  const start = f.entries.at(-1);
  assert.equal(start.cmd, `claude --model claude-haiku-5-5 --effort high --dangerously-skip-permissions --resume ${ID}`);
  assert.equal(start.previousModel, undefined); assert.equal(start.previousEffort, 'low');
});

test('발령 경계: 옵션으로 다시 띄운 worker 세션은 옛 실행기·모델 세션으로 거절되지 않는다', () => {
  const guard = f => {
    const identity = inspectCardSendIdentity({entries: f.entries, session: f.session, currentPid: f.entries.at(-1).panePid});
    return inspectDispatchRunnerGuard({home: f.home, role: f.role, session: f.session, profile: 'worker', identity,
      readSettingsFn: () => settingsOf()});
  };
  const plain = fixture();
  plain.run({});
  assert.equal(guard(plain).code, 'runner-or-model', '대조군: 옵션 없이 다시 띄우면 옛 모델이라 거절');
  const f = fixture();
  f.run();
  const result = guard(f);
  assert.notEqual(result.result, 'reject');
  // 실행기·모델은 같다. resume 꼬리가 붙어 명령 글자가 기본값과 달라 경고 한 줄이 붙는다(평소 restart와 같은 기존 동작).
  assert.deepEqual([result.result, result.code], ['warn', 'effort-or-args']);
});

test('안전 지점 확인이 거절하면(응답 중) 옵션이 있어도 끄지 않는다', () => {
  const f = fixture();
  f.setBeforeStop(() => { throw new Error('working: 응답 생성 중'); });
  assert.throws(() => f.run(), /응답 생성 중/);
  assert.equal(f.stops(), 0);
  assert.equal(f.entries.length, 1);
});

test('명령줄: --model-from-settings는 값을 먹지 않는 옵션이고 사용법에 나온다', async () => {
  const {parseFlags} = await import('../src/cli-basics.mjs');
  const {RESTART_USAGE, RESTART_BOOLEANS} = await import('../src/commands/restart.mjs');
  assert.deepEqual(parseFlags(['--model-from-settings', 'w'], {booleans: RESTART_BOOLEANS}), {flags: {'model-from-settings': true}, rest: ['w']});
  assert.match(RESTART_USAGE, /--model-from-settings/);
});

test('설정과 같고 손으로 준 옵션이 있으면 거절하지 않고 옛 명령을 유지한다(버려지는 낱말 없음) — launchSource는 적지 않는다', () => {
  const same = settingsOf({worker: {runner: 'claude', model: 'claude-haiku-5-5', effort: 'low'}});
  const f = fixture({cmd: `${OLD} --add-dir /x`});
  const receipt = f.run(OPTION, same);
  const start = f.entries.at(-1);
  assert.equal(start.cmd, `${OLD} --add-dir /x --resume ${ID}`);
  assert.equal(receipt.modelFromSettings.changed, false);
  assert.equal(start.launchSource, undefined); assert.equal(start.modelFromSettings, true); assert.equal(start.settingsRevision, 7);
});

// PR #362 검수 F1: 설정 명령에만 있는 옵션(권한 건너뛰기 등)이 모델을 바꾸면서 조용히 붙으면 안 된다.
const BARE = 'claude --model claude-haiku-5-5 --effort low';
test('양방향 대조: 설정 명령에만 있는 옵션이 있으면 끄기 전에 거절하고, 어느 쪽에만 있는지 보여 준다', () => {
  const added = fixture({cmd: BARE});
  assert.throws(() => added.run(), error => {
    assert.match(error.message, /설정 명령에만 있는 옵션: --dangerously-skip-permissions/);
    assert.doesNotMatch(error.message, /옛 명령에만 있는 옵션/);
    assert.match(error.message, /권한·옵션이 달라 설정 명령으로 바꾸지 않는다/);
    return true;
  });
  const both = fixture({cmd: `${BARE} --add-dir /x`});
  assert.throws(() => both.run(),
    /설정 명령에만 있는 옵션: --dangerously-skip-permissions \/ 옛 명령에만 있는 옵션: --add-dir \/x/);
  const removed = fixture({cmd: `${OLD} --add-dir /x`});
  assert.throws(() => removed.run(), error => {
    assert.match(error.message, /옛 명령에만 있는 옵션: --add-dir \/x/);
    assert.doesNotMatch(error.message, /설정 명령에만 있는 옵션/);
    return true;
  });
  for (const f of [added, both, removed]) {
    assert.deepEqual(f.log, []);
    assert.equal(f.entries.length, 1);
  }
});

test('양방향 대조: 설정과 모델·강도가 같으면 옛 명령을 그대로 써서 설정 명령에만 있는 옵션이 붙지 않는다', () => {
  const same = settingsOf({worker: {runner: 'claude', model: 'claude-haiku-5-5', effort: 'low'}});
  const f = fixture({cmd: BARE});
  f.run(OPTION, same);
  const start = f.entries.at(-1);
  assert.equal(start.cmd, `${BARE} --resume ${ID}`);
  assert.equal(start.launchSource, undefined); assert.equal(start.modelFromSettings, true);
});

test('양방향 대조: 강도 자리만 새로 생기는 것은 허용한다(옛 명령에 강도 없음 → 설정 강도)', () => {
  const f = fixture({cmd: 'claude --model claude-haiku-5-5 --dangerously-skip-permissions'});
  f.run();
  const start = f.entries.at(-1);
  assert.equal(start.cmd, `${NEW} --resume ${ID}`);
  assert.equal(start.previousModel, 'claude-haiku-5-5'); assert.equal(start.previousEffort, undefined);
});

// PR #362 검수 F2: 역할 말고 낱말이 더 있으면 역할 선택·세션 조회 전에 사용법 오류로 끝난다. 실제 명령줄 경로(cmdRestart)를 지난다.
test('명령줄: 여분 위치 인자는 세션 조회 전에 거절하고, 정상 꼴은 역할을 그대로 고른다', async () => {
  const {floor} = await import('../src/floor.mjs');
  const {parseFlags} = await import('../src/cli-basics.mjs');
  const {cmdRestart, RESTART_BOOLEANS} = await import('../src/commands/restart.mjs');
  const saved = {alive: floor.alive, exit: process.exit, error: console.error};
  const tryRestart = argv => {
    let entered = null;
    const messages = [];
    floor.alive = session => { entered = session; throw new Error('FAKE_SESSION_BOUNDARY'); };
    process.exit = code => { throw new Error(`EXIT ${code}`); };
    console.error = message => messages.push(String(message));
    try {
      const parsed = parseFlags(argv, {booleans: RESTART_BOOLEANS});
      assert.throws(() => cmdRestart(parsed.rest, parsed.flags), /EXIT/);
    } finally { floor.alive = saved.alive; process.exit = saved.exit; console.error = saved.error; }
    return {entered, messages: messages.join('\n')};
  };
  for (const argv of [['w', '--model-from-settings', 'x'], ['--model-from-settings', 'x', 'w'], ['a', 'b']]) {
    const result = tryRestart(argv);
    assert.equal(result.entered, null, argv.join(' '));
    assert.match(result.messages, /역할은 하나만 받는다/, argv.join(' '));
    assert.match(result.messages, /사용법: kadan restart/, argv.join(' '));
  }
  for (const argv of [['--model-from-settings', 'w'], ['w', '--model-from-settings'], ['w']])
    assert.equal(tryRestart(argv).entered, 'kadan-w', argv.join(' '));
});

// 격리 홈에 정지 훅 설정 파일을 만든다(파일이 남으므로 이 파일의 마지막 시험으로 둔다). 운영 홈은 이 파일이 있어
// 설정 명령에 `--settings <파일>`이 붙는다.
test('정지 훅 설정이 있는 홈: 설정 명령의 --settings가 한 번만 붙고, 옛 명령의 같은 인자는 남는 낱말이 아니다', () => {
  const hook = path.join(process.env.KADAN_HOME, 'stop-hook', 'claude-settings.json');
  fs.mkdirSync(path.dirname(hook), {recursive: true});
  fs.writeFileSync(hook, '{}');
  const withHook = cmd => cmd.replace(/^claude/, `claude --settings '${hook}'`);
  const f = fixture({cmd: withHook(OLD)});
  f.run();
  const start = f.entries.at(-1);
  const words = start.cmd.split(' ');
  assert.equal(words.filter(word => word === '--settings').length, 1);
  assert.equal(start.model, 'claude-sonnet-5-5'); assert.equal(start.previousEffort, 'low');
  assert.match(start.cmd, /--effort high /); assert.match(start.cmd, new RegExp(`--resume ${ID}$`));
  assert.equal(start.conversationMode, 'resume');
});
