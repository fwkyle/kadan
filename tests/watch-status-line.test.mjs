import test from 'node:test';
import assert from 'node:assert/strict';
import {assessRoles} from '../src/watch.mjs';
import {NotifyHoldTracker} from '../src/watch-notify-hold.mjs';
import {changeDigest} from '../src/watch-roles.mjs';
import {parseClock, readStatusLine, isWorkingMoving, assessIdleStop, hasOpenQuestion, IDLE_STOP_AFTER_MS,
  backgroundMarker, BACKGROUND_GRACE_MS} from '../src/watch-status-line.mjs';

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
// claude 2.1.302 일하는 중 실제 화면 두 장(감독 세션, 경로·계정은 자리표시로 줄임). `esc to interrupt`가 없고 빈 `❯`가 보인다.
const claudeWorkingReal = (glyph, clock) => [
  '  Bash(cd ~/Dev/<repo>; sleep 4; <명령>)', '  ⎿  Running… (4s)', '     (ctrl+b ctrl+b (twice) to run in background)', '',
  `${glyph} Grooving… (${clock} · ↓ 1.7k tokens)`, '',
  '────────────────────────────────────────', '❯ ', '────────────────────────────────────────',
  '  ~/Dev/<repo>[main]                                          ✔ Update installed',
  '  Opus 5.5 | effort:high | 2h 33m left | ctx:76%',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents',
].join('\n');
// 일하는 줄(회전 줄·도구 실행 줄)을 모두 지운 화면 = 진짜 입력 대기
const withoutSpinner = screen => screen.split('\n').filter(l => !/Grooving|Running…|ctrl\+b|Bash\(/.test(l)).join('\n');

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

test('claude 실제 표본: 회전 기호가 ✢→·로 돌고 시계가 늘어도 일하는 중이다(빈 ❯가 있어도 idle이 아님)', () => {
  assert.deepEqual(readStatusLine(claudeWorkingReal('✢', '32s')), {kind: 'working', tool: 'claude', clockSec: 32});
  assert.deepEqual(readStatusLine(claudeWorkingReal('·', '38s')), {kind: 'working', tool: 'claude', clockSec: 38});
  for (const verb of ['Thinking', 'Cogitating', 'Pondering'])
    assert.equal(readStatusLine(claudeWorkingReal('✻', '1m 02s').replace('Grooving', verb)).clockSec, 62);
});

test('claude 끝난 턴 모양은 일하는 중이 아니다', () => {
  for (const done of ['✻ Cogitated for 3m 44s', '✻ Brewed for 11s · done 1:48 AM', '✻ Cogitated for 3m 44s · done 1:16 PM']) {
    assert.equal(readStatusLine(withoutSpinner(claudeWorkingReal('✻', '1s')) + '\n' + done).kind, 'idle', done);
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

test('(a) 하이브리드 Reconnecting만 있는 14시간 화면은 일하는 중으로 묻히지 않고 끊김 경보로 간다', () => {
  const {alerts, states} = run(['14h 03m 22s', '14h 04m 30s', '14h 05m 40s', '14h 06m 50s'].map(hybridOnly));
  assert.equal(states.get('kadan-worker').workingMoving, false);
  assert.equal(alerts[0].some(a => a.kind === '끊김'), true);
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

test('(b) claude 실제 일하는 화면 두 장은 4분 넘게 가도 멈춤 0건, 일하는 줄만 지운 화면은 멈춤이다', () => {
  const screens = Array.from({length: 8}, (_, i) => claudeWorkingReal(i % 2 ? '·' : '✢', `${30 + i * 6}s`));
  assert.equal(idleRun(screens).flat().length, 0);
  const stopped = idleRun(Array(IDLE_STOP_AFTER_MS / 60_000 + 1).fill(withoutSpinner(claudeWorkingReal('✢', '32s')))).at(-1);
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].tool, 'claude');
});

test('(a) claude 실제 일하는 화면은 시계가 늘면 정체를 적립하지 않는다', () => {
  const {alerts, states} = run(Array.from({length: 6}, (_, i) => claudeWorkingReal(i % 2 ? '·' : '✢', `${30 + i * 6}s`)));
  assert.equal(anyStalled(alerts), false);
  assert.equal(states.get('kadan-worker').workingMoving, true);
});

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

// ---- 검수 F1·F2 (PR #199 수정 2라운드) ----
// F1: 회전 줄 없이 도구 실행 줄 `⎿  Running… (Ns)`과 빈 ❯만 보이는 화면.
const toolOnly = clock => [
  '  Bash(<오래 걸리는 명령>)', `  ⎿  Running… (${clock})`, '     (ctrl+b ctrl+b (twice) to run in background)', '',
  '────────────────────────────────────────', '❯ ', '────────────────────────────────────────',
  '  ~/Dev/<repo>[main]', '  Opus 5.5 | effort:high | 2h 33m left | ctx:20%',
].join('\n');

test('F1: 도구 실행 줄만 있는 화면은 idle이 아니라 working이고 시계를 읽는다', () => {
  assert.deepEqual(readStatusLine(toolOnly('4s')), {kind: 'working', tool: 'claude', clockSec: 4});
  assert.equal(readStatusLine(toolOnly('1m 02s')).clockSec, 62);
});

test('F1: 도구 시계가 늘면 (a) 일하는 중 — 4분·10분에도 멈춤 0건이고 정체도 적립하지 않는다', () => {
  for (const minutes of [5, 11]) {
    const screens = Array.from({length: minutes}, (_, i) => toolOnly(`${i * 60 + 1}s`));
    assert.equal(idleRun(screens).flat().length, 0, `${minutes}주기`);
    const {alerts, states} = run(screens);
    assert.equal(anyStalled(alerts), false);
    assert.equal(states.get('kadan-worker').workingMoving, true);
  }
});

test('F1: 도구 줄 시계가 안 늘면 멈춤이 아니라 (c) 기존 정체로 간다', () => {
  assert.equal(idleRun(Array(12).fill(toolOnly('30s'))).flat().length, 0, '(b)는 0건');
  const {alerts} = run(Array(6).fill(toolOnly('30s')));
  assert.equal(stalled(alerts.at(-1)), true, '(c) 정체 경로');
});

test('F1: 도구 줄을 지운 진짜 빈 입력창은 그대로 멈춤이다', () => {
  const idleOnly = toolOnly('4s').split('\n').filter(l => !/Running|ctrl\+b|Bash\(/.test(l)).join('\n');
  assert.equal(readStatusLine(idleOnly).kind, 'idle');
  assert.equal(idleRun(Array(5).fill(idleOnly)).at(-1).length, 1);
});

// F2: 입력 보호·알림밀림은 입력창이 비어 있어도 걸린다(복사 모드·최근 사람 입력). 보류 정보를 직접 연결한다.
test('F2: NotifyHoldTracker.isHeld — 이번 주기에 밀렸거나 이전 주기부터 이어진 역할만 참', () => {
  const tracker = new NotifyHoldTracker();
  assert.equal(tracker.isHeld('worker'), false);
  tracker.beginCycle();
  tracker.held('worker', {code: 'KADAN_PANE_IN_MODE', message: 'copy mode'});
  assert.equal(tracker.isHeld('worker'), true, '이번 주기');
  tracker.endCycle(Date.now());
  tracker.beginCycle();
  assert.equal(tracker.isHeld('worker'), true, '이전 주기부터 이어짐');
  tracker.endCycle(Date.now());
  tracker.beginCycle();
  tracker.delivered('worker', {});
  tracker.endCycle(Date.now());
  assert.equal(tracker.isHeld('worker'), false);
  assert.equal(tracker.isHeld('other'), false);
});

test('F2: 보류 중인 역할(KADAN_PANE_IN_MODE 등 holdCode 무엇이든)은 빈 입력창이어도 멈춤 0건', () => {
  for (const code of ['KADAN_PANE_IN_MODE', 'KADAN_HUMAN_ACTIVE']) {
    const tracker = new NotifyHoldTracker();
    const held = () => tracker.isHeld('worker');
    let states = new Map();
    const alerts = [];
    for (let i = 0; i < 8; i++) {
      tracker.beginCycle();
      tracker.held('worker', {code, message: 'hold'});
      const result = assessIdleStop(states, observe(codexIdle), {
        elapsedMs: 60_000, intervalMs: 60_000, tasks: [task], entries: [],
        excludedSessions: new Set(held() ? ['kadan-worker'] : []),
      });
      states = result.states;
      alerts.push(...result.alerts);
      tracker.endCycle(Date.now());
    }
    assert.equal(alerts.length, 0, code);
  }
  // 보류가 풀리면 다시 4분을 채워야 경보한다.
  assert.equal(idleRun(Array(5).fill(codexIdle)).at(-1).length, 1);
});
import {statusProgress} from '../src/watch-status-line.mjs';
test('statusProgress: 시계 증가=진행, 같은 시계·처음 본 화면·오류 낱말·화면 없음=진행 아님',()=>{
 assert.equal(statusProgress(codexWorking('5m 12s'),300).moving,true);
 assert.equal(statusProgress(codexWorking('5m 12s'),312).moving,false);
 assert.equal(statusProgress(codexWorking('5m 12s'),null).moving,false);
 assert.equal(statusProgress(reconnecting('5m 12s'),300).moving,false);
 assert.deepEqual(statusProgress(null,300),{status:null,moving:false});
 assert.equal(statusProgress(codexIdle,300).status.kind,'idle');
});

// ---- PR #374 검수 F1: 일하는 표시를 찾는 범위 ----
// 화면 끝 14줄에 더해, 그 14줄 안의 마지막 입력 줄 위로 10줄까지는 항상 본다. 범위는 넓어지기만 한다.
const bottom14 = screen => {
  const lines = screen.split('\n');
  while (lines.length && lines.at(-1).trim() === '') lines.pop();
  return lines.slice(-14).join('\n');
};
const SPINNER = '✢ Grooving… (32s · ↓ 1.7k tokens)';
const RULE40 = '─'.repeat(40);
const longFooter = (input, gap, count, top = [SPINNER]) =>
  [...top, ...Array(gap).fill(''), RULE40, input, RULE40, ...Array.from({length: count}, (_, i) => `  알림 ${i + 1}`)].join('\n');

test('F1: 바닥글 8줄이어도 입력 줄 위 10줄 안의 회전 줄·도구 실행 줄은 working이다', () => {
  for (const gap of [1, 2, 3, 4, 8]) {
    assert.deepEqual(readStatusLine(longFooter('❯ ', gap, 8)), {kind: 'working', tool: 'claude', clockSec: 32}, `빈 줄 ${gap}`);
    assert.equal(readStatusLine(longFooter('❯ 친 글', gap, 8)).kind, 'working', `친 글 · 빈 줄 ${gap}`);
    assert.equal(readStatusLine(longFooter('❯ ', gap, 8, ['  ⎿  Running… (4s)'])).kind, 'working', `도구 줄 · 빈 줄 ${gap}`);
  }
  // 입력 줄 위 10번째 줄까지 본다(회전 줄 + 빈 줄 8 + 가로줄 = 10줄). 그 밖은 지금처럼 보지 않는다.
  assert.equal(readStatusLine(longFooter('❯ ', 9, 8)).kind, 'idle');
  // codex 입력 줄도 같다.
  const codex = gap => ['• Working (5m 12s • esc to interrupt)', ...Array(gap).fill(''), '› Ask Codex to do anything', '',
    ...Array.from({length: 9}, (_, i) => `  줄 ${i + 1}`)].join('\n');
  assert.deepEqual(readStatusLine(codex(4)), {kind: 'working', tool: 'codex', clockSec: 312});
});

test('F1: 입력 줄을 못 찾은 화면과 14줄 밖의 입력 줄은 예전과 똑같이 동작한다', () => {
  // 화면 끝 14줄 안에 입력 줄이 없으면 회전 줄이 15번째에 있어도 찾지 않는다.
  const noInput = [SPINNER, ...Array.from({length: 14}, (_, i) => `본문 ${i + 1}`)].join('\n');
  assert.equal(readStatusLine(noInput).kind, 'unknown');
  // 입력 줄이 14줄 밖이면 idle로도 working으로도 읽지 않는다.
  const farInput = [SPINNER, RULE40, '❯ ', RULE40, ...Array.from({length: 14}, (_, i) => `본문 ${i + 1}`)].join('\n');
  assert.equal(readStatusLine(farInput).kind, 'unknown');
});

test('F1: 범위는 넓어지기만 한다 — 화면 끝 14줄만 본 판정과 다르면 그것은 working뿐이다', () => {
  const pad = Array.from({length: 12}, (_, i) => `앞선 본문 ${i + 1}`);
  const samples = [codexWorking('5m 12s'), codexWorkingQueued, codexIdle, reconnecting('5m 12s'), claudeIdle,
    claudeWorkingReal('✢', '32s'), claudeWorkingReal('·', '1m 02s'), withoutSpinner(claudeWorkingReal('✢', '32s')),
    toolOnly('4s'), toolOnly('1m 10s')];
  let widened = 0;
  const check = (screen, label) => {
    const now = readStatusLine(screen), before = readStatusLine(bottom14(screen));
    if (now.kind === before.kind) { assert.deepEqual(now, before, label); return; }
    assert.equal(now.kind, 'working', label);
    widened += 1;
  };
  // 기존 실측 표본: 그대로, 그리고 위에 본문을 붙여 화면이 길어져도 판정이 같다.
  for (const [i, sample] of samples.entries()) {
    assert.deepEqual(readStatusLine(sample), readStatusLine(bottom14(sample)), `표본 ${i}`);
    assert.deepEqual(readStatusLine([...pad, sample].join('\n')), readStatusLine(sample), `표본 ${i} + 본문`);
  }
  // 합성 격자: 입력 3종 × 빈 줄 0~12 × 바닥글 0~10줄 × 회전 줄 있음/없음.
  for (const input of ['❯ ', '❯ 친 글', '  본문 줄']) {
    for (let gap = 0; gap <= 12; gap++) {
      for (let count = 0; count <= 10; count++) {
        check(longFooter(input, gap, count), `회전 · ${input} · 빈 줄 ${gap} · 바닥글 ${count}`);
        check(longFooter(input, gap, count, ['✻ Cogitated for 3m 44s']), `완료 · ${input} · 빈 줄 ${gap} · 바닥글 ${count}`);
      }
    }
  }
  assert.ok(widened > 0, '넓어진 칸이 하나는 있어야 한다');
});

// ---- 백그라운드 셸 표시: 상한까지 멈춤을 늦춘다 ----
// 표시 줄은 감시AI 관찰 자료의 실제 화면에서 확인한 모양이다(숫자·낱말만 바꿈).
const claudeBackgroundLine = (verb = 'Churned', shells = '2 shells') => `✻ ${verb} for 6m 29s · done 10:59 AM · ${shells} still running`;
const claudeBackground = line => claudeIdle.replace('✻ Cogitated for 3m 44s · done 1:16 PM', line);
const codexBackground = ['─ Worked for 17m 42s ─────────────────', '', '  2 background terminals running · /ps to view · /stop to close', '', '',
  '› Ask Codex to do anything', '', '  gpt-6-astra medium · ~/Dev/kadan-lite · main · Context 63% used · 258K window'].join('\n');
const codexWaitingBackground = ['• Waiting for background terminal (5m 12s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close',
  '', '', '› Ask Codex to do anything', '', '  gpt-6-astra medium · ~/Dev/kadan-lite · main · Context 63% used · 258K window'].join('\n');
const graceMin = BACKGROUND_GRACE_MS / 60_000;

test('백그라운드 표시를 읽는다: claude 끝난 턴 요약 줄, codex 단독 줄·기다리는 줄. 표시가 없거나 모양이 다르면 null', () => {
  assert.equal(graceMin, 30);
  assert.deepEqual(backgroundMarker(claudeBackground(claudeBackgroundLine())), {line: claudeBackgroundLine(), count: 2});
  assert.equal(backgroundMarker(claudeBackground(claudeBackgroundLine('Cooked', '1 shell'))).count, 1);
  assert.equal(backgroundMarker(claudeBackground('✻ Cooked for 24s · done 오후 7:41 · 3 shells still running')).count, 3);
  assert.equal(backgroundMarker(codexBackground).count, 2);
  assert.equal(backgroundMarker(codexWaitingBackground).count, 1);
  for (const none of [claudeIdle, codexIdle, claudeBackground('✻ Churned for 6m 29s · done 10:59 AM · 2 tasks in background'),
    claudeBackground('  본문에서 2 shells still running 이라고 말함'), null, '']) assert.equal(backgroundMarker(none), null);
  // 화면 위쪽으로 밀려난 옛 표시는 보지 않는다(일하는 표시를 찾는 범위와 같다).
  assert.equal(backgroundMarker([claudeBackgroundLine(), ...Array(30).fill('  본문 줄'), claudeIdle].join('\n')), null);
});

test('백그라운드 표시가 이어지는 동안 30분 전에는 멈춤 0건, 30분에 1건과 표시 시간·개수', () => {
  for (const [name, screen, tool] of [['claude', claudeBackground(claudeBackgroundLine()), 'claude'], ['codex 단독 줄', codexBackground, 'codex'],
    ['codex 기다리는 줄', codexWaitingBackground, 'codex']]) {
    const alerts = idleRun(Array(graceMin + 3).fill(screen));
    assert.equal(alerts.slice(0, graceMin).flat().length, 0, `${name}: 29분째 주기까지 0건`);
    const [alert] = alerts[graceMin];
    assert.equal(alert.kind, '멈춤', name);
    assert.equal(alert.backgroundMs, BACKGROUND_GRACE_MS, name);
    assert.equal(alert.tool, tool);
    assert.ok(alert.backgroundCount >= 1);
    assert.equal(alerts[graceMin + 2][0].id, alert.id, `${name}: 같은 화면이면 같은 경보(다시 알리지 않는다)`);
  }
});

test('백그라운드 표시로 늦추는 세션을 held로 돌려주고, 상한이 지나면 held에서 뺀다', () => {
  let states = new Map();
  const heldAt = [];
  for (let minute = 0; minute <= graceMin; minute++) {
    const result = assessIdleStop(states, observe(codexBackground), {elapsedMs: 60_000, intervalMs: 60_000, tasks: [task], entries: []});
    states = result.states;
    heldAt.push(result.held.has('kadan-worker'));
  }
  assert.ok(heldAt.slice(0, graceMin).every(Boolean), '상한 전에는 늦추는 중');
  assert.equal(heldAt[graceMin], false, '상한이 지나면 늦추지 않는다');
  assert.equal(assessIdleStop(new Map(), observe(codexIdle), {elapsedMs: 60_000, intervalMs: 60_000, tasks: [task], entries: []}).held.size, 0, '표시 없음');
});

test('표시가 사라지면 그때부터 4분, 표시 줄이 바뀌면(새 턴이 끝남) 30분을 다시 센다', () => {
  const afterMin = IDLE_STOP_AFTER_MS / 60_000;
  const gone = idleRun([...Array(10).fill(claudeBackground(claudeBackgroundLine())), ...Array(afterMin + 1).fill(claudeIdle)]);
  assert.equal(gone.slice(0, 10 + afterMin).flat().length, 0);
  assert.equal(gone.at(-1).length, 1);
  assert.equal(gone.at(-1)[0].backgroundMs, undefined, '표시가 없으면 표시 시간도 없다');
  const changed = idleRun([...Array(20).fill(claudeBackground(claudeBackgroundLine('Churned'))), ...Array(graceMin + 1).fill(claudeBackground(claudeBackgroundLine('Cooked')))]);
  assert.equal(changed.slice(0, 20 + graceMin).flat().length, 0, '바뀐 줄부터 다시 30분');
  assert.equal(changed.at(-1).length, 1);
});

test('표시 문구가 바뀌어 못 읽으면 지금처럼 4분에 멈춤이 난다(놓치지 않는 쪽)', () => {
  const afterMin = IDLE_STOP_AFTER_MS / 60_000;
  const unknown = claudeBackground('✻ Churned for 6m 29s · done 10:59 AM · 2 background jobs active');
  const alerts = idleRun(Array(afterMin + 1).fill(unknown));
  assert.equal(alerts.at(-1).length, 1);
  assert.equal(alerts.at(-1)[0].backgroundMs, undefined);
});

test('표시가 있어도 정당한 대기 제외와 일하는 중 판정은 그대로다', () => {
  const n = graceMin + 5, screen = claudeBackground(claudeBackgroundLine());
  assert.equal(idleRun(Array(n).fill(screen), {observe: {doneMarker: {taskId: 'c1', result: 'ok'}}}).flat().length, 0, '완료후보');
  assert.equal(idleRun(Array(n).fill(screen), {options: {tasks: []}}).flat().length, 0, '감시 범위 밖');
  // codex가 실제로 일하는 줄(Working … esc to interrupt)에 붙은 표시는 일하는 중이다: 멈춤 후보가 아니다.
  assert.equal(idleRun(Array.from({length: n}, (_, i) => codexWorkingBackground(`${i}m 00s`))).flat().length, 0);
});

test('잠든 공백은 표시가 이어진 시간에 더하지 않는다', () => {
  const screen = claudeBackground(claudeBackgroundLine());
  let states = new Map();
  const step = elapsedMs => { const result = assessIdleStop(states, observe(screen), {elapsedMs, intervalMs: 60_000, tasks: [task], entries: []}); states = result.states; return result; };
  for (let i = 0; i < 10; i++) step(60_000);
  assert.equal(step(8 * 3_600_000).alerts.length, 0, '여덟 시간 잠들었다 깬 주기');
  assert.equal(states.get('kadan-worker').backgroundMs, 9 * 60_000);
});

test('codex 기다리는 줄의 시계가 주기마다 늘어도 같은 표시로 이어 센다(상한에 닿는다)', () => {
  const ticking = minute => codexWaitingBackground.replace('5m 12s', `${minute}m 12s`);
  assert.equal(backgroundMarker(ticking(3)).line, backgroundMarker(ticking(47)).line, '비교 값에 시계가 없다');
  const alerts = idleRun(Array.from({length: graceMin + 2}, (_, minute) => ticking(minute)));
  assert.equal(alerts.slice(0, graceMin).flat().length, 0);
  assert.equal(alerts[graceMin].length, 1, '30분에 멈춤');
  assert.equal(alerts[graceMin][0].backgroundMs, BACKGROUND_GRACE_MS);
});

test('멈춤 후보에서 잠깐 빠지는 주기가 끼어도 표시가 이어진 시간을 다시 세지 않는다', () => {
  const screen = claudeBackground(claudeBackgroundLine());
  let states = new Map();
  const out = [];
  for (let minute = 0; minute <= graceMin + 1; minute++) {
    // 10·11·20분 주기에는 알림 밀림 등으로 멈춤 후보에서 빠진다.
    const excluded = [10, 11, 20].includes(minute) ? new Set(['kadan-worker']) : new Set();
    const result = assessIdleStop(states, observe(screen), {elapsedMs: 60_000, intervalMs: 60_000, tasks: [task], entries: [], excludedSessions: excluded});
    states = result.states; out.push(result);
  }
  assert.equal(out.slice(0, graceMin).flatMap(r => r.alerts).length, 0);
  assert.equal(out[10].held.size, 0, '빠진 주기에는 늦추는 세션으로도 세지 않는다');
  assert.equal(states.get('kadan-worker').backgroundMs, (graceMin + 1) * 60_000, '이어 센다');
  // 빠졌던 주기 뒤 빈 입력창 4분을 다시 채운 다음, 상한을 넘겼으므로 멈춤이 난다.
  assert.equal(out[graceMin].alerts.length, 1);
});

test('더 새 턴이 표시 없이 끝났으면 위쪽의 옛 표시는 읽지 않는다', () => {
  const older = claudeBackgroundLine('Churned');
  const newerPlain = ['⏺ 앞 턴의 답.', '', older, '', '⏺ 다음 턴의 답. 백그라운드 작업이 끝났다.', '', claudeIdle].join('\n');
  assert.equal(backgroundMarker(newerPlain), null);
  const newerMarked = ['⏺ 앞 턴의 답.', '', older, '', '⏺ 다음 턴의 답.', '', claudeBackground(claudeBackgroundLine('Cooked', '1 shell'))].join('\n');
  assert.equal(backgroundMarker(newerMarked).line, claudeBackgroundLine('Cooked', '1 shell'));
  // 답 본문의 "… for …" 문장은 턴 요약 줄이 아니다: 그 위의 표시를 가리지 않는다.
  const prose = [older, '', '⏺ Waiting for the build to finish.', '', ...claudeIdle.split('\n').slice(2)].join('\n');
  assert.equal(backgroundMarker(prose).line, older);
  const afterMin = IDLE_STOP_AFTER_MS / 60_000;
  assert.equal(idleRun(Array(afterMin + 1).fill(newerPlain)).at(-1).length, 1, '옛 표시만 있는 화면은 지금처럼 4분에 멈춤');
});
