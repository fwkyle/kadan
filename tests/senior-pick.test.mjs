import '../tests/helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {seniorCommand, composeAdvicePrompt} from '../src/senior.mjs';
import {SENIOR_SAFE_RUNNERS, blockModel, initSettings, setFallback, setRole, setRunner, setRunnerModel} from '../src/runner-settings.mjs';
import {CardStore} from '../src/card-store.mjs';
import {NOEXEC_AGENT_MD} from '../src/exec-agent.mjs';
import {readLedger} from '../src/ledger.mjs';

// 시니어 한 칸 + 호출 때 모델 고르기(2026-10-20 [kyle]). 실제 codex는 부르지 않고 가짜 spawn이 senior.sh 자리를 대신한다.
const models = [{slug: 'gpt-6-sol', supported_reasoning_levels: ['low', 'high'].map(effort => ({effort}))},
  {slug: 'gpt-6-luna', supported_reasoning_levels: ['low', 'medium'].map(effort => ({effort}))}];
const readCodexModels = () => ({models});

const BOUND = 'agy --agent kadan-noexec --model {model} --print-timeout 90s --output-format json --print {prompt}';

function fixture({body = '# 시험 카드\n\n- 열 이름을 바꾼다\n', stored = {}, agyExec = 'agy --model {model} --print {prompt}', repoName = 'repo', git = false, cardRepo = null} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-senior-pick-'));
  const repo = path.join(home, repoName); fs.mkdirSync(repo);
  if (git) { // 진짜 git 저장소(커밋 1개). 표식 파일 하나를 둔다.
    const g = (...a) => execFileSync('git', ['-C', repo, ...a], {stdio: 'ignore'});
    g('init', '-q'); fs.writeFileSync(path.join(repo, 'README.md'), 'FAKE-REPO\n'); g('add', 'README.md');
    g('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init');
  }
  fs.writeFileSync(path.join(home, 'agent-runners.json'), JSON.stringify({runners: [{id: 'codex', spawn: 'codex --model {model} -c model_reasoning_effort="{effort}"'}]}));
  const meta = revision => ({revision, by: 'kyle', reason: '시험', record: () => {}, readCodexModels});
  initSettings(home, {by: 'kyle', reason: '시작', record: () => {}});
  setRole(home, {role: 'senior', runner: 'codex', model: 'gpt-6-sol', effort: 'high', ...meta(1)});
  setRunner(home, {runner: 'agy', spawn: 'agy --model {model}', table: {execField: 'response'}, ...meta(2)});
  setRunnerModel(home, {runner: 'agy', model: 'argon', efforts: '', ...meta(3)});
  // exec 틀은 파일에 직접 둔다: 저장 API는 묶기 문법을 어긴 틀을 거절하므로, 반영 전 운영 틀(--agent 없음)은 이렇게 흉내 낸다.
  const settingsFile = path.join(home, 'runner-settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  settings.runners.agy.exec = agyExec;
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  if (stored.senior2) { // 옛 설정 파일에 남은 senior2를 흉내 낸다
    const file = path.join(home, 'runner-settings.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.presets[raw.activePreset].roles.senior2 = stored.senior2;
    fs.writeFileSync(file, JSON.stringify(raw));
  }
  new CardStore(home).create({repo: 'qa', id: 'card-a', repoPath: cardRepo ? cardRepo(repo) : repo, body});
  const calls = [];
  const spawn = async (command, opts) => {
    calls.push({command, env: opts.env, cwd: opts.cwd});
    if (command.startsWith('agy')) return {status: 0, stderr: '', stdout: JSON.stringify({response: '결론: agy 답'})};
    fs.writeFileSync(path.join(opts.env.KADAN_SENIOR_DIR, 'result.txt'), '결론: 답');
    return {status: 0, stderr: '', stdout: '결론: 답'};
  };
  const run = (flags = {}, more = {}) => seniorCommand(['qa/card-a'], {question: '바꿀까?', ...flags}, {home, by: 'qa-슈퍼감독', env: {PATH: process.env.PATH}, readCodexModels, spawn, ...more});
  const advices = () => readLedger(home).filter(e => e.kind === 'advice');
  return {home, repo, calls, run, advices, meta};
}

test('지정이 없으면 설정값 그대로: 영수증·원장에 지정 표시가 없고 senior.sh에 설정 모델이 간다', async () => {
  const f = fixture();
  const r = await f.run();
  assert.equal(r.reason, 'ok');
  assert.deepEqual(Object.keys(r).sort(), ['adviceId', 'answer', 'card', 'durationMs', 'effort', 'evidencePath', 'follow', 'model', 'reason', 'tab', 'tabReason'].filter(k => k in r).sort());
  assert.equal(r.source, undefined); assert.equal(r.runner, undefined);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].env.KADAN_SENIOR_MODEL, 'gpt-6-sol'); assert.equal(f.calls[0].env.KADAN_SENIOR_EFFORT, 'high');
  const [entry] = f.advices();
  assert.equal(entry.source, undefined); assert.equal(entry.runner, undefined); assert.equal(entry.settingsModel, undefined);
  assert.equal(entry.model, 'gpt-6-sol');
});

