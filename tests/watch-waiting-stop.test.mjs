import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {createDatabase, writeStorageMarker} from '../src/storage.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {createWatchMailReader} from '../src/watch-mail-reader.mjs';
import {CardStore} from '../src/card-store.mjs';
import {createWatchStoreReaders} from '../src/watch-store-cache.mjs';
import {runWatch} from '../src/watch-runner.mjs';
import {buildWatchScope} from '../src/watch-scope.mjs';
import {assessWaitingStops, waitingStopScreen} from '../src/watch-waiting-stop.mjs';
import {screenDisconnects, disconnectKind, assessRoles} from '../src/watch.mjs';
import {changeDigest} from '../src/watch-roles.mjs';
import {anyStopWordInBottom} from '../src/watch-stop-phrases.mjs';
import {formatAlertBody, itemizedAlert, seedAlertState} from '../src/watch-alert-body.mjs';

// 대기 표시(card progress --activity waiting)를 남긴 실행이 이미 아는 오류 화면에 멈췄을 때의 감시.
// 가짜 시계·가짜 바닥·가짜 전송기·가짜 AI만 쓴다. 역할 이름은 운영 이름이 아닌 가짜다.
const INCIDENT = JSON.parse(fs.readFileSync(new URL('./fixtures/waiting-capacity-screens.json', import.meta.url), 'utf8')).incident;
const CAPACITY = '■ Selected model is at capacity. Please try a different model.';
const COMPOSER = '› Ask Codex to do anything\n\n  gpt-6.1-sol high · ~/Dev/PROJ · main · Context 41% used\n';
const errorScreen = (...block) => `• Ran npm test\n  └ ok 12\n    +3 lines\n\n${block.join('\n')}\n\n${COMPOSER}`;
const IDLE = `• 다른 시험이 끝나면 전체 시험을 돌리겠습니다.\n\n${COMPOSER}`;
const WORKING = `• Ran sleep 60\n\n• Working (3m 10s • esc to interrupt)\n\n${COMPOSER}`;
const LIMIT_429 = errorScreen('■ exceeded retry limit, last status: 429 Too Many Requests');

const epoch = Date.parse('2026-11-18T06:54:00Z');
const stamp = minute => new Date(epoch + minute * 60_000).toISOString();
const WORKER = 'qa-reviewer', BOSS = 'qa-boss', LEAD = 'qa-lead', SESSION = `kadan-${WORKER}`;
const parents = new Map([[WORKER, BOSS], [BOSS, 'qa-top'], ['qa-top', '@user']]);
const start = (role, panePid) => ({kind: 'start', role, session: `kadan-${role}`, panePid, harness: 'codex', model: 'm', t: stamp(0)});
const starts = [start(WORKER, 1), start(BOSS, 2), start('qa-top', 3), start(LEAD, 4)];
const KEY = 'qa/qa-task';
const running = {id: 'qa-task', key: KEY, role: WORKER, board: 'qa', status: 'assigned', workType: 'execution',
  activity: 'running', activityRole: WORKER, activityAt: stamp(0), at: stamp(0)};
const WAIT_NOTE = '다른 시험 종료 뒤 전체 시험 대기';
const waiting = {...running, activity: 'waiting', activityAt: stamp(1), at: stamp(1), noteKind: 'progress', note: WAIT_NOTE, by: WORKER};
const dispatch = (by = BOSS) => ({kind: 'send', role: WORKER, session: SESSION, taskId: 'qa-task', executionKey: KEY, by, t: stamp(0)});

// screen·card·alive는 분(minute)을 받아 그 순회의 값을 준다. keys: 대기 세션에 닿을 수 있는 모든 입력 길(재개·큐 Enter·알림·넛지).
// leadPid: 바닥이 돌려주는 발령 역할 창의 PID(원장에 등록된 값은 4). sendFail(role, minute): 그 전송에서 던질 오류(없으면 성공).
async function simulate({screen = () => INCIDENT, card = () => waiting, alive = () => true, until = 14, seed = null, by = BOSS,
  extra = () => [], leadAlive = true, leadPid = null, sendFail = () => null} = {}) {
  let minute = 0;
  const entries = seed ?? [...starts, dispatch(by)];
  const before = entries.length, sent = [], keys = [], aiCalls = [];
  const controller = new AbortController();
  await runWatch({signal: controller.signal, intervalMs: 60_000, stallN: 2, stallAfterMs: 300_000, idleMs: 15 * 60_000,
    parents, routes: new Map(), superRole: 'qa-top', now: () => epoch + minute * 60_000,
    floor: {list: () => starts.filter(s => s.role === WORKER ? alive(minute) : s.role !== LEAD || leadAlive)
      .map(s => ({session: s.session, pid: s.role === LEAD ? leadPid ?? s.panePid : s.panePid})),
      read: session => session === SESSION ? screen(minute) : `• 맡긴 재판정 결과를 기다립니다. ${minute}분\n\n${COMPOSER}`, alive: () => true},
    readEntries: () => [...entries, ...extra(minute)], readCards: () => [card(minute)], readWorks: () => [],
    resume429: (role, text) => keys.push(['resume429', role, text]),
    sendQueueEnter: session => keys.push(['queue-enter', session]),
    sendAlert: (role, message) => {
      const failure = sendFail(role, minute);
      if (failure) throw failure;
      sent.push({minute, role, message}); if (role === WORKER) keys.push(['alert', role]);
    },
    sendNudge: (role, message) => { sent.push({minute, role, message, nudge: true}); if (role === WORKER) keys.push(['nudge', role]); },
    judgeCmd: 'fake', judgeCooldownMs: 60_000,
    ai: {reports: {retire: () => {}}, run: args => { aiCalls.push([minute, args.source, args.role]); return {ok: true}; }},
    record: e => entries.push({...e, t: stamp(minute)}), spawn: () => ({status: 0, stdout: ''}), print: () => {},
    sleep: async () => { await setImmediate(); if (++minute >= until) controller.abort(); }});
  const records = entries.slice(before);
  const alerts = records.filter(e => e.kind === 'alert' && e.session === SESSION);
  return {entries, records, sent, keys, alerts,
    opened: alerts.filter(e => !e.resolved), resolved: alerts.filter(e => e.resolved),
    waitingStops: alerts.filter(e => e.alertKind === '대기중정지' && !e.resolved),
    workerAI: aiCalls.filter(([, , role]) => role === WORKER), aiCalls,
    retries: records.filter(e => e.kind === 'rate-limit-retry' || e.kind === 'queue-resume')};
}

