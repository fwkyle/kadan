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
  const asked = decisions.request(card.key, {question: '합칠까요? 확인 경로 없음: 시험', options: ['합침', '보류'], recommendation: '합침', reason: '확인 경로 없음: 시험', work: '없음'}, 'kadan-슈퍼감독');
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

test('JSON이 아니거나 칸 규칙을 어기면 설명 줄을 쓰지 않고 사유만 남기며, 대체 후보로 내려가지 않는다', async () => {
  for (const [model, reason] of [['garbage', 'not-json'], ['rule', 'field-rule:stage']]) {
    const w = world({chain: [{runner: 'fake', model}, {runner: 'fake', model: 'ok'}]});
    const card = w.makeCard();
    await enable(w);
    w.dispatch(card, 0);
    {const {done} = w.run(); await done;}
    assert.equal(w.brief(card.key), null);
    assert.equal(w.calls().length, 1);
    assert.equal(w.rows().at(-1).reason, reason);
    w.clock.t += 60_000;
    {const {done} = w.run(); await done;}
    assert.equal(w.calls().length, 1, '같은 입력으로 다시 부르지 않는다');
    // 새 프로세스(감시 재시작)도 기록을 읽어 다시 부르지 않는다.
    const again = new ExplainAI({home: w.home, now: () => w.clock.t});
    again.tick({cards: w.store.listSummaries(), entries: taskIdentity(w.store.listSummaries()).project(w.raw), readEntries: () => w.raw});
    await again.drain();
    assert.equal(w.calls().length, 1);
  }
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
  assert.throws(() => setRole(home, {role: 'senior', runner: 'agy', model: 'flash', ...meta()}), /codex 실행기만/);
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
