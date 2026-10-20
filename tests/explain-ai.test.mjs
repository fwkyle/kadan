import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CardStore} from '../src/card-store.mjs';
import {BriefStore, buildHumanBrief} from '../src/human-brief.mjs';
import {buildCardCenter} from '../src/card-center.mjs';
import {taskIdentity} from '../src/task-identity.mjs';
import {DecisionStore} from '../src/decisions.mjs';
import {ExplainAI, EXPLAIN_FILE} from '../src/explain-ai.mjs';
import {EXPLAIN_BY} from '../src/actors.mjs';
import {readStream, appendStream} from '../src/storage.mjs';
import {explainChain, setRole, setFallback, initSettings, readSettings} from '../src/runner-settings.mjs';
import {execCommand, fillTemplate, checkExecTemplate} from '../src/runner-table.mjs';
import {buildExplainInput, buildExplainPrompt} from '../src/explain-input.mjs';
import {setRunner as saveRunner} from '../src/runner-settings.mjs';
import {scrubForAI} from '../src/explain-input.mjs';
import {runnersCommand} from '../src/runners-command.mjs';
import {runWatch} from '../src/watch-runner.mjs';
import {buildDiag, shapeOf, wordIds, errnoOf, pick, ATTEMPT_RESULTS, WORD_IDS, KEY_NAMES, SIGNAL_NAMES, ERRNO_CODES, VALUE_KINDS, ENVELOPE_STATES, UNKNOWN_KEY, MAX_KEYS} from '../src/explain-diag.mjs';

const fake = new URL('./helpers/fake-explain.mjs', import.meta.url).pathname;
const EXEC = `node '${fake}' {model}`;

// 가짜 실행기와 설정이 든 격리 홈. 시계는 시험이 직접 움직인다(켜는 시점 이후 사건만 보는 규칙을 시각으로 시험한다).
function world({chain = [{runner: 'fake', model: 'ok'}], exec = EXEC, spawn, timeoutMs = 3000} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-explain-'));
  const log = path.join(home, 'fake-log.jsonl');
  process.env.FAKE_EXPLAIN_LOG = log;
  const writeSettings = roles => fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify({
    version: 1, revision: 1, activePreset: 'B',
    presets: {B: {roles: roles ?? {}, ...(chain.length > 1 ? {fallback: {explain: chain.slice(1)}} : {})}},
    runners: {codex: {spawn: 'codex {model}', catalog: 'codex-models-cache'}, fake: {spawn: 'fake {model}', ...(exec ? {exec, execField: 'response'} : {}), models: []}},
    families: {}, blocked: []}));
  writeSettings(chain.length ? {explain: chain[0]} : {});
  const clock = {t: Date.now()};
  const ai = new ExplainAI({home, now: () => clock.t, timeoutMs, ...(spawn ? {spawn} : {})});
  const store = new CardStore(home);
  const raw = [];
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
  const iso = offset => new Date(clock.t + offset).toISOString();
  const run = (extra = {}) => {
    const cards = store.listSummaries();
    const entries = taskIdentity(cards).project(raw);
    const result = ai.tick({cards, entries, readEntries: () => raw, ...extra});
    return {result, done: ai.drain()};
  };
  const makeCard = (id = 'card-a') => store.create({repo: 'r', id, repoPath: home, title: `${id} 제목`, body: `# ${id}\n본문`});
  const dispatch = (card, offset, role = 'worker') => raw.push({kind: 'send', role, taskId: card.id, executionKey: card.key, t: iso(offset)});
  const finish = (card, offset, result = 'ok', role = 'worker') => raw.push({kind: 'done', role, taskId: card.id, executionKey: card.key, result, t: iso(offset)});
  const rows = () => readStream(home, EXPLAIN_FILE, {optional: true});
  return {home, ai, store, raw, clock, calls, run, makeCard, dispatch, finish, rows, writeSettings, brief: key => new BriefStore(home).read(key), iso};
}
const enable = async w => { w.run(); await w.ai.drain(); w.clock.t += 60_000; };

test('설명 AI 칸이 비었거나 exec 틀이 없으면 사건이 나도 호출 0, 설명 줄 변화 0, 기록 0', async () => {
  for (const options of [{chain: []}, {exec: null}]) {
    const w = world(options);
    const card = w.makeCard();
    await enable(w);
    w.dispatch(card, 0); w.finish(card, 1000);
    const {result, done} = w.run(); await done;
    assert.equal(result.state, 'off');
    assert.equal(w.calls().length, 0);
    assert.equal(w.brief(card.key), null);
    assert.equal(w.rows().length, 0);
  }
  assert.equal(explainChain(null), null);
});

test('켜기 전 사건·옛 카드는 호출 0이고, 켠 뒤 발령·완료·막힘·결정·결과 등록은 각각 호출 1회와 설명 줄 1줄을 남긴다', async () => {
  const w = world();
  const old = w.makeCard('old-card');
  w.dispatch(old, -10 * 60_000); w.finish(old, -5 * 60_000);
  const card = w.makeCard();
  await enable(w);
  {const {done} = w.run(); await done;}
  assert.equal(w.calls().length, 0, '켜기 전 사건은 부르지 않는다');
  assert.equal(w.brief(old.key), null);
  const step = async (label, expected) => {
    w.clock.t += 60_000;
    const {done} = w.run(); await done;
    assert.equal(w.calls().length, expected, label);
    const row = w.brief(card.key);
    assert.equal(row.by, EXPLAIN_BY, label);
    assert.match(row.inputHash, /^[0-9a-f]{64}$/, label);
  };
  w.dispatch(card, 0); await step('발령', 1);
  w.finish(card, 1000); await step('완료', 2);
  const current = w.store.get(card.key);
  const resultFile = current.resultPath; fs.mkdirSync(path.dirname(resultFile), {recursive: true}); fs.writeFileSync(resultFile, '# 결과\n끝');
  w.store.update(card.key, {status: 'assigned', scope: '범위', board: 'b', role: 'worker', rallyId: 'x', rallyTitle: 'x', rallyRound: '1', rallyStep: 'implementation'}, {revision: current.revision, by: 'sup', note: '발령', noteKind: 'decision'});
  w.store.report(card.key, {revision: w.store.get(card.key).revision, resultFile, outcome: 'implemented', by: 'worker'});
  await step('결과 등록', 3);
  const decisions = new DecisionStore(w.home, {notify: () => {}, userNotify: () => null});
  const before = w.calls().length;
  const asked = decisions.request(card.key, {question: '합칠까요? 확인 경로 없음: 시험', options: ['합침', '보류'], recommendation: '합침', reason: '확인 경로 없음: 시험', work: '없음'}, '시험-슈퍼감독');
  w.clock.t += 60_000;
  {const {done} = w.run({decisions: decisions.list()}); await done;}
  assert.equal(w.calls().length, before + 1, '결정 요청');
  decisions.answer(asked.id, {revision: asked.revision, choice: '합침'}, '사용자');
  w.clock.t += 60_000;
  {const {done} = w.run({decisions: decisions.list()}); await done;}
  assert.equal(w.calls().length, before + 2, '결정 답');
  const held = w.makeCard('card-held');
  w.store.update(held.key, {status: 'hold'}, {revision: held.revision, by: 'sup', note: '보류', noteKind: 'decision'});
  w.clock.t += 60_000;
  {const {done} = w.run({decisions: decisions.list()}); await done;}
  assert.equal(w.calls().length, before + 3, '막힘(보류)');
  assert.equal(w.brief(old.key), null);
});

