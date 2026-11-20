import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {inspectDispatchRunnerGuard} from '../src/dispatch-runner-guard.mjs';
import {summarizeCommand, describeCommand, describeCommandDiff, withoutCommands} from '../src/command-summary.mjs';
import {restartRole} from '../src/restart.mjs';
import {reopenRole} from '../src/reopen.mjs';
import {resumeSecretary} from '../src/secretary-resume.mjs';
import {tmuxFloor, tmux, sessionDiedMessage, createFailureReason} from '../src/floor-tmux.mjs';
import {spawnSync} from 'node:child_process';
import {settingsWith} from './helpers/runner-table.mjs';
import {makeHerdrFloor, HERDR_REASON_WORDS} from '../src/floor-herdr.mjs';

// Why: 발령 경고·재시작 실패 안내가 역할의 시작 명령 원문을 싣던 길을 막는다(#435 후속).
// 시험의 비밀은 모두 가짜 값이다. 가짜 비밀 세 꼴: 환경변수 앞머리, `-c api_key="…"`, `--` 뒤 프롬프트.
const TOKEN = '가짜토큰값', KEY = '가짜키값', PROMPT = '가짜프롬프트값', MODE = '가짜모드값';
const SECRETS = [TOKEN, KEY, PROMPT, MODE];
const noSecrets = (text, label) => {
  for (const secret of SECRETS) assert.equal(String(text).includes(secret), false, `${label}: ${secret} 노출\n${text}`);
};

const RUNNERS = {claude: {spawn: 'claude --model {model} --effort {effort} --dangerously-skip-permissions'}};
const WORKER = {runner: 'claude', model: 'claude-sonnet-5-5', effort: 'xhigh'};
const settingsDoc = runners => ({version: 1, revision: 7, activePreset: 'B', presets: {B: {roles: {worker: WORKER}}}, runners});
const SESSION_CMD = `env TOKEN=${TOKEN} claude --model claude-sonnet-5-5 --effort high ` +
  `-c api_key="${KEY}" -c sandbox_mode="${MODE}" --dangerously-skip-permissions -- ${PROMPT}`;
// launchIdentityOf는 앞머리 `KEY=값`만 건너뛴다(`env`는 실행기가 아니다)
const SESSION_CMD_ENV = SESSION_CMD.replace('env TOKEN=', 'TOKEN=');
const identity = (cmd, model = 'claude-sonnet-5-5') => ({harness: 'claude', model, launch: {cmd, settingsRevision: 7}});
const guard = (settings, id, extra = {}) => inspectDispatchRunnerGuard({
  home: '/x', role: 'r', session: 'kadan-r', profile: 'worker', identity: id, readSettingsFn: () => settings, ...extra});

test('요약: 실행기·모델·강도와 옵션 이름만 보이고 값·환경변수·프롬프트는 개수로만 센다', () => {
  const s = summarizeCommand(SESSION_CMD_ENV);
  assert.equal(s.harness, 'claude'); assert.equal(s.model, 'claude-sonnet-5-5'); assert.equal(s.effort, 'high');
  assert.deepEqual(s.names, ['-c api_key', '-c sandbox_mode', '--dangerously-skip-permissions']);
  assert.equal(s.others.length, 4); // 환경변수 1 + 설정 값 2 + 프롬프트 1
  const text = describeCommand(SESSION_CMD_ENV);
  noSecrets(text, '요약');
  assert.match(text, /실행기 claude · 모델 claude-sonnet-5-5 · 강도 high/);
  assert.match(text, /그 밖 낱말·값 4개/);
});

test('요약: 읽을 수 없는 명령(셸 결합)은 내용 없이 읽지 못했다고만 말한다', () => {
  const text = describeCommand(`claude --model x; echo ${TOKEN}`);
  noSecrets(text, '셸 결합'); assert.match(text, /읽지 못함/);
  noSecrets(describeCommandDiff(`claude --model x; echo ${TOKEN}`, 'claude --model x'), '셸 결합 차이');
});

test('withoutCommands: 오류 문구 안의 명령 원문과 값 붙은 낱말을 지운다', () => {
  const message = `세션이 만들어지자마자 죽었다 — 명령이 실패한 것 같다: ${SESSION_CMD_ENV}; 낱말 api_key=${KEY}`;
  const cleaned = withoutCommands(message, SESSION_CMD_ENV);
  noSecrets(cleaned, '지운 문구');
  assert.match(cleaned, /명령이 실패한 것 같다: \(시작 명령 생략\)/);
});