test('사고 재현: 대기 표시 + 용량 초과 화면 + 빈 입력창이면 직속 감독에게 경보 1회, 다음 주기에 다시 울리지 않고 키 0·AI 0', async () => {
  const r = await simulate();
  assert.equal(r.waitingStops.length, 1, '14주기 동안 경보 기록은 한 번');
  assert.equal(r.waitingStops[0].recipient, BOSS);
  assert.equal(r.waitingStops[0].delivered, true);
  assert.equal(r.waitingStops[0].level, 'AMBER');
  const mails = r.sent.filter(m => m.role === BOSS && /대기 표시 중/u.test(m.message));
  assert.equal(mails.length, 1, '감독 창에 들어간 알림도 한 번');
  assert.equal(mails[0].minute, 0, '정체 시간을 기다리지 않고 처음 본 주기에 알린다');
  const since = new Date(stamp(1)); // 본문은 기계 시간대의 월/일 시:분으로 적는다
  const when = `${since.getMonth() + 1}/${since.getDate()} ${String(since.getHours()).padStart(2, '0')}:${String(since.getMinutes()).padStart(2, '0')}`;
  for (const text of [SESSION, KEY, WAIT_NOTE, CAPACITY, '대기 표시 때문에 정체 감시 밖이었음', `대기 표시 ${when}`])
    assert.ok(mails[0].message.includes(text), `알림에 "${text}" 없음: ${mails[0].message}`);
  assert.deepEqual(r.resolved, [], '화면이 그대로인 동안 풀리지도 퇴역(감시제외)하지도 않는다');
  assert.deepEqual(r.keys, [], '대기 세션에는 아무 입력도 보내지 않는다');
  assert.deepEqual(r.workerAI, [], '대기 세션을 두고 AI를 부르지 않는다');
  assert.deepEqual(r.retries, [], '자동 재개·큐 재개 기록 없음');
  // 감시기가 다시 떠도(원장에서 열린 경보를 복원) 같은 경보를 다시 보내지 않는다.
  const again = await simulate({seed: r.entries, until: 4});
  assert.deepEqual(again.waitingStops, []);
  assert.deepEqual(again.resolved, []);
  assert.deepEqual(again.sent.filter(m => /대기 표시 중/u.test(m.message)), []);
});

test('정당한 대기 화면(일하는 중·빈 입력창, 정지 문구 없음)은 경보 0·AI 0·키 0', async () => {
  for (const screen of [IDLE, WORKING]) {
    const r = await simulate({screen: () => screen, until: 40});
    assert.deepEqual(r.alerts, [], '대기 세션에 관한 경보 기록이 하나도 없다');
    assert.deepEqual(r.workerAI, []);
    assert.deepEqual(r.keys, []);
    assert.deepEqual(r.retries, []);
  }
});

test('정체 판정 AI가 불릴 만한 화면(입력창에 글이 남은 채 그대로)이어도 대기 세션에는 AI를 부르지 않는다', async () => {
  // 감시 범위 안이었다면 5분 뒤 정체 후보가 되어 작업 감시AI가 불리는 화면이다(빈 입력창이 아니라 멈춤 경보로 가지 않는다).
  const still = '• 다른 시험이 끝나기를 기다립니다.\n\n› 감독에게 보낼 메모를 쓰는 중';
  const r = await simulate({screen: () => still, until: 20});
  assert.deepEqual(r.workerAI, [], '대기 세션을 두고 AI를 불렀다');
  assert.deepEqual(r.alerts, []);
  assert.deepEqual(r.keys, []);
  // 대조: 같은 화면이 감시 범위 안(대기 표시 없음)이면 AI가 실제로 불린다 — 위 0회가 빈 검사가 아님을 보인다.
  const watched = await simulate({screen: () => still, card: () => running, until: 20});
  assert.ok(watched.workerAI.some(([, source]) => source === 'stall'), `감시 범위 안에서는 정체 판정 AI가 불려야 한다: ${JSON.stringify(watched.aiCalls)}`);
});

test('대기 세션의 최종 429 화면은 자동 재개 없이 경보만 한 번', async () => {
  const r = await simulate({screen: () => LIMIT_429});
  assert.equal(r.waitingStops.length, 1);
  assert.equal(r.waitingStops[0].recipient, BOSS);
  assert.deepEqual(r.keys, [], '대기 세션에 재개 문구를 보냈다');
  assert.deepEqual(r.retries, [], '재개 예약도 만들지 않는다');
  // 대조: 같은 화면이 감시 범위 안(대기 표시 없음)이면 재개가 실제로 예약·전송된다 — 위 키 0회가 빈 검사가 아님을 보인다.
  const watched = await simulate({screen: () => LIMIT_429, card: () => running, until: 6});
  assert.ok(watched.keys.some(([kind, role]) => kind === 'resume429' && role === WORKER), `감시 범위 안에서는 재개 문구가 가야 한다: ${JSON.stringify(watched.retries.map(e => e.action))}`);
  assert.deepEqual(r.workerAI, []);
  assert.match(r.sent.find(m => /대기 표시 중/u.test(m.message)).message, /429 Too Many Requests/u);
});

// 검수 발견 1(2026-11-19): 대기 경로는 정상 감시의 즉시 경보(currentStopPhrases)와 같은 기준만 쓴다. 자동 재개용 최종 429 판정은
// 인용하거나 이미 복구된 429도 집으므로 쓰지 않는다.
const TERMINAL_429 = '■ Exceeded retry limit, last status: 429 Too Many Requests';
const TOOL = '• Ran npm test\n  └ 4 passed\n    +2 lines';
const FENCED_429 = ['• 장애 로그 설명을 추가했습니다.', '', '```text', TERMINAL_429, '```', '', COMPOSER].join('\n');
const PAST_429 = [TOOL, '', TERMINAL_429, '', '• 다시 시도해 확인을 끝냈습니다.', '', COMPOSER].join('\n');
const LOOSE_429 = `• 시험을 다시 돌립니다.\n${TERMINAL_429}\n\n${COMPOSER}`;

