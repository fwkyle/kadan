import '../tests/helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {seniorCommand, composeAdvicePrompt, resolveRepoReadDir} from '../src/senior.mjs';
import {SENIOR_SAFE_RUNNERS, initSettings, setFallback, setRole, setRunner, setRunnerModel, setSeniors} from '../src/runner-settings.mjs';
import {CardStore} from '../src/card-store.mjs';
import {readLedger} from '../src/ledger.mjs';

// 시니어 등록 목록 + 호출 때 등록된 시니어 중 고르기(2026-10-20·22 [kyle]). 헤드리스 길(senior-mode headless)에서 가짜 spawn으로 본다.
// 헤드리스 길은 codex 스크립트만 부른다: agy가 등록돼 있으면 아무도 부르지 않는다(2026-11-18 [kyle] — agy는 대화창으로만).
// agy 대화창 길은 tests/senior-agy*.test.mjs가 본다.
const models = [{slug: 'gpt-6-sol', supported_reasoning_levels: ['low', 'high'].map(effort => ({effort}))},
  {slug: 'gpt-6-luna', supported_reasoning_levels: ['low', 'medium'].map(effort => ({effort}))}];
const readCodexModels = () => ({models});
const SOL = {runner: 'codex', model: 'gpt-6-sol', effort: 'high'}, LUNA = {runner: 'codex', model: 'gpt-6-luna', effort: 'low'};
const ARGON = {runner: 'agy', model: 'argon'};
const BOUND = 'agy --agent kadan-noexec --model {model} --print-timeout 90s --output-format json --print {prompt}';

// seniors: 등록 목록. 기본은 codex 두 명이다. 한 명이면 옛 단일 설정(setRole)으로 등록한다.
function fixture({seniors = [SOL, LUNA], body = '# 시험 카드\n\n- 열 이름을 바꾼다\n', stored = {}, agyExec = BOUND, git = false, mode = 'headless'} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-senior-pick-'));
  if (mode != null) fs.writeFileSync(path.join(home, 'senior-mode'), `${mode}\n`);
  const repo = path.join(home, 'repo'); fs.mkdirSync(repo);
  if (git) { // 진짜 git 저장소(커밋 1개). 표식 파일 하나를 둔다.
    const g = (...a) => execFileSync('git', ['-C', repo, ...a], {stdio: 'ignore'});
    g('init', '-q'); fs.writeFileSync(path.join(repo, 'README.md'), 'FAKE-REPO\n'); g('add', 'README.md');
    g('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init');
  }
  fs.writeFileSync(path.join(home, 'agent-runners.json'), JSON.stringify({runners: [{id: 'codex', spawn: 'codex --model {model} -c model_reasoning_effort="{effort}"'}]}));
  const meta = revision => ({revision, by: 'kyle', reason: '시험', record: () => {}, readCodexModels});
  initSettings(home, {by: 'kyle', reason: '시작', record: () => {}});
  setRunner(home, {runner: 'agy', spawn: 'agy --model {model}', table: {execField: 'response'}, ...meta(1)});
  setRunnerModel(home, {runner: 'agy', model: 'argon', efforts: '', ...meta(2)});
  if (seniors.length === 1 && seniors[0].runner === 'codex') setRole(home, {role: 'senior', ...seniors[0], ...meta(3)});
  else setSeniors(home, {items: seniors, ...meta(3)});
  // 설명 AI용 exec 틀은 파일에 직접 둔다. 시니어는 이 틀을 쓰지 않는다(있어도 agy를 헤드리스로 부르지 않는다).
  const settingsFile = path.join(home, 'runner-settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  settings.runners.agy.exec = agyExec;
  if (stored.senior2) settings.presets[settings.activePreset].roles.senior2 = stored.senior2; // 옛 설정 파일에 남은 senior2를 흉내 낸다
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  new CardStore(home).create({repo: 'qa', id: 'card-a', repoPath: repo, body});
  const calls = [];
  const spawn = async (command, opts) => {
    calls.push({command, env: opts.env, cwd: opts.cwd});
    fs.writeFileSync(path.join(opts.env.KADAN_SENIOR_DIR, 'result.txt'), '결론: 답');
    return {status: 0, stderr: '', stdout: '결론: 답'};
  };
  const run = (flags = {}, more = {}) => seniorCommand(['qa/card-a'], {question: '바꿀까?', ...flags}, {home, by: 'qa-슈퍼감독', env: {PATH: process.env.PATH}, readCodexModels, spawn, ...more});
  const advices = () => readLedger(home).filter(e => e.kind === 'advice');
  return {home, repo, calls, run, advices, meta};
}

test('지정이 없고 한 명만 등록돼 있으면 설정값 그대로: 영수증·원장에 지정 표시가 없고 senior.sh에 설정 모델이 간다', async () => {
  const f = fixture({seniors: [SOL]});
  const r = await f.run();
  assert.deepEqual(Object.keys(r).sort(), ['answers', 'askId', 'card']);
  const one = r.answers[0];
  assert.equal(one.reason, 'ok');
  for (const key of ['adviceId', 'answer', 'durationMs', 'effort', 'evidencePath', 'follow', 'model', 'reason', 'runner', 'status']) assert.ok(key in one, key);
  assert.equal(one.source, undefined);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].env.KADAN_SENIOR_MODEL, 'gpt-6-sol'); assert.equal(f.calls[0].env.KADAN_SENIOR_EFFORT, 'high');
  const [entry] = f.advices();
  assert.equal(entry.source, undefined); assert.equal(entry.runner, undefined); assert.equal(entry.settingsModel, undefined);
  assert.equal(entry.model, 'gpt-6-sol');
});

