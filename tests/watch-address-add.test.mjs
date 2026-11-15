import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {fixture, card, start, question, at, fullEquivalent, replayIs} from './helpers/watch-address-add.mjs';

for (const [label, nextCards] of [
  ['하나 추가', [card(), card('two')]],
  ['여러 개 추가', [card(), card('two'), card('three')]],
  ['같은 집합 순서 변경', [card('two'), card()]],
]) {
  test(`${label}: revision과 과거 해석을 보존하고 새 카드 발령·완료만 이어 붙인다`, async () => {
    const initial = label === '같은 집합 순서 변경' ? [card(), card('two')] : [card()];
    const s = fixture(undefined, initial), before = s.first;
    const snapshot = structuredClone(before.projected);
    s.cards = nextCards;
    const added = s.read();
    replayIs(s, 1, 0);
    assert.equal(added.projected[1], before.projected[1], 'RAM도 과거 주소 해석 객체를 재사용한다');
    for (const table of Object.keys(before.saved.meta)) {
      assert.equal(added.saved.meta[table].revision, before.saved.meta[table].revision, table);
    }
    assert.deepEqual(added.saved.rows, before.saved.rows);
    assert.equal((await s.sweep()).status, 'match');
    s.metrics.clear();
    s.append({...question, mailId: 'fixture-new', taskId: 'two', executionKey: 'fixture/two'});
    s.append({kind: 'done', role: start.role, taskId: 'two', executionKey: 'fixture/two', result: 'ok'});
    const tail = s.read();replayIs(s, 0, 0);
    assert.equal(tail.projected[1], before.projected[1]);
    assert.deepEqual(before.projected, snapshot, '이미 내준 snapshot은 바뀌지 않는다');
    fullEquivalent(s, tail);
    assert.equal((await s.sweep()).status, 'match');
  });
}

const cases = [
  ['과거 미등록 짧은 ID', [start, {...question, taskId: 'two', executionKey: undefined}],
    [card(), card('two')]],
  ['과거 미등록 정식 주소', [start, {...question, taskId: 'fixture/two', executionKey: undefined}],
    [card(), card('two')]],
  ['짧은 ID 모호해짐', [start, {...question, executionKey: undefined}], [card(), card('one', 'other')]],
  ['정식 주소의 짧은 표현 변경', [start, {...question, taskId: 'fixture/one'}],
    [card(), card('one', 'other')]],
  ['카드 제거', [start, question], []],
  ['기존 key 변경', [start, question], [card('one', 'other')]],
  ['기존 id 변경', [start, question], [{key: 'fixture/one', id: 'different'}]],
  ['같은 길이 주소 교체', [start, question], [card('two')]],
  ['중복 key', [start, question], [card(), card(), card('two')]],
  ['규격 밖 주소', [start, question], [card(), {key: 'two', id: 'two'}]],
  ['인계 taskIds', [start, {kind: 'handover', phase: 'transferred', from: start.role,
    to: 'fixture-next', handoverId: 'fixture-transfer', taskIds: ['fixture/two'], t: at}],
    [card(), card('two')]],
  ['답장 주소', [start, question, {kind: 'send', mailId: 'fixture-answer', replyTo: question.mailId,
    replyFinal: true, by: start.role, role: question.by, taskId: 'two', t: at}], [card(), card('two')]],
  ['별칭 뒤 중복 완료', [start, {kind: 'done', role: start.role, taskId: 'two', result: 'failed', t: at},
    {kind: 'done', role: start.role, taskId: 'fixture/two', result: 'ok', t: at}], [card(), card('two')]],
];
for (const [label, events, nextCards] of cases) {
  test(`${label}: 전체 재생과 메모리 재해석을 함께 실행한다`, async () => {
    const s = fixture(events);
    s.cards = nextCards;
    const next = s.read();replayIs(s, 0, 1);
    assert.equal(s.metrics.snapshot().replay.projection.address, 1);
    assert.notEqual(next.saved.meta.watch_mail_projection.revision,
      s.first.saved.meta.watch_mail_projection.revision);
    fullEquivalent(s, next);
    assert.equal((await s.sweep()).status, 'match');
  });
}

test('카드 목록보다 plan/send를 먼저 읽으면 과거 prefix 참조로 전체 재생한다', () => {
  const s = fixture();
  s.append({kind: 'plan', role: start.role, taskId: 'two'});
  s.append({...question, taskId: 'two', executionKey: 'fixture/two', mailId: 'fixture-race'});
  s.read();s.metrics.clear();
  s.cards = [...s.cards, card('two')];
  const next = s.read();replayIs(s, 0, 1);fullEquivalent(s, next);
});

test('RAM 해석을 건너뛴 여러 수집도 같은 SQL revision이면 과거 객체를 유지한다', () => {
  const s = fixture(), old = s.first.projected[1];
  s.cards = [...s.cards, card('two')];s.reader.readEntries();
  s.cards = [...s.cards, card('three')];s.reader.readEntries();
  assert.equal(s.read().projected[1], old);
  replayIs(s, 2, 0);
});

test('주소 배열을 제자리에서 바꾸어도 이전 snapshot의 해석은 바뀌지 않는다', () => {
  const s = fixture(), old = structuredClone(s.first.projected);
  s.cards[0].key = 'other/one';
  const changed = s.read();replayIs(s, 0, 1);
  assert.deepEqual(s.first.projected, old);
  assert.equal(changed.projected.length, 1);
  fullEquivalent(s, changed);
});

test('고정 씨앗의 여러 카드 추가 순서와 작은 원장도 매번 전체 재생과 같다', async () => {
  let seed = 731;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;return seed % n; };
  for (let batch = 0; batch < 6; batch++) {
    const events = [start];
    for (let index = 0; index < 12; index++) {
      const id = `item-${random(8)}`;
      events.push(random(2) ? {...question, taskId: id, executionKey: undefined,
        mailId: `fixture-${batch}-${index}`} : {kind: 'done', role: start.role,
        taskId: random(2) ? id : `fixture/${id}`, result: 'ok', t: at});
    }
    const s = fixture(events, []), ids = Array.from({length: 8}, (_, n) => `item-${n}`);
    while (ids.length) {
      s.cards = [...s.cards, card(ids.splice(random(ids.length), 1)[0])];
      const next = s.read();fullEquivalent(s, next);
    }
    assert.equal((await s.sweep()).status, 'match');
  }
});

test('건너뛰기 판정을 강제로 참으로 만들면 독립 정기 대조가 잘못된 상태를 잡는다', async () => {
  const s = fixture([start, {...question, taskId: 'two', executionKey: 'fixture/two'}]);
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function(sql) {
    const statement = prepare.call(this, sql);
    if (sql.startsWith('SELECT 1 FROM short_refs WHERE')) return {get: () => undefined};
    return statement;
  };
  try {
    s.cards = [...s.cards, card('two')];
    // 이 지점만 전체 기대값 비교를 생략해 잘못된 SQL/RAM 상태를 그대로 대조에 넘긴다.
    const raw = s.reader.readEntries();s.reader.project(raw, s.cards);
  } finally { DatabaseSync.prototype.prepare = prepare; }
  replayIs(s, 1, 0);
  const found = await s.sweep();
  assert.equal(found.status, 'diff');
  for (const key of ['projection-state', 'mail-state', 'role-state', 'work-state']) {
    assert.ok(found.diffs.some(diff => diff.key === key), key);
  }
});