test('guard 경고 expected-unreadable: 실행기·모델·강도와 이유만, 명령 원문 0건', () => {
  const settings = settingsDoc({claude: {spawn: `env TOKEN=${TOKEN} claude --model {model} --effort {effort} ` +
    `-c api_key="${KEY}" -- ${PROMPT}`}});
  const result = guard(settings, identity(SESSION_CMD_ENV));
  assert.equal(result.code, 'expected-unreadable');
  noSecrets(result.warning, 'expected-unreadable');
  assert.match(result.warning, /claude · claude-sonnet-5-5 · xhigh/);
  assert.match(result.warning, /not-ai/);
  assert.deepEqual(result.ledger, {result: 'warn', code: 'expected-unreadable', settingsRevision: 7});
});

test('guard 경고 effort-or-args: 다른 옵션 이름은 보이고 값은 0건, 기록 칸 모양은 그대로', () => {
  const result = guard(settingsDoc(RUNNERS), identity(SESSION_CMD_ENV));
  assert.equal(result.code, 'effort-or-args');
  noSecrets(result.warning, 'effort-or-args');
  assert.match(result.warning, /강도 세션 high ↔ 기본값 xhigh/);
  assert.match(result.warning, /세션에만 있는 옵션 이름 -c api_key, -c sandbox_mode/);
  assert.match(result.warning, /그 밖 낱말·값 4개 다름/);
  assert.doesNotMatch(result.warning, /세션 명령:/);
  assert.deepEqual(result.ledger, {result: 'warn', code: 'effort-or-args', settingsRevision: 7});
});

test('guard 거절 줄과 예외 통과 경고: 그대로 둔 줄에도 명령 원문 0건', () => {
  const old = identity(SESSION_CMD_ENV, 'claude-opus-5-5');
  const rejected = guard(settingsDoc(RUNNERS), old);
  assert.equal(rejected.result, 'reject'); assert.equal(rejected.code, 'runner-or-model');
  noSecrets(rejected.message, '거절 줄');
  assert.match(rejected.message, /claude · claude-opus-5-5/);
  const mismatch = guard(settingsDoc(RUNNERS), identity(SESSION_CMD_ENV), {profile: 'worker', phaseProfile: 'reviewer'});
  noSecrets(mismatch.message ?? '', '프로필 불일치 줄');
  const allowed = guard(settingsDoc(RUNNERS), old, {allowOldRunner: '긴급'});
  noSecrets(allowed.warning, '예외 통과 경고');
  const broken = inspectDispatchRunnerGuard({home: '/x', role: 'r', session: 'kadan-r', profile: 'worker', identity: old,
    readSettingsFn: () => { throw new Error('설정 깨짐'); }});
  noSecrets(broken.message, '설정 못 읽음 줄');
});

// 가짜 바닥으로 restart 실패(끈 뒤 새 세션 실패)를 주입한다. 바닥 문구는 실제 tmux 바닥(floor-tmux.mjs)과 같은 꼴로 명령을 싣는다.
const ID = '0197aaaa-1111-4222-8333-444455556666';
const MODEL = 'gpt-6-sol';
const START_CMD = `TOKEN=${TOKEN} codex -p lite --model ${MODEL} -c model_reasoning_effort="low" -c api_key="${KEY}"`;
// 실행 중 프로세스의 인자에는 환경변수 앞머리와 따옴표가 없다
const START_ARGS = `codex -p lite --model ${MODEL} -c model_reasoning_effort=low -c api_key=${KEY}`;
function failingFloor() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-redact-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-redact-user-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-redact-cwd-'));
  const role = 'w', session = 'kadan-w';
  const entries = [{kind: 'start', floor: 'tmux', role, session, cmd: START_CMD, cwd: dir, panePid: '100',
    roleProfile: 'worker', by: 'boss', t: '2026-10-14T00:00:00Z'}];
  const log = [];
  let alive = true;
  const floor = {name: 'tmux', alive: () => alive, pid: () => '100',
    stop: () => { alive = false; },
    create: options => {
      log.push(options);
      if (log.length === 1) { // 첫 호출(restart의 다시 열기)만 실패한다
        throw new Error(sessionDiedMessage(options.cmd));
      }
      alive = true; return {panePid: '200'};
    }};
  const deps = {read: () => entries, record: e => { entries.push({t: '2026-10-14T01:00:00Z', ...e}); },
    pendingCards: () => [], closeWindow: () => ({}), openWindow: () => ({method: 'manual'}),
    paneInfo: () => ({panePid: '100', location: 'kadan-w:@3.%3'}),
    processTree: () => [{pid: '100', ppid: '1', args: '-zsh'}, {pid: '150', ppid: '100', args: START_ARGS}],
    openFiles: pids => pids.flatMap(p => (p === '150' ? [`/h/.codex/sessions/2026/10/14/rollout-2026-10-14T16-35-00-${ID}.jsonl`, `/h/.codex/thread-writer-locks/${ID}.lock`] : [])), processStartedAt: () => 1000, beforeStop: () => {},
    readJson: f => JSON.parse(fs.readFileSync(f, 'utf8')), homeDir};
  return {home, homeDir, role, session, entries, log, floor, deps, setAlive: v => { alive = v; }};
}

