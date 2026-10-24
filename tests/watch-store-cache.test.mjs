import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {CardStore} from '../src/card-store.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {createWatchStoreReaders} from '../src/watch-store-cache.mjs';
import {appendRow, appendStream, readStream, storagePath, transaction} from '../src/storage.mjs';
import {effectiveWorkOwnership} from '../src/handover-state.mjs';
import {buildCardCenter} from '../src/card-center.mjs';

const at = n => new Date(Date.UTC(2020, 0, 1, n)).toISOString();
function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-summary-cache-'));
  return {home, cards: new CardStore(home), works: new WorkStore(home), readers: createWatchStoreReaders(home)};
}
function append(home, kind, key, patch) {
  const stream = `${kind}/${key}/events.jsonl`;
  const rows = readStream(home, stream, {optional: true});
  const value = {key, revision: rows.length + 1, at: at(rows.length), ...patch};
  appendStream(home, stream, value);
  return value;
}
const cardPatch = {status: 'assigned', role: 'worker', repo: 'r', id: 'card'};
const workPatch = {owner: 'boss', action: 'create', status: 'open', executions: [], mailRefs: []};
const normalized = cards => cards.map(c => ({...c, history: c.history ?? []}));

test('증분 요약은 열림·닫힘·재개와 업무 담당 경계에서 기존 전체 요약과 같다', () => {
  const {home, cards, works, readers} = setup();
  append(home, 'cards', 'r/card', cardPatch);
  append(home, 'works', 'r/work', workPatch);
  const unchanged = append(home, 'cards', 'r/other', {...cardPatch, id: 'other', status: 'done'});
  const entries = [
    {kind: 'send', role: 'worker', taskId: 'card', t: at(0)},
    {kind: 'done', role: 'worker', taskId: 'card', result: 'ok', t: at(2)},
    {kind: 'handover', phase: 'transferred', from: 'boss', to: 'boss2', t: at(3)},
  ];
  const patches = [
    {status: 'done'}, {status: 'ready'}, {status: 'assigned', owner: 'boss2'},
    {status: 'hold', owner: 'boss'}, {status: 'draft', ownerAssignedAt: at(4)},
    {status: 'assigned', action: 'reopen'}, {owner: null}, {owner: undefined},
    {owner: 'boss2', ownerAssignedAt: 'invalid'}, {action: 'create', at: null},
  ];
  let oldCards = readers.cards.read(), oldWorks = readers.works.read();
  for (const patch of patches) {
    const c = append(home, 'cards', 'r/card', {...cardPatch, ...patch});
    append(home, 'works', 'r/work', {...workPatch, ...patch});
    const nextCards = readers.cards.read(), nextWorks = readers.works.read();
    assert.deepEqual(nextCards, cards.listWatch());
    assert.deepEqual(nextWorks, works.listWatch());
    const center = rows => buildCardCenter({cards: normalized(rows), entries, tree: [], now: Date.parse(at(20))});
    assert.deepEqual(center(nextCards), center(cards.listWatch()));
    assert.deepEqual(nextWorks.map(w => effectiveWorkOwnership(w, entries)),
      works.list().map(w => effectiveWorkOwnership(w, entries)));
    assert.notStrictEqual(nextCards, oldCards, '버전마다 새 배열');
    assert.equal(oldCards.find(x => x.key === 'r/card').revision, c.revision - 1, '옛 snapshot 불변');
    assert.strictEqual(nextCards.find(x => x.key === unchanged.key), oldCards.find(x => x.key === unchanged.key));
    assert.notStrictEqual(nextWorks, oldWorks);
    oldCards = nextCards; oldWorks = nextWorks;
  }
  assert.equal(readers.cards.info().rows, 2 + patches.length);
  assert.equal(readers.works.info().rows, 1 + patches.length);
  assert.equal(readers.cards.info().full, 1);
  assert.equal(readers.works.info().full, 1);
});

test('무관한 사건·변경 없는 주기는 같은 요약을 재사용하고 새 카드는 발견한다', () => {
  const {home, readers, cards} = setup();
  append(home, 'cards', 'r/card', cardPatch);
  const first = readers.cards.read(), before = readers.cards.info();
  appendStream(home, 'system/events.jsonl', {kind: 'watch-cycle', t: at(0)});
  assert.strictEqual(readers.cards.read(), first);
  assert.equal(readers.cards.info().rows, before.rows);
  append(home, 'cards', 'r/new', {...cardPatch, id: 'new'});
  assert.deepEqual(readers.cards.read(), cards.listWatch());
  assert.equal(readers.cards.info().changed, 1);
});