test('발견 1: 코드 울타리에 인용한 429, 뒤에 정상 응답이 이어진 429, 한 줄 응답 바로 아래의 429는 대기 중 정지가 아니다', async () => {
  for (const [name, screen] of Object.entries({'fenced-429': FENCED_429, 'past-429': PAST_429, 'loose-429': LOOSE_429})) {
    assert.equal(screenDisconnects(screen).size, 0, `${name}: 정상 감시의 즉시 경보 기준으로도 정지가 아니다`);
    assert.equal(waitingStopScreen(screen), null, name);
    const r = await simulate({screen: () => screen, until: 12});
    assert.deepEqual(r.alerts, [], `${name}: 대기 세션에 관한 경보가 없어야 한다`);
    assert.deepEqual([r.keys, r.workerAI, r.retries], [[], [], []], name);
  }
});

test('발견 1: 대기 경로가 정지로 보는 화면은 정상 감시의 즉시 경보 기준이 정지로 보는 화면과 같다(더 넓지 않다)', () => {
  const screens = [INCIDENT, LIMIT_429, FENCED_429, PAST_429, LOOSE_429, IDLE, WORKING,
    errorScreen('■ stream disconnected before completion'), errorScreen('■ Model is overloaded, retry later', '  └ capacity exceeded'),
    `x\n• Reconnecting... 2/5 (9m 34s • esc to interrupt)\n${COMPOSER}`, `${CAPACITY}\n\n› 지금 쓰는 중인 답장`];
  for (const screen of screens) {
    const normal = screenDisconnects(screen), found = waitingStopScreen(screen);
    assert.equal(found !== null, normal.size > 0, screen);
    if (found) assert.deepEqual([normal.has(found.key), normal.get(found.key)], [true, found.line], screen);
  }
  assert.deepEqual(screens.map(s => waitingStopScreen(s) !== null),
    [true, true, false, false, false, false, false, true, false, true, false]);
});

// 검수 발견 3: 대기 경보 id는 지금의 정지 줄 하나를 정규화한 값이다. 스크롤 위쪽의 옛 오류가 사라져도 바뀌지 않는다.
test('발견 3: 같은 429 화면에서 위쪽의 옛 오류가 스크롤 밖으로 나가도 다시 울리지 않는다', async () => {
  // 검수 재현 그대로: 429 바로 위가 한 줄 응답이고, 맨 위의 다른 옛 오류가 3분에 사라진다. 고치기 전에는 서로 다른 id로 2번 울렸다.
  const loose = minute => [minute < 3 ? '■ An older unrelated error' : null, '• 직전 답변입니다.', TERMINAL_429, '', COMPOSER]
    .filter(line => line !== null).join('\n');
  const first = await simulate({screen: loose, until: 6});
  assert.deepEqual(first.waitingStops, [], '이 모양은 현재 오류 덩어리가 아니라 알리지 않는다(한 번도, 두 번도 아니다)');
  assert.deepEqual(first.keys, []);
  // 현재 오류 덩어리인 429에서 같은 일이 일어나면: 경보 1회, id 하나, 풀림 없음.
  const block = minute => [minute < 3 ? '■ An older unrelated error' : null, minute < 3 ? '' : null, TOOL, '', TERMINAL_429, '', COMPOSER]
    .filter(line => line !== null).join('\n');
  const second = await simulate({screen: block, until: 6});
  assert.equal(second.waitingStops.length, 1);
  assert.deepEqual(second.resolved, []);
  assert.equal(new Set([0, 1, 2, 3, 4, 5].map(minute => waitingStopScreen(block(minute)).key)).size, 1);
  assert.equal(waitingStopScreen(block(0)).line, TERMINAL_429);
});

test('본문·코드 울타리·설명에 인용된 문구와 낱말 capacity만 있는 오류는 경보 0', async () => {
  const quoted = [
    `• 화면에 "${CAPACITY}"가 뜨면 감독에게 알린다고 문서에 적었습니다.\n\n${COMPOSER}`,
    `• 예시 화면:\n\n\`\`\`\n${CAPACITY}\n\`\`\`\n\n${COMPOSER}`,
    `• 사고 화면은 다음과 같습니다:\n\n${CAPACITY}\n\n${COMPOSER}`,
    `${CAPACITY}\n\n• Working (1m 02s • esc to interrupt)\n\n${COMPOSER}`,
    `${CAPACITY}\n\n› 지금 쓰는 중인 답장`,
    errorScreen('■ Model is overloaded, retry later', '  └ capacity exceeded'),
  ];
  for (const screen of quoted) {
    assert.equal(waitingStopScreen(screen), null, screen);
    const r = await simulate({screen: () => screen, until: 3});
    assert.deepEqual(r.waitingStops, [], screen);
    assert.deepEqual(r.keys, []);
  }
});

// 검수 발견 2: 용량 초과는 오류 표시로 시작하는 줄 전체가 그 문장일 때만 정지다.
test('발견 2: 다른 오류가 인용한 문장, 뒤에 다른 말이 붙은 줄, 앞에 말이 붙은 줄은 용량 초과가 아니다', async () => {
  const lines = {
    'quoted-capacity': '■ Could not read documentation entry "Selected model is at capacity".',
    'capacity-planning': '■ Selected model is at capacity planning stage.',
    'prefix': '■ Note: Selected model is at capacity. Please try a different model.',
    'suffix': '■ Selected model is at capacity. Please try a different model. (see docs)',
    'first-sentence-only': '■ Selected model is at capacity.',
    'no-error-mark': 'Selected model is at capacity. Please try a different model.',
  };
  for (const [name, line] of Object.entries(lines)) {
    const screen = errorScreen(line);
    assert.equal(screenDisconnects(screen).size, 0, `${name}: 감시 범위 안에서도 정지 문구가 아니다`);
    assert.equal(waitingStopScreen(screen), null, name);
    const r = await simulate({screen: () => screen, until: 12});
    assert.deepEqual(r.alerts, [], name);
    assert.deepEqual([r.keys, r.workerAI], [[], []], name);
  }
  // 실제 오류 줄은 그대로 읽는다(들여쓴 이어진 줄·대소문자·다른 오류 표시 포함).
  for (const line of [CAPACITY, CAPACITY.toUpperCase(), `✕${CAPACITY.slice(1)}`, `${CAPACITY}  `])
    assert.equal(waitingStopScreen(errorScreen(line))?.line, line.trim(), line);
  assert.equal(waitingStopScreen(errorScreen('■ stream error', `  ${CAPACITY}`))?.line, '■ stream error');
});

