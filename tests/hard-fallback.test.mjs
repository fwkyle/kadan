// 어려운 일 작업자 자리(worker-hard)의 대체 후보(fallback['worker-hard']): 저장·비우기·start --fallback·발령 검사·검수자 연결·가져오기.
// 모델 이름은 모두 가짜다. 설정·원장은 격리 홈에만 쓴다. tmux는 시험마다 따로 만든 격리 소켓만 쓴다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  DEFAULT_FAMILIES, blockModel, checkPresetFamilies, launchFor, launchForFallback, launchForHard, readSettings, setFallback, setRole,
} from '../src/runner-settings.mjs';
import {runnersCommand, RUNNERS_USAGE} from '../src/runners-command.mjs';
import {exportPreset, importPreset} from '../src/runner-export.mjs';
import {inspectDispatchRunnerGuard} from '../src/dispatch-runner-guard.mjs';
import {readLedger} from '../src/ledger.mjs';
import {createWallServer} from '../src/wall.mjs';

const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
const choice = (model, effort = 'high') => ({runner: 'codex', model, effort});
const MODELS = ['gpt-norm', 'gpt-hard', 'gpt-hard-2', 'gpt-wfb', 'claude-rev', 'claude-rev-2', 'claude-hard'];

// A: 작업자·검수자·어려운 일 자리가 모두 찬 프리셋(작업자 폴백 gpt-wfb 하나). B: 어려운 일 자리가 빈 프리셋.
function makeHome({active = 'A', hardFallback} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-hardfb-'));
  const settings = {version: 1, revision: 1, activePreset: active, families: DEFAULT_FAMILIES,
    runners: {codex: {spawn: 'codex --model {model} --effort {effort}', models: MODELS.map(model => ({model, efforts: ['high']}))}},
    presets: {
      A: {roles: {worker: choice('gpt-norm'), reviewer: choice('claude-rev'), 'worker-hard': choice('gpt-hard')},
        fallback: {worker: [choice('gpt-wfb')], ...(hardFallback ? {'worker-hard': hardFallback} : {})}},
      B: {roles: {worker: choice('gpt-norm'), reviewer: choice('claude-rev')}},
    }};
  fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify(settings));
  const records = [];
  const record = e => records.push(e);
  const meta = () => ({revision: readSettings(home).revision, reason: '시험', by: 'test', record});
  return {home, settings, records, record, meta};
}
const startsOf = (home, role) => readLedger(home).filter(e => e.kind === 'start' && e.role === role && e.cmd);

test('저장: 자리가 찬 프리셋에서 대체 후보를 저장하고, show에 번호·명령이 보이며, 원장에 fallback 사건이 남는다', () => {
  const f = makeHome();
  runnersCommand(['fallback', 'worker-hard'], {set: 'codex:gpt-hard-2:high,codex:gpt-wfb:high', ...f.meta()}, f);
  assert.deepEqual(readSettings(f.home).presets.A.fallback['worker-hard'], [choice('gpt-hard-2'), choice('gpt-wfb')]);
  assert.deepEqual(readSettings(f.home).presets.A.fallback.worker, [choice('gpt-wfb')], '작업자 목록은 그대로');
  const shown = runnersCommand(['show'], {}, f);
  assert.equal(shown.fallback['worker-hard'].length, 2);
  assert.match(shown.fallback['worker-hard'][0].cmd, /--model gpt-hard-2/);
  const event = f.records.at(-1);
  assert.equal(event.action, 'fallback'); assert.equal(event.role, 'worker-hard');
  assert.deepEqual(event.after, [choice('gpt-hard-2'), choice('gpt-wfb')]);
  // 비우는 것은 언제나 허용한다.
  runnersCommand(['fallback', 'worker-hard'], {set: '', ...f.meta()}, f);
  assert.equal(readSettings(f.home).presets.A.fallback['worker-hard'], undefined);
  assert.match(RUNNERS_USAGE, /fallback <worker\|worker-hard\|/);
});

