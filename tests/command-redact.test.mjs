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
import {settingsWith} from './helpers/runner-table.mjs';

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
        throw new Error(`세션이 만들어지자마자 죽었다 — 명령이 실패한 것 같다: ${options.cmd}`);
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
    create: options => { throw new Error(`세션이 만들어지자마자 죽었다 — 명령이 실패한 것 같다: ${options.cmd}`); }};
  const deps = {read: () => entries, record: e => entries.push(e), findTranscript: () => transcript, pendingCards: () => [],
    closeWindow: () => ({}), openWindow: () => ({method: 'manual'}), beforeStop: () => {}};
  assert.throws(() => restartRole({home, role: '비서', session: 'kadan-비서', flags: {}, floor, settings: null, deps}), error => {
    noSecrets(error.message, '비서 restart 실패 문구');
    assert.match(error.message, /명령이 실패한 것 같다: .*시작 명령 생략/);
    assert.match(error.message, /kadan up으로 복원한다/);
    return true;
  });
});

test('withoutCommands: -- 뒤 프롬프트도 지운다', () => {
  const cleaned = withoutCommands(`실패 ${PROMPT} 끝`, `codex --model x -- ${PROMPT}`);
  noSecrets(cleaned, '프롬프트');
});
