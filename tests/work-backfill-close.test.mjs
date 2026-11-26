import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {appendStream, createDatabase, storageVersion, transaction, writeStorageMarker} from '../src/storage.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {CardStore} from '../src/card-store.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {workCommand} from '../src/work-command.mjs';
import {backfillCloseCards} from '../src/work-card-backfill.mjs';

const {DatabaseSync} = createRequire(import.meta.url)('node:sqlite');
const root = fileURLToPath(new URL('..', import.meta.url));

// Why: #495 전에 마감한 업무의 실행 카드는 assigned 등으로 남아 있다. 소급 닫기는 되돌릴 수 없는 원장에 쓰므로,
// 닫아야 할 카드만 닫고 나머지는 한 줄도 쓰지 않는지를 확인한다.
const BOSS = '시험감독';
const tick = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-backfill-'));
  createDatabase(home); writeStorageMarker(home, 'sqlite');
  const store = new WorkStore(home), cards = new CardStore(home);
  const makeWork = key => store.create({key, title: '업무', goal: '결과', scope: '범위', acceptance: '조건',
    owner: BOSS, repoPath: home, board: '시험판'});
  const change = (action, fields = {}, key = 'repo/w') => store.change(key, action, fields,
    {revision: store.get(key).revision, by: BOSS, note: '확인'});
  const patch = (key, fields, note = '상태 설정') => cards.update(key, fields,
    {revision: cards.get(key).revision, by: BOSS, note});
  const dispatch = (key, runs) => {
    const id = key.split('/')[1];
    for (const [role, result] of runs) {
      appendLedger({kind: 'send', by: BOSS, role, taskId: id, executionKey: key, digest: `${role}-${id}`}, home);
      if (result) appendLedger({kind: 'done', by: role, role, taskId: id, executionKey: key, result}, home);
    }
  };
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
  // #495 전의 마감: 업무 기록만 닫히고 실행 카드는 그대로 남는다.
  const closeLikeBefore = (t, key = 'repo/w', action = 'complete') => {
    const held = t.mock.method(CardStore.prototype, 'closeDone', () => ({closed: [], failed: []}));
    change(action, {result: '근거'}, key);
    held.mock.restore();
  };
  // 지금 CLI·화면으로는 만들 수 없는 옛 기록(두 업무 연결·없는 카드)을 업무 이력에 직접 덧붙인다.
  const forceLink = (workKey, key) => {
    const {history, ...latest} = store.get(workKey);
    appendStream(home, `works/${workKey}/events.jsonl`, {...latest, revision: latest.revision + 1,
      executions: [...latest.executions, {key, phase: 'implementation', round: 1}], note: '옛 기록'});
  };
  const events = () => transaction(home, db => db.prepare('SELECT count(*) AS n FROM events').get().n, {readOnly: true});
  const state = () => ({events: events(), version: storageVersion(home)});
  const apply = () => backfillCloseCards(home, {apply: true, by: BOSS});
  const preview = () => backfillCloseCards(home);
  makeWork('repo/w');
  return {home, store, cards, change, patch, makeWork, execution, dispatch, closeLikeBefore, forceLink, state, apply, preview};
}
const keysOf = items => items.map(x => x.key).sort();
const sorted = keys => [...keys].sort();
const reasons = result => Object.fromEntries(result.skipped.cards.map(s => [s.key, s.reason]));

