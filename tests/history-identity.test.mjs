import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createDatabase, writeStorageMarker, appendStream, storagePath} from '../src/storage.mjs';
import {CardStore} from '../src/card-store.mjs';
import {floor} from '../src/floor.mjs';
import {loadWallSnapshot} from '../src/commands/tree-wall.mjs';
import {wallCache} from '../src/wall-snapshot-cache.mjs';
import {dashboardData} from '../src/dashboard-api.mjs';
import {createDashboardStoreReader} from '../src/dashboard-store-reader.mjs';
import {hydrateHistory} from '../src/dashboard-card-history.mjs';

// 같은 끝 행(revision 3)을 가진 다른 DB 파일로 교체하되 과거 행(revision 2) 메모만 다르게 만든다.
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-history-identity-'));
  createDatabase(home);writeStorageMarker(home, 'sqlite');process.env.KADAN_HOME = home;
  const cards = new CardStore(home);
  cards.create({repo: 'demo', id: 'one', title: '독립 검수', repoPath: home, body: '# Why\n상세 근거 확인', by: '사람'});
  const first = cards.get('demo/one').history.at(-1);
  appendStream(home, 'cards/demo/one/events.jsonl',
    {...first, revision: 2, status: 'assigned', at: '2026-10-25T01:00:00Z', role: 'worker', note: '옛 배정 근거'});
  appendStream(home, 'cards/demo/one/events.jsonl',
    {...first, revision: 3, status: 'hold', at: '2026-10-25T01:01:00Z', role: 'worker', note: '끝 행은 동일'});
  const replace = () => {
    const file = storagePath(home), next = path.join(home, 'replacement.sqlite');
    fs.copyFileSync(file, next);
    const db = new DatabaseSync(next);
    db.exec('DROP TRIGGER events_no_update'); // 시험 사본에서만 append-only 트리거를 끈다
    db.exec("UPDATE events SET payload=json_set(payload,'$.note','새 파일의 다른 배정 근거') WHERE stream='cards/demo/one/events.jsonl' AND seq=2");
    db.close();
    fs.renameSync(file, path.join(home, 'previous.sqlite'));fs.renameSync(next, file);
  };
  return {home, replace};
}
const noteAt2 = history => history.find(h => h.revision === 2).note;

test('수집 뒤 DB 파일이 같은 끝 행의 다른 파일로 바뀌면 상세 이력 읽기를 거절한다', () => {
  const f = fixture();
  const row = createDashboardStoreReader(f.home, 'cards', {facts: true}).read()[0];
  assert.equal(noteAt2(hydrateHistory(row, f.home).history), '옛 배정 근거', '교체 전에는 읽힌다');
  f.replace();
  assert.throws(() => hydrateHistory(row, f.home), error => error.code === 'KADAN_HISTORY_CHANGED');
  // 새로 수집하면 새 파일이 기준이 되어 읽힌다(기존 한 번 재수집 경로)
  const fresh = createDashboardStoreReader(f.home, 'cards', {facts: true}).read()[0];
  assert.equal(noteAt2(hydrateHistory(fresh, f.home).history), '새 파일의 다른 배정 근거');
});

test('실제 상세 API 경로: 옛 snapshot에 교체 뒤의 과거 이유를 섞지 않고, 새 수집은 새 파일을 쓴다', () => {
  const f = fixture();
  const list = floor.list;floor.list = () => [];wallCache.clear();
  try {
    const collect = () => Object.assign(loadWallSnapshot(null, {listOnly: true, summaryBodies: true}), {home: f.home});
    const url = new URL('http://local/api/dashboard/detail?card=demo/one');
    const snapshot = collect();
    const before = dashboardData(snapshot, url);
    assert.ok(JSON.stringify(before.history).includes('옛 배정 근거'));
    f.replace();
    assert.throws(() => dashboardData(snapshot, url), error => error.code === 'KADAN_HISTORY_CHANGED');
    wallCache.clear();
    const after = dashboardData(collect(), url);
    assert.ok(JSON.stringify(after.history).includes('새 파일의 다른 배정 근거') && !JSON.stringify(after.history).includes('옛 배정 근거'));
    assert.equal(after.revision, before.revision);
  } finally {floor.list = list;wallCache.clear();}
});

test('파일이 그대로면 수집 뒤 정상 추가가 있어도 수집한 revision까지 읽는다', () => {
  const f = fixture();
  const row = createDashboardStoreReader(f.home, 'cards', {facts: true}).read()[0];
  appendStream(f.home, 'cards/demo/one/events.jsonl', {...new CardStore(f.home).get('demo/one'), history: undefined, revision: 4, at: '2026-10-25T01:02:00Z', note: '수집 뒤 추가'});
  const history = hydrateHistory(row, f.home).history;
  assert.equal(history.length, 3);
  assert.equal(history.at(-1).revision, 3);
});
