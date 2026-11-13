import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {runWatch} from '../src/watch-runner.mjs';
import {WatchAI} from '../src/watch-ai.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {createDatabase, writeStorageMarker, storageVersion} from '../src/storage.mjs';
import {createWatchMailReader} from '../src/watch-mail-reader.mjs';
import {cycleReads} from '../src/watch-reads.mjs';

// 점검 도구 실패가 사람에게 가는지를 감시 주기로 본다. 실제 WatchAI에 점검 프로세스만 가짜로 넣어 호출 기록이 원장에 남는 경로를 탄다.
// 사용자 알림은 감시기가 부르는 시스템 알림 실행(osascript)을 가로채 센다. 가짜 시계·가짜 화면, 역할 이름은 운영 이름이 아닌 가짜다.
// 원장 읽기는 감시 명령(src/commands/watch.mjs)과 같은 배선(우편 읽기 + 주기 읽기)이다.
const REV = 't-rev', BOSS = 't-boss', TOP = 't-top', ROLES = [TOP, BOSS, REV];
const parents = new Map([[REV, BOSS], [BOSS, TOP], [TOP, '@user']]);
const IDLE = '────────\n❯\n────────\nworkspace\nmodel\npermissions';
const letters = n => [...String(n)].map(d => 'ghijklmnop'[d]).join('');
// 대상 셋: 작업 진행 점검(REV, 30분마다)과 감독 응답 점검(BOSS·TOP, 1시간마다).
const PROGRESS = `progress:${REV}:a`, HEALTH_BOSS = `supervisor-health:${BOSS}:`, HEALTH_TOP = `supervisor-health:${TOP}:`;

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-tool-fail-'));
  createDatabase(home); writeStorageMarker(home, 'sqlite');
  const epoch = Date.now() + 1_000, t = new Date(epoch).toISOString();
  for (const [i, role] of ROLES.entries()) appendLedger({kind: 'start', role, session: `kadan-${role}`, panePid: i + 1, t}, home);
  appendLedger({kind: 'send', role: REV, session: `kadan-${REV}`, taskId: 'a', executionKey: 'r/a', by: BOSS, t}, home);
  const cards = [{id: 'a', key: 'r/a', role: REV, board: 't', status: 'assigned', workType: 'execution', activity: 'running', activityRole: REV, activityAt: t, at: t, by: REV}];
  return {home, epoch, cards};
}

// outcome({key, n, minute}) → 'ok' | 'missing' | 'failed' | 'timeout'. key는 `종류:역할:실행`, n은 그 대상의 몇 번째 점검인지(1부터).
// 같은 env로 from을 바꿔 다시 부르면 감시기 재시작이다.
async function watch(env, {from = 0, until, outcome = () => 'ok', ai: fakeAI = null}) {
  const {home, epoch, cards} = env, controller = new AbortController();
  const userNotes = [], roleMessages = [], prints = [], counts = env.counts ??= new Map();
  let minute = from;
  const clock = () => epoch + minute * 60_000, iso = () => new Date(clock()).toISOString();
  const record = entry => appendLedger({...entry, t: entry.t ?? iso()}, home);
  let mailRoles = [];
  const mailReader = createWatchMailReader(home, null, {readCards: () => cards, readWorks: () => [], readRoles: () => mailRoles});
  const reads = cycleReads({readEntries: mailReader.readEntries, readCards: () => cards, readWorks: () => [], version: () => storageVersion(home)});
  const floor = {list: () => ROLES.map((role, i) => ({session: `kadan-${role}`, pid: i + 1})),
    // 작업자는 일하는 중(시계가 움직임), 감독은 빈 입력창. 감독 화면은 한 시간마다 글자 하나가 바뀌어 같은 화면 재사용으로 점검을 건너뛰지 않는다.
    read: session => session === `kadan-${REV}` ? `⏺ 작업 ${letters(minute)}\n\n✻ Working… (${minute}m 0s · esc to interrupt)\n\n${IDLE}`
      : `⏺ 기다리는 중 ${letters(Math.floor(minute / 60))}\n\n${IDLE}`};
  const ai = fakeAI ?? new WatchAI({home, now: clock, readCards: () => cards, readWorks: () => [], floor, record,
    send: (role, message) => roleMessages.push({role, message, minute}),
    spawn: async (_command, options) => {
      const id = options.env.KADAN_JUDGE_REQUEST;
      const request = readLedger(home).find(e => e.kind === 'watch-ai-request' && e.requestId === id);
      const key = `${request.source}:${request.role}:${request.taskId || ''}`, n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      const result = outcome({key, n, minute});
      // 정상 판정: 일하는 작업자는 진행중, 기다리는 감독은 입력대기.
      if (result === 'ok') { ai.reports.submit(id, request.source === 'progress' ? '진행중' : '입력대기', '정상'); return {status: 0, stdout: ''}; }
      if (result === 'missing') return {status: 0, stdout: '입력대기'}; // 판정은 정했지만 보고 명령이 끝나지 못했다
      if (result === 'failed') return {status: 1, stdout: ''};
      return {status: null, error: {code: 'ETIMEDOUT'}};
    }});
  const load = os.loadavg; os.loadavg = () => [0, 0, 0];
  try {
    await runWatch({
      signal: controller.signal, intervalMs: 60_000, stallN: 5, stallAfterMs: 300_000, parents, routes: new Map(), superRole: TOP,
      judgeCmd: 'fake', ai, now: clock, floor,
      readEntries: reads.readEntries, readMailLetters: mailReader.letters, projectEntries: mailReader.project, reads,
      rememberObservedRoles: roles => { mailRoles = roles; },
      readCards: reads.readCards, readWorks: reads.readWorks, record,
      sendAlert: (role, message) => roleMessages.push({role, message, minute}),
      print: line => prints.push(String(line)),
      spawn: (command, args) => { if (command === 'osascript') userNotes.push({minute, text: String(args?.[1] ?? '')}); return {status: 0, stdout: ''}; },
      sleep: async () => { await setImmediate(); minute += 1; if (minute >= until) controller.abort(); },
    });
  } finally { os.loadavg = load; }
  const ledger = readLedger(home);
  return {userNotes, roleMessages, prints, ledger,
    calls: ledger.filter(e => e.kind === 'watch-ai-call').map(e => `${e.source}:${e.role}:${e.taskId || ''}=${e.reason}`),
    alerts: ledger.filter(e => e.kind === 'alert' && e.alertKind === '감시AI오류')};
}
const failAt = (target, ...numbers) => ({key, n}) => key === target && numbers.includes(n) ? 'missing' : 'ok';