test('발견 2: 용량 초과 문장이 화면 아래에 보여도 시계가 도는 정상 작업은 일하는 중이고 정체 판정 AI를 부르지 않는다', async () => {
  const session = SESSION;
  const moving = screenOf => {
    const assess = (states, screen) => assessRoles(states, new Map([[session,
      {role: WORKER, alive: true, pid: 1, expectedPid: 1, screen, digest: changeDigest(screen)}]]), 60_000, 60_000, 2);
    return assess(assess(new Map(), screenOf(1)).states, screenOf(2)).states.get(session).workingMoving;
  };
  // 검수 재현 'active ticking': 문장을 인용한 응답 아래에서 일하는 시계가 돈다. 기준 커밋과 같이 일하는 중이어야 한다.
  const quoted = minute => `• 화면 문구 "Selected model is at capacity."를 문서화하는 중입니다.\n\n• Working (${minute + 1}m 10s • esc to interrupt)\n\n${COMPOSER}`;
  // 진짜 오류 줄이 아래 12줄 안에 남아 있고(지난 오류) 그 아래에서 다시 일하는 화면도 같다: 넓은 검사는 이 문장을 보지 않는다.
  const real = minute => `${TOOL}\n\n${CAPACITY}\n\n• 다시 보내 주셔서 이어갑니다.\n\n• Working (${minute + 1}m 10s • esc to interrupt)\n\n${COMPOSER}`;
  for (const [name, screenOf] of [['quoted', quoted], ['real', real]]) {
    assert.equal(moving(screenOf), true, `${name}: 일하는 중으로 남아야 한다`);
    assert.equal(anyStopWordInBottom(screenOf(1)), false, name);
    const r = await simulate({screen: screenOf, card: () => running, until: 12});
    assert.deepEqual(r.workerAI, [], `${name}: 정상 작업에 정체 판정 AI를 불렀다`);
    assert.deepEqual([r.opened, r.keys], [[], []], name);
  }
  // 대조: 넓은 검사가 원래 보던 낱말(429)은 지금처럼 일하는 중을 거부한다.
  const limited = minute => `${TOOL}\n\n${TERMINAL_429}\n\n• Working (${minute + 1}m 10s • esc to interrupt)\n\n${COMPOSER}`;
  assert.deepEqual([moving(limited), anyStopWordInBottom(limited(1))], [false, true]);
});

test('지금 규칙의 한계 기록: 오류 줄 바로 위가 한 줄 응답이면 용량 초과 줄을 읽지 않는다(기존 현재 오류 덩어리 규칙 그대로)', () => {
  const afterResponse = `• 전체 시험을 돌리겠습니다.\n\n${CAPACITY}\n\n${COMPOSER}`;
  assert.equal(waitingStopScreen(afterResponse), null);
  // 사고 화면처럼 바로 위가 도구 블록의 들여쓴 줄이면 읽는다.
  assert.equal(waitingStopScreen(INCIDENT).line, CAPACITY);
});

test('감시 대상 안 작업자의 용량 초과 화면은 정지 문구(끊김)로 바로 잡힌다', async () => {
  assert.deepEqual([...screenDisconnects(INCIDENT).values()], [CAPACITY]);
  assert.equal(disconnectKind(CAPACITY), '끊김');
  assert.equal(screenDisconnects(`${CAPACITY.toLowerCase()}\n\n${COMPOSER}`).size, 1, '대소문자 무시');
  const r = await simulate({card: () => running, until: 6});
  assert.deepEqual(r.opened.map(e => [e.alertKind, e.recipient]), [['끊김', BOSS]]);
  assert.deepEqual(r.waitingStops, []);
  assert.deepEqual(r.keys, [], '용량 초과에는 자동 재개를 붙이지 않는다');
  assert.deepEqual(r.retries, []);
});

test('감시 범위: sessions·entries는 그대로이고 대기 실행은 waitingSessions로만 나온다', () => {
  const entries = [...starts, dispatch(LEAD)];
  const plain = buildWatchScope([waiting], entries, parents);
  assert.deepEqual(plain, {sessions: new Set(), entries: []}, '요청하지 않으면 예전 모양 그대로');
  const scope = buildWatchScope([waiting], entries, parents, [], {waiting: true});
  assert.deepEqual([scope.sessions, scope.entries], [new Set(), []]);
  assert.deepEqual(scope.waitingSessions.map(e => [e.session, e.role, e.taskId, e.executionKey, e.by]), [[SESSION, WORKER, 'qa-task', KEY, LEAD]]);
  // 대기가 아닌 실행은 waitingSessions에 없다.
  const active = buildWatchScope([running], entries, parents, [], {waiting: true});
  assert.deepEqual([[...active.sessions], active.entries.length, active.waitingSessions], [[SESSION], 1, []]);
  // 같은 역할에 감시 중인 다른 실행이 있으면 그 세션은 정상 감시가 본다(두 길로 보지 않는다).
  const other = {...running, id: 'qa-other', key: 'qa/qa-other'};
  const both = buildWatchScope([waiting, other], [...entries, {...dispatch(), taskId: 'qa-other', executionKey: 'qa/qa-other'}], parents, [], {waiting: true});
  assert.deepEqual([[...both.sessions], both.entries.map(e => e.executionKey), both.waitingSessions], [[SESSION], ['qa/qa-other'], []]);
  // 결과를 등록한 대기(확정 대기)는 지금처럼 감시 범위에 남는다.
  const confirmed = {...waiting, result: {at: stamp(1), by: WORKER, outcome: 'pass'}};
  const kept = buildWatchScope([confirmed], entries, parents, [], {waiting: true});
  assert.deepEqual([[...kept.sessions], kept.waitingSessions], [[SESSION], []]);
});

