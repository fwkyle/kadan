import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {dashboardFixture} from './helpers/dashboard-fixture.mjs';
import {createDashboardStoreReader} from '../src/dashboard-store-reader.mjs';
import {hydrateHistory} from '../src/dashboard-card-history.mjs';
import {listFactsFromHistory} from '../src/card-list-facts.mjs';
import {workFactsFromHistory} from '../src/work-list-facts.mjs';
import {appendStream, storagePath} from '../src/storage.mjs';

const plain = JSON.parse;
const json = value => JSON.stringify(value, (k, v) => v instanceof Map ? [...v] : v);
const strip = ({listFacts, workFacts, historyRef, history, ...row}) => row;

test('facts 모드 목록 행은 이력 대신 사실과 이력 참조를 들고, 상세에서 같은 이력을 SQL로 다시 읽는다', () => {
  const f = dashboardFixture({count: 3});
  for (const kind of ['cards', 'works']) {
    const full = createDashboardStoreReader(f.home, kind).read();
    const lean = createDashboardStoreReader(f.home, kind, {facts: true}).read();
    assert.equal(lean.length, full.length);
    for (const [i, row] of lean.entries()) {
      assert.equal(row.history, undefined, `${kind}: 이력은 RAM에 두지 않는다`);
      assert.deepEqual(strip(row), strip(full[i]), `${kind}: 이력·사실·참조 말고는 같은 행`);
      const hydrated = hydrateHistory(row, f.home);
      assert.deepEqual(hydrated.history, full[i].history, `${kind}: 상세에서 읽은 이력`);
      const facts = kind === 'cards' ? listFactsFromHistory(full[i].history) : workFactsFromHistory(full[i].history);
      assert.equal(json(kind === 'cards' ? row.listFacts : row.workFacts), json(facts), `${kind}: 증분 사실 = 이력에서 만든 사실`);
    }
  }
});

test('새 사건을 받으면 이전 snapshot을 바꾸지 않고 사실만 이어 갱신하며 이력을 다시 들지 않는다', () => {
  const f = dashboardFixture({count: 2});
  const reader = createDashboardStoreReader(f.home, 'cards', {facts: true});
  const first = reader.read(), old = first[0], oldFacts = json(old.listFacts);
  appendStream(f.home, `cards/${old.key}/events.jsonl`,
    {...old, revision: old.revision + 1, title: '새 제목', noteKind: 'progress', by: old.role ?? '사람', note: '진행 보고',
      at: new Date(Date.parse(old.at) + 60_000).toISOString()});
  const second = reader.read();
  assert.equal(json(old.listFacts), oldFacts, '이미 낸 snapshot의 사실은 그대로');
  const row = second.find(c => c.key === old.key);
  assert.equal(row.revision, old.revision + 1);
  assert.equal(row.history, undefined);
  const hydrated = hydrateHistory(row, f.home);
  assert.equal(hydrated.history.length, old.revision + 1);
  assert.equal(json(row.listFacts), json(listFactsFromHistory(hydrated.history)));
  // 수집 뒤 같은 revision의 끝 행이 바뀌면 상세는 거절한다
  const db = new DatabaseSync(storagePath(f.home));
  db.exec('DROP TRIGGER events_no_update');
  db.exec(`UPDATE events SET payload=json_set(payload,'$.title','바꿈') WHERE stream='cards/${old.key}/events.jsonl' AND seq=${row.revision}`);
  db.close();
  assert.throws(() => hydrateHistory(row, f.home), error => error.code === 'KADAN_HISTORY_CHANGED');
});

test('한도를 넘어 값을 잃은 카드만 이력을 보관하고, 사실이 아니라 이력으로 같은 출력을 낸다', () => {
  const f = dashboardFixture({count: 2});
  const reader = createDashboardStoreReader(f.home, 'cards', {facts: true});
  const start = reader.read(), target = start[0], other = start[1];
  let row = {...target};
  // 명시 차례 행을 한도(3)보다 많이 쌓은 뒤, 가장 오래된 행의 revision을 현재 turnRevision으로 가리킨다
  for (let i = 0; i < 5; i++) {
    const revision = row.revision + 1;
    row = {...target, revision, at: new Date(Date.parse(target.at) - 86_400_000 + revision * 60_000).toISOString(), by: '사람',
      turnOwner: 'worker', turnRevision: revision, turnAt: undefined, turnBy: '사람'};
    row.turnAt = row.at;
    delete row.history;delete row.listFacts;delete row.historyRef;delete row.bodySummary;delete row.path;delete row.resultPath;delete row.evidenceDir;
    appendStream(f.home, `cards/${target.key}/events.jsonl`, row);
  }
  const first = reader.read().find(c => c.key === target.key);
  assert.equal(first.history, undefined, '현재 turnRevision이 한도 안이면 이력은 필요 없다');
  appendStream(f.home, `cards/${target.key}/events.jsonl`,
    {...row, revision: row.revision + 1, at: new Date(Date.parse(row.at) + 60_000).toISOString(), turnRevision: target.revision + 1, turnAt: row.turnAt});
  const after = reader.read();
  const kept = after.find(c => c.key === target.key), plainOne = after.find(c => c.key === other.key);
  assert.ok(Array.isArray(kept.history) && kept.history.length === kept.revision, '값을 잃은 카드는 이력 전체를 든다');
  assert.equal(kept.listFacts, undefined);
  assert.equal(plainOne.history, undefined);
  assert.equal(reader.info().reloaded >= 1, true, '이전에 놓은 이력은 그 스트림만 다시 읽는다');
});
