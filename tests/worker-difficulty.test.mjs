// 난이도 칸 PR 1: 실행 모델 설정의 '어려운 일 작업자' 자리(worker-hard)와 kadan start --profile worker --difficulty hard.
// 모델 이름은 모두 가짜다. 설정·원장은 격리 홈에만 쓴다. tmux는 시험마다 따로 만든 격리 소켓만 쓴다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  DEFAULT_FAMILIES, blockModel, launchFor, launchForHard, readSettings, setFallback, setRole,
} from '../src/runner-settings.mjs';
import {runnersCommand} from '../src/runners-command.mjs';
import {exportPreset, importPreset} from '../src/runner-export.mjs';
import {setCompare} from '../src/runner-compare.mjs';
import {inspectDispatchRunnerGuard} from '../src/dispatch-runner-guard.mjs';
import {inspectCardSendIdentity} from '../src/ai-identity.mjs';
import {guardedSend} from '../src/cli-guarded-send.mjs';
import {CardStore} from '../src/card-store.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {createWallServer} from '../src/wall.mjs';

const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
const choice = (model, effort = 'high') => ({runner: 'codex', model, effort});
const MODELS = ['gpt-norm', 'gpt-hard', 'gpt-other', 'claude-rev', 'claude-hard'];

// A: 작업자·검수자·어려운 일 자리가 모두 찬 프리셋. B: 어려운 일 자리가 빈 프리셋.
function makeHome({active = 'A'} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-difficulty-'));
  const settings = {version: 1, revision: 1, activePreset: active, families: DEFAULT_FAMILIES,
    runners: {codex: {spawn: 'codex --model {model} --effort {effort}',
      models: MODELS.map(model => ({model, efforts: ['high']}))}},
    presets: {
      A: {roles: {worker: choice('gpt-norm'), reviewer: choice('claude-rev'), 'worker-hard': choice('gpt-hard')}},
      B: {roles: {worker: choice('gpt-other'), reviewer: choice('claude-rev')}},
    }};
  fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify(settings));
  const records = [];
  const record = e => records.push(e);
  const meta = () => ({revision: readSettings(home).revision, reason: '시험', by: 'test', record});
  return {home, settings, records, record, meta};
}
const startsOf = (home, role) => readLedger(home).filter(e => e.kind === 'start' && e.role === role && e.cmd);

test('설정: worker-hard를 채우면 show에 값과 채워질 명령이 보이고, --clear로 비운다(이미 비면 거절)', () => {
  const f = makeHome({active: 'B'});
  assert.equal(readSettings(f.home).presets.B.roles['worker-hard'], undefined);
  assert.equal(launchForHard(readSettings(f.home)), null);
  let shown = runnersCommand(['show'], {}, f);
  assert.equal(shown.launch['worker-hard'], '비어 있음 — 작업자와 같다');
  runnersCommand(['set', 'worker-hard'], {runner: 'codex', model: 'gpt-hard', effort: 'high', ...f.meta()}, f);
  const hard = launchForHard(readSettings(f.home));
  assert.equal(hard.role, 'worker-hard'); assert.match(hard.cmd, /--model gpt-hard/);
  // 세션 프로필은 worker 하나뿐이다: worker 값은 그대로다.
  assert.match(launchFor(readSettings(f.home), 'worker').cmd, /--model gpt-other/);
  shown = runnersCommand(['show'], {}, f);
  assert.equal(shown.launch['worker-hard'], hard.cmd);
  assert.deepEqual(shown.roles['worker-hard'], choice('gpt-hard'));
  runnersCommand(['set', 'worker-hard'], {clear: true, ...f.meta()}, f);
  assert.equal(readSettings(f.home).presets.B.roles['worker-hard'], undefined);
  assert.throws(() => runnersCommand(['set', 'worker-hard'], {clear: true, ...f.meta()}, f), /바뀐 것 없음/);
  assert.throws(() => runnersCommand(['set', 'worker'], {clear: true, ...f.meta()}, f), /worker-hard 자리에만/);
  assert.throws(() => runnersCommand(['set', 'worker-hard'], {clear: true, runner: 'codex', ...f.meta()}, f), /함께 쓸 수 없다/);
});