test('대기가 풀리면 대기 경보는 닫히고 정상 감시(끊김·자동 재개 대상)로 돌아온다', async () => {
  const r = await simulate({card: minute => minute < 3 ? waiting : {...running, activityAt: stamp(3), at: stamp(3)}, until: 8});
  assert.equal(r.waitingStops.length, 1);
  assert.deepEqual(r.resolved.map(e => e.alertKind), ['대기중정지']);
  assert.ok(r.resolved[0].t >= stamp(3), '대기가 풀린 주기에 닫힌다');
  assert.deepEqual(r.opened.map(e => e.alertKind), ['대기중정지', '끊김']);
  // 실행이 끝나도(done) 닫힌다.
  const done = await simulate({extra: minute => minute >= 2 ? [{kind: 'done', role: WORKER, taskId: 'qa-task', executionKey: KEY, result: 'ok', t: stamp(2)}] : [], until: 5});
  assert.deepEqual(done.resolved.map(e => e.alertKind), ['대기중정지']);
  assert.equal(done.waitingStops.length, 1);
});

test('화면이 바뀌면 닫히고, 다른 정지 화면이면 새 경보다. 숫자만 다른 같은 줄은 같은 경보다', async () => {
  const recovered = await simulate({screen: minute => minute < 2 ? INCIDENT : WORKING, until: 6});
  assert.equal(recovered.waitingStops.length, 1);
  assert.deepEqual(recovered.resolved.map(e => e.alertKind), ['대기중정지']);
  const changed = await simulate({screen: minute => minute < 2 ? INCIDENT : errorScreen('■ stream disconnected before completion'), until: 6});
  assert.equal(changed.waitingStops.length, 2);
  assert.notEqual(changed.waitingStops[0].id, changed.waitingStops[1].id);
  const ticking = await simulate({screen: minute => `x\n• Reconnecting... ${minute % 5}/5 (${minute}m 0${minute % 10}s • esc to interrupt)\n${COMPOSER}`, until: 8});
  assert.equal(ticking.waitingStops.length, 1);
  assert.deepEqual(ticking.resolved, []);
});

test('대기 중 세션이 죽으면(일부러 끈 것 제외) 같은 경보로 한 번 알린다. 처음부터 없던 세션은 알리지 않는다', async () => {
  const died = await simulate({screen: () => IDLE, alive: minute => minute < 2, until: 8});
  assert.equal(died.waitingStops.length, 1);
  assert.equal(died.waitingStops[0].level, 'AMBER');
  assert.match(died.sent.find(m => /대기 표시 중/u.test(m.message)).message, /세션 종료 의심.*세션 없음 또는 PID 불일치/su);
  assert.deepEqual(died.keys, []);
  // kadan stop으로 끈 세션은 죽음이 아니다.
  const stopped = await simulate({screen: () => IDLE, alive: minute => minute < 2, until: 8,
    extra: minute => minute >= 2 ? [{kind: 'stop', session: SESSION, role: WORKER, t: stamp(2)}] : []});
  assert.deepEqual(stopped.waitingStops, []);
  // 감시 시작 때 이미 없던 세션(묵은 대기 카드)은 울리지 않는다.
  const never = await simulate({alive: () => false, until: 5});
  assert.deepEqual(never.alerts, []);
  // 재시작 뒤 복원된 죽음 경보는 이어 간다(풀림으로 닫지 않는다).
  const restarted = await simulate({seed: died.entries, alive: () => false, until: 3});
  assert.deepEqual([restarted.waitingStops, restarted.resolved], [[], []]);
});

test('판정 함수: 살아 있는 것을 본 세션만 죽음 후보이고, PID가 다른 세션의 화면은 읽지 않는다', () => {
  const entry = {session: SESSION, role: WORKER, taskId: 'qa-task', executionKey: KEY, by: LEAD, card: waiting};
  const seen = over => new Map([[SESSION, {role: WORKER, alive: true, pid: 1, expectedPid: 1, screen: INCIDENT, ...over}]]);
  const first = assessWaitingStops(null, [entry], seen(), {entries: starts});
  assert.deepEqual([...first.alive], [SESSION]);
  assert.equal(first.alerts.length, 1);
  assert.equal(first.alerts[0].dispatcher, LEAD);
  assert.equal(first.alerts[0].waitingNote, WAIT_NOTE);
  const swapped = assessWaitingStops(first, [entry], seen({pid: 9}), {entries: starts});
  assert.deepEqual(swapped.alerts.map(a => a.dead), [true]);
  assert.deepEqual(assessWaitingStops(null, [entry], seen({pid: 9}), {entries: starts}).alerts, []);
  assert.deepEqual(assessWaitingStops(null, [], seen(), {entries: starts}), {alive: new Set(), judged: new Map(), alerts: []});
  // 대기 사유는 그 대기 표시를 만든 보고 한 줄이다. 뒤에 붙은 일반 메모는 사유가 아니다(사유 없이 알린다).
  const memo = {...waiting, at: stamp(5), noteKind: 'decision', note: '감독 메모'};
  assert.equal(assessWaitingStops(null, [{...entry, card: memo}], seen(), {entries: starts}).alerts[0].waitingNote, '');
  assert.equal(assessWaitingStops(null, [{...entry, card: {...waiting, noteKind: 'decision'}}], seen(), {entries: starts}).alerts[0].waitingNote, '');
});

