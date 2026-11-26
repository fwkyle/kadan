import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDatabase, storageVersion, writeStorageMarker} from '../src/storage.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {CardStore} from '../src/card-store.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {buildCardCenter} from '../src/card-center.mjs';
import {executionBucket, executionHealth, workHealth} from '../src/dashboard-execution.mjs';
import {buildWorkStatus} from '../src/work-status-message.mjs';
import {workCommand} from '../src/work-command.mjs';
import {recentExecutionEvents} from '../src/dashboard-status.mjs';
import {dashboardData} from '../src/dashboard-api.mjs';
import {buildTree} from '../src/cli-tree.mjs';
import {createRequire} from 'node:module';
import {Readable} from 'node:stream';
import {createCenterHandler} from '../src/center-wall.mjs';

const {DatabaseSync} = createRequire(import.meta.url)('node:sqlite');

// Why: 업무를 마감해도 실행 카드의 저장 상태가 assigned로 남아, 대시보드가 끝난 작업자·감독을 경보했다(2026-11-26).
// 원장 시각은 실제 순서(배정 → 발령 → 완료 → 마감)의 현재 시각을 쓴다. 미래 시각을 쓰면 실행이 저장 상태를 늘 이겨
// "마감 뒤에도 실패로 판정" 같은 확인이 거짓으로 통과한다.
const BOSS = '시험감독';
const tick = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-close-cards-'));
  createDatabase(home); writeStorageMarker(home, 'sqlite');
  const store = new WorkStore(home), cards = new CardStore(home);
  const makeWork = key => store.create({key, title: '업무', goal: '결과', scope: '범위', acceptance: '조건',
    owner: BOSS, repoPath: home, board: '시험판'});
  const change = (action, fields = {}, key = 'repo/w') => store.change(key, action, fields,
    {revision: store.get(key).revision, by: BOSS, note: '확인'});
  const patch = (key, fields, note = '상태 설정') => cards.update(key, fields,
    {revision: cards.get(key).revision, by: BOSS, note});
  makeWork('repo/w');
  // 업무에 실행 하나를 더하고 원하는 저장 상태로 둔 뒤, 원장에 [역할, 결과|null] 순서로 발령·완료를 적는다.
  const execution = ({status = 'assigned', runs = [['A', 'ok']], work = 'repo/w'} = {}) => {
    const known = new Set(store.get(work).executions.map(x => x.key));
    change('execute', {title: '실행', body: '본문', phase: 'implementation', round: '1'}, work);
    const key = store.get(work).executions.find(x => !known.has(x.key)).key;
    if (status !== 'draft') {
      patch(key, {status, scope: '범위',
        ...(status === 'assigned' ? {board: '시험판', role: 'A', rallyId: 'r', rallyTitle: '묶음', rallyRound: '1', rallyStep: 'implementation'} : {}),
        ...(status === 'superseded' ? {replacedByText: '후속 업무가 이어받음'} : {})});
    }
    tick();
    dispatch(key, runs);
    tick();
    return key;
  };
  const dispatch = (key, runs) => {
    const id = key.split('/')[1];
    for (const [role, result] of runs) {
      appendLedger({kind: 'send', by: BOSS, role, taskId: id, executionKey: key, digest: `${role}-${id}`}, home);
      if (result) appendLedger({kind: 'done', by: role, role, taskId: id, executionKey: key, result}, home);
    }
  };
  const view = key => buildCardCenter({cards: cards.list(), entries: readLedger(home), tree: [], runtimeKnown: false})
    .cards.find(c => c.key === key);
  return {home, store, cards, change, patch, makeWork, execution, view};
}
const complete = f => f.change('complete', {result: '근거'});

test('complete: 원장 ok인 assigned 실행 카드를 done으로 닫고 닫은 카드를 알린다', () => {
  const f = fixture(), key = f.execution();
  const work = complete(f);
  const card = f.cards.get(key);
  assert.equal(work.status, 'done');
  assert.equal(card.status, 'done');
  assert.match(card.note, /업무 repo\/w 완료 마감.*원장 결과 ok \(A ok\)/);
  assert.equal(card.by, BOSS);
  assert.deepEqual(work.cardClose, {closed: [{key, from: 'assigned', result: 'ok'}], failed: []});
});

