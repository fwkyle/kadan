import '../tests/helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {seniorCommand, composeAdvicePrompt, SECOND_PROMPT_LIMIT_BYTES} from '../src/senior.mjs';
import {SENIOR2_ALLOWED_RUNNERS, blockModel, clearSecondSlot, initSettings, readSettings, setFallback, setRole, setRunner, setRunnerModel} from '../src/runner-settings.mjs';
import {runnersCommand} from '../src/runners-command.mjs';
import {CardStore} from '../src/card-store.mjs';
import {readLedger} from '../src/ledger.mjs';

// 시니어 두 번째 자리(2026-10-20 [kyle]): 1번 자리(codex)와 같은 질문에 병렬로 각각 답하고 둘 다 기록한다.
// 실제 agy·codex는 부르지 않는다. 가짜 실행기 'fake'가 exec 틀을 가진 실행기 역할을 한다.
const codexModels = [{slug: 'gpt-6-sol', supported_reasoning_levels: ['low', 'high'].map(effort => ({effort}))}];
const readCodexModels = () => ({models: codexModels});
const OPEN = ['fake'];

function fixture({second = true, body = '# 시험 카드\n\n- DB 열 이름을 바꾼다\n'} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-senior2-'));
  const repo = path.join(home, 'repo'); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(home, 'agent-runners.json'), JSON.stringify({runners: [{id: 'codex', spawn: 'codex --model {model} -c model_reasoning_effort="{effort}"'}]}));
  const records = [];
  const meta = revision => ({revision, by: 'kyle', reason: '시험', record: e => records.push(e), readCodexModels, senior2Runners: OPEN});
  initSettings(home, {by: 'kyle', reason: '시작', record: e => records.push(e)});
  setRole(home, {role: 'senior', runner: 'codex', model: 'gpt-6-sol', effort: 'high', ...meta(1)});
  setRunner(home, {runner: 'fake', spawn: 'fake --model {model}', table: {exec: 'fake --model {model} --print {prompt}', execField: 'response'}, ...meta(2)});
  setRunnerModel(home, {runner: 'fake', model: 'fake-m', efforts: '', ...meta(3)});
  if (second) setRole(home, {role: 'senior2', runner: 'fake', model: 'fake-m', ...meta(4)});
  new CardStore(home).create({repo: 'qa', id: 'card-a', repoPath: repo, body});
  const calls = [];
  // 가짜 호출: 1번 자리(senior.sh)는 증거 폴더에 result.txt를 쓰고, 2번 자리(fake 틀)는 표준 출력 JSON으로 답한다.
  const spawn = ({one = {}, two = {}, gate = null} = {}) => async (command, settings) => {
    const slot = settings.env.KADAN_SENIOR_DIR ? 1 : 2;
    calls.push({slot, command, settings, startedAt: calls.length});
    if (gate) await gate(slot);
    const o = slot === 1 ? {answer: '결론: 1번 답', status: 0, stderr: '', error: null, ...one} : {answer: '결론: 2번 답', status: 0, stderr: '', error: null, ...two};
    if (o.error) throw o.error;
    if (slot === 1) { if (o.answer != null) fs.writeFileSync(path.join(settings.env.KADAN_SENIOR_DIR, 'result.txt'), o.answer); return {status: o.status, stderr: o.stderr, stdout: o.answer ?? ''}; }
    return {status: o.status, stderr: o.stderr, stdout: o.answer == null ? '' : JSON.stringify({response: o.answer})};
  };
  const run = (flags = {}, more = {}) => seniorCommand(['qa/card-a'], {question: '바꿀까?', ...flags}, {home, by: 'qa-슈퍼감독', env: {PATH: process.env.PATH}, readCodexModels, slot2Runners: OPEN, ...more});
  const advices = () => readLedger(home).filter(e => e.kind === 'advice');
  return {home, repo, calls, spawn, run, advices, meta, records};
}