test('--model만: 설정의 실행기(codex)에 그 모델로 senior.sh가 불리고 기록에 flag가 남는다', async () => {
  const f = fixture();
  const r = await f.run({model: 'gpt-6-luna'});
  assert.equal(f.calls[0].env.KADAN_SENIOR_MODEL, 'gpt-6-luna');
  assert.equal(f.calls[0].env.KADAN_SENIOR_EFFORT, 'max'); // 설정 강도 high는 luna에 없어 이어받지 않는다
  assert.equal(r.source, 'flag'); assert.equal(r.runner, 'codex'); assert.equal(r.model, 'gpt-6-luna');
  const [entry] = f.advices();
  assert.equal(entry.source, 'flag'); assert.equal(entry.runner, 'codex'); assert.equal(entry.model, 'gpt-6-luna');
  assert.equal(entry.settingsModel, 'gpt-6-sol'); assert.equal(entry.settingsRunner, 'codex');
});

test('--runner codex --model …은 같은 결과이고 설정 강도가 새 모델에서도 되면 이어받는다', async () => {
  const f = fixture();
  const r = await f.run({runner: 'codex', model: 'gpt-6-sol'});
  assert.equal(r.source, 'flag'); assert.equal(f.calls[0].env.KADAN_SENIOR_EFFORT, 'high');
  const r2 = await f.run({runner: 'codex', model: 'gpt-6-luna', effort: 'low'});
  assert.equal(f.calls[1].env.KADAN_SENIOR_EFFORT, 'low'); assert.equal(r2.effort, 'low');
});

test('--runner만 주면 오류이고 호출은 0회다', async () => {
  const f = fixture();
  await assert.rejects(f.run({runner: 'codex'}), /--runner만으로는 부를 수 없다/);
  assert.equal(f.calls.length, 0); assert.equal(f.advices().length, 0);
});

test('허용 목록은 codex·agy이고 목록 밖 실행기는 호출 전에 거절한다(실행 0회, 증거 폴더도 없다)', async () => {
  const f = fixture();
  assert.deepEqual(SENIOR_SAFE_RUNNERS, ['codex', 'agy']);
  await assert.rejects(f.run({runner: 'devin', model: 'x'}), /안전하게 묶을 수 있는 실행기\(codex, agy\)만.*devin/);
  assert.equal(f.calls.length, 0); assert.equal(f.advices().length, 0);
  assert.equal(fs.existsSync(path.join(f.home, 'advice')), false);
});

