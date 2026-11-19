import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setImmediate} from 'node:timers/promises';
import {runWatch} from '../src/watch-runner.mjs';
import {buildWatchScope} from '../src/watch-scope.mjs';
import {assessWaitingStops, waitingStopScreen} from '../src/watch-waiting-stop.mjs';
import {screenDisconnects, disconnectKind} from '../src/watch.mjs';
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
async function simulate({screen = () => INCIDENT, card = () => waiting, alive = () => true, until = 14, seed = null, by = BOSS, extra = () => []} = {}) {
  let minute = 0;
  const entries = seed ?? [...starts, dispatch(by)];
  const before = entries.length, sent = [], keys = [], aiCalls = [];
  const controller = new AbortController();
  await runWatch({signal: controller.signal, intervalMs: 60_000, stallN: 2, stallAfterMs: 300_000, idleMs: 15 * 60_000,
    parents, routes: new Map(), superRole: 'qa-top', now: () => epoch + minute * 60_000,
    floor: {list: () => starts.filter(s => s.role !== WORKER || alive(minute)).map(s => ({session: s.session, pid: s.panePid})),
      read: session => session === SESSION ? screen(minute) : `• 맡긴 재판정 결과를 기다립니다. ${minute}분\n\n${COMPOSER}`, alive: () => true},
    readEntries: () => [...entries, ...extra(minute)], readCards: () => [card(minute)], readWorks: () => [],
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

test('대기 세션의 최종 429 화면은 자동 재개 없이 경보만 한 번', async () => {
  const r = await simulate({screen: () => LIMIT_429});
  assert.equal(r.waitingStops.length, 1);
  assert.equal(r.waitingStops[0].recipient, BOSS);
  assert.deepEqual(r.keys, [], '재개 문구를 보내지 않는다');
  assert.deepEqual(r.retries, [], '재개 예약도 만들지 않는다');
  assert.deepEqual(r.workerAI, []);
  assert.match(r.sent.find(m => /대기 표시 중/u.test(m.message)).message, /429 Too Many Requests/u);
  // 오류 덩어리로 읽지 못하는 모양(바로 위가 한 줄 응답)이어도 최종 429 판정이 잡는다.
  const loose = `• 시험을 다시 돌립니다.\n■ exceeded retry limit, last status: 429 Too Many Requests\n\n${COMPOSER}`;
  assert.equal(screenDisconnects(loose).size, 0);
  assert.match(waitingStopScreen(loose, epoch).line, /429 Too Many Requests/u);
  assert.match(waitingStopScreen(loose, epoch).key, /^429:[0-9a-f]{64}$/u);
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
    assert.equal(waitingStopScreen(screen, epoch), null, screen);
    const r = await simulate({screen: () => screen, until: 3});
    assert.deepEqual(r.waitingStops, [], screen);
    assert.deepEqual(r.keys, []);
  }
});

test('지금 규칙의 한계 기록: 오류 줄 바로 위가 한 줄 응답이면 용량 초과 줄을 읽지 않는다(기존 현재 오류 덩어리 규칙 그대로)', () => {
  const afterResponse = `• 전체 시험을 돌리겠습니다.\n\n${CAPACITY}\n\n${COMPOSER}`;
  assert.equal(waitingStopScreen(afterResponse, epoch), null);
  // 사고 화면처럼 바로 위가 도구 블록의 들여쓴 줄이면 읽는다.
  assert.equal(waitingStopScreen(INCIDENT, epoch).line, CAPACITY);
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
  const first = assessWaitingStops(new Set(), [entry], seen(), {entries: starts, now: epoch});
  assert.deepEqual([...first.alive], [SESSION]);
  assert.equal(first.alerts.length, 1);
  assert.equal(first.alerts[0].dispatcher, LEAD);
  assert.equal(first.alerts[0].waitingNote, WAIT_NOTE);
  const swapped = assessWaitingStops(first.alive, [entry], seen({pid: 9}), {entries: starts, now: epoch});
  assert.deepEqual(swapped.alerts.map(a => a.dead), [true]);
  assert.deepEqual(assessWaitingStops(new Set(), [entry], seen({pid: 9}), {entries: starts, now: epoch}).alerts, []);
  assert.deepEqual(assessWaitingStops(new Set(), [], seen(), {entries: starts, now: epoch}), {alive: new Set(), alerts: []});
  // 대기 사유는 그 대기 표시를 만든 보고 한 줄이다. 뒤에 붙은 일반 메모는 사유가 아니다.
  const memo = {...waiting, at: stamp(5), noteKind: 'decision', note: '감독 메모', history: [waiting]};
  assert.equal(assessWaitingStops(new Set(), [{...entry, card: memo}], seen(), {entries: starts, now: epoch}).alerts[0].waitingNote, WAIT_NOTE);
  assert.equal(assessWaitingStops(new Set(), [{...entry, card: {...memo, history: []}}], seen(), {entries: starts, now: epoch}).alerts[0].waitingNote, '');
});

test('경보 본문: 실행 키·대기 표시 시각과 사유·정지 줄·감시 밖이었던 이유를 담고, 복원된 경보(값 없음)도 문장이 깨지지 않는다', () => {
  const entry = {session: SESSION, role: WORKER, taskId: 'qa-task', executionKey: KEY, by: LEAD, card: waiting};
  const [alert] = assessWaitingStops(new Set(), [entry], new Map([[SESSION, {role: WORKER, alive: true, pid: 1, expectedPid: 1, screen: INCIDENT}]]), {entries: starts, now: epoch}).alerts;
  const body = formatAlertBody(alert);
  assert.match(body, new RegExp(`^대기 표시 중 오류 화면으로 멈춤 ${SESSION} / ${KEY} \\(`, 'u'));
  for (const text of [`"${WAIT_NOTE}"`, `화면: ${CAPACITY}`, '대기 표시 때문에 정체 감시 밖이었음', `발령 ${LEAD}`, '감독 확인 필요']) assert.ok(body.includes(text), text);
  const mail = itemizedAlert(alert, '15:00');
  assert.ok(mail.includes('상태: 대기 표시 중 오류 화면으로 멈춤') && mail.includes('근거: 대기 표시'), mail);
  const restored = seedAlertState([{kind: 'alert', id: alert.id, alertKind: alert.kind, level: 'AMBER', role: WORKER, session: SESSION, taskId: 'qa-task', delivered: true, recipient: BOSS}]).active[0];
  assert.equal(formatAlertBody(restored), `대기 표시 중 오류 화면으로 멈춤 ${SESSION} / qa-task (대기 표시; 대기 표시 때문에 정체 감시 밖이었음 — 감독 확인 필요)`);
});

test('받는 쪽: 발령한 역할이 관계표의 직속 상위와 달라도 직속 상위에게 가고, 본문이 발령한 역할을 밝힌다', async () => {
  const r = await simulate({by: LEAD, until: 3});
  assert.deepEqual(r.waitingStops.map(e => e.recipient), [BOSS]);
  assert.ok(r.sent.find(m => /대기 표시 중/u.test(m.message)).message.includes(`발령 ${LEAD}`));
  assert.deepEqual(r.sent.filter(m => m.role === LEAD), []);
});
