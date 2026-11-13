import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createDatabase, writeStorageMarker, appendStream} from '../src/storage.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {ledgerViewPath} from '../src/ledger-view-store.mjs';
import {withMailboxView} from '../src/mail-view.mjs';
import {createWatchMailReader} from '../src/watch-mail-reader.mjs';
import {createWatchLedgerView} from '../src/watch-ledger-view.mjs';
import {createWatchStoreReaders} from '../src/watch-store-cache.mjs';
import {createSweepRunner} from '../src/watch-sweep-run.mjs';
import {createWatchReplayMetrics, watchMetric, WATCH_METRIC_COUNT_MAX,
  WATCH_METRIC_MEMORY_MAX} from '../src/watch-replay-metrics.mjs';

const bytes = value => value * 1048576;
const memoryUsage = () => ({rss: bytes(600), heapUsed: bytes(350), heapTotal: bytes(480)});
const fixture = metrics => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-replay-metrics-'));
  createDatabase(home); writeStorageMarker(home, 'sqlite');
  for (let n = 0; n < 8; n++) appendStream(home, 'ledger.jsonl', {
    kind: 'start', role: 'fixture-worker', session: 'kadan-fixture-worker',
    panePid: n + 1, t: '2026-01-01T00:00:00Z',
  });
  let cards = [{key: 'fixture/task', id: 'task'}];
  const reader = createWatchMailReader(home, null, {
    readCards: () => cards, readWorks: () => [], metrics,
  });
  return {home, reader, setCards: value => { cards = value; }, cards: () => cards};
};
const zero = () => createWatchReplayMetrics().snapshot().replay;
const addressReplay = () => ({...zero(),
  projection: {full: 1, address: 1, generation: 0, invalid: 0, count: 0},
  mail: {full: 1, generation: 1, actors: 0, invalid: 0, count: 0},
  role: {full: 1, generation: 1, invalid: 0, count: 0},
  work: {full: 1, generation: 1, invalid: 0, count: 0},
});

test('최초 적재만 initial, metadata·평소 append는 0, 주소 추가·순서 변경은 연쇄 이유를 구분한다', () => {
  const metrics = createWatchReplayMetrics({memoryUsage});
  const f = fixture(metrics);
  f.reader.readEntries();
  assert.deepEqual(metrics.snapshot().replay, {...zero(), initial: 1});
  metrics.clear();
  f.reader.readEntries();
  f.setCards(f.cards().map(card => ({...card, title: 'renamed', status: 'done'})));
  f.reader.readEntries();
  appendLedger({kind: 'watch-cycle', by: 'watch', t: '2026-01-01T00:01:00Z'}, f.home);
  f.reader.readEntries();
  assert.deepEqual(metrics.snapshot().replay, zero());
  f.setCards([...f.cards(), {key: 'fixture/unrelated', id: 'unrelated'}]);
  f.reader.readEntries();
  assert.deepEqual(metrics.snapshot().replay, addressReplay());
  metrics.clear();
  f.setCards([...f.cards()].reverse());
  f.reader.readEntries();
  assert.deepEqual(metrics.snapshot().replay, addressReplay());
});

test('원본 캐시 새 세대와 명시 reset은 raw의 다른 이유이며 대조 교체도 별도로 센다', async () => {
  const metrics = createWatchReplayMetrics({memoryUsage});
  const f = fixture(metrics);
  f.reader.readEntries(); metrics.clear();
  fs.renameSync(ledgerViewPath(f.home), path.join(f.home, 'previous-cache.sqlite'));
  f.reader.readEntries();
  assert.deepEqual(metrics.snapshot().replay.raw, {full: 1, generation: 1, retreat: 0, reset: 0});
  metrics.clear();
  const runner = createSweepRunner({metrics, engine: {
    full: async () => ({status: 'diff', diffs: [{key: 'ledger-array'}]}),
    light: () => ({mismatches: []}),
  }, policy: {record: () => ({replace: true}), holding: () => false, alerts: () => []},
  reset: () => f.reader.resetIncremental()});
  runner.tick(); await runner.idle();
  assert.equal(metrics.snapshot().replay.raw.full, 0, 'reset 요청만으로 읽었다고 세지 않는다');
  f.reader.readEntries();
  assert.deepEqual(metrics.snapshot().replay.raw, {full: 1, generation: 0, retreat: 0, reset: 1});
  assert.deepEqual(metrics.snapshot().replay.sweep, {full: 1, replace: 1, moved: 0, error: 0});
});

