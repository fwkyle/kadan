import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {WorkStore} from '../src/work-store.mjs';
import {appendStream, createDatabase, writeStorageMarker, readStream} from '../src/storage.mjs';
import {effectiveWorkOwnership, withEffectiveOwner} from '../src/handover-state.mjs';
import {buildWatchScope, buildSupervisorScope} from '../src/watch-scope.mjs';
import {assessSupervisorIdle} from '../src/watch-supervisor.mjs';

const at = n => new Date(Date.UTC(2020, 0, 1, n)).toISOString();
const key = 'r/work';
const stream = `works/${key}/events.jsonl`;
function setup(mode, patches) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-work-summary-'));
  if (mode === 'sqlite') { createDatabase(home); writeStorageMarker(home, mode); }
  let previous = {key, title: '업무', scope: '범위', acceptance: '완료 기준',
    owner: 'boss-a', status: 'open', executions: [{key: 'r/card'}], mailRefs: [],
    action: 'create', goal: 'large body '.repeat(100), progress: 'large progress '.repeat(100)};
  patches.forEach((patch, i) => {
    previous = {...previous, action: 'update', at: at(i), ...patch, revision: i + 1};
    appendStream(home, stream, previous);
  });
  return {home, store: new WorkStore(home)};
}
const parents = new Map([['worker', 'boss-a'], ['boss-a', 'top'], ['boss-b', 'top'], ['top', '@user']]);
const cards = [{key: 'r/card', id: 'card', status: 'assigned', role: 'worker', at: at(0), history: []}];
const entries = [
  {kind: 'send', taskId: 'card', executionKey: 'r/card', role: 'worker', by: 'boss-a', t: at(1)},
  {kind: 'done', taskId: 'card', executionKey: 'r/card', role: 'worker', result: 'ok', t: at(2)},
  {kind: 'handover', phase: 'transferred', from: 'boss-a', to: 'boss-b', t: at(3)},
];
function decisions(works, events = entries) {
  const effective = works.map(w => withEffectiveOwner(w, events));
  return {
    ownership: works.map(w => effectiveWorkOwnership(w, events)),
    worker: buildWatchScope(cards, events, parents, effective),
    supervisor: buildSupervisorScope(cards, events, parents, effective),
    idle: assessSupervisorIdle(events, new Map(), Date.parse(at(20)), 60_000, null, parents,
      {works: effective, cards, liveRoleSessions: new Set()}),
  };
}