test('점검 도구 실패 1회: 사람 알림 0건, 원장에는 호출 기록이 남는다', async () => {
  const out = await watch(setup(), {until: 200, outcome: failAt(HEALTH_BOSS, 1)});
  assert.deepEqual(out.userNotes, []);
  assert.deepEqual(out.alerts, [], '경보 기록도 만들지 않는다');
  assert.ok(out.calls.includes(`${HEALTH_BOSS}=report-missing`), '실패는 원장의 호출 기록으로 남는다(대시보드 감시 화면이 이 기록을 센다)');
  assert.ok(out.prints.some(line => line.includes('점검 도구 오류(기록만)') && line.includes(BOSS)), '감시 출력에 한 줄');
  assert.deepEqual(out.roleMessages, [], '역할 창에도 보내지 않는다');
});

test('성공이 끼면 다시 센다: 실패·성공·실패는 알리지 않는다', async () => {
  const out = await watch(setup(), {until: 260, outcome: failAt(HEALTH_BOSS, 1, 3)});
  assert.equal(out.calls.filter(c => c === `${HEALTH_BOSS}=report-missing`).length, 2);
  assert.deepEqual(out.userNotes, []);
});

test('같은 대상에서 연속 2번 실패: 두 번째 실패 때 1회 올리고, 계속 실패해도 다시 올리지 않으며, 성공하면 닫힌다', async () => {
  const reasons = {1: 'missing', 2: 'timeout', 3: 'failed', 4: 'missing'};
  const out = await watch(setup(), {until: 400, outcome: ({key, n}) => key === HEALTH_BOSS && reasons[n] ? reasons[n] : 'ok'});
  assert.equal(out.userNotes.length, 1, JSON.stringify(out.userNotes));
  const [note] = out.userNotes;
  assert.ok(note.minute >= 120 && note.minute <= 125, `두 번째 실패(약 2시간째) 때: ${note.minute}분`);
  for (const part of ['점검 도구 오류 — ', `감시기가 ${BOSS} 응답 상태 점검을 끝내지 못함`, '연속 2회', '대상 상태는 모름(대상이 멈췄다는 뜻이 아님)'])
    assert.ok(note.text.includes(part), `${part} / ${note.text}`);
  assert.ok(!note.text.includes('정상으로 보였음'), '기록된 판정이 없으면 대상 상태를 말하지 않는다');
  // 사유가 바뀌며 네 번 실패했지만 알림은 한 번이고, 다섯 번째 점검이 성공하면 닫힘 기록이 남는다.
  assert.deepEqual(out.alerts.map(a => [a.id, a.resolved === true]), [[`ai-call:${HEALTH_BOSS}`, false], [`ai-call:${HEALTH_BOSS}`, true]]);
});