test('restart 실패(끈 뒤 새 세션 실패): 명령 원문 0건, kadan reopen 안내 — 안내대로 치면 같은 대화로 열린다', () => {
  const f = failingFloor();
  let error;
  try { restartRole({home: f.home, role: f.role, session: f.session, flags: {}, floor: f.floor, settings: settingsWith(), deps: f.deps}); }
  catch (caught) { error = caught; }
  assert.ok(error, 'restart가 실패해야 한다');
  noSecrets(error.message, 'restart 실패 문구');
  assert.match(error.message, /기존 kadan-w은 종료됐고 새 세션을 만들지 못했다/);
  assert.match(error.message, /다시 열기: kadan reopen w$/);
  assert.doesNotMatch(error.message, /직접 복구|cd /);
  // 안내대로 reopen: 같은 대화 번호로 같은 작업 폴더에 연다(바닥은 이번엔 성공한다).
  f.log.length = 0; f.setAlive(false);
  const deps = {read: () => f.entries, record: e => f.entries.push({t: '2026-10-14T02:00:00Z', ...e}),
    modelChoices: () => new Map([[MODEL, ['low']]]), windowPolicy: () => ({}), openWindow: () => ({method: 'manual'}),
    register: () => ({registered: false, reason: '이미 등록됨'}), pendingCards: () => [], exists: () => true, homeDir: f.homeDir};
  f.floor.create = options => { f.log.push(options); return {panePid: '300'}; };
  reopenRole({home: f.home, role: f.role, session: f.session, floor: f.floor, settings: settingsWith(), deps});
  assert.equal(f.log.length, 1);
  assert.match(f.log[0].cmd, new RegExp(` resume ${ID}\\b`));
  assert.equal(f.log[0].cwd, f.entries[0].cwd);
  assert.equal(f.entries.at(-1).conversationRef, ID);
});