for (const mode of ['new-home', 'sqlite']) {
  test(`${mode}: 업무 요약은 교대·같은 이름 재배정·재개 판정과 원장을 보존한다`, () => {
    const patches = [
      {action: 'create'}, {}, {owner: 'boss-b'}, {owner: 'boss-a'},
      {ownerAssignedAt: at(4)}, {action: 'reopen'}, {}, {status: 'hold'}, {status: 'done'},
    ];
    const {home, store} = setup(mode, patches);
    const before = readStream(home, stream);
    const full = store.list(), summary = store.listWatch();
    assert.deepEqual(decisions(summary), decisions(full));
    for (const w of summary) {
      assert.ok(w.history.length <= 4);
      assert.ok(w.history.every(h => !('goal' in h) && !('executions' in h)));
      const {history: a, ...aMeta} = w;
      const {history: b, ...bMeta} = full.find(x => x.key === w.key);
      assert.deepEqual(aMeta, bMeta);
    }
    assert.deepEqual(readStream(home, stream), before);
    assert.deepEqual(store.list(), full, '상세 이력 조회는 그대로');
    assert.notDeepEqual(decisions(full.map(({history, ...w}) => w)), decisions(full),
      '이력을 무작정 빼면 달라지는 대조군');
  });

  test(`${mode}: 여러 순서·시각·상태의 요약 판정이 전체 이력과 같다`, () => {
    // 각 접두 이력을 실제 저장소에서 읽는다. 짧은 결정적 조합이며 실행기나 AI는 호출하지 않는다.
    const variants = [
      {action: 'create'}, {}, {owner: 'boss-b'}, {}, {action: 'reopen'},
      {owner: 'boss-a'}, {ownerAssignedAt: at(6)}, {ownerAssignedAt: null},
      {owner: null}, {owner: undefined}, {owner: 'boss-b', ownerAssignedAt: 'invalid'},
      {action: 'create', at: null}, {status: 'hold'}, {status: 'open'},
    ];
    for (let size = 1; size <= variants.length; size++) {
      const {store} = setup(mode, variants.slice(0, size));
      assert.deepEqual(decisions(store.listWatch()), decisions(store.list()), `prefix ${size}`);
      assert.deepEqual(decisions(store.listWatch(), []), decisions(store.list(), []), `no handover ${size}`);
    }
  });

  for (const invalid of [{revision: 9}, {revision: '2'}, {key: 'r/wrong'}, {executions: {}}, {mailRefs: null}]) {
    test(`${mode}: 과거 행 손상을 요약에서도 거절: ${JSON.stringify(invalid)}`, () => {
      const {home, store} = setup(mode, [{action: 'create'}]);
      const first = store.get(key);
      appendStream(home, stream, {...first, revision: 2, ...invalid});
      appendStream(home, stream, {...first, revision: 3});
      assert.throws(() => store.list(), /이력 손상/);
      assert.throws(() => store.listWatch(), /이력 손상/);
    });
  }
}

test("저장소 없는 'none' 홈의 읽기는 빈 결과이고 홈을 바꾸지 않으며, 옛 JSONL 표시는 변환 안내 오류다", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-work-summary-empty-'));
  const store = new WorkStore(home);
  assert.deepEqual(store.listWatch(), []);
  assert.deepEqual(fs.readdirSync(home), [], '읽기로 저장소를 만들지 않는다');
  // 'none' 홈은 fs·DB를 보지 않으므로 고아 폴더가 있어도 예외 없이 빈 결과다.
  fs.mkdirSync(path.join(home, 'works', 'r', 'orphan'), {recursive: true});
  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.listWatch(), []);
  assert.deepEqual(fs.readdirSync(home), ['works'], '읽기가 홈을 바꾸지 않는다');
  assert.deepEqual(fs.readdirSync(path.join(home, 'works', 'r')), ['orphan']);
  fs.rmSync(path.join(home, 'works'), {recursive: true});
  writeStorageMarker(home, 'jsonl');
  assert.throws(() => store.list(), /jsonl-last/);
  assert.throws(() => store.listWatch(), /jsonl-last/);
});

test('sqlite: 최신 업무와 압축 이력은 동시 쓰기에도 같은 읽기 스냅샷이다', () => {
  const {home, store} = setup('sqlite', [{action: 'create'}, {action: 'reopen'}]);
  const before = store.listWatch();
  const original = DatabaseSync.prototype.prepare;
  let raced = false;
  DatabaseSync.prototype.prepare = function(sql, ...args) {
    if (!raced && sql.includes('SELECT e.stream, e.seq')) {
      raced = true;
      const code = `import {WorkStore} from ${JSON.stringify(new URL('../src/work-store.mjs', import.meta.url).href)};
        new WorkStore(process.env.KADAN_HOME).change('r/work','update',{owner:'new-owner'},
          {revision:2,note:'concurrent write'});`;
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        env: {...process.env, KADAN_HOME: home}, encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(run.status, 0, run.stderr);
    }
    return original.call(this, sql, ...args);
  };
  try { assert.deepEqual(store.listWatch(), before); }
  finally { DatabaseSync.prototype.prepare = original; }
  assert.equal(raced, true);
  assert.equal(store.get(key).owner, 'new-owner');
  assert.equal(store.listWatch()[0].revision, 3, '다음 조회는 새 사건을 본다');
});
