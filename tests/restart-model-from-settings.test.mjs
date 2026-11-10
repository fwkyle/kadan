// kadan restart --model-from-settings: 마지막 start의 프로필과 지금 활성 프리셋 값으로 모델·강도만 바꿔 같은 대화를 이어 연다.
// 옛 명령에서 모델·강도 자리의 값만 바꾼다. 실행 파일·다른 옵션·낱말 순서는 옛 그대로다(PR #362 재검수 N1 뒤 설계).
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
import {TABLE, settingsWith} from './helpers/runner-table.mjs';

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
  // launchSource는 적지 않는다: 명령이 설정 틀 그대로가 아니라 옛 명령에서 값만 바꾼 것이다.
  assert.equal(start.launchSource, undefined); assert.equal(start.modelFromSettings, true);
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

test('두 번째 restart: 이전 restart가 붙인 resume 꼬리가 있어도 모델·강도를 바꾼다', () => {
  const f = fixture({cmd: `${OLD} --resume ${ID}`});
  f.run();
  assert.equal(f.entries.at(-1).cmd, `${NEW} --resume ${ID}`);
});

test('거절은 모두 끄기 전이다: 프로필 없음·설정 값 없음·실행기 다름·비교 모드·자리를 정할 수 없음·잘못된 옵션 값', () => {
  const codexWorker = settingsOf({worker: {runner: 'codex', model: 'gpt-6-1-sol', effort: 'high'}});
  const cases = [
    ['프로필 없음', fixture({profile: null}), undefined, /시작 기록에 프로필이 없어/],
    ['설정에 역할 값 없음', fixture(), settingsOf({}), /역할 값이 없다/],
    ['설정 대상이 아닌 프로필', fixture({profile: 'secretary'}), undefined, /역할 값이 없다/],
    ['실행기 다름', fixture(), codexWorker, /실행기\(codex\)가 이 역할의 실행기\(claude\)와 다르다/],
    ['비교 모드 start', fixture({extra: {compareMode: true, settingsPreset: 'B', pickId: 'p1'}}), undefined, /비교 모드/],
    ['다른 대화 지정', fixture({cmd: `${OLD} --continue`}), undefined, /대화 지정/],
    // 모델 자리는 정확히 1번, 읽은 값이 시작 기록의 모델과 같아야 한다. 강도 자리는 많아야 1번이다.
    ['모델 자리 0번(틀과 다른 꼴 --model=값)', fixture({cmd: 'claude --model=claude-haiku-5-5 --effort low'}), undefined, /모델 자리를 0번 찾았다/],
    ['모델 자리 2번', fixture({cmd: `claude --model claude-haiku-5-5 ${OLD.replace(/^claude /, '')}`}), undefined, /모델 자리를 2번 찾았다/],
    ['읽은 값이 시작 기록의 모델과 다름', fixture({cmd: 'claude --model other-model --effort low --model=claude-haiku-5-5'}), undefined,
      /읽은 값\(other-model\)이 시작 기록의 모델\(claude-haiku-5-5\)과 다르다/],
    ['강도 자리 2번', fixture({cmd: `${OLD} --effort high`}), undefined, /강도 자리를 2번 찾았다/],
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

test('손으로 되살린 꼴(절대경로 실행 파일·카단 정지 훅 설정·중간 --resume·순서 다름): 순서·실행 파일은 그대로, 모델·강도만 바뀐다', () => {
  const hand = `/opt/tools/bin/claude --settings '/h/.kadan/stop-hook/claude-settings.json' --resume ${ID} `
    + '--dangerously-skip-permissions --model claude-haiku-5-5 --effort low';
  const f = fixture({cmd: hand});
  f.run();
  const start = f.entries.at(-1);
  // 중간의 --resume만 평소 restart처럼 끝으로 옮겨진다. 나머지 낱말은 옛 순서 그대로다.
  assert.equal(start.cmd, '/opt/tools/bin/claude --settings /h/.kadan/stop-hook/claude-settings.json --dangerously-skip-permissions '
    + `--model claude-sonnet-5-5 --effort high --resume ${ID}`);
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
  assert.equal(start.settingsRevision, 7); assert.equal(start.launchSource, undefined);
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

test('설정과 같고 손으로 준 옵션이 있으면 옛 명령을 그대로 유지한다', () => {
  const same = settingsOf({worker: {runner: 'claude', model: 'claude-haiku-5-5', effort: 'low'}});
  const f = fixture({cmd: `${OLD} --add-dir /x`});
  const receipt = f.run(OPTION, same);
  const start = f.entries.at(-1);
  assert.equal(start.cmd, `${OLD} --add-dir /x --resume ${ID}`);
  assert.equal(receipt.modelFromSettings.changed, false);
  assert.equal(start.launchSource, undefined); assert.equal(start.modelFromSettings, true); assert.equal(start.settingsRevision, 7);
});

// PR #362 검수 F1·재검수 N1 뒤의 기대. 앞 라운드에는 "설정 명령에만 있는 옵션·옛 명령에만 있는 옵션·다른 이름의 실행 파일"을
// 낱말 묶음 대조로 거절했다. 그 대조는 어느 값이 어느 옵션에 붙었는지 보지 못했다(N1). 지금은 옛 명령에서 모델·강도 값만 바꾸므로
// 다른 옵션은 구조상 바뀌지 않는다. 그래서 아래 경우는 거절이 아니라 통과이고, 옵션이 옛 그대로인지를 단언한다.
const BARE = 'claude --model claude-haiku-5-5 --effort low';
const SWAPPED = 'claude --model claude-sonnet-5-5 --effort high';
test('권한 옵션이 없던 역할에는 설정 틀에 그 옵션이 있어도 붙지 않는다(모델·강도만 바뀐다)', () => {
  const f = fixture({cmd: BARE});
  f.run();
  assert.equal(f.entries.at(-1).cmd, `${SWAPPED} --resume ${ID}`);
});

test('손으로 준 옵션은 그대로 남고 모델·강도만 바뀐다', () => {
  const f = fixture({cmd: `${OLD} --add-dir /x`});
  f.run();
  assert.equal(f.entries.at(-1).cmd, `${NEW} --add-dir /x --resume ${ID}`);
  const bare = fixture({cmd: `${BARE} --add-dir /x`});
  bare.run();
  assert.equal(bare.entries.at(-1).cmd, `${SWAPPED} --add-dir /x --resume ${ID}`);
});

test('래퍼 실행 파일은 래퍼 그대로다', () => {
  const f = fixture({cmd: OLD.replace(/^claude/, '/opt/bin/kadan-claude'), processArgs: OLD});
  f.run();
  assert.equal(f.entries.at(-1).cmd, `${NEW.replace(/^claude/, '/opt/bin/kadan-claude')} --resume ${ID}`);
});

// 재검수 N1: 옵션에 붙은 값이 설정 틀과 서로 뒤바뀐 꼴. 낱말 묶음으로는 차이가 없어 설정 명령(값이 뒤바뀐 것)으로 다시 띄웠다.
test('N1: 다른 옵션의 값이 설정 틀과 달라도 옛 값 그대로다(허용·금지 도구가 뒤바뀌지 않는다)', () => {
  const spawn = 'claude --model {model} --effort {effort} --allowedTools Edit --disallowedTools Read';
  const settings = {...settingsOf(), runners: {...structuredClone(TABLE),
    claude: {...structuredClone(TABLE.claude), spawn, resume: `${spawn} --resume {conversation}`, fork: undefined}}};
  const f = fixture({cmd: `${BARE} --allowedTools Read --disallowedTools Edit`});
  f.run(OPTION, settings);
  assert.equal(f.entries.at(-1).cmd, `${SWAPPED} --allowedTools Read --disallowedTools Edit --resume ${ID}`);
});

test('codex: 모델과 강도 값만 바뀌고 다른 -c 이름=값은 그대로다', () => {
  const f = fixture({cmd: `${OLD_CODEX} -c sandbox_mode=read-only`, openFiles: ROLLOUT});
  f.run(OPTION, settingsOf({worker: {runner: 'codex', model: 'gpt-6-1-sol', effort: 'high'}}));
  assert.equal(f.entries.at(-1).cmd,
    `codex -p lite --model gpt-6-1-sol -c model_reasoning_effort=high -c sandbox_mode=read-only resume ${ID} --no-alt-screen`);
});

test('설정과 모델·강도가 같으면 옛 명령 그대로다(설정 틀에만 있는 옵션이 붙지 않는다)', () => {
  const same = settingsOf({worker: {runner: 'claude', model: 'claude-haiku-5-5', effort: 'low'}});
  const f = fixture({cmd: BARE});
  f.run(OPTION, same);
  const start = f.entries.at(-1);
  assert.equal(start.cmd, `${BARE} --resume ${ID}`);
  assert.equal(start.launchSource, undefined); assert.equal(start.modelFromSettings, true);
});

test('강도 자리: 옛 명령에 없으면 모델 자리 뒤에 넣고, 설정에 강도가 없으면 옛 강도를 두고, 틀에 강도 자리가 없으면 넣지 않는다', () => {
  const inserted = fixture({cmd: 'claude --dangerously-skip-permissions --model claude-haiku-5-5 --add-dir /x'});
  inserted.run();
  const start = inserted.entries.at(-1);
  assert.equal(start.cmd, `claude --dangerously-skip-permissions --model claude-sonnet-5-5 --effort high --add-dir /x --resume ${ID}`);
  assert.equal(start.previousModel, 'claude-haiku-5-5'); assert.equal(start.previousEffort, undefined);

  const noEffort = fixture();
  noEffort.run(OPTION, settingsOf({worker: {runner: 'claude', model: 'claude-sonnet-5-5'}}));
  assert.equal(noEffort.entries.at(-1).cmd, `claude --model claude-sonnet-5-5 --effort low --dangerously-skip-permissions --resume ${ID}`);
  assert.equal(noEffort.entries.at(-1).previousEffort, undefined);

  const agy = fixture({cmd: 'agy --model gemini-old --dangerously-skip-permissions',
    openFiles: [`/h/.gemini/antigravity-cli/conversations/${ID}.db`]});
  agy.run(OPTION, settingsOf({worker: {runner: 'agy', model: 'gemini-new', effort: 'high'}}));
  assert.equal(agy.entries.at(-1).cmd, `agy --model gemini-new --dangerously-skip-permissions --conversation ${ID}`);
});

// 재검수 2의 N2: 낱말 모양만 보고 자리를 찾으면 다른 옵션의 값(`--append-system-prompt`의 값 '--effort')을 강도 옵션으로 오인해
// 그 뒤 낱말(`--allowedTools`)을 강도 값으로 덮어썼다. 지금은 옵션 표로 끝까지 걸어 옵션 자리에서만 찾는다.
test('N2: 다른 옵션의 값이 강도 옵션 이름과 같아도 그 값과 뒤 옵션은 그대로이고, 강도는 모델 자리 뒤에 새로 들어간다', () => {
  const f = fixture({cmd: "claude --model claude-haiku-5-5 --append-system-prompt '--effort' --allowedTools Read"});
  const receipt = f.run();
  assert.equal(f.entries.at(-1).cmd,
    `claude --model claude-sonnet-5-5 --effort high --append-system-prompt --effort --allowedTools Read --resume ${ID}`);
  assert.equal(receipt.modelFromSettings.previousEffort, null);
  assert.equal(f.entries.at(-1).previousEffort, undefined);
});

// N2 인접: 다른 옵션의 값이 '--model'인 꼴은 여기까지 오기 전에 기존 신원 판독(launchIdentityOf)이 모델을 못 읽어 거절한다.
// 끄지 않으므로 그 옵션의 값이 바뀌지 않는다.
test('N2 인접: 다른 옵션의 값이 --model인 명령은 끄기 전에 거절한다(값이 바뀌지 않는다)', () => {
  const f = fixture({cmd: "claude --append-system-prompt '--model' --model claude-haiku-5-5 --effort low"});
  assert.throws(() => f.run(), /등록 실행기·모델을 읽지 못했다/);
  assert.deepEqual(f.log, []);
});

test('끝까지 해석되지 않는 명령은 끄기 전에 거절한다: 모르는 옵션·맨 낱말·`--`', () => {
  const cases = [
    ['모르는 옵션', fixture({cmd: `${OLD} --some-unknown-flag`}), /카단이 모르는 옵션: --some-unknown-flag/],
    // N2 인접: 다른 옵션의 값 '--effort' 뒤의 일반 글자 low는 강도 값이 아니라 맨 낱말이다. 바꾸지 않고 거절한다.
    ['값 뒤의 맨 낱말', fixture({cmd: "claude --append-system-prompt '--effort' low --model claude-haiku-5-5"}),
      /옵션 자리가 아닌 낱말\(하위 명령·첫 프롬프트 등\): low/],
    ['값처럼 보이는 맨 낱말', fixture({cmd: 'claude --append-system-prompt --model X --model claude-haiku-5-5 --effort low'}),
      /옵션 자리가 아닌 낱말\(하위 명령·첫 프롬프트 등\): X/],
    ['첫 프롬프트', fixture({cmd: `${OLD} hello`}), /옵션 자리가 아닌 낱말\(하위 명령·첫 프롬프트 등\): hello/],
    ['`--` 뒤 입력', fixture({cmd: `${OLD} -- hello`}), /`--`/],
  ];
  for (const [name, f, pattern] of cases) {
    assert.throws(() => f.run(), error => {
      assert.match(error.message, pattern, name);
      return true;
    }, name);
    assert.deepEqual(f.log, [], name);
    assert.equal(f.entries.length, 1, name);
  }
  // 모든 거절 문구에 같은 뜻이 붙는다.
  assert.throws(() => fixture({cmd: `${OLD} --some-unknown-flag`}).run(), /모델 자리를 확실히 가릴 수 없어 바꾸지 않는다/);
  // 옵션 표가 없는 실행기는 restart의 대화 다시 열기 자체가 먼저 거절한다. 걷기 함수의 그 갈래는 아래 걷기 함수 시험이 본다.
});

test('표에 있는 옵션은 값에 공백·기호가 있어도 그대로 보존된다', () => {
  const f = fixture({cmd: `${OLD} --add-dir '/work/path with spaces' --append-system-prompt 'literal; text' --allowedTools Read`});
  f.run();
  assert.equal(f.entries.at(-1).cmd,
    `${NEW} --add-dir '/work/path with spaces' --append-system-prompt 'literal; text' --allowedTools Read --resume ${ID}`);
});

test('끝 fork 꼴(갈라 연 역할)도 살아 있는 대화로 resume하며 모델·강도만 바뀐다', () => {
  const f = fixture({cmd: `${OLD} --resume 0197bbbb-1111-4222-8333-444455556666 --fork-session`});
  f.run();
  assert.equal(f.entries.at(-1).cmd, `${NEW} --resume ${ID}`);
});

test('걷기 함수: 옵션 자리와 값 자리를 가르고, 기존 판정 함수의 결과는 그대로다', async () => {
  const {walkKnownOptions, startConversationCertainty, conversationOf} = await import('../src/conversation-ref.mjs');
  assert.deepEqual(walkKnownOptions("/opt/bin/claude --model m --append-system-prompt '--effort' --verbose --add-dir=/x"), {ok: true,
    harness: 'claude', options: [
      {at: 1, name: '--model', valueAt: 2, inline: false},
      {at: 3, name: '--append-system-prompt', valueAt: 4, inline: false},
      {at: 5, name: '--verbose', valueAt: null, inline: false},
      {at: 6, name: '--add-dir', valueAt: null, inline: true},
    ]});
  assert.deepEqual(walkKnownOptions('claude --model m --resume x'), {ok: false, word: '--resume', reason: 'unknown-option'});
  assert.deepEqual(walkKnownOptions('codex -p lite resume x'), {ok: false, word: 'resume', reason: 'bare-word'});
  assert.deepEqual(walkKnownOptions('omo --model m'), {ok: false, word: 'omo', reason: 'unknown-runner'});
  // 값 낱말이 없는 끝 옵션은 예전처럼 '새 대화로 확실함'이다(판정 불변).
  for (const [cmd, certainty] of [['claude --model m --effort low', 'new'], ['claude --model', 'new'], ['claude --model m hello', 'unknown'],
    ['claude --model m -- x', 'unknown'], ['claude --model m --resume x', 'resume'], ['codex -p lite --model m fork x', 'fork'],
    ['claude --verbose=1', 'unknown'], ['omo --model m', 'unknown'], ['agy --model m --dangerously-skip-permissions', 'new']])
    assert.equal(startConversationCertainty(cmd), certainty, cmd);
  assert.deepEqual(conversationOf('claude --model m --resume x'), {conversationMode: 'resume', conversationRef: 'x'});
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
