import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTree } from '../src/cli-tree.mjs';
import { centerSummary } from '../src/center-summary.mjs';
import { buildCardCenter } from '../src/card-center.mjs';
import { roleLineage } from '../src/role-lineage.mjs';
import { startDigest } from '../src/secretary-resume.mjs';

// 고정 입력. 시험 역할 이름은 운영 이름을 쓰지 않는다.
const T = (n) => `2036-11-02T00:${String(n).padStart(2, '0')}:00Z`;
const start = (role, n, extra = {}) => ({ kind: 'start', role, session: `kadan-${role}`, panePid: 100 + n, t: T(n), ...extra });

// tree → center → centerSummary까지 실제 경로를 지난 liveRoles 한 칸을 본다.
function live(entries, roles) {
  const alive = Object.fromEntries(roles.map((r, i) => [`kadan-${r}`, { pid: 900 + i, alive: true }]));
  const tree = buildTree(entries, alive, []);
  const center = buildCardCenter({ cards: [], entries, tree });
  const lineage = roleLineage(entries);
  const flat = tree.flatMap((b) => b.roles).map((r) => ({ ...r, supersedes: lineage.get(r.role) ?? [] }));
  return Object.fromEntries(centerSummary({ ...center, roles: flat }).liveRoles.map((r) => [r.role, r]));
}

test('restart: 새 start의 restartOf로 옛 start를 찾아 panePid·로티 탭·대화를 담는다', () => {
  const old = start('세대-가', 1, { rottieTerminalId: 'term-A', conversationMode: 'resume', conversationRef: 'conv-old' });
  const next = start('세대-가', 5, { restartOf: startDigest(old), restartConversation: 'conv-X' });
  const got = live([old, next], ['세대-가'])['세대-가'].supersedes;
  assert.deepEqual(got, [{ source: 'restart', rottieTerminalId: 'term-A', panePid: '101', conversation: 'conv-X' }]);
});

test('restart: 옛 start에 대화가 적혀 있고 restartConversation이 없으면 옛 값, fork 대화는 쓰지 않는다', () => {
  const old = start('세대-나', 1, { conversationMode: 'fork', conversationRef: 'parent' });
  const next = start('세대-나', 5, { restartOf: startDigest(old) });
  assert.deepEqual(roleLineage([old, next]).get('세대-나'),
    [{ source: 'restart', rottieTerminalId: null, panePid: '101', conversation: null }]);
});

test('restart: 못 찾는 지문이면 담지 않는다(추측 금지)', () => {
  const next = start('세대-다', 5, { restartOf: 'deadbeef' });
  assert.deepEqual(live([start('세대-다', 1), next], ['세대-다'])['세대-다'].supersedes, []);
});

test('adopt: accepted의 sourceTerminalId를 받는 역할에 담는다. 값이 없으면 담지 않는다', () => {
  const entries = [
    start('세대-라', 1),
    { kind: 'adopt', phase: 'accepted', role: '세대-라', adoptionId: 'a1', sourceTerminalId: 'term-T', t: T(2) },
    { kind: 'adopt', phase: 'finished', role: '세대-라', adoptionId: 'a1', t: T(3) },
    { kind: 'adopt', phase: 'accepted', role: '세대-마', adoptionId: 'a2', sourceTerminalId: null, t: T(4) },
  ];
  const got = live(entries, ['세대-라', '세대-마']);
  assert.deepEqual(got['세대-라'].supersedes, [{ source: 'adopt', rottieTerminalId: 'term-T', panePid: null, conversation: null }]);
  assert.deepEqual(got['세대-마'].supersedes, []);
});

test('handover: complete면 from의 마지막 start 값을 to에 담고, aborted는 담지 않는다', () => {
  const from = start('세대-바', 1, { rottieTerminalId: 'term-B', conversationMode: 'resume', conversationRef: 'conv-B' });
  const entries = [from, start('세대-사', 2),
    { kind: 'handover', phase: 'transferred', handoverId: 'h1', from: '세대-바', to: '세대-사', t: T(3) },
    { kind: 'handover', phase: 'complete', handoverId: 'h1', from: '세대-바', to: '세대-사', t: T(4) },
    { kind: 'handover', phase: 'aborted', handoverId: 'h2', from: '세대-바', to: '세대-아', t: T(5) }];
  const got = roleLineage(entries);
  assert.deepEqual(got.get('세대-사'), [{ source: 'handover', rottieTerminalId: 'term-B', panePid: '101', conversation: 'conv-B' }]);
  assert.equal(got.has('세대-아'), false);
});

test('두 번 restart: 사슬 2개, 가까운 것부터. 11번째부터는 자른다', () => {
  const s1 = start('세대-자', 1, { rottieTerminalId: 'term-1' });
  const s2 = start('세대-자', 2, { restartOf: startDigest(s1), rottieTerminalId: 'term-2' });
  const s3 = start('세대-자', 3, { restartOf: startDigest(s2) });
  assert.deepEqual(roleLineage([s1, s2, s3]).get('세대-자').map((x) => x.rottieTerminalId), ['term-2', 'term-1']);
  const chain = [start('세대-차', 0, { rottieTerminalId: 't0' })];
  for (let i = 1; i <= 12; i++) chain.push(start('세대-차', i, { restartOf: startDigest(chain.at(-1)), rottieTerminalId: `t${i}` }));
  const got = roleLineage(chain).get('세대-차');
  assert.equal(got.length, 10);
  assert.equal(got[0].rottieTerminalId, 't11');
});

test('교체 없음 → 빈 목록(null 아님)', () => {
  const got = live([start('세대-카', 1)], ['세대-카'])['세대-카'];
  assert.deepEqual(got.supersedes, []);
});

test('원장 읽기 불변: 받은 사건 배열을 한 번만 훑고 다른 것을 읽지 않는다', () => {
  const entries = [start('세대-타', 1), start('세대-타', 2)];
  let walks = 0;
  const counted = new Proxy(entries, { get(target, key, receiver) {
    if (key === 'forEach') walks++;
    if (key === Symbol.iterator || key === 'map' || key === 'filter' || key === 'reduce') walks += 100;
    return Reflect.get(target, key, receiver);
  } });
  roleLineage(counted);
  assert.equal(walks, 1);
});