test('저장: 자리가 비면 거절, 차단 모델(worker로 막음)·중복·모르는 모델·강도 오류도 작업자 폴백과 같은 문구로 거절한다', () => {
  const f = makeHome({active: 'B'});
  const set = (items, meta = f.meta()) => setFallback(f.home, {role: 'worker-hard', items, ...meta});
  assert.throws(() => set([choice('gpt-hard-2')]), /자리가 비어 있어 대체 후보를 둘 수 없다/);
  assert.equal(readSettings(f.home).revision, 1, '거절하면 revision이 그대로');
  setRole(f.home, {role: 'worker-hard', runner: 'codex', model: 'gpt-hard', effort: 'high', ...f.meta()});
  blockModel(f.home, {model: 'gpt-hard-2', roles: 'worker', ...f.meta()});
  assert.throws(() => set([choice('gpt-hard-2')]), /폴백 1번: 정책으로 막은 모델: gpt-hard-2/);
  assert.throws(() => set([choice('gpt-wfb'), choice('gpt-wfb')]), /같은 폴백 항목이 두 번 있다/);
  assert.throws(() => set([choice('no-such-model')]), /폴백 1번: codex에서 고를 수 없는 모델/);
  assert.throws(() => set([{runner: 'codex', model: 'gpt-wfb', effort: 'low'}]), /지원하지 않는 강도/);
  // 작업자 폴백도 같은 문구로 막힌다(같은 검사).
  assert.throws(() => setFallback(f.home, {role: 'worker', items: [choice('gpt-hard-2')], ...f.meta()}), /폴백 1번: 정책으로 막은 모델: gpt-hard-2/);
  set([choice('gpt-wfb')]);
  assert.deepEqual(readSettings(f.home).presets.B.fallback['worker-hard'], [choice('gpt-wfb')]);
  assert.throws(() => set([choice('gpt-wfb')]), /바뀐 것이 없다/);
});

test('비우기: set worker-hard --clear는 같은 변경(한 번의 revision)에서 대체 후보도 지우고, 지운 목록을 기록에 남긴다', () => {
  const f = makeHome({hardFallback: [choice('gpt-hard-2')]});
  const before = readSettings(f.home).revision;
  runnersCommand(['set', 'worker-hard'], {clear: true, ...f.meta()}, f);
  const after = readSettings(f.home);
  assert.equal(after.revision, before + 1);
  assert.equal(after.presets.A.roles['worker-hard'], undefined);
  assert.equal(after.presets.A.fallback['worker-hard'], undefined, '1순위 없이 대체 후보만 남지 않는다');
  assert.deepEqual(after.presets.A.fallback.worker, [choice('gpt-wfb')], '작업자 목록은 그대로');
  const event = f.records.at(-1);
  assert.equal(event.action, 'set'); assert.deepEqual(event.fallbackBefore, [choice('gpt-hard-2')]);
  assert.equal(runnersCommand(['show'], {}, f).fallback['worker-hard'], undefined);
  // 대체 후보가 없던 자리를 비우면 기록에 그 칸이 없다.
  const g = makeHome();
  runnersCommand(['set', 'worker-hard'], {clear: true, ...g.meta()}, g);
  assert.equal('fallbackBefore' in g.records.at(-1), false);
});

test('발령용 명령: 어려운 일 대체 후보 N번은 그 목록에서만 읽고, 자리가 비면 작업자 목록으로 내려가지 않는다', () => {
  const f = makeHome({hardFallback: [choice('gpt-hard-2')]});
  const settings = readSettings(f.home);
  const hard = launchForFallback(settings, 'worker-hard', 1);
  assert.equal(hard.role, 'worker-hard'); assert.equal(hard.fallbackIndex, 1); assert.match(hard.cmd, /--model gpt-hard-2/);
  assert.match(launchForFallback(settings, 'worker', 1).cmd, /--model gpt-wfb/);
  assert.throws(() => launchForFallback(settings, 'worker-hard', 2), /없는 폴백 번호: 2 — 가능: 1\.\.1/);
  const empty = structuredClone(settings);
  delete empty.presets.A.roles['worker-hard'];
  assert.throws(() => launchForFallback(empty, 'worker-hard', 1), /자리가 비어 있어 대체 후보를 쓸 수 없다/);
});

