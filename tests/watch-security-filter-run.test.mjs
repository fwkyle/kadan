import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runWatch} from '../src/watch-runner.mjs';

const A = JSON.parse(fs.readFileSync(new URL('./fixtures/security-filter-screens.json', import.meta.url), 'utf8'))['A-test-output-then-notice'];
const epoch = Date.parse('2026-10-18T00:00:00Z');
const stamp = m => new Date(epoch + m * 60_000).toISOString();

// 가짜 시계·바닥·전송기로 감시 순회를 돌린다. 작업자 화면은 항상 A(실제 보안 필터 표본).
async function simulate(harness) {
  let minute = 0;
  const records = [], sent = [];
  const controller = new AbortController();
  const parents = new Map([['qa-worker', 'qa-boss'], ['qa-boss', '@user']]);
  const starts = [['qa-worker', 1], ['qa-boss', 2]].map(([role, panePid]) => ({kind: 'start', role,
    session: `kadan-${role}`, panePid, harness: role === 'qa-worker' ? harness : 'codex', model: 'm', t: stamp(0)}));
  const card = {id: 'qa-task', key: 'qa/qa-task', role: 'qa-worker', board: 'qa', status: 'assigned',
    activity: 'running', activityRole: 'qa-worker', activityAt: stamp(0), workType: 'execution'};
  const entries = [...starts, {kind: 'send', role: card.role, session: 'kadan-qa-worker', taskId: 'qa-task',
    executionKey: card.key, t: stamp(0)}];
  await runWatch({signal: controller.signal, intervalMs: 60_000, stallN: 2, stallAfterMs: 300_000,
    idleMs: 15 * 60_000, parents, routes: new Map(), superRole: 'qa-boss', now: () => epoch + minute * 60_000,
    floor: {list: () => starts.map(s => ({session: s.session, pid: s.panePid})),
      read: s => s === 'kadan-qa-worker' ? A : 'supervisor screen', alive: () => true},
    readEntries: () => entries, readCards: () => [card], readWorks: () => [],
    resume429: () => assert.fail('no resume'), sendAlert: (role, message) => sent.push({role, message}),
    sendNudge: () => {}, record: e => { records.push(e); entries.push({...e, t: stamp(minute)}); },
    spawn: () => ({status: 0, stdout: ''}), print: () => {},
    sleep: async () => { if (++minute >= 3) controller.abort(); }});
  return {alerts: records.filter(e => e.kind === 'alert' && !e.resolved && e.alertKind === '보안필터'), sent};
}

test('claude 실행의 같은 화면은 경보 0건', async () => {
  const r = await simulate('claude');
  assert.deepEqual(r.alerts, []);
});

test('codex 실행이면 첫 주기에 직속 감독에게 1건, 실행 ID가 붙는다', async () => {
  const r = await simulate('codex');
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].recipient, 'qa-boss');
  assert.equal(r.alerts[0].taskId, 'qa-task');
  assert.match(r.sent[0].message, /qa-worker \/ qa-task/u);
});