test('같은 입력은 사건이 다시 나도 호출 0이고, 메모로 revision만 올라도 요약이 화면에서 사라지지 않는다. 손으로 쓴 줄은 그대로다', async () => {
  const w = world();
  const card = w.makeCard();
  await enable(w);
  w.dispatch(card, 0);
  {const {done} = w.run(); await done;}
  assert.equal(w.calls().length, 1);
  {const {done} = w.run(); await done;}
  {const {done} = w.run(); await done;}
  assert.equal(w.calls().length, 1, '같은 입력·같은 사건은 다시 부르지 않는다');
  // 다른 사람이 메모를 남겨 revision만 오른다.
  const current = w.store.get(card.key);
  w.store.update(card.key, {}, {revision: current.revision, by: 'sup', note: '메모', noteKind: 'progress'});
  const center = () => buildCardCenter({cards: [w.store.get(card.key)], entries: taskIdentity(w.store.listSummaries()).project(w.raw), tree: [], runtimeKnown: false});
  const view = buildHumanBrief(center(), w.home).get(card.key);
  assert.equal(view.summary, '요약');
  assert.equal(view.stale, false);
  assert.equal(w.calls().length, 1, '화면 조회는 호출하지 않는다');
  // 손으로 쓴 줄은 revision이 오르면 요약을 숨긴다(지금 규칙 그대로).
  const manual = w.makeCard('card-manual');
  new BriefStore(w.home).write(manual.key, {revision: 1, title: '손', workstream: '손 묶음', summary: '손 요약'}, '서기');
  w.store.update(manual.key, {}, {revision: 1, by: 'sup', note: '메모', noteKind: 'progress'});
  const manualView = buildHumanBrief(buildCardCenter({cards: [w.store.get(manual.key)], entries: [], tree: []}), w.home).get(manual.key);
  assert.equal(manualView.summary, '');
  assert.equal(manualView.stale, true);
  // 입력이 실제로 바뀌면(결정 메모) 설명 AI 줄도 낡은 것으로 본다.
  const changed = w.store.get(card.key);
  w.store.update(card.key, {}, {revision: changed.revision, by: 'sup', note: '새 결정', noteKind: 'decision'});
  assert.equal(buildHumanBrief(center(), w.home).get(card.key).summary, '');
});

test('1순위가 시간 초과·실패면 대체 후보를 한 번 부르고, 둘 다 실패하면 쓰지 않고 같은 입력으로 다시 부르지 않는다', async () => {
  const w = world({chain: [{runner: 'fake', model: 'fail'}, {runner: 'fake', model: 'ok'}]});
  const card = w.makeCard();
  await enable(w);
  w.dispatch(card, 0);
  {const {done} = w.run(); await done;}
  assert.deepEqual(w.calls().map(c => c.mode), ['fail', 'ok']);
  assert.equal(w.brief(card.key).by, EXPLAIN_BY);
  assert.deepEqual(w.rows().at(-1).attempts.map(a => a.result), ['call-failed', 'ok']);

  const slow = world({chain: [{runner: 'fake', model: 'slow'}, {runner: 'fake', model: 'fail'}], timeoutMs: 400});
  const second = slow.makeCard();
  await enable(slow);
  slow.dispatch(second, 0);
  {const {done} = slow.run(); await done;}
  assert.deepEqual(slow.calls().map(c => c.mode), ['slow', 'fail']);
  assert.equal(slow.brief(second.key), null);
  const row = slow.rows().at(-1);
  assert.equal(row.outcome, 'failed');
  assert.deepEqual(row.attempts.map(a => a.result), ['timeout', 'call-failed']);
  slow.clock.t += 60_000;
  {const {done} = slow.run(); await done;}
  assert.equal(slow.calls().length, 2, '같은 입력은 시도 한 차례만 한다');
});

test('JSON이 아니거나 칸 규칙을 어기면 다음 대체 후보로 한 번 내려가고, 대체도 실패하면 쓰지 않으며 같은 입력으로 다시 부르지 않는다', async () => {
  for (const [model, reason] of [['garbage', 'not-json'], ['rule', 'field-rule:stage']]) {
    const w = world({chain: [{runner: 'fake', model}, {runner: 'fake', model}]});
    const card = w.makeCard();
    await enable(w);
    w.dispatch(card, 0);
    {const {done} = w.run(); await done;}
    assert.equal(w.brief(card.key), null);
    assert.equal(w.calls().length, 2, '체인 길이 안에서 후보마다 한 번씩만');
    const row = w.rows().at(-1);
    assert.equal(row.outcome, 'failed');
    assert.equal(row.reason, reason);
    assert.equal(row.attempts.length, 2);
    for (const a of row.attempts) assert.equal(typeof a.diag, 'object', '실패 시도마다 구조 진단이 남는다');
    w.clock.t += 60_000;
    {const {done} = w.run(); await done;}
    assert.equal(w.calls().length, 2, '같은 입력으로 다시 부르지 않는다');
    // 새 프로세스(감시 재시작)도 기록을 읽어 다시 부르지 않는다.
    const again = new ExplainAI({home: w.home, now: () => w.clock.t});
    again.tick({cards: w.store.listSummaries(), entries: taskIdentity(w.store.listSummaries()).project(w.raw), readEntries: () => w.raw});
    await again.drain();
    assert.equal(w.calls().length, 2);
  }
});

test('형식 실패(not-json·field-rule)는 대체 후보가 성공하면 written이고, 성공 시도에는 diag가 없다', async () => {
  for (const [model, result] of [['garbage', 'not-json'], ['rule', 'field-rule:stage']]) {
    const w = world({chain: [{runner: 'fake', model}, {runner: 'fake', model: 'ok'}]});
    const card = w.makeCard();
    await enable(w);
    w.dispatch(card, 0);
    {const {done} = w.run(); await done;}
    assert.deepEqual(w.calls().map(c => c.mode), [model, 'ok']);
    assert.equal(w.brief(card.key).by, EXPLAIN_BY);
    const row = w.rows().at(-1);
    assert.equal(row.outcome, 'written');
    assert.deepEqual(row.attempts.map(a => a.result), [result, 'ok']);
    assert.equal(typeof row.attempts[0].diag, 'object');
    assert.equal('diag' in row.attempts[1], false);
  }
});

test('실패 시도에는 출력 글자(excerpt)를 남기지 않고, 봉투 상태 envelope을 4가지로 가른다', async () => {
  const cases = [['leak', 'not-json', 'ok'], ['empty', 'not-json', 'field-empty'], ['nofield', 'not-json', 'field-missing'], ['notenv', 'not-json', 'not-json']];
  for (const [model, result, envelope] of cases) {
    const w = world({chain: [{runner: 'fake', model}]});
    const card = w.makeCard();
    await enable(w);
    w.dispatch(card, 0);
    {const {done} = w.run(); await done;}
    const [a] = w.rows().at(-1).attempts;
    assert.equal(a.result, result);
    assert.equal(a.diag.envelope, envelope, model);
    for (const k of ['excerpt', 'stderrExcerpt', 'envelope', 'outputBytes', 'error']) assert.equal(k in a, false, k);
    assertDiagSchema(a.diag);
  }
  // 호출 실패는 stderr 글자 대신 바이트 수·종료 코드만 남고, 봉투 상태는 붙지 않는다.
  const w = world({chain: [{runner: 'fake', model: 'fail'}]});
  const card = w.makeCard();
  await enable(w);
  w.dispatch(card, 0);
  {const {done} = w.run(); await done;}
  const [a] = w.rows().at(-1).attempts;
  assert.equal(a.result, 'call-failed');
  assert.equal(a.diag.stderrBytes, 5);
  assert.equal(a.diag.exitCode, 1);
  assert.equal('envelope' in a.diag, false);
  assert.equal(JSON.stringify(w.rows()).includes('boom'), false);
  assertDiagSchema(a.diag);
});

test('호출 중 revision이 바뀌면 입력이 같을 때만 새 revision으로 쓰고, 달라졌으면 답을 버린다. 어느 쪽도 같은 입력으로 다시 부르지 않고 재시작 뒤에도 같다', async () => {
  const body = JSON.stringify({response: JSON.stringify({title: '제목', workstream: '묶음', stage: '구현'})});
  for (const [note, kind, outcome] of [['잡담', 'progress', 'written'], ['새 결정', 'decision', 'stale']]) {
    let w, spawned = 0;
    const spawn = async () => {
      spawned++;
      const current = w.store.get('r/card-a');
      w.store.update('r/card-a', {}, {revision: current.revision, by: 'sup', note, noteKind: kind});
      return {status: 0, stdout: body, stderr: ''};
    };
    w = world({spawn});
    const card = w.makeCard();
    await enable(w);
    w.dispatch(card, 0);
    {const {done} = w.run(); await done;}
    assert.equal(w.rows().at(-1).outcome, outcome);
    assert.equal(Boolean(w.brief(card.key)), outcome === 'written');
    for (let i = 0; i < 3; i++) { w.clock.t += 60_000; const {done} = w.run(); await done; }
    const again = new ExplainAI({home: w.home, now: () => w.clock.t, spawn});
    again.tick({cards: w.store.listSummaries(), entries: taskIdentity(w.store.listSummaries()).project(w.raw), readEntries: () => w.raw});
    await again.drain();
    assert.equal(spawned, 1, `${outcome}: 같은 입력으로 다시 부르지 않는다(같은 사건 1개)`);
  }
});