test('계열 경고: 어려운 일 대체 후보도 작업자 후보로 보고 다른 계열 검수자가 없으면 경고한다', () => {
  const preset = {roles: {worker: choice('gpt-norm'), reviewer: choice('claude-rev'), 'worker-hard': choice('gpt-hard')},
    fallback: {'worker-hard': [choice('claude-hard')]}};
  assert.deepEqual(checkPresetFamilies(preset), [`작업자 후보 claude-hard에 맞는 다른 계열 검수자 없음 — 검수자 후보를 추가하세요`]);
  preset.fallback.reviewer = [choice('gpt-wfb')];
  assert.deepEqual(checkPresetFamilies(preset), []);
});

// 발령 검사(세 가지). 세션 명령은 설정이 실제로 만든 명령을 쓴다.
function guardRig() {
  const f = makeHome({hardFallback: [choice('gpt-hard-2')]});
  const doc = () => readSettings(f.home);
  const identityOf = (cmd, model, extra = {}) => ({harness: 'codex', model, launch: {cmd, settingsRevision: 1, ...extra}});
  const check = identity => inspectDispatchRunnerGuard({home: f.home, role: 'r', session: 'kadan-r', profile: 'worker',
    phaseProfile: 'worker', identity, readSettingsFn: doc});
  return {f, doc, identityOf, check};
}

test('발령 (a): 어려운 일 세션이 작업자 폴백 모델이면 거절된다', () => {
  const {doc, identityOf, check} = guardRig();
  const cmd = launchForFallback(doc(), 'worker', 1).cmd;
  const verdict = check(identityOf(cmd, 'gpt-wfb', {difficulty: 'hard', launchSource: 'fallback'}));
  assert.deepEqual([verdict.result, verdict.code], ['reject', 'runner-or-model']);
  assert.match(verdict.message, /어려운 일 작업자 자리/);
});

test('발령 (b): 보통 세션이 어려운 일 폴백 모델이면 거절된다', () => {
  const {doc, identityOf, check} = guardRig();
  const cmd = launchForFallback(doc(), 'worker-hard', 1).cmd;
  const verdict = check(identityOf(cmd, 'gpt-hard-2', {launchSource: 'fallback'}));
  assert.deepEqual([verdict.result, verdict.code], ['reject', 'runner-or-model']);
  assert.match(verdict.message, /worker 기본값/);
});

test('발령 (c): 어려운 일 세션이 어려운 일 폴백 N번이면 fallback 경고로 통과하고 번호를 기록용으로 돌려준다', () => {
  const {f, doc, identityOf, check} = guardRig();
  const cmd = launchForFallback(doc(), 'worker-hard', 1).cmd;
  const verdict = check(identityOf(cmd, 'gpt-hard-2', {difficulty: 'hard', launchSource: 'fallback', fallbackIndex: 1}));
  assert.equal(verdict.result, 'warn'); assert.equal(verdict.code, 'fallback');
  assert.match(verdict.warning, /어려운 일 작업자 자리 폴백 1번\(codex · gpt-hard-2 · high\)/);
  assert.deepEqual(verdict.ledger, {result: 'warn', code: 'fallback', fallbackIndex: 1, settingsRevision: 1});
  // 자리 값(1순위)은 그대로 통과한다.
  assert.deepEqual(check(identityOf(launchForHard(doc()).cmd, 'gpt-hard', {difficulty: 'hard'})), {result: 'pass'});
  // 자리를 비우면 어려운 일 세션은 예전처럼 작업자 값하고만 대조한다: 어려운 일 폴백 모델은 거절.
  runnersCommand(['set', 'worker-hard'], {clear: true, ...f.meta()}, f);
  const gone = check(identityOf(cmd, 'gpt-hard-2', {difficulty: 'hard'}));
  assert.deepEqual([gone.result, gone.code], ['reject', 'runner-or-model']);
  assert.deepEqual(check(identityOf(launchFor(doc(), 'worker').cmd, 'gpt-norm', {difficulty: 'hard'})), {result: 'pass'});
});