test('설정: 검수자와 같은 계열·worker로 막은 모델은 저장 거절, 폴백 목록은 만들지 않는다', () => {
  const f = makeHome({active: 'B'});
  const set = model => setRole(f.home, {role: 'worker-hard', runner: 'codex', model, effort: 'high', ...f.meta()});
  assert.throws(() => set('claude-hard'), /어려운 일 작업자와 검수자가 같은 계열\(claude\)/);
  assert.equal(readSettings(f.home).revision, 1);
  blockModel(f.home, {model: 'gpt-other', roles: 'worker', ...f.meta()});
  assert.throws(() => set('gpt-other'), /정책으로 막은 모델/);
  assert.throws(() => setFallback(f.home, {role: 'worker-hard', items: [choice('gpt-hard')], ...f.meta()}), /폴백이 없다/);
  assert.throws(() => runnersCommand(['fallback', 'worker-hard'], {set: 'codex:gpt-hard:high', ...f.meta()}, f), /폴백이 없다/);
  set('gpt-hard');
  assert.equal(readSettings(f.home).presets.B.roles['worker-hard'].model, 'gpt-hard');
});

test('설정: 내보내기·가져오기에 worker-hard가 실린다', () => {
  const f = makeHome();
  const data = exportPreset(f.home, {name: 'A'});
  assert.deepEqual(data.preset.roles['worker-hard'], choice('gpt-hard'));
  importPreset(f.home, {data, as: 'C', ...f.meta()});
  assert.deepEqual(readSettings(f.home).presets.C.roles['worker-hard'], choice('gpt-hard'));
});

// 발령 검사. 세션 명령은 설정이 실제로 만든 명령을 쓴다.
function guardRig() {
  const f = makeHome();
  const doc = () => readSettings(f.home);
  const identityOf = (cmd, model, extra = {}) => ({harness: 'codex', model, launch: {cmd, settingsRevision: 1, ...extra}});
  const check = (identity, {phaseProfile = 'worker', settings = doc()} = {}) => inspectDispatchRunnerGuard({
    home: f.home, role: 'r', session: 'kadan-r', profile: 'worker', phaseProfile, identity, readSettingsFn: () => settings});
  return {f, doc, identityOf, check};
}

test('발령: 보통 세션은 모델이 어려운 일 자리와 같아도 작업자 기본값과 다르면 거절된다', () => {
  const {doc, identityOf, check} = guardRig();
  const hardCmd = launchForHard(doc()).cmd;
  const verdict = check(identityOf(hardCmd, 'gpt-hard'));
  assert.equal(verdict.code, 'runner-or-model'); assert.equal(verdict.result, 'reject');
  assert.match(verdict.message, /worker 기본값/); assert.doesNotMatch(verdict.message, /어려운 일 작업자 자리/);
  assert.equal(check(identityOf(launchFor(doc(), 'worker').cmd, 'gpt-norm')).result, 'pass');
});

test('발령: 어려운 일 세션은 자리 값과 같으면 예외 없이 통과, 자리 값이 바뀌면 거절, 자리를 비우면 작업자 값과 대조', () => {
  const {f, doc, identityOf, check} = guardRig();
  const hardCmd = launchForHard(doc()).cmd, workerCmd = launchFor(doc(), 'worker').cmd;
  const hard = cmd => identityOf(cmd, cmd.includes('gpt-hard') ? 'gpt-hard' : cmd.includes('gpt-norm') ? 'gpt-norm' : 'gpt-other',
    {difficulty: 'hard'});
  assert.deepEqual(check(hard(hardCmd)), {result: 'pass'});
  // 둘 중 하나면 통과시키지 않는다: 어려운 일 세션이 작업자 값으로 떠 있으면 거절.
  const wrong = check(hard(workerCmd));
  assert.equal(wrong.code, 'runner-or-model'); assert.match(wrong.message, /어려운 일 작업자 자리/);
  assert.match(wrong.message, /--difficulty hard/);
  // 자리 값이 바뀐 뒤: 옛 어려운 일 세션 거절.
  setRole(f.home, {role: 'worker-hard', runner: 'codex', model: 'gpt-other', effort: 'high', ...f.meta()});
  const stale = check(hard(hardCmd));
  assert.equal(stale.code, 'runner-or-model'); assert.match(stale.message, /어려운 일 작업자 자리/);
  // 자리를 비우면 작업자 값과 대조한다.
  runnersCommand(['set', 'worker-hard'], {clear: true, ...f.meta()}, f);
  assert.deepEqual(check(hard(workerCmd)), {result: 'pass'});
  assert.equal(check(hard(hardCmd)).code, 'runner-or-model');
});

