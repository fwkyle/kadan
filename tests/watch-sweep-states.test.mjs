import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {createDatabase, writeStorageMarker, appendStream} from '../src/storage.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {ledgerViewPath} from '../src/ledger-view-store.mjs';
import {withLedgerView} from '../src/ledger-view.mjs';
import {createWatchMailReader} from '../src/watch-mail-reader.mjs';
import {createLedgerArraySweep, resetWatchSweep} from '../src/watch-sweep.mjs';
import {createSweepPolicy} from '../src/watch-sweep-policy.mjs';
import {createSweepRunner} from '../src/watch-sweep-run.mjs';
import {createWatchReplayMetrics, WATCH_METRIC_COUNT_MAX,
  WATCH_METRIC_MEMORY_MAX, WATCH_METRIC_DURATION_MAX} from '../src/watch-replay-metrics.mjs';
import {buildCycleEntry} from '../src/watch-cycle.mjs';

const at = '2026-01-01T00:00:00Z';
const worker = 'fixture-sweep-worker', boss = 'fixture-sweep-boss';
const start = {kind: 'start', role: worker, session: `kadan-${worker}`, panePid: 1, t: at};
const send = {kind: 'send', role: worker, by: boss, session: start.session,
  taskId: 'one', executionKey: 'fixture/one', mailId: 'fixture-question', expectReply: true, t: at};
const done = {kind: 'done', role: worker, taskId: 'one', executionKey: 'fixture/one', result: 'ok', t: at};

function setup(events = [start, send, done]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-sweep-states-'));
  createDatabase(home);writeStorageMarker(home, 'sqlite');
  const state = {home, cards: [{key: 'fixture/one', id: 'one', role: worker, status: 'assigned'}]};
  state.reader = createWatchMailReader(home, null, {readCards: () => state.cards});
  state.append = entry => appendLedger(entry, home);
  for (const entry of events) state.append(entry);
  state.reader.readEntries();
  state.edit = sql => {
    const db = new DatabaseSync(ledgerViewPath(home));
    try { db.exec(sql); } finally { db.close(); }
  };
  state.sweep = (options = {}) => createLedgerArraySweep({access: state.reader.sweepAccess,
    chunkRows: 2, ...options});
  return state;
}

test('원장이 아직 없는 새 홈은 비교할 상태가 없으며 거짓 오류를 내지 않는다', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-sweep-empty-'));
  const reader = createWatchMailReader(home, null, {readCards: () => []});
  reader.readEntries();
  assert.equal((await createLedgerArraySweep({access: reader.sweepAccess}).full()).status, 'match');
});

for (const [key, sql] of [
  ['projection-state', "UPDATE views SET routine=1-routine WHERE domain='watch' AND position=(SELECT min(position) FROM views WHERE domain='watch')"],
  ['completion-state', 'DELETE FROM watch_mail_completions'],
  ['mail-state', "UPDATE mail_current SET read=1 WHERE domain='watch'"],
  ['role-state', 'UPDATE watch_role_sessions SET dispatch_ready=1-dispatch_ready'],
  ['work-state', "UPDATE watch_work_last SET kind='send'"],
]) {
  test(`${key}: 내용 손상을 잡고 진단 뒤 초기화해 다음 읽기에서 복구한다`, async () => {
    const s = setup();
    assert.equal((await s.sweep().full()).status, 'match');
    s.edit(sql);
    const found = await s.sweep().full();
    assert.equal(found.status, 'diff', JSON.stringify(found));
    assert.deepEqual(found.diffs.map(diff => diff.key), [key]);
    const notes = [], resets = [];
    const metrics = createWatchReplayMetrics();
    const policy = createSweepPolicy({diagnostics: {rows: () => [], append: row => notes.push(row)}});
    const runner = createSweepRunner({engine: s.sweep(), policy, metrics, reset: keys => {
      assert.ok(notes.some(row => row.kind === 'pass' && row.status === 'diff'));
      resets.push(keys);resetWatchSweep(s.reader, keys);
    }});
    runner.tick();await runner.idle();
    assert.deepEqual(resets, [[key]]);
    assert.equal(policy.holding(), true);
    assert.equal(metrics.snapshot().replay.sweep.full, 1);
    assert.equal(metrics.snapshot().replay.sweep.replace, 1);
    s.reader.readEntries();
    assert.equal((await s.sweep().full()).status, 'match');
  });
}

