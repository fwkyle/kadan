import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {runWatch} from '../src/watch-runner.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {createDatabase, writeStorageMarker, storageVersion} from '../src/storage.mjs';
import {CardStore} from '../src/card-store.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {createWatchStoreReaders} from '../src/watch-store-cache.mjs';
import {createWatchMailReader} from '../src/watch-mail-reader.mjs';
import {cycleReads} from '../src/watch-reads.mjs';
import {buildSupervisorScope, buildWatchScope} from '../src/watch-scope.mjs';
import {watchScopeFacts} from '../src/watch-scope-facts.mjs';
import {observationContext} from '../src/watch-supervisor-health.mjs';
import {buildWatchPrompt} from '../src/watch-ai.mjs';

// 끝난 실행을 감독이 모른 채 쉬는 경우의 재현. 실제 카드·업무 저장소(결과 등록·진행 보고)를 거치고,
// 감시 주기는 가짜 시계·가짜 화면으로 돌린다. 원장·카드·업무 읽기는 감시 명령(src/commands/watch.mjs)과 같은 배선이다.
// 역할 이름은 운영 이름이 아닌 가짜다.
const BOSS = 'p-boss', REV = 'p-rev', TOP = 'p-top';
const parents = new Map([[REV, BOSS], [BOSS, TOP], [TOP, '@user']]);
const IDLE = '────────\n❯\n────────\nworkspace\nmodel\npermissions';
const doneScreen = `⏺ 결과를 등록했다.\n\nKADAN:DONE exec-1 failed\n\n✻ Finished\n\n${IDLE}`;
const KEY = 'repo/exec-1', WORK = 'repo/w1';

// 업무 → 검수 실행 발령 → 시작 보고 → 결과 등록 → (finalActivity) 종료 메모. 완료 통지 우편은 보내지 않는다.
function setup({finalActivity = 'waiting', report = true} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-finished-'));
  createDatabase(home); writeStorageMarker(home, 'sqlite');
  const cards = new CardStore(home), works = new WorkStore(home);
  const stamp = () => new Date().toISOString();
  for (const [i, role] of [TOP, BOSS, REV].entries()) appendLedger({kind: 'start', role, session: `kadan-${role}`, panePid: i + 1, t: stamp()}, home);
  works.create({key: WORK, title: '업무', goal: '결과', scope: '범위', acceptance: '기준', owner: BOSS, repoPath: home, board: 'p', by: BOSS});
  cards.create({repo: 'repo', id: 'exec-1', repoPath: home, body: '# exec-1', by: BOSS});
  works.change(WORK, 'link', {execution: KEY, phase: 'review', round: 1}, {revision: 1, by: BOSS, note: '실행 연결'});
  const ready = cards.update(KEY, {status: 'ready', scope: '범위'}, {revision: 1, by: BOSS, note: '승인'});
  cards.update(KEY, {status: 'assigned', role: REV, board: 'p', rallyId: 'w1', rallyTitle: '묶음', rallyRound: '1', rallyStep: 'review'},
    {revision: ready.revision, by: BOSS, note: '발령'});
  appendLedger({kind: 'send', role: REV, session: `kadan-${REV}`, taskId: 'exec-1', executionKey: KEY, by: BOSS, t: stamp()}, home);
  works.change(WORK, 'update', {turnOwner: REV}, {revision: 2, by: BOSS, note: '차례 넘김'});
  const env = {home, cards, works};
  progress(env, 'running', '시작');
  if (report) {
    fs.writeFileSync(cards.get(KEY).resultPath, '# 결과\n');
    cards.report(KEY, {revision: cards.get(KEY).revision, outcome: 'changes', by: REV});
  }
  if (finalActivity) progress(env, finalActivity, '종료 기록: 완료 통지는 거절됨');
  return env;
}
const progress = ({cards}, activity, note) => cards.update(KEY, {activity}, {revision: cards.get(KEY).revision, by: REV, noteKind: 'progress', note});
const cardUpdate = ({cards}, patch, note) => cards.update(KEY, patch, {revision: cards.get(KEY).revision, by: BOSS, note});
const workUpdate = ({works}, fields, note) => works.change(WORK, 'update', fields, {revision: works.get(WORK).revision, by: BOSS, note});

