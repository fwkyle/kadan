import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {runWatch} from '../src/watch-runner.mjs';
import {buildWatchScope, buildSupervisorScope} from '../src/watch-scope.mjs';
import {observationContext} from '../src/watch-supervisor-health.mjs';
import {buildWatchPrompt} from '../src/watch-ai.mjs';

// 감독 정기 점검의 관찰 자료에 "맡긴 하위 실행이 대기 표시로 작업자 화면 감시 밖"임이 실리는지 본다.
// Why: 2026-11-18 감독 점검은 activity:"waiting"만 보고 22시간 멈춘 하위를 정당한 결과 대기로 판정했다.
// 합격 기준은 관찰 자료의 칸과 지시문의 글이다(AI가 어떻게 판정하는지는 보지 않는다). 가짜 시계·가짜 바닥·가짜 AI만 쓴다.
const COMPOSER = '› Ask Codex to do anything\n\n  gpt-6.1-sol high · ~/Dev/PROJ · main · Context 41% used\n';
const epoch = Date.parse('2026-11-18T06:54:00Z');
const stamp = minute => new Date(epoch + minute * 60_000).toISOString();
const WORKER = 'qa-reviewer', BOSS = 'qa-boss', TOP = 'qa-top', SESSION = `kadan-${WORKER}`;
const parents = new Map([[WORKER, BOSS], [BOSS, TOP], [TOP, '@user']]);
const start = (role, panePid) => ({kind: 'start', role, session: `kadan-${role}`, panePid, harness: 'codex', model: 'm', t: stamp(0)});
const starts = [start(WORKER, 1), start(BOSS, 2), start(TOP, 3)];
const KEY = 'qa/qa-task';
const running = {id: 'qa-task', key: KEY, title: '재판정', role: WORKER, board: 'qa', status: 'assigned', workType: 'execution',
  activity: 'running', activityRole: WORKER, activityAt: stamp(0), at: stamp(0), scope: '범위'};
const waiting = {...running, activity: 'waiting', activityAt: stamp(1), at: stamp(1), noteKind: 'progress', note: '다른 시험 종료 뒤 대기', by: WORKER};
const reported = {...waiting, result: {by: WORKER, at: stamp(1), outcome: 'implemented'}};
const dispatch = (id = 'qa-task', key = KEY) => ({kind: 'send', role: WORKER, session: SESSION, taskId: id, executionKey: key, by: BOSS, t: stamp(0)});
const PLAIN_KEYS = ['id', 'title', 'status', 'activity', 'scope'];

// 감독(BOSS)의 정기 점검(1시간)이 불릴 때 AI가 받은 관찰 자료를 모은다.
async function supervisorInputs(card, until = 64) {
  let minute = 0;
  const entries = [...starts, dispatch()], inputs = [];
  const controller = new AbortController();
  await runWatch({signal: controller.signal, intervalMs: 60_000, stallN: 2, stallAfterMs: 300_000, idleMs: 15 * 60_000,
    parents, routes: new Map(), superRole: TOP, now: () => epoch + minute * 60_000,
    floor: {list: () => starts.map(s => ({session: s.session, pid: s.panePid})),
      read: session => session === SESSION ? `• 다른 시험이 끝나면 돌리겠습니다.\n\n${COMPOSER}` : `• 맡긴 재판정 결과를 기다립니다.\n\n${COMPOSER}`, alive: () => true},
    readEntries: () => entries, readCards: () => [card], readWorks: () => [],
    sendAlert: () => {}, sendNudge: () => {}, judgeCmd: 'fake', judgeCooldownMs: 60_000,
    ai: {reports: {retire: () => {}}, run: args => { if (args.source === 'supervisor-health') inputs.push({minute, role: args.role, input: args.input}); return {ok: true}; }},
    record: e => entries.push({...e, t: stamp(minute)}), spawn: () => ({status: 0, stdout: ''}), print: () => {},
    sleep: async () => { await setImmediate(); if (++minute >= until) controller.abort(); }});
  return inputs;
}