test('감시 순회는 설명 AI 호출을 기다리지 않는다(느린 가짜 실행기)', async () => {
  const w = world({chain: [{runner: 'fake', model: 'slow'}], timeoutMs: 10_000});
  const card = w.makeCard();
  await enable(w);
  w.dispatch(card, 0);
  const started = performance.now();
  const {result, done} = w.run();
  const elapsed = performance.now() - started;
  assert.equal(result.queued, 1);
  assert.ok(elapsed < 1000, `tick은 대기열에 넣고 바로 돌아온다(${elapsed}ms)`);
  assert.ok(w.ai.running, 'AI 호출은 뒤에서 돈다');
  await w.ai.stop();
  await done;
});

test('한 주기에 대기열로 넣는 카드 수는 상한을 넘지 않는다', async () => {
  const w = world();
  const cards = ['a', 'b', 'c', 'd', 'e'].map(id => w.makeCard(`card-${id}`));
  await enable(w);
  for (const card of cards) w.dispatch(card, 0);
  const {result, done} = w.run(); await done;
  assert.equal(result.queued, 3);
  assert.equal(w.calls().length, 3);
  w.clock.t += 60_000;
  w.run().done; await w.ai.drain();
  assert.equal(w.calls().length, 5, '남은 카드는 다음 주기에 이어서 처리한다');
});

test('보내는 프롬프트에서 웹훅 주소·토큰 모양을 가린다', async () => {
  const w = world();
  const secretUrl = 'https://discord.com/api/webhooks/123456789/abcDEF_ghi-JKL';
  // 토큰 모양을 조각으로 이어 만든다(저장소에 토큰처럼 보이는 글자열을 두면 푸시 보호가 막는다).
  const botToken = ['MTIzNDU2Nzg5MDEyMzQ1Njc4OTA', 'GabcdE', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('.');
  const card = w.store.create({repo: 'r', id: 'card-secret', repoPath: w.home, title: '비밀', body: `웹훅 ${secretUrl} 토큰 ${botToken} sk-abcdefghijklmnopqrstuvwxyz123456`});
  await enable(w);
  w.dispatch(card, 0);
  {const {done} = w.run(); await done;}
  const [call] = w.calls();
  assert.ok(call.prompt.includes('[주소 가림]'));
  for (const leak of [secretUrl, botToken, 'abcDEF_ghi-JKL', 'sk-abcdefghijklmnopqrstuvwxyz123456']) assert.ok(!call.prompt.includes(leak), leak);
  assert.equal(scrubForAI('Bearer abcdefghijklmnopqrstuvwxyz0123'), '[가림]');
  assert.ok(!JSON.stringify(w.rows()).includes('웹훅'), '시도 기록에는 프롬프트·출력 본문이 없다');
});

test('설명 AI 모듈은 네트워크 모듈을 가져오지 않고 실행기 이름으로 가르지 않는다', () => {
  for (const file of ['explain-ai', 'explain-input', 'explain-events']) {
    const text = fs.readFileSync(new URL(`../src/${file}.mjs`, import.meta.url), 'utf8');
    assert.ok(!/node:(http|https|net|dgram)|\bfetch\(/.test(text), `${file}: 네트워크`);
    assert.ok(!/['"`](agy|claude|codex|gemini|haiku)['"`]/i.test(text.replace(/\/\/.*$/gm, '')), `${file}: 실행기 이름 분기`);
  }
});

test('설정: explain은 exec 틀이 있는 실행기만 고르고 대체 후보는 1개까지, 감시 AI·시니어 codex 고정은 그대로다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-explain-settings-'));
  fs.writeFileSync(path.join(home, 'agent-runners.json'), JSON.stringify({runners: [
    {id: 'codex', spawn: 'codex --model {model} -c model_reasoning_effort="{effort}"'},
    {id: 'agy', spawn: 'agy --model {model}', exec: 'agy --print {prompt} --model {model} --output-format json', execField: 'response'},
    {id: 'claude-code', spawn: 'claude --model {model} --effort {effort}', exec: 'claude -p --model {model} --output-format json', execField: 'result'},
    {id: 'devin', spawn: 'devin --model {model}'},
  ]}));
  const records = [], record = e => records.push(e);
  let settings = initSettings(home, {by: 'kyle', reason: '시험', record});
  const meta = () => ({by: 'kyle', reason: '시험', record, revision: readSettings(home).revision, readCodexModels: () => ({models: [{slug: 'gpt-6-sol', supported_reasoning_levels: [{effort: 'low'}]}]})});
  settings = readSettings(home);
  assert.equal(settings.runners.agy.execField, 'response');
  for (const [runner, model] of [['agy', 'flash'], ['claude', 'haiku']]) {
    setRunner(runner, model);
  }
  function setRunner(runner, model) {
    const current = readSettings(home);
    if (!current.runners[runner].models.some(m => m.model === model)) {
      current.runners[runner].models.push({model, efforts: []});
      fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify(current));
    }
  }
  // exec 틀이 없는 실행기는 거절한다.
  assert.throws(() => setRole(home, {role: 'explain', runner: 'devin', model: 'x', ...meta()}), /실행기|모델/);
  setRunner('devin', 'x');
  assert.throws(() => setRole(home, {role: 'explain', runner: 'devin', model: 'x', ...meta()}), /exec 미지원/);
  // 강도는 exec 틀에 {effort}가 있을 때만 받는다. 이 틀들은 받지 않는다.
  assert.throws(() => setRole(home, {role: 'explain', runner: 'agy', model: 'flash', effort: 'high', ...meta()}), /강도를 받지 않는다/);
  setRole(home, {role: 'explain', runner: 'agy', model: 'flash', ...meta()});
  setFallback(home, {role: 'explain', items: [{runner: 'claude', model: 'haiku'}], ...meta()});
  assert.throws(() => setFallback(home, {role: 'explain', items: [{runner: 'claude', model: 'haiku'}, {runner: 'agy', model: 'flash'}], ...meta()}), /최대 2개/);
  const chain = explainChain(readSettings(home));
  assert.deepEqual(chain.map(c => [c.runner, c.model]), [['agy', 'flash'], ['claude', 'haiku']]);
  // kadan runners show: 설명 AI 줄과 대체 후보가 실행기 표의 exec 틀로 보인다.
  const shown = runnersCommand(['show'], {}, {home, by: 'kyle', record});
  assert.match(shown.launch.explain, /^agy --print .* --model flash /);
  assert.match(shown.fallback.explain[0].cmd, /^claude -p --model haiku /);
  // 감시 AI·시니어는 여전히 codex만 고른다.
  assert.throws(() => setRole(home, {role: 'watch', runner: 'agy', model: 'flash', ...meta()}), /codex 실행기만/);
  assert.throws(() => setRole(home, {role: 'senior', runner: 'agy', model: 'flash', ...meta()}), /안전하게 묶을 수 있는 실행기\(codex\)만/);
  // 틀 채우기: {prompt}가 있으면 인자(따옴표 처리), 없으면 표준 입력.
  const filled = readSettings(home);
  const asArg = execCommand(filled, 'agy', {model: 'flash', prompt: "it's $(x)"});
  assert.equal(asArg.command, 'agy --print "$KADAN_EXPLAIN_PROMPT" --model flash --output-format json');
  assert.deepEqual(asArg.env, {KADAN_EXPLAIN_PROMPT: "it's $(x)"});
  assert.equal(asArg.stdin, '');
  const asStdin = execCommand(filled, 'claude', {model: 'haiku', prompt: '글'});
  assert.equal(asStdin.command, 'claude -p --model haiku --output-format json');
  assert.equal(asStdin.stdin, '글');
  assert.equal(asStdin.field, 'result');
  assert.deepEqual(asStdin.env, {});
  // 폴백 1순위의 exec 틀을 나중에 비우면 설명 AI는 쉰다.
  const emptied = readSettings(home);
  delete emptied.runners.agy.exec;
  assert.equal(explainChain(emptied), null);
});