// from분부터 until분까지 1분 주기로 돈다. hooks[분]으로 중간에 상태를 바꾼다. 같은 epoch로 다시 부르면 감시기 재시작이다.
// live(역할, 분): 그 역할의 세션이 살아 있는가. ai: 가짜 감시 AI({reports, run})를 주면 감시 AI를 켠 상태로 돈다.
async function watch(env, {from = 0, until, epoch = Date.now() + 1_000, screens = {}, hooks = {}, decisions = () => [], live = () => true, ai = null} = {}) {
  const {home} = env, stores = createWatchStoreReaders(home), controller = new AbortController();
  let mailRoles = [];
  const mailReader = createWatchMailReader(home, null, {readCards: stores.cards.read, readWorks: stores.works.read, readRoles: () => mailRoles});
  const reads = cycleReads({readEntries: mailReader.readEntries, readCards: stores.cards.read, readWorks: stores.works.read, version: () => storageVersion(home)});
  const messages = [];
  let minute = from;
  const iso = () => new Date(epoch + minute * 60_000).toISOString();
  const screen = {[REV]: () => doneScreen, [BOSS]: () => IDLE, [TOP]: () => IDLE, ...screens};
  const load = os.loadavg; os.loadavg = () => [0, 0, 0];
  try {
    await runWatch({
      signal: controller.signal, intervalMs: 60_000, stallN: 5, stallAfterMs: 300_000, parents, routes: new Map(), superRole: TOP,
      now: () => epoch + minute * 60_000,
      ...(ai ? {judgeCmd: 'fake', ai} : {}),
      floor: {list: () => [TOP, BOSS, REV].map((role, i) => ({session: `kadan-${role}`, pid: i + 1})).filter(item => live(item.session.slice(6), minute)),
        read: session => screen[session.slice(6)](minute)},
      readEntries: reads.readEntries, readMailLetters: mailReader.letters, projectEntries: mailReader.project, reads,
      rememberObservedRoles: roles => { mailRoles = roles; },
      readCards: reads.readCards, readWorks: reads.readWorks, readDecisions: () => decisions(minute),
      record: entry => appendLedger({...entry, t: iso()}, home),
      sendAlert: (role, message) => messages.push({role, message, minute, via: 'alert'}),
      sendNudge: (role, message) => messages.push({role, message, minute, via: 'nudge'}),
      print: () => {}, spawn: () => ({status: 0, stdout: ''}),
      sleep: async () => { await setImmediate(); minute += 1; hooks[minute]?.(env, iso()); if (minute >= until) controller.abort(); },
    });
  } finally { os.loadavg = load; }
  // 전달된 알림을 [분, 받는 역할, 종류]로 줄인다. 해소 안내는 뺀다.
  const kindOf = m => m.message.includes('놀고 있음') ? '놀고 있음' : m.message.includes('끝난 것 같음') ? '완료후보' : m.message.includes('해소됨') ? '해소'
    : m.message.includes('화면이 멈춤') ? '정체' : m.message.includes('일하는 표시 없이 멈춤') ? '멈춤' : m.message.includes('세션 종료 의심') ? '죽음' : '기타';
  const sent = messages.map(m => [m.minute, m.role, kindOf(m)]);
  return {epoch, messages, sent, alerts: sent.filter(m => m[2] !== '해소')};
}
// 15분에 감독에게 완료후보와 본인 알림(놀고 있음 1단), 30분에 상위에게 놀고 있음 2단. 그 뒤로는 다시 깨우지 않는다.
const LADDER = [[15, BOSS, '완료후보'], [15, BOSS, '놀고 있음'], [30, TOP, '놀고 있음']];
const shift = minutes => LADDER.map(([at, role, kind]) => [at + minutes, role, kind]);

test('대조군: 종료 메모가 running이면 완료후보·놀고 있음 1단(본인)·2단(상위)이 난다', async () => {
  const out = await watch(setup({finalActivity: 'running'}), {until: 60});
  assert.deepEqual(out.alerts, LADDER);
});

