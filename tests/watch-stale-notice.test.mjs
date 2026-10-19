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
const fail = (taskId, role, t) => ({kind: 'done', taskId, role, by: role, result: 'failed', t, board: 'b'});
const center = (cards, entries) => buildCardCenter({cards, entries, tree: [], runtimeKnown: false, now: NOW}).cards;
const bucketOf = (cs, id) => executionBucket(cs.find(c => c.id === id), NOW);

test('분류: 실패로 끝난 실행의 역할이 다음 카드를 받으면 오래된 미확정, 지금 발령은 계속 지금 막힘', () => {
  const {card} = mk();
  const old = card('old', '작업자-1', {work: 'w1'}), next = card('next', '작업자-1', {work: 'w2'});
  const entries = [send('old', '작업자-1', '2026-10-18T06:00:00Z'), fail('old', '작업자-1', '2026-10-18T07:00:00Z'), send('next', '작업자-1', '2026-10-19T05:00:00Z')];
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
    send('old1', '작업자-1', '2026-10-18T06:00:00Z', '감독-A'), fail('old1', '작업자-1', '2026-10-18T07:00:00Z'), send('old2', '작업자-2', '2026-10-18T06:10:00Z', '감독-B'),
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
  assert.doesNotMatch(a.message, /kadan done/); // 실패한 실행에는 결과 확정 명령을 주지 않는다
  assert.match(plans.find(p => p.recipient === '감독-B').message, /kadan done 작업자-2 repo\/old2 <ok\|failed>/);
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
  assert.ok(log.every(e => e.alertKind === STALE_NOTICE_KIND && e.resolved === true && !e.id));
  assert.equal(log.filter(e => e.delivered === true).length, 2);
  assert.equal(log.filter(e => e.attempt).length, 2); // 보내기 전에 시도부터 남긴다
  const again = runStaleNotices({cards, entries: [...entries, ...log], now: NOW, send: (r, m) => sent.push([r, m]), record});
  assert.deepEqual(again, {sent: 0, unknownRecipient: 0, failed: 0, held: 0});
  assert.equal(sent.length, 2);
});

test('재안내: 알림 보류면 시도를 거두고 다음에 다시, 판정된 실행은 목록에서 빠진다', () => {
  const {cards, entries, store} = setup();
  const held = Object.assign(new Error('입력 중'), {delivery: 'not-sent', code: 'KADAN_HUMAN_ACTIVE'});
  const log = [];
  const out = runStaleNotices({cards, entries, now: NOW, record: e => log.push(e), send: () => { throw held; }});
  assert.deepEqual(out, {sent: 0, unknownRecipient: 0, failed: 0, held: 2});
  assert.ok(planStaleNotices({cards, entries: [...entries, ...log], now: NOW}).length === 2); // 안 보냈으니 다시 시도
  const cancelled = store.update(cards[0].key, {status: 'cancelled'}, {revision: cards[0].revision, note: '판정'});
  assert.ok(!planStaleNotices({cards: [cancelled, ...cards.slice(1)], entries, now: NOW}).some(p => p.keys.includes('repo/old1')));
});

test('재안내: 보낸 뒤 결과 기록이 실패해도 다시 보내지 않고, 시도 기록이 실패하면 보내지 않는다', () => {
  const {cards, entries} = setup();
  const log = [], sent = [];
  // 시도 기록만 성공하고 뒤 기록은 실패
  let n = 0;
  const flaky = e => { if (n++ % 2) throw new Error('잠금'); log.push(e); };
  runStaleNotices({cards, entries, now: NOW, send: (r, m) => sent.push(r), record: flaky});
  assert.equal(sent.length, 2);
  assert.equal(planStaleNotices({cards, entries: [...entries, ...log], now: NOW}).length, 0);
  // 시도 기록이 실패하면 보내지 않는다
  const none = [];
  const out = runStaleNotices({cards, entries, now: NOW, send: r => none.push(r), record: () => { throw new Error('잠금'); }});
  assert.equal(none.length, 0);
  assert.equal(out.failed, 2);
});

