import './helpers/isolated-home.mjs';
import test from 'node:test';
import {stopChild} from './helpers/child-cleanup.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {seniorCommand, seniorCommandLabel, LIMIT_PATTERN} from '../src/senior.mjs';
import {blockModel, initSettings, readSettings, setRole, setRunner, setRunnerModel, setSeniors} from '../src/runner-settings.mjs';
import {runnersCommand} from '../src/runners-command.mjs';
import {CardStore} from '../src/card-store.mjs';
import {readLedger} from '../src/ledger.mjs';

// 시니어 2명 등록 + 등록된 전원에게 동시에 묻기(2026-10-22 [kyle] 승인). 실제 모델은 부르지 않고 가짜 spawn만 쓴다.
// 호출 시험은 헤드리스 길(senior-mode headless)의 codex 두 명으로 본다: 헤드리스는 codex 스크립트만 부르고, agy가 등록돼 있으면
// 아무도 부르지 않는다(2026-11-18 [kyle]). codex + agy 대화창 혼합은 tests/senior-agy-command.test.mjs가 본다.
const models = [{slug: 'gpt-6-astra', supported_reasoning_levels: ['low', 'high'].map(effort => ({effort}))},
  {slug: 'gpt-6-sol', supported_reasoning_levels: ['low', 'high'].map(effort => ({effort}))}];
const readCodexModels = () => ({models});
const BOUND = 'agy --agent kadan-noexec --model {model} --print-timeout 90s --output-format json --print {prompt}';
const ASTRA = {runner: 'codex', model: 'gpt-6-astra', effort: 'high'}, SOL = {runner: 'codex', model: 'gpt-6-sol', effort: 'low'};
const ARGON = {runner: 'agy', model: 'gemini-4-argon-medium'};

function fixture({seniors = [ASTRA, SOL]} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-senior-two-'));
  fs.writeFileSync(path.join(home, 'senior-mode'), 'headless\n');
  const repo = path.join(home, 'repo'); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(home, 'agent-runners.json'), JSON.stringify({runners: [{id: 'codex', spawn: 'codex --model {model} -c model_reasoning_effort="{effort}"'}]}));
  const records = [];
  const meta = revision => ({revision, by: 'kyle', reason: '시험', record: e => records.push(e), readCodexModels});
  initSettings(home, {by: 'kyle', reason: '시작', record: () => {}});
  setRunner(home, {runner: 'agy', spawn: 'agy --model {model}', table: {execField: 'response'}, ...meta(1)});
  setRunnerModel(home, {runner: 'agy', model: ARGON.model, efforts: '', ...meta(2)});
  setRunnerModel(home, {runner: 'agy', model: 'gemini-3.8-flash-high', efforts: '', ...meta(3)});
  setSeniors(home, {items: seniors, ...meta(4)});
  // 묶기 문법을 어긴 틀은 저장 API가 거절하므로, 시험용 exec 틀은 파일에 직접 둔다.
  const file = path.join(home, 'runner-settings.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')); raw.runners.agy.exec = BOUND; fs.writeFileSync(file, JSON.stringify(raw));
  new CardStore(home).create({repo: 'qa', id: 'card-a', repoPath: repo, body: '# 시험 카드\n'});
  const calls = [];
  // 가짜 호출: 모두 senior.sh다. 모델(KADAN_SENIOR_MODEL)로 두 시니어를 가르고 behavior[모델]이 결과를 정한다.
  const behavior = {'gpt-6-astra': {}, 'gpt-6-sol': {}};
  const fake = async (command, opts) => {
    const model = opts.env.KADAN_SENIOR_MODEL;
    calls.push({model, command, env: opts.env, cwd: opts.cwd});
    const b = behavior[model] ?? {};
    if (b.gate) await b.gate;
    if (b.status) return {status: b.status, stdout: b.stdout ?? '', stderr: b.stderr ?? ''};
    fs.writeFileSync(path.join(opts.env.KADAN_SENIOR_DIR, 'result.txt'), `결론: ${model} 답`);
    return {status: 0, stderr: '', stdout: ''};
  };
  const run = (flags = {}, more = {}) => seniorCommand(['qa/card-a'], {question: '바꿀까?', ...flags}, {home, by: 'qa-슈퍼감독', env: {PATH: process.env.PATH}, readCodexModels, spawn: fake, ...more});
  const advices = () => readLedger(home).filter(e => e.kind === 'advice');
  return {home, repo, calls, behavior, run, advices, meta};
}

