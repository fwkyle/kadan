import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createProcessCollections, processCollectionInfo} from '../src/process-collections.mjs';
import {collectionStats} from '../src/watch-resource-stats.mjs';

test('작은 모음은 메모리, 합계 상한 뒤에는 모든 키를 보존하며 임시 DB로 옮긴다', t => {
  const pool = createProcessCollections();t.after(() => pool.close());
  const seen = pool.set(), values = pool.map();
  for (let i = 0; i < 1000; i++) seen.add(`key-${i}`);
  assert.equal(pool.info().storage, 'memory');
  assert.equal(pool.info().retainedEntries, 1000);
  assert.equal(values.set('same', {result:'unknown', reason:undefined}), values);
  assert.equal(pool.info().storage, 'temporary');
  assert.equal(pool.info().retainedEntries, 0);
  assert.equal(seen.size, 1000);assert.equal(values.size, 1);
  for (let i = 0; i < 1000; i++) assert(seen.has(`key-${i}`));
  assert.deepEqual(values.get('same'), {result:'unknown', reason:undefined});
  assert.equal(seen.add('key-1'), seen);assert.equal(seen.size, 1000);
});

test('키·값·삽입 순서가 이동 전후 같고 삭제 후 재추가는 끝에 온다', t => {
  const pool = createProcessCollections({maxEntries:3});t.after(() => pool.close());
  const set = pool.set(), map = pool.map(), expected = new Map();
  const items = [['a', null], ['b', undefined], ['c', NaN], ['d', {n:3n, list:[1, undefined]}]];
  for (const [key, value] of items) {map.set(key, value);expected.set(key, value);}
  map.set('a', false);expected.set('a', false);
  assert.equal(map.delete('missing'), false);
  assert.equal(map.delete('b'), expected.delete('b'));
  map.set('b', -0);expected.set('b', -0);
  assert.deepEqual([...map], [...expected]);
  assert.deepEqual([...map.keys()], [...expected.keys()]);
  assert.deepEqual([...map.values()], [...expected.values()]);
  assert.deepEqual([...map.entries()], [...expected.entries()]);
  assert.equal(map.has('b'), true);assert.equal(map.has('missing'), false);
  assert.equal(map.get('missing'), undefined);
  set.add('a');set.add('b');set.add('a');set.delete('a');set.add('a');
  assert.deepEqual([...set], ['b', 'a']);
  assert.deepEqual([...set.values()], ['b', 'a']);
  assert.deepEqual([...set.entries()], [['b', 'b'], ['a', 'a']]);
  map.clear();assert.equal(map.size, 0);assert.deepEqual([...set], ['b', 'a']);
  assert.equal(pool.info().entries, 2);
});

test('NUL과 고립 UTF-16 surrogate를 서로 다른 문자열 키로 보관한다', t => {
  const pool = createProcessCollections({maxEntries:1});t.after(() => pool.close());
  const set = pool.set();
  const keys = ['a\0b', 'a', '\ud800', '\ud801', '\ufffd', '한글🙂'];
  for (const key of keys) set.add(key);
  assert.equal(set.size, keys.length);assert.deepEqual([...set], keys);
  for (const key of keys) assert(set.has(key));
});

test('항목 수가 작아도 바이트 상한을 넘으면 옮기고 큰 값은 그대로 읽는다', t => {
  const pool = createProcessCollections({maxBytes:100});t.after(() => pool.close());
  const map = pool.map(), value = '값'.repeat(1000);
  map.set('a', 'short');map.set('a', value);
  assert.equal(pool.info().storage, 'temporary');assert.equal(map.size, 1);
  assert.equal(map.get('a'), value);assert.equal(pool.info().serializedBytes, 0);
});

test('모음 값은 호출부가 보관 후 수정하지 않는 직렬화 값이다', t => {
  const pool = createProcessCollections();t.after(() => pool.close());
  const map = pool.map(), value = {delivery:'unknown'};
  map.set('a', value);value.delivery = 'sent';
  assert.deepEqual(map.get('a'), {delivery:'unknown'});
  const read = map.get('a');read.delivery = 'sent';
  assert.deepEqual(map.get('a'), {delivery:'unknown'});
});

test('임시 DB는 원장과 별개이며 새 연결과 종료 뒤 기억을 공유하지 않는다', t => {
  let db;
  const first = createProcessCollections({maxEntries:0, openDatabase:() => (db = new DatabaseSync(''))});
  const second = createProcessCollections({maxEntries:0});
  t.after(() => {first.close();second.close();});
  const a = first.set(), b = second.set();a.add('sent');b.add('other');
  assert.equal(b.has('sent'), false);
  assert.equal(db.prepare('PRAGMA cache_size').get().cache_size, -512);
  assert.equal(db.prepare('PRAGMA temp_store').get().temp_store, 1);
  assert.equal(db.prepare('PRAGMA database_list').get().file, '');
  first.close();first.close();assert.equal(db.isOpen, false);
  assert.throws(() => a.has('sent'), /닫혔습니다/);
  assert.equal(b.has('other'), true);
});

test('이동 실패나 DB 쓰기 실패 뒤에는 빈 기억으로 재시도하지 않는다', t => {
  const missing = createProcessCollections({maxEntries:1, openDatabase:() => {throw Error('disk denied');}});
  t.after(() => missing.close());
  const a = missing.set();a.add('first');
  assert.throws(() => a.add('second'), /중복 방지 상태/);
  assert.throws(() => a.has('first'), /중복 방지 상태/);
  let db;
  const pool = createProcessCollections({maxEntries:0, openDatabase:() => (db = new DatabaseSync(''))});
  t.after(() => pool.close());
  const b = pool.set();b.add('sent');
  db.exec("CREATE TRIGGER reject_write BEFORE INSERT ON entries BEGIN SELECT RAISE(FAIL,'disk failed'); END");
  assert.throws(() => b.add('new'), /중복 방지 상태/);
  assert.throws(() => b.has('sent'), /중복 방지 상태/);
  assert.throws(() => b.delete('sent'), /중복 방지 상태/);
});

test('큰 기억의 계측도 표본 상한을 지키고 iteration을 닫은 뒤 계속 쓸 수 있다', t => {
  const pool = createProcessCollections();t.after(() => pool.close());
  const set = pool.set();for (let i = 0; i < 2500; i++) set.add(`sent-${i}`);
  const stats = collectionStats(set);
  assert.equal(stats.entries, 2500);assert.equal(stats.sampledEntries, 1000);
  assert.equal(stats.complete, false);assert.equal(stats.storage, 'temporary');
  assert.equal(stats.retainedEntries, 0);assert(stats.serializedBytes <= 256 * 1024);
  set.add('next');assert.equal(set.size, 2501);
  assert.equal(processCollectionInfo(new Set()), undefined);
});
