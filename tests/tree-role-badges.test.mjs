import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CardStore } from '../src/card-store.mjs';
import { buildTree } from '../src/cli-tree.mjs';
import { buildCardCenter } from '../src/card-center.mjs';
import { centerSummary } from '../src/center-summary.mjs';
import { executionKindByRole } from '../src/role-execution-kind.mjs';
import { createWallSnapshotLoader } from '../src/commands/tree-wall.mjs';

// 격리 홈, 고정 입력. 시험 역할 이름은 운영 이름을 쓰지 않는다.
// 카드 수정 시각(지금)보다 뒤여야 카드 센터가 실행 기록을 최신으로 본다.
const T = (n) => `2036-11-02T00:${String(n).padStart(2, '0')}:00Z`;
const alive = (...roles) => Object.fromEntries(roles.map((r, i) => [`kadan-${r}`, { pid: 100 + i, alive: true }]));
const start = (role, n, extra = {}) => ({ kind: 'start', role, session: `kadan-${role}`, panePid: 100, t: T(n), ...extra });

// 카드 하나를 role에 배정한다. 반환: { cards, taskId }
function assigned(store, home, id, role, step, boardName = 'b') {
  const c = store.create({ repo: 'repo', id, repoPath: home, body: `# ${id}` });
  const r = store.update(c.key, { status: 'ready', scope: '범위' }, { revision: 1, note: '승인' });
  return store.update(c.key, { status: 'assigned', role, board: boardName, rallyId: 'w', rallyTitle: 'w', rallyRound: '1', rallyStep: step },
    { revision: r.revision, note: '배정' });
}
const send = (role, taskId, n) => ({ kind: 'send', role, taskId, board: 'b', t: T(n) });
const done = (role, taskId, n) => ({ kind: 'done', role, taskId, result: 'ok', t: T(n) });
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-badge-'));

function liveRolesOf({ entries, cards, works = [], aliveRoles }) {
  const tree = buildTree(entries, alive(...aliveRoles), cards);
  const cached = buildCardCenter({ cards, entries, tree });
  const kinds = executionKindByRole(cached.cards, works);
  const roles = tree.flatMap((b) => b.roles).map((r) => ({ ...r, executionKind: kinds.get(r.role) ?? null }));
  return Object.fromEntries(centerSummary({ ...cached, roles }).liveRoles.map((r) => [r.role, r]));
}

test('roleProfile: 마지막 start 값, 옛 start·start 없음은 null', () => {
  const entries = [start('배지-검수', 1, { roleProfile: 'reviewer' }), start('배지-옛', 2), start('배지-기반', 3, { roleProfile: undefined })];
  const live = liveRolesOf({ entries, cards: [], aliveRoles: ['배지-검수', '배지-옛', '배지-기반', '배지-없음'] });
  assert.equal(live['배지-검수'].roleProfile, 'reviewer');
  assert.equal(live['배지-옛'].roleProfile, null);
  assert.equal(live['배지-기반'].roleProfile, null);
  assert.equal(live['배지-없음'].roleProfile, null);
  assert.equal(live['배지-검수'].executionKind, null);
});

test('roleProfile: 같은 세션이 다른 프로필로 다시 시작되면 마지막 값', () => {
  const entries = [start('배지-작업', 1, { roleProfile: 'worker' }), start('배지-작업', 5, { roleProfile: 'reviewer' })];
  assert.equal(liveRolesOf({ entries, cards: [], aliveRoles: ['배지-작업'] })['배지-작업'].roleProfile, 'reviewer');
});

test('executionKind: 미완료 배정 review면 review, done이면 null', () => {
  const h = home(), store = new CardStore(h);
  const card = assigned(store, h, 'k-review', '배지-검수', 'review');
  const base = [start('배지-검수', 1, { roleProfile: 'reviewer' }), { kind: 'plan', taskId: 'k-review', board: 'b', t: T(2) }, send('배지-검수', 'k-review', 3)];
  assert.equal(liveRolesOf({ entries: base, cards: [card], aliveRoles: ['배지-검수'] })['배지-검수'].executionKind, 'review');
  const finished = [...base, done('배지-검수', 'k-review', 4)];
  assert.equal(liveRolesOf({ entries: finished, cards: [card], aliveRoles: ['배지-검수'] })['배지-검수'].executionKind, null);
});

test('executionKind: 업무 연결의 phase가 있으면 그 값(release·other 포함), 미완료 둘이면 가장 최근 발령', () => {
  const h = home(), store = new CardStore(h);
  const older = assigned(store, h, 'k-old', '배지-작업', 'implementation');
  const newer = assigned(store, h, 'k-new', '배지-작업', 'implementation');
  const entries = [start('배지-작업', 1, { roleProfile: 'worker' }),
    { kind: 'plan', taskId: 'k-old', board: 'b', t: T(2) }, send('배지-작업', 'k-old', 3),
    { kind: 'plan', taskId: 'k-new', board: 'b', t: T(4) }, send('배지-작업', 'k-new', 5)];
  const works = [{ key: 'repo/w', executions: [{ key: older.key, phase: 'implementation', round: 1 }, { key: newer.key, phase: 'release', round: 1 }] }];
  assert.equal(liveRolesOf({ entries, cards: [older, newer], works, aliveRoles: ['배지-작업'] })['배지-작업'].executionKind, 'release');
  // 최근 것이 끝나면 남은 미완료(오래된 것)가 나온다.
  const after = [...entries, done('배지-작업', 'k-new', 6)];
  assert.equal(liveRolesOf({ entries: after, cards: [older, newer], works, aliveRoles: ['배지-작업'] })['배지-작업'].executionKind, 'implementation');
});

test('원장·카드·업무 읽기 횟수는 두 칸을 더해도 한 번씩이다', () => {
  const h = home();
  process.env.KADAN_HOME = h;
  try {
    const loader = createWallSnapshotLoader(null, { listOnly: true });
    let reads = 0;
    const data = loader.read();
    reads += 1;
    const snapshot = loader.build(data);
    assert.equal(reads, 1);
    const summary = centerSummary(snapshot.center);
    assert.ok(Array.isArray(summary.liveRoles));
    for (const role of summary.liveRoles) assert.ok('roleProfile' in role && 'executionKind' in role);
  } finally {
    delete process.env.KADAN_HOME;
  }
});
