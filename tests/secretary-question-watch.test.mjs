// Why: 비서가 --expect-reply로 감독에게 물은 질문은 답할 감독의 할 일·놀고 있음 감시로 이어지고 최종 답변으로만 닫힌다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHierarchy} from '../src/hierarchy.mjs';
import {peerResponsibilities} from '../src/peer-mail.mjs';
import {assessSupervisorIdle} from '../src/watch-supervisor.mjs';

const table = {'k-super': '@user', 'k-boss': 'k-super', 'k-worker': 'k-boss', 'r-super': '@user'};
const parents = parseHierarchy(table);
const t = '2026-11-16T00:00:00Z';
const profile = {'k-super': 'super', 'r-super': 'super', 'k-boss': 'conductor', 'k-worker': 'worker'};
const starts = Object.entries(profile).map(([role, roleProfile]) =>
  ({kind: 'start', role, roleProfile, session: `kadan-${role}`, t}));
const ask = (to, extra = {}) => ({kind: 'send', mailId: 'sq1', by: '비서', role: to, t,
  expectReply: true, transport: 'mailbox', ...extra});
const answer = (to, extra) => ({kind: 'send', mailId: 'sa1', by: to, role: '비서', t,
  replyTo: 'sq1', transport: 'mailbox', ...extra});
const state = unchangedMs => ({alive: true, digest: 'same', unchangedMs});
const states = () => new Map(Object.keys(table).map(r => [`kadan-${r}`, state(40 * 60_000)]));
const idle = entries => assessSupervisorIdle([], states(), Date.parse(t) + 40 * 60_000, 15 * 60_000, null,
  parents, {works: [], cards: [], waits: [], peerEntries: [...starts, ...entries]});
const owners = entries => peerResponsibilities([...starts, ...entries], parents).map(r => r.role);

for (const to of ['k-boss', 'k-super']) {
  test(`비서 → ${to} 질문은 받는 감독의 답할 일이 되어 놀고 있음 경보를 낸다`, () => {
    assert.deepEqual(owners([ask(to)]), [to]);
    const alerts = idle([ask(to)]);
    assert.ok(alerts.some(a => a.session === `kadan-${to}`), JSON.stringify(alerts));
    assert.ok(alerts.some(a => JSON.stringify(a).includes('sq1')));
  });
}

test('읽음·일반 답장은 닫지 않고 최종 답변만 닫는다', () => {
  assert.deepEqual(owners([ask('k-boss'), answer('k-boss')]), ['k-boss']);
  assert.deepEqual(owners([ask('k-boss'), answer('k-boss', {replyFinal: true})]), []);
  assert.deepEqual(idle([ask('k-boss'), answer('k-boss', {replyFinal: true})]), []);
});

test('--expect-reply 없는 맥락 우편, 작업자 수신, 관계표 밖 수신은 잡지 않는다', () => {
  assert.deepEqual(owners([ask('k-boss', {expectReply: undefined})]), []);
  assert.deepEqual(owners([ask('k-worker')]), []);
  assert.deepEqual(owners([ask('outsider')]), []);
});

test('비서 자신은 책임자가 되지 않고, 비서가 받는 질문은 그대로 제외된다', () => {
  assert.ok(!owners([ask('k-boss')]).includes('비서'));
  const toSecretary = {kind: 'send', mailId: 'sq2', by: 'k-super', role: '비서', t, expectReply: true,
    transport: 'mailbox'};
  assert.deepEqual(owners([toSecretary]), []);
});

test('대조군: 슈퍼감독끼리의 질문은 그대로 잡힌다', () => {
  const q = {kind: 'send', mailId: 'sq3', by: 'r-super', role: 'k-super', t, expectReply: true,
    transport: 'mailbox'};
  assert.deepEqual(owners([q]), ['k-super']);
});