test('미리보기: 장수·저장소·원래 상태·원장 결과를 보이고 아무것도 쓰지 않는다', t => {
  const f = fixture();
  f.makeWork('other/w');
  const a = f.execution(), b = f.execution({status: 'hold', runs: [['B', 'failed']]});
  const c = f.execution({status: 'archived', work: 'other/w'});
  const waiting = f.execution({runs: [['A', null]]});
  // 마감 관문을 지나려면 업무가 닫힐 때는 끝나 있어야 하므로, 닫은 뒤에 새 발령이 생긴 모양으로 만든다.
  f.dispatch(waiting, [['A', 'ok']]);
  f.closeLikeBefore(t);
  f.closeLikeBefore(t, 'other/w');
  tick();
  f.dispatch(waiting, [['C', null]]);
  const before = f.state();
  const result = f.preview();
  assert.deepEqual(f.state(), before);
  assert.equal(result.apply, false);
  assert.equal(result.total, 3);
  assert.deepEqual(keysOf(result.cards), sorted([a, b, c]));
  assert.deepEqual(result.byRepo, {repo: 2, other: 1});
  assert.deepEqual(result.byFrom, {assigned: 1, hold: 1, archived: 1});
  assert.deepEqual(result.byResult, {ok: 2, failed: 1});
  assert.deepEqual(reasons(result), {[waiting]: 'unfinished'});
  assert.deepEqual(result.skipped.byReason.unfinished.sample, [waiting]);
  assert.deepEqual(result.skipped.byReason.unfinished.byFrom, {assigned: 1});
  assert.deepEqual(result.counts, {closedWorks: 2, linkedExecutions: 4, alreadyEnded: 0, multiLinked: 0, multiLinkedWithOpen: 0});
  assert.deepEqual(result.assigned, {total: 2, toClose: 1, skipped: 1});
  assert.equal(Object.hasOwn(result, 'closed'), false);
});

for (const status of ['draft', 'ready', 'assigned', 'hold', 'archived']) {
  for (const outcome of ['ok', 'failed']) {
    test(`적용: 저장 상태 ${status} × 원장 ${outcome} → done, 메모에 소급과 원장 결과`, t => {
      const f = fixture(), key = f.execution({status, runs: [['A', outcome]]});
      f.closeLikeBefore(t);
      const result = f.apply();
      assert.deepEqual(result.closed, [{key, from: status, result: outcome}]);
      assert.deepEqual(result.failed, []);
      const card = f.cards.get(key);
      assert.equal(card.status, 'done');
      assert.equal(card.by, BOSS);
      assert.equal(card.note, `업무 repo/w 완료 마감 소급 정리로 닫음 · 원장 결과 ${outcome} (A ${outcome})`);
    });
  }
}

test('취소한 업무의 카드는 취소 마감 소급으로 적는다', t => {
  const f = fixture(), key = f.execution();
  f.closeLikeBefore(t, 'repo/w', 'cancel');
  assert.equal(f.apply().closed.length, 1);
  assert.match(f.cards.get(key).note, /^업무 repo\/w 취소 마감 소급 정리로 닫음 · 원장 결과 ok \(A ok\)$/);
});

test('두 번째 적용은 아무 줄도 쓰지 않는다. 원장 사건과 우편 파일도 만들지 않는다', t => {
  const f = fixture();
  f.execution(); f.execution({status: 'ready', runs: [['B', 'failed']]});
  f.closeLikeBefore(t);
  const mail = () => { try { return fs.readdirSync(path.join(f.home, 'mail')).sort(); } catch { return []; } };
  const entries = readLedger(f.home).length, files = mail(), workRevision = f.store.get('repo/w').revision;
  const before = f.state();
  assert.equal(f.apply().closed.length, 2);
  // 쓴 줄은 닫은 카드마다 카드 이력 한 줄뿐이다.
  assert.equal(f.state().events, before.events + 2);
  assert.equal(readLedger(f.home).length, entries);
  assert.equal(f.store.get('repo/w').revision, workRevision);
  assert.deepEqual(mail(), files);
  const after = f.state();
  const again = f.apply();
  assert.deepEqual([again.total, again.closed, again.failed], [0, [], []]);
  assert.deepEqual(f.state(), after);
});

