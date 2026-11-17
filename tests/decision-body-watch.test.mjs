import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {runWatch} from '../src/watch-runner.mjs';

const epoch = Date.parse('2026-11-16T00:00:00Z');
const stamp = minute => new Date(epoch + minute * 60_000).toISOString();
async function observe(withClosedWorkDecision) {
  const parents = new Map([['body-worker', 'body-boss'], ['body-boss', 'body-슈퍼감독'], ['body-슈퍼감독', '@user']]);
  const starts = [...parents.keys()].map((role, index) => ({kind: 'start', role,
    session: `kadan-${role}`, panePid: index + 1, t: stamp(0)}));
  const cards = [
    {id: 'old', key: 'repo/old', role: 'body-worker', board: 'body', status: 'done',
      activity: 'done', workType: 'execution'},
    {id: 'current', key: 'repo/current', role: 'body-worker', board: 'body', status: 'assigned',
      activity: 'running', workType: 'execution'},
  ];
  const works = [{key: 'repo/done', status: 'done', owner: 'body-boss', executions: [{key: 'repo/old'}]},
    {key: 'repo/open', status: 'open', owner: 'body-boss', executions: [{key: 'repo/current'}], at: stamp(0)}];
  const entries = [...starts,
    {kind: 'send', role: 'body-worker', taskId: 'old', t: stamp(0)},
    {kind: 'done', role: 'body-worker', taskId: 'old', result: 'ok', t: stamp(1)},
    {kind: 'send', role: 'body-worker', taskId: 'current', t: stamp(0)},
    {kind: 'plan', board: 'body', taskId: 'current', t: stamp(0)},
  ];
  const decisions = withClosedWorkDecision ? [{id: 'done-question', chat: true, card: null,
    work: 'repo/done', requestedBy: 'body-슈퍼감독', question: '끝난 업무의 질문', status: 'open', at: stamp(0)}] : [];
  let minute = 0;
  const controller = new AbortController(), alerts = [], nudges = [];
  await runWatch({signal: controller.signal, intervalMs: 60_000, stallN: 2,
    stallAfterMs: 300_000, idleMs: 15 * 60_000, parents, routes: new Map(), superRole: 'body-슈퍼감독',
    now: () => epoch + minute * 60_000,
    floor: {list: () => starts.map(s => ({session: s.session, pid: s.panePid})),
      read: () => '고정 화면', alive: () => true},
    readEntries: () => entries, readCards: () => cards, readWorks: () => works, readDecisions: () => decisions,
    sendAlert: () => {}, sendNudge: role => nudges.push([minute, role]),
    record: e => {entries.push({...e, t: stamp(minute)});
      if (e.kind === 'alert' && !e.resolved) alerts.push([e.alertKind, e.role, e.recipient, minute]);},
    print: () => {}, spawn: () => ({status: 0, stdout: ''}),
    sleep: async () => {if (++minute >= 20) controller.abort();},
  });
  return {alerts, nudges};
}

test('done 업무의 열린 chat 결정은 다른 열린 업무의 놀고 있음·정체를 가리지 않는다', async () => {
  const control = await observe(false), withDecision = await observe(true);
  assert.ok(control.alerts.some(([kind]) => kind === '정체'));
  assert.ok(control.alerts.some(([kind]) => kind === '놀고 있음'));
  assert.deepEqual(withDecision, control);
});