test('--model만: 등록된 시니어를 모델로 찾아 그 한 명만 부르고 기록에 flag가 남는다', async () => {
  const f = fixture();
  const r = await f.run({model: 'gpt-6-luna'});
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].command, /senior\.sh'$/);
  assert.equal(f.calls[0].env.KADAN_SENIOR_MODEL, 'gpt-6-luna');
  const one = r.answers[0];
  assert.equal(r.answers.length, 1); assert.equal(one.source, 'flag'); assert.equal(one.runner, 'codex'); assert.equal(one.model, 'gpt-6-luna');
  const [entry] = f.advices();
  assert.equal(entry.source, 'flag'); assert.equal(entry.runner, 'codex'); assert.equal(entry.model, 'gpt-6-luna'); assert.equal(entry.seniorCount, 1);
});

test('--runner codex --model …은 등록 항목을 그대로 고르고 등록 강도를 쓰며, --effort는 부르는 모델마다 검사한다', async () => {
  const f = fixture();
  const r = await f.run({runner: 'codex', model: 'gpt-6-sol'});
  assert.equal(f.advices()[0].source, 'flag'); assert.equal(f.calls[0].env.KADAN_SENIOR_EFFORT, 'high'); assert.equal(r.answers[0].effort, 'high');
  const r2 = await f.run({runner: 'codex', model: 'gpt-6-sol', effort: 'low'});
  assert.equal(f.calls[1].env.KADAN_SENIOR_EFFORT, 'low'); assert.equal(r2.answers[0].effort, 'low');
  await assert.rejects(f.run({runner: 'codex', model: 'gpt-6-sol', effort: 'ultra'}), /지원하지 않는 강도: ultra/);
  assert.equal(f.calls.length, 2);
});

test('--runner만 주면 오류이고 호출은 0회다', async () => {
  const f = fixture();
  await assert.rejects(f.run({runner: 'codex'}), /--runner만으로는 부를 수 없다/);
  assert.equal(f.calls.length, 0); assert.equal(f.advices().length, 0);
});

test('허용 목록은 codex·agy이고 목록 밖 실행기는 호출 전에 거절한다(실행 0회, 증거 폴더도 없다)', async () => {
  const f = fixture();
  assert.deepEqual(SENIOR_SAFE_RUNNERS, ['codex', 'agy']);
  await assert.rejects(f.run({runner: 'devin', model: 'x'}), /등록된 시니어가 아니다: devin\/x — 등록된 시니어: codex\/gpt-6-sol\/high, codex\/gpt-6-luna\/low/);
  assert.equal(f.calls.length, 0); assert.equal(f.advices().length, 0);
  assert.equal(fs.existsSync(path.join(f.home, 'advice')), false);
});

test('설정 저장은 목록 밖 실행기를 거절하고 agy는 받는다', () => {
  const f = fixture();
  setRunner(f.home, {runner: 'devin', spawn: 'devin --model {model}', table: {}, ...f.meta(4)});
  setRunnerModel(f.home, {runner: 'devin', model: 'x', efforts: '', ...f.meta(5)});
  assert.throws(() => setRole(f.home, {role: 'senior', runner: 'devin', model: 'x', ...f.meta(6)}), /안전하게 묶을 수 있는 실행기/);
  setRole(f.home, {role: 'senior', runner: 'agy', model: 'argon', ...f.meta(6)});
});