test('열린·보류 업무의 카드, 업무 없는 카드, 이미 끝난 카드는 대상이 아니고 한 줄도 쓰지 않는다', t => {
  const f = fixture();
  f.makeWork('repo/open'); f.makeWork('repo/held');
  const open = f.execution({work: 'repo/open'}), held = f.execution({work: 'repo/held'});
  f.change('update', {status: 'hold'}, 'repo/held');
  const loose = f.cards.create({repo: 'repo', id: 'loose', repoPath: f.home, title: '연결 없음', body: '본문', by: BOSS}).key;
  f.patch(loose, {status: 'assigned', scope: '범위', board: '시험판', role: 'A', rallyId: 'r', rallyTitle: '묶음', rallyRound: '1', rallyStep: 'implementation'});
  tick();
  f.dispatch(loose, [['A', 'ok']]);
  const ended = ['done', 'cancelled', 'superseded'].map(status => f.execution({status, runs: []}));
  const target = f.execution();
  f.closeLikeBefore(t);
  const untouched = [open, held, loose, ...ended];
  const revisions = untouched.map(key => f.cards.get(key).revision);
  const result = f.apply();
  assert.deepEqual(result.closed.map(c => c.key), [target]);
  assert.equal(result.skipped.total, 0);
  assert.equal(result.counts.alreadyEnded, 3);
  assert.deepEqual(untouched.map(key => f.cards.get(key).revision), revisions);
  assert.deepEqual(result.assigned, {total: 4, toClose: 1, openWorkOnly: 2, noWork: 1});
});

// 마감 관문을 못 넘는 카드. 업무는 관문을 지나 닫힌 뒤에 이런 모양이 됐거나, 관문이 생기기 전에 닫힌 것이다.
const UNFINISHED = {
  '마감 뒤 새로 발령해 미완료인': (f, key) => f.dispatch(key, [['B', null]]),
  'failed 뒤 다시 발령해 미완료인': (f, key) => f.dispatch(key, [['A', 'failed'], ['B', null]]),
  '완료 뒤 상태를 다시 바꾼': (f, key) => f.patch(key, {status: 'hold'}, '다시 멈춤'),
};
for (const [name, mutate] of Object.entries(UNFINISHED)) {
  test(`관문: ${name} 카드는 닫지 않고 끝나지 않은 실행으로 센다`, t => {
    const f = fixture(), blocked = f.execution(), fine = f.execution();
    f.closeLikeBefore(t);
    tick();
    mutate(f, blocked);
    const revision = f.cards.get(blocked).revision;
    const result = f.apply();
    assert.deepEqual(result.closed.map(c => c.key), [fine]);
    assert.deepEqual(reasons(result), {[blocked]: 'unfinished'});
    assert.equal(f.cards.get(blocked).revision, revision);
  });
}

test('관문: 발령 기록이 없는 카드는 닫지 않는다(원장 결과를 지어내지 않는다)', t => {
  const f = fixture(), never = f.execution({status: 'cancelled', runs: []});
  const empty = f.execution({status: 'cancelled', runs: []});
  f.closeLikeBefore(t);
  // 관문이 생기기 전의 기록처럼, 닫힌 업무에 발령한 적 없는 초안이 연결돼 있다.
  const draft = f.cards.create({repo: 'repo', id: 'never-sent', repoPath: f.home, title: '초안', body: '본문', by: BOSS}).key;
  f.forceLink('repo/w', draft);
  const result = f.apply();
  assert.deepEqual(result.closed, []);
  assert.deepEqual(reasons(result), {[draft]: 'unfinished'});
  assert.equal(f.cards.get(draft).status, 'draft');
  assert.deepEqual([never, empty].map(key => f.cards.get(key).status), ['cancelled', 'cancelled']);
});

test('관문: 카드가 없는 연결은 던지지 않고 카드 없음으로 세며 나머지는 닫는다', t => {
  const f = fixture(), fine = f.execution();
  f.closeLikeBefore(t);
  f.forceLink('repo/w', 'repo/gone');
  const result = f.apply();
  assert.deepEqual(result.closed.map(c => c.key), [fine]);
  assert.deepEqual(result.skipped.cards, [{key: 'repo/gone', reason: 'missing', from: null, state: null, works: ['repo/w']}]);
});