test('위치 후퇴로 다시 읽다가 검증 실패해도 원래 예외와 재생 관측을 모두 유지한다', () => {
  const metrics = createWatchReplayMetrics({memoryUsage});
  const f = fixture();
  const view = createWatchLedgerView(metrics);
  withMailboxView(f.home, (cache, info) => view(cache, info)); metrics.clear();
  assert.throws(() => withMailboxView(f.home, (cache, info) =>
    view(cache, {...info, position: info.position - 1})), /개수 불일치/);
  assert.deepEqual(metrics.snapshot().replay.raw, {full: 1, generation: 0, retreat: 1, reset: 0});
  assert.equal(metrics.snapshot().processMemory.samples, 1);
});

test('최초 구성 이후의 계수 불일치와 잘못된 상태 메타는 각각 count와 invalid다', () => {
  const metrics = createWatchReplayMetrics({memoryUsage});
  const f = fixture(metrics);
  f.reader.readEntries(); metrics.clear();
  const change = fn => {
    const db = new DatabaseSync(ledgerViewPath(f.home));
    try { fn(db); } finally { db.close(); }
  };
  change(db => {
    const meta = JSON.parse(db.prepare('SELECT value FROM watch_mail_projection').get().value);
    meta.revision = 'fixture-cold-check';
    db.prepare('UPDATE watch_mail_projection SET value=?').run(JSON.stringify(meta));
    db.exec("DELETE FROM views WHERE domain='watch' AND position=1");
  });
  f.reader.readEntries();
  assert.deepEqual(metrics.snapshot().replay.projection,
    {full: 1, address: 0, generation: 0, invalid: 0, count: 1});
  metrics.clear();
  change(db => {
    db.exec("UPDATE watch_role_meta SET value='{}'; UPDATE watch_work_meta SET value='{}'");
    const meta = JSON.parse(db.prepare("SELECT value FROM mail_view_meta WHERE domain='watch'").get().value);
    meta.version = 2;
    db.prepare("UPDATE mail_view_meta SET value=? WHERE domain='watch'").run(JSON.stringify(meta));
  });
  f.reader.readEntries();
  for (const name of ['mail', 'role', 'work']) {
    assert.equal(metrics.snapshot().replay[name].full, 1);
    assert.equal(metrics.snapshot().replay[name].invalid, 1);
  }
});

test('선택 계수기가 없는 공유 우편 뷰는 결과가 같고 계수/메모리 관측을 하지 않는다', () => {
  const metrics = createWatchReplayMetrics({memoryUsage});
  const f = fixture(metrics);
  f.reader.readEntries(); metrics.clear();
  const read = (_store, info) => info;
  const plain = withMailboxView(f.home, read);
  assert.deepEqual(withMailboxView(f.home, read, {metrics}), plain);
  assert.deepEqual(metrics.snapshot(), {replay: zero(),
    processMemory: {last: null, max: null, samples: 0, failures: 0}});
});

