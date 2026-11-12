// 업무 흐름 요약의 색인 2곳(K1)과 결정 기록을 바뀌었을 때만 읽는 판독기(K5)가 결과를 바꾸지 않는지 확인한다.
// K1의 기준(오라클)은 바꾸기 전 구현(dd40c9f의 followupFor·executionModel)의 식을 그대로 옮긴 것이다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDatabase, writeStorageMarker, readStream, appendStream, storageSnapshot, storagePath,
} from '../src/storage.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {CardStore} from '../src/card-store.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {taskIdentity} from '../src/task-identity.mjs';
import {
  operationsFlowSummaries, operationsFlowDetail, operationsFlowIndex, watchCallCounts, ambiguousTaskIds,
} from '../src/operations-flow.mjs';
import {DecisionStore} from '../src/decisions.mjs';
import {
  createDashboardDecisionsReader, dashboardDecisionRows, dashboardDecisionsInfo,
} from '../src/dashboard-decisions.mjs';
import {readHumanBriefInputs} from '../src/human-brief.mjs';
import {decisionsByCard} from '../src/explain-input.mjs';
import {loadWallSnapshot} from '../src/commands/tree-wall.mjs';
import {DERIVED_MAX_AGE_MS} from '../src/wall-snapshot-cache.mjs';

// ── 바꾸기 전 식(오라클). src/operations-flow.mjs(dd40c9f) :156과 :248을 글자 그대로 옮겼다.
const oracleLinkedWatchCalls = (context, identity, keys) =>
  context.watchCalls
    ? context.watchCalls.filter(e => e.taskId && keys.has(identity.resolve(e.taskId, e.executionKey).key)).length
    : null;
const oracleAmbiguous = (records, identity, card) =>
  records?.events.some(e => identity.resolve(e.taskId, e.executionKey).state === 'ambiguous' && e.taskId === card.id)
    ?? false;
// ── 바꾼 뒤 식(목록 경로가 쓰는 조회). 색인은 src의 내보낸 함수로 만든다.
const indexedLinkedWatchCalls = (counts, keys) => [...keys].reduce((n, key) => n + (counts.get(key) ?? 0), 0);

const card = (key, id = key.split('/')[1]) => ({key, id});
// 같은 ID가 두 저장소에 있는 모호한 카드, 한글 이름, 흔한 카드.
const CARDS = [card('앞/X-1'), card('뒤/X-1'), card('앞/Y-2'), card('가나/한글-3'), card('앞/Z-4')];
const unresolved = (identity, e) => e.taskId && identity.resolve(e.taskId, e.executionKey).key === undefined;