test('재현: 결과 등록 뒤 종료 메모가 waiting이어도 감독 본인 알림 1회, 계속 쉬면 상위로 올라간다(오래 쉬어도 반복하지 않는다)', async () => {
  const out = await watch(setup({finalActivity: 'waiting'}), {until: 1000});
  assert.deepEqual(out.alerts, LADDER, '주기 1000번 동안 알림은 이 셋뿐이다(반복해서 깨우지 않는다)');
  assert.deepEqual(out.messages.filter(m => m.role === BOSS).map(m => m.via), ['alert', 'nudge'], '감독 본인 창: 완료후보 1회 + 놀고 있음 1단 1회');
});

test('정당한 대기는 그대로 조용하다: 결과 등록 없는 waiting(화면에 완료 표시가 있어도, 알려진 한계)', async () => {
  const out = await watch(setup({finalActivity: 'waiting', report: false}), {until: 120});
  assert.deepEqual(out.sent, []);
});

test('조용: 감독이 유예 안에 done을 적으면 알림이 없다(통지가 정상으로 온 경우와 같다)', async () => {
  const done = ({home}, t) => appendLedger({kind: 'done', role: REV, session: `kadan-${REV}`, taskId: 'exec-1', executionKey: KEY, result: 'failed', by: BOSS, t}, home);
  const out = await watch(setup(), {until: 60, hooks: {5: done}});
  assert.deepEqual(out.sent, []);
});

test('조용: 결과 등록 뒤 감독이 카드를 고쳤으면(메모·보류) 알림이 없다', async () => {
  for (const [name, touch] of [
    ['메모', env => cardUpdate(env, {}, '결과 확인, 수정 발령 예정')],
    ['보류', env => cardUpdate(env, {status: 'hold'}, '보류')],
  ]) {
    const env = setup(); touch(env);
    assert.deepEqual((await watch(env, {until: 60})).sent, [], name);
  }
});

test('취소한 실행은 더 알리지 않는다. 진행 중 실행이 없어진 열린 업무는 기존 규칙대로 업무 단위의 할 일이다', async () => {
  const env = setup(); cardUpdate(env, {status: 'cancelled'}, '취소');
  const out = await watch(env, {until: 60});
  assert.equal(out.alerts.some(m => m[2] === '완료후보'), false);
  assert.equal(out.messages.some(m => m.message.includes('exec-1')), false, '실행을 근거로 한 알림은 없다');
  assert.ok(out.messages.every(m => m.message.includes(`work:${WORK}`)), '남은 알림의 근거는 업무다');
});

test('조용: 업무가 보류면 알림이 없다', async () => {
  const env = setup(); workUpdate(env, {status: 'hold'}, '업무 보류');
  assert.deepEqual((await watch(env, {until: 60})).sent, []);
});

test('감독이 카드를 고친 뒤 담당이 다시 기록하면 다시 확정 대기로 센다(알리는 쪽으로 틀린다)', async () => {
  const env = setup(); cardUpdate(env, {}, '결과 확인'); progress(env, 'waiting', '추가 종료 메모');
  assert.deepEqual((await watch(env, {until: 60})).alerts, LADDER);
});

test('조용: 그 실행에 사용자 결정이 열려 있는 동안은 알림이 없고, 닫히면 그때 난다', async () => {
  const decision = {id: 'd1', status: 'open', card: KEY, requestedBy: BOSS, question: '머지할까', options: ['예', '아니오'], at: new Date().toISOString()};
  // 40분에 답이 와서 결정이 닫히고 감독 창에 답이 찍힌다(화면이 바뀐다). 완료후보는 유예가 이미 지나 그 주기에 나고, 놀고 있음은 그때부터 센다.
  const answered = minute => minute < 40 ? IDLE : `⏺ 사용자 답: 예\n\n${IDLE}`;
  const out = await watch(setup(), {until: 100, decisions: minute => minute < 40 ? [decision] : [], screens: {[BOSS]: answered}});
  assert.deepEqual(out.alerts, [[40, BOSS, '완료후보'], [55, BOSS, '놀고 있음'], [70, TOP, '놀고 있음']]);
});