// 헤드리스 agy 차단(설계 2026-11-18 v2.1 1번): 모드는 호출 시작에 한 번 정하고, headless면 선택 옵션을 처리하기 전에 등록 목록 전체를 본다.
const refusedWithoutCalls = async (f, flags, label) => {
  const error = await f.run(flags).then(() => assert.fail(`${label}: 거절해야 한다`), e => e);
  assert.match(error.message, /헤드리스 시니어\(senior-mode headless\)는 codex만 부른다.*agy\/argon.*headless-agy/u, label);
  assert.equal(error.reason, 'headless-agy', label);
  assert.equal(f.calls.length, 0, `${label}: 호출 0회`);
  assert.deepEqual(f.advices(), [], label);
  assert.equal(fs.existsSync(path.join(f.home, 'advice')), false, `${label}: 증거 폴더도 없다`);
  assert.equal(fs.existsSync(path.join(f.home, 'senior-agy')), false, `${label}: agy 작업 폴더도 만들지 않는다`);
};

test('헤드리스 + agy 등록: 등록 순서·고른 모델과 무관하게 아무도 부르지 않는다(codex만 골라도 0회, agy exec 틀이 있어도 0회)', async () => {
  for (const seniors of [[SOL, ARGON], [ARGON, SOL], [ARGON]]) {
    const label = seniors.map(s => s.runner).join('+');
    for (const flags of [{}, {model: 'gpt-6-sol'}, {runner: 'codex', model: 'gpt-6-sol'}, {model: 'argon'}, {runner: 'agy', model: 'argon'},
      {effort: 'low'}, {model: 'nope'}]) {
      await refusedWithoutCalls(fixture({seniors}), flags, `${label} ${JSON.stringify(flags)}`);
    }
  }
  // 실행기 표에 묶인 exec 틀이 있든 없든 같다: 시니어에는 그 틀로 가는 갈래가 없다.
  for (const agyExec of [BOUND, 'agy --model {model} --print {prompt}']) await refusedWithoutCalls(fixture({seniors: [SOL, ARGON], agyExec}), {}, agyExec);
});

test('헤드리스 길은 고정된 codex 스크립트만 부른다: 시니어 코드에 실행기 표 exec 틀·헤드리스 agy 옵션으로 가는 글이 없다', () => {
  for (const file of ['senior.mjs', 'senior-session.mjs', 'senior-session-run.mjs', 'senior-agy.mjs', 'senior-agy-screen.mjs', 'senior-screen.mjs', 'senior-tab.mjs']) {
    const code = fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/execCommand|runnerTemplate|bindExec|assertExecBound|callExec|viaExec/u.test(code), `${file}: exec 틀 경로`);
    // (`-p`는 tmux 명령의 옵션으로 쓰이므로 글로 찾지 않는다. agy 실행 인자의 `-p` 없음은 tests/senior-agy.test.mjs가 본다.)
    assert.ok(!/--print\b|--print-timeout|--output-format/u.test(code), `${file}: 헤드리스 agy 옵션`);
  }
});

test('등록되지 않은 모델은 거절하고 오류 글에 등록된 시니어 목록을 보여 준다(실행 0회, 증거 폴더도 없다)', async () => {
  const f = fixture();
  await assert.rejects(f.run({model: 'nope'}), /등록된 시니어가 아니다: nope — 등록된 시니어: codex\/gpt-6-sol\/high, codex\/gpt-6-luna\/low/);
  await assert.rejects(f.run({model: 'argon'}), /등록된 시니어가 아니다: argon/, '실행기 목록에 있는 모델이어도 등록돼 있지 않으면 거절');
  await assert.rejects(f.run({runner: 'agy', model: 'gpt-6-sol'}), /등록된 시니어가 아니다: agy\/gpt-6-sol/);
  assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(path.join(f.home, 'advice')), false);
});

test('fallback senior는 계속 거절한다', () => {
  const f = fixture();
  assert.throws(() => setFallback(f.home, {role: 'senior', items: [], ...f.meta(4)}), /폴백이 없다/);
});

test('watch는 계속 codex 전용이다', () => {
  const f = fixture();
  assert.throws(() => setRole(f.home, {role: 'watch', runner: 'agy', model: 'argon', ...f.meta(4)}), /codex 실행기만/);
});

test('옛 roles.senior2가 든 설정은 무시한다: 부르면 1번 자리만 돈다', async () => {
  const f = fixture({seniors: [SOL], stored: {senior2: {runner: 'agy', model: 'argon'}}});
  const r = await f.run();
  assert.equal(r.answers[0].reason, 'ok'); assert.equal(f.calls.length, 1); assert.equal(r.answers[0].slots, undefined);
  assert.equal(f.advices().length, 1);
});

