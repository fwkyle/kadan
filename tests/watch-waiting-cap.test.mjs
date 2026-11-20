import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setImmediate} from 'node:timers/promises';
import {runWatch} from '../src/watch-runner.mjs';
import {assessWaitingCap, waitingStopScreen, WAITING_CAP_MS} from '../src/watch-waiting-stop.mjs';
import {SUPERVISOR_CHECK_MS} from '../src/watch-supervisor-health.mjs';
import {readStatusLine, backgroundMarker} from '../src/watch-status-line.mjs';
import {changeDigest} from '../src/watch-roles.mjs';
import {formatAlertBody, itemizedAlert} from '../src/watch-alert-body.mjs';

// 대기 시간 상한(마지막 그물): 대기 표시(card progress --activity waiting)를 남긴 실행의 화면이 일하는 표시 없이
// 1시간 그대로면 직속 상위에게 한 번 알린다. 가짜 시계·가짜 바닥·가짜 전송기·가짜 AI만 쓴다. 역할 이름은 가짜다.
// "기대 결과 표"라고 적은 시험은 발령 카드의 표 한 줄씩이다(판정 기준: main에서는 이 경보가 늘 0이다).
const fixture = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const REAL = fixture('waiting-cap-screens.json');
const INCIDENT = fixture('waiting-capacity-screens.json').incident; // 이미 아는 정지 문구 화면(`대기중정지` 대상)
const COMPOSER = '› Ask Codex to do anything\n\n  gpt-6.1-sol high · ~/Dev/PROJ · main · Context 41% used\n';
const TOOL = '• Ran npm test\n  └ 4 passed\n    +2 lines';
// 문구 목록에 없는 오류 화면: 턴이 끝나 빈 입력창으로 돌아왔다(문구 검사가 놓치는 모양).
const UNKNOWN_ERROR = `${TOOL}\n\n■ Unexpected failure while streaming the response (code 7).\n\n${COMPOSER}`;
// 오류 글도 없이 조용히 멈춘 빈 입력창.
const QUIET = `• 다른 시험이 끝나면 전체 시험을 돌리겠습니다.\n\n${COMPOSER}`;
const clock = minute => minute < 60 ? `${minute}m 36s` : `${Math.floor(minute / 60)}h ${String(minute % 60).padStart(2, '0')}m 36s`;
// 실제 화면의 일하는 줄 시계만 순회마다 늘린다(턴이 도는 중).
const claudeTurn = minute => REAL.claudeLimiterWait.replace('31m 36s', clock(31 + minute));
const codexTurn = minute => REAL.codexWorking.replace('46m 03s', clock(46 + minute));

const CAP = WAITING_CAP_MS / 60_000;
const epoch = Date.parse('2026-11-18T06:54:00Z');
const stamp = minute => new Date(epoch + minute * 60_000).toISOString();
const WORKER = 'qa-reviewer', BOSS = 'qa-boss', TOP = 'qa-top', SESSION = `kadan-${WORKER}`;
const parents = new Map([[WORKER, BOSS], [BOSS, TOP], [TOP, '@user']]);
const start = (role, panePid) => ({kind: 'start', role, session: `kadan-${role}`, panePid, harness: 'codex', model: 'm', t: stamp(0)});
const starts = [start(WORKER, 1), start(BOSS, 2), start(TOP, 3)];
const KEY = 'qa/qa-task', WORK = 'qa/work-1';
const running = {id: 'qa-task', key: KEY, role: WORKER, board: 'qa', status: 'assigned', workType: 'execution',
  activity: 'running', activityRole: WORKER, activityAt: stamp(0), at: stamp(0)};
const WAIT_NOTE = '다른 시험 종료 뒤 전체 시험 대기';
const waiting = {...running, activity: 'waiting', activityAt: stamp(1), at: stamp(1), noteKind: 'progress', note: WAIT_NOTE, by: WORKER};
const dispatch = {kind: 'send', role: WORKER, session: SESSION, taskId: 'qa-task', executionKey: KEY, by: BOSS, t: stamp(0)};
const work = extra => ({key: WORK, status: 'open', owner: BOSS, executions: [{key: KEY}], history: [{action: 'create', at: stamp(0)}], ...extra});