test('K1 감시 호출 수: 색인으로 센 값이 업무마다 전체를 거르던 식과 같다(만든 경우)', () => {
  const identity = taskIdentity(CARDS);
  const call = extra => ({kind: 'watch-ai-call', ...extra});
  const watchCalls = [
    call({taskId: 'Y-2'}),                              // 주소 없이 ID만 → 앞/Y-2
    call({taskId: 'Y-2', executionKey: '앞/Y-2'}),      // 주소 있음
    call({taskId: 'X-1'}),                              // 모호한 ID를 주소 없이 → 못 풂
    call({taskId: 'X-1', executionKey: '뒤/X-1'}),      // 모호한 ID지만 주소로 풂
    call({taskId: '없는-9'}),                           // 등록 안 된 ID → 못 풂
    call({taskId: 'Y-2', executionKey: '없는/주소'}),   // 없는 주소 → 못 풂
    call({taskId: 'Y-2', executionKey: '앞/Z-4'}),      // ID와 주소가 다른 카드(충돌) → 못 풂
    call({executionKey: '앞/Z-4'}),                     // 작업 ID 없음 → 세지 않음
    call({taskId: '한글-3'}),                           // 한글 이름
    call({taskId: '한글-3'}),
  ];
  const counts = watchCallCounts(watchCalls, identity);
  const keySets = [
    ['앞/Y-2'], ['뒤/X-1'], ['앞/X-1'], ['가나/한글-3'], ['앞/Z-4'],
    ['앞/Y-2', '뒤/X-1', '가나/한글-3'], ['앞/X-1', '앞/Z-4'], [],
  ];
  const expected = [2, 1, 0, 2, 0, 5, 0, 0];
  keySets.forEach((list, i) => {
    const keys = new Set(list);
    const indexed = indexedLinkedWatchCalls(counts, keys);
    assert.equal(indexed, oracleLinkedWatchCalls({watchCalls}, identity, keys), `묶음 ${i}`);
    assert.equal(indexed, expected[i], `묶음 ${i} 기대값`);
  });
  // 빈 증명이 아닌지: 못 푼 호출이 실제로 있고, 0이 아닌 수와 0인 업무가 모두 있다.
  assert.ok(watchCalls.some(e => unresolved(identity, e)));
  assert.ok(expected.some(n => n > 0) && expected.some(n => n === 0));
  assert.ok(!counts.has(undefined), '못 푼 호출은 표에 넣지 않는다');
  // 감시 호출이 0건이면 모든 업무가 0이다.
  const one = new Set(['앞/Y-2']);
  assert.equal(indexedLinkedWatchCalls(watchCallCounts([], identity), one), 0);
  assert.equal(oracleLinkedWatchCalls({watchCalls: []}, identity, one), 0);
  // 감시 호출을 못 읽은 문맥(watchCalls 없음)은 기준 식이 null이다.
  // 그 갈래는 색인을 만들지 않고 예전 식 그대로 간다(아래 실제 저장소 시험의 상세 경로).
  assert.equal(oracleLinkedWatchCalls({watchCalls: null}, identity, one), null);
});

test('K1 모호한 ID 판정: 업무마다 한 번 모은 집합이 실행마다 훑던 식과 같다(만든 경우)', () => {
  const identity = taskIdentity(CARDS);
  const cases = [
    {name: '모호한 ID를 주소 없이 쓴 send·done',
      events: [{kind: 'send', taskId: 'X-1'}, {kind: 'done', taskId: 'X-1'}],
      expected: {'앞/X-1': true, '뒤/X-1': true, '앞/Y-2': false}},
    {name: '모호한 ID지만 주소가 있음',
      events: [{kind: 'send', taskId: 'X-1', executionKey: '앞/X-1'}],
      expected: {'앞/X-1': false, '뒤/X-1': false}},
    {name: '주소 있는 사건과 없는 사건이 섞임',
      events: [{kind: 'send', taskId: 'X-1', executionKey: '앞/X-1'}, {kind: 'done', taskId: 'X-1'},
        {kind: 'send', taskId: 'Y-2'}],
      expected: {'앞/X-1': true, '앞/Y-2': false}},
    {name: '모호하지 않은 사건만',
      events: [{kind: 'send', taskId: 'Y-2'}, {kind: 'done', taskId: '한글-3'}, {kind: 'send', taskId: '없는-9'}],
      expected: {'앞/Y-2': false, '가나/한글-3': false, '앞/X-1': false}},
    {name: '사건 없음', events: [], expected: {'앞/X-1': false}},
    {name: '작업 ID 없이 주소만', events: [{kind: 'send', executionKey: '앞/X-1'}], expected: {'앞/X-1': false}},
  ];
  let sawTrue = false;
  for (const c of cases) {
    const ids = ambiguousTaskIds(c.events, identity);
    for (const [key, want] of Object.entries(c.expected)) {
      const target = CARDS.find(x => x.key === key);
      assert.equal(ids.has(target.id), oracleAmbiguous({events: c.events}, identity, target), `${c.name} · ${key}`);
      assert.equal(ids.has(target.id), want, `${c.name} · ${key} 기대값`);
      sawTrue ||= want;
    }
  }
  assert.ok(sawTrue, '모호 판정이 참인 경우가 하나는 있어야 한다');
  // 연결 사건을 못 읽은 업무(records 없음)는 기준 식이 false다. 그 갈래는 집합을 만들지 않는다.
  assert.equal(oracleAmbiguous(null, identity, CARDS[0]), false);
});