test('감독 점검 관찰 자료: 대기 표시로 화면 감시 밖인 하위 실행에 새 칸 셋이 실린다', async () => {
  const calls = await supervisorInputs(waiting);
  const boss = calls.find(call => call.role === BOSS);
  assert.ok(boss, '감독의 정기 점검이 한 번은 불린다');
  assert.equal(boss.input.check, 'hourly');
  const [task] = boss.input.tasks;
  assert.deepEqual([task.id, task.activity, task.outsideScreenWatch, task.activityAt, task.waitingMinutes],
    ['qa-task', 'waiting', true, stamp(1), boss.minute - 1]);
  assert.ok(boss.minute - 1 >= 59, '대기를 표시한 지 한 시간쯤 지난 시점이다');
  // AI가 실제로 받는 지시문에 그 칸과 설명 문장이 함께 들어간다.
  const prompt = buildWatchPrompt({source: 'supervisor-health', command: 'cmd', input: boss.input});
  assert.ok(prompt.includes('"outsideScreenWatch":true') && prompt.includes(`"waitingMinutes":${boss.minute - 1}`));
});

test('감독 점검 관찰 자료: 화면 감시 안의 실행(일하는 중·결과 등록 뒤 확정 대기)에는 새 칸이 없다', async () => {
  const [busy] = (await supervisorInputs(running)).find(call => call.role === BOSS).input.tasks;
  assert.deepEqual(Object.keys(busy), PLAIN_KEYS);
  const [confirmed] = (await supervisorInputs(reported)).find(call => call.role === BOSS).input.tasks;
  assert.deepEqual(Object.keys(confirmed), ['id', 'title', 'status', 'activity', 'resultReportedAt', 'resultOutcome', 'scope']);
});

test('observationContext: 화면 감시 밖 목록을 넘긴 실행에만 싣고, 안 넘기면 예전 항목 그대로다', () => {
  const seen = {alive: true, pid: 2, expectedPid: 2};
  const other = {...running, id: 'qa-other', key: 'qa/qa-other', title: '다른 일'};
  const context = (cards, entries, withOutside = true) => {
    const keys = new Set(buildWatchScope(cards, entries, parents, [], {waiting: true}).waitingSessions.map(e => e.executionKey ?? e.taskId));
    const tasks = buildSupervisorScope(cards, entries, parents, []).entries;
    return observationContext(BOSS, seen, entries, cards, tasks, undefined, withOutside ? {keys, now: epoch + 90 * 60_000} : undefined).tasks;
  };
  const single = [...starts, dispatch()];
  assert.deepEqual(context([waiting], single), [{id: 'qa-task', title: '재판정', status: 'assigned', activity: 'waiting',
    outsideScreenWatch: true, activityAt: stamp(1), waitingMinutes: 89, scope: '범위'}]);
  // 안 넘기면(작업 감시AI 입력) 대기 실행의 항목도 예전과 같다.
  assert.deepEqual(context([waiting], single, false), [{id: 'qa-task', title: '재판정', status: 'assigned', activity: 'waiting', scope: '범위'}]);
  // 같은 역할에 감시 중인 다른 실행이 있으면 그 세션의 화면은 정상 감시가 본다: 대기 실행에도 싣지 않는다.
  const both = context([waiting, other], [...single, dispatch('qa-other', 'qa/qa-other')]);
  assert.deepEqual(both.map(task => Object.keys(task)), [PLAIN_KEYS, PLAIN_KEYS]);
  // 대기 시각을 읽을 수 없으면 지어내지 않는다.
  const [broken] = observationContext(BOSS, seen, single, [{...waiting, activityAt: undefined}], [{role: BOSS, subject: WORKER, taskId: 'qa-task'}],
    undefined, {keys: new Set([KEY]), now: epoch}).tasks;
  assert.deepEqual([broken.outsideScreenWatch, broken.activityAt, 'waitingMinutes' in broken], [true, null, false]);
});

test('지시문: 감독 갈래에만 화면 감시 밖 대기 문장이 있다', () => {
  const build = source => buildWatchPrompt({source, command: 'cmd', input: {screen: 'x'}});
  const text = build('supervisor-health');
  for (const phrase of ['outsideScreenWatch', 'activityAt', 'waitingMinutes', '화면 감시', '"하위 결과 대기 = 정상"으로만 넘기지 말고', '판정 이유에'])
    assert.ok(text.includes(phrase), phrase);
  for (const source of ['stall', 'progress']) assert.ok(!build(source).includes('outsideScreenWatch'), source);
});