test('실제 카드 저장소: 감시기가 읽는 카드 요약(이력 없음)으로도 실행 키·발령한 역할·대기 사유가 경보에 실린다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-waiting-stop-'));
  createDatabase(home); writeStorageMarker(home, 'sqlite');
  const store = new CardStore(home), readers = createWatchStoreReaders(home);
  const made = store.create({repo: 'qa', id: 'real-task', repoPath: home, body: '# 지시'});
  store.update(made.key, {status: 'assigned', role: WORKER, board: 'qa', scope: '시험 범위',
    rallyId: 'rally', rallyTitle: '묶음', rallyRound: '1', rallyStep: 'review'}, {revision: 1, note: '배정'});
  const entries = [...starts, {kind: 'send', role: WORKER, session: SESSION, taskId: made.id, executionKey: made.key, by: LEAD,
    t: new Date(Date.now() - 60_000).toISOString()}];
  const observed = new Map([[SESSION, {role: WORKER, alive: true, pid: 1, expectedPid: 1, screen: INCIDENT}]]);
  const alertOf = () => {
    const scope = buildWatchScope(readers.cards.read(), entries, parents, [], {waiting: true});
    return assessWaitingStops(null, scope.waitingSessions, observed, {entries}).alerts;
  };
  assert.deepEqual(alertOf(), [], '대기 표시 전에는 대기 목록에 없다(정상 감시 대상)');
  const reported = store.update(made.key, {activity: 'waiting'}, {revision: store.get(made.key).revision, note: WAIT_NOTE, noteKind: 'progress', by: WORKER});
  const [alert] = alertOf();
  assert.equal(readers.cards.read().find(c => c.key === made.key).history, undefined, '감시기의 카드 요약에는 이력이 없다');
  assert.deepEqual([alert.executionKey, alert.taskId, alert.dispatcher, alert.waitingAt, alert.waitingNote, alert.line],
    [made.key, made.id, LEAD, reported.activityAt, WAIT_NOTE, CAPACITY]);
  // 대기 보고 뒤에 다른 메모가 붙으면 사유는 싣지 않고(뒤 메모를 사유로 읽지 않는다) 같은 경보를 그대로 낸다.
  store.update(made.key, {}, {revision: store.get(made.key).revision, note: '확인 중', by: 'qa-other'});
  const [later] = alertOf();
  assert.deepEqual([later.id, later.waitingAt, later.waitingNote], [alert.id, reported.activityAt, '']);
  assert.match(formatAlertBody(later), /\(대기 표시 \d+\/\d+ \d\d:\d\d; 화면: ■ Selected model is at capacity/u);
});

test('경보 본문: 실행 키·대기 표시 시각과 사유·정지 줄·감시 밖이었던 이유를 담고, 복원된 경보(값 없음)도 문장이 깨지지 않는다', () => {
  const entry = {session: SESSION, role: WORKER, taskId: 'qa-task', executionKey: KEY, by: LEAD, card: waiting};
  const [alert] = assessWaitingStops(null, [entry], new Map([[SESSION, {role: WORKER, alive: true, pid: 1, expectedPid: 1, screen: INCIDENT}]]), {entries: starts}).alerts;
  const body = formatAlertBody(alert);
  assert.match(body, new RegExp(`^대기 표시 중 오류 화면으로 멈춤 ${SESSION} / ${KEY} \\(`, 'u'));
  for (const text of [`"${WAIT_NOTE}"`, `화면: ${CAPACITY}`, '대기 표시 때문에 정체 감시 밖이었음', `발령 ${LEAD}`, '감독 확인 필요']) assert.ok(body.includes(text), text);
  const mail = itemizedAlert(alert, '15:00');
  assert.ok(mail.includes('상태: 대기 표시 중 오류 화면으로 멈춤') && mail.includes('근거: 대기 표시'), mail);
  const restored = seedAlertState([{kind: 'alert', id: alert.id, alertKind: alert.kind, level: 'AMBER', role: WORKER, session: SESSION, taskId: 'qa-task', delivered: true, recipient: BOSS}]).active[0];
  assert.equal(formatAlertBody(restored), `대기 표시 중 오류 화면으로 멈춤 ${SESSION} / qa-task (대기 표시; 대기 표시 때문에 정체 감시 밖이었음 — 감독 확인 필요)`);
});

test('받는 쪽: 그 실행을 발령한 역할에게 간다(관계표의 직속 상위와 달라도). 발령한 역할의 세션이 없으면 직속 상위에게 간다', async () => {
  // 사고의 모양: 다른 계열의 감독(LEAD)이 검수자에게 재판정을 맡기고 그 결과를 기다린다. 검수자의 직속 상위는 BOSS다.
  const r = await simulate({by: LEAD, until: 3});
  assert.deepEqual(r.waitingStops.map(e => [e.recipient, e.route.basis, e.delivered]), [[LEAD, 'dispatcher', true]]);
  const mails = r.sent.filter(m => /대기 표시 중/u.test(m.message));
  assert.deepEqual(mails.map(m => m.role), [LEAD], '기다리는 쪽(발령한 역할)만 받는다');
  assert.ok(mails[0].message.includes(`발령 ${LEAD}`));
  // 발령한 역할의 세션이 없으면 죽은 창에 보내지 않고 기존 경로(직속 상위)로 간다. 건너뛴 이유를 기록에 남긴다.
  const gone = await simulate({by: LEAD, leadAlive: false, until: 3});
  assert.deepEqual(gone.waitingStops.map(e => [e.recipient, e.delivered]), [[BOSS, true]]);
  assert.deepEqual(gone.waitingStops[0].route.skipped, [`${LEAD}(발령한 역할 세션 없음 또는 PID 불일치)`]);
  assert.deepEqual(gone.sent.filter(m => /대기 표시 중/u.test(m.message)).map(m => m.role), [BOSS]);
  // 발령한 역할을 모르면(옛 기록) 직속 상위에게 간다.
  const unknown = await simulate({by: undefined, until: 3, seed: [...starts, {...dispatch(), by: undefined}]});
  assert.deepEqual(unknown.waitingStops.map(e => e.recipient), [BOSS]);
});

// 검수 발견 4: 발령한 역할의 이름만 살아 있고 창 PID가 원장에 등록된 PID와 다르면 그 창은 다른 프로세스다(전송 보호기가 거절한다).
const stopMails = r => r.sent.filter(m => /대기 표시 중/u.test(m.message)).map(m => [m.minute, m.role]);
test('발견 4: 발령한 역할의 창 PID가 등록된 PID와 다르면 처음부터 대기 실행 담당의 직속 상위에게 보낸다', async () => {
  const r = await simulate({by: LEAD, leadPid: 998, until: 4});
  assert.deepEqual(r.waitingStops.map(e => [e.recipient, e.delivered, e.route.skipped]),
    [[BOSS, true, [`${LEAD}(발령한 역할 세션 없음 또는 PID 불일치)`]]]);
  assert.deepEqual(stopMails(r), [[0, BOSS]], '직속 상위가 첫 주기에 한 번 받고 발령한 역할 창에는 넣지 않는다');
  assert.deepEqual(r.records.filter(e => e.alertKind === '전달실패'), [], '발령한 역할의 상위로 전달 실패를 올리지 않는다');
});