test('관문: 짧은 ID가 모호한 발령이 걸린 카드는 끝난 실행이 있어도 닫지 않는다', t => {
  const f = fixture();
  const make = repo => f.cards.create({repo, id: 'twin', repoPath: f.home, title: '같은 ID', body: '본문', by: BOSS}).key;
  const mine = make('repo');
  make('elsewhere');
  f.change('link', {execution: mine, phase: 'implementation', round: '1'});
  f.dispatch(mine, [['A', null]]);
  appendLedger({kind: 'done', by: 'A', role: 'A', taskId: 'twin', executionKey: mine, result: 'ok'}, f.home);
  f.closeLikeBefore(t);
  assert.equal(f.preview().total, 1, '모호한 줄이 생기기 전에는 닫을 대상이다');
  appendLedger({kind: 'send', by: BOSS, role: 'B', taskId: 'twin', digest: 'short'}, f.home);
  const result = f.apply();
  assert.deepEqual(result.closed, []);
  assert.deepEqual(reasons(result), {[mine]: 'ambiguous'});
  assert.equal(f.cards.get(mine).status, 'draft');
});

for (const status of ['open', 'hold']) {
  test(`이중 연결: ${status} 업무에도 연결된 실행은 닫지 않고 수를 센다`, t => {
    const f = fixture(), shared = f.execution(), fine = f.execution();
    f.closeLikeBefore(t);
    f.makeWork('repo/alive');
    f.forceLink('repo/alive', shared);
    if (status === 'hold') f.change('update', {status: 'hold'}, 'repo/alive');
    const revision = f.cards.get(shared).revision;
    const result = f.apply();
    assert.deepEqual(result.closed.map(c => c.key), [fine]);
    assert.deepEqual(reasons(result), {[shared]: 'open-work'});
    assert.deepEqual(result.skipped.cards[0].works, ['repo/alive', 'repo/w']);
    assert.deepEqual([result.counts.multiLinked, result.counts.multiLinkedWithOpen], [1, 1]);
    assert.equal(f.cards.get(shared).revision, revision);
  });
}

function twoClosedWorks(t) {
  const f = fixture(), shared = f.execution();
  f.makeWork('repo/second');
  f.closeLikeBefore(t);
  f.forceLink('repo/second', shared);
  f.closeLikeBefore(t, 'repo/second', 'cancel');
  return {f, shared};
}

test('이중 연결: 끝난 업무 둘에만 연결된 실행은 한 번만 닫고 두 업무를 메모에 남긴다', t => {
  const {f, shared} = twoClosedWorks(t);
  const result = f.apply();
  assert.deepEqual(result.closed.map(c => c.key), [shared]);
  assert.deepEqual([result.counts.multiLinked, result.counts.multiLinkedWithOpen], [1, 0]);
  assert.equal(f.cards.get(shared).note,
    '업무 repo/second 취소 마감 소급 정리로 닫음 · 원장 결과 ok (A ok) · 함께 연결된 끝난 업무: 업무 repo/w 완료');
});

// 판정 뒤, 닫기 직전에 사건을 끼워 넣는다.
function beforeClose(t, inject) {
  const original = CardStore.prototype.closeDone;
  t.mock.method(CardStore.prototype, 'closeDone', function (...args) { inject(); return original.apply(this, args); });
}
const newSend = (f, key) => appendLedger({kind: 'send', by: BOSS, role: 'B', taskId: key.split('/')[1], executionKey: key, digest: 'new'}, f.home);

test('경합: 판정 뒤 그 카드 ID가 적힌 원장 줄이 생기면 닫지 않고 나머지만 닫는다', t => {
  const f = fixture(), first = f.execution(), raced = f.execution(), last = f.execution();
  f.closeLikeBefore(t);
  const revision = f.cards.get(raced).revision;
  beforeClose(t, () => newSend(f, raced));
  const result = f.apply();
  assert.deepEqual(keysOf(result.closed), sorted([first, last]));
  assert.deepEqual(result.failed.map(c => c.key), [raced]);
  assert.match(result.failed[0].reason, /새 원장 기록/);
  assert.deepEqual(result.failedByReason, {record: 1});
  assert.equal(f.cards.get(raced).revision, revision);
});