test('조용: 감독이 그 실행으로 상위에게 물은 질문 우편(답 대기)이 있으면 감독에게 알림이 없다. 담당이 감독에게 물은 질문은 감독의 할 일이라 가리지 않는다', async () => {
  const ask = (by, role) => ({home}) => appendLedger({kind: 'send', transport: 'mailbox', mailId: `q-${by}`, by, role, expectReply: true, executionKey: KEY, workKey: WORK, t: new Date().toISOString()}, home);
  const quiet = setup(); ask(BOSS, TOP)(quiet);
  const asked = await watch(quiet, {until: 60});
  assert.deepEqual(asked.sent.filter(m => m[1] === BOSS || m[2] === '완료후보'), [], '묻고 기다리는 감독에게는 조용');
  // 답할 차례인 상위는 기존 규칙대로 본인 차례(답할 질문) 알림을 받는다. 상위의 다음 단계는 사용자 알림이라 여기 잡히지 않는다.
  assert.deepEqual(asked.messages.map(m => [m.minute, m.role, m.via]), [[15, TOP, 'nudge']]);
  const loud = setup(); ask(REV, BOSS)(loud);
  const out = await watch(loud, {until: 60});
  assert.ok(out.alerts.some(m => m[1] === BOSS && m[2] === '놀고 있음'), '감독 본인 알림');
  assert.ok(out.alerts.some(m => m[1] === TOP && m[2] === '놀고 있음'), '상위 알림');
});

test('조용: 담당이 아직 응답을 만드는 중이면(화면이 움직임) 알림이 없다', async () => {
  const working = minute => `⏺ 마무리 중 ${'가나다라마바사아자차'[minute % 10]}\n\n✻ Working… (${minute}m 0s · esc to interrupt)\n\n${IDLE}`;
  assert.deepEqual((await watch(setup(), {until: 60, screens: {[REV]: working}})).sent, []);
});

test('업무 대기 시각(wait-until)은 끝난 실행을 가리지 않는다', async () => {
  const env = setup(); workUpdate(env, {waitUntil: new Date(Date.now() + 10 * 3_600_000).toISOString()}, '내일 아침까지 대기');
  assert.deepEqual((await watch(env, {until: 60})).alerts, LADDER);
});

// 유예(완료후보)와 멈춘 시간(놀고 있음)은 감시기 메모리에서만 센다. 재시작하면 0부터 다시 세므로, 아직 확정되지 않은 실행은
// 재시작 15분 뒤 같은 순서로 한 번 더 알린다(재시작마다 1회). 종료 메모가 running인 기존 경로도 똑같다.
test('감시기 재시작: 확정되지 않은 실행은 재시작 15분 뒤부터 같은 순서로 한 번 더 알린다(기존 경로와 같은 동작)', async () => {
  for (const finalActivity of ['waiting', 'running']) {
    const env = setup({finalActivity});
    const first = await watch(env, {until: 20});
    assert.deepEqual(first.alerts, LADDER.slice(0, 2), finalActivity);
    const second = await watch(env, {from: 20, until: 180, epoch: first.epoch});
    assert.deepEqual(second.sent, shift(20), finalActivity);
  }
});

test('감독 관찰AI 입력에 결과 등록 사실이 실린다(결과 시각·판정, 확정 대기 표시)', () => {
  const env = setup(), readers = createWatchStoreReaders(env.home);
  const cards = readers.cards.read(), entries = readLedger(env.home);
  const scope = buildSupervisorScope(cards, entries, parents, readers.works.read());
  const context = observationContext(BOSS, {alive: true, pid: 2, expectedPid: 2}, entries, cards, scope.entries);
  const task = context.tasks.find(t => t.id === 'exec-1');
  assert.equal(task.activity, 'waiting');
  assert.equal(task.resultOutcome, 'changes');
  assert.equal(task.resultReportedAt, env.cards.get(KEY).result.at);
  assert.equal(context.responsibilities.find(r => r.executionKey === KEY).awaitsConfirmation, true);
  assert.match(buildWatchPrompt({source: 'supervisor-health', command: 'kadan watch-report', input: context}), /resultReportedAt·resultOutcome/u);
});

// 정당하게 기다리던 담당이 나중에 결과를 등록한다(등록 뒤에도 waiting 그대로).
const reportLater = env => { fs.writeFileSync(env.cards.get(KEY).resultPath, '# 결과\n'); env.cards.report(KEY, {revision: env.cards.get(KEY).revision, outcome: 'changes', by: REV}); };