test('설정 모양: 옛 단일 객체는 1명 목록으로 읽고, 한 명 등록은 목록을 그 한 명으로 바꾼다', () => {
  const f = fixture({seniors: [ASTRA]});
  const file = path.join(f.home, 'runner-settings.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.presets[raw.activePreset].roles.senior = {runner: 'codex', model: 'gpt-6-sol', effort: 'low'};
  fs.writeFileSync(file, JSON.stringify(raw));
  const settings = readSettings(f.home);
  assert.deepEqual(settings.presets[settings.activePreset].roles.senior, [{runner: 'codex', model: 'gpt-6-sol', effort: 'low'}]);
  setSeniors(f.home, {items: [ASTRA, ARGON], ...f.meta(settings.revision)});
  setRole(f.home, {role: 'senior', runner: 'codex', model: 'gpt-6-astra', effort: 'low', ...f.meta(settings.revision + 1)});
  const next = readSettings(f.home);
  assert.deepEqual(next.presets[next.activePreset].roles.senior, [{runner: 'codex', model: 'gpt-6-astra', effort: 'low'}]);
});

test('설정 저장: 3명·같은 실행기+모델 중복·빈 목록·허용 밖 실행기는 거절하고 설정을 바꾸지 않는다', () => {
  const f = fixture();
  const revision = readSettings(f.home).revision;
  const third = {runner: 'agy', model: 'gemini-3.8-flash-high'};
  assert.throws(() => setSeniors(f.home, {items: [ASTRA, ARGON, third], ...f.meta(revision)}), /최대 2명/);
  assert.throws(() => setSeniors(f.home, {items: [ASTRA, {...ASTRA, effort: 'low'}], ...f.meta(revision)}), /같은 실행기·모델 시니어가 두 번/);
  assert.throws(() => setSeniors(f.home, {items: [], ...f.meta(revision)}), /시니어 목록 필요/);
  setRunner(f.home, {runner: 'devin', spawn: 'devin --model {model}', table: {}, ...f.meta(revision)});
  setRunnerModel(f.home, {runner: 'devin', model: 'x', efforts: '', ...f.meta(revision + 1)});
  assert.throws(() => setSeniors(f.home, {items: [ASTRA, {runner: 'devin', model: 'x'}], ...f.meta(revision + 2)}), /시니어 2번: .*안전하게 묶을 수 있는 실행기/);
  assert.equal(readSettings(f.home).revision, revision + 2);
});

test('kadan runners set senior --set: 두 명을 한 번에 등록하고, 3개·중복·--runner와 섞기는 거절한다', t => {
  const f = fixture({seniors: [ASTRA]});
  // runnersCommand는 codex 모델 목록을 파일에서 읽는다: 이 기계의 캐시에 기대지 않고 시험용 파일을 가리킨다(CI에는 없다).
  const cache = path.join(f.home, 'models_cache.json'), before = process.env.KADAN_CODEX_MODELS_CACHE;
  fs.writeFileSync(cache, JSON.stringify({models}));
  process.env.KADAN_CODEX_MODELS_CACHE = cache;
  t.after(() => { if (before === undefined) delete process.env.KADAN_CODEX_MODELS_CACHE; else process.env.KADAN_CODEX_MODELS_CACHE = before; });
  const meta = () => ({home: f.home, by: 'kyle', record: () => {}});
  const revision = () => String(readSettings(f.home).revision);
  const set = flags => runnersCommand(['set', 'senior'], {revision: revision(), reason: '시험', ...flags}, meta());
  const saved = set({set: 'codex:gpt-6-astra:high,agy:gemini-4-argon-medium'});
  assert.deepEqual(saved.presets[saved.activePreset].roles.senior, [ASTRA, ARGON]);
  assert.throws(() => set({set: 'codex:gpt-6-astra:high,agy:gemini-4-argon-medium,agy:gemini-3.8-flash-high'}), /최대 2명/);
  assert.throws(() => set({set: 'codex:gpt-6-astra:high,codex:gpt-6-astra:low'}), /두 번/);
  assert.throws(() => set({set: 'codex:gpt-6-astra:high', runner: 'codex', model: 'gpt-6-sol'}), /함께 쓰지 않는다/);
  const show = runnersCommand(['show'], {}, meta());
  assert.equal(show.launch.senior, seniorCommandLabel([ASTRA, ARGON]));
  assert.match(show.launch.senior, /gpt-6-astra.*codex exec.* \+ agy 대화창 · 모델 gemini-4-argon-medium/);
  assert.ok(!show.launch.senior.includes('exec 틀'), 'agy는 exec 틀로 부르지 않는다');
});

test('둘 다 ok: 칸 2개·원장 2줄·같은 askId, 시니어마다 증거 폴더와 adviceId가 따로다', async () => {
  const f = fixture();
  const r = await f.run();
  assert.equal(r.answers.length, 2); assert.equal(f.calls.length, 2);
  assert.deepEqual(r.answers.map(a => [a.runner, a.model, a.effort, a.status]), [['codex', 'gpt-6-astra', 'high', 'ok'], ['codex', 'gpt-6-sol', 'low', 'ok']]);
  assert.deepEqual(r.answers.map(a => a.answer), ['결론: gpt-6-astra 답', '결론: gpt-6-sol 답']);
  assert.ok(f.calls.every(call => /senior\.sh'$/.test(call.command)));
  const entries = f.advices();
  assert.equal(entries.length, 2);
  assert.deepEqual(new Set(entries.map(e => e.askId)), new Set([r.askId]));
  assert.equal(new Set(entries.map(e => e.adviceId)).size, 2);
  assert.deepEqual(entries.map(e => [e.seniorIndex, e.seniorCount, e.reason]), [[1, 2, 'ok'], [2, 2, 'ok']]);
  assert.deepEqual(r.answers.map(a => a.adviceId).sort(), entries.map(e => e.adviceId).sort());
  const dirs = r.answers.map(a => a.evidencePath);
  assert.deepEqual(dirs, [path.join(f.home, 'advice', r.askId, '1-codex-gpt-6-astra'), path.join(f.home, 'advice', r.askId, '2-codex-gpt-6-sol')]);
  assert.equal(f.calls[0].env.KADAN_SENIOR_DIR, dirs[0]); assert.equal(f.calls[1].env.KADAN_SENIOR_DIR, dirs[1]);
  for (const dir of dirs) assert.ok(fs.existsSync(path.join(dir, 'input.txt')) && fs.existsSync(path.join(dir, 'stderr.txt')));
  assert.ok(!('answer' in r), '옛 단일 answer 칸은 없다');
});

test('하나가 429면 그 칸만 한도, 나머지는 답을 돌려주고 재시도 없이(호출 2회) 성공으로 끝난다', async () => {
  for (const [text, where] of [['HTTP 429 Too Many Requests', 'stderr'], ['You hit your Usage Limit', 'stdout'], ['quota exceeded', 'stderr'], ['Rate Limit reached', 'stderr']]) {
    const f = fixture();
    f.behavior['gpt-6-astra'] = {status: 1, [where]: text};
    const r = await f.run();
    assert.deepEqual(r.answers.map(a => [a.model, a.status, a.reason]), [['gpt-6-astra', '한도', 'limit'], ['gpt-6-sol', 'ok', 'ok']], text);
    assert.equal(r.answers[0].answer, undefined); assert.equal(r.answers[1].answer, '결론: gpt-6-sol 답');
    assert.equal(f.calls.length, 2, '재시도 없음');
    assert.deepEqual(f.advices().map(e => e.reason), ['limit', 'ok']);
  }
  assert.ok(LIMIT_PATTERN.test('429') && !LIMIT_PATTERN.test('connection reset'));
});

test('한도 글이 없는 실패는 한도가 아니라 실패(call-failed)이고, 종료 코드는 0이다(다른 칸이 ok)', async () => {
  const f = fixture();
  f.behavior['gpt-6-sol'] = {status: 2, stderr: 'boom'};
  const r = await f.run();
  assert.deepEqual(r.answers.map(a => a.status), ['ok', '실패(call-failed)']);
  assert.equal(f.calls.length, 2);
});

test('둘 다 실패하면 종료 코드 1이고 칸마다 이유와 증거 경로가 오류 글에 있다(재시도 없음)', async () => {
  const f = fixture();
  f.behavior['gpt-6-astra'] = {status: 1, stderr: 'rate limit'}; f.behavior['gpt-6-sol'] = {status: 3, stderr: 'boom'};
  await assert.rejects(f.run(), error => error.exitCode === 1 && /\[codex\/gpt-6-astra\] 자문 실패\(limit\)/.test(error.message)
    && /\[codex\/gpt-6-sol\] 자문 실패\(call-failed\)/.test(error.message) && error.answers.length === 2 && Boolean(error.askId));
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.advices().map(e => e.reason), ['limit', 'call-failed']);
});

test('덮어쓰기: 등록된 시니어를 고르면 그 한 명만 부르고, 등록 밖은 등록 목록을 보이는 오류다', async () => {
  const f = fixture();
  const r = await f.run({model: 'gpt-6-sol'});
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].model, 'gpt-6-sol'); assert.equal(r.answers.length, 1);
  const r2 = await f.run({runner: 'codex', model: 'gpt-6-astra', effort: 'low'});
  assert.equal(f.calls.length, 2); assert.equal(r2.answers[0].effort, 'low');
  await assert.rejects(f.run({model: 'gemini-3.8-flash-high'}), /등록된 시니어가 아니다: gemini-3.8-flash-high — 등록된 시니어: codex\/gpt-6-astra\/high, codex\/gpt-6-sol\/low/);
  await assert.rejects(f.run({runner: 'codex', model: 'gemini-4-argon-medium'}), /등록된 시니어가 아니다/);
  assert.equal(f.calls.length, 2);
});