test('가져오기·내보내기: 자리가 있으면 어려운 일 대체 후보가 실리고 복원되며, 자리 없는 파일은 전체 거절한다', () => {
  const f = makeHome({hardFallback: [choice('gpt-hard-2')]});
  const data = exportPreset(f.home, {name: 'A'});
  assert.deepEqual(data.preset.fallback['worker-hard'], [choice('gpt-hard-2')]);
  importPreset(f.home, {data, as: 'C', ...f.meta()});
  assert.deepEqual(readSettings(f.home).presets.C.fallback['worker-hard'], [choice('gpt-hard-2')]);
  // 이 기계에서 worker로 막은 모델이 대체 후보에 있으면 가져오기가 거절한다(작업자와 같은 규칙).
  blockModel(f.home, {model: 'gpt-hard-2', roles: 'worker', ...f.meta()});
  assert.throws(() => importPreset(f.home, {data, as: 'D', ...f.meta()}), /막은 모델이 있다.*fallback|막은 모델이 있다.*gpt-hard-2/);
  // 자리 없이 대체 후보만 있는 파일.
  const file = path.join(f.home, 'runner-settings.json');
  const snapshot = fs.readFileSync(file), recorded = f.records.length;
  const orphan = structuredClone(data);
  delete orphan.preset.roles['worker-hard'];
  assert.throws(() => importPreset(f.home, {data: orphan, as: 'E', ...f.meta()}), /파일 형식 오류: 어려운 일 작업자 자리가 비어 있어/);
  assert.deepEqual(fs.readFileSync(file), snapshot); assert.equal(f.records.length, recorded);
  // 빈 목록은 자리 없이도 괜찮다(칸이 만들어지지 않는다).
  const emptyList = structuredClone(data);
  delete emptyList.preset.roles['worker-hard']; emptyList.preset.fallback['worker-hard'] = [];
  assert.doesNotThrow(() => importPreset(f.home, {data: emptyList, as: 'F', ...f.meta()}));
  assert.equal(readSettings(f.home).presets.F.fallback['worker-hard'], undefined);
});

// 실제 CLI + 격리 tmux 소켓. 가짜 codex는 잠들어 있기만 한다.
function cliRig(name, home) {
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexec sleep 60\n', {mode: 0o755});
  const socket = `kadan-hardfb-${name}-${process.pid}`;
  const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, KADAN_HOME: home, KADAN_SOCKET: socket,
    KADAN_WINDOW: 'none', KADAN_FLOOR: 'tmux', KADAN_ALT_CHECK_MS: '0'};
  delete env.TMUX; delete env.TMUX_PANE;
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], {env, encoding: 'utf8', timeout: 15000});
  const start = (role, ...extra) => run('start', role, '--hidden', '--no-prompt', '--profile', 'worker', ...extra);
  const cleanup = () => { console.log(`격리 소켓 kill-server: ${socket}`); spawnSync('tmux', ['-L', socket, 'kill-server'], {env}); };
  return {env, run, start, cleanup};
}
const hasTmux = spawnSync('tmux', ['-V']).status === 0;

test('start --difficulty hard --fallback N: 어려운 일 목록의 N번으로 뜨고 폴백 칸과 difficulty가 함께 남는다', {skip: !hasTmux}, () => {
  const f = makeHome({hardFallback: [choice('gpt-hard-2')]});
  const r = cliRig('ok', f.home);
  try {
    const out = r.start('hf', '--difficulty', 'hard', '--fallback', '1', '--reason', '시험 폴백');
    assert.equal(out.status, 0, out.stderr);
    const [start] = startsOf(f.home, 'hf');
    assert.equal(start.difficulty, 'hard'); assert.equal(start.launchSource, 'fallback');
    assert.equal(start.fallbackIndex, 1); assert.equal(start.fallbackReason, '시험 폴백');
    assert.equal(start.settingsRevision, 1); assert.equal(start.settingsPreset, 'A');
    assert.deepEqual(start.runnerChoice, choice('gpt-hard-2'));
    assert.match(start.cmd, /--model gpt-hard-2/); assert.doesNotMatch(start.cmd, /gpt-wfb/);
    assert.equal(start.roleProfile, 'worker');
    r.run('stop', 'hf');
  } finally { r.cleanup(); }
});