test('뒤에 추가된 손상을 거절하고 실패한 조회의 부분 상태를 재사용하지 않는다', () => {
  for (const kind of ['cards', 'works']) {
    const {home, readers} = setup(), patch = kind === 'cards' ? cardPatch : workPatch;
    append(home, kind, 'r/a', patch); append(home, kind, 'r/z', patch);
    const first = readers[kind].read();
    append(home, kind, 'r/a', patch);
    append(home, kind, 'r/z', {...patch, revision: '2'});
    assert.throws(() => readers[kind].read(), /이력 손상/);
    assert.equal(first[0].revision, 1);
    assert.equal(readers[kind].info().streams, 0);
    assert.throws(() => readers[kind].read(), /이력 손상/);
  }
});

test('끝 행과 다른 head·새 사건의 순번 빈틈을 거절한다', () => {
  for (const sql of [
    "UPDATE heads SET payload=json_set(payload,'$.status','hold')",
    "INSERT INTO events(stream,seq,payload) SELECT stream,3,json_set(payload,'$.revision',3) FROM heads;"
      + "UPDATE heads SET seq=3,payload=json_set(payload,'$.revision',3)",
  ]) {
    const {home, readers} = setup();
    append(home, 'cards', 'r/card', cardPatch); readers.cards.read();
    const db = new DatabaseSync(storagePath(home)); db.exec(sql); db.close();
    assert.throws(() => readers.cards.read(), /이력 손상/);
  }
});

test('파일 교체는 같은 순번이어도 전체 검증으로 복구한다', () => {
  const a = setup(), b = setup();
  append(a.home, 'cards', 'r/card', {...cardPatch, title: 'before'});
  append(b.home, 'cards', 'r/card', {...cardPatch, title: 'after'});
  a.readers.cards.read();
  fs.renameSync(storagePath(a.home), path.join(a.home, 'previous.sqlite'));
  fs.copyFileSync(storagePath(b.home), storagePath(a.home));
  assert.deepEqual(a.readers.cards.read(), new CardStore(a.home).listWatch());
  assert.equal(a.readers.cards.read()[0].title, 'after');
  assert.equal(a.readers.cards.info().full, 2);
});

test('빈 홈에서 시작해 첫 쓰기를 발견하며 읽기 때문에 DB를 만들지 않는다', () => {
  const {home, readers} = setup();
  assert.deepEqual(readers.cards.read(), []); assert.deepEqual(readers.works.read(), []);
  assert.equal(fs.existsSync(storagePath(home)), false);
  append(home, 'works', 'r/work', workPatch);
  assert.equal(readers.works.read().length, 1);
});

test('증분 조회 중 동시 쓰기는 다음 snapshot에서 보인다', () => {
  const {home, readers} = setup();
  append(home, 'works', 'r/work', workPatch); readers.works.read();
  append(home, 'works', 'r/work', {...workPatch, owner: 'boss2'});
  transaction(home, db => {
    db.prepare('SELECT count(*) FROM heads').get(); // WAL snapshot 고정
    const script = `import {appendStream} from ${JSON.stringify(new URL('../src/storage.mjs', import.meta.url).href)};
      appendStream(process.env.KADAN_HOME,'works/r/work/events.jsonl',${JSON.stringify({
        key: 'r/work', ...workPatch, revision: 3, owner: 'boss3', at: at(3),
      })});`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script],
      {env: {...process.env, KADAN_HOME: home}, encoding: 'utf8', timeout: 10_000});
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readers.works.read()[0].owner, 'boss2');
  }, {readOnly: true});
  assert.equal(readers.works.read()[0].owner, 'boss3');
});

test('담당·누락·null의 256가지 교대 이력을 모든 접두 구간에서 전체 조회와 대조한다', () => {
  const {home, readers, works} = setup();
  const owners = ['boss', 'boss2', null, undefined];
  for (let revision = 1; revision <= 4; revision++) {
    transaction(home, db => {
      for (let n = 0; n < 256; n++) {
        const key = `r/w-${n}`;
        const owner = owners[Math.floor(n / 4 ** (revision - 1)) % 4];
        appendRow(db, `works/${key}/events.jsonl`, {key, ...workPatch, owner, revision,
          action: revision === 1 ? 'create' : (n % 3 === 0 ? 'reopen' : 'update'),
          ownerAssignedAt: n % 5 === 0 ? at(revision) : (n % 7 === 0 ? null : undefined),
          at: n % 11 === 0 ? null : (n % 13 === 0 ? 'invalid' : at(revision))});
      }
    });
    const actual = readers.works.read();
    assert.deepEqual(actual, works.listWatch(), `revision ${revision}`);
    assert.deepEqual(actual.map(w => effectiveWorkOwnership(w, [])),
      works.list().map(w => effectiveWorkOwnership(w, [])));
  }
  assert.equal(readers.works.info().rows, 1024);
});