test('비서 restart 실패(끈 뒤 새 세션 실패): 바닥 문구의 명령 원문 0건, kadan up 안내', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-redact-secretary-'));
  const transcript = path.join(home, 'rollout-exact.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({type: 'session_meta', payload: {id: 'exact-conversation', cwd: home}}) + '\n');
  const cmd = `codex --model test-model -c model_reasoning_effort="high" -c api_key="${KEY}" ` +
    '--dangerously-bypass-approvals-and-sandbox';
  const entries = [{kind: 'start', floor: 'tmux', role: '비서', session: 'kadan-비서', panePid: '20', cwd: home,
    roleProfile: 'secretary', cmd, by: '사람'}];
  let pane = {pid: '20'};
  const floor = {name: 'tmux', alive: () => Boolean(pane), pid: () => pane?.pid, stop: () => { pane = null; },
    create: options => { throw new Error(sessionDiedMessage(options.cmd)); }};
  const deps = {read: () => entries, record: e => entries.push(e), findTranscript: () => transcript, pendingCards: () => [],
    closeWindow: () => ({}), openWindow: () => ({method: 'manual'}), beforeStop: () => {}};
  assert.throws(() => restartRole({home, role: '비서', session: 'kadan-비서', flags: {}, floor, settings: null, deps}), error => {
    noSecrets(error.message, '비서 restart 실패 문구');
    assert.match(error.message, /시작 명령이 실패한 것 같다\(실행기 codex · 모델 test-model · 강도 high/);
    assert.match(error.message, /kadan up으로 복원한다/);
    return true;
  });
});

test('withoutCommands: -- 뒤 프롬프트도 지운다', () => {
  const cleaned = withoutCommands(`실패 ${PROMPT} 끝`, `codex --model x -- ${PROMPT}`);
  noSecrets(cleaned, '프롬프트');
});

// ---- 2라운드(검수 exec-77879902): 원천(바닥 오류 문구)에서 명령 원문을 뺀다 ----
// 검수 독립 시험(evidence/output-contract.test.mjs)이 겨눈 상황을 옮겼다. 가짜 값은 공백·인라인·분리 꼴을 모두 포함한다.
const S2 = {env: 'fixture-env-21A', cfg: 'fixture setting with spaces 21B', prompt: 'fixture prompt with spaces 21C',
  inline: 'fixture-inline-21D', split: 'fixture-split-21E', remote: 'fixture remote endpoint 21F'};
const gone = (text, label) => {
  const present = Object.entries(S2).filter(([, value]) => String(text).includes(value)).map(([key]) => key);
  assert.deepEqual(present, [], `${label}: 출력에 남은 가짜 값 종류\n${text}`);
};
const WID = '00000000-0000-4000-8000-000000000021';
const WMODEL = 'codex-fixture';
// 같은 대화 resume 꼬리를 붙일 수 있는 꼴(옵션 값 낱말이 위치 인자처럼 보이지 않게 `--remote`는 따옴표 값 하나)
const CODEX2 = `codex --model ${WMODEL} -c model_reasoning_effort='"high"' -c "api_key=${S2.cfg}" --remote "${S2.remote}"`;

function workerFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-redact2-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-redact2-cwd-'));
  const role = 'fixture-worker', session = 'kadan-fixture-worker';
  const entries = [{kind: 'start', floor: 'tmux', role, session, cwd, cmd: `TOKEN=${S2.env} ${CODEX2}`, panePid: '110', roleProfile: 'worker'}];
  const created = [];
  let alive = true;
  const floor = {name: 'tmux', alive: () => alive, pid: () => '110', stop: () => { alive = false; },
    create: ({cmd: command, cwd: directory}) => { created.push({command, directory}); throw new Error(sessionDiedMessage(command)); }};
  const deps = {read: () => entries, record: entry => entries.push({...entry, t: '2026-11-20T00:00:10Z'}),
    beforeStop: () => {}, pendingCards: () => [], closeWindow: () => ({}),
    paneInfo: () => ({panePid: '110', location: 'fixture:@1.%1'}),
    processTree: () => [{pid: '110', ppid: '1', args: '-zsh'}, {pid: '120', ppid: '110', args: `codex --model ${WMODEL}`}],
    openFiles: pids => pids.includes('120') ? [`/fixture/.codex/sessions/2026/11/20/rollout-2026-11-20T00-00-00-${WID}.jsonl`,
      `/fixture/.codex/thread-writer-locks/${WID}.lock`] : [],
    processStartedAt: () => 1000, modelChoices: () => new Map([[WMODEL, ['high']]]), windowPolicy: () => ({}),
    openWindow: () => ({method: 'hidden'}), register: () => ({}), exists: () => true, homeDir: home};
  return {home, role, session, floor, settings: settingsWith(), deps, cwd, created, entries};
}
const capture = fn => { try { fn(); } catch (error) { return error.message; } return assert.fail('실패를 주입했는데 성공했다'); };

test('2라운드: restart 실패 뒤 안내한 kadan reopen이 다시 실패해도 가짜 값 0건, 같은 대화·실행기·모델 표시', () => {
  const f = workerFixture();
  const restartError = capture(() => restartRole(f));
  gone(restartError, 'restart');
  assert.equal(f.created.length, 1, restartError);
  assert.equal(f.entries.at(-1).conversation, WID);
  const reopenError = capture(() => reopenRole(f));
  assert.equal(f.created.length, 2);
  assert.equal(f.created[0].command, f.created[1].command); // 같은 명령으로 다시 열려 한다
  gone(reopenError, 'reopen');
  assert.match(reopenError, /실행기 codex · 모델 codex-fixture · 강도 high/);
  assert.match(restartError, /다시 열기: kadan reopen fixture-worker$/);
});