// 씨앗 고정 난수(mulberry32). 같은 씨앗이면 늘 같은 자료다.
function rng(seed) {
  return () => {
    seed |= 0;seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
test('K1 무작위 대조: 카드·사건·실행 묶음을 바꿔 가며 두 식이 늘 같다(씨앗 3개 × 60단계)', () => {
  let trueSeen = 0, linkedSeen = 0, unresolvedSeen = 0;
  for (const seed of [11, 2026, 77123]) {
    const rand = rng(seed), pick = list => list[Math.floor(rand() * list.length)];
    const repos = ['앞', '뒤', '가나'], idPool = ['X-1', 'Y-2', '한글-3', 'Z-4', 'W-5', 'Q-6'];
    for (let step = 0; step < 60; step++) {
      // 카드: 같은 ID가 여러 저장소에 걸리도록 작은 ID 묶음에서 뽑는다(주소는 겹치지 않게).
      const seen = new Set(), cards = [];
      for (let i = 0; i < 2 + Math.floor(rand() * 7); i++) {
        const key = `${pick(repos)}/${pick(idPool)}`;
        if (!seen.has(key)) {seen.add(key);cards.push(card(key));}
      }
      const identity = taskIdentity(cards);
      const event = kind => {
        const e = {kind};
        if (rand() < 0.85) e.taskId = rand() < 0.9 ? pick(idPool) : '없는-9';
        if (rand() < 0.35) e.executionKey = rand() < 0.85 ? pick(cards).key : '없는/주소';
        return e;
      };
      const watchCalls = Array.from({length: Math.floor(rand() * 12)}, () => event('watch-ai-call'));
      const events = Array.from({length: Math.floor(rand() * 10)}, () => event(rand() < 0.5 ? 'send' : 'done'));
      const keys = new Set(cards.filter(() => rand() < 0.5).map(c => c.key));
      const counts = watchCallCounts(watchCalls, identity), ids = ambiguousTaskIds(events, identity);
      const linked = oracleLinkedWatchCalls({watchCalls}, identity, keys);
      assert.equal(indexedLinkedWatchCalls(counts, keys), linked, `씨앗 ${seed} 단계 ${step} 감시 호출 수`);
      for (const c of cards) {
        const want = oracleAmbiguous({events}, identity, c);
        assert.equal(ids.has(c.id), want, `씨앗 ${seed} 단계 ${step} ${c.key} 모호 판정`);
        if (want) trueSeen++;
      }
      if (linked > 0) linkedSeen++;
      if (watchCalls.some(e => unresolved(identity, e))) unresolvedSeen++;
    }
  }
  // 빈 증명이 아닌지: 참인 모호 판정, 0이 아닌 감시 호출 수, 못 푼 감시 호출이 모두 여러 번 나왔다.
  assert.ok(trueSeen > 20 && linkedSeen > 20 && unresolvedSeen > 20,
    `참 ${trueSeen} · 연결 ${linkedSeen} · 못 풂 ${unresolvedSeen}`);
});

// ── 실제 저장소를 거친 대조: 목록(색인 경로)과 상세(색인 없는 예전 식 경로)가 같은 후속 판정을 낸다.
function flowHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-flow-index-'));
  createDatabase(home);writeStorageMarker(home, 'sqlite');
  const works = new WorkStore(home), cards = new CardStore(home);
  let clock = 0;
  const record = value =>
    appendLedger({t: new Date(Date.UTC(2026, 10, 12, 1, 0, clock++)).toISOString(), ...value}, home);
  const make = (key, title, executions) => {
    works.create({key, title, goal: '색인 대조', scope: '격리 시험', acceptance: '목록과 상세가 같다',
      owner: '감독', repoPath: home});
    for (const [i, name] of executions.entries()) {
      works.change(key, 'execute',
        {title: name, body: '격리 시험 지시', phase: i ? 'review' : 'implementation', round: i + 1},
        {revision: works.get(key).revision, by: '감독', note: '격리 시험'});
    }
    const keys = works.get(key).executions.map(x => x.key);
    for (const k of keys) {
      cards.update(k, {role: '작업자', status: 'assigned', board: '시험판', scope: '격리 시험 데이터만',
        rallyId: 'r1', rallyTitle: '묶음', rallyRound: '1', rallyStep: 'implementation'},
      {revision: 1, by: '감독', note: '격리 시험 배정'});
    }
    return keys;
  };
  return {home, works, cards, record, make};
}
const idOf = key => key.split('/')[1];
// 진행 중 업무의 경과 시간은 부른 시각에 달려 있어 비교에서 뺀다. 나머지는 값·순서까지 비교한다.
const comparable = v => JSON.parse(JSON.stringify(
  {followup: v.followup, decisions: v.decisions, automatic: v.automatic, timing: {...v.timing, elapsedMs: null}}));

test('K1 실제 저장소: 목록의 요약이 상세(예전 식)와 같고, 모호한 실행·감시 호출 수가 실제로 걸린다', () => {
  const f = flowHome();
  const [a1, a2] = f.make('앞/여러실행', '실행 둘 · 사건 섞임', ['첫 실행', '둘째 실행']);
  f.make('앞/감시없음', '감시 호출 0건', ['혼자']);
  const [c1] = f.make('가나/한글업무', '한글 이름 업무', ['한글 실행']);
  // 한 업무의 두 실행에 사건이 섞인다: 주소 있는 발령, 주소 없이 ID만 쓴 발령·완료.
  f.record({kind: 'send', role: '작업자', taskId: idOf(a1), by: '감독', executionKey: a1, workKey: '앞/여러실행'});
  f.record({kind: 'send', role: '작업자', taskId: idOf(a2), by: '감독'});
  f.record({kind: 'done', role: '작업자', taskId: idOf(a1), result: 'ok'});
  f.record({kind: 'done', role: '작업자', taskId: idOf(a2), result: 'ok'});
  f.record({kind: 'send', role: '작업자', taskId: idOf(c1), by: '감독'});
  // 감시 호출: 주소 없이 ID만(a1 둘, c1 하나), 주소 있음(a2), 작업 ID 없음, 등록 안 된 ID.
  const calls = [{taskId: idOf(a1)}, {taskId: idOf(a1)}, {taskId: idOf(a2), executionKey: a2}, {taskId: idOf(c1)},
    {}, {taskId: '없는-9'}];
  for (const extra of calls) f.record({kind: 'watch-ai-call', role: '작업자', session: 'kadan-작업자', ...extra});
  const compare = label => {
    const works = f.works.list(), summaries = operationsFlowSummaries(f.home, works);
    assert.equal(summaries.size, works.length);
    const details = new Map(works.map(w => [w.key, operationsFlowDetail(f.home, w.key)]));
    for (const w of works) {
      assert.deepEqual(comparable(summaries.get(w.key)), comparable(details.get(w.key)), `${label} · ${w.key}`);
    }
    const index = new Map(operationsFlowIndex(f.home).works.map(w => [w.key, w.followup]));
    for (const w of works) {
      for (const name of ['state', 'label', 'owner', 'next', 'at']) {
        assert.deepEqual(index.get(w.key)[name], details.get(w.key).followup[name] ?? null,
          `${label} · ${w.key} · ${name}`);
      }
    }
    return {summaries, details};
  };
  const before = compare('모호해지기 전');
  assert.equal(before.summaries.get('앞/여러실행').timing.linkedWatchCalls, 3);
  assert.equal(before.summaries.get('앞/감시없음').timing.linkedWatchCalls, 0);
  assert.equal(before.summaries.get('가나/한글업무').timing.linkedWatchCalls, 1);
  assert.ok(before.details.get('앞/여러실행').executions.every(x => x.ambiguous === false));
  // 같은 카드 ID를 다른 저장소에 만든다 → 주소 없이 그 ID를 쓴 사건·감시 호출이 모호해진다.
  f.cards.create({repo: '뒤', id: idOf(a2), repoPath: f.home, body: '# 같은 ID, 다른 저장소'});
  f.cards.create({repo: '뒤', id: idOf(a1), repoPath: f.home, body: '# 같은 ID, 다른 저장소'});
  const after = compare('모호해진 뒤');
  const executions = after.details.get('앞/여러실행').executions;
  assert.ok(executions.some(x => x.ambiguous === true), '상세가 모호한 실행을 실제로 표시한다(빈 증명이 아니다)');
  assert.equal(after.summaries.get('앞/여러실행').timing.linkedWatchCalls, 1,
    '주소 없이 쓴 두 건은 모호해져 빠지고 주소 있는 한 건만 남는다');
  assert.notDeepEqual(comparable(after.summaries.get('앞/여러실행')),
    comparable(before.summaries.get('앞/여러실행')), '모호해지면 요약이 실제로 달라진다');
});

// ── K5: 결정 기록을 바뀌었을 때만 읽는다.
const STREAM = 'decisions/events.jsonl';
const input = {question: '서비스를 제품과 분리할까요?', options: ['분리', '유지'], recommendation: '분리',
  reason: '기존 결정으로 해결할 수 없는 표시 정책\n- 결과 파일: /repo/card-a/result.md'};
const BY = 'p-슈퍼감독';
function decisionHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-decision-reader-'));
  const cards = new CardStore(home);
  cards.create({repo: 'repo', id: 'card-a', repoPath: home, body: '# 테스트'});
  cards.create({repo: 'repo', id: '한글-카드', repoPath: home, body: '# 테스트'});
  const store = new DecisionStore(home, {notify: () => {}});
  return {home, cards, store};
}
const plain = v => JSON.parse(JSON.stringify(v));
// 대시보드(수집·응답)가 쓰는 읽기. 결정을 쓰는 길은 인자 없는 list()·get()을 쓴다.
const dashboardDecisionList = home => new DecisionStore(home).list({dashboard: true});
// 바꾸기 전 읽기(오라클): DecisionStore.list()와 설명 입력의 decisionsByCard(readStream(...)).
const oracleList = home => new DecisionStore(home).list();
const oracleByCard = home => decisionsByCard(readStream(home, STREAM, {optional: true}));
const briefDecisions = home => readHumanBriefInputs(home, ['repo/card-a']).decisions;