// 판정 원장 버전을 판정과 같은 읽기에서 잡지 않고 나중에 재면, 읽기 직후에 붙은 발령을 못 보고 닫는다.
test('경합: 판정용 읽기가 끝나자마자 생긴 발령도 잡는다(버전은 같은 읽기에서 잡는다)', t => {
  const f = fixture(), raced = f.execution(), fine = f.execution();
  f.closeLikeBefore(t);
  let armed = false, injected = 0;
  const list = CardStore.prototype.list, close = DatabaseSync.prototype.close;
  t.mock.method(CardStore.prototype, 'list', function () { armed = true; return list.call(this); });
  t.mock.method(DatabaseSync.prototype, 'close', function () {
    close.call(this);
    if (armed) { armed = false; injected++; newSend(f, raced); }
  });
  const result = f.apply();
  assert.equal(injected, 1);
  assert.deepEqual(result.closed.map(c => c.key), [fine]);
  assert.deepEqual(result.failed.map(c => c.key), [raced]);
  assert.match(result.failed[0].reason, /새 원장 기록/);
  assert.equal(f.cards.get(raced).status, 'assigned');
});

test('경합: 판정 뒤 업무가 다시 열리면 그 업무의 카드는 닫지 않는다', t => {
  const f = fixture(), key = f.execution();
  f.closeLikeBefore(t);
  beforeClose(t, () => f.change('reopen'));
  const result = f.apply();
  assert.deepEqual(result.closed, []);
  assert.deepEqual(result.failedByReason, {reopened: 1});
  assert.equal(f.cards.get(key).status, 'assigned');
});

for (const reopened of ['repo/w', 'repo/second']) {
  test(`경합: 끝난 업무 둘에 걸린 카드는 ${reopened} 하나만 다시 열려도 닫지 않는다`, t => {
    const {f, shared} = twoClosedWorks(t);
    beforeClose(t, () => f.change('reopen', {}, reopened));
    const result = f.apply();
    assert.deepEqual(result.closed, []);
    assert.deepEqual(result.failedByReason, {reopened: 1});
    assert.equal(f.cards.get(shared).status, 'assigned');
  });
}

// 원장 전체 읽기 한 번은 작업 영역(tasks/events.jsonl)을 처음부터 한 번 읽는다. 실제 SQL을 세서 함수 이름에 기대지 않는다.
test('원장 전체는 업무 수·카드 수와 상관없이 한 번만 읽는다', t => {
  const totals = [[1, 1], [3, 4]].flatMap(([works, each]) => [false, true].map(applying => {
    const f = fixture();
    const names = Array.from({length: works}, (_, i) => `repo/n${i}`);
    for (const name of names) {
      f.makeWork(name);
      for (let i = 0; i < each; i++) f.execution({work: name});
      f.closeLikeBefore(t, name);
    }
    let reads = 0;
    const prepare = DatabaseSync.prototype.prepare;
    t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
      const statement = prepare.call(this, sql);
      if (/FROM events WHERE stream=\? ORDER BY seq/.test(sql)) {
        const iterate = statement.iterate.bind(statement);
        statement.iterate = (...args) => { if (args.at(-1) === 'tasks/events.jsonl') reads++; return iterate(...args); };
      }
      return statement;
    });
    const result = backfillCloseCards(f.home, {apply: applying, by: BOSS});
    t.mock.restoreAll();
    return [result.total, result.closed?.length ?? 0, reads];
  }));
  assert.deepEqual(totals, [[1, 0, 1], [1, 1, 1], [12, 0, 1], [12, 12, 1]]);
});

test('저장소가 없는 홈에서는 닫을 것이 없고 저장소를 만들지 않는다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-backfill-empty-'));
  for (const apply of [false, true]) assert.equal(backfillCloseCards(home, {apply}).total, 0);
  assert.deepEqual(fs.readdirSync(home), []);
});

function runCli(f, ...args) {
  return spawnSync(process.execPath, [path.join(root, 'src/cli.mjs'), 'work', ...args], {encoding: 'utf8',
    env: {...process.env, KADAN_HOME: f.home, KADAN_SOCKET: `t-${process.pid}`, KADAN_WINDOW: 'none', KADAN_NOTIFY: 'off', KADAN_ROLE: BOSS}});
}