test('정상 자료·새 사건·카드 추가로 인한 기존 전체 재생은 거짓 차이를 만들지 않는다', async () => {
  const s = setup([start, send]);
  const events = [
    {kind: 'send', mailId: 'fixture-answer', role: boss, by: worker, replyTo: send.mailId,
      replyFinal: true, taskId: 'one', executionKey: 'fixture/one', t: at},
    {kind: 'handover', phase: 'transferred', from: worker, to: 'fixture-sweep-next',
      taskIds: ['one'], handoverId: 'fixture-handover', t: at},
    {...done, role: 'fixture-sweep-next'},
    {kind: 'watch-cycle', by: 'watch', t: at},
  ];
  for (const event of events) {
    s.append(event);s.reader.readEntries();
    assert.equal((await s.sweep().full()).status, 'match');
  }
  s.cards = [...s.cards, {key: 'fixture/two', id: 'two'}];
  s.reader.readEntries();
  const notes = [], resets = [];
  const runner = createSweepRunner({engine: s.sweep(),
    policy: createSweepPolicy({diagnostics: {rows: () => [], append: row => notes.push(row)}}),
    reset: keys => resets.push(keys)});
  runner.tick();await runner.idle();
  assert.deepEqual(resets, []);
  assert.equal(notes.find(row => row.kind === 'pass').status, 'match');
});

test('기존 투영과 역할 상태가 함께 틀려도 원본에서 독립 재생해 양쪽 차이를 잡는다', async () => {
  const s = setup([start, send]);
  s.edit(`DELETE FROM views WHERE domain='watch' AND position=(
      SELECT position FROM watch_role_dispatches LIMIT 1);
    DELETE FROM watch_role_dispatches;
    UPDATE watch_role_meta SET value=json_set(value,'$.dispatchCount',0);`);
  const result = await s.sweep().full();
  assert.equal(result.status, 'diff');
  assert.ok(result.diffs.some(diff => diff.key === 'projection-state'));
  assert.ok(result.diffs.some(diff => diff.key === 'role-state'));
  resetWatchSweep(s.reader, result.diffs.map(diff => diff.key));
  s.reader.readEntries();
  assert.equal((await s.sweep().full()).status, 'match');
});

test('대조는 현재 상태를 고치지 않으며 메타 계수 손상도 비교한다', async () => {
  const s = setup();
  s.edit("UPDATE watch_mail_projection SET value=json_set(value,'$.count',999)");
  const result = await s.sweep().full();
  assert.ok(result.diffs.some(diff => diff.key === 'projection-state'));
  const db = new DatabaseSync(ledgerViewPath(s.home), {readOnly: true});
  try {
    assert.equal(JSON.parse(db.prepare('SELECT value FROM watch_mail_projection').get().value).count, 999);
  } finally { db.close(); }
});

test('고정 상태 비교 중 새 사건이 추가되어도 같은 prefix는 일치한다', async () => {
  const s = setup();
  let added = false;
  const result = await s.sweep({yieldNow: async () => {
    if (!added) {
      added = true;s.append({...send, mailId: 'fixture-later'});s.reader.readEntries();
    }
  }}).full();
  assert.equal(result.status, 'match', JSON.stringify(result));
});

test('원문 캐시만 앞선 경우 감시 투영의 적용 위치까지 비교한다', async () => {
  const s = setup();
  s.append({...send, mailId: 'fixture-ahead'});
  withLedgerView(s.home, () => {});
  assert.equal((await s.sweep().full()).status, 'match');
});

test('카드 목록이 먼저 바뀌고 감시 투영은 아직 이전 목록이면 moved다', async () => {
  const s = setup();
  s.cards = [...s.cards, {key: 'other/one', id: 'one'}];
  const result = await s.sweep().full();
  assert.equal(result.status, 'moved');
  assert.deepEqual(result.diffs, []);
});

test('상태 snapshot을 잡은 뒤 카드 주소가 바뀌면 거짓 차이 대신 moved다', async () => {
  const s = setup();
  const original = s.reader.sweepAccess.states.open;
  let opened = false, changed = false;
  const access = {...s.reader.sweepAccess, states: {...s.reader.sweepAccess.states,
    open() { opened = true;return original(); }}};
  const result = await createLedgerArraySweep({access, chunkRows: 2, yieldNow: async () => {
    if (opened && !changed) {
      changed = true;s.cards = [...s.cards, {key: 'fixture/new', id: 'new'}];s.reader.readEntries();
    }
  }}).full();
  assert.ok(changed);
  assert.equal(result.status, 'moved');
  assert.deepEqual(result.diffs, []);
});