test('발령: 어려운 일 세션에는 작업자 폴백 대조를 적용하지 않는다(보통 세션은 폴백 경고)', () => {
  const {f, doc, identityOf, check} = guardRig();
  const fallback = f.settings;
  fallback.presets.A.fallback = {worker: [choice('gpt-other')]};
  fs.writeFileSync(path.join(f.home, 'runner-settings.json'), JSON.stringify(fallback));
  const otherCmd = launchFor(doc(), 'worker').cmd.replace('gpt-norm', 'gpt-other');
  assert.equal(check(identityOf(otherCmd, 'gpt-other')).code, 'fallback', '대조군: 보통 세션은 폴백으로 통과');
  const verdict = check(identityOf(otherCmd, 'gpt-other', {difficulty: 'hard'}));
  assert.equal(verdict.result, 'reject'); assert.equal(verdict.code, 'runner-or-model');
});

test('발령: 검수 카드를 어려운 일 세션에 보내면 profile-phase-mismatch', () => {
  const {doc, identityOf, check} = guardRig();
  const verdict = check(identityOf(launchForHard(doc()).cmd, 'gpt-hard', {difficulty: 'hard'}), {phaseProfile: 'reviewer'});
  assert.equal(verdict.code, 'profile-phase-mismatch'); assert.equal(verdict.result, 'reject');
});

test('발령: 재사용으로 붙은 빈 시작 기록이 있어도 원래 시작 기록의 difficulty를 읽는다', () => {
  const {doc, check} = guardRig();
  const hardCmd = launchForHard(doc()).cmd;
  const base = {kind: 'start', role: 'r', session: 'kadan-r', panePid: '111'};
  const entries = [{...base, cmd: hardCmd, difficulty: 'hard'}, {...base}];
  const identity = inspectCardSendIdentity({entries, session: 'kadan-r', currentPid: '111'});
  assert.equal(identity.launch.difficulty, 'hard');
  assert.deepEqual(check(identity), {result: 'pass'});
  // 반대: 빈 기록이 difficulty를 가져도 cmd 없는 기록은 기준이 아니다.
  const plain = inspectCardSendIdentity({entries: [{...base, cmd: launchFor(doc(), 'worker').cmd}, {...base, difficulty: 'hard'}],
    session: 'kadan-r', currentPid: '111'});
  assert.equal(plain.launch.difficulty, undefined);
});

// 실제 CLI + 격리 tmux 소켓. 가짜 codex는 잠들어 있기만 한다.
function cliRig(name, home) {
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexec sleep 60\n', {mode: 0o755});
  const socket = `kadan-difficulty-${name}-${process.pid}`;
  const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, KADAN_HOME: home, KADAN_SOCKET: socket,
    KADAN_WINDOW: 'none', KADAN_FLOOR: 'tmux', KADAN_ALT_CHECK_MS: '0'};
  delete env.TMUX; delete env.TMUX_PANE;
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], {env, encoding: 'utf8', timeout: 15000});
  const start = (role, ...extra) => run('start', role, '--hidden', '--no-prompt', '--profile', 'worker', ...extra);
  const cleanup = () => { console.log(`격리 소켓 kill-server: ${socket}`); spawnSync('tmux', ['-L', socket, 'kill-server'], {env}); };
  return {env, run, start, cleanup};
}
const hasTmux = spawnSync('tmux', ['-V']).status === 0;

