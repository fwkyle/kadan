import test from 'node:test';
import assert from 'node:assert/strict';
import {createExplainQueue, EXPLAIN_QUEUE_MAX_BYTES, EXPLAIN_QUEUE_MAX_ENTRIES}
  from '../src/explain-queue.mjs';
import {collectionStats, watchResourceStats, memoryMegabytes} from '../src/watch-resource-stats.mjs';

const job = (key, hash = 'a', input = '가') => ({key, hash, input, ids: [{id: key, at: 1}]});

test('같은 카드의 최신 입력으로 합치고 원래 대기 순서와 정확한 UTF-8 바이트를 보존한다', () => {
  const queue = createExplainQueue(), first = job('a'), second = job('b'), latest = job('a', 'new', '최신 입력');
  assert.equal(queue.enqueue(first), true);queue.enqueue(second);
  assert.equal(queue.enqueue(job('a')), false);
  assert.equal(queue.enqueue(latest), true);
  assert.equal(queue.info().bytes,
    Buffer.byteLength(JSON.stringify(latest)) + Buffer.byteLength(JSON.stringify(second)));
  assert.equal(queue.info().coalesced, 1);
  assert.strictEqual(queue.take(), latest);assert.strictEqual(queue.take(), second);
  assert.equal(queue.take(), undefined);assert.equal(queue.info().bytes, 0);
});

test('대기열 개수 상한에서 미룬 카드는 자리가 나면 다시 넣을 수 있다', () => {
  const queue = createExplainQueue();
  for (let i = 0; i < EXPLAIN_QUEUE_MAX_ENTRIES; i++) assert.equal(queue.enqueue(job(String(i))), true);
  assert.equal(queue.enqueue(job('later')), false);
  assert.equal(queue.length, EXPLAIN_QUEUE_MAX_ENTRIES);
  assert.equal(queue.info().deferred, 1);
  queue.take();assert.equal(queue.enqueue(job('later')), true);
  queue.clear();assert.equal(queue.length, 0);assert.equal(queue.info().bytes, 0);
});

test('바이트 상한과 단일 초과 입력을 거절하며 낡은 같은 카드 입력은 남기지 않는다', () => {
  const queue = createExplainQueue(), large = '가'.repeat(800000);
  assert.equal(queue.enqueue(job('a', 'a', large)), true);
  assert.equal(queue.enqueue(job('b', 'b', large)), false);
  assert.ok(queue.info().bytes <= EXPLAIN_QUEUE_MAX_BYTES);
  assert.equal(queue.enqueue(job('a', 'changed', large + large)), false);
  assert.equal(queue.length, 0);assert.equal(queue.info().bytes, 0);
  assert.equal(queue.info().oversized, 1);
});

test('모음 크기는 개수·바이트 한도까지만 측정하며 원본을 바꾸지 않는다', () => {
  const small = new Map([['가', {result: 'sent'}]]);
  assert.deepEqual(collectionStats(small), {entries: 1, sampledEntries: 1,
    serializedBytes: Buffer.byteLength(JSON.stringify([...small][0])), complete: true});
  const many = new Set(Array.from({length: 10000}, (_, i) => String(i)));
  assert.equal(collectionStats(many).sampledEntries, 1000);
  assert.equal(collectionStats(many).complete, false);assert.equal(many.size, 10000);
  const big = collectionStats(new Set(['가'.repeat(100000)]));
  assert.equal(big.serializedBytes, 256 * 1024);assert.equal(big.complete, false);
  const cyclic = {};cyclic.self = cyclic;
  assert.equal(collectionStats(new Set([cyclic])).complete, false);
  assert.equal(watchResourceStats({}).mail, null);
});

test('메모리 수치는 알려진 항목만 MiB로 바꾸고 external과 arrayBuffers를 합치지 않는다', () => {
  assert.deepEqual(memoryMegabytes({rss: 2**20, heapUsed: 2**19, heapTotal: 2**20,
    external: 2**20, arrayBuffers: 2**19}),
  {rss: 1, heapUsed: .5, heapTotal: 1, external: 1, arrayBuffers: .5});
  assert.deepEqual(memoryMegabytes({rss: 0, heapUsed: NaN}), {rss: 0});
});