test('사용자 actor 집합 변경은 원본과 해석 우편의 actors 이유로만 센다', () => {
  const metrics = createWatchReplayMetrics({memoryUsage});
  const f = fixture(metrics);
  f.reader.readEntries(); metrics.clear();
  const old = process.env.KADAN_USER_NAMES;
  try {
    process.env.KADAN_USER_NAMES = 'fixture-person';
    f.reader.readEntries();
    assert.deepEqual(metrics.snapshot().replay.mail,
      {full: 2, generation: 0, actors: 2, invalid: 0, count: 0});
    assert.equal(metrics.snapshot().replay.projection.full, 0);
  } finally {
    if (old === undefined) delete process.env.KADAN_USER_NAMES;
    else process.env.KADAN_USER_NAMES = old;
  }
});

test('카드/업무 reader의 실제 최초 구성과 reset만 세고 정상 재사용은 세지 않는다', () => {
  const metrics = createWatchReplayMetrics({memoryUsage});
  const f = fixture();
  const stores = createWatchStoreReaders(f.home, metrics);
  metrics.beginInitial(); stores.cards.read(); stores.works.read(); metrics.endInitial();
  assert.deepEqual(metrics.snapshot().replay, {...zero(), initial: 1});
  metrics.clear(); stores.cards.read(); stores.works.read();
  assert.deepEqual(metrics.snapshot().replay, zero());
  stores.cards.reset(); stores.works.reset(); stores.cards.read(); stores.works.read();
  assert.deepEqual(metrics.snapshot().replay.stores, {cards: 1, works: 1});
});

test('계측기가 던져도 원장 결과는 같고 failures에 남기며 메모리 실패는 최고값을 지우지 않는다', () => {
  const good = createWatchReplayMetrics({memoryUsage});
  const broken = {...good, replay() { throw new Error('fake counter failure'); }};
  const f = fixture(broken);
  const first = f.reader.readEntries();
  f.setCards([...f.cards(), {key: 'fixture/next', id: 'next'}]);
  assert.deepEqual(f.reader.readEntries(), first);
  assert.ok(good.snapshot().processMemory.failures >= 4);
  let fail = false;
  const metrics = createWatchReplayMetrics({memoryUsage: () => {
    if (fail) throw new Error('fake memory failure');
    return memoryUsage();
  }});
  watchMetric(metrics, 'sample'); fail = true; watchMetric(metrics, 'sample');
  assert.deepEqual(metrics.snapshot().processMemory, {last: null,
    max: {rss: 600, heapUsed: 350, heapTotal: 480}, samples: 2, failures: 1});
});

test('고정 필드와 상한 숫자를 모두 직렬화해도 두 칸은 1KiB 이하이고 주기 기록은 자리표다', () => {
  const metrics = createWatchReplayMetrics({memoryUsage: () => ({
    rss: Number.MAX_VALUE, heapUsed: Number.MAX_VALUE, heapTotal: Number.MAX_VALUE,
  })});
  metrics.sample();
  assert.deepEqual(metrics.snapshot().processMemory.last,
    {rss: WATCH_METRIC_MEMORY_MAX, heapUsed: WATCH_METRIC_MEMORY_MAX, heapTotal: WATCH_METRIC_MEMORY_MAX});
  const largest = value => typeof value === 'number' ? WATCH_METRIC_COUNT_MAX
    : Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, largest(entry)]));
  const worst = largest(metrics.snapshot());
  for (const key of ['last', 'max']) for (const name of ['rss', 'heapUsed', 'heapTotal']) {
    worst.processMemory[key][name] = WATCH_METRIC_MEMORY_MAX;
  }
  assert.ok(Buffer.byteLength(JSON.stringify(worst)) <= 1024);
  const f = fixture();
  appendLedger({kind: 'watch-cycle', by: 'watch', timing: worst, t: '2026-01-01T00:01:00Z'}, f.home);
  const row = f.reader.readEntries().at(-1);
  assert.equal(row.kind, 'watch-cycle');
  assert.equal(Object.hasOwn(row, 'timing'), false);
  assert.deepEqual(Object.keys(row).filter(key => key !== '_ledgerOrder').sort(), ['by', 'kind', 't']);
});