test('start --difficulty hard (비교 모드, 자리 채워짐): 돌려 고르기 없이 자리 값으로 뜨고, 카드가 예외 없이 간다', {skip: !hasTmux}, () => {
  const f = makeHome();
  setCompare(f.home, {enabled: true, presets: 'A,B', ...f.meta()});
  const r = cliRig('fill', f.home);
  try {
    const out = r.start('hw', '--difficulty', 'hard');
    assert.equal(out.status, 0, out.stderr);
    const [start] = startsOf(f.home, 'hw');
    assert.equal(start.difficulty, 'hard'); assert.equal(start.launchSource, 'settings');
    assert.equal(start.settingsPreset, 'A'); assert.equal(start.settingsRevision, readSettings(f.home).revision);
    assert.deepEqual(start.runnerChoice, choice('gpt-hard'));
    assert.match(start.cmd, /--model gpt-hard/);
    assert.equal(start.compareMode, undefined); assert.equal(start.pickId, undefined);
    assert.equal(readLedger(f.home).filter(e => e.kind === 'compare-pick').length, 0);
    // 그 세션에 구현 카드를 --allow-old-runner 없이 보낸다.
    const store = new CardStore(f.home);
    const card = store.create({repo: 'test', id: 'hw-card', repoPath: f.home, body: '# 시험'});
    store.update(card.key, {status: 'assigned', role: 'hw', board: 'test', scope: '시험', rallyId: 'test',
      rallyTitle: '난이도', rallyRound: '1', rallyStep: 'implementation'}, {revision: 1, note: '시험 배정'});
    const sent = guardedSend({floor: {name: 'fake', alive: () => true, pid: () => String(start.panePid), send: () => ({})},
      session: start.session, role: 'hw', message: '시험', taskId: card.id, recordedPid: String(start.panePid),
      env: r.env, readEntries: () => readLedger(f.home), record: e => appendLedger(e, f.home), saveBody: () => {}});
    assert.ok(sent, '발령이 거절되지 않았다');
    // 살아 있는 세션 재사용은 거절한다.
    const again = r.start('hw', '--difficulty', 'hard');
    assert.equal(again.status, 2); assert.match(again.stderr, /새로 띄울 때만/);
    r.run('stop', 'hw');
  } finally { r.cleanup(); }
});

test('start --difficulty hard (비교 모드, 자리 빔): 안내 한 줄만 내고 평소처럼 예약을 만들며 difficulty는 없다', {skip: !hasTmux}, () => {
  const f = makeHome({active: 'B'});
  setCompare(f.home, {enabled: true, presets: 'A,B', ...f.meta()});
  const r = cliRig('empty', f.home);
  try {
    const out = r.start('hw', '--difficulty', 'hard');
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stderr, /어려운 일 작업자 자리가 비어 있어 보통 작업자로 띄운다/);
    const [start] = startsOf(f.home, 'hw');
    assert.equal('difficulty' in start, false);
    assert.equal(start.compareMode, true);
    assert.equal(readLedger(f.home).filter(e => e.kind === 'compare-pick').length, 1);
    r.run('stop', 'hw');
  } finally { r.cleanup(); }
});

test('start --difficulty: normal은 옵션 없음과 같고, 재사용·다른 프로필·--cmd·--fallback·--for·모르는 값은 거절한다', {skip: !hasTmux}, () => {
  const f = makeHome();
  const r = cliRig('misuse', f.home);
  try {
    const normal = r.start('nw', '--difficulty', 'normal');
    assert.equal(normal.status, 0, normal.stderr);
    const [start] = startsOf(f.home, 'nw');
    assert.equal('difficulty' in start, false); assert.match(start.cmd, /--model gpt-norm/);
    const reuse = r.start('nw', '--difficulty', 'hard');
    assert.equal(reuse.status, 2); assert.match(reuse.stderr, /새로 띄울 때만/);
    const bad = [
      ['모르는 값', ['hw1', '--hidden', '--no-prompt', '--profile', 'worker', '--difficulty', 'extreme'], /normal 또는 hard/],
      ['다른 프로필', ['hw2', '--hidden', '--no-prompt', '--profile', 'reviewer', '--difficulty', 'hard'], /--profile worker에서만/],
      ['--cmd', ['hw3', '--hidden', '--no-prompt', '--profile', 'worker', '--difficulty', 'hard', '--cmd', 'codex --model gpt-hard --effort high'], /함께 쓸 수 없다/],
      ['--fallback', ['hw4', '--hidden', '--no-prompt', '--profile', 'worker', '--difficulty', 'hard', '--fallback', '1', '--reason', '시험'], /함께 쓸 수 없다/],
      ['--for', ['hw5', '--hidden', '--no-prompt', '--profile', 'worker', '--difficulty', 'hard', '--for', 'nw'], /함께 쓸 수 없다/],
    ];
    for (const [name, args, pattern] of bad) {
      const out = r.run('start', ...args);
      assert.equal(out.status, 2, `${name}: ${out.stderr}`); assert.match(out.stderr, pattern, name);
    }
    for (const role of ['hw1', 'hw2', 'hw3', 'hw4', 'hw5']) assert.equal(startsOf(f.home, role).length, 0, role);
    r.run('stop', 'nw');
  } finally { r.cleanup(); }
});