test('발견 4: 발령한 역할에게 보내다 실패하면 같은 주기에 직속 상위에게 간다(경보가 열린 채 아무에게도 안 가는 일이 없다)', async () => {
  const fail = (delivery, code) => Object.assign(new Error('세션 PID 불일치'), delivery ? {delivery} : {}, code ? {code} : {});
  // 보내기 전에 거절된 실패(not-sent)와 전달 여부를 모르는 실패 모두 직속 상위로 넘긴다.
  for (const delivery of ['not-sent', null]) {
    const r = await simulate({by: LEAD, until: 4, sendFail: role => role === LEAD ? fail(delivery) : null});
    assert.deepEqual(stopMails(r), [[0, BOSS]], String(delivery));
    assert.deepEqual(r.waitingStops.map(e => [e.recipient, e.delivered, e.route.skipped]),
      [[BOSS, true, [`${LEAD}(발령한 역할 전달 실패: 세션 PID 불일치)`]]], String(delivery));
    assert.deepEqual(r.records.filter(e => e.alertKind === '전달실패'), [], String(delivery));
  }
  // 창에 이미 들어갔다고 확인된 오류(sent)는 받은 것으로 치고 직속 상위에 또 보내지 않는다.
  const sent = await simulate({by: LEAD, until: 4, sendFail: role => role === LEAD ? fail('sent') : null});
  assert.deepEqual([stopMails(sent), sent.waitingStops.map(e => e.recipient)], [[], [LEAD]]);
  // 사람이 그 창에서 입력 중이라 미룬 알림은 직속 상위로 돌리지 않고 다음 주기에 발령한 역할에게 다시 보낸다.
  const held = await simulate({by: LEAD, until: 4,
    sendFail: (role, minute) => role === LEAD && minute === 0 ? fail('not-sent', 'KADAN_HUMAN_ACTIVE') : null});
  assert.deepEqual(stopMails(held), [[1, LEAD]]);
  assert.deepEqual(held.waitingStops.map(e => [e.recipient, Boolean(e.held), e.delivered]), [[LEAD, true, false], [LEAD, false, false], [LEAD, false, true]]);
});

test('발견 4: 발령한 역할이 직속 상위와 같으면 기존 경로 그대로다(전달 실패는 그 위 상위로 올라간다)', async () => {
  const r = await simulate({until: 4, sendFail: role => role === BOSS ? Object.assign(new Error('세션 없음'), {delivery: 'not-sent'}) : null});
  assert.deepEqual(r.waitingStops.map(e => [e.recipient, e.delivered, e.route.basis === 'dispatcher', e.route.skipped ?? []]),
    [[BOSS, false, false, []]], '직속 상위에게 한 번만 시도한다(발령한 역할로 따로 먼저 보내지 않는다)');
  const escalated = r.records.filter(e => e.alertKind === '전달실패');
  assert.deepEqual(escalated.map(e => [e.recipient, e.delivered]), [['qa-top', true]]);
  assert.match(r.sent.find(m => m.role === 'qa-top').message, /전달실패 대기 표시 중 오류 화면으로 멈춤/u);
});

// 검수 발견 5: 사라진 세션의 수명 판정은 사라진 것을 처음 본 주기에 한 번만 원장을 읽는다.
test('발견 5: 대기 세션이 사라진 뒤 원장을 주기마다 다시 훑지 않는다(첫 주기 한 번, 그 뒤 0회)', () => {
  const entry = {session: SESSION, role: WORKER, taskId: 'qa-task', executionKey: KEY, by: LEAD, card: waiting};
  const counted = rows => {
    const counter = {reads: 0};
    const entries = new Proxy(rows, {get(target, name, receiver) {
      if (/^\d+$/u.test(String(name))) counter.reads++;
      return Reflect.get(target, name, receiver);
    }});
    return {entries, counter};
  };
  const noise = length => Array.from({length}, () => ({kind: 'send'}));
  const perCycle = [];
  for (const length of [128, 1280]) {
    const {entries, counter} = counted([starts[0], ...noise(length)]);
    let state = {alive: new Set([SESSION]), judged: new Map()};
    const reads = [];
    for (let cycle = 0; cycle < 5; cycle++) {
      const before = counter.reads;
      const next = assessWaitingStops(state, [entry], new Map(), {entries});
      assert.deepEqual(next.alerts.map(a => [a.id, a.dead]), [[`waiting-stop:${SESSION}:${KEY}:death`, true]], `주기 ${cycle}: 죽음 경보가 이어진다`);
      reads.push(counter.reads - before);
      state = next;
    }
    assert.deepEqual(reads, [length + 1, 0, 0, 0, 0], `원장 ${length}건`);
    perCycle.push(reads);
  }
  assert.deepEqual(perCycle.map(reads => reads.slice(1)), [[0, 0, 0, 0], [0, 0, 0, 0]], '원장이 10배여도 둘째 주기부터 0회');
  // 일부러 끈 세션도 한 번만 판정한다: 그 뒤로는 원장을 읽지 않고 조용하다.
  const stopped = counted([starts[0], ...noise(1280), {kind: 'stop', session: SESSION, role: WORKER}]);
  let state = {alive: new Set([SESSION]), judged: new Map()};
  for (let cycle = 0; cycle < 3; cycle++) {
    state = assessWaitingStops(state, [entry], new Map(), {entries: stopped.entries});
    assert.deepEqual([state.alerts, [...state.judged]], [[], [[SESSION, 'stopped']]]);
  }
  assert.equal(stopped.counter.reads, 1, '마지막 기록(stop) 하나만 읽고 끝');
  // 재시작 뒤 복원된 죽음 경보는 원장을 읽지 않고 이어 간다.
  const restored = counted([starts[0], ...noise(1280)]);
  const active = [{id: `waiting-stop:${SESSION}:${KEY}:death`, kind: '대기중정지'}];
  const again = assessWaitingStops(null, [entry], new Map(), {entries: restored.entries, active});
  assert.deepEqual([again.alerts.length, restored.counter.reads, [...again.judged]], [1, 0, [[SESSION, 'dead']]]);
  // 한 역할에 대기 실행이 둘이어도 한 번만 읽는다.
  const two = counted([starts[0], ...noise(128)]);
  const both = assessWaitingStops({alive: new Set([SESSION]), judged: new Map()},
    [entry, {...entry, taskId: 'qa-other', executionKey: 'qa/qa-other'}], new Map(), {entries: two.entries});
  assert.deepEqual([both.alerts.length, two.counter.reads], [2, 129]);
  // 세션이 다시 살아나면 판정을 버린다.
  const back = assessWaitingStops(state, [entry], new Map([[SESSION, {role: WORKER, alive: true, pid: 1, expectedPid: 1, screen: IDLE}]]), {entries: starts});
  assert.deepEqual([[...back.alive], [...back.judged], back.alerts], [[SESSION], [], []]);
});