test('카드 글의 웹훅 주소·토큰 모양은 가려서 보낸다(지정 여부와 무관)', async () => {
  const secret = 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8Nn7Mm6Ll5Kk4Jj3Ii2Hh1Gg0Ff9Ee8Dd7Cc6Bb5';
  const hook = `https://discord.com/api/webhooks/123456789012345678/${secret}`;
  const f = fixture({seniors: [SOL], body: `# 카드\n\n알림 주소 ${hook}\n`});
  const r = await f.run({model: 'gpt-6-sol'});
  const input = fs.readFileSync(path.join(r.answers[0].evidencePath, 'input.txt'), 'utf8');
  assert.equal(input.includes(secret), false);
  assert.equal(input.includes('discord.com/api/webhooks'), false);
  assert.match(input, /--- 질문 ---/);
  const card = new CardStore(f.home).get('qa/card-a');
  assert.notEqual(input, composeAdvicePrompt({question: '바꿀까?', card, attachments: []}));
});

test('resolveRepoReadDir: 하위 폴더·홈·/·상위 .git·separate-git-dir는 null, 최상위 자체만 통과', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rrd-')));
  const repo = path.join(root, 'repo'); fs.mkdirSync(path.join(repo, 'sub'), {recursive: true});
  execFileSync('git', ['-C', repo, 'init', '-q']);
  assert.equal(resolveRepoReadDir(repo), repo);
  assert.equal(resolveRepoReadDir(path.join(repo, 'sub')), null);
  assert.equal(resolveRepoReadDir(os.homedir()), null);
  assert.equal(resolveRepoReadDir('/'), null);
  const outer = path.join(root, 'outer'); fs.mkdirSync(path.join(outer, 'inner'), {recursive: true});
  execFileSync('git', ['-C', outer, 'init', '-q']);
  assert.equal(resolveRepoReadDir(path.join(outer, 'inner')), null);
  const sep = path.join(root, 'sep'); fs.mkdirSync(sep);
  execFileSync('git', ['init', '-q', `--separate-git-dir=${path.join(root, 'meta.git')}`, sep]);
  assert.equal(resolveRepoReadDir(sep), sep);
});

test('질문 조립(agy 대화창): 답을 화면에 쓰고 마지막 줄에 끝 표지만 쓰게 하며, 저장소는 읽기 전용 폴더가 있을 때만 읽게 한다. 완성된 표지는 없다', () => {
  const card = {key: 'r/c', title: 'T', body: 'B'};
  const screen = composeAdvicePrompt({question: 'Q', card, attachments: [], readsRepo: true, repoDir: '/fake/repo', session: {token: 'abcd1234', answer: 'screen'}});
  assert.match(screen, /읽기 전용 폴더로 열려 있다: \/fake\/repo — 먼저 그 저장소의 안내 파일\(AGENTS\.md/);
  assert.match(screen, /답은 파일로 쓰지 않고 이 대화의 답으로 화면에 쓴다/);
  assert.match(screen, /마지막 줄에 끝 표지 한 줄만 단독으로 쓴다/);
  assert.ok(!screen.includes('result.txt') && !screen.includes('KADAN-SENIOR-END-abcd1234'));
  assert.ok(screen.includes('끝 표지 조각: "KADAN-SENIOR" "-END-" "abcd1234"'));
  const blind = composeAdvicePrompt({question: 'Q', card, attachments: [], readsRepo: false, repoDir: null, session: {token: 'abcd1234', answer: 'screen'}});
  assert.match(blind, /저장소를 직접 읽을 수 없다/); assert.ok(!blind.includes('읽기 전용 폴더로 열려 있다'));
  // codex 대화창 질문은 그대로다: 저장소 절대경로와 result.txt 쓰기.
  const file = composeAdvicePrompt({question: 'Q', card, attachments: [], session: {repoDir: '/fake/repo', token: 'abcd1234'}});
  assert.match(file, /그 카드의 저장소는 \/fake\/repo 이다/); assert.match(file, /result\.txt 파일 하나에 쓴다/);
  assert.ok(!file.includes('화면에 쓴다'));
});

test('codex 시니어는 바뀌지 않는다: senior.sh로 부르고 --add-dir·읽기 폴더 문구가 없다', async () => {
  const f = fixture({seniors: [SOL], git: true});
  const r = await f.run();
  assert.equal(r.answers[0].reason, 'ok'); assert.match(f.calls[0].command, /senior\.sh'$/);
  assert.ok(!f.calls[0].command.includes('--add-dir'));
  const input = fs.readFileSync(path.join(r.answers[0].evidencePath, 'input.txt'), 'utf8');
  assert.match(input, /현재 작업 폴더가 그 카드의 저장소다/); assert.ok(!input.includes('읽기 전용 폴더로 열려 있다'));
});
