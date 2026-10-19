import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CardStore} from '../src/card-store.mjs';
import {buildCardCenter} from '../src/card-center.mjs';
import {executionBucket} from '../src/dashboard-execution.mjs';
import {planStaleNotices, runStaleNotices, STALE_NOTICE_KIND, STALE_NOTICE_LIMIT} from '../src/watch-stale-notice.mjs';

const NOW = Date.parse('2026-10-19T06:00:00Z');
const mk = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-stale-'));
  const store = new CardStore(home);
  const card = (id, role, {round = '1', work = 'w1', status = 'assigned'} = {}) => {
    const c = store.create({repo: 'repo', id, repoPath: home, body: '# ' + id});
    const r = store.update(c.key, {status: 'ready', scope: '범위'}, {revision: 1, note: '승인'});
    return store.update(c.key, {status, role, board: 'b', rallyId: work, rallyTitle: '묶음', rallyRound: round, rallyStep: 'implementation'},
      {revision: r.revision, note: '배정'});
  };
  return {home, store, card};
};
const send = (taskId, role, t, by = '감독-A') => ({kind: 'send', taskId, role, by, t, board: 'b'});
const center = (cards, entries) => buildCardCenter({cards, entries, tree: [], runtimeKnown: false, now: NOW}).cards;
const bucketOf = (cs, id) => executionBucket(cs.find(c => c.id === id), NOW);

test('분류: 역할이 다음 카드를 받으면 오래된 미확정, 지금 발령은 계속 지금 막힘', () => {
  const {card} = mk();
  const old = card('old', '작업자-1', {work: 'w1'}), next = card('next', '작업자-1', {work: 'w2'});
  const entries = [send('old', '작업자-1', '2026-10-18T06:00:00Z'), send('next', '작업자-1', '2026-10-19T05:00:00Z')];
  const cs = center([old, next], entries);
  assert.equal(cs.find(c => c.id === 'old').movedOn, 'role');
  assert.equal(bucketOf(cs, 'old'), 'stale');
  assert.equal(cs.find(c => c.id === 'next').movedOn, undefined);
  assert.equal(bucketOf(cs, 'next'), 'stuck'); // 신호가 최근이고 시작 보고가 없다 = 진짜 막힘은 숨기지 않는다
});

test('분류: 같은 업무에 뒤 라운드가 있으면 오래된 미확정, 다른 업무 뒤 라운드는 상관없다', () => {
  const {card} = mk();
  const r1 = card('r1', '검수자-1', {round: '1'}), r2 = card('r2', '작업자-2', {round: '2'}), other = card('o1', '작업자-3', {round: '1', work: 'w9'});
  const entries = [send('r1', '검수자-1', '2026-10-19T05:00:00Z'), send('r2', '작업자-2', '2026-10-19T05:30:00Z'), send('o1', '작업자-3', '2026-10-19T05:30:00Z')];
  const cs = center([r1, r2, other], entries);
  assert.equal(cs.find(c => c.id === 'r1').movedOn, 'round');
  assert.equal(bucketOf(cs, 'r1'), 'stale');
  assert.equal(bucketOf(cs, 'o1'), 'stuck');
});

test('분류: 취소·일시정지된 옛 실행은 오래된 미확정이 아니라 제 칸에 남고 재안내도 없다', () => {
  const {card, store} = mk();
  const a = card('c1', '작업자-1', {work: 'w1'}), b = card('h1', '작업자-1', {work: 'w3'}), next = card('n1', '작업자-1', {work: 'w2'});
  const cancelled = store.update(a.key, {status: 'cancelled'}, {revision: a.revision, note: '취소'});
  const held = store.update(b.key, {status: 'hold'}, {revision: b.revision, note: '보류'});
  const entries = [send('c1', '작업자-1', '2026-10-17T06:00:00Z'), send('h1', '작업자-1', '2026-10-18T06:00:00Z'), send('n1', '작업자-1', '2026-10-19T05:00:00Z')];
  const cs = center([cancelled, held, next], entries);
  assert.equal(bucketOf(cs, 'c1'), 'closed');
  assert.equal(bucketOf(cs, 'h1'), 'hold');
  assert.deepEqual(planStaleNotices({cards: [cancelled, held, next], entries, now: NOW}), []);
});

const setup = () => {
  const {card, store} = mk();
  const old1 = card('old1', '작업자-1', {work: 'w1'}), old2 = card('old2', '작업자-2', {work: 'w1', round: '1'});
  const next1 = card('next1', '작업자-1', {work: 'w2'}), later = card('later', '작업자-9', {work: 'w1', round: '2'});
  const entries = [
    send('old1', '작업자-1', '2026-10-18T06:00:00Z', '감독-A'), send('old2', '작업자-2', '2026-10-18T06:10:00Z', '감독-B'),
    send('next1', '작업자-1', '2026-10-19T05:00:00Z', '감독-A'), send('later', '작업자-9', '2026-10-19T05:10:00Z', '감독-A'),
  ];
  return {cards: [old1, old2, next1, later], entries, store};
};

