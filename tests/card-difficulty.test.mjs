// 난이도 칸 PR 2: 카드의 difficulty 칸, 발령 기록(send)의 고정, 어긋남 경고, 자동 왕복 이어받기, 성과 보고서 난이도별.
// 모델 이름은 모두 가짜다. 설정·원장·카드는 격리 홈에만 쓴다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {CardStore} from '../src/card-store.mjs';
import {cardCommand} from '../src/card-command.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {workCommand} from '../src/work-command.mjs';
import {guardedSend} from '../src/cli-guarded-send.mjs';
import {launchFor, launchForHard} from '../src/runner-settings.mjs';
import {calculateCompareReport, compareReport, formatCompareReport} from '../src/compare-report.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {appendStream} from '../src/storage.mjs';
import {createWallServer} from '../src/wall.mjs';
import {choice} from './helpers/compare-fixture.mjs';

const rally = {rallyId: 'rally', rallyTitle: '묶음', rallyRound: '1', rallyStep: 'implementation'};
const newHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-card-difficulty-'));
const assign = (store, card, extra = {}) => store.update(card.key, {status: 'assigned', role: 'r', board: 'r',
  scope: '시험 범위', ...rally, ...extra}, {revision: card.revision, note: '배정'});

test('카드 칸: hard만 저장하고 normal로 고치면 칸이 지워지며, 옛 카드는 칸 없이 보통으로 읽는다', () => {
  const home = newHome(), store = new CardStore(home);
  const old = store.create({repo: 'r', id: 'old', repoPath: home, body: '# 옛 카드'});
  assert.equal('difficulty' in old, false);
  const card = store.create({repo: 'r', id: 'c1', repoPath: home, body: '# 새', difficulty: 'hard'});
  assert.equal(card.difficulty, 'hard');
  assert.equal(store.create({repo: 'r', id: 'c2', repoPath: home, body: '# 새', difficulty: 'normal'}).difficulty, undefined);
  const cleared = cardCommand(['update', card.key], {revision: card.revision, difficulty: 'normal', note: '보통으로 되돌림'}, {home, by: 'test'});
  assert.equal('difficulty' in cleared, false);
  const raised = cardCommand(['update', card.key], {revision: cleared.revision, difficulty: 'hard', note: '난이도 올림'}, {home, by: 'test'});
  assert.equal(raised.difficulty, 'hard');
  // 이력에 남고, 목록에도 보인다(없으면 보이지 않는다).
  assert.deepEqual(store.get(card.key).history.map(e => e.difficulty ?? null), ['hard', null, 'hard']);
  const list = cardCommand(['list'], {}, {home, by: 'test'});
  assert.equal(list.find(c => c.key === card.key).difficulty, 'hard');
  assert.equal('difficulty' in list.find(c => c.key === old.key), false);
  // CLI 쓰기 길: card create --difficulty hard
  fs.writeFileSync(path.join(home, 'body.md'), '# 본문\n');
  const viaCli = cardCommand(['create', 'r/c3'], {'repo-path': home, 'body-file': path.join(home, 'body.md'), difficulty: 'hard'}, {home, by: 'test'});
  assert.equal(viaCli.difficulty, 'hard');
});

test('카드 칸 거절: 모르는 값·조율 카드·검수 단계·닫힌 카드는 어느 순서로 만나도 거절한다', () => {
  const home = newHome(), store = new CardStore(home);
  const make = (id, extra = {}) => store.create({repo: 'r', id, repoPath: home, body: '# 카드', ...extra});
  assert.throws(() => make('bad', {difficulty: 'extreme'}), /normal 또는 hard/);
  assert.throws(() => make('co', {workType: 'coordination', difficulty: 'hard'}), /조율/);
  assert.equal(make('co2', {workType: 'coordination'}).difficulty, undefined);
  const coordination = store.get('r/co2');
  assert.throws(() => store.update(coordination.key, {difficulty: 'hard'}, {revision: coordination.revision, note: '시도'}), /조율/);
  // 이미 hard인 카드를 조율 카드로 바꾸는 쪽에서 만나도 거절.
  const hard = make('h1', {difficulty: 'hard'});
  assert.throws(() => store.update(hard.key, {workType: 'coordination'}, {revision: hard.revision, note: '시도'}), /조율/);
  // 검수 단계: 값 쪽에서도, 단계 쪽에서도 거절. 먼저 normal이면 단계를 바꿀 수 있다.
  const review = assign(store, make('rv'), {rallyStep: 'review'});
  assert.throws(() => store.update(review.key, {difficulty: 'hard'}, {revision: review.revision, note: '시도'}), /검수 단계/);
  const impl = assign(store, make('h2', {difficulty: 'hard'}));
  assert.throws(() => store.update(impl.key, {rallyStep: 'review'}, {revision: impl.revision, note: '시도'}), /검수 단계/);
  const normal = store.update(impl.key, {difficulty: 'normal'}, {revision: impl.revision, note: '보통으로'});
  assert.equal(store.update(normal.key, {rallyStep: 'review'}, {revision: normal.revision, note: '검수로'}).rallyStep, 'review');
  // 닫힌 카드의 난이도는 못 바꾼다.
  const closing = assign(store, make('h3', {difficulty: 'hard'}));
  const done = store.update(closing.key, {status: 'done'}, {revision: closing.revision, note: '끝'});
  assert.throws(() => store.update(done.key, {difficulty: 'normal'}, {revision: done.revision, note: '시도'}), /닫힌 카드/);
  assert.equal(store.get(done.key).difficulty, 'hard');
});