test('complete: 원장 failed는 done + 결과 메모. 경보 묶음은 사라지고 실패는 실행 기록·상태 이유·업무 상태 글에 남는다', () => {
  const f = fixture(), key = f.execution({runs: [['A', 'failed']]});
  const before = f.view(key);
  assert.equal(executionHealth(before).healthLabel, '실패 확인 필요');
  assert.equal(executionBucket(before), 'stuck');
  assert.match(buildWorkStatus(f.home, 'repo/w').content, /실패로 끝난 실행: 1건/);
  complete(f);
  const after = f.view(key);
  assert.equal(after.status, 'done');
  assert.equal(after.displayState, 'done');
  assert.equal(executionBucket(after), 'closed');
  assert.equal(workHealth(f.store.get('repo/w'), [{card: after, round: 1}]).healthLabel, '업무 완료');
  assert.deepEqual(after.runs.map(r => [r.role, r.state]), [['A', 'failed']]);
  assert.deepEqual(recentExecutionEvents([after]).filter(e => e.kind === 'failed').map(e => [e.card.key, e.role]), [[key, 'A']]);
  assert.match(after.statusReason, /원장 결과 failed \(A failed\)/);
  assert.match(buildWorkStatus(f.home, 'repo/w').content, /실패로 끝난 실행: 1건/);
});

test('사건 재현: 끈 작업자의 failed 실행은 마감 전엔 지도에 "꺼짐 · 인계 필요", 마감 뒤엔 지도에서 빠진다', async () => {
  const {buildMap, STATE_LABEL} = await import('../gui/src/strategy-map.ts');
  const f = fixture();
  const file = path.join(f.home, 'hierarchy.json');
  fs.writeFileSync(file, JSON.stringify({'시험상위': '@user', A: '시험상위'}));
  appendLedger({kind: 'hierarchy-loaded', path: file, by: 'watch'}, f.home);
  appendLedger({kind: 'start', role: 'A', session: 'kadan-A', panePid: '101', cmd: 'claude', by: '사람'}, f.home);
  const key = f.execution({runs: [['A', 'failed']]});
  appendLedger({kind: 'stop', role: 'A', session: 'kadan-A', by: '사람'}, f.home);
  const onMap = () => {
    const entries = readLedger(f.home), tree = buildTree(entries, {}, f.cards.listSummaries()), now = Date.now();
    const data = dashboardData({home: f.home, collectedAt: new Date(now).toISOString(), centerError: null, entries,
      ledgerLines: entries.length, center: buildCardCenter({cards: f.cards.list(), entries, tree, runtimeKnown: true, now}),
      registeredWorks: f.store.list(), resources: null, resourceError: '격리 시험', tree, decisions: []},
    new URL('http://local/api/dashboard/status'));
    const unit = buildMap({hierarchy: data.hierarchy, rows: data.rows, live: data.live, alerts: data.alerts,
      stopped: data.stopped, held: data.held}).bases.flatMap(b => b.units).find(u => u.role === 'A');
    return {rows: data.rows.map(r => r.key), label: unit ? STATE_LABEL[unit.state] : null};
  };
  assert.deepEqual(onMap(), {rows: [key], label: '꺼짐 · 인계 필요'});
  complete(f);
  assert.deepEqual(onMap(), {rows: [], label: null});
});

test('cancel도 같은 방식으로 닫는다', () => {
  const f = fixture(), ok = f.execution(), bad = f.execution({runs: [['B', 'failed']]});
  const work = f.change('cancel', {result: '취소 근거'});
  assert.equal(work.status, 'cancelled');
  assert.equal(f.cards.get(ok).status, 'done');
  assert.equal(f.cards.get(bad).status, 'done');
  assert.match(f.cards.get(bad).note, /업무 repo\/w 취소 마감.*원장 결과 failed \(B failed\)/);
  assert.deepEqual(work.cardClose.closed.map(c => [c.key, c.result]), [[ok, 'ok'], [bad, 'failed']]);
});

// 저장 상태 running·waiting은 없다(카드 상태 8종 중 끝 묶음이 아닌 5종이 마감 관문을 통과할 수 있다).
for (const status of ['draft', 'ready', 'assigned', 'hold', 'archived']) {
  for (const result of ['ok', 'failed']) {
    test(`열린 저장 상태 ${status} × 원장 ${result} → done`, () => {
      const f = fixture(), key = f.execution({status, runs: [['A', result]]});
      const work = complete(f);
      assert.equal(f.cards.get(key).status, 'done');
      assert.equal(f.view(key).displayState, 'done');
      assert.deepEqual(work.cardClose.closed, [{key, from: status, result}]);
    });
  }
}