test('2라운드: 새 설정을 적용한 비서 restart가 실패해도 가짜 값 0건, kadan up 안내 유지', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-redact2-secretary-'));
  const transcript = path.join(home, 'rollout-fixture.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({type: 'session_meta', payload: {id: WID, cwd: home}}) + '\n');
  const entries = [{kind: 'start', floor: 'tmux', role: '비서', session: 'kadan-비서', panePid: '10', cwd: home,
    roleProfile: 'secretary', cmd: CODEX2}];
  const settings = {version: 1, revision: 19, activePreset: 'A', blocked: [],
    runners: {codex: {spawn: 'codex --model {model} -c model_reasoning_effort="{effort}"',
      models: [WMODEL, 'codex-fixture-new'].map(value => ({model: value, efforts: ['high', 'medium']}))}},
    presets: {A: {label: 'fixture', roles: {secretary: {runner: 'codex', model: 'codex-fixture-new', effort: 'medium'}}}}};
  fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify(settings));
  let alive = true, command;
  const floor = {name: 'tmux', alive: () => alive, pid: () => (alive ? '10' : null), stop: () => { alive = false; },
    create: options => { command = options.cmd; throw new Error(sessionDiedMessage(options.cmd)); }};
  const deps = {read: () => entries, record: entry => entries.push(entry), findTranscript: () => transcript,
    pendingCards: () => [], closeWindow: () => ({}), openWindow: () => ({}), beforeStop: () => {}};
  const error = capture(() => restartRole({home, role: '비서', session: 'kadan-비서', floor, settings: null, deps}));
  assert.match(command, /codex-fixture-new/, '새 설정이 입혀진 명령이어야 한다');
  assert.ok(command.includes(S2.remote), '명령에는 가짜 값이 실제로 들어 있다');
  gone(error, '비서 restart');
  assert.match(error, /kadan up으로 복원한다/);
  assert.match(error, /실행기 codex · 모델 codex-fixture-new · 강도 medium/);
  // kadan up(quickstart.mjs)은 같은 resumeSecretary를 부르고 오류 문구를 그대로 로그·결과에 싣는다.
  const upError = capture(() => resumeSecretary({home, floor, read: deps.read, record: deps.record,
    startNew: () => assert.fail('같은 대화만')}));
  gone(upError, 'kadan up 복원');
});

