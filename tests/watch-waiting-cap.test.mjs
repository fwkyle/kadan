import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {createDatabase, writeStorageMarker} from '../src/storage.mjs';
import {readLedger} from '../src/ledger.mjs';
import {CardStore} from '../src/card-store.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {Mailbox} from '../src/mailbox.mjs';
import {runWatch} from '../src/watch-runner.mjs';
import {assessWaitingCap, waitingStopScreen, WAITING_CAP_MS} from '../src/watch-waiting-stop.mjs';
import {SUPERVISOR_CHECK_MS} from '../src/watch-supervisor-health.mjs';
import {readStatusLine, backgroundMarker, statusProgress, workingClockText} from '../src/watch-status-line.mjs';
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
  extra = () => [], works = () => [], decisions = () => [], others = []} = {}) {
  let minute = from;
  const entries = seed ?? [...starts, dispatch];
  const before = entries.length, sent = [], keys = [], aiCalls = [];
  const controller = new AbortController();
  await runWatch({signal: controller.signal, intervalMs: 60_000, stallN: 2, stallAfterMs: 300_000, idleMs: 15 * 60_000,
    parents, routes: new Map(), superRole: TOP, now: () => epoch + minute * 60_000,
    floor: {list: () => starts.filter(s => s.role !== WORKER || alive(minute)).map(s => ({session: s.session, pid: s.panePid})),
      read: session => session === SESSION ? screen(minute) : `• 맡긴 재판정 결과를 기다립니다. ${minute}분\n\n${COMPOSER}`, alive: () => true},
    readEntries: () => [...entries, ...extra(minute)], readCards: () => [card(minute), ...others], readWorks: () => works(minute),
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
    '감독이 그 실행으로 상위에게 물은 질문 우편': {extra: () => [{kind: 'send', mailId: 'q-boss', by: BOSS, role: TOP, session: `kadan-${TOP}`,
      keyDelivery: 'sent', expectReply: true, executionKey: KEY, t: stamp(1)}]},
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

test('경계: 얼어붙은 일하는 줄·백그라운드 표시·보내지 않은 입력도 1시간 그대로면 알린다', async () => {
  // 일하는 줄이 있어도 시계가 멈춰 있으면 턴이 도는 것이 아니다.
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

// 수정 1(2026-11-20 검수 발견 2건)에서 기대 결과 표에 더한 줄.
test('더한 표 1: 시계가 매분 도는 작업 화면은 과거 도구 출력에 429 인용이 한 줄 있어도 0회', async () => {
  const quoted = minute => `  └ upstream returned 429 Too Many Requests\n\n${codexTurn(80 + minute)}`;
  assert.equal(waitingStopScreen(quoted(0)), null, '인용된 오류라 지금의 오류 화면(대기중정지)은 아니다');
  assert.equal(statusProgress(quoted(1), readStatusLine(quoted(0)).clockSec).moving, false, '공용 판정은 이 화면을 진행 중으로 보지 않는다(그대로 둔다)');
  assert.equal(changeDigest(quoted(0)), changeDigest(quoted(CAP + 20)), '화면 지문은 내내 같다');
  const r = await simulate({screen: quoted, until: CAP + 25});
  assert.deepEqual([r.cap, r.capMails, r.keys, r.workerAI], [[], [], [], []]);
});

test('더한 표 2: 분만 보이는 시계가 매분 바뀌는 작업 화면은 0회', async () => {
  const coarse = minute => codexTurn(80 + minute).replace(' 36s', '');
  assert.deepEqual([readStatusLine(coarse(0)).kind, readStatusLine(coarse(0)).clockSec], ['working', null], '초가 없어 시계 값은 읽히지 않는다');
  assert.notEqual(workingClockText(coarse(0)), workingClockText(coarse(1)), '시계 글자는 바뀐다');
  assert.equal(changeDigest(coarse(0)), changeDigest(coarse(CAP + 20)));
  const r = await simulate({screen: coarse, until: CAP + 25});
  assert.deepEqual([r.cap, r.capMails], [[], []]);
  // claude 일하는 줄도 같다.
  const claudeCoarse = minute => REAL.claudeLimiterWait.replace('31m 36s', `${100 + minute}m`);
  assert.equal(readStatusLine(claudeCoarse(0)).kind, 'working');
  assert.deepEqual((await simulate({screen: claudeCoarse, until: CAP + 25})).cap, []);
});

test('더한 표 3: 일하는 줄이 보여도 시계가 순회마다 그대로면(얼어붙음) 60분에 1회', async () => {
  for (const frozen of [REAL.codexWorking, REAL.codexWorking.replace(' 03s', ''), `  └ upstream returned 429 Too Many Requests\n\n${REAL.codexWorking}`]) {
    const r = await simulate({screen: () => frozen});
    assert.deepEqual(r.cap.map(e => e.t), [stamp(CAP)]);
  }
  // 시계가 한 순회만 그대로였다가 다시 돌면 알리지 않는다.
  const hiccup = await simulate({screen: minute => codexTurn(80 + (minute === 40 ? 39 : minute)), until: CAP + 25});
  assert.deepEqual(hiccup.cap, []);
});

const mailFrom = (minute, executionKey = null) => ({kind: 'send', mailId: `q-${minute}`, by: WORKER, role: BOSS, session: `kadan-${BOSS}`,
  keyDelivery: 'sent', expectReply: true, ...(executionKey ? {executionKey} : {}), t: stamp(minute)});

test('더한 표 4: 빈 입력창 60분 + 이전 발령 때 다른 실행으로 보낸 미답 질문은 1회(가리지 않는다)', async () => {
  for (const [name, old] of [['다른 실행에 연결한 옛 질문', mailFrom(-5, 'qa/qa-previous')], ['실행 연결 없는 옛 질문', mailFrom(-5)]]) {
    const r = await simulate({screen: () => QUIET, seed: [...starts, old, dispatch]});
    assert.deepEqual([r.cap.map(e => e.t), r.capMails.length], [[stamp(CAP)], 1], name);
  }
});

test('더한 표 5: 빈 입력창 + 현재 실행에 등록한 질문, 또는 현재 발령 뒤 보낸 열린 질문은 0회', async () => {
  const cases = {
    '현재 실행에 등록한 질문': [...starts, dispatch, mailFrom(1, KEY)],
    '현재 발령 뒤 보낸 열린 질문(실행 연결 없음)': [...starts, dispatch, mailFrom(1)],
    '현재 발령 뒤 다른 실행 키로 보낸 열린 질문': [...starts, dispatch, mailFrom(1, 'qa/qa-previous')],
    '재발령 전에 현재 실행에 등록해 둔 질문': [...starts, mailFrom(-5, KEY), dispatch],
  };
  for (const [name, seed] of Object.entries(cases)) {
    const r = await simulate({screen: () => QUIET, seed});
    assert.deepEqual([r.cap, r.capMails], [[], []], name);
  }
});

// 수정 2(2026-11-20 재검수 발견 1건): 답 대기로 타이머를 버리는 규칙을 모든 경로에서 고정한다.
// 두 실행(끝난 이전 실행 + 대기 표시한 현재 실행)을 같은 열린 업무에 둔다. 한 업무에 구현 → 수정 → 재검수 실행이 이어지는 평소 모양이다.
// 우편은 실제 우편함 저장 경로(Mailbox.send → resolveWorkMail)가 격리 홈에 남긴 원장 줄을 그대로 쓰고 시각(t)만 가짜 시계에 맞춘다.
const PREV = 'qa/qa-prev';
const MAILS = (() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-waiting-cap-mail-'));
  createDatabase(home); writeStorageMarker(home, 'sqlite');
  const cards = new CardStore(home), works = new WorkStore(home);
  works.create({key: WORK, title: '업무', goal: '결과', scope: '범위', acceptance: '기준', owner: BOSS, repoPath: home, board: 'qa', by: BOSS});
  for (const id of ['qa-prev', 'qa-task']) cards.create({repo: 'qa', id, repoPath: home, body: `# ${id}`, by: BOSS});
  const ask = (to, by, link) => new Mailbox(home, to).send({by, message: '확인 부탁드립니다', expectReply: true, ...link}).mailId;
  // 실행을 업무에 잇기 전에 보낸 우편에는 업무 키가 붙지 않는다.
  const ids = {prevNoWork: ask(BOSS, WORKER, {executionKey: PREV})};
  works.change(WORK, 'link', {execution: PREV, phase: 'implementation', round: 1}, {revision: 1, by: BOSS, note: '실행 연결'});
  works.change(WORK, 'link', {execution: KEY, phase: 'review', round: 1}, {revision: 2, by: BOSS, note: '실행 연결'});
  Object.assign(ids, {prev: ask(BOSS, WORKER, {executionKey: PREV}), current: ask(BOSS, WORKER, {executionKey: KEY}),
    workOnly: ask(BOSS, WORKER, {workKey: WORK}), bossPrev: ask(TOP, BOSS, {executionKey: PREV}), bossCurrent: ask(TOP, BOSS, {executionKey: KEY})});
  const rows = readLedger(home);
  return Object.fromEntries(Object.entries(ids).map(([name, mailId]) => [name, rows.find(e => e.mailId === mailId)]));
})();
const mailAt = (name, minute) => ({...MAILS[name], t: stamp(minute)});
// 결정 저장소가 남기는 열린 결정의 칸(src/decisions.mjs의 request): 카드 결정은 card에 실행 키, 채팅 결정은 card 없이 chat·work.
const decisionAt = (minute, link) => ({id: `d-${minute}`, revision: 1, to: '@user', requestedBy: BOSS, question: '진행할까요',
  options: ['진행', '보류'], recommendation: '진행', reason: '확인 필요', status: 'open', at: stamp(minute), card: null, ...link});
const prevCard = {...running, id: 'qa-prev', key: PREV, status: 'done'};
const early = starts.map(s => ({...s, t: stamp(-15)}));
const priorSend = {...dispatch, taskId: 'qa-prev', executionKey: PREV, t: stamp(-8)};
// 이전 실행: 발령(-8분) → [before] → 완료(-3분). 현재 실행: 발령(0분) → [after] → 대기 표시(1분).
const timeline = ({before = [], after = []} = {}) => [...early, priorSend, ...before, {...priorSend, kind: 'done', result: 'ok', t: stamp(-3)}, dispatch, ...after];
const sameWork = extra => () => [work({executions: [{key: PREV}, {key: KEY}], ...extra})];
const inSameWork = (options = {}) => simulate({screen: () => QUIET, others: [prevCard], works: sameWork(), seed: timeline(options.mail), ...options});
const once = r => [r.cap.map(e => e.t), r.capMails.length];
const ONCE = [[stamp(CAP)], 1], NEVER = [[], 0];

test('수정 2 준비: 우편 고정본은 실제 저장 경로가 남긴 칸이고, 같은 업무에 답 대기가 없으면 60분에 1회', async () => {
  const links = name => [MAILS[name].transport, MAILS[name].by, MAILS[name].role, MAILS[name].expectReply, MAILS[name].executionKey ?? null, MAILS[name].workKey ?? null];
  assert.deepEqual(links('prev'), ['mailbox', WORKER, BOSS, true, PREV, WORK], '--execution만 줘도 연결 업무 키가 붙는다');
  assert.deepEqual(links('prevNoWork'), ['mailbox', WORKER, BOSS, true, PREV, null]);
  assert.deepEqual(links('workOnly'), ['mailbox', WORKER, BOSS, true, null, WORK]);
  assert.deepEqual(links('bossPrev'), ['mailbox', BOSS, TOP, true, PREV, WORK]);
  assert.deepEqual(once(await inSameWork()), ONCE);
});

test('수정 2 표 1·2: 이전 실행의 미답 질문은 같은 업무여도 가리지 않는다(업무 키가 붙은 우편, 없는 우편)', async () => {
  for (const name of ['prev', 'prevNoWork'])
    assert.deepEqual(once(await inSameWork({mail: {before: [mailAt(name, -5)]}})), ONCE, name);
});

test('수정 2 표 3: 이전 실행 카드에 걸린 열린 사용자 결정은 가리지 않는다', async () => {
  for (const link of [{card: PREV}, {card: PREV, work: WORK}])
    assert.deepEqual(once(await inSameWork({decisions: () => [decisionAt(-5, link)]})), ONCE, JSON.stringify(link));
});

test('수정 2 표 4: 감독이 이전 실행으로 상위에게 물은 미답 질문은 가리지 않는다', async () => {
  assert.deepEqual(once(await inSameWork({mail: {before: [mailAt('bossPrev', -5)]}})), ONCE);
});

test('수정 2 표 5·6: 실행 키 없이 업무에만 연결한 답 대기는 현재 발령 전이면 1회, 뒤면 0회', async () => {
  assert.deepEqual(once(await inSameWork({mail: {before: [mailAt('workOnly', -5)]}})), ONCE, '발령 전 업무 질문');
  assert.deepEqual(once(await inSameWork({mail: {after: [mailAt('workOnly', 1)]}})), NEVER, '발령 뒤 업무 질문');
  // 업무 단위(채팅) 사용자 결정도 같다. 질문 우편과 달리 이 갈래는 답 대기 표로만 걸린다.
  const chat = minute => () => [decisionAt(minute, {chat: true, work: WORK})];
  assert.deepEqual(once(await inSameWork({decisions: chat(-5)})), ONCE, '발령 전 업무 결정');
  assert.deepEqual(once(await inSameWork({decisions: chat(1)})), NEVER, '발령 뒤 업무 결정');
});

test('수정 2 표 7: 현재 실행에 연결한 질문·결정과 감독이 현재 실행으로 물은 질문은 0회(지금과 같음)', async () => {
  const cases = {
    '현재 실행에 연결한 질문': {mail: {after: [mailAt('current', 1)]}},
    '재발령 전에 현재 실행에 연결해 둔 질문': {mail: {before: [mailAt('current', -5)]}},
    '현재 실행 카드의 사용자 결정': {decisions: () => [decisionAt(1, {card: KEY, work: WORK})]},
    '발령 전에 현재 실행 카드에 걸어 둔 사용자 결정': {decisions: () => [decisionAt(-5, {card: KEY})]},
    '감독이 현재 실행으로 상위에게 물은 질문': {mail: {after: [mailAt('bossCurrent', 1)]}},
  };
  for (const [name, options] of Object.entries(cases)) assert.deepEqual(once(await inSameWork(options)), NEVER, name);
});

test('수정 2 표 8: 사용자 차례·업무 대기 시각은 0회(지금과 같음)', async () => {
  assert.deepEqual(once(await inSameWork({works: sameWork({turnOwner: '@user', turnAt: stamp(2)})})), NEVER, '사용자 차례');
  assert.deepEqual(once(await inSameWork({works: sameWork({waitUntil: stamp(600), waitUntilSetAt: stamp(-5)})})), NEVER, '업무 대기 시각');
  // 양성 대조: 차례 기록이 마지막 하위 실행보다 앞이면(stale) 사용자 차례가 아니다.
  assert.deepEqual(once(await inSameWork({works: sameWork({turnOwner: '@user', turnAt: stamp(-9)})})), ONCE, '지난 차례 기록');
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