test('--effort는 부르는 모델마다 검사한다: 지원하지 않는 강도면 아무도 부르지 않고, 받으면 부르는 전원의 강도가 바뀐다', async () => {
  const f = fixture();
  await assert.rejects(f.run({effort: 'ultra'}), /지원하지 않는 강도: ultra/);
  assert.equal(f.calls.length, 0); assert.deepEqual(f.advices(), []);
  const r = await f.run({effort: 'low'});
  assert.equal(f.calls.length, 2); assert.deepEqual(r.answers.map(a => a.effort), ['low', 'low']);
  assert.deepEqual(f.calls.map(call => call.env.KADAN_SENIOR_EFFORT), ['low', 'low']);
  assert.ok(r.answers.every(a => a.note === undefined));
});

test('헤드리스에서 agy가 함께 등록돼 있으면 codex도 부르지 않고 증거 폴더도 만들지 않는다(agy는 대화창으로만 부른다)', async () => {
  const f = fixture({seniors: [ASTRA, ARGON]});
  await assert.rejects(f.run(), /헤드리스 시니어.*codex만 부른다.*agy\/gemini-4-argon-medium.*headless-agy/);
  await assert.rejects(f.run({model: 'gpt-6-astra'}), /headless-agy/, 'codex만 골라도 같다');
  assert.equal(f.calls.length, 0); assert.deepEqual(f.advices(), []); assert.equal(fs.existsSync(path.join(f.home, 'advice')), false);
});