test('재안내: 감독별로 한 통에 묶고, 판정 명령 뼈대는 있되 DONE 마커는 넣지 않는다', () => {
  const {cards, entries} = setup();
  const plans = planStaleNotices({cards, entries, now: NOW});
  assert.deepEqual(plans.map(p => p.recipient).sort(), ['감독-A', '감독-B']);
  const a = plans.find(p => p.recipient === '감독-A');
  assert.deepEqual(a.keys, ['repo/old1']);
  assert.match(a.message, /kadan done 작업자-1 old1 <ok\|failed>/);
  assert.match(a.message, /--status superseded --replaced-by/);
  assert.match(a.message, /--status cancelled/);
  assert.doesNotMatch(a.message, /KADAN:DONE/);
});

test('재안내: 실행당 평생 1회(원장 기준이라 재시작 뒤에도), 실제 전달은 가짜 콜백으로만', () => {
  const {cards, entries} = setup();
  const log = [], sent = [];
  const record = e => log.push(e);
  const first = runStaleNotices({cards, entries, now: NOW, send: (r, m) => sent.push([r, m]), record});
  assert.equal(first.sent, 2);
  assert.equal(sent.length, 2);
  assert.ok(log.every(e => e.alertKind === STALE_NOTICE_KIND && e.resolved === true && e.delivered === true && !e.id));
  const again = runStaleNotices({cards, entries: [...entries, ...log], now: NOW, send: (r, m) => sent.push([r, m]), record});
  assert.deepEqual(again, {sent: 0, unknownRecipient: 0, failed: 0, held: 0});
  assert.equal(sent.length, 2);
});

test('재안내: 알림 보류면 기록 없이 미루고 다음에 다시, 판정된 실행은 목록에서 빠진다', () => {
  const {cards, entries, store} = setup();
  const held = Object.assign(new Error('입력 중'), {delivery: 'not-sent', holdCode: 'human-input'});
  const log = [];
  const out = runStaleNotices({cards, entries, now: NOW, record: e => log.push(e), send: () => { throw held; }});
  // 보류 판정 함수가 이 오류를 보류로 보는지에 따라 held 또는 failed로 센다. 보류면 기록이 없어야 한다.
  assert.equal(out.held + out.failed, 2);
  if (out.held) assert.equal(log.length, 0);
  const cancelled = store.update(cards[0].key, {status: 'cancelled'}, {revision: cards[0].revision, note: '판정'});
  assert.ok(!planStaleNotices({cards: [cancelled, ...cards.slice(1)], entries, now: NOW}).some(p => p.keys.includes('repo/old1')));
});

test('재안내: 받는 쪽을 모르면 보내지 않고 기록만 남기며 업무 owner가 있으면 그쪽으로 간다', () => {
  const {card} = mk();
  const old = card('x1', '작업자-1', {work: 'w1'}), next = card('x2', '작업자-1', {work: 'w2'});
  const entries = [send('x1', '작업자-1', '2026-10-18T06:00:00Z', '모름'), send('x2', '작업자-1', '2026-10-19T05:00:00Z', '모름')];
  const log = [], sent = [];
  const out = runStaleNotices({cards: [old, next], entries, now: NOW, send: (r) => sent.push(r), record: e => log.push(e)});
  assert.equal(out.unknownRecipient, 1);
  assert.equal(sent.length, 0);
  assert.equal(log[0].delivered, false);
  assert.equal(log[0].recipient, null);
  const works = [{owner: '업무-감독', executions: [{key: 'repo/x1'}]}];
  assert.equal(planStaleNotices({cards: [old, next], entries, works, now: NOW})[0].recipient, '업무-감독');
});

test('재안내: 한 통은 목록 상한까지만 싣고 나머지는 외 N개로 적는다', () => {
  const {card} = mk();
  const cards = [], entries = [];
  const total = STALE_NOTICE_LIMIT + 5;
  for (let i = 0; i < total; i++) {
    cards.push(card('b' + i, '작업자-' + i, {work: 'w' + i}));
    entries.push(send('b' + i, '작업자-' + i, '2026-10-18T06:00:00Z'));
  }
  cards.push(card('nx', '작업자-0', {work: 'wz'}));
  // 모든 역할이 다음 일을 받게 한다
  for (let i = 0; i < total; i++) { cards.push(card('c' + i, '작업자-' + i, {work: 'wc' + i})); entries.push(send('c' + i, '작업자-' + i, '2026-10-19T05:00:00Z')); }
  const [plan] = planStaleNotices({cards, entries, now: NOW});
  assert.equal(plan.keys.length, total);
  assert.equal((plan.message.match(/^- repo\//gm) || []).length, STALE_NOTICE_LIMIT);
  assert.match(plan.message, /외 5개/);
});