test('재안내: 보낸 우편의 전달 실패는 기록하고 다시 보내지 않는다', () => {
  const {cards, entries} = setup();
  const log = [];
  const out = runStaleNotices({cards, entries, now: NOW, record: e => log.push(e),
    send: () => { throw Object.assign(new Error('세션 없음'), {delivery: 'not-sent'}); }});
  assert.equal(out.failed, 2);
  assert.equal(planStaleNotices({cards, entries: [...entries, ...log], now: NOW}).length, 0);
});

test('재안내: 받는 쪽을 모르면 보내지 않고 기록만 남기며 업무 owner가 있으면 그쪽으로 간다', () => {
  const {card} = mk();
  const old = card('x1', '작업자-1', {work: 'w1'}), next = card('x2', '작업자-1', {work: 'w2'});
  const entries = [send('x1', '작업자-1', '2026-10-18T06:00:00Z', '모름'), fail('x1', '작업자-1', '2026-10-18T07:00:00Z'), send('x2', '작업자-1', '2026-10-19T05:00:00Z', '모름')];
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
    entries.push(send('b' + i, '작업자-' + i, '2026-10-18T06:00:00Z'), fail('b' + i, '작업자-' + i, '2026-10-18T07:00:00Z'));
  }
  cards.push(card('nx', '작업자-0', {work: 'wz'}));
  // 모든 역할이 다음 일을 받게 한다
  for (let i = 0; i < total; i++) { cards.push(card('c' + i, '작업자-' + i, {work: 'wc' + i})); entries.push(send('c' + i, '작업자-' + i, '2026-10-19T05:00:00Z')); }
  const [plan] = planStaleNotices({cards, entries, now: NOW});
  assert.equal(plan.keys.length, total);
  assert.equal((plan.message.match(/^- repo\//gm) || []).length, STALE_NOTICE_LIMIT);
  assert.match(plan.message, /외 5개/);
});

// 검수 boundary-probe 경계(2026-10-19 1라운드): 숨기면 안 되는 지금 막힘이 stuck으로 남는지 본다.
const bucketsOf = (specs, entries) => {
  const {card} = mk();
  const cards = specs.map(([id, role, opts, patch]) => ({...card(id, role, opts), ...(patch ?? {})}));
  return {cards, cs: center(cards, entries)};
};

test('경계: 같은 실행 재발령·발령 시각 같음·시각 없음은 지금 막힘', () => {
  let {cs} = bucketsOf([['a', 'w']], [send('a', 'w', '2026-10-19T05:00:00Z'), send('a', 'w', '2026-10-19T05:30:00Z')]);
  assert.equal(bucketOf(cs, 'a'), 'stuck');
  ({cs} = bucketsOf([['a', 'w', {work: 'x'}], ['b', 'w', {work: 'y'}]], [fail('a', 'w', '2026-10-19T05:10:00Z'),
    send('a', 'w', '2026-10-19T05:00:00Z'), send('b', 'w', '2026-10-19T05:00:00Z')]));
  assert.equal(bucketOf(cs, 'a'), 'stuck');
  ({cs} = bucketsOf([['a', 'w', {work: 'x'}], ['b', 'w', {work: 'y'}]], [{...send('a', 'w'), t: undefined}, fail('a', 'w', '2026-10-19T05:10:00Z'),
    send('b', 'w', '2026-10-19T05:00:00Z')]));
  assert.equal(bucketOf(cs, 'a'), 'stuck');
});

test('경계: 같은 라운드·업무 없음·다른 저장소 같은 업무·같은 ID 다른 저장소는 지금 막힘', () => {
  const {card} = mk();
  const a = card('a', 'w', {round: '1'}), b = card('b', 'r', {round: '1'});
  assert.equal(bucketOf(center([a, b], [send('a', 'w', '2026-10-19T05:00:00Z'), send('b', 'r', '2026-10-19T05:10:00Z')]), 'a'), 'stuck');
  const noWork = {...a, rallyId: undefined}, later = {...card('c', 'r', {round: '2'}), rallyId: undefined};
  assert.equal(bucketOf(center([noWork, later], [send('a', 'w', '2026-10-19T05:00:00Z'), send('c', 'r', '2026-10-19T05:10:00Z')]), 'a'), 'stuck');
  const other = {...card('d', 'r', {round: '2'}), repo: 'other', key: 'other/d'};
  assert.equal(bucketOf(center([a, other], [send('a', 'w', '2026-10-19T05:00:00Z'), send('other/d', 'r', '2026-10-19T05:10:00Z')]), 'a'), 'stuck');
  const sameId = {...card('e', 'r'), id: 'a', repo: 'other', key: 'other/a'};
  assert.equal(bucketOf(center([a, sameId], [send('a', 'w', '2026-10-19T05:00:00Z'), send('other/a', 'r', '2026-10-19T05:10:00Z')]), 'a'), 'stuck');
});

test('경계(F1): 인계받은 실행은 새 담당의 과거 발령에 밀려나지 않는다', () => {
  const {card} = mk();
  const a = {...card('a', 'old', {work: 'x'}), at: '2026-10-19T04:00:00Z'}, b = card('b', 'new', {work: 'y'});
  const entries = [send('a', 'old', '2026-10-19T05:00:00Z'), fail('a', 'old', '2026-10-19T05:10:00Z'),
    send('b', 'new', '2026-10-19T05:20:00Z'),
    {kind: 'handover', phase: 'transferred', from: 'old', to: 'new', taskIds: ['a'], handoverId: 'h1', t: '2026-10-19T05:40:00Z'}];
  const cs = center([a, b], entries);
  assert.equal(cs.find(c => c.id === 'a').role, 'new');
  assert.equal(cs.find(c => c.id === 'a').movedOn, undefined);
  assert.equal(bucketOf(cs, 'a'), 'stuck');
});

test('경계(F1): 같은 역할의 동시 발령은 결과 없이 진행 중인 쪽을 넘기지 않고, 실패로 끝난 뒤의 새 발령만 넘긴다', () => {
  const {card} = mk();
  const a = card('a', 'w', {work: 'x'}), b = card('b', 'w', {work: 'y'});
  const concurrent = center([a, b], [send('a', 'w', '2026-10-19T05:00:00Z'), send('b', 'w', '2026-10-19T05:20:00Z')]);
  assert.equal(bucketOf(concurrent, 'a'), 'stuck');
  const failed = center([a, b], [send('a', 'w', '2026-10-19T05:00:00Z'), fail('a', 'w', '2026-10-19T05:10:00Z'), send('b', 'w', '2026-10-19T05:20:00Z')]);
  assert.equal(failed.find(c => c.id === 'a').movedOn, 'role');
});

test('경계(F2): 발령하지 않은 뒤 라운드(준비·취소·초안·보류)는 근거가 아니다', () => {
  const {card, store} = mk();
  for (const status of ['ready', 'cancelled', 'draft', 'hold', 'archived']) {
    const a = card('a' + status, 'w', {round: '1', work: 'u' + status});
    const made = card('b' + status, 'r', {round: '2', work: 'u' + status});
    const b = status === 'ready' || status === 'cancelled' || status === 'hold' || status === 'archived'
      ? store.update(made.key, {status}, {revision: made.revision, note: status}) : {...made, status};
    const cs = center([a, b], [send('a' + status, 'w', '2026-10-19T05:00:00Z')]);
    assert.equal(bucketOf(cs, 'a' + status), 'stuck', status);
  }
  // 발령은 됐지만 취소된 뒤 라운드도 근거가 아니다
  const a = card('ax', 'w', {round: '1', work: 'ux'}), made = card('bx', 'r', {round: '2', work: 'ux'});
  const b = store.update(made.key, {status: 'cancelled'}, {revision: made.revision, note: '취소'});
  assert.equal(bucketOf(center([a, b], [send('ax', 'w', '2026-10-19T05:00:00Z'), send('bx', 'r', '2026-10-19T05:10:00Z')]), 'ax'), 'stuck');
});

test('경계: 10/19 새 발령 직후 현재 실행은 지금 막힘으로 남는다', () => {
  const {card} = mk();
  const older = card('older', 'impl-3', {work: 'x'}), cur = card('cur', 'impl-3', {work: 'y'});
  const cs = center([older, cur], [send('older', 'impl-3', '2026-10-19T03:00:00Z'), fail('older', 'impl-3', '2026-10-19T03:30:00Z'),
    send('cur', 'impl-3', '2026-10-19T03:58:00Z')]);
  assert.equal(bucketOf(cs, 'cur'), 'stuck');
});

test('재안내(R2-F1): 세션이 사라진 옛 실행도 대시보드와 같은 생존 근거로 재안내 대상이 된다', () => {
  const {card} = mk();
  const a = card('orph-a', '작업자-9', {work: 'w1'}), b = card('orph-b', '작업자-9', {work: 'w2'});
  const entries = [send('orph-a', '작업자-9', '2026-10-19T05:00:00Z'), send('orph-b', '작업자-9', '2026-10-19T05:30:00Z')];
  const dash = buildCardCenter({cards: [a, b], entries, tree: [{roles: [{role: '작업자-9', life: {state: 'absent'}}]}], runtimeKnown: true, now: NOW}).cards;
  assert.equal(dash.find(c => c.id === 'orph-a').displayState, 'orphaned');
  assert.equal(bucketOf(dash, 'orph-a'), 'stale');
  const plan = planStaleNotices({cards: [a, b], entries, now: NOW, liveSessions: new Set()});
  assert.deepEqual(plan.flatMap(p => p.keys), ['repo/orph-a']);
  // 세션이 살아 있으면 둘 다 아니다
  assert.deepEqual(planStaleNotices({cards: [a, b], entries, now: NOW, liveSessions: new Set(['kadan-작업자-9'])}), []);
  // 생존을 모르면(관찰 실패) 보내지 않는다
  assert.deepEqual(planStaleNotices({cards: [a, b], entries, now: NOW}), []);
});

test('재안내(R2-F2): 보류 기록이 실패하면 held가 아니라 실패로 알리고 다음 훑기에 기록을 다시 쓰며, 불확실 시도는 다시 보내지 않는다', () => {
  const {cards, entries} = setup();
  const held = Object.assign(new Error('입력 중'), {delivery: 'not-sent', code: 'KADAN_HUMAN_ACTIVE'});
  const log = [], sent = [], pending = [];
  let failHeld = true;
  const record = e => { if (e.held && failHeld) throw new Error('잠금'); log.push(e); };
  const first = runStaleNotices({cards, entries, now: NOW, record, pendingHeld: pending, send: () => { throw held; }});
  assert.deepEqual(first, {sent: 0, unknownRecipient: 0, failed: 2, held: 0});
  assert.equal(pending.length, 2);
  failHeld = false;
  const second = runStaleNotices({cards, entries: [...entries, ...log], now: NOW, record, pendingHeld: pending, send: r => sent.push(r)});
  assert.equal(second.sent, 2);
  assert.equal(pending.length, 0);
  // 재시작(pendingHeld 소실): 시도만 남은 실행은 다시 보내지 않는다(한계)
  const attemptOnly = log.filter(e => e.attempt);
  assert.equal(planStaleNotices({cards, entries: [...entries, ...attemptOnly], now: NOW}).length, 0);
});