// 감시 순회 쪽 연결: 설명 AI가 느리거나 실패해도 순회는 매 주기 돌고, 끝날 때 정리한다.
test('감시 순회는 설명 AI 점검이 실패해도 매 주기 이어지고, 설명 AI 점검 값에는 읽은 카드·사건·결정이 담긴다', async () => {
  const epoch = Date.parse('2026-09-09T00:00:00Z');
  const starts = [{kind: 'start', role: 'w1', session: 'kadan-w1', panePid: 1, t: new Date(epoch).toISOString()}];
  const cards = [{id: 'w1', key: 'r/w1', role: 'w1', status: 'assigned', workType: 'execution'}];
  const entries = [...starts, {kind: 'send', role: 'w1', taskId: 'w1', t: new Date(epoch).toISOString()}];
  const parents = new Map([['w1', 'top'], ['top', '@user']]);
  const controller = new AbortController();
  const seen = [];
  let cycle = 0, stopped = false;
  const explain = {tick: args => { seen.push(args); throw new Error('설명 AI 고장'); }, stop: async () => { stopped = true; }};
  const printed = [];
  await runWatch({signal: controller.signal, intervalMs: 1000, stallN: 1, parents, routes: new Map(), superRole: 'top',
    floor: {list: () => starts.map(x => ({session: x.session, pid: x.panePid})), read: () => 'unchanged'},
    readEntries: () => entries, readCards: () => cards, readDecisions: () => [{id: 'd1', card: 'r/w1'}], now: () => epoch + cycle * 1000, explain,
    sendAlert: () => {}, record: () => {}, print: text => printed.push(text), spawn: cmd => ({status: 0, stdout: cmd === 'memory_pressure' ? 'System-wide memory free percentage: 80%' : '', stderr: ''}),
    sleep: async () => { await new Promise(resolve => setImmediate(resolve)); if (++cycle === 4) controller.abort(); }});
  assert.equal(seen.length, 4, '설명 AI 점검이 매 주기 불렸다');
  assert.equal(seen[0].cards.length, 1);
  assert.deepEqual(seen[0].decisions, [{id: 'd1', card: 'r/w1'}]);
  assert.ok(seen[0].liveSessions instanceof Set);
  assert.equal(typeof seen[0].readEntries, 'function');
  assert.ok(printed.some(text => text.includes('설명 AI 점검 실패')));
  assert.equal(stopped, true);
});

// ---- 2라운드 수정(검수 F1~F7·S1·S2)의 회귀 시험 ----
const brief = JSON.stringify({response: JSON.stringify({title: '제목', workstream: '묶음', stage: '구현'})});
const gate = () => { let open; const wait = new Promise(resolve => { open = resolve; }); return {wait, open}; };

test('F1 {prompt}는 독립 낱말일 때만 저장된다: 따옴표·글자에 붙은 틀은 저장 단계에서 거절한다', () => {
  for (const bad of ['agy --print "{prompt}"', "agy --print '{prompt}'", 'agy --print x{prompt}', 'agy --print={prompt}', 'agy --print {prompt}y']) assert.throws(() => checkExecTemplate(bad), /독립 낱말/, bad);
  for (const good of ['agy --print {prompt} --x', '{prompt}', 'agy {model}']) checkExecTemplate(good);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-explain-save-'));
  fs.writeFileSync(path.join(home, 'agent-runners.json'), JSON.stringify({runners: [{id: 'codex', spawn: 'codex {model}'}, {id: 'agy', spawn: 'agy --model {model}'}]}));
  initSettings(home, {by: 'kyle', reason: '시험', record: () => {}});
  for (const bad of ['agy --print "{prompt}"', "agy --print '{prompt}'", 'agy --print x{prompt}'])
    assert.throws(() => saveRunner(home, {runner: 'agy', table: {exec: bad}, revision: 1, by: 'kyle', reason: '시험', record: () => {}}), /독립 낱말/, bad);
  saveRunner(home, {runner: 'agy', table: {exec: 'agy --print {prompt} --model {model}'}, revision: 1, by: 'kyle', reason: '시험', record: () => {}});
});

test('F1 독립 낱말 틀에 명령 치환·백틱·작은따옴표·줄바꿈이 든 카드 글을 넣어도 실행되지 않고 원문이 그대로 전달된다', async () => {
  const w = world({exec: `node '${fake}' {model} {prompt}`});
  const marks = ['one', 'two', 'three'].map(name => path.join(w.home, `MARK-${name}`));
  const evil = `$(touch ${marks[0]}) \`touch ${marks[1]}\` it's "q" ; touch ${marks[2]}\n둘째 줄 $& $\` {cwd}`;
  const card = w.store.create({repo: 'r', id: 'card-evil', repoPath: w.home, title: '악성', body: evil});
  await enable(w);
  w.dispatch(card, 0);
  {const {done} = w.run(); await done;}
  for (const mark of marks) assert.ok(!fs.existsSync(mark), `${mark} 가 생겼다 — 카드 글이 셸 문법으로 실행됐다`);
  const [call] = w.calls();
  assert.ok(call, '호출이 있었다');
  assert.ok(call.prompt.includes(JSON.stringify(evil).slice(1, -1)), '카드 글 원문이 JSON 직렬화된 모양 그대로 프롬프트에 있다');
  assert.equal(w.rows().at(-1).outcome, 'written');
});