test('결과만 등록하고 화면에 완료 표시가 없어도 감독에게 간다: 입력창 멈춤 알림 뒤 놀고 있음 1단 → 2단', async () => {
  const out = await watch(setup(), {until: 120, screens: {[REV]: () => IDLE}});
  assert.deepEqual(out.messages.map(m => [m.minute, m.role, m.via]), [[4, BOSS, 'alert'], [15, BOSS, 'nudge'], [30, TOP, 'alert']]);
  assert.match(out.messages[0].message, /일하는 표시 없이 멈춤/u);
});

// 감독이 다른 본인 차례 일로 이미 놀고 있음 2단까지 올라간 뒤(30분), 기다리던 담당이 60분에 결과를 등록한다.
// 담당 세션이 감시에 새로 들어오며 멈춘 시간을 다시 세므로, 열려 있던 경보에 묻히지 않고 본인 알림부터 다시 간다.
test('감독에게 이미 놀고 있음이 열려 있어도 끝난 실행은 묻히지 않는다(본인 알림부터 다시 간다)', async () => {
  for (const [marker, own] of [[true, [75, BOSS, 'alert', '끝난 것 같음']], [false, [64, BOSS, 'alert', '일하는 표시 없이 멈춤']]]) {
    const env = setup({report: false});
    env.works.create({key: 'repo/w2', title: '다른 업무', goal: '결과', scope: '범위', acceptance: '기준', owner: BOSS, repoPath: env.home, board: 'p', by: BOSS});
    const out = await watch(env, {until: 150, hooks: {60: reportLater}, screens: {[REV]: minute => marker && minute >= 60 ? doneScreen : IDLE}});
    const seen = out.messages.map(m => [m.minute, m.role, m.via]);
    assert.deepEqual(seen.slice(0, 2), [[15, BOSS, 'nudge'], [30, TOP, 'alert']], '결과 등록 전: 다른 업무로 1단 → 2단');
    assert.deepEqual(seen.slice(2), [own.slice(0, 3), [75, BOSS, 'nudge'], [90, TOP, 'alert']], `표시 ${marker}`);
    assert.ok(out.messages[2].message.includes(own[3]));
    assert.match(out.messages.find(m => m.minute === 75 && m.via === 'nudge').message, /본인 차례 2건/u);
  }
});

test('운영과 같은 읽기 경로(범위 사실 묶음)에서도 확정 대기 표시가 붙는다', () => {
  const env = setup(), stores = createWatchStoreReaders(env.home);
  const mailReader = createWatchMailReader(env.home, null, {readCards: stores.cards.read, readWorks: stores.works.read, readRoles: () => []});
  const reads = cycleReads({readEntries: mailReader.readEntries, readCards: stores.cards.read, readWorks: stores.works.read, version: () => storageVersion(env.home)});
  reads.begin();
  const raw = reads.readEntries(), cards = reads.readCards(), works = reads.readWorks();
  const entries = mailReader.project(raw, cards);
  assert.ok(watchScopeFacts(entries, cards), '범위 사실 묶음을 쓰는 갈래여야 한다');
  const scope = buildWatchScope(cards, entries, parents, works);
  assert.deepEqual(scope.entries.map(e => [e.role, e.executionKey, e.awaitsConfirmation]), [[REV, KEY, true]]);
});

// 검수 지적 F1: 감독의 처리와 다른 역할의 기록을 구분한다.
const note = (env, by, text = '상태 확인') => env.cards.update(KEY, {}, {revision: env.cards.get(KEY).revision, by, noteKind: 'progress', note: text});

test('F1: 감독이 아닌 다른 역할이 카드에 메모를 남겨도 확정 대기 실행은 감시에 남는다', async () => {
  const env = setup(); note(env, 'p-observer');
  assert.deepEqual((await watch(env, {until: 60})).alerts, LADDER);
});

test('F1 대조: 발령한 감독·상위 감독·사용자가 결과 등록 뒤 카드를 고쳤으면 조용하다', async () => {
  for (const by of [BOSS, TOP, '사람']) {
    const env = setup(); note(env, by, '결과 확인');
    assert.deepEqual((await watch(env, {until: 60})).sent, [], by);
  }
});

// 검수 지적 F2: 결과 등록 뒤 담당이 감독에게 질문을 보내고 답을 기다린다. 화면은 완료 표시·일하는 표시·오류가 없는 빈 입력창이다.
const askBoss = env => appendLedger({kind: 'send', transport: 'mailbox', mailId: 'q-rev', by: REV, role: BOSS, expectReply: true, executionKey: KEY, workKey: WORK, t: new Date().toISOString()}, env.home);
const stallCounter = () => { const calls = []; return {calls, ai: {reports: {retire: () => {}}, run: async options => { calls.push([options.source, options.role]); return {ok: true, reason: 'reported'}; }}}; };

