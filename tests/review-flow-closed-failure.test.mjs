import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout} from 'node:timers/promises';
import {dashboardFixture} from './helpers/dashboard-fixture.mjs';
import {dashboardData} from '../src/dashboard-api.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {executionBucket} from '../src/dashboard-execution.mjs';
import {buildReviewFlows} from '../src/review-flow.mjs';
import {buildRallies} from '../src/rallies.mjs';
import {workspaceModel} from '../src/dashboard-workspace.mjs';
import {cardCommand} from '../src/card-command.mjs';
import {CardStore} from '../src/card-store.mjs';
import {backfillCloseCards} from '../src/work-card-backfill.mjs';

// Why: 마감이 실패한 실행 카드도 done으로 닫으면서(#495), 업무를 다시 열면 결과 없이 실패한 검수의 단계가
// '검수 중단'에서 '검수 판정 미기록'으로 바뀌었다(2026-11-26 재검수). 마감·소급 닫기가 완료로 만든 카드의 원장 실패는
// 단계 표·묶음에서도 실패로 읽혀야 하고, 닫은 카드는 목록에서 계속 끝난 것으로 남아야 한다.
// 사람이 손으로 완료한 카드는 그 결정이 과거 실행보다 앞서므로 #495 전처럼 완료로 보여야 한다.
const workKey = 'demo/dashboard', implementation = 'demo/card-1', review = 'demo/card-2';

function change(fixture, action, fields) {
  return fixture.works.change(workKey, action, fields,
    {revision: fixture.works.get(workKey).revision, by: '사람', note: '격리 검수'});
}
function registerRun(fixture, key, step, result) {
  const role = step === 'review' ? 'qa-review' : 'qa-worker';
  fixture.cards.update(key, {status: 'assigned', scope: '격리 검수', board: 'qa', role,
    rallyId: 'reopened-review', rallyTitle: '격리 검수', rallyRound: '1', rallyStep: step},
  {revision: fixture.cards.get(key).revision, by: '사람', note: '격리 검수'});
  const taskId = key.split('/').at(-1), t = new Date().toISOString();
  appendLedger({kind: 'send', role, taskId, executionKey: key, digest: step, t}, fixture.home);
  appendLedger({kind: 'done', role, taskId, executionKey: key, result, t}, fixture.home);
}
// 상세 화면이 읽는 두 응답(업무 상세의 묶음 표, 검수 카드 상세의 묶음 표)과 카드 목록 판정을 함께 읽는다.
function read(fixture) {
  const snapshot = fixture.snapshot();
  const detail = card => dashboardData(snapshot, new URL(`http://localhost/api/dashboard/detail?card=${card}`));
  const shown = flow => ({label: flow.label, verdict: flow.verdict, round: flow.rounds.at(-1).number,
    reviewState: flow.rounds.at(-1).review[0].state, reviewStateLabel: flow.rounds.at(-1).review[0].stateLabel});
  const [workFlow] = detail(`work:${workKey}`).reviewFlows;
  const card = snapshot.center.cards.find(c => c.key === review);
  const [rally] = buildRallies(snapshot.center.cards);
  const row = workspaceModel(snapshot.center).find(r => r.key === review);
  return {work: shown(workFlow), card: shown(detail(review).reviewFlow), rally: {state: rally.state, done: rally.done, phase: row.flowPhase},
    storedStatus: fixture.cards.get(review).status, listState: card.displayState, bucket: executionBucket(card),
    runResult: card.runs[0].result};
}

const FAILED = {flow: ['검수 중단', 'exception', 'failed', '실패'], rally: {state: 'failed', done: false, phase: '독립검수 · 실패'}};
const OK = {flow: ['검수 판정 미기록', 'pending', 'done', '완료'], rally: {state: 'done', done: true, phase: '구현·검수 완료 기록'}};
const shownFlow = ([label, verdict, reviewState, reviewStateLabel]) => ({label, verdict, round: 1, reviewState, reviewStateLabel});
function prepared(t, result) {
  const fixture = dashboardFixture({count: 2});
  t.after(() => fixture.server.close());
  registerRun(fixture, implementation, 'implementation', 'ok');
  registerRun(fixture, review, 'review', result);
  change(fixture, 'link', {execution: review, phase: 'review', round: 1});
  return fixture;
}
const cardUpdate = (fixture, flags) => cardCommand(['update', review],
  {revision: String(fixture.cards.get(review).revision), ...flags}, {home: fixture.home, by: '사람'});