test('work execute --difficulty hard: 작업자 단계 실행만 받고, 검수 실행은 만들기 전에 거절한다', () => {
  const home = newHome(), by = 'test';
  const context = {home, by};
  const works = new WorkStore(home);
  works.create({key: 'r/w', title: '업무', goal: '목표', scope: '범위', acceptance: '조건', owner: 'boss', repoPath: home, board: 'r', by});
  const body = path.join(home, 'body.md');
  fs.writeFileSync(body, '# 지시\n');
  const run = (phase, extra = {}) => workCommand(['execute', 'r/w'], {revision: works.get('r/w').revision, phase, round: '1',
    title: `${phase} 실행`, 'body-file': body, note: '시험', ...extra}, context);
  const before = works.get('r/w').executions.length;
  assert.throws(() => run('review', {difficulty: 'hard'}), /검수 실행에는 난이도 hard/);
  assert.throws(() => run('implementation', {difficulty: 'extreme'}), /normal 또는 hard/);
  assert.equal(works.get('r/w').executions.length, before, '거절하면 실행을 만들지 않는다');
  const made = run('implementation', {difficulty: 'hard'});
  const key = made.executions.at(-1).key;
  assert.equal(new CardStore(home).get(key).difficulty, 'hard');
  const plain = run('fix', {});
  assert.equal(new CardStore(home).get(plain.executions.at(-1).key).difficulty, undefined);
});

// ---- 발령 기록(send) ----
const RUNNERS = {claude: {spawn: 'claude --model {model} --effort {effort} --dangerously-skip-permissions'}};
const WORKER = {runner: 'claude', model: 'claude-normal-x', effort: 'high'};
const HARD = {runner: 'claude', model: 'claude-hard-x', effort: 'max'};
const settingsDoc = roles => ({version: 1, revision: 3, activePreset: 'B', presets: {B: {roles}}, runners: RUNNERS});

function rig({hardSlot = true, cardDifficulty, session = 'normal', step = 'implementation'} = {}) {
  const home = newHome();
  const settings = settingsDoc({worker: WORKER, ...(hardSlot ? {'worker-hard': HARD} : {})});
  fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify(settings));
  const store = new CardStore(home);
  const created = store.create({repo: 'r', id: 'card-1', repoPath: home, body: '# 지시', ...(cardDifficulty ? {difficulty: cardDifficulty} : {})});
  const card = assign(store, created, {rallyStep: step});
  const cmd = session === 'hard' ? launchForHard(settings).cmd : launchFor(settings, 'worker').cmd;
  const entries = [{kind: 'start', role: 'r', session: 'kadan-r', panePid: '111', roleProfile: 'worker', cmd,
    ...(session === 'hard' ? {difficulty: 'hard'} : {})}];
  const records = [];
  const floor = {name: 'fake', alive: () => true, pid: () => '111', send: () => ({})};
  const send = () => {
    const lines = [], original = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    try {
      guardedSend({floor, session: 'kadan-r', role: 'r', message: '카드 지시', taskId: 'card-1', recordedPid: '111',
        env: {KADAN_HOME: home}, readEntries: () => entries, record: e => records.push(e), saveBody: () => {}});
    } finally { console.error = original; }
    return lines;
  };
  return {home, store, card, send, records, sent: () => records.find(e => e.kind === 'send')};
}
const warns = lines => lines.filter(line => /어려움 카드/.test(line));

