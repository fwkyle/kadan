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
  const nodes = tree.flatMap((b) => b.roles);
  const lineage = roleLineage(entries, nodes.filter((r) => r.life.state === 'alive'));
  const flat = nodes.map((r) => ({ ...r, supersedes: lineage.get(r.role) ?? [] }));
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

// ---- 독립 검수(exec-371db54d) 재현 4건 ----
const adoptOf = (role, terminal, n) => ({ kind: 'adopt', phase: 'accepted', role, adoptionId: `a-${role}-${n}`, sourceTerminalId: terminal, t: T(n) });
const liveOf = (role, pid) => ({ role, life: { state: 'alive', currentPid: pid } });

test('F1 이름 재사용: 연결 없는 독립 새 start에는 예전 업무의 교체 기록이 붙지 않는다', () => {
  const entries = [start('세대-파', 1), adoptOf('세대-파', 'term-original-a', 2),
    { kind: 'stop', role: '세대-파', t: T(3) },
    start('세대-파', 4, { cwd: '/repo-b' })];
  assert.deepEqual(roleLineage(entries, [liveOf('세대-파', 104)]).get('세대-파') ?? [], []);
  // 같은 start 뒤(다음 start 전)에 받은 adopt는 계속 붙는다.
  const kept = [start('세대-파', 1), start('세대-파', 4), adoptOf('세대-파', 'term-new', 5)];
  assert.deepEqual(roleLineage(kept).get('세대-파').map((x) => x.rottieTerminalId), ['term-new']);
});

test('F2 현재 값 빼기: 살아 있는 세대와 같은 panePid·terminal id·대화는 내주지 않는다', () => {
  const old = start('세대-하', 1, { panePid: 77, rottieTerminalId: 'term-past', conversationMode: 'resume', conversationRef: 'conv-same' });
  const next = start('세대-하', 2, { panePid: 77, rottieTerminalId: 'term-current', conversationMode: 'resume', conversationRef: 'conv-same',
    restartOf: startDigest(old), restartConversation: 'conv-same' });
  // pid·대화가 현재와 같으면 null, 옛 탭 id는 그대로 남는다.
  assert.deepEqual(roleLineage([old, next], [liveOf('세대-하', 77)]).get('세대-하'),
    [{ source: 'restart', rottieTerminalId: 'term-past', panePid: null, conversation: null }]);
  // 세 값이 모두 현재와 같으면 항목이 빠진다.
  const o2 = start('세대-히', 1, { panePid: 77, rottieTerminalId: 'term-x', conversationMode: 'resume', conversationRef: 'conv-same' });
  const n2 = { ...o2, t: T(2), restartOf: startDigest(o2), restartConversation: 'conv-same' };
  assert.equal(roleLineage([o2, n2], [liveOf('세대-히', 77)]).has('세대-히'), false);
  // 되살아난 source: 다른 살아 있는 역할이 같은 terminal id를 쓰면 target 목록에서 빠진다.
  const from = start('세대-거', 1, { rottieTerminalId: 'term-shared' });
  const to = start('세대-너', 2);
  const revived = start('세대-거', 5, { rottieTerminalId: 'term-shared' });
  const entries = [from, to, { kind: 'handover', phase: 'complete', handoverId: 'h9', from: '세대-거', to: '세대-너', t: T(3) }, revived];
  assert.equal(roleLineage(entries).get('세대-너').length, 1);
  assert.deepEqual(roleLineage(entries, [liveOf('세대-거', 105), liveOf('세대-너', 102)]).get('세대-너'),
    [{ source: 'handover', rottieTerminalId: null, panePid: '101', conversation: null }]);
});

test('F3 A→B→C 두 번 인계하면 A도 C의 목록에 가까운 것부터 이어진다', () => {
  const entries = [start('세대-에이', 1, { rottieTerminalId: 'term-A' }), start('세대-비', 2, { rottieTerminalId: 'term-B' }),
    { kind: 'handover', phase: 'complete', handoverId: 'h1', from: '세대-에이', to: '세대-비', t: T(3) },
    start('세대-씨', 4, { rottieTerminalId: 'term-C' }),
    { kind: 'handover', phase: 'complete', handoverId: 'h2', from: '세대-비', to: '세대-씨', t: T(5) }];
  const got = roleLineage(entries, [liveOf('세대-씨', 104)]).get('세대-씨');
  assert.deepEqual(got.map((x) => [x.source, x.rottieTerminalId]), [['handover', 'term-B'], ['handover', 'term-A']]);
  // 아직 C에게 넘기지 않은 B는 A만 안다.
  assert.deepEqual(roleLineage(entries.slice(0, 3)).get('세대-비').map((x) => x.rottieTerminalId), ['term-A']);
});

test('F4 비용: 긴 restart 사슬에서도 배열을 복사·뒤집지 않고 상한 10에서 멈춘다', () => {
  const chain = [start('세대-길', 0)];
  for (let i = 1; i < 2000; i++) chain.push(start('세대-길', i, { restartOf: startDigest(chain.at(-1)) }));
  const reverse = Array.prototype.reverse;
  let reversed = 0;
  Array.prototype.reverse = function patched(...args) { reversed++; return reverse.apply(this, args); };
  let got;
  try { got = roleLineage(chain).get('세대-길'); } finally { Array.prototype.reverse = reverse; }
  assert.equal(reversed, 0);
  assert.equal(got.length, 10);
  assert.equal(got[0].panePid, String(100 + 1998));
});
