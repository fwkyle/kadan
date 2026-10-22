import test from 'node:test';
import assert from 'node:assert/strict';
// 가짜 시계: 1단 글의 등록 명령 꼴을 그대로 따라 한 우편이 실제로 놀고 있음을 끄는지 고정한다(검수 F2).
import {runWatch} from '../src/watch-runner.mjs';

const epoch = Date.parse('2026-09-09T00:00:00Z');
const stamp = m => new Date(epoch + m * 60_000).toISOString();
const parents = new Map([['p-작업자', 'p-감독'], ['p-감독', 'p-슈퍼감독'], ['p-슈퍼감독', '@user']]);
const starts = [...parents.keys()].map((role, i) => ({kind: 'start', role, session: 'kadan-' + role, panePid: i + 1, t: stamp(0)}));
const card = {id: 't1', key: 'repo/t1', role: 'p-작업자', board: 'p', status: 'assigned', activity: 'running', workType: 'execution'};
const work = {key: 'repo/w1', status: 'open', owner: 'p-감독', executions: [{key: 'repo/t1'}], at: stamp(0)};
const send = {kind: 'send', role: 'p-작업자', taskId: 't1', t: stamp(0)};
const plan = {kind: 'plan', board: 'p', taskId: 't1', t: stamp(0)};
const ask = extra => ({kind: 'send', mailId: 'q1', by: 'p-감독', role: 'p-슈퍼감독', session: 'kadan-p-슈퍼감독', expectReply: true, t: stamp(0), ...extra});

async function simulate({minutes = 20, cards = [card], works = [work], entries: extra = [send, plan]}) {
  const nudges = [], entries = [...starts, ...extra];
  let minute = 0;
  const controller = new AbortController();
  await runWatch({signal: controller.signal, intervalMs: 60_000, stallN: 2, stallAfterMs: 300_000, idleMs: 15 * 60_000,
    parents, routes: new Map(), superRole: 'p-슈퍼감독', now: () => epoch + minute * 60_000,
    floor: {list: () => starts.map(s => ({session: s.session, pid: s.panePid})), read: () => 'frozen screen', alive: () => true},
    readEntries: () => entries, readCards: () => cards, readWorks: () => works, readDecisions: () => [],
    sendAlert: () => {}, sendNudge: (role, msg) => nudges.push([minute, role, msg]),
    record: e => entries.push({...e, t: stamp(minute)}), print: () => {}, spawn: () => ({status: 0, stdout: ''}),
    sleep: async () => { if (++minute >= minutes) controller.abort(); }});
  return nudges;
}

test('살아 있는 작업자의 실행 카드: --execution 우편은 감독을 대기에서 빼고, --work만 있는 우편은 여전히 깨운다', async () => {
  const bare = await simulate({});
  assert.deepEqual(bare.map(([m, r]) => [m, r]), [[15, 'p-감독']]);
  assert.match(bare[0][2], /kadan mail 'p-슈퍼감독' --execution 'repo\/t1' --work 'repo\/w1' --expect-reply '<질문>'/);
  const byExecution = await simulate({entries: [send, plan, ask({executionKey: 'repo/t1'})]});
  assert.ok(!byExecution.some(([, r]) => r === 'p-감독'), '--execution 우편이면 감독을 깨우지 않는다');
  const byWorkOnly = await simulate({entries: [send, plan, ask({workKey: 'repo/w1'})]});
  assert.ok(byWorkOnly.some(([, r]) => r === 'p-감독'), '--work만 있는 우편은 실행 카드를 대기에서 빼지 못한다');
});

test('업무 항목(work:<키>): --work 우편이 감독을 대기에서 뺀다', async () => {
  // 실행이 끝난 업무(2026-10-07 사고 모양): 카드는 done이라 업무 자체가 감독의 할 일이다.
  const done = {...card, status: 'done', activity: 'done'};
  const idleEntries = [send, {kind: 'done', role: 'p-작업자', taskId: 't1', result: 'ok', t: stamp(1)}];
  const bare = await simulate({cards: [done], entries: idleEntries});
  assert.match(bare[0][2], /kadan mail 'p-슈퍼감독' --work 'repo\/w1' --expect-reply '<질문>'/);
  const asked = await simulate({cards: [done], entries: [...idleEntries, ask({workKey: 'repo/w1'})]});
  assert.ok(!asked.some(([, r]) => r === 'p-감독'));
});