test('발령 기록: 어려움 카드는 send에 difficulty hard를 고정하고, 어려운 일 세션이면 경고가 없다', () => {
  const r = rig({cardDifficulty: 'hard', session: 'hard'});
  assert.deepEqual(warns(r.send()), []);
  assert.equal(r.sent().difficulty, 'hard');
  assert.equal('difficultyMismatch' in r.sent(), false);
});

test('발령 기록: 어려움 카드 → 보통 세션은 자리가 채워져 있으면 경고 + difficultyMismatch + 발령 성공', () => {
  const r = rig({cardDifficulty: 'hard'});
  const lines = warns(r.send());
  assert.equal(lines.length, 1); assert.match(lines[0], /--difficulty hard/);
  assert.equal(r.sent().difficulty, 'hard'); assert.equal(r.sent().difficultyMismatch, true);
  assert.equal(r.sent().runnerChoice.model, 'claude-normal-x');
});

test('발령 기록: 어려운 일 자리가 비어 있으면 경고가 없고(difficulty는 기록), 보통 카드는 아무것도 적지 않는다', () => {
  const empty = rig({cardDifficulty: 'hard', hardSlot: false});
  assert.deepEqual(warns(empty.send()), []);
  assert.equal(empty.sent().difficulty, 'hard'); assert.equal('difficultyMismatch' in empty.sent(), false);
  // 보통 카드 → 보통 세션: 지금 모든 사용자와 같다(두 칸 모두 없다).
  const plain = rig({});
  assert.deepEqual(warns(plain.send()), []);
  assert.equal('difficulty' in plain.sent(), false); assert.equal('difficultyMismatch' in plain.sent(), false);
  // 보통 카드 → 어려운 일 세션: 조용히 통과.
  const reuse = rig({session: 'hard'});
  assert.deepEqual(warns(reuse.send()), []);
  assert.equal('difficulty' in reuse.sent(), false); assert.equal('difficultyMismatch' in reuse.sent(), false);
});

test('발령 기록: 발령 뒤 카드 난이도를 바꿔도 이미 남은 send 기록은 그대로다', () => {
  const r = rig({cardDifficulty: 'hard', session: 'hard'});
  r.send();
  const sent = structuredClone(r.sent());
  const current = r.store.get(r.card.key);
  r.store.update(r.card.key, {difficulty: 'normal'}, {revision: current.revision, note: '보통으로'});
  assert.deepEqual(r.sent(), sent);
  assert.equal(r.sent().difficulty, 'hard');
});

// ---- 자동 왕복 ----
test('자동 왕복: 수정 실행은 원본 작업 카드의 지금 난이도를 이어받고, 검수 실행에는 적지 않는다', async () => {
  const {AutomaticReview} = await import('../src/automatic-review.mjs');
  const home = newHome(), by = 'boss';
  const store = new CardStore(home), works = new WorkStore(home);
  works.create({key: 'r/w', title: '업무', goal: '목표', scope: '범위', acceptance: '조건', owner: by, repoPath: home, board: 'r', by});
  const origin = assign(store, store.create({repo: 'r', id: 'origin', repoPath: home, body: '# 원본'}), {role: 'x'});
  const originReview = assign(store, store.create({repo: 'r', id: 'origin-review', repoPath: home, body: '# 검수 원본'}), {role: 'x', rallyStep: 'review'});
  const auto = new AutomaticReview({home, by, floor: {name: 'fake'}, send: () => ({})});
  const state = phase => ({key: 'r/w', revision: 1, phase, round: phase === 'fix' ? 2 : 1,
    references: {implementation: {key: origin.key}, review: {key: originReview.key}}, identities: {worker: {}, reviewer: {}}});
  const prepared = (phase, s = state(phase)) => {
    auto.guard = () => works.get('r/w');
    auto.save = (_, patch) => patch;
    const patch = auto.prepare({...s, identities: {worker: {role: 'wk'}, reviewer: {role: 'rv'}}, references: s.references});
    return store.get(patch.current.key);
  };
  assert.equal(prepared('implementation').difficulty, undefined, '원본이 보통이면 칸이 없다');
  store.update(origin.key, {difficulty: 'hard'}, {revision: store.get(origin.key).revision, note: '난이도 올림'});
  assert.equal(prepared('fix').difficulty, 'hard', '원본 카드의 지금 값을 이어받는다');
  assert.equal(prepared('review').difficulty, undefined, '검수 실행에는 적지 않는다');
});