test('agy 틀에 --agent kadan-noexec가 없으면 호출 전에 거절한다(실행 0회, 증거 폴더도 없다)', async () => {
  const f = fixture();
  await assert.rejects(f.run({runner: 'agy', model: 'argon'}), /agy 실행 틀이 묶기 문법에 맞지 않는다\(--agent kadan-noexec가 없다\)/);
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

test('--runner agy --model: 실행기 표 틀로 호출 폴더에서 부른다(git 아닌 저장소라 --add-dir 없음, 저장소 못 읽는다는 문구, 가림, 시간 상한, 에이전트 파일)', async () => {
  const secret = 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8Nn7Mm6Ll5Kk4Jj3Ii2Hh1Gg0Ff9Ee8Dd7Cc6Bb5';
  const f = fixture({agyExec: BOUND, body: `# 카드\n\n알림 https://discord.com/api/webhooks/123456789012345678/${secret}\n`});
  const r = await f.run({runner: 'agy', model: 'argon', timeout: 120, effort: 'low'});
  assert.equal(r.reason, 'ok'); assert.equal(r.source, 'flag'); assert.equal(r.runner, 'agy'); assert.equal(r.answer, '결론: agy 답');
  assert.match(r.note, /--effort는 agy 실행 틀에 강도 자리가 없어 무시했다/);
  const [call] = f.calls;
  assert.equal(call.command, 'agy --agent kadan-noexec --model argon --print-timeout 120s --output-format json --print "$KADAN_EXPLAIN_PROMPT"');
  assert.ok(!call.command.includes('--add-dir'));
  assert.equal(call.cwd, r.evidencePath);
  assert.equal(fs.readFileSync(path.join(r.evidencePath, '.agents/agents/kadan-noexec/agent.md'), 'utf8'), NOEXEC_AGENT_MD);
  const prompt = call.env.KADAN_EXPLAIN_PROMPT;
  assert.match(prompt, /저장소를 직접 읽을 수 없다/); assert.ok(!prompt.includes('현재 작업 폴더가 그 카드의 저장소다'));
  assert.ok(!prompt.includes(secret)); assert.ok(!prompt.includes('discord.com/api/webhooks'));
  assert.equal(fs.readFileSync(path.join(r.evidencePath, 'result.txt'), 'utf8'), '결론: agy 답');
  const [entry] = f.advices();
  assert.equal(entry.source, 'flag'); assert.equal(entry.runner, 'agy'); assert.equal(entry.settingsRunner, 'codex'); assert.equal(entry.reason, 'ok');
});

test('agy 틀이 묶기 문법을 어기면(--add-dir·주석·따옴표 속 옵션) 호출 전에 거절한다(실행 0회)', async () => {
  for (const exec of [`${BOUND} --add-dir /FAKE/REPOSITORY`, `${BOUND} # x`, 'agy --agent kadan-noexec " x --print-timeout 90s y " --print-timeout 90s --print {prompt}']) {
    const f = fixture({agyExec: exec});
    await assert.rejects(f.run({runner: 'agy', model: 'argon'}), /묶기 문법에 맞지 않는다/, exec);
    assert.equal(f.calls.length, 0);
    assert.equal(fs.existsSync(path.join(f.home, 'advice')), false, '증거 폴더도 없다');
  }
});

test('설정의 시니어가 agy여도 지정 표시 없이 같은 exec 경로로 간다', async () => {
  const f = fixture({agyExec: BOUND});
  setRole(f.home, {role: 'senior', runner: 'agy', model: 'argon', ...f.meta(4)});
  const r = await f.run();
  assert.equal(r.source, undefined); assert.equal(r.runner, 'agy'); assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].command, /^agy --agent kadan-noexec --model argon --print-timeout 1800s /);
  assert.equal(f.advices()[0].source, undefined);
});

test('exec 경로의 프롬프트가 200KB를 넘으면 부르지 않는다', async () => {
  const f = fixture({agyExec: BOUND});
  const files = [];
  for (let i = 0; i < 4; i++) { const file = path.join(f.home, `a${i}.txt`); fs.writeFileSync(file, 'x'.repeat(60 * 1024)); files.push(file); }
  await assert.rejects(f.run({runner: 'agy', model: 'argon', file: files}), /프롬프트가 너무 크다/);
  assert.equal(f.calls.length, 0);
});

test('agy 호출이 실패하면 자문 실패로 끝나고 원장에 남는다', async () => {
  const f = fixture({agyExec: BOUND});
  await assert.rejects(f.run({runner: 'agy', model: 'argon'}, {spawn: async () => ({status: 1, stdout: '', stderr: 'boom'})}), /자문 실패\(call-failed\)/);
  assert.equal(f.advices()[0].reason, 'call-failed');
});

test('block --roles senior는 골라 부른 모델도 막는다', async () => {
  const f = fixture();
  blockModel(f.home, {model: 'gpt-6-luna', roles: 'senior', revision: 4, by: 'kyle', reason: '시험', record: () => {}});
  await assert.rejects(f.run({model: 'gpt-6-luna'}), /정책으로 막은 모델/);
  assert.equal(f.calls.length, 0);
});

test('설정에 없는 모델은 거절한다', async () => {
  const f = fixture();
  await assert.rejects(f.run({model: 'nope'}), /고를 수 없는 모델/);
  assert.equal(f.calls.length, 0);
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
  const f = fixture({stored: {senior2: {runner: 'agy', model: 'argon'}}});
  const r = await f.run();
  assert.equal(r.reason, 'ok'); assert.equal(f.calls.length, 1); assert.equal(r.slots, undefined);
  assert.equal(f.advices().length, 1);
});

test('카드 글의 웹훅 주소·토큰 모양은 가려서 보낸다(지정 여부와 무관)', async () => {
  const secret = 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8Nn7Mm6Ll5Kk4Jj3Ii2Hh1Gg0Ff9Ee8Dd7Cc6Bb5';
  const hook = `https://discord.com/api/webhooks/123456789012345678/${secret}`;
  const f = fixture({body: `# 카드\n\n알림 주소 ${hook}\n`});
  const r = await f.run({model: 'gpt-6-luna'});
  const input = fs.readFileSync(path.join(r.evidencePath, 'input.txt'), 'utf8');
  assert.equal(input.includes(secret), false);
  assert.equal(input.includes('discord.com/api/webhooks'), false);
  assert.match(input, /--- 질문 ---/);
  const card = new CardStore(f.home).get('qa/card-a');
  assert.notEqual(input, composeAdvicePrompt({question: '바꿀까?', card, attachments: []}));
});