test('동시성: 지연시킨 가짜 호출 둘이 한꺼번에 진행 중이다(시간 단언 없음)', async () => {
  const f = fixture();
  let release; const gate = new Promise(resolve => { release = resolve; });
  f.behavior['gpt-6-astra'] = {gate}; f.behavior['gpt-6-sol'] = {gate};
  const pending = f.run();
  for (let i = 0; i < 50 && f.calls.length < 2; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 2, '첫 호출이 끝나기 전에 둘째도 시작했다');
  assert.equal(f.advices().length, 0, '아직 아무도 끝나지 않았다');
  release();
  const r = await pending;
  assert.deepEqual(r.answers.map(a => a.status), ['ok', 'ok']);
});

test('신호(SIGTERM)로 끊기면 진행 중이던 시니어마다 interrupted 줄이 남는다', async t => {
  const f = fixture();
  const script = path.join(f.home, 'child.mjs'), ready = path.join(f.home, 'ready');
  fs.writeFileSync(script, `import fs from 'node:fs';
import {seniorCommand} from ${JSON.stringify(new URL('../src/senior.mjs', import.meta.url).href)};
let started = 0;
setInterval(() => {}, 1000); // 끝나지 않는 가짜 호출만으로는 프로세스가 살아 있지 않다
const spawn = () => { if (++started === 2) fs.writeFileSync(${JSON.stringify(ready)}, 'x'); return new Promise(() => {}); };
await seniorCommand(['qa/card-a'], {question: '바꿀까?'}, {home: ${JSON.stringify(f.home)}, by: 'qa-슈퍼감독', env: {PATH: process.env.PATH}, spawn,
  readCodexModels: () => ({models: ${JSON.stringify(models)}})});
`);
  const child = spawn(process.execPath, [script], {env: {...process.env, KADAN_HOME: f.home}, stdio: 'ignore'});
  t.after(() => stopChild(child));
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({code, signal})));
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(ready), '두 호출이 모두 시작되지 않았다');
  child.kill('SIGTERM');
  assert.equal((await exited).code, 143);
  const entries = f.advices();
  assert.deepEqual(entries.map(e => [e.reason, e.seniorIndex]), [['interrupted', 1], ['interrupted', 2]]);
  assert.equal(new Set(entries.map(e => e.askId)).size, 1);
});

