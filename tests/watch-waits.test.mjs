import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {ProgressWatch} from '../src/watch-progress.mjs';
import {observationContext, SupervisorHealth} from '../src/watch-supervisor-health.mjs';
import {buildWatchPrompt} from '../src/watch-ai.mjs';
import {decisionList, openDecisionContext, decisionFields, waitsOfCard, waitFields, waitingCardKeys} from '../src/watch-waits.mjs';

// 사례 재현용 가짜 이름: 감독 S가 업무 A에 열린 채팅 결정을 올렸고, 막힌 실행은 업무 B에 있다.
const S = '시험-감독-S', T = '시험-감독-T', worker = '시험-작업자';
const card = {key: 'r/b1', id: 'b1', status: 'assigned', workType: 'execution', activity: 'running', role: worker, title: '막힌 실행'};
const decision = (over = {}) => ({id: 'd1', status: 'open', chat: true, card: null, work: 'r/work-a', requestedBy: S, question: '감독을 다시 띄울지', options: ['예', '아니오'], recommendation: '예', at: '2026-10-30T15:20:00Z', ...over});
const works = [{key: 'r/work-b', executions: [{key: 'r/b1'}]}, {key: 'r/work-a', executions: [{key: 'r/a1'}]}];
const decisionWait = d => ({ids: [d.card, d.work ? `work:${d.work}` : null].filter(Boolean), answerer: '@user', kind: 'decision', ref: d.id});

test('결정 목록: 못 읽음(null)과 열린 결정 없음([])이 다르다', () => {
  assert.equal(decisionList(undefined), null);
  assert.equal(decisionList(null), null);
  assert.deepEqual(decisionList([]), []);
  assert.equal(openDecisionContext(null, S), null);
  assert.deepEqual(openDecisionContext([], S), []);
  assert.deepEqual(decisionFields(null, S), {openDecisions: null, openDecisionsUnread: true});
  assert.deepEqual(decisionFields([], S), {openDecisions: []});
});

test('감독 관찰AI 입력에는 그 감독의 열린 결정만 있고 다른 감독 T의 결정·닫힌 결정은 없다', () => {
  const decisions = [decision(), decision({id: 'dT', requestedBy: T}), decision({id: 'dClosed', status: 'answered'})];
  const items = openDecisionContext(decisions, S);
  assert.deepEqual(items.map(d => d.id), ['d1']);
  assert.deepEqual(Object.keys(items[0]).sort(), ['at', 'card', 'id', 'options', 'question', 'recommendation', 'work']);
  const obs = {alive: true, pid: 1, expectedPid: 1};
  const withDecisions = observationContext(S, obs, [], [], [], decisions);
  assert.deepEqual(withDecisions.openDecisions.map(d => d.id), ['d1']);
  assert.equal(observationContext(S, obs, [], [], [], null).openDecisionsUnread, true);
  assert.equal(observationContext(S, obs, [], [], [], null).openDecisions, null);
  assert.equal('openDecisions' in observationContext(S, obs, [], [], []), false);
});

test('감독 정기 후보(select)의 입력에도 결정 문맥이 실린다', () => {
  const health = new SupervisorHealth();
  const scope = {sessions: new Set([`kadan-${S}`]), entries: []};
  const observations = new Map([[`kadan-${S}`, {alive: true, pid: 1, expectedPid: 1, screen: '화면', startedAt: new Date(0).toISOString()}]]);
  const base = {scope, observations, entries: [], cards: [], enabled: true, ownTurn: new Set()};
  health.select({...base, now: 0, decisions: [decision()]});
  const {candidate} = health.select({...base, now: 61 * 60_000, decisions: [decision()]});
  assert.deepEqual(candidate.input.openDecisions.map(d => d.id), ['d1']);
});

test('명확히 연결된 답 대기만 진행 후보에서 뺀다. 업무가 다른 감독의 결정(사례)은 거름 근거가 아니다', () => {
  const roleOf = () => worker;
  const linked = decisionWait(decision({work: 'r/work-b'}));
  const unrelated = decisionWait(decision());
  assert.deepEqual([...waitingCardKeys([card], works, [linked], true, roleOf)], ['r/b1']);
  assert.equal(waitingCardKeys([card], works, [unrelated], true, roleOf).size, 0);
  // 카드 id·카드 key로 직접 걸린 결정과 질문 우편도 센다.
  assert.equal(waitingCardKeys([card], works, [{ids: ['r/b1'], answerer: '@user'}], true, roleOf).size, 1);
  // 못 읽었으면 아무것도 빼지 않는다.
  assert.equal(waitingCardKeys([card], works, [linked], false, roleOf).size, 0);
  // 질문 우편은 작업자가 물은 것일 때만 센다: 작업자가 답할 쪽이면 작업자의 할 일이다.
  assert.equal(waitsOfCard([{ids: ['b1'], answerer: worker, asker: S}], card, 'b1', works, worker).length, 0);
  assert.equal(waitsOfCard([{ids: ['b1'], answerer: S, asker: worker}], card, 'b1', works, worker).length, 1);
});

test('답 대기에 걸린 카드는 후보가 안 나오고 감독의 다른 실행은 그대로 판정한다. 풀리면 바로 다시 나온다', () => {
  const other = {...card, key: 'r/c1', id: 'c1', role: `${worker}2`};
  const cards = [card, other];
  const entries = [{kind: 'send', role: worker, taskId: 'b1'}, {kind: 'send', role: other.role, taskId: 'c1'}];
  const observations = new Map(cards.map((c, i) => [`kadan-${c.role}`, {alive: true, pid: i + 1, screen: `화면${c.id}`}]));
  const w = new ProgressWatch();
  const args = {cards, entries, observations, now: 0, enabled: true, waiting: new Set(['r/b1'])};
  w.select(args);
  args.now = 30 * 60_000;
  assert.equal(w.select(args).taskId, 'c1');
  args.now = 31 * 60_000; args.blockedSessions = new Set([`kadan-${other.role}`]);
  assert.equal(w.select(args), null);
  args.waiting = new Set();
  assert.equal(w.select(args).taskId, 'b1');
});

test('진행 AI 입력용 대기 자료: 못 읽음(null)과 빈 목록이 서로 다르게 나온다', () => {
  assert.deepEqual(waitFields([], false, card, 'b1', works, worker), {waits: null, waitsUnread: true});
  assert.deepEqual(waitFields([], true, card, 'b1', works, worker), {waits: []});
  assert.deepEqual(waitFields([decisionWait(decision({work: 'r/work-b'}))], true, card, 'b1', works, worker),
    {waits: [{kind: 'decision', ref: 'd1', answerer: '@user'}]});
});

for (const source of ['progress', 'supervisor-health', 'stall']) {
  test(`감시AI 지시문(${source}): kyle 결정 대기는 정상 대기로 입력대기에 기록하라는 규칙`, () => {
    const text = buildWatchPrompt({source, command: 'cmd', input: {}});
    for (const phrase of ['openDecisions', 'waits', '정상 대기다', '입력대기로 기록하고 정체로 보고하지 마라', 'openDecisionsUnread·waitsUnread'])
      assert.ok(text.includes(phrase), phrase);
  });
}