test('한 카드에서 A 실패 뒤 B 성공이면 역할별 결과를 메모에 남긴다', () => {
  const f = fixture(), key = f.execution({status: 'ready', runs: [['A', 'failed'], ['B', 'ok']]});
  complete(f);
  assert.match(f.cards.get(key).note, /원장 결과 failed \(A failed · B ok\)/);
});

test('수동 카드 진행 보고(running) 뒤 완료된 실행도 닫고 활동 보고 칸이 판정을 바꾸지 않는다', () => {
  const f = fixture(), key = f.execution({runs: [['A', null]]});
  f.cards.update(key, {activity: 'running'}, {revision: f.cards.get(key).revision, by: 'A', noteKind: 'progress', note: '시작'});
  tick();
  appendLedger({kind: 'done', by: 'A', role: 'A', taskId: key.split('/')[1], executionKey: key, result: 'ok'}, f.home);
  tick();
  complete(f);
  assert.equal(f.cards.get(key).status, 'done');
  assert.equal(f.view(key).displayState, 'done');
});

for (const [name, runs] of [['미완료', [['A', null]]], ['failed 뒤 미완료 재발령', [['A', 'failed'], ['B', null]]]]) {
  test(`회귀: ${name} 실행이 있으면 거절하고 어떤 카드도 바꾸지 않는다`, () => {
    const f = fixture(), finished = f.execution(), open = f.execution({status: 'ready', runs});
    const revisions = [f.cards.get(finished).revision, f.cards.get(open).revision];
    assert.throws(() => complete(f), /끝나지 않은 실행/);
    assert.throws(() => f.change('cancel', {result: '근거'}), /끝나지 않은 실행/);
    assert.deepEqual([f.cards.get(finished).revision, f.cards.get(open).revision], revisions);
    assert.equal(f.store.get('repo/w').status, 'open');
  });
}

test('다른 업무의 카드와 업무에 연결하지 않은 카드는 바꾸지 않는다', () => {
  const f = fixture();
  f.makeWork('repo/other');
  const mine = f.execution(), theirs = f.execution({work: 'repo/other'});
  const loose = f.cards.create({repo: 'repo', id: 'loose', repoPath: f.home, title: '연결 없음', body: '본문', by: BOSS}).key;
  const revisions = [f.cards.get(theirs).revision, f.cards.get(loose).revision];
  const work = complete(f);
  assert.equal(f.cards.get(mine).status, 'done');
  assert.deepEqual([f.cards.get(theirs).revision, f.cards.get(loose).revision], revisions);
  assert.equal(f.cards.get(theirs).status, 'assigned');
  assert.deepEqual(work.cardClose.closed.map(c => c.key), [mine]);
});

test('이미 닫힌 카드는 그대로 두고, 다시 열어 다시 마감해도 카드 이력이 늘지 않는다', () => {
  const f = fixture();
  const closed = ['done', 'cancelled', 'superseded'].map(status => f.execution({status, runs: []}));
  const auto = f.execution();
  const before = closed.map(key => f.cards.get(key).revision);
  assert.deepEqual(complete(f).cardClose.closed.map(c => c.key), [auto]);
  assert.deepEqual(closed.map(key => f.cards.get(key).revision), before);
  const after = f.cards.get(auto).revision;
  assert.throws(() => complete(f), /종료한 업무/);
  f.change('reopen');
  assert.deepEqual(complete(f).cardClose, {closed: [], failed: []});
  assert.equal(f.cards.get(auto).revision, after);
  assert.deepEqual(closed.map(key => f.cards.get(key).revision), before);
});

test('마감이 아닌 업무 변경은 카드를 건드리지 않고 cardClose 칸도 없다', () => {
  const f = fixture(), key = f.execution();
  const revision = f.cards.get(key).revision;
  const work = f.change('update', {progress: '중간 보고'});
  assert.equal(Object.hasOwn(work, 'cardClose'), false);
  assert.equal(f.cards.get(key).revision, revision);
});