// 검수 F1·F2(2026-10-22): 저장 때만 검사하던 틈. 호출 직전에도 같은 검사를 하고, 하나라도 걸리면 아무도 부르지 않는다.
const rejectedWithoutCalls = async (f, flags, pattern) => {
  await assert.rejects(f.run(flags), pattern);
  assert.equal(f.calls.length, 0, '호출 0회'); assert.deepEqual(f.advices(), []);
  assert.equal(fs.existsSync(path.join(f.home, 'advice')), false, '증거 폴더도 없다');
};
const block = (f, model, roles) => blockModel(f.home, {model, roles, ...f.meta(readSettings(f.home).revision)});

test('F1: 등록한 뒤 역할별 block(senior)이 걸리면 전원 거절(호출 0회), 오류에 고치는 명령이 있다', async () => {
  const f = fixture();
  block(f, 'gpt-6-astra', 'senior');
  await rejectedWithoutCalls(f, {}, /시니어 1번\(codex\/gpt-6-astra\): 정책으로 막은 모델.*kadan runners set senior --set/);
  await rejectedWithoutCalls(f, {model: 'gpt-6-sol'}, /정책으로 막은 모델/); // 차단 안 된 한 명만 골라도 전원 거절
});

test('F1: 등록한 뒤 전역 block이 걸리면 호출 0회', async () => {
  const f = fixture();
  block(f, 'gpt-6-sol', '');
  await rejectedWithoutCalls(f, {}, /시니어 2번\(codex\/gpt-6-sol\): 정책으로 막은 모델/);
});

test('F1: --model로 차단 항목을 지정해도 호출 0회', async () => {
  const f = fixture();
  block(f, 'gpt-6-astra', 'senior');
  await rejectedWithoutCalls(f, {runner: 'codex', model: 'gpt-6-astra'}, /정책으로 막은 모델/);
});

test('F1: 다른 역할에만 걸린 block은 시니어를 막지 않는다', async () => {
  const f = fixture();
  block(f, 'gpt-6-astra', 'reviewer');
  const r = await f.run();
  assert.equal(r.answers.length, 2); assert.equal(f.calls.length, 2);
});

test('F2: 설정 파일을 직접 고쳐 3명(서로 다른 3개·동일 3개)을 넣어도 호출 0회', async () => {
  for (const list of [[ASTRA, ARGON, {runner: 'agy', model: 'gemini-3.8-flash-high'}], [ARGON, ARGON, ARGON], [ASTRA, ASTRA]]) {
    const f = fixture();
    const file = path.join(f.home, 'runner-settings.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')); raw.presets[raw.activePreset].roles.senior = list; fs.writeFileSync(file, JSON.stringify(raw));
    await rejectedWithoutCalls(f, {}, list.length > 2 ? /시니어는 최대 2명이다.*kadan runners set senior --set/ : /같은 실행기·모델 시니어가 두 번/);
  }
});