// screen·card·alive·extra·works·decisions는 분(minute)을 받아 그 순회의 값을 준다. from~until-1분의 순회를 돈다.
// keys: 대기 세션에 닿을 수 있는 모든 입력 길(재개·큐 Enter·알림·넛지). seed: 앞선 감시기가 남긴 원장(재시작).
async function simulate({screen = () => UNKNOWN_ERROR, card = () => waiting, alive = () => true, from = 0, until = CAP + 10, seed = null,
  extra = () => [], works = () => [], decisions = () => []} = {}) {
  let minute = from;
  const entries = seed ?? [...starts, dispatch];
  const before = entries.length, sent = [], keys = [], aiCalls = [];
  const controller = new AbortController();
  await runWatch({signal: controller.signal, intervalMs: 60_000, stallN: 2, stallAfterMs: 300_000, idleMs: 15 * 60_000,
    parents, routes: new Map(), superRole: TOP, now: () => epoch + minute * 60_000,
    floor: {list: () => starts.filter(s => s.role !== WORKER || alive(minute)).map(s => ({session: s.session, pid: s.panePid})),
      read: session => session === SESSION ? screen(minute) : `• 맡긴 재판정 결과를 기다립니다. ${minute}분\n\n${COMPOSER}`, alive: () => true},
    readEntries: () => [...entries, ...extra(minute)], readCards: () => [card(minute)], readWorks: () => works(minute),
    readDecisions: () => decisions(minute),
    resume429: (role, text) => keys.push(['resume429', role, text]),
    sendQueueEnter: session => keys.push(['queue-enter', session]),
    sendAlert: (role, message) => { sent.push({minute, role, message}); if (role === WORKER) keys.push(['alert', role]); },
    sendNudge: (role, message) => { sent.push({minute, role, message, nudge: true}); if (role === WORKER) keys.push(['nudge', role]); },
    judgeCmd: 'fake', judgeCooldownMs: 60_000,
    ai: {reports: {retire: () => {}}, run: args => { aiCalls.push([minute, args.source, args.role]); return {ok: true}; }},
    record: e => entries.push({...e, t: stamp(minute)}), spawn: () => ({status: 0, stdout: ''}), print: () => {},
    sleep: async () => { await setImmediate(); if (++minute >= until) controller.abort(); }});
  const records = entries.slice(before);
  const alerts = records.filter(e => e.kind === 'alert' && e.session === SESSION);
  const ofCap = alerts.filter(e => e.alertKind === '대기중장기정지');
  return {entries, sent, keys, alerts, cap: ofCap.filter(e => !e.resolved), capResolved: ofCap.filter(e => e.resolved),
    retired: alerts.filter(e => e.alertKind === '감시제외'), stops: alerts.filter(e => e.alertKind === '대기중정지' && !e.resolved),
    capMails: sent.filter(m => /화면이 오래 그대로/u.test(m.message)),
    workerAI: aiCalls.filter(([, , role]) => role === WORKER)};
}

test('상수: 상한은 감독 정기 점검 주기와 같은 1시간이고, 시험 화면은 뜻한 모양으로 읽힌다', () => {
  assert.equal(WAITING_CAP_MS, SUPERVISOR_CHECK_MS);
  assert.equal(WAITING_CAP_MS, 60 * 60_000);
  for (const idle of [UNKNOWN_ERROR, QUIET]) {
    assert.equal(waitingStopScreen(idle), null, '문구 검사는 이 화면을 정지로 읽지 않는다');
    assert.equal(readStatusLine(idle).kind, 'idle');
  }
  assert.deepEqual([readStatusLine(REAL.claudeLimiterWait).kind, readStatusLine(REAL.codexWorking).kind], ['working', 'working']);
  // 변화 지문은 숫자를 지운다: 시계만 도는 화면은 '변화 없음'이라, 지문만으로는 턴이 도는 대기와 멈춤을 가르지 못한다.
  assert.equal(changeDigest(claudeTurn(0)), changeDigest(claudeTurn(20)));
  assert.equal(changeDigest(codexTurn(0)), changeDigest(codexTurn(10)));
  // 시계가 1시간을 넘어 모양이 바뀌는 순간(`59m 36s` → `1h 00m 36s`)에는 지문도 한 번 바뀐다.
  assert.notEqual(changeDigest(codexTurn(13)), changeDigest(codexTurn(14)));
});

test('기대 결과 표 1: 턴이 끝난 빈 입력창이 1시간 그대로면 경보 1회, 다음 주기 0회, 키 0회, AI 0회', async () => {
  for (const screen of [UNKNOWN_ERROR, QUIET]) {
    const r = await simulate({screen: () => screen});
    assert.equal(r.cap.length, 1, '70주기 동안 경보 기록은 한 번');
    assert.deepEqual([r.cap[0].recipient, r.cap[0].delivered, r.cap[0].level, r.cap[0].t], [BOSS, true, 'AMBER', stamp(CAP)]);
    assert.equal(r.capMails.length, 1, '우편도 한 번');
    assert.deepEqual([r.capMails[0].role, r.capMails[0].minute], [BOSS, CAP]);
    for (const part of [KEY, WAIT_NOTE, `같은 화면 ${CAP}분째`, '정체 감시 밖', '대상: ' + SESSION])
      assert.ok(r.capMails[0].message.includes(part), part);
    assert.deepEqual([r.keys, r.workerAI], [[], []], '대기 세션에 키도 AI도 붙지 않는다');
    assert.deepEqual([r.capResolved, r.retired, r.stops], [[], [], []], '그대로인 동안 풀리지도 퇴역(감시제외)하지도 않고 대기중정지와 겹치지 않는다');
  }
});

