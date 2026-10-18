import test from 'node:test';
import assert from 'node:assert/strict';
import {assessRoles} from '../src/watch.mjs';
import {changeDigest} from '../src/watch-roles.mjs';
import {parseClock, readStatusLine, isWorkingMoving, assessIdleStop, hasOpenQuestion, IDLE_STOP_AFTER_MS}
  from '../src/watch-status-line.mjs';

// 아래 화면 조각은 감시AI 관찰 자료(~/.kadan/watch-ai/*/input.txt)의 실제 화면 아래쪽을 줄이고 경로를 지운 것이다.
// 표본 위치·모양 표는 카드 result.md에 있다.
const codexWorking = clock => [
  '• Working (' + clock + ' • esc to interrupt)', '', '', '› Ask Codex to do anything', '',
  '  kimi/k3[1m] max · ~/Dev/kadan · main · Context 15% used · weekly 57% left · 996K window',
].join('\n');
const codexWorkingBackground = clock => codexWorking(clock).replace('interrupt)',
  'interrupt) · 1 background terminal running · /ps to view · /stop to close');
const codexWorkingQueued = [
  '• Working (2m 13s • esc to interrupt)', '', '', '› [Image #1] 어드민도 gnb 아래에 프리뷰', '',
  '  tab to queue message                                                    20% context left',
].join('\n');
const codexIdle = [
  '────────────────────────────────────────', '', '› Ask Codex to do anything', '',
  '  gpt-6-astra medium · ~/Dev/kadan-lite · main · Context 63% used · 258K window',
].join('\n');
const reconnecting = clock => [
  '', `• Reconnecting... 2/5 (${clock} • esc to interrupt)`,
  '  └ Stream disconnected before completion: Routed model generation timeout after 200000ms',
  '', '', '› Ask Codex to do anything', '',
  '  command-code/deepseek default · ~/Dev/kadan · main · Context 29% used · weekly 58% left',
].join('\n');
// #187 사고 화면: 끊김 낱말 줄 없이 Reconnecting 줄에 esc to interrupt와 시계만 있다.
const hybridOnly = clock => [
  '', `• Reconnecting... (${clock} • esc to interrupt)`, '', '', '› Ask Codex to do anything', '',
].join('\n');
const claudeIdle = [
  '✻ Cogitated for 3m 44s · done 1:16 PM', '',
  '────────────────────────────────────────', '❯ ', '────────────────────────────────────────',
  '  ~/Dev/kadan[main]                                          ✔ Update installed',
  '  Opus 5.5 | effort:high | 0h 48m left | ctx:20%',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents',
].join('\n');
// 표본 미확인: claude 일하는 중 모양은 카드의 설명(`✻ … (Ns · … esc to interrupt)`)대로 만든 것이다.
const claudeWorkingUnconfirmed = (verb, clock) => [
  `✻ ${verb}… (${clock} · ↑ 1.2k tokens · esc to interrupt)`, '',
  '────────────────────────────────────────', '❯ ', '────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

test('경과 시계 세 형식을 초로 읽는다', () => {
  assert.equal(parseClock('12s'), 12);
  assert.equal(parseClock('5m 12s'), 312);
  assert.equal(parseClock('1h 02m 03s'), 3723);
  assert.equal(parseClock('34m 04s'), 2044);
  for (const bad of ['', '5m', '12', 'soon', null, undefined]) assert.equal(parseClock(bad), null);
});

test('codex 실제 표본: 일하는 중은 입력창 내용·뒤 조각과 상관없이 일하는 중이다', () => {
  assert.deepEqual(readStatusLine(codexWorking('34m 04s')), {kind: 'working', tool: 'codex', clockSec: 2044});
  assert.equal(readStatusLine(codexWorkingBackground('31m 25s')).clockSec, 1885);
  assert.equal(readStatusLine(codexWorkingQueued).kind, 'working');
});

test('codex 실제 표본: 빈 입력창은 idle, 일하는 표시가 없다', () => {
  assert.deepEqual(readStatusLine(codexIdle), {kind: 'idle', tool: 'codex', clockSec: null});
});

test('하이브리드 Reconnecting(esc to interrupt 포함)은 일하는 중이 아니다', () => {
  assert.equal(readStatusLine(reconnecting('9m 34s')).kind, 'idle');
  assert.equal(readStatusLine(hybridOnly('14h 04m 30s')).kind, 'idle');
});

test('claude 실제 표본: 끝난 턴의 시계 줄은 일하는 중이 아니고 ❯ 입력창은 idle이다', () => {
  assert.deepEqual(readStatusLine(claudeIdle), {kind: 'idle', tool: 'claude', clockSec: null});
});

test('claude 일하는 중(표본 미확인): 동사가 여러 개여도 시계를 읽는다', () => {
  for (const verb of ['Thinking', 'Cogitating', 'Pondering']) {
    assert.deepEqual(readStatusLine(claudeWorkingUnconfirmed(verb, '1m 02s')), {kind: 'working', tool: 'claude', clockSec: 62});
  }
});

test('입력창이 비어 있지 않으면 idle이 아니다(사람이 입력 중)', () => {
  const typing = codexIdle.replace('› Ask Codex to do anything', '› 지금 쓰는 중인 글');
  assert.equal(readStatusLine(typing).kind, 'unknown');
  assert.equal(readStatusLine(claudeIdle.replace('❯ ', '❯ 쓰는 중')).kind, 'unknown');
});

test('isWorkingMoving: 늘거나 줄면 움직임, 같거나 처음이면 근거 아님', () => {
  const at = clock => readStatusLine(codexWorking(clock));
  assert.equal(isWorkingMoving(at('5m 12s'), 300), true);
  assert.equal(isWorkingMoving(at('5s'), 300), true, '새 턴으로 다시 시작');
  assert.equal(isWorkingMoving(at('5m 00s'), 300), false);
  assert.equal(isWorkingMoving(at('5m 00s'), null), false);
  assert.equal(isWorkingMoving(readStatusLine(codexIdle), 300), false);
});

// ---- assessRoles 연결: (a) 일하는 중이면 정체를 적립하지 않는다 ----
const observe = (screen, over = {}) => new Map([['kadan-worker', {
  role: 'worker', alive: true, pid: 1, expectedPid: 1, screen, digest: changeDigest(screen), ...over,
}]]);
const run = (screens, stallN = 2) => {
  let states = new Map();
  const alerts = [];
  for (const screen of screens) {
    const result = assessRoles(states, observe(screen), 60_000, 60_000, stallN);
    states = result.states;
    alerts.push(result.alerts);
  }
  return {states, alerts};
};
const stalled = list => list.some(a => a.kind === '정체');
const anyStalled = lists => lists.some(stalled);

test('(a) 시계가 늘어나는 일하는 화면은 오래 가도 정체를 적립하지 않는다', () => {
  const screens = ['1m 00s', '2m 00s', '3m 00s', '4m 00s', '5m 00s', '6m 00s'].map(codexWorking);
  const {alerts, states} = run(screens);
  assert.equal(anyStalled(alerts), false);
  assert.equal(states.get('kadan-worker').stallCount, 0);
  assert.equal(states.get('kadan-worker').unchangedMs, 0, '일하는 동안은 정체 시간을 쌓지 않는다');
});

test('(a) 시계가 다시 시작(새 턴)해도 일하는 중이다', () => {
  const {alerts} = run(['9m 00s', '10m 00s', '5s', '1m 05s', '2m 05s'].map(codexWorking));
  assert.equal(anyStalled(alerts), false);
});

test('(a) 시계가 같으면 근거가 아니라 (c) 기존 정체로 간다', () => {
  const {alerts} = run(['5m 00s', '5m 00s', '5m 00s', '5m 00s'].map(codexWorking));
  assert.equal(stalled(alerts.at(-1)), true);
});

test('(a) 끊김 줄이 같은 아래쪽에 걸리면 일하는 중이 아니다(#187 회귀 유지)', () => {
  const {alerts, states} = run(['9m 00s', '10m 00s', '11m 00s'].map(reconnecting));
  const state = states.get('kadan-worker');
  assert.equal(state.workingMoving, false);
  assert.ok(state.disconnects.length > 0, '끊김 줄을 보고 있다');
  assert.equal(state.stallCount, 0, '끊김은 정체로 세지 않는다 — 끊김 경로가 맡는다');
  assert.equal(anyStalled(alerts), false);
});

test('(a) 하이브리드 Reconnecting만 있는 14시간 화면은 일하는 중으로 묻히지 않고 정체로 간다', () => {
  const {alerts, states} = run(['14h 03m 22s', '14h 04m 30s', '14h 05m 40s', '14h 06m 50s'].map(hybridOnly));
  assert.equal(states.get('kadan-worker').workingMoving, false);
  assert.equal(stalled(alerts.at(-1)), true);
});

// ---- (b) 멈춤 ----
const task = {kind: 'send', role: 'worker', taskId: 'c1', t: '2026-10-19T00:00:00.000Z'};
const idleRun = (screens, over = {}, stepMs = 60_000) => {
  let states = new Map();
  const all = [];
  for (const screen of screens) {
    const result = assessIdleStop(states, observe(screen, over.observe), {
      elapsedMs: stepMs, intervalMs: 60_000, tasks: [task], entries: [], ...over.options,
    });
    states = result.states;
    all.push(result.alerts);
  }
  return all;
};

test('(b) 일하는 표시 없는 빈 입력창이 기준 시간 이어지면 경보한다', () => {
  const afterMin = IDLE_STOP_AFTER_MS / 60_000;
  const alerts = idleRun(Array(afterMin + 1).fill(codexIdle));
  assert.equal(alerts.slice(0, afterMin).flat().length, 0, '기준 전에는 경보 없음');
  const last = alerts.at(-1);
  assert.equal(last.length, 1);
  assert.equal(last[0].kind, '멈춤');
  assert.equal(last[0].level, 'AMBER');
  assert.match(last[0].id, /^idle-stop:kadan-worker:/);
  assert.equal(idleRun(Array(afterMin + 1).fill(claudeIdle)).at(-1)[0].tool, 'claude');
});

test('(b) 일하는 중이거나 화면이 바뀌면 경보하지 않는다', () => {
  const working = idleRun(Array(8).fill(codexWorking('1m 00s')));
  assert.equal(working.flat().length, 0);
  const changing = idleRun(Array.from({length: 8}, (_, i) => codexIdle + '\n' + 'abcdefgh'[i].repeat(5)));
  assert.equal(changing.flat().length, 0);
});

test('(b) 정당한 대기 제외: DONE 마커·미발령·질문 대기·큐 배너·앞 단계 경보 세션', () => {
  const n = 7;
  assert.equal(idleRun(Array(n).fill(codexIdle), {observe: {doneMarker: {taskId: 'c1', result: 'ok'}}}).flat().length, 0, '완료후보');
  assert.equal(idleRun(Array(n).fill(codexIdle), {options: {tasks: []}}).flat().length, 0, '완료·일시정지·취소·미발령(감시 범위 밖)');
  assert.equal(idleRun(Array(n).fill(codexIdle), {options: {queuedLine: () => 'queued'}}).flat().length, 0, '큐 배너');
  assert.equal(idleRun(Array(n).fill(codexIdle), {options: {excludedSessions: new Set(['kadan-worker'])}}).flat().length, 0, '죽음·끊김·재개·큐 처리 중');
  const typing = codexIdle.replace('› Ask Codex to do anything', '› 사람이 쓰는 중');
  assert.equal(idleRun(Array(n).fill(typing)).flat().length, 0, '사람 입력 보호·알림밀림(입력창이 비어 있지 않음)');
});

const question = over => ({kind: 'send', transport: 'mailbox', mailId: 'm-q1', by: 'worker', role: 'boss',
  taskId: 'c1', expectReply: true, t: '2026-10-19T00:05:00.000Z', digest: 'd-q1', ...over});

test('(b) 그 역할이 발령 뒤 보낸 질문에 답이 없으면 정당한 대기라 경보하지 않는다', () => {
  assert.equal(hasOpenQuestion([question()], 'worker', task.t), true);
  assert.equal(hasOpenQuestion([question({t: '2026-10-18T23:00:00.000Z'})], 'worker', task.t), false, '발령 전 질문은 아님');
  assert.equal(hasOpenQuestion([question({expectReply: false})], 'worker', task.t), false);
  assert.equal(hasOpenQuestion([], 'worker', task.t), false);
  const answered = [question(), {kind: 'send', transport: 'mailbox', mailId: 'm-a1', by: 'boss', role: 'worker',
    replyTo: 'm-q1', replyFinal: true, taskId: 'c1', t: '2026-10-19T00:06:00.000Z'}];
  assert.equal(hasOpenQuestion(answered, 'worker', task.t), false, '최종 답이 오면 아님');
  assert.equal(idleRun(Array(7).fill(codexIdle), {options: {entries: [question()]}}).flat().length, 0);
  assert.equal(idleRun(Array(7).fill(codexIdle), {options: {entries: answered}}).at(-1).length, 1);
});