test('중간 예외에도 읽기 연결을 닫고 보류하며 상태를 초기화하지 않는다', async () => {
  const s = setup();
  const open = s.reader.sweepAccess.states.open;
  let snapshot, closed = false;
  const access = {...s.reader.sweepAccess, states: {...s.reader.sweepAccess.states, open() {
    snapshot = open();return {...snapshot, close() { closed = true;snapshot.close(); }};
  }}};
  const policy = createSweepPolicy({diagnostics: {rows: () => [], append() {}}});
  const resets = [];
  const engine = createLedgerArraySweep({access, chunkRows: 2, yieldNow: async () => {
    if (snapshot) throw new Error('fixture-sweep-failure');
  }});
  const runner = createSweepRunner({engine, policy, reset: keys => resets.push(keys)});
  runner.tick();await runner.idle();
  assert.ok(closed);
  assert.throws(() => snapshot.db.prepare('SELECT 1'));
  assert.throws(() => snapshot.source.prepare('SELECT 1'));
  assert.equal(policy.holding(), true);
  assert.deepEqual(resets, []);
});

test('독립 재생 중 원본 읽기가 실패해도 임시 DB와 두 snapshot 연결을 모두 닫는다', async () => {
  const s = setup();
  const original = s.reader.sweepAccess.states.open;
  const close = DatabaseSync.prototype.close, closed = [];
  let snapshot;
  DatabaseSync.prototype.close = function () {
    if (snapshot) closed.push(this);
    return close.call(this);
  };
  try {
    const access = {...s.reader.sweepAccess, states: {...s.reader.sweepAccess.states, open() {
      snapshot = original();
      return {...snapshot, source: {prepare() { throw new Error('fixture-source-read'); }}};
    }}};
    const result = await createLedgerArraySweep({access, chunkRows: 2}).full();
    assert.equal(result.status, 'error');
    assert.match(result.error, /fixture-source-read/u);
    assert.equal(closed.length, 3); // 임시 :memory: DB, 원본 snapshot, 현재 상태 snapshot
    assert.ok(closed.includes(snapshot.db) && closed.includes(snapshot.source));
  } finally { DatabaseSync.prototype.close = close; }
});

test('투영 메타가 없으면 일치로 넘기지 않고 오류로 보류한다', async () => {
  const s = setup();
  s.edit('DELETE FROM watch_mail_projection');
  const result = await s.sweep().full();
  assert.equal(result.status, 'error');
  assert.equal(result.errorKey, 'watch-state');
});

test('손상된 투영 위치를 재생 범위로 쓰거나 일치로 받아들이지 않는다', async () => {
  const s = setup();
  s.edit("UPDATE watch_mail_projection SET value=json_set(value,'$.position','invalid')");
  assert.equal((await s.sweep().full()).status, 'error');
});

test('기존 running 보호가 전체 대조를 겹쳐 실행하지 않는다', async () => {
  let complete, calls = 0;
  const metrics = createWatchReplayMetrics();
  const pending = new Promise(resolve => { complete = resolve; });
  const runner = createSweepRunner({engine: {
    full: async () => { calls++;await pending;return {status: 'match', diffs: []}; },
  }, policy: createSweepPolicy({diagnostics: {rows: () => [], append() {}}}), metrics, reset() {
    assert.fail('일치 결과에서는 초기화하지 않는다');
  }});
  runner.tick();runner.tick();runner.tick();
  assert.equal(calls, 1);
  assert.equal(metrics.snapshot().replay.sweep.full, 1);
  complete();await runner.idle();
});

test('기존 역할 재생 접근점도 기존 투영 손상을 입력으로 공유하지 않는다', async () => {
  const s = setup([start, send]);
  const live = s.reader.sweepAccess.roleState.live();
  s.edit(`DELETE FROM views WHERE domain='watch' AND position=(
    SELECT position FROM watch_role_dispatches LIMIT 1)`);
  const replayed = await s.reader.sweepAccess.roleState.replay({...live, upTo: live.position});
  assert.equal(replayed.digest, live.digest);
});