test('F2 호출 중인 같은 입력은 다음 주기에 다시 예약하지 않고 호출 직전에도 시도 기록을 확인한다', async () => {
  const g = gate();
  let spawned = 0;
  const w = world({spawn: async () => { spawned++; await g.wait; return {status: 0, stdout: brief, stderr: ''}; }});
  const card = w.makeCard();
  await enable(w);
  w.dispatch(card, 0);
  const first = w.run();
  assert.equal(first.result.queued, 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  for (let i = 0; i < 3; i++) { w.clock.t += 60_000; assert.equal(w.run().result.queued, 0, '호출 중인 카드는 다시 예약하지 않는다'); }
  g.open(); await w.ai.drain();
  assert.equal(spawned, 1);
  assert.equal(w.rows().filter(r => r.kind === 'explain-call').length, 1);
  // 대기열에 이미 들어 있던 작업도 호출 직전에 시도 기록이 있으면 부르지 않는다.
  w.ai.attempted.add('r/card-z|h');
  await w.ai.run({key: 'r/card-z', hash: 'h', ids: [{id: 'x', at: 1}], input: {}, revision: 1, resultPath: null});
  assert.equal(spawned, 1);
});

test('F4 설명 AI 줄은 입력 지문이 달라지면 revision이 같아도 숨는다(원장 완료만 추가돼도)', async () => {
  const w = world();
  const card = w.makeCard();
  await enable(w);
  w.dispatch(card, 0);
  {const {done} = w.run(); await done;}
  const view = () => buildHumanBrief(buildCardCenter({cards: [w.store.get(card.key)], entries: taskIdentity(w.store.listSummaries()).project(w.raw), tree: [], runtimeKnown: false}), w.home).get(card.key);
  assert.equal(view().summary, '요약');
  w.finish(card, 5000);
  const after = view();
  assert.equal(after.summary, '', '완료로 입력이 바뀌었으니 옛 요약은 숨는다');
  assert.equal(after.stale, true);
});

test('F5 출력이 상한(1MiB)을 넘으면 묶음을 끝내고 사유만 남기며 설명 줄을 쓰지 않고 대체 후보로 내려가지 않는다', async () => {
  const w = world({chain: [{runner: 'fake', model: 'huge'}, {runner: 'fake', model: 'ok'}]});
  const card = w.makeCard();
  await enable(w);
  w.dispatch(card, 0);
  const started = Date.now();
  {const {done} = w.run(); await done;}
  assert.ok(Date.now() - started < 20_000);
  assert.equal(w.brief(card.key), null);
  assert.deepEqual(w.calls().map(c => c.mode), ['huge']);
  const row = w.rows().at(-1);
  assert.equal(row.outcome, 'failed');
  assert.equal(row.reason, 'output-limit');
});

test('F6 프롬프트에 들어가는 모든 글(담당·작성자·결정 문구·메모)에서 토큰 모양을 가린다', () => {
  const token = ['MTIzNDU2Nzg5MDEyMzQ1Njc4OTA', 'GabcdE', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('.');
  const key = 'sk-' + 'abcdefghijklmnopqrstuvwxyz123456';
  const card = {key: 'r/a', id: 'a', title: token, body: key, role: token, status: 'assigned', displayState: 'running',
    history: [{noteKind: 'decision', by: key, note: token}], result: null};
  const decisions = [{status: 'answered', question: key, options: [token, 'b'], recommendation: key, answer: {text: token}, cancelReason: key}];
  const input = buildExplainInput(card, {progress: key, decisions});
  const text = buildExplainPrompt(input, token, key);
  for (const leak of [token, key]) assert.ok(!text.includes(leak) && !JSON.stringify(input).includes(leak), leak);
});

test('F7 칸을 비우면 대기열이 무효가 되어, 다시 켠 뒤에도 옛 대기열이 실행되지 않는다', async () => {
  const g = gate();
  let spawned = 0;
  const w = world({spawn: async () => { spawned++; await g.wait; return {status: 0, stdout: brief, stderr: ''}; }});
  const cards = ['a', 'b', 'c'].map(id => w.makeCard(`card-${id}`));
  await enable(w);
  for (const card of cards) w.dispatch(card, 0);
  w.run();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(w.ai.queue.length, 2);
  w.writeSettings({});
  w.clock.t += 60_000; w.run();
  assert.equal(w.ai.queue.length, 0, '끄면 대기열을 비운다');
  w.writeSettings({explain: {runner: 'fake', model: 'ok'}});
  w.clock.t += 60_000; w.run();
  g.open(); await w.ai.drain();
  assert.equal(spawned, 1, '호출 중이던 첫 작업만 끝나고 나머지는 실행되지 않는다');
  assert.deepEqual(w.rows().filter(r => r.kind === 'explain-state').map(r => r.state), ['enabled', 'disabled', 'enabled']);
});

test('S1 자리 채우기는 한 번에 처리해 $& 같은 치환 문법과 값 안의 {cwd}를 원문 그대로 둔다', () => {
  const out = fillTemplate('run {model} {prompt} {cwd}', {model: 'm', prompt: '$& $` $\' $$ {cwd} {model}', cwd: '/w'});
  assert.equal(out, 'run m $& $` $\' $$ {cwd} {model} /w');
});

test('S2 결과 파일이 등록 뒤에 바뀌면 발췌를 빼고 그 사유를 입력에 적는다', async () => {
  const w = world();
  const card = w.makeCard();
  await enable(w);
  const current = w.store.get(card.key);
  fs.mkdirSync(path.dirname(current.resultPath), {recursive: true});
  fs.writeFileSync(current.resultPath, '# 진짜 결과');
  w.store.update(card.key, {status: 'assigned', scope: '범위', board: 'b', role: 'worker', rallyId: 'x', rallyTitle: 'x', rallyRound: '1', rallyStep: 'implementation'}, {revision: current.revision, by: 'sup', note: '발령', noteKind: 'decision'});
  w.store.report(card.key, {revision: w.store.get(card.key).revision, outcome: 'implemented', by: 'worker'});
  fs.writeFileSync(current.resultPath, '# 바뀐 결과 SECRET-TAMPER');
  w.clock.t += 60_000;
  {const {done} = w.run(); await done;}
  const [call] = w.calls();
  assert.ok(!call.prompt.includes('SECRET-TAMPER') && !call.prompt.includes('진짜 결과'));
  assert.ok(call.prompt.includes('결과 파일이 등록한 뒤에 바뀌어 발췌를 뺐다'));
});

// ---- PR #208 5라운드: 실패 진단은 '구조만 기록'(자유 글자 0). 합격 기준은 사례 나열이 아니라 두 성질이다. ----
// 성질 1(도식): 원장을 다시 읽은 모든 시도의 문자열·숫자가 허용 집합 안에 있다.
// 성질 2(누출): 어떤 비밀·포장을 넣어도 원장 시도 기록에 비밀의 5자 이상 부분 문자열이 없다.
//   (숫자로만 된 4자리 이하는 길이·값 칸이 허용하는 값이라 검사에서 뺀다. 5자리 이상 숫자 조각은 검사한다.)
const ATTEMPT_KEYS = ['runner', 'model', 'fallbackIndex', 'result', 'durationMs', 'diag'];
const DIAG_KEYS = ['envelope', 'shape', 'answerShape', 'words', 'stdoutBytes', 'stderrBytes', 'exitCode', 'signal'];
const SHAPE_KEYS = ['t', 'n', 'v', 'keys', 'unknown', 'extra', 'k'];
const count = v => Number.isInteger(v) && v >= 0;
function assertShape(node, depth, where) {
  for (const k of Object.keys(node)) assert.ok(SHAPE_KEYS.includes(k), `${where}: 낯선 칸 ${k}`);
  assert.ok(VALUE_KINDS.includes(node.t), `${where}: 종류 ${node.t}`);
  if ('k' in node) assert.ok(KEY_NAMES.includes(node.k) || node.k === UNKNOWN_KEY, `${where}: 키 ${node.k}`);
  for (const k of ['n', 'unknown', 'extra']) if (k in node) assert.ok(count(node[k]), `${where}: ${k}`);
  if ('v' in node) { assert.equal(node.t, 'number', where); assert.ok(node.v >= 0 && node.v <= 9999 && Number.isInteger(node.v), `${where}: v ${node.v}`); }
  if ('keys' in node) {
    assert.ok(depth <= 2 && node.t === 'object' && node.keys.length <= MAX_KEYS, `${where}: 키 펼침 한도`);
    for (const child of node.keys) assertShape(child, depth + 1, where);
  }
}
function assertDiagSchema(diag, where = 'diag') {
  for (const k of Object.keys(diag)) assert.ok(DIAG_KEYS.includes(k), `${where}: 낯선 칸 ${k}`);
  if ('envelope' in diag) assert.ok(ENVELOPE_STATES.includes(diag.envelope), where);
  assert.ok(Array.isArray(diag.words) && new Set(diag.words).size === diag.words.length, `${where}: words`);
  for (const id of diag.words) assert.ok(WORD_IDS.includes(id), `${where}: 낱말 ${id}`);
  for (const k of ['stdoutBytes', 'stderrBytes', 'exitCode']) if (k in diag) assert.ok(count(diag[k]), `${where}: ${k}`);
  if ('signal' in diag) assert.ok(SIGNAL_NAMES.includes(diag.signal), `${where}: 신호 ${diag.signal}`);
  for (const k of ['shape', 'answerShape']) if (k in diag) assertShape(diag[k], 1, `${where}.${k}`);
}
function assertLedgerSchema(rows, where) {
  const attempts = rows.flatMap(r => r.attempts ?? []);
  for (const a of attempts) {
    for (const k of Object.keys(a)) assert.ok(ATTEMPT_KEYS.includes(k), `${where}: 시도 칸 ${k}`);
    assert.match(a.result, /^(ok|timeout|output-limit|call-failed|template-error|not-json|field-rule:[a-z]+)$/, where);
    if ('diag' in a) assertDiagSchema(a.diag, where);
  }
  return attempts;
}

const PROP_SEED = 20261020;
const PROP_RUNS = 300;
function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-./+=';
const wrappers = {
  plain: s => `oops ${s} done`,
  json1: s => JSON.stringify({response: `x ${s} y`}),
  json2: s => JSON.stringify({response: JSON.stringify({response: `x\n${s}\ny`})}),
  percent: s => JSON.stringify({response: encodeURIComponent(s)}),
  unicode: s => `{"response":"${[...s].map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('')}"}`,
  control: s => `{"response":"\\b\\f\\n${s}\\b"}`,
  edge4k: s => `${'z '.repeat(2040)}${'q'.repeat(8)}${s}${' tail'.repeat(500)}`,
  edge300: s => `${'ab '.repeat(97)}${s} tail`,
  asKey: s => JSON.stringify({[s]: 1, response: ''}),
  nested: s => JSON.stringify({error: {message: s, detail: {x: s}}, response: ''}),
};
const sub5 = (text, secret) => { for (let k = 0; k + 5 <= secret.length; k++) { const piece = secret.slice(k, k + 5); if (text.includes(piece)) return piece; } return null; };
async function ledgerFor(stdout, stderr = '', status = 0) {
  const w = world({chain: [{runner: 'fake', model: 'ok'}], spawn: async () => ({status, stdout, stderr})});
  const card = w.makeCard();
  await enable(w);
  w.dispatch(card, 0);
  {const {done} = w.run(); await done;}
  return w.rows();
}

test('도식 시험: 실패 시도 원장은 허용 집합 밖의 문자열·숫자·칸이 없다(원장 재독)', async () => {
  const bodies = [JSON.stringify({response: '', error: {code: 429, message: 'quota exceeded'}}), 'plain text 12345', '',
    JSON.stringify({response: 'x', 'bad key!': 1, n: 12345, f: 1.5, neg: -3, ok: true, z: null, arr: [1, 2, 3], deep: {a: {b: {c: 1}}}}),
    JSON.stringify(Object.fromEntries(Array.from({length: 40}, (_, i) => ['k' + String.fromCharCode(97 + (i % 26)).repeat(1 + (i % 3)) + 'x'.repeat(i % 7), i])))];
  for (const body of bodies) for (const [stdout, stderr, status] of [[body, '', 0], ['', body, 1]]) {
    const rows = await ledgerFor(stdout, stderr, status);
    const attempts = assertLedgerSchema(rows, body.slice(0, 20));
    assert.ok(attempts.some(a => 'diag' in a));
  }
  // 도식 자체가 시험을 통과시키는지(허용 밖 값을 넣으면 실제로 걸리는지) 한 번 거꾸로 본다.
  assert.throws(() => assertDiagSchema({words: [], stdoutBytes: 1, stderrBytes: 0, shape: {t: 'number', v: 10000}}));
  assert.throws(() => assertDiagSchema({words: ['not-an-id'], stdoutBytes: 1, stderrBytes: 0}));
  assert.throws(() => assertDiagSchema({words: [], stdoutBytes: 1, stderrBytes: 0, excerpt: 'x'}));
  assert.throws(() => assertDiagSchema({words: [], stdoutBytes: 1, stderrBytes: 0, shape: {t: 'object', keys: [{k: 'a b', t: 'string'}]}}));
});

test('shapeOf: 키는 두 단계까지, 고정 목록 밖 키는 unknown으로 세고, 숫자는 0~9999 정수 값만 남긴다', () => {
  const s = shapeOf({response: '', error: {code: 429, message: 'quota exceeded', type: {a: 1}}, 'a-b': 1, 'k1': 2, SecretLookingKey: 3,
    usage: 10000, stats: 1.5, models: -1, status: true, reason: null, output: [1, 2]});
  const by = Object.fromEntries(s.keys.map(k => [k.k, k]));
  assert.deepEqual(by.response, {k: 'response', t: 'string', n: 0});
  assert.deepEqual(by.error.keys.map(k => [k.k, k.t, k.n, k.v]), [['code', 'number', undefined, 429], ['message', 'string', 14, undefined], ['type', 'object', 1, undefined]]);
  assert.equal('keys' in by.error.keys[2], false); // 세 단계째는 펼치지 않는다
  assert.equal(s.unknown, 3); // 'a-b', 'k1', 'SecretLookingKey'(정규식은 넘지만 목록에 없다)
  assert.ok(!JSON.stringify(s).includes('SecretLookingKey'));
  for (const k of ['usage', 'stats', 'models']) assert.equal('v' in by[k], false, k);
  assert.deepEqual(by.output, {k: 'output', t: 'array', n: 2});
  const wide = shapeOf(Object.fromEntries(KEY_NAMES.slice(0, 20).map((c, i) => [c, i])));
  assert.equal(wide.keys.length, MAX_KEYS);
  assert.equal(wide.extra, 4);
});

test('고정 목록: 신호·시스템 오류 코드는 목록 안의 것만 남는다', () => {
  assert.equal(buildDiag({stdout: '', stderr: '', signal: 'SIGTERM'}).signal, 'SIGTERM');
  for (const fake of ['SIGFAKESECRET', 'SIGXYZ', 'sigterm', '', null]) assert.equal('signal' in buildDiag({stdout: '', stderr: '', signal: fake}), false, String(fake));
  assert.ok(ERRNO_CODES.includes('ENOSPC') && !ERRNO_CODES.includes('EFAKESECRET'));
});

test('낱말 id: 고정 목록과 맞은 것만, 중복 없이 남는다', () => {
  assert.deepEqual(wordIds('Quota EXCEEDED', 'quota again'), ['quota']);
  assert.deepEqual(wordIds('', ''), []);
  assert.ok(wordIds('429 Too Many Requests').includes('rate-limit-429'));
  assert.ok(wordIds('Invalid API key provided').includes('invalid_api_key'));
  assert.ok(WORD_IDS.every(id => /^[a-z0-9_-]+$/.test(id)));
});

// 3라운드 검수가 만든 실제 형식 표본 24종(전부 지어낸 값). 포장 8종 × 출력 통로 2개로 돌린다.
const REAL = (() => {
  const alnum = 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY';
  const password = 'P7f9K2m4Q6r8,T1v3W5x7Y9z2,A4b6C8d0E2f4';
  const cookie = 'P7f9K2m4Q6r8{T1v3W5x7Y9z2}A4b6C8d0E2f4';
  const b64 = s => Buffer.from(s).toString('base64url');
  return [
    ['openai', 'sk-proj-' + alnum.repeat(3)], ['anthropic', 'sk-ant-api03-' + alnum.repeat(3)],
    ['github-classic', 'ghp_' + alnum + 'aB3d'], ['github-fine', 'github_pat_' + alnum.repeat(2)],
    ['slack-bot', 'xoxb-123456789012-123456789012-' + alnum.slice(0, 24)],
    ['slack-user', 'xoxp-123456789012-123456789012-123456789012-' + alnum],
    ['discord-bot', alnum.slice(0, 24) + '.' + alnum.slice(0, 6) + '.' + alnum],
    ['discord-webhook', 'https://discord.com/api/webhooks/123456789012345678/' + alnum.repeat(2)],
    ['jwt', b64('{"alg":"HS256","typ":"JWT"}') + '.' + b64('{"sub":"fake-review-user","exp":2000000000}') + '.' + alnum],
    ['google-api', 'AIza' + (alnum + 'aB3').slice(0, 35)], ['google-oauth', 'ya29.' + alnum.repeat(3)],
    ['aws-access-id', 'AKIA' + 'A1B2C3D4E5F6G7H8'], ['aws-secret', (alnum + '/+=xYz12').slice(0, 40)],
    ['url-simple', 'postgresql://fake-user:' + alnum + '@db.invalid/test'],
    ['url-comma-password', 'postgresql://fake-user:' + password + '@db.invalid/test'],
    ['cookie-base64url', 'sid=' + alnum], ['cookie-braces', 'sid=' + cookie],
    ['cookie-brackets', 'sid=' + cookie.replace('{', '[').replace('}', ']')],
    ['session-uuid', 'a1b2c3d4-e5f6-4789-abcd-1234567890ef'], ['session-hex128', 'a1b2c3d4e5f67890aabbccddeeff0011'],
    ['session-hex64', 'a1b2c3d4e5f67890'], ['basic-auth', 'Basic ' + Buffer.from('user:pass').toString('base64')],
    ['bearer-long', 'Bearer ' + alnum.repeat(2)], ['bearer-short', 'Bearer a1b2c3d4e5f67890'],
  ];
})();
const REAL_WRAP = {
  plain: s => `error ${s} end`,
  json1: s => JSON.stringify({response: s}),
  json2: s => JSON.stringify({response: JSON.stringify({error: s})}),
  percent: s => JSON.stringify({response: encodeURIComponent(s)}),
  unicode: s => '{"response":"' + [...s].map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '"}',
  controls: s => JSON.stringify({response: '\b\f\n' + s + '\t\r'}),
  slash: s => JSON.stringify({response: s}).replaceAll('/', '\\/'),
  doubleControl: s => JSON.stringify({response: JSON.stringify({error: '\b\n' + s})}),
};

test(`누출 성질 시험 A: 실제 형식 ${REAL.length}종 × 포장 ${Object.keys(REAL_WRAP).length}종 × 출력 통로 2개, 원장 재독에 비밀 5자 이상 조각 0`, async () => {
  assert.equal(REAL.length, 24);
  let cases = 0;
  for (const [name, secret] of REAL) for (const [wrap, fn] of Object.entries(REAL_WRAP)) for (const viaStderr of [false, true]) {
    const out = fn(secret);
    const rows = await ledgerFor(viaStderr ? '' : out, viaStderr ? out : '', viaStderr ? 1 : 0);
    const attempts = assertLedgerSchema(rows, `${name}/${wrap}`);
    const text = JSON.stringify(attempts);
    for (const form of [secret, encodeURIComponent(secret)]) assert.equal(sub5(text, form), null, `${name}/${wrap}/${viaStderr ? 'stderr' : 'stdout'}`);
    cases++;
  }
  assert.equal(cases, 24 * 8 * 2);
});

test(`누출 성질 시험 B(시드 ${PROP_SEED}, ${PROP_RUNS}회): 무작위 비밀(구분자·숫자 포함)을 어떤 포장·통로로 넣어도 원장 재독에 5자 이상 조각 0, 도식 통과`, async () => {
  const rand = rng(PROP_SEED);
  const alpha = ALNUM + ':",{}[] \\';
  const names = Object.keys(wrappers);
  for (let i = 0; i < PROP_RUNS; i++) {
    const len = 20 + Math.floor(rand() * 61);
    const secret = Array.from({length: len}, () => alpha[Math.floor(rand() * alpha.length)]).join('').trim();
    const name = names[Math.floor(rand() * names.length)];
    const out = wrappers[name](secret);
    const viaStderr = rand() < 0.5;
    const rows = await ledgerFor(viaStderr ? '' : out, viaStderr ? out : '', viaStderr ? 1 : 0);
    const where = `#${i} ${name} ${viaStderr ? 'stderr' : 'stdout'} secret=${JSON.stringify(secret)}`;
    const attempts = assertLedgerSchema(rows, where);
    assert.ok(attempts.length > 0 && attempts.every(a => 'diag' in a), where);
    const text = JSON.stringify(attempts);
    for (const form of [secret, encodeURIComponent(secret)]) assert.equal(sub5(text, form), null, where);
  }
});

test('진단 쓸모: 한 줄 봉투 {response:"",error:{code:429,message:"quota exceeded"}}는 구조·낱말 id로 원인이 읽힌다', async () => {
  const env = {response: '', error: {code: 429, message: 'quota exceeded'}};
  for (const [name, body] of [['한 줄', JSON.stringify(env)], ['줄바꿈', JSON.stringify(env, null, 1)]]) {
    const [{diag}] = assertLedgerSchema(await ledgerFor(body), name);
    assert.equal(diag.envelope, 'field-empty', name);
    const by = Object.fromEntries(diag.shape.keys.map(k => [k.k, k]));
    assert.deepEqual([by.response.t, by.response.n], ['string', 0], name);
    assert.deepEqual([by.error.t, by.error.n], ['object', 2], name);
    const inner = Object.fromEntries(by.error.keys.map(k => [k.k, k]));
    assert.equal(inner.code.v, 429, name);
    assert.deepEqual([inner.message.t, inner.message.n], ['string', 14], name);
    assert.ok(diag.words.includes('quota'), name);
    assert.ok(diag.words.includes('rate-limit-429') === false);
    assert.equal(diag.stdoutBytes, Buffer.byteLength(body));
    assert.equal('answerShape' in diag, false); // 답이 빈 글이라 안쪽 구조가 없다
  }
  // 봉투 안 답이 JSON이지만 규칙을 어기면 안쪽 구조(answerShape)도 남는다.
  const inner = JSON.stringify({title: '제목', workstream: '묶음', stage: '없는단계'});
  const [{diag, result}] = assertLedgerSchema(await ledgerFor(JSON.stringify({response: inner})), 'inner').map(a => ({...a}));
  assert.equal(result, 'field-rule:stage');
  assert.deepEqual(diag.answerShape.keys.map(k => [k.k, k.t, k.n]), [['title', 'string', 2], ['workstream', 'string', 2], ['stage', 'string', 4]]);
});

test('진단 쓸모: 평문 오류 stderr는 맞는 낱말 id만 남기고 글자는 남기지 않는다', async () => {
  const stderr = 'Error: 429 Too Many Requests — rate limit reached for model; Unauthorized (401 Unauthorized) context length exceeded';
  const rows = await ledgerFor('', stderr, 1);
  const [{diag, result}] = assertLedgerSchema(rows, 'stderr');
  assert.equal(result, 'call-failed');
  assert.deepEqual(diag.words.sort(), ['auth-token', 'context_length', 'rate-limit-429', 'rate-limit-text', 'unauthorized']);
  assert.equal(diag.stderrBytes, Buffer.byteLength(stderr));
  assert.equal(diag.exitCode, 1);
  assert.equal('shape' in diag, false);
  assert.equal(JSON.stringify(rows).includes('Too Many'), false);
});

test('S1: 성공 시도에는 diag가 남지 않는다(경고만 stderr에 있어도)', async () => {
  const body = JSON.stringify({response: JSON.stringify({title: '제목', workstream: '묶음', stage: '구현'})});
  const [a] = assertLedgerSchema(await ledgerFor(body, 'warn: quota'), 'ok');
  assert.equal(a.result, 'ok');
  assert.equal('diag' in a, false);
});

test('설명 AI 원장 코드에 발췌·덩어리 가림 코드가 없다(프롬프트용 scrubForAI는 그대로)', () => {
  for (const file of ['explain-ai', 'explain-input', 'explain-diag']) {
    const text = fs.readFileSync(new URL(`../src/${file}.mjs`, import.meta.url), 'utf8');
    assert.ok(!/excerptOf|stderrExcerpt|EXCERPT_|LAST_CHUNK/.test(text), file);
  }
  for (const file of ['explain-ai', 'explain-diag']) assert.ok(!/가림/.test(fs.readFileSync(new URL(`../src/${file}.mjs`, import.meta.url), 'utf8')), file);
});

// ---- PR #208 6라운드: explain-call 줄 전체의 문자열 값은 허용 집합 안에만 있다(F1 저장 오류 원문 제거). ----
// 허용: 메타데이터 칸(kind·by·at·key·inputHash·eventIds·시도의 runner·model), 고정 코드(outcome·reason·result), 구조 진단.
const CALL_KEYS = ['kind', 'by', 'at', 'key', 'inputHash', 'eventIds', 'outcome', 'reason', 'attempts'];
const OUTCOMES = ['written', 'failed', 'stale'];
const REASON_RE = new RegExp(`^(rewrote-at-new-revision|revision-changed|no-attempt|write-failed(:(${ERRNO_CODES.join('|')}))?|timeout|output-limit|call-failed|template-error|not-json|field-rule:[a-z]+)$`);
function assertCallRow(row, where, {runner = 'fake', model = 'ok'} = {}) {
  for (const k of Object.keys(row)) assert.ok(CALL_KEYS.includes(k), `${where}: 낯선 칸 ${k}`);
  assert.equal(row.kind, 'explain-call', where);
  assert.equal(row.by, EXPLAIN_BY, where);
  assert.ok(!Number.isNaN(Date.parse(row.at)) && new Date(row.at).toISOString() === row.at, `${where}: at`);
  assert.match(row.key, /^[\w.-]+\/[\w.-]+$/, where);
  assert.match(row.inputHash, /^[0-9a-f]{8,64}$/, where);
  assert.ok(Array.isArray(row.eventIds) && row.eventIds.every(id => typeof id === 'string' && /^[\w:.-]+$/.test(id)), `${where}: eventIds`);
  assert.ok(OUTCOMES.includes(row.outcome), `${where}: outcome ${row.outcome}`);
  if ('reason' in row) assert.match(row.reason, REASON_RE, `${where}: reason`);
  for (const a of row.attempts) {
    assert.equal(a.runner, runner, where);
    assert.equal(a.model, model, where);
  }
  assertLedgerSchema([row], where);
}

test('F1: write 실패의 오류 메시지 원문은 원장 reason에 남지 않고 고정 코드만 남는다(저장소 손상 주입)', async () => {
  const fake = `Unexpected token 'F', "FakeSecretAbcXyz789" is not valid JSON`;
  const original = BriefStore.prototype.write;
  const cases = [
    ['일반 오류', () => new Error(fake), 'write-failed'],
    ['시스템 코드', () => Object.assign(new Error(fake), {code: 'ENOSPC'}), 'write-failed:ENOSPC'],
    ['모양 밖 코드', () => Object.assign(new Error(fake), {code: 'FakeSecretAbcXyz789'}), 'write-failed'],
    ['정규식은 넘지만 목록에 없는 코드', () => Object.assign(new Error(fake), {code: 'EFAKESECRET'}), 'write-failed'],
    ['소문자 코드', () => Object.assign(new Error(fake), {code: 'enospc'}), 'write-failed'],
  ];
  try {
    for (const [name, make, expected] of cases) {
      const w = world({spawn: async () => ({status: 0, stdout: brief, stderr: ''})});
      const card = w.makeCard();
      await enable(w);
      BriefStore.prototype.write = function () { throw make(); };
      w.dispatch(card, 0);
      {const {done} = w.run(); await done;}
      BriefStore.prototype.write = original;
      const [row] = w.rows().filter(r => r.kind === 'explain-call');
      assert.equal(row.outcome, 'failed', name);
      assert.equal(row.reason, expected, name);
      assertCallRow(row, name);
      assert.ok(!fs.readFileSync(path.join(w.home, EXPLAIN_FILE), 'utf8').includes('FakeSecret'), name);
    }
  } finally { BriefStore.prototype.write = original; }
});

test('F1: 실제 설명 줄 손상(저장소 쪽 오류)도 고정 코드로만 남는다', async () => {
  let corrupt = () => {};
  const w = world({spawn: async () => { corrupt(); return {status: 0, stdout: brief, stderr: ''}; }});
  const card = w.makeCard();
  await enable(w);
  // AI가 답하는 사이 설명 줄이 손상된다(sourceHash 없음 → 저장 단계의 읽기가 실패).
  corrupt = () => appendStream(w.home, `cards/${card.key}/briefs.jsonl`, {key: card.key, note: 'FakeSecretAbcXyz789'});
  w.dispatch(card, 0);
  {const {done} = w.run(); await done;}
  const [row] = w.rows().filter(r => r.kind === 'explain-call');
  assert.equal(row.outcome, 'failed');
  assert.match(row.reason, new RegExp(`^write-failed(:(${ERRNO_CODES.join('|')}))?$`));
  assertCallRow(row, 'corrupt');
  assert.ok(!JSON.stringify(w.rows()).includes('FakeSecret'));
});

test('원장 줄 전체 문자열 허용 집합: 성공·형식 실패·호출 실패·시간 초과 줄의 모든 문자열 값이 허용 안에 있다', async () => {
  const bodies = [[brief, '', 0], ['plain FakeSecretAbcXyz789', '', 0], ['', 'FakeSecretAbcXyz789', 1], [JSON.stringify({response: '{"title":"FakeSecretAbcXyz789"}'}), '', 0]];
  for (const [stdout, stderr, status] of bodies) {
    const rows = (await ledgerFor(stdout, stderr, status)).filter(r => r.kind === 'explain-call');
    assert.equal(rows.length, 1);
    for (const row of rows) { assertCallRow(row, stdout.slice(0, 20)); assert.ok(!JSON.stringify(row).includes('FakeSecret')); }
  }
  // 허용 집합이 실제로 걸리는지 거꾸로 본다.
  const ok = {kind: 'explain-call', by: EXPLAIN_BY, at: new Date().toISOString(), key: 'r/c', inputHash: 'abcdef12', eventIds: ['e1'], outcome: 'failed', attempts: []};
  assertCallRow(ok, 'base');
  assert.throws(() => assertCallRow({...ok, reason: 'write:Unexpected token'}, 'x'));
  assert.throws(() => assertCallRow({...ok, reason: 'write-failed:FakeSecret'}, 'x'));
  assert.throws(() => assertCallRow({...ok, extra: 'x'}, 'x'));
  assert.throws(() => assertCallRow({...ok, outcome: 'boom'}, 'x'));
});

// ---- PR #208 8라운드: 원장 문자열은 '입력 값'이 아니라 '허용 목록의 리터럴'로만 기록한다 ----
test('8R F1: 예외 code 접근 함수·Proxy·던지는 접근 함수는 한 번만 읽고 목록 리터럴만 남긴다', async () => {
  const original = BriefStore.prototype.write;
  const reads = {n: 0};
  const accessor = () => {
    reads.n = 0;
    const error = new Error('FakeMessageNeverPersist');
    Object.defineProperty(error, 'code', {get() { return ++reads.n === 1 ? 'ENOSPC' : 'EORCHIDSECRET'; }});
    return error;
  };
  const throwing = () => {
    const error = new Error('FakeMessageNeverPersist');
    Object.defineProperty(error, 'code', {get() { throw new Error('FakeGetterSecret'); }});
    return error;
  };
  const throwingMessage = () => {
    const error = {};
    Object.defineProperty(error, 'message', {get() { throw new Error('FakeGetterSecret'); }});
    return error;
  };
  const proxied = () => new Proxy(new Error('x'), {get(target, key) {
    if (key === 'code') return 'ENOSPC';
    if (key === 'message') return 'FakeProxySecret';
    return Reflect.get(target, key);
  }});
  const proxyThrows = () => new Proxy({}, {get() { throw new Error('FakeProxySecret'); }});
  const cases = [
    ['첫 읽기 ENOSPC 다음 가짜', accessor, 'write-failed:ENOSPC'],
    ['읽을 때 던지는 code', throwing, 'write-failed'],
    ['읽을 때 던지는 message', throwingMessage, 'write-failed'],
    ['Proxy(code만 목록 안)', proxied, 'write-failed:ENOSPC'],
    ['모든 읽기가 던지는 Proxy', proxyThrows, 'write-failed'],
    ['숫자 code', () => Object.assign(new Error('x'), {code: 28}), 'write-failed'],
    ['Symbol code', () => Object.assign(new Error('x'), {code: Symbol('ENOSPC')}), 'write-failed'],
    ['객체 code(toString이 ENOSPC)', () => Object.assign(new Error('x'), {code: {toString: () => 'ENOSPC'}}), 'write-failed'],
    ['null을 던짐', () => null, 'write-failed'],
  ];
  try {
    for (const [name, make, expected] of cases) {
      const w = world({spawn: async () => ({status: 0, stdout: brief, stderr: ''})});
      const card = w.makeCard();
      await enable(w);
      BriefStore.prototype.write = function () { throw make(); };
      w.dispatch(card, 0);
      {const {done} = w.run(); await done;}
      BriefStore.prototype.write = original;
      const [row] = w.rows().filter(r => r.kind === 'explain-call');
      assert.equal(row.reason, expected, name);
      const text = fs.readFileSync(path.join(w.home, EXPLAIN_FILE), 'utf8');
      for (const bad of ['Fake', 'ORCHID']) assert.ok(!text.includes(bad), `${name}: ${bad}`);
    }
  } finally { BriefStore.prototype.write = original; }
  const probe = accessor();
  assert.equal(errnoOf(probe), 'ENOSPC');
  assert.equal(reads.n, 1, 'code는 한 번만 읽는다');
});

test('8R 출처: pick은 입력 값이 아니라 목록 쪽 리터럴을 돌려주고 문자열 아닌 값은 떨어뜨린다', () => {
  const live = ['ENOSPC'];
  const echo = pick(live, 'ENOSPC');
  assert.equal(echo, 'ENOSPC');
  assert.ok(live.some(item => Object.is(item, echo)));
  const sneaky = {toString: () => 'ENOSPC', valueOf: () => 'ENOSPC'};
  for (const v of [sneaky, 28, Symbol('ENOSPC'), ['ENOSPC'], null, undefined, new String('ENOSPC')]) assert.equal(pick(live, v), undefined, typeof v);
});

test('8R 출처: 신호·키 이름이 접근 함수 값이어도 목록 리터럴만 남는다', () => {
  let reads = 0;
  const flip = {toString() { return ++reads === 1 ? 'SIGTERM' : 'SIGFAKESECRET'; }};
  assert.equal('signal' in buildDiag({stdout: '', stderr: '', signal: flip}), false);
  const s = shapeOf({title: 'a', FakeKey: 'b', errors: [1, 2]});
  assert.deepEqual(s.keys.map(k => k.k), ['title', 'errors']);
  assert.equal(s.unknown, 1);
  assert.deepEqual(s.keys[1], {k: 'errors', t: 'array', n: 2});
});

test('8R 출처 시험: 원장에 기록된 시도 문자열은 허용 상수 배열 안의 같은 값이다', async () => {
  const outputs = [
    ['not json {', ''], [JSON.stringify({response: ''}), ''], [JSON.stringify({response: '{"title":1}'}), ''],
    [JSON.stringify({response: '{"title":"a","workstream":"b","stage":"zzz"}'}), 'quota exceeded'],
    [JSON.stringify({FakeKey: {errors: [1], code: 7, usage: {x: 1}}}), 'blocked'],
  ];
  const walk = node => {
    assert.ok(VALUE_KINDS.includes(node.t));
    if ('k' in node) assert.ok(KEY_NAMES.includes(node.k) || node.k === UNKNOWN_KEY);
    for (const c of node.keys ?? []) walk(c);
  };
  for (const [stdout, stderr] of outputs) {
    const attempts = (await ledgerFor(stdout, stderr)).flatMap(r => r.attempts ?? []);
    assert.ok(attempts.length > 0);
    for (const a of attempts) {
      assert.ok(ATTEMPT_RESULTS.includes(a.result), a.result);
      if (!a.diag) continue;
      if ('envelope' in a.diag) assert.ok(ENVELOPE_STATES.includes(a.diag.envelope));
      for (const id of a.diag.words) assert.ok(WORD_IDS.includes(id));
      if ('signal' in a.diag) assert.ok(SIGNAL_NAMES.includes(a.diag.signal));
      for (const k of ['shape', 'answerShape']) if (a.diag[k]) walk(a.diag[k]);
    }
  }
});