test('start --difficulty hard --fallback: 자리 빔·목록 없음·범위 밖·이유 없음·잘못된 번호는 종료 코드 2이고 작업자 목록으로 내려가지 않는다', {skip: !hasTmux}, () => {
  const f = makeHome();
  const empty = makeHome({active: 'B'});
  const rA = cliRig('badA', f.home), rB = cliRig('badB', empty.home);
  try {
    const cases = [
      [rB, '자리 빔', ['e1', '--difficulty', 'hard', '--fallback', '1', '--reason', '시험'], /자리가 비어 있어 대체 후보를 쓸 수 없다/],
      [rA, '목록 없음', ['e2', '--difficulty', 'hard', '--fallback', '1', '--reason', '시험'], /없는 폴백 번호: 1/],
      [rA, '범위 밖', ['e3', '--difficulty', 'hard', '--fallback', '9', '--reason', '시험'], /없는 폴백 번호: 9/],
      [rA, '이유 없음', ['e4', '--difficulty', 'hard', '--fallback', '1'], /--reason/],
      [rA, '잘못된 번호', ['e5', '--difficulty', 'hard', '--fallback', '0', '--reason', '시험'], /1부터 시작하는 번호/],
      [rA, '--cmd와 함께', ['e6', '--difficulty', 'hard', '--fallback', '1', '--cmd', 'codex --model gpt-hard --effort high'], /함께 쓸 수 없다/],
    ];
    for (const [rig, name, args, pattern] of cases) {
      const out = rig.start(...args);
      assert.equal(out.status, 2, `${name}: ${out.stderr}`); assert.match(out.stderr, pattern, name);
      assert.doesNotMatch(out.stderr, /보통 작업자로 띄운다/, `${name}: 자리가 비어도 보통 작업자로 내려가지 않는다`);
    }
    for (const [home, roles] of [[f.home, ['e2', 'e3', 'e4', 'e5', 'e6']], [empty.home, ['e1']]])
      for (const role of roles) assert.equal(startsOf(home, role).length, 0, role);
  } finally { rA.cleanup(); rB.cleanup(); }
});

test('start --fallback (보통 작업자)는 그대로: 어려운 일 목록이 아니라 작업자 목록을 읽고 difficulty가 없다', {skip: !hasTmux}, () => {
  const f = makeHome({hardFallback: [choice('gpt-hard-2')]});
  const r = cliRig('plain', f.home);
  try {
    const out = r.start('pf', '--fallback', '1', '--reason', '시험');
    assert.equal(out.status, 0, out.stderr);
    const [start] = startsOf(f.home, 'pf');
    assert.match(start.cmd, /--model gpt-wfb/); assert.equal('difficulty' in start, false);
    r.run('stop', 'pf');
  } finally { r.cleanup(); }
});