// ---- 성과 보고서 ----
const epoch = '2026-10-27T00:00:00.000Z';
const stamp = minutes => new Date(Date.parse(epoch) + minutes * 60000).toISOString();
function reportFixture() {
  const data = {entries: [], works: [], cards: []};
  const add = ({work = 'test/work', phase = 'implementation', round = 1, worker = 'gpt-one', reviewer = 'claude-one',
    difficulty, launchSource = 'settings', review = true, pass = true, role} = {}) => {
    const n = data.entries.length, key = `test/${phase.slice(0, 4)}-${n}`, reviewKey = `test/review-${n}`;
    let w = data.works.find(w => w.key === work);
    if (!w) { w = {key: work, status: 'open', executions: []}; data.works.push(w); }
    const workerRole = role ?? `test-worker-${n}`, reviewRole = `test-reviewer-${n}`;
    data.entries.push({kind: 'send', taskId: key.split('/')[1], executionKey: key, workKey: work, role: workerRole,
      settingsPreset: 'A', compareMode: false, pickId: null, launchSource, runnerChoice: choice(worker),
      ...(difficulty ? {difficulty} : {}), t: stamp(n * 30 + 1)});
    w.executions.push({key, phase, round});
    data.entries.push({kind: 'done', taskId: key.split('/')[1], executionKey: key, role: workerRole, result: 'ok', t: stamp(n * 30 + 11)});
    if (review) {
      w.executions.push({key: reviewKey, phase: 'review', round});
      data.entries.push({kind: 'send', taskId: reviewKey.split('/')[1], executionKey: reviewKey, workKey: work, role: reviewRole,
        reviewFor: {role: workerRole}, compareMode: false, pickId: null, settingsPreset: 'A', launchSource: 'review-for',
        runnerChoice: choice(reviewer, 'high'), t: stamp(n * 30 + 12)});
      data.entries.push({kind: 'done', taskId: reviewKey.split('/')[1], executionKey: reviewKey, role: reviewRole, result: 'ok', t: stamp(n * 30 + 20)});
      data.cards.push({key: reviewKey, result: {outcome: pass ? 'pass' : 'changes'}});
    }
    return {key, workerRole};
  };
  return {data, add};
}
const rowsOf = report => report.groups.flatMap(group => group.rows);

test('보고서: 같은 검수자·같은 조합도 보통 업무와 어려움 업무가 다른 행으로 세어지고 --json 행에 difficulty가 있다', () => {
  const f = reportFixture();
  f.add({work: 'test/easy'}); f.add({work: 'test/easy2'});
  f.add({work: 'test/hard', difficulty: 'hard'});
  const report = calculateCompareReport(f.data);
  const rows = rowsOf(report);
  assert.deepEqual(rows.map(r => [r.difficulty, r.independentSamples]).sort(), [['hard', 1], ['normal', 2]]);
  const text = formatCompareReport(report);
  assert.match(text, /난이도 보통/); assert.match(text, /난이도 어려움/);
  assert.ok(text.indexOf('난이도 보통') < text.indexOf('난이도 어려움'));
});

test('보고서: 어려움 표본이 없으면 텍스트 출력에 난이도 제목 줄이 없다(칸을 안 쓰는 사용자의 출력은 그대로)', () => {
  const f = reportFixture();
  f.add({work: 'test/easy'});
  const text = formatCompareReport(calculateCompareReport(f.data));
  assert.doesNotMatch(text, /난이도/);
  assert.equal(rowsOf(calculateCompareReport(f.data))[0].difficulty, 'normal');
});