test('발견 5의 대가: 죽음 경보가 열린 뒤 그 세션을 kadan stop으로 꺼도 경보는 그대로 열려 있다(대기가 풀리거나 실행이 끝나면 닫힌다)', async () => {
  const stop = {kind: 'stop', session: SESSION, role: WORKER, t: stamp(4)};
  const r = await simulate({screen: () => IDLE, alive: minute => minute < 2, until: 8, extra: minute => minute >= 4 ? [stop] : []});
  assert.equal(r.waitingStops.length, 1);
  assert.deepEqual(r.resolved, []);
  const closed = await simulate({screen: () => IDLE, alive: minute => minute < 2, until: 8,
    card: minute => minute < 5 ? waiting : {...waiting, status: 'done'}});
  assert.deepEqual([closed.waitingStops.length, closed.resolved.map(e => e.alertKind)], [1, ['대기중정지']]);
});

test('운영 읽기 경로: 감시 명령이 쓰는 원장·카드 읽기(지난 주기 감시 역할만 준비)로도 대기 세션이 잡혀 발령한 역할에게 간다', async () => {
  // kadan watch의 배선(commands/watch.mjs)과 같게 잇는다: 카드·업무 캐시 읽기, 그 위의 원장 읽기와 투영, 지난 주기에 감시한 역할 목록.
  // 대기 역할은 감시 범위 밖이라 그 목록에 들지 않는다. 그래도 발령 기록(보낸 역할 포함)과 세션 시작 기록이 읽혀야 한다.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-waiting-stop-live-'));
  createDatabase(home); writeStorageMarker(home, 'sqlite');
  const store = new CardStore(home);
  const made = store.create({repo: 'qa', id: 'live-task', repoPath: home, body: '# 지시'});
  store.update(made.key, {status: 'assigned', role: WORKER, board: 'qa', scope: '시험 범위',
    rallyId: 'rally', rallyTitle: '묶음', rallyRound: '1', rallyStep: 'review'}, {revision: 1, note: '배정'});
  const began = Date.now() - 120_000, iso = offset => new Date(began + offset).toISOString();
  for (const s of starts) appendLedger({...s, t: iso(0)}, home);
  appendLedger({kind: 'send', role: WORKER, session: SESSION, taskId: made.id, executionKey: made.key, by: LEAD, t: iso(1000)}, home);
  store.update(made.key, {activity: 'waiting'}, {revision: store.get(made.key).revision, note: WAIT_NOTE, noteKind: 'progress', by: WORKER});
  const stores = createWatchStoreReaders(home);
  let mailRoles = [];
  const observedRoles = [];
  const mailReader = createWatchMailReader(home, null, {readCards: stores.cards.read, readWorks: stores.works.read, readRoles: () => mailRoles});
  const sent = [], keys = [], aiCalls = [], controller = new AbortController();
  let cycle = 0;
  await runWatch({signal: controller.signal, intervalMs: 60_000, stallN: 2, stallAfterMs: 300_000, idleMs: 15 * 60_000,
    parents, routes: new Map(), superRole: 'qa-top', now: () => Date.now() + cycle * 60_000,
    floor: {list: () => starts.map(s => ({session: s.session, pid: s.panePid})),
      read: session => session === SESSION ? INCIDENT : `• 맡긴 재판정 결과를 기다립니다. ${cycle}분\n\n${COMPOSER}`, alive: () => true},
    readEntries: mailReader.readEntries, readMailLetters: mailReader.letters, projectEntries: mailReader.project,
    rememberObservedRoles: roles => { mailRoles = roles; observedRoles.push([...roles]); },
    readCards: stores.cards.read, readWorks: stores.works.read,
    resume429: (role, text) => keys.push(['resume429', role, text]), sendQueueEnter: session => keys.push(['queue-enter', session]),
    sendAlert: (role, message) => { sent.push({role, message}); if (role === WORKER) keys.push(['alert', role]); },
    sendNudge: (role, message) => { sent.push({role, message, nudge: true}); if (role === WORKER) keys.push(['nudge', role]); },
    judgeCmd: 'fake', ai: {reports: {retire: () => {}}, run: args => { aiCalls.push([args.source, args.role]); return {ok: true}; }},
    record: e => appendLedger({...e, t: new Date().toISOString()}, home), spawn: () => ({status: 0, stdout: ''}), print: () => {},
    sleep: async () => { await setImmediate(); if (++cycle >= 4) controller.abort(); }});
  assert.ok(observedRoles.every(roles => !roles.includes(WORKER)), '대기 역할은 감시한 역할 목록(다음 주기 준비 대상)에 들지 않는다');
  const alerts = readLedger(home).filter(e => e.kind === 'alert' && e.alertKind === '대기중정지');
  assert.deepEqual(alerts.map(e => [e.recipient, e.route?.basis, e.delivered, e.taskId, Boolean(e.resolved)]), [[LEAD, 'dispatcher', true, made.id, false]],
    '4주기 동안 발령한 역할에게 한 번');
  const mails = sent.filter(m => /대기 표시 중/u.test(m.message));
  assert.deepEqual(mails.map(m => m.role), [LEAD]);
  for (const text of [made.key, WAIT_NOTE, CAPACITY, `발령 ${LEAD}`]) assert.ok(mails[0].message.includes(text), text);
  assert.deepEqual(keys, []);
  assert.deepEqual(aiCalls.filter(([, role]) => role === WORKER), []);
});