test('K5 변경 없는 두 번째 읽기는 결정 줄을 0줄 읽고, 요청·답변·취소는 바로 다음 읽기에 보인다', () => {
  const f = decisionHome();
  const reader = createDashboardDecisionsReader(f.home, {now: () => 1_000_000});
  assert.deepEqual(reader.read(), []);
  assert.deepEqual(reader.info(), {rows: 0, full: 1, cached: 0});
  const a = f.store.request('repo/card-a', input, BY);
  const b = f.store.request('repo/한글-카드', {...input, question: '한글 카드의 질문'}, BY);
  const first = reader.read();
  assert.deepEqual(plain(first), readStream(f.home, STREAM));
  assert.deepEqual(reader.info(), {rows: 2, full: 2, cached: 2});
  // 변경 없음: 같은 배열, 읽은 줄 0.
  for (let i = 0; i < 3; i++) assert.equal(reader.read(), first);
  assert.deepEqual(reader.info(), {rows: 2, full: 2, cached: 2});
  // 다른 흐름에만 사건이 옴(원장·카드): 결정 줄 0.
  appendLedger({kind: 'alert', alertKind: 'probe', level: 'info', by: 'probe', role: '작업자', message: '다른 흐름'}, f.home);
  f.cards.update('repo/card-a', {}, {revision: 1, by: '작업자', noteKind: 'progress', note: '다른 흐름'});
  assert.equal(reader.read(), first);
  assert.deepEqual(reader.info(), {rows: 2, full: 2, cached: 2});
  // 답변(줄 2개: 답변 + 전달 결과) → 바로 반영.
  f.store.answer(a.id, {revision: 1, text: '분리하세요', choice: '분리'}, '사람');
  const answered = reader.read();
  assert.notEqual(answered, first);
  assert.deepEqual(plain(answered), readStream(f.home, STREAM));
  assert.equal(answered.length, 4);
  // 취소 → 바로 반영.
  f.store.cancel(b.id, {revision: 1, reason: '시험 취소'}, BY);
  assert.deepEqual(plain(reader.read()), readStream(f.home, STREAM));
  assert.deepEqual(reader.info(), {rows: 2 + 4 + 5, full: 4, cached: 5});
  assert.equal(reader.read(), reader.read());
});