test('보고서: 보통으로 시작해 어려움으로 올린 업무는 난이도 올림으로 지표에서 빠지고, 어려움으로 시작한 업무의 보통 수정은 표본으로 남는다', () => {
  const f = reportFixture();
  // 올림 + 조합 변경: 사유 두 개가 함께 붙고 첫 구현 발령의 행(보통)에 센다.
  f.add({work: 'test/raised', role: 'w-raised', pass: false});
  f.add({work: 'test/raised', phase: 'fix', round: 2, worker: 'gpt-two', role: 'w-raised2', difficulty: 'hard', review: false});
  // 올림만(같은 조합)
  f.add({work: 'test/raised-same', role: 'w-same', pass: false});
  f.add({work: 'test/raised-same', phase: 'fix', round: 2, role: 'w-same', difficulty: 'hard', review: false});
  // 어려움으로 시작 + 보통 수정(같은 조합): 섞임이 아니다.
  f.add({work: 'test/hard-start', role: 'w-hs', difficulty: 'hard', pass: false});
  f.add({work: 'test/hard-start', phase: 'fix', round: 2, role: 'w-hs', review: false});
  const report = calculateCompareReport(f.data);
  assert.deepEqual(report.mixed, {'난이도 올림': 2, '작업자 변경': 1});
  const normal = rowsOf(report).find(r => r.difficulty === 'normal');
  assert.deepEqual(normal.mixed, {'난이도 올림': 2, '작업자 변경': 1});
  assert.deepEqual(normal.mixedWorkIds.sort(), ['test/raised', 'test/raised-same']);
  assert.equal(normal.independentSamples, 0);
  const hard = rowsOf(report).find(r => r.difficulty === 'hard');
  assert.deepEqual(hard.workIds, ['test/hard-start']); assert.deepEqual(hard.mixed, {});
});

test('보고서: --cmd로 띄운 작업자의 어려움 카드는 어려움 쪽 [명시 명령] 행으로, 옛 발령(칸 없음)은 보통으로 센다', () => {
  const f = reportFixture();
  f.add({work: 'test/cmd-hard', difficulty: 'hard', launchSource: 'override', worker: 'gpt-cmd'});
  f.add({work: 'test/old'});
  const rows = rowsOf(calculateCompareReport(f.data));
  assert.deepEqual(rows.map(r => [r.difficulty, r.launch]).sort(), [['hard', '명시 명령'], ['normal', null]]);
});

test('보고서: 카드의 난이도를 나중에 바꿔도 발령에 고정된 값으로 센다', () => {
  const f = reportFixture();
  f.add({work: 'test/fixed', difficulty: 'hard'});
  // 카드 쪽 값은 보고서가 읽지 않는다(읽는 범위를 넓히지 않는다).
  for (const card of f.data.cards) card.difficulty = 'normal';
  f.data.cards.push({key: 'test/impl-0', difficulty: undefined});
  assert.equal(rowsOf(calculateCompareReport(f.data))[0].difficulty, 'hard');
});

test('대시보드 결과 보기: 어려움 행이 있는 보고서가 같은 JSON으로 내려가고 두 행이 구분된다', async () => {
  const f = reportFixture();
  f.add({work: 'test/easy', role: 'w1'});
  f.add({work: 'test/hard', role: 'w2', difficulty: 'hard'});
  const home = newHome();
  fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify({version: 1, revision: 1, activePreset: 'A',
    runners: {codex: {spawn: 'codex --model {model} --effort {effort}', models: [{model: 'gpt-one', efforts: ['medium']}]}},
    presets: {A: {roles: {worker: choice('gpt-one')}}}}));
  for (const entry of f.data.entries) appendLedger(entry, home);
  for (const work of f.data.works) appendStream(home, `works/${work.key}/events.jsonl`, work);
  for (const card of f.data.cards) appendStream(home, `cards/${card.key}/events.jsonl`, card);
  const server = createWallServer(() => ({center: null, entries: readLedger(home), tree: [], ledgerLines: 0, collectedAt: new Date()}),
    {home, cacheSec: 0});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  try {
    const url = `${base}/runners/compare-report?since=${epoch}`;
    const served = await (await fetch(url)).json();
    const rows = rowsOf(served);
    assert.deepEqual(rows.map(r => r.difficulty).sort(), ['hard', 'normal']);
    assert.equal(new Set(rows.map(r => `${r.worker.model}|${r.launch}|${r.difficulty}`)).size, rows.length, '행 구분 값이 겹치지 않는다');
    const stripTime = ({asOf, ...rest}) => rest;
    assert.deepEqual(stripTime(served), stripTime(compareReport(home, {since: epoch})));
    assert.equal((await fetch(base)).status, 200);
  } finally {
    await new Promise(r => server.close(r));
    const listeners = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {encoding: 'utf8'});
    assert.equal(listeners.stdout.trim(), '');
    console.log(`검증 서버 종료: PID ${process.pid}, 127.0.0.1:${port}, lsof LISTEN 없음`);
  }
});