const sees = (fixture, expected, message) => {
  const now = read(fixture);
  assert.deepEqual([now.work, now.card, now.rally], [shownFlow(expected.flow), shownFlow(expected.flow), expected.rally], message);
  return now;
};

for (const [result, expected] of [['failed', FAILED], ['ok', OK]]) {
  const [label] = expected.flow;
  const {rally} = expected;
  test(`결과 없이 ${result}로 끝난 검수: 마감하고 다시 열어도 단계는 '${label}'이고 닫은 카드는 목록에서 끝난 것이다`, async t => {
    const fixture = prepared(t, result);
    const flow = shownFlow(expected.flow);
    const before = read(fixture);
    assert.deepEqual([before.work, before.card], [flow, flow]);
    // 묶음 상태와 실행 줄의 단계 글은 #495 전(닫기 전)과 같아야 한다.
    assert.deepEqual(before.rally, rally);
    await setTimeout(5);
    const closed = change(fixture, 'complete', {result: '격리 검수 근거'});
    assert.deepEqual(closed.cardClose.failed, []);
    for (const step of ['complete', 'reopen']) {
      if (step === 'reopen') { await setTimeout(5); change(fixture, 'reopen', {}); }
      const after = read(fixture);
      assert.deepEqual([after.work, after.card], [flow, flow], `${step} 뒤 단계 표`);
      assert.deepEqual(after.rally, rally, `${step} 뒤 묶음`);
      // #495 유지: 저장 상태는 done이고 '지금 막힌 것'·'오래된 미확정'으로 돌아오지 않는다.
      assert.deepEqual([after.storedStatus, after.listState, after.bucket], ['done', 'done', 'closed'], `${step} 뒤 카드 목록`);
      assert.equal(after.runResult, result, '원장 실행 결과 보존');
    }
  });
}

test('손으로 card update --status done 한 카드는 원장에 실패가 있어도 #495 전처럼 완료다', t => {
  const fixture = prepared(t, 'failed');
  sees(fixture, FAILED, '손 완료 전');
  cardUpdate(fixture, {status: 'done', note: '확인하고 완료 처리'});
  const manual = {flow: OK.flow, rally: OK.rally};
  assert.equal(sees(fixture, manual, '손 완료 뒤').runResult, 'failed');
  // 이미 손으로 완료한 카드는 업무 마감이 건드리지 않아 마감·재개 뒤에도 같다.
  const closed = change(fixture, 'complete', {result: '근거'});
  assert.equal(closed.cardClose.closed.some(c => c.key === review), false);
  change(fixture, 'reopen', {});
  sees(fixture, manual, '업무 재개 뒤');
});

for (const action of ['complete', 'cancel']) {
  test(`자동 닫기(${action}) 뒤에 메모를 남겨도 실패이고, 다시 발령 상태로 바꿨다가 손으로 완료하면 완료다`, t => {
    const fixture = prepared(t, 'failed');
    change(fixture, action, {result: '근거'});
    sees(fixture, FAILED, '자동 닫기 뒤');
    cardUpdate(fixture, {note: '나중에 덧붙인 메모'});
    sees(fixture, FAILED, '메모 뒤');
    cardUpdate(fixture, {status: 'done', note: '상태는 그대로 두고 다시 저장'});
    sees(fixture, FAILED, '같은 상태 저장 뒤');
    // 준비 단계: card update의 수동 발령은 카드 본문 형식을 요구해 저장 모듈로 되돌린다.
    fixture.cards.update(review, {status: 'assigned'}, {revision: fixture.cards.get(review).revision, by: '사람', note: '다시 연다'});
    cardUpdate(fixture, {status: 'done', note: '사람이 확인하고 완료'});
    sees(fixture, OK, '손 완료 뒤');
  });
}