test('2번 자리가 비어 있으면 지금과 같다: 영수증 모양·원장 한 줄·입력 바이트가 그대로다', async () => {
  const f = fixture({second: false});
  const r = await f.run({}, {spawn: f.spawn()});
  assert.equal(r.reason, 'ok'); assert.equal(r.slots, undefined); assert.equal(r.answer, '결론: 1번 답');
  assert.equal(f.calls.length, 1);
  const [entry] = f.advices();
  assert.equal(f.advices().length, 1); assert.equal(entry.slot, undefined); assert.equal(entry.pairId, undefined);
  const card = new CardStore(f.home).get('qa/card-a');
  const input = fs.readFileSync(path.join(r.evidencePath, 'input.txt'), 'utf8');
  assert.equal(input, composeAdvicePrompt({question: '바꿀까?', card, attachments: []}));
});

test('두 자리는 병렬로 돈다: 한쪽이 끝나기 전에 다른 쪽이 이미 시작했고 원장 줄이 둘이다', async () => {
  const f = fixture();
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  const seen = [];
  const gate = async slot => { seen.push(slot); if (seen.length === 2) release(); await slow; };
  const r = await f.run({}, {spawn: f.spawn({gate})});
  assert.deepEqual(seen.sort(), [1, 2]); // 둘 다 들어와야 풀리는 문이므로 병렬이 아니면 멈춘다
  assert.equal(r.answered, 2);
  assert.deepEqual(r.slots.map(s => [s.slot, s.runner, s.model, s.reason]), [[1, 'codex', 'gpt-6-sol', 'ok'], [2, 'fake', 'fake-m', 'ok']]);
  assert.equal(r.slots[0].answer, '결론: 1번 답'); assert.equal(r.slots[1].answer, '결론: 2번 답');
  const entries = f.advices();
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(e => e.slot).sort(), [1, 2]);
  assert.equal(new Set(entries.map(e => e.pairId)).size, 1); assert.equal(entries[0].pairId, r.pairId);
  assert.equal(new Set(entries.map(e => e.evidencePath)).size, 2);
  const two = f.calls.find(c => c.slot === 2);
  assert.equal(two.settings.cwd, r.slots[1].evidencePath); // 2번 자리는 저장소가 아니라 호출 폴더에서 돈다
  assert.notEqual(two.settings.cwd, f.repo);
  assert.match(fs.readFileSync(path.join(r.slots[1].evidencePath, 'input.txt'), 'utf8'), /저장소는 읽을 수 없다/);
  assert.match(fs.readFileSync(path.join(r.slots[0].evidencePath, 'input.txt'), 'utf8'), /현재 작업 폴더가 그 카드의 저장소다/);
  // 탭 상태 파일은 1번 자리 폴더에만 생긴다(서로 덮어쓰지 않는다).
  assert.ok(!fs.existsSync(path.join(r.slots[1].evidencePath, 'tab.json')));
});

test('한쪽이 시간 초과·호출 실패·빈 답이어도 다른 쪽 답은 남고 호출은 성공(종료 코드 0)이다', async () => {
  for (const [two, reason] of [[{error: Object.assign(new Error('t'), {code: 'ETIMEDOUT'})}, 'timeout'], [{status: 3}, 'call-failed'], [{answer: '  '}, 'empty'], [{status: 1, stderr: 'KADAN_JUDGE_TIMEOUT=1'}, 'timeout']]) {
    const f = fixture();
    const r = await f.run({}, {spawn: f.spawn({two})});
    assert.equal(r.answered, 1); assert.equal(r.slots[0].reason, 'ok'); assert.equal(r.slots[1].reason, reason); assert.equal(r.slots[1].answer, undefined);
    assert.equal(f.advices().length, 2);
  }
  const g = fixture();
  const r = await g.run({}, {spawn: g.spawn({one: {status: 2}})});
  assert.equal(r.answered, 1); assert.equal(r.slots[0].reason, 'call-failed'); assert.equal(r.slots[1].answer, '결론: 2번 답');
  assert.deepEqual(g.advices().map(e => e.reason).sort(), ['call-failed', 'ok']);
});

test('둘 다 실패하면 종료 코드 1로 던지고 원장 줄은 둘 다 남는다', async () => {
  const f = fixture();
  await assert.rejects(() => f.run({}, {spawn: f.spawn({one: {status: 2}, two: {status: 2}})}), error => {
    assert.equal(error.exitCode, 1); assert.match(error.message, /두 자리 모두.*1번 call-failed, 2번 call-failed/); return true;
  });
  assert.equal(f.advices().length, 2);
});