test('K5 결과 동일: 대시보드 목록과 설명 입력의 결정이 늘 DB를 읽는 기준과 값·순서까지 같다', () => {
  const f = decisionHome();
  const check = label => {
    assert.deepEqual(plain(dashboardDecisionList(f.home)), plain(oracleList(f.home)), `${label} 목록`);
    assert.deepEqual(plain([...briefDecisions(f.home)]), plain([...oracleByCard(f.home)]), `${label} 설명 입력`);
  };
  check('비어 있음');
  const made = [];
  const rand = rng(390);
  for (let step = 0; step < 24; step++) {
    const open = made.map(id => f.store.get(id)).filter(d => d.status === 'open');
    const roll = rand(), target = open[Math.floor(rand() * open.length)];
    if (!open.length || roll < 0.45) {
      const key = rand() < 0.5 ? 'repo/card-a' : 'repo/한글-카드';
      made.push(f.store.request(key, {...input, question: `질문 ${step}`}, BY).id);
    } else if (roll < 0.75) {
      f.store.answer(target.id, {revision: target.revision, choice: rand() < 0.5 ? '분리' : '유지'}, '사람');
    } else {
      f.store.cancel(target.id, {revision: target.revision, reason: `취소 ${step}`}, '사람');
    }
    check(`단계 ${step}`);
    // 바뀌지 않았으면 같은 배열을 돌려준다(이 목록을 키로 쓰는 다른 기억이 빗나가지 않는다).
    assert.equal(dashboardDecisionList(f.home), dashboardDecisionList(f.home));
  }
  const states = new Set(oracleList(f.home).map(d => d.status));
  assert.deepEqual([...states].sort(), ['answered', 'cancelled', 'open'], '세 상태가 모두 나왔다');
});