test('카드 하나를 닫지 못해도 업무 마감은 남고 실패한 카드와 이유를 알린다', t => {
  const f = fixture(), broken = f.execution(), fine = f.execution();
  const original = CardStore.prototype.update;
  t.mock.method(CardStore.prototype, 'update', function (key, ...rest) {
    if (key === broken) throw new Error('주입한 저장 실패');
    return original.call(this, key, ...rest);
  });
  const work = complete(f);
  assert.equal(work.status, 'done');
  assert.equal(f.store.get('repo/w').status, 'done');
  assert.equal(f.cards.get(broken).status, 'assigned');
  assert.equal(f.cards.get(fine).status, 'done');
  assert.deepEqual(work.cardClose.closed.map(c => c.key), [fine]);
  assert.deepEqual(work.cardClose.failed, [{key: broken, reason: '주입한 저장 실패'}]);
});

test('판정 뒤 카드가 바뀌면 덮어쓰지 않고, 같은 계획을 다시 적용해도 이력이 늘지 않는다', async t => {
  const {planCardClose, closeWorkCards} = await import('../src/work-card-close.mjs');
  const f = fixture(), moved = f.execution(), still = f.execution();
  const center = buildCardCenter({cards: f.cards.list(), entries: readLedger(f.home), tree: [], runtimeKnown: false});
  const plan = planCardClose(f.store.get('repo/w').executions, center.cards);
  const held = t.mock.method(CardStore.prototype, 'closeDone', () => ({closed: [], failed: []}));
  complete(f);
  held.mock.restore();
  const version = storageVersion(f.home);
  f.patch(moved, {}, '판정 뒤 감독 메모');
  const first = closeWorkCards(f.home, plan, {workKey: 'repo/w', action: 'complete', by: BOSS, version});
  assert.deepEqual(first.closed.map(c => c.key), [still]);
  assert.equal(first.failed.length, 1);
  assert.equal(first.failed[0].key, moved);
  assert.match(first.failed[0].reason, /카드가 변경됨/);
  assert.equal(f.cards.get(moved).status, 'assigned');
  const revision = f.cards.get(still).revision;
  assert.deepEqual(closeWorkCards(f.home, plan.filter(p => p.key === still),
    {workKey: 'repo/w', action: 'complete', by: BOSS, version}), {closed: [], failed: []});
  assert.equal(f.cards.get(still).revision, revision);
});

test('자동 닫기는 원장 사건(우편·경보)과 우편 파일을 만들지 않는다', () => {
  const f = fixture();
  f.execution(); f.execution({status: 'hold', runs: [['B', 'failed']]});
  const mail = () => { try { return fs.readdirSync(path.join(f.home, 'mail')).sort(); } catch { return []; } };
  const entries = readLedger(f.home).length, files = mail();
  assert.equal(complete(f).cardClose.closed.length, 2);
  assert.equal(readLedger(f.home).length, entries);
  assert.deepEqual(mail(), files);
});

function cli(t, f, action) {
  const lines = [];
  t.mock.method(process.stderr, 'write', chunk => { lines.push(String(chunk)); return true; });
  const result = workCommand([action, 'repo/w'], {revision: String(f.store.get('repo/w').revision), result: '근거', note: '확인'},
    {home: f.home, by: BOSS});
  t.mock.restoreAll();
  return {result, text: lines.join('')};
}

for (const action of ['complete', 'cancel']) {
  test(`CLI work ${action}: 닫은 카드 수·키를 stderr 한 줄과 JSON에 보인다`, t => {
    const f = fixture(), ok = f.execution(), bad = f.execution({runs: [['B', 'failed']]});
    const {result, text} = cli(t, f, action);
    assert.equal(result.cardClose.closed.length, 2);
    assert.ok(text.includes(`실행 카드 2장 닫음: ${ok}(ok), ${bad}(failed)`), text);
  });
}

test('CLI: 닫지 못한 카드는 이유와 직접 닫는 명령을 보인다', t => {
  const f = fixture(), broken = f.execution();
  t.mock.method(CardStore.prototype, 'update', () => { throw new Error('주입한 저장 실패'); });
  const {result, text} = cli(t, f, 'complete');
  assert.equal(result.status, 'done');
  assert.ok(text.includes(`실행 카드 닫기 실패 1장(업무 마감은 기록됨): ${broken} — 주입한 저장 실패`), text);
  assert.ok(text.includes('kadan card update <카드키> --revision <최신> --status done'), text);
});

test('CLI: 닫은 카드가 많으면 앞 10장만 적고 나머지 수를 센다', t => {
  const f = fixture();
  for (let i = 0; i < 12; i++) f.execution();
  const {result, text} = cli(t, f, 'complete');
  assert.equal(result.cardClose.closed.length, 12);
  assert.match(text, /실행 카드 12장 닫음: .* 외 2장/);
});