test('열린 실행기가 없으면 2번 자리는 부르지 않고, 형식은 바꾸지 않고 stderr 한 줄만 낸다', async () => {
  assert.deepEqual(SENIOR2_ALLOWED_RUNNERS, []); // agy 실측 결과로 지금은 어느 실행기도 열지 않았다
  const f = fixture();
  const warns = [];
  const r = await f.run({}, {spawn: f.spawn(), slot2Runners: undefined, warn: line => warns.push(line)});
  assert.equal(r.slots, undefined); assert.equal(r.answer, '결론: 1번 답');
  assert.equal(f.calls.filter(c => c.slot === 2).length, 0);
  assert.equal(warns.length, 1); assert.match(warns[0], /2번 자리.*열리지 않은 실행기/);
});

// 1자리 결과는 main과 같다: senior2 없음 기준 영수증 최상위 필드·원장 사건 필드·답이 그대로여야 한다.
const shape = (r, entries) => ({receipt: Object.keys(r).sort(), entries: entries.map(e => Object.keys(e).sort()), answer: r.answer, reason: r.reason});
async function baseline() {
  const f = fixture({second: false});
  return shape(await f.run({}, {spawn: f.spawn()}), f.advices());
}

test('1자리 결과가 main과 같다: senior2 없음 / 있음+막힘(허용 목록 밖) / 있음+block — 영수증 필드·원장 필드·답이 동일', async () => {
  const base = await baseline();
  assert.ok(!base.receipt.includes('slots') && !base.receipt.includes('pairId') && base.receipt.includes('evidencePath'));
  const cases = {
    '허용 목록 밖': async () => { const f = fixture(); return [f, await f.run({}, {spawn: f.spawn(), slot2Runners: [], warn: () => {}})]; },
    block: async () => {
      const f = fixture();
      blockModel(f.home, {model: 'fake-m', roles: 'senior2', ...f.meta(5)});
      return [f, await f.run({}, {spawn: f.spawn(), warn: () => {}})];
    },
  };
  for (const [name, go] of Object.entries(cases)) {
    const [f, r] = await go();
    assert.deepEqual(shape(r, f.advices()), base, name);
    assert.equal(f.calls.filter(c => c.slot === 2).length, 0, name);
    assert.equal(f.advices().length, 1, name);
  }
});

test('프롬프트가 바이트 상한을 넘으면 2번 자리만 실패로 기록하고 1번 자리는 계속 간다', async () => {
  const f = fixture();
  const files = [0, 1, 2, 3, 4].map(i => { const file = path.join(f.home, `big-${i}.txt`); fs.writeFileSync(file, 'x'.repeat(60 * 1024)); return file; });
  const r = await f.run({file: files}, {spawn: f.spawn()});
  assert.ok(5 * 60 * 1024 > SECOND_PROMPT_LIMIT_BYTES);
  assert.equal(r.slots[1].reason, 'prompt-too-large'); assert.equal(r.slots[0].reason, 'ok');
  assert.equal(f.calls.filter(c => c.slot === 2).length, 0);
});

test('외부로 나가는 입력은 두 자리 모두 웹훅 주소와 토큰 모양을 가린다', async () => {
  const secret = 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2';
  const hook = 'https://discord.com/api/webhooks/123456789012345678/' + 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8Nn7Mm6Ll5Kk4Jj3Ii2Hh1Gg0Ff9Ee8Dd7Cc6Bb5';
  const f = fixture({body: `# 카드\n키 ${secret}\n웹훅 ${hook}\n`});
  const r = await f.run({}, {spawn: f.spawn()});
  for (const slot of r.slots) {
    const input = fs.readFileSync(path.join(slot.evidencePath, 'input.txt'), 'utf8');
    assert.ok(!input.includes(secret) && !input.includes('Zz9Yy8Xx7Ww6'), `${slot.slot}번 자리 입력에 비밀이 남았다`);
    assert.match(input, /\[가림\]|\[숨김\]|\*\*\*|REDACTED/i);
  }
});

