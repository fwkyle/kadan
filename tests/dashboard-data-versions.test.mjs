import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {dashboardFixture} from './helpers/dashboard-fixture.mjs';
import {dashboardDataVersions} from '../src/dashboard-data-versions.mjs';
import {createTreeInputCache} from '../src/dashboard-tree-inputs.mjs';
import {buildTree} from '../src/cli-tree.mjs';
import {buildCardCenter} from '../src/card-center.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {loadWallSnapshot} from '../src/commands/tree-wall.mjs';
import {wallCache} from '../src/wall-snapshot-cache.mjs';
import {floor} from '../src/floor.mjs';

test('원장·카드·업무 버전이 분리되며 본문 파일 수정도 놓치지 않는다', () => {
  const f = dashboardFixture({count: 2});
  const a = dashboardDataVersions(f.home);
  appendLedger({kind: 'watch-cycle', timing: {totalMs: 1}}, f.home);
  const b = dashboardDataVersions(f.home);
  assert.notEqual(b.all, a.all);assert.equal(b.cards, a.cards);assert.equal(b.works, a.works);
  const card = f.cards.get('demo/card-1');
  f.cards.update(card.key, {title: '새 제목'}, {revision: card.revision, note: '수정'});
  const c = dashboardDataVersions(f.home);
  assert.notEqual(c.cards, b.cards);assert.equal(c.works, b.works);
  const work = f.works.get('demo/dashboard');
  f.works.change(work.key, 'update', {progress: '새 진행'}, {revision: work.revision, note: '진행'});
  const d = dashboardDataVersions(f.home);
  assert.equal(d.cards, c.cards);assert.notEqual(d.works, c.works);
  fs.writeFileSync(path.join(f.home, 'cards/demo/card-1/card.md'), '# 본문 파일만 변경');
  const e = dashboardDataVersions(f.home);
  assert.notEqual(e.cards, d.cards);assert.equal(e.works, d.works);
});

test('역할 트리 입력은 확정 인계·별칭·첫 완료·비정규 세션과 오류를 그대로 계산한다', () => {
  const f = dashboardFixture({count: 2}), cards = f.cards.list(), select = createTreeInputCache();
  const live = {'kadan-worker': {pid: 42}, 'kadan-비서': {pid: 52}, custom: {pid: 62}};
  const changes = [
    {kind: 'start', role: 'worker', session: 'kadan-worker', pid: 41, t: '2020-01-01'},
    {kind: 'plan', taskId: 'card-1', board: 'b'},
    {kind: 'send', role: 'worker', taskId: 'demo/card-1', t: '2020-01-02'},
    {kind: 'done', role: 'worker', taskId: 'card-1', result: 'ok', t: '2020-01-03'},
    {kind: 'done', role: 'worker', taskId: 'demo/card-1', result: 'failed', t: '2020-01-04'},
    {kind: 'send', role: 'worker', taskId: 'card-2', t: '2020-01-05'},
    {kind: 'handover', phase: 'transferred', from: 'worker', to: '비서',
      taskIds: ['demo/card-1', 'card-2'], t: '2020-01-06'},
    {kind: 'note', role: 'other', session: 'kadan-비서'},
    {kind: 'send', role: '비서', session: 'custom', transport: 'mailbox'},
    {kind: 'start', role: '비서', session: 'custom', pid: 62},
    {kind: 'watch-cycle', timing: {totalMs: 2}},
    {kind: 'watch-scope', sessions: ['kadan-worker']},
    {kind: 'note', text: '역할 없는 기록'},
  ];
  let entries = [];
  for (const entry of changes) {
    entries = entries.concat(entry);
    const reduced = select(entries).entries;
    const fullTree = buildTree(entries, live, cards), tree = buildTree(reduced, live, cards);
    assert.deepEqual(tree, fullTree);
    assert.deepEqual(buildCardCenter({cards, entries: reduced, tree}),
      buildCardCenter({cards, entries, tree: fullTree}));
  }
  const a = select(entries), b = select(entries.concat({kind: 'watch-cycle'}));
  assert.strictEqual(b.entries, a.entries);assert.equal(b.revision, a.revision);
  const restored = select(JSON.parse(JSON.stringify(entries)));
  assert.notEqual(restored.revision, b.revision);assert.deepEqual(restored.entries, a.entries);
  const broken = select(entries.concat({broken: true})).entries;
  assert.throws(() => buildCardCenter({cards, entries: broken, tree: []}), /원장 손상/);
});

test('순회 사건만 추가되면 카드·업무·트리·카드 상태 계산을 재사용하고 원장은 갱신한다', () => {
  const f = dashboardFixture({count: 2});process.env.KADAN_HOME = f.home;
  const original = floor.list;floor.list = () => [];
  wallCache.clear();
  try {
    const a = loadWallSnapshot(), counts = wallCache.stats();
    appendLedger({kind: 'watch-cycle', timing: {totalMs: 7}}, f.home);
    const b = loadWallSnapshot();
    for (const name of ['cards', 'works', 'tree', 'center']) {
      assert.equal(wallCache.stats()[name].miss, counts[name].miss, name);
    }
    assert.equal(b.entries.length, a.entries.length + 1);
    assert.equal(b.centerKey, a.centerKey);assert.notEqual(b.workModelKey, a.workModelKey);
    const tree = buildTree(b.entries, {}, f.cards.list());
    const expected = buildCardCenter({cards: f.cards.list(), entries: b.entries, tree});
    assert.deepEqual(b.center.cards, expected.cards);
    appendLedger({kind: 'note', role: 'new-role'}, f.home);
    assert.notEqual(loadWallSnapshot().centerKey, b.centerKey);
  } finally { floor.list = original; }
});

test('옛 카드 첨부 본문은 그 필드를 요청할 때만 읽고 같은 수집에서는 한 번만 읽는다', () => {
  const f = dashboardFixture({count: 2});process.env.KADAN_HOME = f.home;wallCache.clear();
  const file = path.join(f.home, 'old-card.md');fs.writeFileSync(file, '# 과거 카드 본문');
  appendLedger({kind: 'send', role: 'qa-worker', taskId: 'old-card', originalCardPath: file}, f.home);
  const original = fs.readFileSync;let reads = 0;
  fs.readFileSync = function(name, ...args) {
    if (name === file) reads++;
    return original.call(this, name, ...args);
  };
  try {
    const snapshot = loadWallSnapshot();assert.equal(reads, 0);
    assert.equal(snapshot.cardFiles['old-card'].text, '# 과거 카드 본문');assert.equal(reads, 1);
    assert.strictEqual(snapshot.cardFiles, snapshot.cardFiles);assert.equal(reads, 1);
  } finally { fs.readFileSync = original; }
});