test('K5 기억한 목록은 얼려 있어 호출부가 고쳐 쓰면 바로 드러난다', () => {
  const f = decisionHome();
  f.store.request('repo/card-a', input, BY);
  const list = dashboardDecisionList(f.home), rows = dashboardDecisionRows(f.home);
  assert.throws(() => { list.push({}); }, TypeError);
  assert.throws(() => { list[0].status = 'answered'; }, TypeError);
  assert.throws(() => { list[0].options.push('셋째'); }, TypeError);
  assert.throws(() => { rows.push({}); }, TypeError);
  // 늘 DB를 읽는 목록은 지금처럼 새 객체다.
  const fresh = oracleList(f.home);fresh[0].status = '고침';
  assert.equal(oracleList(f.home)[0].status, 'open');
});

test('K5 10분 안전망: 머리 줄이 같아도 10분이 지나면 전체를 다시 읽는다(가짜 시계)', () => {
  const f = decisionHome();
  let clock = 5_000_000;
  const reader = createDashboardDecisionsReader(f.home, {now: () => clock});
  f.store.request('repo/card-a', input, BY);
  const first = reader.read();
  clock += DERIVED_MAX_AGE_MS - 1;
  assert.equal(reader.read(), first);
  assert.equal(reader.info().full, 1);
  clock += 1;
  const again = reader.read();
  assert.notEqual(again, first);
  assert.deepEqual(plain(again), plain(first));
  assert.deepEqual(reader.info(), {rows: 2, full: 2, cached: 1});
  // 다시 읽은 뒤에는 새 10분이 시작된다.
  clock += DERIVED_MAX_AGE_MS - 1;
  assert.equal(reader.read(), again);
});