test('업무 상태 글의 실패 수: 손으로 done 처리한 실패는 세고, 취소로 정리한 실패는 예전처럼 세지 않는다', () => {
  const f = fixture();
  const handClosed = f.execution({runs: [['A', 'failed']]}), cancelled = f.execution({runs: [['B', 'failed']]});
  f.patch(handClosed, {status: 'done'}, '손 정리');
  f.patch(cancelled, {status: 'cancelled'}, '취소');
  const content = buildWorkStatus(f.home, 'repo/w').content;
  assert.match(content, /실패로 끝난 실행: 1건/);
  assert.match(content, /열린 실행: 없음/);
});

// 원장 전체 읽기 한 번은 작업 영역(tasks/events.jsonl)을 처음부터 한 번 읽는다. 실제 SQL을 세서 함수 이름에 기대지 않는다.
function countFullLedgerReads(t) {
  const count = {reads: 0}, prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    const statement = prepare.call(this, sql);
    if (/FROM events WHERE stream=\? ORDER BY seq/.test(sql)) {
      const iterate = statement.iterate.bind(statement);
      statement.iterate = (...args) => { if (args.at(-1) === 'tasks/events.jsonl') count.reads++; return iterate(...args); };
    }
    return statement;
  });
  return count;
}
// 닫기 단계의 두 자리에 원장 줄을 끼워 넣는다: closeDone을 부르기 직전(마감 저장 뒤), 새 줄을 읽은 직후(다음 잠금 전).
function beforeClose(t, inject) {
  const original = CardStore.prototype.closeDone;
  t.mock.method(CardStore.prototype, 'closeDone', function (...args) { inject(); return original.apply(this, args); });
}
function afterDelta(t, inject = () => {}) {
  const original = CardStore.prototype.mentionedAfter, count = {reads: 0};
  t.mock.method(CardStore.prototype, 'mentionedAfter', function (...args) {
    const result = original.apply(this, args);
    inject(++count.reads);
    return result;
  });
  return count;
}
const unrelated = home => appendLedger({kind: 'alert', by: 'watch', alertKind: '무관한 사건', role: 'Z'}, home);

for (const actor of [BOSS, '사람']) {
  test(`원장 전체 읽기는 닫는 카드 수와 상관없이 한 번이고, 사이에 새 줄이 없으면 새 줄 읽기도 없다 (${actor})`, t => {
    const totals = [0, 1, 12].map(cards => {
      const f = fixture();
      for (let i = 0; i < cards; i++) f.execution({runs: [['A', i % 2 ? 'failed' : 'ok']]});
      const full = countFullLedgerReads(t), delta = afterDelta(t);
      const summaries = t.mock.method(CardStore.prototype, 'listSummaries');
      const work = f.store.change('repo/w', 'complete', {result: '근거'},
        {revision: f.store.get('repo/w').revision, by: actor, note: '확인'});
      const out = [cards, work.cardClose.closed.length, full.reads, delta.reads, summaries.mock.callCount()];
      t.mock.restoreAll();
      return out;
    });
    assert.deepEqual(totals, [[0, 0, 1, 0, 0], [1, 1, 1, 0, 0], [12, 12, 1, 0, 0]]);
  });
}

const RACES = {
  '새 발령': (f, key) => appendLedger({kind: 'send', by: BOSS, role: 'B', taskId: key.split('/')[1], executionKey: key, digest: 'new'}, f.home),
  '짧은 ID만 적힌 새 발령': (f, key) => appendLedger({kind: 'send', by: BOSS, role: 'B', taskId: key.split('/')[1], digest: 'short'}, f.home),
  '새 완료 기록': (f, key) => appendLedger({kind: 'done', by: 'B', role: 'B', taskId: key.split('/')[1], executionKey: key, result: 'failed'}, f.home),
  '새 인계 기록': (f, key) => appendLedger({kind: 'handover', phase: 'transferred', handoverId: 'h-1', from: 'A', to: 'B', taskIds: [key], by: BOSS}, f.home),
};
for (const [name, inject] of Object.entries(RACES)) {
  test(`경합: 마감 판정 뒤 ${name}이 생긴 카드는 닫지 않고 나머지만 닫는다`, t => {
    const f = fixture(), first = f.execution(), raced = f.execution(), last = f.execution();
    const revision = f.cards.get(raced).revision;
    const full = countFullLedgerReads(t);
    beforeClose(t, () => inject(f, raced));
    const work = complete(f);
    assert.equal(full.reads, 1);
    t.mock.restoreAll();
    assert.equal(work.status, 'done');
    assert.deepEqual(work.cardClose.closed.map(c => c.key), [first, last]);
    assert.deepEqual(work.cardClose.failed.map(c => c.key), [raced]);
    assert.match(work.cardClose.failed[0].reason, /새 원장 기록/);
    assert.equal(f.cards.get(raced).status, 'assigned');
    assert.equal(f.cards.get(raced).revision, revision);
  });
}