test('검수자 연결: --for가 어려운 일 폴백 작업자의 실제 시작 기록(모델·계열)으로 다른 계열 검수자를 고른다', {skip: !hasTmux}, () => {
  // 어려운 일 폴백이 검수자 1순위와 같은 계열(claude)이라, 설정의 1순위 값만 보면 같은 계열 검수자가 뽑힌다.
  const f = makeHome({hardFallback: [choice('claude-hard')]});
  const settings = readSettings(f.home);
  settings.presets.A.fallback.reviewer = [choice('gpt-wfb')];
  fs.writeFileSync(path.join(f.home, 'runner-settings.json'), JSON.stringify(settings));
  const r = cliRig('rev', f.home);
  try {
    const worker = r.start('hw', '--difficulty', 'hard', '--fallback', '1', '--reason', '시험');
    assert.equal(worker.status, 0, worker.stderr);
    assert.match(startsOf(f.home, 'hw')[0].cmd, /--model claude-hard/);
    const out = r.run('start', 'rv', '--hidden', '--no-prompt', '--profile', 'reviewer', '--for', 'hw');
    assert.equal(out.status, 0, out.stderr);
    const [review] = startsOf(f.home, 'rv');
    assert.equal(review.launchSource, 'review-for');
    assert.equal(review.reviewFor.model, 'claude-hard'); assert.equal(review.reviewFor.family, 'claude');
    assert.equal(review.reviewFor.reviewerModel, 'gpt-wfb'); assert.equal(review.reviewFor.reviewerFamily, 'gpt');
    assert.equal(review.fallbackIndex, 1);
    assert.ok(review.reviewFor.skipped.some(line => /claude-rev: 작업자와 같은 계열/.test(line)), review.reviewFor.skipped.join('; '));
    r.run('stop', 'rv'); r.run('stop', 'hw');
  } finally { r.cleanup(); }
});

// 화면 저장(/runners/preset-save)은 프리셋 한 벌을 가져오기 경로로 교체한다. 값 저장과 비우기는 한 번의 revision이다.
test('화면 프리셋 저장: 자리와 대체 후보를 함께 저장하고, 비우기(둘 다 지운 초안)는 한 revision에 둘 다 지운다', async () => {
  const f = makeHome();
  const server = createWallServer(() => ({center: null, entries: readLedger(f.home), tree: [],
    ledgerLines: 0, collectedAt: new Date()}), {home: f.home, cacheSec: 0});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  try {
    const token = (await (await fetch(base)).text()).match(/name="token" value="([a-f0-9]+)"/)[1];
    const post = preset => fetch(base + '/runners/preset-save', {method: 'POST',
      headers: {'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', origin: base},
      body: new URLSearchParams({token, preset: 'A', value: JSON.stringify(preset), reason: '화면 저장',
        revision: String(readSettings(f.home).revision)})});
    const withList = structuredClone(readSettings(f.home).presets.A);
    withList.fallback['worker-hard'] = [choice('gpt-hard-2')];
    assert.equal((await post(withList)).status, 200);
    assert.deepEqual(readSettings(f.home).presets.A.fallback['worker-hard'], [choice('gpt-hard-2')]);
    // 차단 모델은 이 기계에서 거절된다.
    blockModel(f.home, {model: 'claude-hard', roles: 'worker', ...f.meta()});
    const blocked = structuredClone(withList);
    blocked.fallback['worker-hard'] = [choice('claude-hard')];
    assert.equal((await post(blocked)).status, 409);
    // 비우기: 자리와 목록을 함께 지운 초안 하나를 저장한다 → revision은 한 번만 오른다.
    const before = readSettings(f.home).revision;
    const cleared = structuredClone(readSettings(f.home).presets.A);
    delete cleared.roles['worker-hard']; delete cleared.fallback['worker-hard'];
    assert.equal((await post(cleared)).status, 200);
    const after = readSettings(f.home);
    assert.equal(after.revision, before + 1);
    assert.equal(after.presets.A.roles['worker-hard'], undefined);
    assert.equal(after.presets.A.fallback['worker-hard'], undefined);
    // 자리만 지우고 목록을 남긴 초안은 거절한다(1순위 없이 후보만 남지 않는다).
    const orphan = structuredClone(withList); delete orphan.roles['worker-hard'];
    assert.equal((await post(orphan)).status, 409);
    assert.equal(readSettings(f.home).revision, before + 1);
  } finally {
    await new Promise(r => server.close(r));
    const l = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {encoding: 'utf8'});
    assert.equal(l.stdout.trim(), '');
    console.log(`검증 서버 종료: PID ${process.pid}, 127.0.0.1:${port}, lsof LISTEN 없음`);
  }
});
