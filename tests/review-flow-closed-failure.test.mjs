import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout} from 'node:timers/promises';
import {dashboardFixture} from './helpers/dashboard-fixture.mjs';
import {dashboardData} from '../src/dashboard-api.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {executionBucket} from '../src/dashboard-execution.mjs';
import {buildReviewFlows} from '../src/review-flow.mjs';

// Why: 마감이 실패한 실행 카드도 done으로 닫으면서(#495), 업무를 다시 열면 결과 없이 실패한 검수의 단계가
// '검수 중단'에서 '검수 판정 미기록'으로 바뀌었다(2026-11-26 재검수). 원장의 실패는 단계 표에서도 실패로 읽혀야 하고,
// 닫은 카드는 목록에서 계속 끝난 것으로 남아야 한다.
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
  return {work: shown(workFlow), card: shown(detail(review).reviewFlow),
    storedStatus: fixture.cards.get(review).status, listState: card.displayState, bucket: executionBucket(card),
    runResult: card.runs[0].result};
}

for (const [result, label, verdict, state, stateLabel] of [
  ['failed', '검수 중단', 'exception', 'failed', '실패'],
  ['ok', '검수 판정 미기록', 'pending', 'done', '완료'],
]) {
  test(`결과 없이 ${result}로 끝난 검수: 마감하고 다시 열어도 단계는 '${label}'이고 닫은 카드는 목록에서 끝난 것이다`, async t => {
    const fixture = dashboardFixture({count: 2});
    t.after(() => fixture.server.close());
    registerRun(fixture, implementation, 'implementation', 'ok');
    registerRun(fixture, review, 'review', result);
    change(fixture, 'link', {execution: review, phase: 'review', round: 1});
    const flow = {label, verdict, round: 1, reviewState: state, reviewStateLabel: stateLabel};
    const before = read(fixture);
    assert.deepEqual([before.work, before.card], [flow, flow]);
    await setTimeout(5);
    const closed = change(fixture, 'complete', {result: '격리 검수 근거'});
    assert.deepEqual(closed.cardClose.failed, []);
    for (const step of ['complete', 'reopen']) {
      if (step === 'reopen') { await setTimeout(5); change(fixture, 'reopen', {}); }
      const after = read(fixture);
      assert.deepEqual([after.work, after.card], [flow, flow], `${step} 뒤 단계 표`);
      // #495 유지: 저장 상태는 done이고 '지금 막힌 것'·'오래된 미확정'으로 돌아오지 않는다.
      assert.deepEqual([after.storedStatus, after.listState, after.bucket], ['done', 'done', 'closed'], `${step} 뒤 카드 목록`);
      assert.equal(after.runResult, result, '원장 실행 결과 보존');
    }
  });
}

const stageCard = (key, step, extra = {}) => ({key: `demo/${key}`, repo: 'demo', board: 'board', title: key, role: 'worker',
  workType: 'execution', rallyId: 'r', rallyTitle: '묶음', rallyRound: '1', rallyStep: step, displayState: 'done',
  history: [], runs: [], ...extra});
const implemented = {result: {outcome: 'implemented', at: '2026-01-01T00:00:00Z', by: 'worker'}};
const flowOf = reviewCard => buildReviewFlows([stageCard('impl', 'implementation', implemented), reviewCard])[0];
const failedRun = {runs: [{state: 'failed'}]};

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
  assert.deepEqual([flow.rounds[0].work[0].state, flow.rounds[0].work[0].stateLabel], ['failed', '실패']);
});