const actorFixture = () => setup([send, {kind: 'mail-read', mailId: send.mailId,
  role: worker, by: 'fixture-human', t: at}]);
async function actorTest(run) {
  const previous = process.env.KADAN_USER_NAMES;
  process.env.KADAN_USER_NAMES = '';
  try { await run(); }
  finally {
    if (previous === undefined) delete process.env.KADAN_USER_NAMES;
    else process.env.KADAN_USER_NAMES = previous;
  }
}
function noActorReset(result) {
  assert.ok(['match', 'moved'].includes(result.status), JSON.stringify(result));
  const policy = createSweepPolicy({diagnostics: {rows: () => [], append() {}}});
  assert.equal(policy.record(result).replace, false);
  assert.equal(policy.holding(), false);
}

test('F1: 다른 사용자 설정의 별도 정식 조회는 손상·초기화·보류가 아니다', async () => actorTest(async () => {
  for (const actors of ['', 'fixture-human']) {
    const s = actorFixture();
    let changed = false;
    const script = `import {withMailboxView} from ${JSON.stringify(new URL('../src/mail-view.mjs', import.meta.url).href)};
      withMailboxView(process.argv[1],()=>{},{domain:'watch',cards:JSON.parse(process.argv[2])});`;
    const result = await s.sweep({yieldNow: async () => {
      if (!changed) {
        changed = true;
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, s.home,
          JSON.stringify(s.cards)], {encoding: 'utf8', env: {...process.env,
          KADAN_USER_NAMES: actors, KADAN_HOME: s.home}});
        assert.equal(child.status, 0, child.stderr);
      }
    }}).full();
    noActorReset(result);
    s.reader.readEntries();
    assert.equal((await s.sweep().full()).status, 'match');
  }
}));

test('F1: snapshot 뒤 사용자 설정과 정상 상태가 바뀌면 moved다', async () => actorTest(async () => {
  const s = actorFixture(), open = s.reader.sweepAccess.states.open;
  let opened = false, changed = false;
  s.reader.sweepAccess.states.open = () => { opened = true;return open(); };
  const result = await s.sweep({yieldNow: async () => {
    if (opened && !changed) {
      changed = true;process.env.KADAN_USER_NAMES = 'fixture-human';s.reader.readEntries();
    }
  }}).full();
  assert.equal(result.status, 'moved');
  noActorReset(result);
}));

test('F1: 환경만 바뀌어도 재생은 저장된 사용자 집합을 사용한다', async () => actorTest(async () => {
  const s = actorFixture(), open = s.reader.sweepAccess.states.open;
  let opened = false;
  s.reader.sweepAccess.states.open = () => { opened = true;return open(); };
  const result = await s.sweep({yieldNow: async () => {
    if (opened) process.env.KADAN_USER_NAMES = 'fixture-human';
  }}).full();
  assert.equal(result.status, 'match');
  noActorReset(result);
}));

test('F1: 같은 사용자 집합의 손상은 잡고, 집합 전환 중 손상은 다음 대조에서 잡는다',
  async () => actorTest(async () => {
    const s = actorFixture();
    s.edit("UPDATE mail_current SET read=1 WHERE domain='watch'");
    assert.deepEqual((await s.sweep().full()).diffs.map(diff => diff.key), ['mail-state']);
    const open = s.reader.sweepAccess.states.open;
    let opened = false, changed = false;
    s.reader.sweepAccess.states.open = () => { opened = true;return open(); };
    const during = await s.sweep({yieldNow: async () => {
      if (opened && !changed) {
        changed = true;process.env.KADAN_USER_NAMES = 'fixture-human';s.reader.readEntries();
        s.edit("UPDATE mail_current SET read=0 WHERE domain='watch'");
      }
    }}).full();
    assert.equal(during.status, 'moved');
    noActorReset(during);
    assert.deepEqual((await s.sweep().full()).diffs.map(diff => diff.key), ['mail-state']);
  }));

