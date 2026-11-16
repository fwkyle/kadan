import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {runWatch} from '../src/watch-runner.mjs';
import {bundleRow, partialRow, fullRow} from './helpers/decision-bundle.mjs';

const epoch = Date.parse('2026-11-16T00:00:00Z');
const stamp = minute => new Date(epoch + minute * 60_000).toISOString();
const parents = new Map([['test-worker', 'test-boss'], ['test-boss', 'test-슈퍼감독'], ['test-슈퍼감독', '@user']]);
async function nudge(decision) {
  const starts = [...parents.keys()].map((role, index) => ({kind: 'start', role,
    session: `kadan-${role}`, panePid: index + 1, t: stamp(0)}));
  const entries = [...starts, {kind: 'send', role: 'test-worker', taskId: 't1', t: stamp(0)},
    {kind: 'done', role: 'test-worker', taskId: 't1', result: 'ok', t: stamp(1)}];
  const card = {id: 't1', key: 'repo/t1', role: 'test-worker', board: 'test', status: 'done',
    activity: 'done', workType: 'execution'};
  const work = {key: 'repo/w1', status: 'open', owner: 'test-boss', executions: [{key: card.key}], at: stamp(0)};
  let minute = 0;
  const controller = new AbortController(), nudges = [];
  await runWatch({signal: controller.signal, intervalMs: 60_000, stallN: 2,
    stallAfterMs: 300_000, idleMs: 15 * 60_000, parents, routes: new Map(),
    superRole: 'test-슈퍼감독', now: () => epoch + minute * 60_000,
    floor: {list: () => starts.map(s => ({session: s.session, pid: s.panePid})),
      read: () => '고정 화면', alive: () => true},
    readEntries: () => entries, readCards: () => [card], readWorks: () => [work],
    readDecisions: () => [decision], sendAlert: () => {},
    sendNudge: role => nudges.push([minute, role]), record: e => entries.push({...e, t: stamp(minute)}),
    print: () => {}, spawn: () => ({status: 0, stdout: ''}),
    sleep: async () => {if (++minute >= 20) controller.abort();},
  });
  return nudges;
}

test('실제 감시 순회: 묶음+열린 업무는 일부 답에도 대기하고 전부 답·취소하면 풀린다', async () => {
  const first = bundleRow({work: 'repo/w1'});
  assert.deepEqual(await nudge(first), []);
  assert.deepEqual(await nudge(partialRow(first)), []);
  assert.deepEqual(await nudge(fullRow(first)), [[15, 'test-boss']]);
  assert.deepEqual(await nudge({...partialRow(first), status: 'cancelled'}), [[15, 'test-boss']]);
});

test('업무 없는 묶음과 참고 context.work는 대기를 만들지 않는다', async () => {
  assert.deepEqual(await nudge(bundleRow()), [[15, 'test-boss']]);
  assert.deepEqual(await nudge(bundleRow({context: {work: 'repo/w1'}})), [[15, 'test-boss']]);
});

test('단일 카드·채팅 대기는 유지되고 묶음의 진행 표시로 대기를 풀지 않는다', async () => {
  assert.deepEqual(await nudge({id: 'single', card: 'repo/t1', status: 'open'}), []);
  assert.deepEqual(await nudge({id: 'chat', card: null, chat: true, work: 'repo/w1', status: 'open'}), []);
  assert.deepEqual(await nudge({...bundleRow({work: 'repo/w1'}), proceeded: {at: stamp(0)}}), []);
});