test('경합: 새 발령을 닫지 않으면 대시보드 판정이 그 발령을 완료로 가리지 않는다', t => {
  const f = fixture(), raced = f.execution();
  beforeClose(t, () => { tick(); RACES['새 발령'](f, raced); });
  complete(f);
  assert.equal(f.view(raced).displayState, 'unconfirmed');
});

test('경합: 새 줄을 확인한 직후, 잠금에 들어가기 전에 붙은 발령도 잡는다(잠금 안 버전 비교)', t => {
  const f = fixture(), first = f.execution(), raced = f.execution();
  beforeClose(t, () => unrelated(f.home));
  const delta = afterDelta(t, n => { if (n === 1) RACES['새 발령'](f, raced); });
  const work = complete(f);
  assert.equal(delta.reads, 2);
  assert.deepEqual(work.cardClose.closed.map(c => c.key), [first]);
  assert.deepEqual(work.cardClose.failed.map(c => c.key), [raced]);
  assert.equal(f.cards.get(raced).status, 'assigned');
});

test('상관없는 원장 줄이 끼어들면 새 줄만 한 번 읽고 모두 닫는다', t => {
  const f = fixture(), keys = [f.execution(), f.execution(), f.execution()];
  const full = countFullLedgerReads(t), delta = afterDelta(t);
  beforeClose(t, () => unrelated(f.home));
  const work = complete(f);
  assert.deepEqual([full.reads, delta.reads], [1, 1]);
  assert.deepEqual(work.cardClose.closed.map(c => c.key), keys);
});

test('원장에 새 줄이 계속 붙으면 정한 횟수만 다시 보고 닫지 않은 것으로 알린다', t => {
  const f = fixture(), key = f.execution();
  beforeClose(t, () => unrelated(f.home));
  const delta = afterDelta(t, () => unrelated(f.home));
  const work = complete(f);
  assert.equal(delta.reads, 20);
  assert.deepEqual(work.cardClose.closed, []);
  assert.match(work.cardClose.failed[0].reason, /계속 붙어/);
  assert.equal(f.cards.get(key).status, 'assigned');
});

test('마감과 닫기 사이에 손으로 고친 카드는 덮지 않고, 손으로 닫은 카드는 조용히 넘어간다', t => {
  const f = fixture(), edited = f.execution(), handClosed = f.execution(), fine = f.execution();
  const original = CardStore.prototype.closeDone;
  let handRevision;
  t.mock.method(CardStore.prototype, 'closeDone', function (...args) {
    f.patch(edited, {}, '사이에 남긴 메모');
    f.patch(handClosed, {status: 'done'}, '손으로 닫음');
    handRevision = f.cards.get(handClosed).revision;
    return original.apply(this, args);
  });
  const work = complete(f);
  assert.deepEqual(work.cardClose.closed.map(c => c.key), [fine]);
  assert.deepEqual(work.cardClose.failed.map(c => c.key), [edited]);
  assert.match(work.cardClose.failed[0].reason, /카드가 변경됨/);
  assert.equal(f.cards.get(handClosed).revision, handRevision);
});

test('판정 시점의 원장 버전이 없으면 확인할 수 없어 아무것도 닫지 않는다', () => {
  const f = fixture(), key = f.execution();
  const revision = f.cards.get(key).revision;
  const out = f.cards.closeDone([{key, revision, role: 'A', note: '버전 없음'}], {by: BOSS});
  assert.deepEqual(out.closed, []);
  assert.match(out.failed[0].reason, /원장 버전이 없어/);
  assert.equal(f.cards.get(key).revision, revision);
});