test('여러 대상이 잇달아 실패(도구 전체 장애): 대상별 횟수와 별개로 1회만 올린다', async () => {
  // 60분부터 모든 점검이 실패한다. 대상마다 한두 번씩만 실패한 시점에 전체 장애로 한 번 올라가고, 대상별 경보는 따로 올리지 않는다.
  const out = await watch(setup(), {until: 200, outcome: ({minute}) => minute >= 60 ? 'failed' : 'ok'});
  assert.equal(out.userNotes.length, 1, JSON.stringify(out.userNotes.map(n => [n.minute, n.text.slice(0, 60)])));
  const [note] = out.userNotes;
  assert.ok(note.minute < 100, `첫 실패 뒤 15분이 지난 다음 실패에서: ${note.minute}분`);
  assert.match(note.text, /점검 도구 오류 — 감시기의 점검이 여러 대상\(\d+개\)에서 잇달아 실패/u);
  assert.deepEqual(out.alerts.map(a => a.id), ['ai-call:all']);
  for (const target of [PROGRESS, HEALTH_BOSS, HEALTH_TOP]) assert.ok(out.calls.includes(`${target}=call-failed`), target);
});

test('도구 전체 장애 경보는 성공한 점검이 하나 오면 닫히고, 그 뒤의 한 번 실패는 다시 조용하다', async () => {
  const out = await watch(setup(), {until: 330, outcome: ({key, minute}) => minute >= 60 && minute < 130 || key === HEALTH_TOP && minute >= 290 ? 'failed' : 'ok'});
  assert.equal(out.userNotes.length, 1);
  assert.deepEqual(out.alerts.map(a => [a.id, a.resolved === true]), [['ai-call:all', false], ['ai-call:all', true]]);
});

test('감시기 재시작: 이미 올린 경보는 열린 채 복원되어 계속 실패해도 다시 알리지 않고, 횟수는 원장에서 이어 센다', async () => {
  // 재시작 전에 한 번 실패(알림 없음) → 재시작 뒤 두 번째 실패에서 올라간다: 횟수가 원장에서 이어진다.
  const counted = setup(), boss = failAt(HEALTH_BOSS, 1, 2, 3);
  assert.deepEqual((await watch(counted, {until: 90, outcome: boss})).userNotes, []);
  const after = await watch(counted, {from: 90, until: 200, outcome: boss});
  assert.equal(after.userNotes.length, 1);
  assert.match(after.userNotes[0].text, /연속 2회/u);
  // 올린 뒤 재시작해도 같은 경보를 다시 알리지 않는다(세 번째 실패).
  const again = await watch(counted, {from: 200, until: 330, outcome: boss});
  assert.equal(again.calls.filter(c => c === `${HEALTH_BOSS}=report-missing`).length, 3);
  assert.deepEqual(again.userNotes, []);
  assert.deepEqual(again.alerts.filter(a => !a.resolved).map(a => a.id), [`ai-call:${HEALTH_BOSS}`], '열린 경보는 하나 그대로');
});

test('전달 기록이 없는 문제 판정은 도구 실패만이 아니므로 한 번이어도 바로 알린다', async () => {
  let called = false;
  const ai = {reports: {retire: () => {}}, run: async options => {
    if (options.source !== 'supervisor-health' || options.role !== BOSS || called) return {ok: true, reason: 'reported'};
    called = true;
    return {ok: false, reason: 'report-incomplete', requestId: 'req-1', verdict: '정체', deliveredRecipients: []};
  }};
  const out = await watch(setup(), {until: 90, ai});
  assert.equal(out.userNotes.length, 1);
  assert.match(out.userNotes[0].text, /기록된 판정: 정체\(판정은 기록됐지만 따로 전달됐는지는 확인 안 됨\)/u);
});

test('호출 기록을 남기지 못한 실패(준비·저장 단계 오류)도 같은 기록으로 남겨 같은 기준으로 센다', async () => {
  let n = 0;
  const ai = {reports: {retire: () => {}}, run: async options => {
    if (options.source !== 'supervisor-health' || options.role !== BOSS) return {ok: true, reason: 'reported'};
    n += 1;
    if (n <= 2) throw new Error('저장 실패');
    return {ok: true, reason: 'reported'};
  }};
  const out = await watch(setup(), {until: 200, ai});
  assert.deepEqual(out.calls.filter(c => c.startsWith(HEALTH_BOSS)), [`${HEALTH_BOSS}=report-error`, `${HEALTH_BOSS}=report-error`]);
  assert.equal(out.userNotes.length, 1, '두 번째 실패에서 한 번');
});

test('감시 보고 저장소 정리 실패는 한 주기면 조용하고 3주기 연속이면 올린다', async () => {
  const failing = minutes => { let cycle = 0; return {reports: {retire: () => { cycle += 1; if (minutes.includes(cycle)) throw new Error('잠금'); }}, run: async () => ({ok: true, reason: 'reported'})}; };
  assert.deepEqual((await watch(setup(), {until: 20, ai: failing([3, 7, 8])})).userNotes, []);
  const out = await watch(setup(), {until: 20, ai: failing([3, 4, 5])});
  assert.equal(out.userNotes.length, 1);
  assert.match(out.userNotes[0].text, /점검 도구 오류 — 감시 보고 저장소 정리가 연속으로 실패/u);
});