test('2라운드: 바닥(tmux) 단위 — 세션이 바로 죽는 실제 상황의 오류에 가짜 값 0건', t => {
  const sockDir = fs.mkdtempSync('/tmp/kr-');
  const prior = {socket: process.env.KADAN_SOCKET, tmpdir: process.env.TMUX_TMPDIR};
  process.env.KADAN_SOCKET = `r${process.pid}died`;
  process.env.TMUX_TMPDIR = sockDir;
  t.after(() => {
    tmux(['kill-server']); fs.rmSync(sockDir, {recursive: true, force: true});
    for (const [key, value] of [['KADAN_SOCKET', prior.socket], ['TMUX_TMPDIR', prior.tmpdir]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-redact2-tmux-'));
  // `false`는 인자를 무시하고 바로 끝난다 — 세션이 만들어지자마자 죽는 상황이다.
  const cmd = `TOKEN=${S2.env} false --token=${S2.inline} --api-key ${S2.split} -c "api_key=${S2.cfg}" -- "${S2.prompt}"`;
  const error = capture(() => tmuxFloor.create({session: 'kadan-fixture-died', role: 'fixture-died', cwd, cmd}));
  gone(error, 'tmux 바닥');
  assert.match(error, /세션이 만들어지자마자 죽었다 — 시작 명령이 실패한 것 같다/);
  assert.equal(error, sessionDiedMessage(cmd));
});

test('2라운드: sessionDiedMessage — 기본 셸·읽을 수 없는 명령도 원문 없이', () => {
  assert.match(sessionDiedMessage(undefined), /기본 셸/);
  gone(sessionDiedMessage(`false; echo ${S2.env}`), '셸 결합');
});

test('2라운드: env 앞머리 요약은 실행기·모델·강도를 보이고 값은 숨긴다', () => {
  const text = describeCommand(`env TOKEN=${S2.env} -u FIXTURE_UNSET claude --model claude-fixture --effort high ` +
    `-c api_key="${S2.cfg}" --token=${S2.inline} --api-key ${S2.split} -- "${S2.prompt}"`);
  gone(text, 'env 요약');
  assert.match(text, /실행기 claude · 모델 claude-fixture · 강도 high/);
  assert.match(text, /옵션 이름 .*--token, --api-key/);
  assert.match(describeCommand('/usr/bin/env FOO=bar codex --model m -c model_reasoning_effort="low"'), /실행기 codex · 모델 m · 강도 low/);
  // 복구 가능 판정(launchIdentityOf)의 범위는 그대로: env 앞머리 명령은 여전히 등록 실행기가 아니다.
  assert.equal(summarizeCommand(`env TOKEN=x claude --model m`).harness, 'claude');
});

test('2라운드: OMO의 --thinking이 강도로 보인다', () => {
  assert.match(describeCommand('omo --model omo-fixture --thinking high --no-recommended-models'), /실행기 omo · 모델 omo-fixture · 강도 high/);
});

// ---- 3라운드(재검수 exec-93cd25d4): 모양을 더 찾지 않고 원칙으로 막는다 ----
// 원칙 1: 요약의 실행기·모델 칸은 등록 실행기로 판독된 경우에만 값을 보인다.
// 원칙 2: 바닥은 외부(tmux stderr·herdr RPC) 오류 문구를 싣지 않고 정해진 사유 낱말만 싣는다.
const S3 = {value: 'fixture-env-split-31A', arg: 'fixture arg with spaces 31B', word: 'fixture-word-31C'};
const gone3 = (text, label) => {
  const present = Object.entries(S3).filter(([, value]) => String(text).includes(value)).map(([key]) => key);
  assert.deepEqual(present, [], `${label}: 출력에 남은 가짜 값 종류\n${text}`);
};

test('3라운드 원칙 시험: 등록 실행기가 아닌 첫 낱말은 실행기·모델 칸에 나오지 않는다', () => {
  const commands = [
    `env -S "${S3.value} claude" --model m`,
    `env -S ${S3.value} claude --model m`,
    `env --split-string=${S3.value} claude --model m`,
    `env -x ${S3.value} claude --model m`,
    `${S3.word} --model ${S3.value}`,
    `env ${S3.word} claude --model m`,
    `/opt/${S3.word}/run --model m`,
    `kadan-${S3.word} --model m`,
    `FOO=bar ${S3.word} -c "api_key=${S3.arg}"`,
  ];
  for (const cmd of commands) {
    const summary = summarizeCommand(cmd);
    assert.equal(summary.ok, false, cmd);
    assert.equal(summary.harness, null, `실행기 칸: ${cmd}`);
    assert.equal(summary.model, null, `모델 칸: ${cmd}`);
    gone3(describeCommand(cmd), `describe ${cmd}`);
    gone3(describeCommandDiff(cmd, 'claude --model m'), `diff ${cmd}`);
    assert.match(describeCommand(cmd), /읽지 못함/);
  }
  // 등록 실행기이면 값을 읽는다(모델이 없으면 실행기 이름만, 모델은 모름)
  assert.equal(summarizeCommand('env -i claude --model m').harness, 'claude');
  assert.equal(summarizeCommand('kadan-claude --model m').harness, 'claude');
  const noModel = summarizeCommand('codex --dangerously-bypass-approvals-and-sandbox');
  assert.equal(noModel.harness, 'codex'); assert.equal(noModel.model, null);
});

test('3라운드: 격리 tmux에서 `env -S` 값이 든 명령이 바로 죽어도 가짜 값 0건, 실행기는 "모름"', t => {
  const sockDir = fs.mkdtempSync('/tmp/kr3-');
  const prior = {socket: process.env.KADAN_SOCKET, tmpdir: process.env.TMUX_TMPDIR, tmux: process.env.TMUX, pane: process.env.TMUX_PANE};
  delete process.env.TMUX; delete process.env.TMUX_PANE;
  process.env.KADAN_SOCKET = `r3${process.pid}envs`;
  process.env.TMUX_TMPDIR = sockDir;
  t.after(() => {
    tmux(['kill-server']); fs.rmSync(sockDir, {recursive: true, force: true});
    for (const [key, value] of [['KADAN_SOCKET', prior.socket], ['TMUX_TMPDIR', prior.tmpdir], ['TMUX', prior.tmux], ['TMUX_PANE', prior.pane]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-redact3-tmux-'));
  const cmd = `env -S "${S3.value} --token ${S3.arg}" claude --model m --effort high`;
  const error = capture(() => tmuxFloor.create({session: 'kadan-fixture-envs', role: 'fixture-envs', cwd, cmd}));
  gone3(error, 'tmux 바닥');
  assert.match(error, /세션이 만들어지자마자 죽었다/);
  assert.match(error, /시작 명령을 읽지 못함/);
  assert.doesNotMatch(error, /실행기 /);
});

test('3라운드: tmux new-session 실패 stderr는 어떤 꼴로 명령 낱말을 되풀이해도 싣지 않고 정해진 사유만 말한다', () => {
  const argv = ['claude', '--model', 'm', '-c', `api_key=${S3.arg}`, `--token=${S3.value}`, '--', S3.word];
  const stderrs = [JSON.stringify(argv), argv.join(','), `bad command: ${argv.join(' ')}`, `duplicate session: ${argv.join(' ')}`,
    `can't find window: ${S3.word}`, `usage: new-session ${S3.value}`, ''];
  for (const stderr of stderrs) {
    const reason = createFailureReason({status: 1, stderr});
    gone3(reason, `stderr ${stderr.slice(0, 20)}`);
    assert.match(reason, /tmux 종료 코드 1; 서버 오류 문구는 표시하지 않는다/);
  }
  assert.match(createFailureReason({status: 1, stderr: 'duplicate session: x'}), /^같은 이름의 세션이 이미 있다/);
  assert.match(createFailureReason({status: 1, stderr: `zzz ${S3.value}`}), /^원인 미분류/);
});

test('3라운드: herdr 생성 거절 문구가 인자 배열을 문자열·JSON·따옴표 없는 꼴로 되풀이해도 가짜 값 0건', () => {
  const cmd = `claude --model m -c "api_key=${S3.arg}" --token=${S3.value} -- ${S3.word}`;
  const argv = ['claude', '--model', 'm', '-c', `api_key=${S3.arg}`, `--token=${S3.value}`, '--', S3.word];
  const echoes = {
    'JSON 배열': JSON.stringify(argv),
    '배열 문자열': `[${argv.map(word => `"${word}"`).join(', ')}]`,
    '쉼표 나열': argv.join(','),
    '분리 낱말 줄': argv.join('\n'),
    '러스트 디버그 꼴': `command: ${JSON.stringify(argv)} (invalid)`,
  };
  for (const [label, echo] of Object.entries(echoes)) {
    for (const kind of ['server', 'plain']) {
      const closed = [];
      const rpc = (_socket, method) => {
        if (method === 'workspace.create') return {workspace: {workspace_id: 'w'}, tab: {tab_id: 't'}};
        if (method === 'workspace.close') { closed.push(method); return {type: 'ok'}; }
        if (method === 'layout.apply') {
          if (kind === 'plain') throw new Error(`layout rejected: ${echo}`);
          throw Object.assign(new Error(`invalid_command: ${echo}`), {code: 'invalid_command', delivery: 'not-sent'});
        }
        throw new Error(method);
      };
      const floor = makeHerdrFloor({
        env: {KADAN_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-redact3-herdr-')),
          KADAN_HERDR_SOCKET: path.join(os.homedir(), '.config/herdr/sessions/test/herdr.sock')},
        rpc, entries: () => []});
      const error = capture(() => floor.create({session: 'kadan-fixture-h', role: 'fixture-h', cwd: '/tmp', cmd}));
      gone3(error, `herdr ${label}/${kind}`);
      assert.equal(closed.length, 1, '만든 작업공간은 닫는다');
      assert.match(error, /서버 거절 문구는 표시하지 않는다/);
    }
  }
});

test('3라운드: herdr 자체 거절(고정 문구)은 그대로 보인다', () => {
  const rpc = (_socket, method) => {
    if (method === 'workspace.create') return {workspace: {workspace_id: 'w'}, tab: {tab_id: 't'}};
    if (method === 'layout.apply') return {layout: {tab_id: 't2', root: {pane_id: 'p'}}};
    if (method === 'session.snapshot') return {snapshot: {panes: [{workspace_id: 'w', tab_id: 't2', pane_id: 'p', terminal_id: 'x', cwd: '/elsewhere'}]}};
    if (method === 'workspace.close') return {type: 'ok'};
    throw new Error(method);
  };
  const floor = makeHerdrFloor({env: {KADAN_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-redact3-herdr-')),
    KADAN_HERDR_SOCKET: path.join(os.homedir(), '.config/herdr/sessions/test/herdr.sock')}, rpc, entries: () => []});
  const error = capture(() => floor.create({session: 'kadan-fixture-h', role: 'fixture-h', cwd: '/tmp', cmd: 'claude --model m'}));
  assert.match(error, /KADAN_HERDR_CWD: 생성 경로·터미널 주소 불일치/);
});

// ---- 4라운드(재검수 exec-b3e9b9da): herdr create() 전체가 같은 규칙을 따른다 ----
// 사유 낱말은 카단이 정한 고정 목록에서만 고른다. 외부 문자열은 모양이 맞아도 싣지 않는다.
const S4 = 'fixture-herdr-外-41D';
const herdrEnv = () => ({KADAN_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-redact4-herdr-')),
  KADAN_HERDR_SOCKET: path.join(os.homedir(), '.config/herdr/sessions/test/herdr.sock')});
const OLD_START = {kind: 'start', session: 'kadan-fixture-h', floor: 'herdr', herdrSocket: herdrEnv().KADAN_HERDR_SOCKET,
  herdrTerminalId: 'old-term', herdrWorkspaceId: 'old-ws', panePid: '1'};
const EXTERNAL = {
  '코드 없음': () => new Error(`rejected: ${S4}`),
  '목록 안 코드': () => Object.assign(new Error(`invalid_command: ${S4}`), {code: 'invalid_command'}),
  '목록 밖·식별자 꼴 코드': () => Object.assign(new Error(`${S4}: x`), {code: S4}),
  '봉투 거절(external)': () => Object.assign(new Error(`${S4}: ${S4}`),
    {code: S4, exitCode: 2, delivery: 'not-sent', external: true}),
};
const failingRpc = (phase, make, closed) => (_socket, method) => {
  if (method === 'workspace.close') { closed.push(method); return {type: 'ok'}; }
  if (method === 'session.snapshot') {
    if (phase === 'previous') throw make();
    return {snapshot: {panes: []}};
  }
  if (method === 'workspace.create') {
    if (phase === 'create') throw make();
    return {workspace: {workspace_id: 'w'}, tab: {tab_id: 't'}};
  }
  if (method === 'layout.apply') throw make();
  throw new Error(method);
};

test('4라운드: workspace.create·이전 주소 확인·layout.apply 실패 모두 외부 문구 0건, 사유는 고정 목록 낱말', () => {
  for (const phase of ['create', 'previous', 'layout']) {
    for (const [label, make] of Object.entries(EXTERNAL)) {
      const closed = [];
      const floor = makeHerdrFloor({env: herdrEnv(), rpc: failingRpc(phase, make, closed),
        entries: () => phase === 'previous' ? [OLD_START] : []});
      let caught;
      try { floor.create({session: 'kadan-fixture-h', role: 'fixture-h', cwd: '/tmp', cmd: 'claude --model m'}); }
      catch (error) { caught = error; }
      assert.ok(caught, `${phase}/${label}: 실패해야 한다`);
      assert.equal(String(caught.message).includes(S4), false, `${phase}/${label}: 외부 문구 노출\n${caught.message}`);
      assert.equal(String(caught.code).includes(S4), false, `${phase}/${label}: 외부 code 노출`);
      assert.doesNotMatch(caught.message, /undefined/, `${phase}/${label}`);
      assert.ok(HERDR_REASON_WORDS.includes(caught.code), `${phase}/${label}: 고정 목록 밖 낱말 ${caught.code}`);
      assert.match(caught.message, new RegExp(`^${caught.code}: `));
      const expected = label === '목록 안 코드' ? 'invalid_command' : 'rpc-error';
      assert.equal(caught.code, expected, `${phase}/${label}`);
      assert.equal(closed.length, phase === 'layout' ? 1 : 0, `${phase}/${label}: 작업공간 닫기 시도`);
    }
  }
});

test('4라운드: 닫기 실패는 그대로 덧붙고, 카단이 만든 거절(생성 주소 미확인)은 고정 문구가 보인다', () => {
  const floor = makeHerdrFloor({env: herdrEnv(), entries: () => [],
    rpc: (_socket, method) => {
      if (method === 'workspace.create') return {workspace: {workspace_id: 'w'}, tab: {tab_id: 't'}};
      if (method === 'workspace.close') throw new Error(`close failed ${S4}`);
      throw Object.assign(new Error(`${S4}`), {code: 'invalid_command'});
    }});
  const error = capture(() => floor.create({session: 'kadan-fixture-h', role: 'fixture-h', cwd: '/tmp', cmd: 'claude'}));
  assert.equal(error.includes(S4), false);
  assert.match(error, /^invalid_command: .*방금 만든 작업공간 종료 미확인$/);
  const noIds = makeHerdrFloor({env: herdrEnv(), entries: () => [], rpc: () => ({workspace: {}})});
  assert.match(capture(() => noIds.create({session: 'kadan-fixture-h', role: 'fixture-h', cwd: '/tmp', cmd: 'claude'})),
    /KADAN_HERDR_RESPONSE: 생성 주소 미확인/);
});