test('일괄 닫기가 쓰는 카드 기록은 card update로 닫은 기록과 같다(인계·계획 판·보류·차례 칸 포함)', () => {
  const build = () => {
    const f = fixture();
    const handed = f.execution();
    appendLedger({kind: 'handover', phase: 'transferred', handoverId: 'h-2', from: 'A', to: 'B', taskIds: [handed], by: BOSS}, f.home);
    const planned = f.execution({status: 'draft'});
    appendLedger({kind: 'plan', board: '계획에만 있는 판', taskId: planned.split('/')[1], executionKey: planned, by: BOSS}, f.home);
    const held = f.execution({status: 'hold', runs: []});
    f.patch(held, {nextAction: '재개 조건', resolutionOwner: 'A'}, '보류 메모');
    tick();
    appendLedger({kind: 'send', by: BOSS, role: 'A', taskId: held.split('/')[1], executionKey: held, digest: 'held'}, f.home);
    appendLedger({kind: 'done', by: 'A', role: 'A', taskId: held.split('/')[1], executionKey: held, result: 'failed'}, f.home);
    const turned = f.execution();
    f.patch(turned, {turnOwner: 'A'}, '차례 지정');
    tick();
    return {f, keys: [handed, planned, held, turned]};
  };
  const comparable = (f, key) => {
    const {history, body, path: bodyPath, resultPath, evidenceDir, key: own, id, at, repoPath, ...rest} = f.cards.get(key);
    return rest;
  };
  const batch = build(), manual = build();
  assert.equal(complete(batch.f).cardClose.closed.length, 4);
  batch.keys.forEach((key, i) => {
    const {note, by} = batch.f.cards.get(key);
    const twin = manual.keys[i];
    manual.f.cards.update(twin, {status: 'done'}, {revision: manual.f.cards.get(twin).revision, by, note});
    assert.deepEqual(comparable(batch.f, key), comparable(manual.f, twin), `${i}번째 카드`);
  });
  assert.equal(batch.f.cards.get(batch.keys[0]).role, 'B');
  assert.equal(batch.f.cards.get(batch.keys[1]).board, null);
});

// 검수 재현(exec-ea47f41a, relinked-after-plan): 마감 저장과 닫기 사이에 카드가 이 업무를 떠나면 닫지 않는다.
// 업무 기록만 바뀌므로 카드 revision과 원장은 그대로다.
const reopen = (f, key = 'repo/w') => f.change('reopen', {}, key);
const MOVES = {
  '다시 열고 다른 열린 업무로 옮긴': {reason: /다시 열려/, move: (f, key) => {
    reopen(f);
    f.change('unlink', {execution: key});
    f.change('link', {execution: key, phase: 'implementation', round: '1'}, 'repo/other');
  }},
  '업무를 다시 연': {reason: /다시 열려/, move: f => reopen(f)},
  '옮긴 뒤 원래 업무를 다시 마감한': {reason: /연결이 빠/, move: (f, key) => {
    reopen(f);
    f.change('unlink', {execution: key});
    f.change('link', {execution: key, phase: 'implementation', round: '1'}, 'repo/other');
    complete(f);
  }},
};
for (const [name, {reason, move}] of Object.entries(MOVES)) {
  test(`경합: 마감 저장 뒤 ${name} 카드는 이전 업무의 마감으로 닫지 않는다`, t => {
    const f = fixture();
    f.makeWork('repo/other');
    const moved = f.execution();
    const revision = f.cards.get(moved).revision, ledger = readLedger(f.home);
    const original = CardStore.prototype.closeDone;
    let injected = false;
    t.mock.method(CardStore.prototype, 'closeDone', function (...args) {
      if (!injected) { injected = true; move(f, moved); }
      return original.apply(this, args);
    });
    const work = complete(f);
    assert.deepEqual(readLedger(f.home), ledger);
    assert.deepEqual(work.cardClose.closed, []);
    assert.deepEqual(work.cardClose.failed.map(c => c.key), [moved]);
    assert.match(work.cardClose.failed[0].reason, reason);
    assert.equal(f.cards.get(moved).status, 'assigned');
    assert.equal(f.cards.get(moved).revision, revision);
  });
}