test('CLI: 업무 키·--apply false·--apply=true는 종료 2로 거절하고 아무것도 쓰지 않는다', t => {
  const f = fixture(), key = f.execution();
  f.closeLikeBefore(t);
  const before = f.state();
  for (const [args, message] of [
    [['repo/w', '--apply'], /업무 키나 다른 인자를 받지 않습니다\(남는 인자: repo\/w\)/],
    [['--apply', 'false'], /남는 인자: false/],
    [['--apply=true'], /모르는 플래그: --apply=true/],
    [['--dry-run'], /모르는 플래그: --dry-run/],
    [['repo/w'], /남는 인자: repo\/w/],
  ]) {
    const run = runCli(f, 'backfill-close', ...args);
    assert.equal(run.status, 2, `${args.join(' ')}: ${run.stdout}${run.stderr}`);
    assert.match(run.stderr, message);
    assert.equal(run.stdout, '');
  }
  assert.deepEqual(f.state(), before);
  assert.equal(f.cards.get(key).status, 'assigned');
});

test('--apply에 참이 아닌 값이 오면 적용하지 않고 거절한다', t => {
  const f = fixture();
  f.execution();
  f.closeLikeBefore(t);
  const before = f.state();
  for (const apply of ['false', 'true', 'x', ['true', 'true']]) {
    assert.throws(() => workCommand(['backfill-close'], {apply}, {home: f.home, by: BOSS}),
      error => error.exitCode === 2 && /값 없이/.test(error.message));
  }
  assert.deepEqual(f.state(), before);
});

test('CLI: 미리보기는 stdout JSON과 stderr 요약을 내고 쓰지 않으며, --apply가 닫은 카드를 알린다', t => {
  const f = fixture(), ok = f.execution(), bad = f.execution({runs: [['B', 'failed']]});
  const blocked = f.execution();
  f.closeLikeBefore(t);
  tick();
  f.dispatch(blocked, [['C', null]]);
  const before = f.state();
  const preview = runCli(f, 'backfill-close');
  assert.equal(preview.status, 0, preview.stderr);
  assert.deepEqual(f.state(), before);
  assert.equal(JSON.parse(preview.stdout).total, 2);
  assert.match(preview.stderr, /소급 닫기 미리보기: 닫을 대상 2장 \(원장 ok 1 · failed 1\)/);
  assert.match(preview.stderr, /저장소별: repo 2/);
  assert.match(preview.stderr, /원래 상태: assigned 2/);
  assert.ok(preview.stderr.includes(`1장: ${blocked}`), preview.stderr);
  assert.match(preview.stderr, /아무것도 쓰지 않았습니다. 닫으려면: kadan work backfill-close --apply/);

  const applied = runCli(f, 'backfill-close', '--apply');
  assert.equal(applied.status, 0, applied.stderr);
  const json = JSON.parse(applied.stdout);
  assert.deepEqual([json.apply, json.closed.length, json.failed], [true, 2, []]);
  assert.deepEqual(keysOf(json.closed), sorted([ok, bad]));
  const listed = json.closed.map(c => `${c.key}(${c.result})`).join(', ');
  assert.ok(applied.stderr.includes(`실행 카드 2장 닫음: ${listed}`), applied.stderr);
  assert.doesNotMatch(applied.stderr, /업무 마감은 기록됨/);
  assert.equal(f.cards.get(ok).by, BOSS);
  assert.equal(f.cards.get(blocked).status, 'assigned');
});

test('닫지 못한 카드는 이유를 보이되 업무 마감 문구를 쓰지 않는다', t => {
  const f = fixture(), broken = f.execution();
  f.closeLikeBefore(t);
  t.mock.method(CardStore.prototype, 'update', () => { throw new Error('주입한 저장 실패'); });
  const lines = [];
  t.mock.method(process.stderr, 'write', chunk => { lines.push(String(chunk)); return true; });
  const result = workCommand(['backfill-close'], {apply: true}, {home: f.home, by: BOSS});
  t.mock.restoreAll();
  const text = lines.join('');
  assert.deepEqual(result.failed, [{key: broken, reason: '주입한 저장 실패'}]);
  assert.ok(text.includes(`실행 카드 닫기 실패 1장: ${broken} — 주입한 저장 실패`), text);
  assert.match(text, /미리보기부터 다시 실행/);
  assert.doesNotMatch(text, /업무 마감은 기록됨|card update/);
});