test('대시보드: 프리셋 저장이 worker-hard 값을 지우지 않고, 실행 모델 화면이 그대로 그려진다', async () => {
  const f = makeHome();
  const server = createWallServer(() => ({center: null, entries: readLedger(f.home), tree: [],
    ledgerLines: 0, collectedAt: new Date()}), {home: f.home, cacheSec: 0});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    const token = (await page.text()).match(/name="token" value="([a-f0-9]+)"/)[1];
    const preset = structuredClone(readSettings(f.home).presets.A);
    preset.label = '이름만 바꿈';
    const response = await fetch(base + '/runners/preset-save', {method: 'POST',
      headers: {'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', origin: base},
      body: new URLSearchParams({token, preset: 'A', value: JSON.stringify(preset), revision: '1', reason: '화면 저장'})});
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(readSettings(f.home).presets.A.roles['worker-hard'], choice('gpt-hard'));
    assert.equal((await fetch(base)).status, 200);
  } finally {
    await new Promise(r => server.close(r));
    const listeners = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {encoding: 'utf8'});
    assert.equal(listeners.stdout.trim(), '');
    console.log(`검증 서버 종료: PID ${process.pid}, 127.0.0.1:${port}, lsof LISTEN 없음`);
  }
});

// 검수 F1: 가져오기·화면 프리셋 저장이 fallback.worker-hard를 저장하면 show가 깨졌다.
test('가져오기: fallback.worker-hard는 전체 거절하고 설정·원장이 그대로, 정상 프리셋은 성공한다', () => {
  const f = makeHome();
  const file = path.join(f.home, 'runner-settings.json');
  const before = fs.readFileSync(file);
  const data = exportPreset(f.home, {name: 'A'});
  const bad = structuredClone(data);
  bad.preset.fallback = {'worker-hard': [choice('gpt-other')]};
  assert.throws(() => importPreset(f.home, {data: bad, as: 'C', ...f.meta()}), /파일 형식 오류: 어려운 일 작업자 자리는 폴백이 없다/);
  assert.throws(() => importPreset(f.home, {data: bad, as: 'A', replace: true, ...f.meta()}), /폴백이 없다/);
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(f.records.length, 0);
  importPreset(f.home, {data, as: 'C', ...f.meta()});
  assert.deepEqual(readSettings(f.home).presets.C.roles['worker-hard'], choice('gpt-hard'));
  assert.equal(runnersCommand(['show'], {}, f).launch['worker-hard'] != null, true);
});

test('화면 프리셋 저장: fallback.worker-hard는 거절되고 설정이 그대로, 정상 저장은 성공한다', async () => {
  const f = makeHome();
  const file = path.join(f.home, 'runner-settings.json');
  const server = createWallServer(() => ({center: null, entries: readLedger(f.home), tree: [],
    ledgerLines: 0, collectedAt: new Date()}), {home: f.home, cacheSec: 0});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  try {
    const token = (await (await fetch(base)).text()).match(/name="token" value="([a-f0-9]+)"/)[1];
    const post = (preset, revision) => fetch(base + '/runners/preset-save', {method: 'POST',
      headers: {'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', origin: base},
      body: new URLSearchParams({token, preset: 'A', value: JSON.stringify(preset), revision: String(revision), reason: '화면 저장'})});
    const bad = structuredClone(readSettings(f.home).presets.A);
    bad.fallback = {'worker-hard': [choice('gpt-other')]};
    const before = fs.readFileSync(file);
    assert.equal((await post(bad, 1)).status, 409);
    assert.deepEqual(fs.readFileSync(file), before);
    const good = structuredClone(readSettings(f.home).presets.A); good.label = '정상';
    assert.equal((await post(good, 1)).status, 200);
    assert.equal(readSettings(f.home).presets.A.fallback?.['worker-hard'], undefined);
  } finally {
    await new Promise(r => server.close(r));
    const l = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {encoding: 'utf8'});
    assert.equal(l.stdout.trim(), '');
    console.log(`검증 서버 종료: PID ${process.pid}, 127.0.0.1:${port}, lsof LISTEN 없음`);
  }
});