test('K5 결정을 쓰는 길은 판독기를 거치지 않고 늘 DB의 최신 revision으로 확인한다', () => {
  const f = decisionHome();
  const a = f.store.request('repo/card-a', input, BY);
  const find = id => dashboardDecisionList(f.home).find(d => d.id === id);
  // 대시보드가 먼저 읽어 기억해 둔다.
  assert.equal(find(a.id).revision, 1);
  const info0 = dashboardDecisionsInfo();
  // 다른 저장 객체(다른 프로세스 흉내)가 답한다: revision 1 → 2(답변) → 3(전달 결과).
  const other = new DecisionStore(f.home, {notify: () => {}});
  other.answer(a.id, {revision: 1, text: '분리하세요', choice: '분리'}, '사람');
  assert.equal(other.get(a.id).revision, 3);
  // 쓰는 길(get·list·answer)은 판독기를 부르지 않았다: 판독기가 읽은 줄 수가 그대로다.
  assert.deepEqual(dashboardDecisionsInfo(), info0);
  // 처음의 저장 객체로 낡은 revision을 주면 거절되고, 최신 상태를 본다(기억한 revision 1로 쓰지 않는다).
  assert.equal(f.store.get(a.id).revision, 3);
  assert.throws(() => f.store.answer(a.id, {revision: 1, text: '다른 답'}, '사람'), /요청 상태\/버전 변경/);
  assert.throws(() => f.store.cancel(a.id, {revision: 1, reason: '낡은 취소'}, '사람'), /요청 상태\/버전 변경/);
  const b = f.store.request('repo/card-a', {...input, question: '둘째 질문'}, BY);
  assert.equal(find(b.id).status, 'open');
  f.store.cancel(b.id, {revision: 1, reason: '바로 취소'}, BY);
  assert.throws(() => f.store.cancel(b.id, {revision: 1, reason: '두 번째 취소'}, BY), /요청 상태\/버전 변경/);
  // 대시보드 목록도 바로 따라온다.
  assert.deepEqual(plain(dashboardDecisionList(f.home)), plain(oracleList(f.home)));
  assert.equal(find(a.id).revision, 3);
  assert.equal(find(b.id).status, 'cancelled');
});

test('K5 손상된 결정 이력은 지금처럼 목록은 오류, 설명 입력은 줄 그대로 묶는다', () => {
  const f = decisionHome();
  f.store.request('repo/card-a', input, BY);
  assert.equal(dashboardDecisionList(f.home).length, 1);
  appendStream(f.home, STREAM, 'bad');
  assert.throws(() => oracleList(f.home), {message: '결정 이력 손상'});
  assert.throws(() => dashboardDecisionList(f.home), {message: '결정 이력 손상'});
  assert.throws(() => dashboardDecisionList(f.home), {message: '결정 이력 손상'});
  assert.deepEqual(plain([...briefDecisions(f.home)]), plain([...oracleByCard(f.home)]));
});

test('K5 읽기 실패 뒤에는 기억을 버리고, 복원한 뒤 첫 읽기는 전체를 다시 읽는다', () => {
  const f = decisionHome();
  f.store.request('repo/card-a', input, BY);
  const reader = createDashboardDecisionsReader(f.home, {now: () => 9_000_000});
  const first = reader.read();
  assert.equal(reader.info().cached, 1);
  // 저장소 설정이 잘못된 JSON이면 기준 읽기도 같은 오류를 낸다.
  const marker = path.join(f.home, 'storage.json'), saved = fs.readFileSync(marker, 'utf8');
  fs.writeFileSync(marker, '{잘못된 JSON');
  let expected;
  try { readStream(f.home, STREAM, {optional: true}); } catch (error) { expected = error; }
  assert.ok(expected instanceof SyntaxError);
  assert.throws(() => reader.read(), {name: expected.name, message: expected.message});
  assert.equal(reader.info().cached, 0, '기억을 버렸다');
  // 설명 입력은 지금처럼 빈 Map으로 받는다.
  assert.equal(briefDecisions(f.home).size, 0);
  fs.writeFileSync(marker, saved);
  const full0 = reader.info().full;
  const again = reader.read();
  assert.equal(reader.info().full, full0 + 1, '복원 뒤 첫 읽기는 전체 읽기');
  assert.notEqual(again, first);
  assert.deepEqual(plain(again), plain(first));
});