test('--effort는 1번 자리에만 적용하고 무시한다고 알린다', async () => {
  const f = fixture();
  const r = await f.run({effort: 'low'}, {spawn: f.spawn()});
  assert.match(r.effortNote, /1번 자리.*2번 자리.*무시/);
  assert.equal(f.calls.find(c => c.slot === 1).settings.env.KADAN_SENIOR_EFFORT, 'low');
  assert.ok(!f.calls.find(c => c.slot === 2).command.includes('low'));
  const g = fixture();
  assert.equal((await g.run({}, {spawn: g.spawn()})).effortNote, undefined);
});

test('설정: 열리지 않은 실행기는 2번 자리로 못 고르고, 열린 실행기만 exec 틀이 있을 때 고른다', () => {
  const f = fixture({second: false});
  const meta = revision => ({revision, by: 'kyle', reason: '시험', record: () => {}, readCodexModels});
  assert.throws(() => setRole(f.home, {role: 'senior2', runner: 'fake', model: 'fake-m', ...meta(4)}), /agy.*막혀 있다/);
  assert.throws(() => setRole(f.home, {role: 'senior2', runner: 'codex', model: 'gpt-6-sol', effort: 'high', ...meta(4)}), /agy.*막혀 있다/);
  assert.throws(() => setRole(f.home, {role: 'senior2', runner: 'codex', model: 'gpt-6-sol', effort: 'high', ...meta(4), senior2Runners: ['codex']}), /exec 미지원/);
  const next = setRole(f.home, {role: 'senior2', runner: 'fake', model: 'fake-m', ...meta(4), senior2Runners: OPEN});
  assert.deepEqual(next.presets[next.activePreset].roles.senior2, {runner: 'fake', model: 'fake-m'});
});

test('설정: 감시 AI는 여전히 codex만, 폴백은 두 자리 모두 거절, 차단 senior는 2번 자리에도 적용된다', () => {
  const f = fixture();
  const meta = revision => ({revision, by: 'kyle', reason: '시험', record: () => {}, readCodexModels, senior2Runners: OPEN});
  assert.throws(() => setRole(f.home, {role: 'watch', runner: 'fake', model: 'fake-m', ...meta(5)}), /감시 AI는 codex 실행기만/);
  for (const role of ['senior', 'senior2']) assert.throws(() => setFallback(f.home, {role, items: [], ...meta(5)}), /폴백이 없다.*병렬/);
  blockModel(f.home, {model: 'fake-m', roles: 'senior', ...meta(5)});
  assert.throws(() => setRole(f.home, {role: 'senior2', runner: 'fake', model: 'fake-m', ...meta(6)}), /정책으로 막은 모델/);
});

test('설정: 2번 자리 비우기는 senior2만 되고, 비운 뒤에는 1번 자리만 부른다. 옛 설정 파일도 그대로 읽힌다', async () => {
  const f = fixture();
  const meta = revision => ({revision, by: 'kyle', reason: '비움', record: () => {}});
  const out = runnersCommand(['clear', 'senior2'], {revision: 5, reason: '비움'}, {home: f.home, by: 'kyle', record: () => {}});
  assert.equal(out.presets[out.activePreset].roles.senior2, undefined);
  assert.throws(() => clearSecondSlot(f.home, {...meta(6)}), /이미 비어/);
  assert.throws(() => runnersCommand(['clear', 'senior'], {revision: 6, reason: 'x'}, {home: f.home, by: 'kyle', record: () => {}}), /senior2.*뿐/);
  assert.equal(readSettings(f.home).presets[readSettings(f.home).activePreset].roles.senior.model, 'gpt-6-sol');
  const r = await f.run({}, {spawn: f.spawn()});
  assert.equal(r.slots, undefined); assert.equal(f.calls.length, 1);
});

test('runners show는 2번 자리의 호출 명령을 보여 준다', () => {
  const f = fixture();
  const shown = runnersCommand(['show'], {}, {home: f.home, by: 'kyle', record: () => {}});
  assert.match(shown.launch.senior2, /fake --model fake-m --print .*2번 자리/);
  assert.match(shown.launch.senior, /senior\.sh/);
});