test('기대 결과 표 2: 같은 화면이 1시간 미만이면 0회', async () => {
  const r = await simulate({until: CAP}); // 0~59분의 순회
  assert.deepEqual([r.cap, r.capMails, r.keys, r.workerAI], [[], [], [], []]);
});

test('기대 결과 표 3: 턴이 도는 중(시계 진행·도구 호출 중)이면 1시간이 넘어도 0회 — 실제 화면 고정본', async () => {
  for (const [name, screen] of [['claude 제한기 호출 대기', claudeTurn], ['codex 일하는 중', codexTurn]]) {
    const r = await simulate({screen, until: CAP + 30});
    assert.deepEqual([r.cap, r.capMails, r.keys, r.workerAI], [[], [], [], []], name);
  }
  // 턴이 돌다가 끝나 빈 입력창이 되면 그때부터 잰다.
  const ended = await simulate({screen: minute => minute < 30 ? codexTurn(minute) : QUIET, until: 30 + CAP + 5});
  assert.deepEqual(ended.cap.map(e => e.t), [stamp(30 + CAP)]);
});

test('기대 결과 표 4: 등록된 답 대기·업무 대기 시각·일시정지·결과 등록 뒤 확정 대기는 0회', async () => {
  const ask = execution => () => [{kind: 'send', mailId: 'q-worker', by: WORKER, role: BOSS, session: `kadan-${BOSS}`, keyDelivery: 'sent',
    expectReply: true, ...(execution ? {executionKey: KEY} : {}), t: stamp(1)}];
  const cases = {
    '실행에 연결한 질문 우편(--execution --expect-reply)': {extra: ask(true)},
    '실행을 특정하지 않은 질문 우편(--expect-reply)': {extra: ask(false)},
    '사용자 결정 대기': {decisions: () => [{id: 'd-1', status: 'open', card: KEY, requestedBy: BOSS, question: '진행할까요', at: stamp(1)}]},
    '업무 대기 시각(wait-until)': {works: () => [work({waitUntil: stamp(600), waitUntilSetAt: stamp(1)})]},
    '일시정지(hold)': {card: () => ({...waiting, status: 'hold'})},
    '결과 등록 뒤 확정 대기': {card: () => ({...waiting, result: {by: WORKER, at: stamp(1), outcome: 'implemented'}})},
  };
  for (const [name, options] of Object.entries(cases)) {
    const r = await simulate(options);
    assert.deepEqual([r.cap, r.capMails], [[], []], name);
  }
  // 양성 대조: 같은 업무가 있어도 대기 시각이 없으면 난다. 답이 닫히면 그때부터가 아니라 화면이 그대로인 시간으로 잰다.
  const plain = await simulate({works: () => [work()]});
  assert.equal(plain.cap.length, 1);
  // 업무 대기 시각이 지나면 그때부터 다시 잰다(대기한 시간은 세지 않는다).
  const expired = await simulate({works: () => [work({waitUntil: stamp(20), waitUntilSetAt: stamp(1)})], until: 20 + CAP + 5});
  assert.deepEqual(expired.cap.map(e => e.t), [stamp(20 + CAP)]);
});

test('기대 결과 표 5: 화면이 바뀌면 타이머는 처음부터, 열린 경보는 해제', async () => {
  const changedScreen = `${QUIET}\n`.replace('전체 시험을 돌리겠습니다', '전체 시험을 다시 확인합니다');
  // 상한 전에 바뀌면 그때부터 다시 1시간.
  const early = await simulate({screen: minute => minute < 40 ? QUIET : changedScreen, until: 40 + CAP + 5});
  assert.deepEqual(early.cap.map(e => e.t), [stamp(40 + CAP)]);
  // 경보가 열린 뒤 바뀌면 그 주기에 닫히고, 다시 1시간 그대로면 새로 한 번 알린다.
  const late = await simulate({screen: minute => minute < CAP + 10 ? QUIET : changedScreen, until: 2 * CAP + 15});
  assert.deepEqual(late.cap.map(e => e.t), [stamp(CAP), stamp(2 * CAP + 10)]);
  assert.deepEqual(late.capResolved.map(e => e.t), [stamp(CAP + 10)]);
  assert.deepEqual([late.capMails.length, late.keys], [2, []]);
  // 턴이 다시 돌기 시작해도(시계 진행) 닫힌다.
  const resumed = await simulate({screen: minute => minute < CAP + 5 ? QUIET : codexTurn(minute), until: CAP + 12});
  assert.deepEqual([resumed.cap.length, resumed.capResolved.length], [1, 1]);
});