test('K5 읽는 도중 DB 파일이 교체되면 오류로 끝내고 기억하지 않는다(다시 시도 없음)', t => {
  const f = decisionHome();
  f.store.request('repo/card-a', input, BY);
  const reader = createDashboardDecisionsReader(f.home, {now: () => 3_000_000});
  reader.read();
  f.store.request('repo/card-a', {...input, question: '둘째'}, BY);
  // DB 파일의 식별값을 재는 stat만 가로챈다: 읽기 전(1번째)은 그대로, 읽은 뒤(2번째)는 다른 파일인 것처럼.
  const file = storagePath(f.home), original = fs.statSync;
  let stats = 0;
  const mock = t.mock.method(fs, 'statSync', function (target, ...rest) {
    const st = original.call(this, target, ...rest);
    if (target !== file) return st;
    stats++;
    return stats === 2 ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, {ino: st.ino + 1}) : st;
  });
  const full0 = reader.info().full;
  assert.throws(() => reader.read(), /조회 중 저장소 파일 교체/);
  assert.equal(stats, 2, '식별값을 전·후 두 번만 쟀다(다시 시도하지 않았다)');
  assert.equal(reader.info().cached, 0);
  mock.mock.restore();
  // 다음 호출은 전체를 다시 읽어 최신을 준다.
  assert.deepEqual(plain(reader.read()), readStream(f.home, STREAM));
  assert.equal(reader.info().full, full0 + 2);
  // 바깥 읽기 연결 안에서 불러도 같은 규칙이다(수집 경로).
  const inside = storageSnapshot(f.home, () => reader.read());
  assert.equal(inside.length, 2);
});

test('K5 저장소가 없는 홈은 기억하지 않고 지금처럼 빈 목록이다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-decision-none-'));
  const reader = createDashboardDecisionsReader(home);
  assert.deepEqual(reader.read(), []);
  assert.deepEqual(reader.info(), {rows: 0, full: 0, cached: 0});
  assert.deepEqual(dashboardDecisionList(home), oracleList(home));
  assert.equal(readHumanBriefInputs(home, []).decisions.size, 0);
});

test('K5 수집 경유: 변경 없는 두 번째 수집은 결정 줄을 0줄 읽고, 결정이 오면 그 수집에 보인다', () => {
  const f = decisionHome();
  const previous = process.env.KADAN_HOME;
  process.env.KADAN_HOME = f.home;
  const collect = () => loadWallSnapshot(null, {listOnly: true, summaryBodies: true});
  try {
    const a = f.store.request('repo/card-a', input, BY);
    const first = collect();
    assert.deepEqual(plain(first.decisions), plain(oracleList(f.home)));
    const info1 = dashboardDecisionsInfo();
    const second = collect();
    assert.deepEqual(dashboardDecisionsInfo(), info1, '변경 없는 수집은 결정 줄을 읽지 않았다');
    assert.equal(second.decisions, first.decisions);
    f.store.cancel(a.id, {revision: 1, reason: '수집 사이 취소'}, BY);
    const third = collect();
    assert.equal(third.decisions.find(d => d.id === a.id).status, 'cancelled');
    assert.equal(dashboardDecisionsInfo().full, info1.full + 1,
      '결정이 바뀐 수집은 한 번만 다시 읽는다(목록·설명 입력이 같은 줄을 쓴다)');
    assert.equal(third.decisionError, null);
  } finally {
    if (previous === undefined) delete process.env.KADAN_HOME;else process.env.KADAN_HOME = previous;
  }
});