test('F1: 우편 사용자 메타가 없거나 해석할 수 없으면 diff 대신 moved다', async () => {
  for (const sql of ["DELETE FROM mail_view_meta WHERE domain='watch'",
    "UPDATE mail_view_meta SET value=json_set(value,'$.actors','invalid') WHERE domain='watch'",
    "UPDATE mail_view_meta SET value='invalid' WHERE domain='watch'"]) {
    const s = actorFixture();s.edit(sql);
    const result = await s.sweep().full();
    assert.equal(result.status, 'moved');
    noActorReset(result);
  }
});

test('F2: 우편 80/800개 뒤 인계는 단독 조각이며 최장 시간·조각 수가 주기 기록에 남는다', async () => {
  for (const count of [80, 800]) {
    const s = setup([]);
    for (let index = 0; index < count; index++) appendStream(s.home, 'ledger.jsonl', {
      kind: 'send', role: worker, by: boss, mailId: `fixture-cost-${index}`, t: at,
    });
    appendStream(s.home, 'ledger.jsonl', {kind: 'handover', phase: 'transferred', from: worker,
      to: 'fixture-cost-next', taskIds: [], handoverId: 'fixture-cost-transfer', t: at});
    s.reader.readEntries();
    const prepare = DatabaseSync.prototype.prepare;
    let inserted = [], handoverRows, updated = 0, observed;
    DatabaseSync.prototype.prepare = function (sql) {
      const statement = prepare.call(this, sql);
      if (sql.startsWith('INSERT INTO source_rows VALUES') ||
          sql.startsWith('UPDATE mail_current SET recipient_key')) {
        const run = statement.run.bind(statement);
        statement.run = (...args) => {
          const result = run(...args);
          if (sql.startsWith('INSERT INTO source_rows')) inserted.push(args[0]);
          else { handoverRows = [...inserted];updated += Number(result.changes); }
          return result;
        };
      }
      return statement;
    };
    const metrics = createWatchReplayMetrics();
    try {
      const engine = s.sweep({chunkRows: 20, yieldNow: async () => { inserted = []; }});
      const runner = createSweepRunner({engine, metrics, policy: {
        record(result) { observed = result;return {replace: false}; }, holding: () => false, alerts: () => [],
      }, reset() { assert.fail('정상 자료를 초기화하지 않는다'); }});
      runner.tick();await runner.idle();
    } finally { DatabaseSync.prototype.prepare = prepare; }
    assert.equal(observed.status, 'match');
    assert.deepEqual(handoverRows, [count + 1]);
    assert.equal(updated, count);
    const cycle = buildCycleEntry({pid: 1, timing: metrics.snapshot()});
    const sweep = cycle.timing.replay.sweep;
    assert.ok(sweep.slices > 0);
    assert.ok(Number.isFinite(sweep.maxSliceMs) && sweep.maxSliceMs >= 0);
    assert.equal(sweep.full, 1);
    console.log(JSON.stringify({fixtureLetters: count, updated, status: observed.status,
      handoverRows, maxSliceMs: sweep.maxSliceMs, slices: sweep.slices}));
  }
});

test('F2: 최장 시간은 누산하지 않고 최대를 유지하며 고정 크기 계측은 1KiB 이하다', () => {
  const metrics = createWatchReplayMetrics({memoryUsage: () => ({
    rss: Number.MAX_VALUE, heapUsed: Number.MAX_VALUE, heapTotal: Number.MAX_VALUE,
  })});
  metrics.sweepSlice(12.34);metrics.sweepSlice(7.1);
  assert.equal(metrics.snapshot().replay.sweep.maxSliceMs, 12.3);
  assert.equal(metrics.snapshot().replay.sweep.slices, 2);
  metrics.sweepSlice(Number.MAX_VALUE);metrics.sample();
  assert.equal(metrics.snapshot().replay.sweep.maxSliceMs, WATCH_METRIC_DURATION_MAX);
  const largest = value => typeof value === 'number' ? WATCH_METRIC_COUNT_MAX :
    Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, largest(entry)]));
  const worst = largest(metrics.snapshot());
  for (const name of ['last', 'max']) for (const key of ['rss', 'heapUsed', 'heapTotal']) {
    worst.processMemory[name][key] = WATCH_METRIC_MEMORY_MAX;
  }
  worst.replay.sweep.maxSliceMs = WATCH_METRIC_DURATION_MAX;
  assert.ok(Buffer.byteLength(JSON.stringify(worst)) <= 1024);
  metrics.clear();
  assert.equal(metrics.snapshot().replay.sweep.slices, undefined);
});