for (const action of ['complete', 'cancel']) {
  test(`소급 닫기(work backfill-close, ${action} 업무)로 닫은 실패 카드는 실패다`, t => {
    const fixture = prepared(t, 'failed');
    // #495 전의 마감: 업무 기록만 닫히고 실행 카드는 남는다.
    const held = t.mock.method(CardStore.prototype, 'closeDone', () => ({closed: [], failed: []}));
    change(fixture, action, {result: '근거'});
    held.mock.restore();
    const applied = backfillCloseCards(fixture.home, {apply: true, by: '사람'});
    assert.deepEqual(applied.closed.filter(c => c.key === review), [{key: review, from: 'assigned', result: 'failed'}]);
    const after = sees(fixture, FAILED, '소급 닫기 뒤');
    assert.deepEqual([after.storedStatus, after.listState, after.bucket], ['done', 'done', 'closed']);
    change(fixture, 'reopen', {});
    sees(fixture, FAILED, '업무 재개 뒤');
  });
}

const stageCard = (key, step, extra = {}) => ({key: `demo/${key}`, repo: 'demo', board: 'board', title: key, role: 'worker',
  workType: 'execution', rallyId: 'r', rallyTitle: '묶음', rallyRound: '1', rallyStep: step, displayState: 'done',
  history: [], runs: [], ...extra});
const implemented = {result: {outcome: 'implemented', at: '2026-01-01T00:00:00Z', by: 'worker'}};
const flowOf = reviewCard => buildReviewFlows([stageCard('impl', 'implementation', implemented), reviewCard])[0];
const byWork = {status: 'done', statusReason: '업무 demo/work 완료 마감으로 자동 닫음 · 원장 결과 failed (R failed)'};
const failedRun = {...byWork, runs: [{state: 'failed'}]};

test('실패로 읽는 것은 닫기가 남긴 상태 이유뿐이다. 비슷한 손 메모와 저장 상태가 done이 아닌 카드는 아니다', () => {
  const shown = extra => flowOf(stageCard('review', 'review', {...failedRun, ...extra})).rounds[0].review[0].state;
  assert.equal(shown({}), 'failed');
  assert.equal(shown({statusReason: '업무 demo/work 취소 마감 소급 정리로 닫음 · 원장 결과 failed (R failed)'}), 'failed');
  for (const statusReason of [undefined, '', '확인하고 완료', '업무 demo/work 마감으로 자동 닫음',
    '확인: 업무 demo/work 완료 마감으로 자동 닫음 · 원장 결과 failed (R failed)']) {
    assert.equal(shown({statusReason}), 'done', String(statusReason));
  }
  assert.equal(shown({status: 'assigned'}), 'done');
});

test('원장 실패를 되살리는 것은 완료로 보이는 카드뿐이다. 취소·대체·일시정지 표시는 그대로다', () => {
  for (const displayState of ['cancelled', 'superseded', 'hold']) {
    const flow = flowOf(stageCard('review', 'review', {displayState, ...failedRun}));
    assert.deepEqual([flow.rounds[0].review[0].state, flow.label], [displayState, '검수 대기'], displayState);
  }
});

test('등록한 검수 판정은 실행이 failed여도 그대로 보인다', () => {
  const result = outcome => ({result: {outcome, at: '2026-01-01T00:00:00Z', by: 'reviewer'}});
  assert.equal(flowOf(stageCard('review', 'review', {...failedRun, ...result('pass')})).label, '최종 검수 통과');
  assert.equal(flowOf(stageCard('review', 'review', {...failedRun, ...result('changes')})).label, '수정 필요');
});

test('구현 단계도 원장의 실패를 완료로 보이지 않는다', () => {
  const [flow] = buildReviewFlows([stageCard('impl', 'implementation', failedRun), stageCard('review', 'review')]);
  assert.equal(buildRallies([stageCard('impl', 'implementation', failedRun), stageCard('review', 'review')])[0].state, 'failed');
  assert.deepEqual([flow.rounds[0].work[0].state, flow.rounds[0].work[0].stateLabel], ['failed', '실패']);
});