test('경합: 카드를 닫는 도중에 업무가 다시 열리면 남은 카드는 닫지 않는다(카드마다 쓰기 직전에 확인)', t => {
  const f = fixture(), keys = [f.execution(), f.execution(), f.execution()];
  const original = CardStore.prototype.locked;
  let closing = false, locks = 0;
  const closeDone = CardStore.prototype.closeDone;
  t.mock.method(CardStore.prototype, 'closeDone', function (...args) { closing = true; return closeDone.apply(this, args); });
  t.mock.method(CardStore.prototype, 'locked', function (fn) {
    // 첫 카드의 잠금(그 안의 update 잠금 포함)이 끝난 뒤, 둘째 카드의 잠금에 들어가기 직전에 업무를 다시 연다.
    if (closing && ++locks === 3) { closing = false; reopen(f); }
    return original.call(this, fn);
  });
  const work = complete(f);
  assert.deepEqual(work.cardClose.closed.map(c => c.key), [keys[0]]);
  assert.deepEqual(work.cardClose.failed.map(c => c.key), [keys[1], keys[2]]);
  assert.deepEqual(keys.map(key => f.cards.get(key).status), ['done', 'assigned', 'assigned']);
});

// 검수 재현(exec-ea47f41a, dashboard-partial): 대시보드의 실제 POST 처리 함수에 마감 요청을 넣는다.
async function post(f, action, {json, key = 'repo/w'} = {}) {
  const handler = createCenterHandler(f.home);
  const request = Readable.from([Buffer.from(new URLSearchParams({token: handler.token, key: `work:${key}`,
    revision: String(f.store.get(key).revision), note: '마감',
    ...(action === 'update' ? {progress: '보고'} : {result: '확인'})}).toString())]);
  request.method = 'POST';
  request.headers = {...(json ? {accept: 'application/json'} : {}), 'content-type': 'application/x-www-form-urlencoded'};
  const out = {};
  const response = {writeHead(status, headers) { out.status = status; out.headers = headers; },
    end(body) { try { out.body = JSON.parse(body); } catch { out.body = body; } }};
  assert.equal(await handler.handle(request, response, new URL(`http://127.0.0.1/works/${action}`)), true);
  return out;
}
// 닫기 직전에 한 카드에 새 발령을 넣어 부분 실패를 만든다.
function partialFailure(t) {
  const f = fixture(), raced = f.execution(), fine = f.execution({runs: [['A', 'failed']]});
  beforeClose(t, () => RACES['새 발령'](f, raced));
  return {f, raced, fine};
}
const failedParam = location => new URL(location, 'http://127.0.0.1').searchParams.get('closeFailed');

for (const action of ['complete', 'cancel']) {
  test(`대시보드 ${action} JSON 응답: 업무는 마감된 채 닫은 수와 닫지 못한 카드 키·이유를 싣는다`, async t => {
    const {f, raced, fine} = partialFailure(t);
    const out = await post(f, action, {json: true});
    assert.equal(out.status, 200);
    assert.equal(out.body.result.key, 'work:repo/w');
    assert.equal(out.body.result.cardClose.closed, 1);
    assert.deepEqual(out.body.result.cardClose.failed.map(c => c.key), [raced]);
    assert.match(out.body.result.cardClose.failed[0].reason, /새 원장 기록/);
    assert.equal(f.store.get('repo/w').status, action === 'complete' ? 'done' : 'cancelled');
    assert.equal(f.cards.get(raced).status, 'assigned');
    assert.equal(f.cards.get(fine).status, 'done');
  });

  test(`대시보드 ${action} 폼 응답: 이동 주소에 닫지 못한 카드 키와 이유 구분을 싣는다`, async t => {
    const {f, raced} = partialFailure(t);
    const out = await post(f, action);
    assert.equal(out.status, 303);
    assert.equal(failedParam(out.headers.location), `${raced}:record`);
    assert.match(out.headers.location, /^\/\?collection=work&card=work%3Arepo%2Fw&detail=1&/);
    assert.match(out.headers.location, /#detail$/);
  });
}

test('대시보드: 닫기 실패가 없으면 실패 목록은 비고 이동 주소는 예전과 같다. 마감이 아닌 저장 응답은 그대로다', async () => {
  const f = fixture();
  f.execution();
  const updated = await post(f, 'update', {json: true});
  assert.deepEqual(Object.keys(updated.body.result).sort(), ['key', 'revision']);
  const done = await post(f, 'complete', {json: true});
  assert.deepEqual(done.body.result.cardClose, {closed: 1, failed: []});
  assert.equal(done.body.location, '/?collection=work&card=work%3Arepo%2Fw&detail=1#detail');
});