test('F2: 답을 기다리는 담당은 정체로 알리지 않고 정체 판정 AI도 부르지 않는다. 답할 감독의 본인 차례는 그대로 간다', async () => {
  const quiet = setup(); askBoss(quiet);
  assert.deepEqual((await watch(quiet, {until: 60, screens: {[REV]: () => IDLE}})).alerts, [[15, BOSS, '놀고 있음'], [30, TOP, '놀고 있음']]);
  const withAI = setup(), counter = stallCounter(); askBoss(withAI);
  await watch(withAI, {until: 60, screens: {[REV]: () => IDLE}, ai: counter.ai});
  assert.deepEqual(counter.calls.filter(([source, role]) => role === REV), [], '담당에 대한 감시 AI 호출 없음');
});

test('F2 회귀: 답을 기다리는 담당이어도 세션 죽음은 가리지 않는다', async () => {
  const env = setup(); askBoss(env);
  const out = await watch(env, {until: 20, screens: {[REV]: () => IDLE}, live: (role, minute) => role !== REV || minute < 5});
  assert.ok(out.alerts.some(m => m[2] === '죽음'), JSON.stringify(out.alerts));
});

test('F2 대조: 질문이 없으면 결과만 등록하고 멈춘 담당은 지금처럼 감독에게 알린다', async () => {
  const out = await watch(setup(), {until: 20, screens: {[REV]: () => IDLE}});
  assert.deepEqual(out.alerts, [[4, BOSS, '멈춤'], [15, BOSS, '놀고 있음']]);
});

test('그 실행에 사용자 결정이 열려 있는 동안은 화면에 완료 표시가 없어도 담당의 멈춤·정체를 알리지 않는다', async () => {
  const decision = {id: 'd2', status: 'open', card: KEY, requestedBy: BOSS, question: '머지할까', options: ['예', '아니오'], at: new Date().toISOString()};
  const out = await watch(setup(), {until: 40, decisions: () => [decision], screens: {[REV]: () => IDLE}});
  assert.deepEqual(out.sent, []);
});

// 검수 지적 F3: 다른 담당으로 재발령한 카드에 남은 옛 결과를 지금 담당의 결과로 알려 주지 않는다.
test('F3: 재발령 전 담당의 결과는 감시 AI 입력에 지금 결과로 실리지 않는다', () => {
  const env = setup({finalActivity: null}), REV2 = 'p-rev2', lineage = new Map([...parents, [REV2, BOSS]]);
  appendLedger({kind: 'start', role: REV2, session: `kadan-${REV2}`, panePid: 4, t: new Date().toISOString()}, env.home);
  env.cards.update(KEY, {role: REV2}, {revision: env.cards.get(KEY).revision, by: BOSS, note: '다른 검수자로 재발령'});
  appendLedger({kind: 'send', role: REV2, session: `kadan-${REV2}`, taskId: 'exec-1', executionKey: KEY, by: BOSS, t: new Date().toISOString()}, env.home);
  env.cards.update(KEY, {activity: 'running'}, {revision: env.cards.get(KEY).revision, by: REV2, noteKind: 'progress', note: '시작'});
  const readers = createWatchStoreReaders(env.home), cards = readers.cards.read(), entries = readLedger(env.home);
  assert.equal(env.cards.get(KEY).result.by, REV, '카드에는 옛 담당의 결과가 남아 있다');
  for (const [role, scope] of [[BOSS, buildSupervisorScope(cards, entries, lineage, readers.works.read())], [REV2, buildWatchScope(cards, entries, lineage, readers.works.read())]]) {
    const task = observationContext(role, {alive: true, pid: 2, expectedPid: 2}, entries, cards, scope.entries).tasks.find(t => t.id === 'exec-1');
    assert.equal(task.activity, 'running', role);
    assert.equal(task.resultReportedAt, undefined, `${role}: 옛 결과 시각을 싣지 않는다`);
    assert.equal(task.resultOutcome, undefined, `${role}: 옛 판정을 싣지 않는다`);
  }
});
