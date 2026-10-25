import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {dashboardFixture} from './helpers/dashboard-fixture.mjs';
import {createDashboardStoreReader} from '../src/dashboard-store-reader.mjs';
import {createWatchStoreReaders} from '../src/watch-store-cache.mjs';
import {appendStream, storagePath} from '../src/storage.mjs';

// 변경 없는 요청은 heads만 읽는다: 준비된 SQL 중 events 표를 읽는 문장이 없어야 한다.
function recordStatements(run) {
  const prepare = DatabaseSync.prototype.prepare, sqls = [];
  DatabaseSync.prototype.prepare = function (sql) {sqls.push(String(sql).replace(/\s+/g, ' '));return prepare.call(this, sql);};
  try {run();} finally {DatabaseSync.prototype.prepare = prepare;}
  return sqls;
}
const readers = f => ({
  dashboard: createDashboardStoreReader(f.home, 'cards'),
  watch: createWatchStoreReaders(f.home).cards,
});
const touchesEvents = sqls => sqls.filter(sql => /\bevents\b/i.test(sql));

test('변경 없는 읽기는 events를 읽지 않고, 한 카드만 바뀌면 그 스트림만 대조한다', () => {
  for (const [name, reader] of Object.entries(readers(dashboardFixture({count: 3})))) {
    reader.read();
    assert.deepEqual(touchesEvents(recordStatements(() => reader.read())), [], name);
  }
  const f = dashboardFixture({count: 3}), made = readers(f);
  for (const [name, reader] of Object.entries(made)) {
    const before = reader.read();
    appendStream(f.home, 'cards/demo/card-1/events.jsonl',
      {...before.find(c => c.key === 'demo/card-1'), revision: before.find(c => c.key === 'demo/card-1').revision + 1,
        title: `바뀜 ${name}`});
    const sqls = recordStatements(() => reader.read());
    assert.ok(touchesEvents(sqls).length > 0, `${name}: 바뀐 스트림은 events와 대조한다`);
    assert.equal(reader.read().find(c => c.key === 'demo/card-1').title, `바뀜 ${name}`);
  }
});

test('같은 순번에서 head payload만 바뀌면 지문이 달라져 다음 읽기에서 거절한다', () => {
  for (const name of ['dashboard', 'watch']) {
    const f = dashboardFixture({count: 2}), reader = readers(f)[name];
    reader.read();
    const db = new DatabaseSync(storagePath(f.home));
    db.exec("UPDATE heads SET payload=json_set(payload,'$.title','손상') WHERE stream='cards/demo/card-1/events.jsonl'");
    db.close();
    assert.throws(() => reader.read(), /이력 손상/, name);
  }
});

test('알려진 한계: head를 그대로 두고 과거 events만 고친 손상은 파일 교체·새 reader 때만 잡힌다', () => {
  for (const name of ['dashboard', 'watch']) {
    const f = dashboardFixture({count: 2}), reader = readers(f)[name];
    reader.read();
    const db = new DatabaseSync(storagePath(f.home));
    db.exec('DROP TRIGGER events_no_update'); // 한계의 전제: 트리거를 끈 직접 수정
    db.exec("UPDATE events SET payload=json_set(payload,'$.title','몰래 수정') "
      + "WHERE stream='cards/demo/card-1/events.jsonl' AND seq=(SELECT max(seq) FROM events WHERE stream='cards/demo/card-1/events.jsonl')");
    db.close();
    assert.doesNotThrow(() => reader.read(), `${name}: 같은 reader는 변경 없는 스트림을 다시 대조하지 않는다`);
    assert.throws(() => readers(f)[name].read(), /이력 손상/, `${name}: 새 reader의 첫 적재는 전체를 대조한다`);
  }
});

test('파일 교체는 지문이 같아도 전체 대조로 복구한다', () => {
  const a = dashboardFixture({count: 2}), b = dashboardFixture({count: 2});
  const reader = createDashboardStoreReader(a.home, 'cards');
  reader.read();
  fs.renameSync(storagePath(a.home), path.join(a.home, 'previous.sqlite'));
  const db = new DatabaseSync(storagePath(b.home));
  db.exec('DROP TRIGGER events_no_update');
  db.exec("UPDATE events SET payload=json_set(payload,'$.title','교체본 손상') WHERE stream='cards/demo/card-1/events.jsonl'");
  db.close();
  fs.copyFileSync(storagePath(b.home), storagePath(a.home));
  assert.throws(() => reader.read(), /이력 손상/);
});