test('기대 결과 표 6: 대기 표시가 풀리거나 실행이 끝나면 경보가 해제된다', async () => {
  const lifted = await simulate({card: minute => minute < CAP + 3 ? waiting : {...running, activityAt: stamp(CAP + 3), at: stamp(CAP + 3)}, until: CAP + 6});
  assert.deepEqual([lifted.cap.length, lifted.capResolved.map(e => e.t)], [1, [stamp(CAP + 3)]]);
  const done = await simulate({extra: minute => minute >= CAP + 3 ? [{kind: 'done', role: WORKER, taskId: 'qa-task', executionKey: KEY, result: 'ok', t: stamp(CAP + 3)}] : [], until: CAP + 6});
  assert.deepEqual([done.cap.length, done.capResolved.length], [1, 1]);
  const closed = await simulate({card: minute => minute < CAP + 3 ? waiting : {...waiting, status: 'done'}, until: CAP + 6});
  assert.deepEqual([closed.cap.length, closed.capResolved.length], [1, 1]);
  // 대기 세션이 사라지면 닫힌다(죽음 자체는 알리지 않는다: 이 검사의 범위 밖).
  const gone = await simulate({alive: minute => minute < CAP + 3, until: CAP + 6});
  assert.deepEqual([gone.cap.length, gone.capResolved.length, gone.capMails.length], [1, 1, 1]);
});

test('기대 결과 표 7: 경보가 열린 채 감시기를 다시 시작해도 다시 알리지 않는다', async () => {
  const first = await simulate({screen: () => QUIET, until: CAP + 5});
  assert.equal(first.cap.length, 1);
  // 같은 원장을 이어받은 새 감시기: 재시작 뒤 1시간이 지나도 같은 화면이면 기록도 우편도 0이다.
  const again = await simulate({screen: () => QUIET, seed: first.entries, from: CAP + 5, until: 2 * CAP + 20});
  assert.deepEqual([again.cap, again.capResolved, again.capMails, again.retired, again.keys], [[], [], [], [], []]);
  // 재시작 뒤 화면이 바뀌면 닫히고, 그때부터 다시 잰다.
  const moved = await simulate({screen: minute => minute < CAP + 8 ? QUIET : UNKNOWN_ERROR, seed: first.entries.slice(), from: CAP + 5, until: 2 * CAP + 12});
  assert.deepEqual([moved.capResolved.map(e => e.t), moved.cap.map(e => e.t)], [[stamp(CAP + 8)], [stamp(2 * CAP + 8)]]);
});

test('기대 결과 표 8: 정지 문구 화면은 대기중정지 1회만 나고 새 경보는 0회', async () => {
  const r = await simulate({screen: () => INCIDENT, until: CAP + 30});
  assert.deepEqual([r.stops.length, r.cap, r.capMails], [1, [], []]);
  assert.equal(r.sent.filter(m => m.role === BOSS && /대기 표시 중/u.test(m.message)).length, 1, '대기 표시 경보 우편은 하나뿐');
  // 정지 문구가 사라지고 빈 입력창만 남으면 그때부터 잰다.
  const cleared = await simulate({screen: minute => minute < 20 ? INCIDENT : QUIET, until: 20 + CAP + 5});
  assert.deepEqual(cleared.cap.map(e => e.t), [stamp(20 + CAP)]);
});

test('스스로 정한 경계: 얼어붙은 일하는 줄·백그라운드 표시·보내지 않은 입력도 1시간 그대로면 알린다', async () => {
  // 일하는 줄이 있어도 시계가 멈춰 있으면 턴이 도는 것이 아니다(statusProgress와 같은 기준).
  const frozen = await simulate({screen: () => REAL.codexWorking});
  assert.equal(frozen.cap.length, 1);
  // 백그라운드 셸을 기다리는 빈 입력창: 일하는 줄(Working)이 아니라 idle로 읽힌다. 감시 범위 안의 멈춤도 30분 유예 뒤에 난다.
  const background = minute => ['• Ran npm test', '',
    `• Waiting for background terminal (${clock(65 + minute)} • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close`,
    '', '', COMPOSER].join('\n');
  assert.deepEqual([readStatusLine(background(0)).kind, backgroundMarker(background(0))?.count], ['idle', 1]);
  assert.equal((await simulate({screen: background})).cap.length, 1);
  // 입력창에 보내지 않은 글이 남은 화면(일하는 표시도 빈 입력창도 아님).
  const typed = QUIET.replace('› Ask Codex to do anything', '› 임시로 적어 둔 글');
  assert.equal(readStatusLine(typed).kind, 'unknown');
  assert.equal((await simulate({screen: () => typed})).cap.length, 1);
});

