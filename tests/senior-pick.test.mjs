import '../tests/helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {seniorCommand, composeAdvicePrompt} from '../src/senior.mjs';
import {SENIOR_SAFE_RUNNERS, blockModel, initSettings, setFallback, setRole, setRunner, setRunnerModel} from '../src/runner-settings.mjs';
import {CardStore} from '../src/card-store.mjs';
import {readLedger} from '../src/ledger.mjs';

// 시니어 한 칸 + 호출 때 모델 고르기(2026-10-20 [kyle]). 실제 codex는 부르지 않고 가짜 spawn이 senior.sh 자리를 대신한다.
const models = [{slug: 'gpt-6-sol', supported_reasoning_levels: ['low', 'high'].map(effort => ({effort}))},
  {slug: 'gpt-6-luna', supported_reasoning_levels: ['low', 'medium'].map(effort => ({effort}))}];
const readCodexModels = () => ({models});

function fixture({body = '# 시험 카드\n\n- 열 이름을 바꾼다\n', stored = {}} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-senior-pick-'));
  const repo = path.join(home, 'repo'); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(home, 'agent-runners.json'), JSON.stringify({runners: [{id: 'codex', spawn: 'codex --model {model} -c model_reasoning_effort="{effort}"'}]}));
  const meta = revision => ({revision, by: 'kyle', reason: '시험', record: () => {}, readCodexModels});
  initSettings(home, {by: 'kyle', reason: '시작', record: () => {}});
  setRole(home, {role: 'senior', runner: 'codex', model: 'gpt-6-sol', effort: 'high', ...meta(1)});
  setRunner(home, {runner: 'agy', spawn: 'agy --model {model}', table: {exec: 'agy --model {model} --print {prompt}', execField: 'response'}, ...meta(2)});
  setRunnerModel(home, {runner: 'agy', model: 'argon', efforts: '', ...meta(3)});
  if (stored.senior2) { // 옛 설정 파일에 남은 senior2를 흉내 낸다
    const file = path.join(home, 'runner-settings.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.presets[raw.activePreset].roles.senior2 = stored.senior2;
    fs.writeFileSync(file, JSON.stringify(raw));
  }
  new CardStore(home).create({repo: 'qa', id: 'card-a', repoPath: repo, body});
  const calls = [];
  const spawn = async (command, opts) => {
    calls.push({command, env: opts.env});
    fs.writeFileSync(path.join(opts.env.KADAN_SENIOR_DIR, 'result.txt'), '결론: 답');
    return {status: 0, stderr: '', stdout: '결론: 답'};
  };
  const run = (flags = {}, more = {}) => seniorCommand(['qa/card-a'], {question: '바꿀까?', ...flags}, {home, by: 'qa-슈퍼감독', env: {PATH: process.env.PATH}, readCodexModels, spawn, ...more});
  const advices = () => readLedger(home).filter(e => e.kind === 'advice');
  return {home, calls, run, advices, meta};
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

test('허용 목록 밖 --runner agy는 호출 전에 거절한다(실행 0회, 증거 폴더도 없다)', async () => {
  const f = fixture();
  assert.deepEqual(SENIOR_SAFE_RUNNERS, ['codex']);
  await assert.rejects(f.run({runner: 'agy', model: 'argon'}), /안전하게 묶을 수 있는 실행기\(codex\)만.*agy.*실측/);
  assert.equal(f.calls.length, 0); assert.equal(f.advices().length, 0);
  assert.equal(fs.existsSync(path.join(f.home, 'advice')), false);
});

test('설정 저장도 목록 밖 실행기를 거절한다', () => {
  const f = fixture();
  assert.throws(() => setRole(f.home, {role: 'senior', runner: 'agy', model: 'argon', ...f.meta(4)}), /안전하게 묶을 수 있는 실행기/);
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