const ADD_DIR = /--add-dir/g;

test('agy 시니어: git 저장소면 코드가 --add-dir <정규화 절대경로>를 정확히 1번 덧붙이고 cwd·에이전트 파일은 호출 폴더에만 있다', async () => {
  const f = fixture({agyExec: BOUND, git: true});
  const real = fs.realpathSync(f.repo);
  const r = await f.run({runner: 'agy', model: 'argon', timeout: 120});
  assert.equal(r.reason, 'ok');
  const [call] = f.calls;
  assert.equal(call.command, `agy --agent kadan-noexec --model argon --print-timeout 120s --output-format json --print "$KADAN_EXPLAIN_PROMPT" --add-dir ${real}`);
  assert.equal(call.command.match(ADD_DIR).length, 1);
  assert.equal(call.cwd, r.evidencePath); assert.notEqual(call.cwd, real);
  assert.equal(fs.readFileSync(path.join(r.evidencePath, '.agents/agents/kadan-noexec/agent.md'), 'utf8'), NOEXEC_AGENT_MD);
  assert.equal(fs.existsSync(path.join(real, '.agents')), false, '저장소에는 에이전트 파일을 두지 않는다');
  const prompt = call.env.KADAN_EXPLAIN_PROMPT;
  assert.ok(prompt.includes(`읽기 전용 폴더로 열려 있다: ${real}`)); assert.ok(!prompt.includes('저장소를 직접 읽을 수 없다'));
  assert.ok(!prompt.includes('현재 작업 폴더가 그 카드의 저장소다'));
});

test('agy 시니어: 카드 경로가 git 작업트리여도 원본 저장소로 정규화해 붙인다', async () => {
  const f = fixture({agyExec: BOUND, git: true});
  const wt = path.join(f.home, 'wt');
  execFileSync('git', ['-C', f.repo, 'worktree', 'add', '-q', '-b', 'side', wt], {stdio: 'ignore'});
  new CardStore(f.home).create({repo: 'qa', id: 'card-wt', repoPath: wt, body: '# wt'});
  const r = await seniorCommand(['qa/card-wt'], {question: '바꿀까?', runner: 'agy', model: 'argon'},
    {home: f.home, by: 'qa-슈퍼감독', env: {PATH: process.env.PATH}, readCodexModels, spawn: async (command, opts) => { f.calls.push({command, env: opts.env}); return {status: 0, stderr: '', stdout: JSON.stringify({response: '결론: 답'})}; }});
  assert.equal(r.reason, 'ok');
  assert.ok(f.calls.at(-1).command.endsWith(` --add-dir ${fs.realpathSync(f.repo)}`), f.calls.at(-1).command);
});

test('agy 시니어: git이 아니거나 공백이 든 경로면 --add-dir 없이 카드 본문·첨부만 쓴다', async () => {
  for (const options of [{git: false}, {git: true, repoName: 'my repo'}, {git: true, repoName: "o'repo"}]) {
    const f = fixture({agyExec: BOUND, ...options});
    const r = await f.run({runner: 'agy', model: 'argon'});
    assert.equal(r.reason, 'ok');
    assert.ok(!f.calls[0].command.includes('--add-dir'), JSON.stringify(options));
    assert.match(f.calls[0].env.KADAN_EXPLAIN_PROMPT, /저장소를 직접 읽을 수 없다/);
  }
});

test('codex 시니어는 바뀌지 않는다: senior.sh로 부르고 --add-dir·읽기 폴더 문구가 없다', async () => {
  const f = fixture({agyExec: BOUND, git: true});
  const r = await f.run();
  assert.equal(r.reason, 'ok'); assert.match(f.calls[0].command, /senior\.sh'$/);
  assert.ok(!f.calls[0].command.includes('--add-dir'));
});

test('저장한 틀의 --add-dir는 여전히 거절된다(git 저장소여도 호출 전 거절, 실행 0회)', async () => {
  const f = fixture({agyExec: `${BOUND} --add-dir ${'/FAKE/REPOSITORY'}`, git: true});
  await assert.rejects(f.run({runner: 'agy', model: 'argon'}), /묶기 문법에 맞지 않는다/);
  assert.equal(f.calls.length, 0);
});