// --- 판정 함수 단독(감시기 없이) ---
const entry = {session: SESSION, role: WORKER, taskId: 'qa-task', executionKey: KEY, by: BOSS, card: waiting};
const seenOf = (screen, more = {}) => new Map([[SESSION, {alive: true, pid: 1, expectedPid: 1, screen, digest: screen == null ? null : changeDigest(screen), ...more}]]);
const step = (states, screen, options = {}, more = {}) =>
  assessWaitingCap(states, [entry], seenOf(screen, more), {elapsedMs: 60_000, intervalMs: 60_000, ...options});
const repeat = (count, screen, options) => {
  let result = {states: new Map(), alerts: []};
  for (let index = 0; index < count; index++) result = step(result.states, typeof screen === 'function' ? screen(index) : screen, options);
  return result;
};

test('경보 id에는 화면 지문이 없고(세션 + 실행), 본문은 복원된 경보에서도 값을 지어내지 않는다', () => {
  const one = repeat(CAP + 1, QUIET).alerts, other = repeat(CAP + 1, UNKNOWN_ERROR).alerts;
  assert.deepEqual([one.length, other.length], [1, 1]);
  assert.equal(one[0].id, `waiting-cap:${SESSION}:${KEY}`);
  assert.equal(one[0].id, other[0].id);
  assert.match(formatAlertBody(one[0]), /화면이 오래 그대로 kadan-qa-reviewer \/ qa\/qa-task \(대기 표시 .*같은 화면 60분째.*발령 qa-boss/u);
  const restored = {id: one[0].id, kind: '대기중장기정지', level: 'AMBER', role: WORKER, session: SESSION, taskId: 'qa-task'};
  assert.doesNotMatch(formatAlertBody(restored), /NaN|undefined|Invalid/u);
  assert.match(itemizedAlert(restored, '15:00'), /상태: 대기 표시 중 화면이 오래 그대로\n근거: 대기 표시; 일하는 표시 없이 같은 화면;/u);
});

test('맥북이 잠든 공백은 세지 않고, 답 대기 목록을 못 읽은 순회에는 새 경보를 열지 않는다', () => {
  const half = repeat(31, QUIET); // 30분
  const woke = step(half.states, QUIET, {elapsedMs: 8 * 3_600_000});
  assert.deepEqual([woke.alerts, woke.states.get(`waiting-cap:${SESSION}:${KEY}`).stillMs], [[], 30 * 60_000]);
  // 못 읽는 동안에도 시간은 센다. 읽게 되면 그 주기에 연다. 이미 연 경보는 못 읽어도 그대로 둔다.
  const blind = repeat(CAP + 5, QUIET, {canOpen: false});
  assert.deepEqual(blind.alerts, []);
  const opened = step(blind.states, QUIET);
  assert.equal(opened.alerts.length, 1);
  assert.equal(step(opened.states, QUIET, {canOpen: false}).alerts.length, 1);
});

test('화면만 못 읽은 순회는 판단하지 않는다: 시간과 열린 경보를 그대로 둔다', () => {
  const open = repeat(CAP + 1, QUIET);
  for (const more of [{screen: null, digest: null}, {pid: 9}]) {
    const blank = step(open.states, QUIET, {}, more);
    assert.deepEqual(blank.alerts.map(a => a.id), open.alerts.map(a => a.id));
    assert.equal(step(blank.states, QUIET).alerts.length, 1, '다시 읽히면 같은 경보가 이어진다');
  }
  const counting = repeat(31, QUIET);
  const blank = step(counting.states, null, {}, {screen: null, digest: null});
  assert.deepEqual([blank.alerts, blank.states.get(`waiting-cap:${SESSION}:${KEY}`).stillMs], [[], 30 * 60_000]);
  // 세션이 사라지면 상태를 버린다.
  const dead = assessWaitingCap(open.states, [entry], new Map([[SESSION, {alive: false}]]), {elapsedMs: 60_000, intervalMs: 60_000});
  assert.deepEqual([dead.alerts, dead.states.size], [[], 0]);
});
