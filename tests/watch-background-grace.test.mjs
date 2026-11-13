import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {setImmediate} from 'node:timers/promises';
import {runWatch} from '../src/watch-runner.mjs';

// 백그라운드 셸 표시가 있는 빈 입력창을 감시 주기로 본다. 가짜 시계·가짜 화면, 역할 이름은 운영 이름이 아닌 가짜다.
// 화면 문구는 감시AI 관찰 자료의 실제 화면 아래쪽에서 본문을 지운 것이다.
const WORKER = 'g-worker', BOSS = 'g-boss', TOP = 'g-top', ROLES = [TOP, BOSS, WORKER];
const parents = new Map([[WORKER, BOSS], [BOSS, TOP], [TOP, '@user']]);
const BAR = '───────────────────────────────────────────────';
const claudeBox = shells => [BAR, '❯ ', BAR, '  ~/work[main]', '  model | effort:medium | ctx:19%', `  ⏵⏵ bypass permissions on${shells ? ` · ${shells} shells` : ''}`];
export const claudeBackground = ['⏺ 전체 시험을 백그라운드로 돌렸다.', '', '✻ Churned for 6m 29s · done 10:59 AM · 2 shells still running', '', ...claudeBox(2)].join('\n');
export const claudeIdle = ['⏺ 전체 시험을 백그라운드로 돌렸다.', '', '✻ Churned for 6m 29s', '', ...claudeBox(0)].join('\n');
export const codexBackground = ['─ Worked for 17m 42s ─────────────────', '', '  2 background terminals running · /ps to view · /stop to close', '', '',
  '› Ask Codex to do anything', '', '  model medium · ~/work · main · Context 63% used'].join('\n');
export const codexWaiting = ['• Waiting for background terminal (5m 12s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close', '', '',
  '› Ask Codex to do anything', '', '  model medium · ~/work · main · Context 63% used'].join('\n');

// screen(분): 작업자 화면. live(분): 작업자 세션이 살아 있는가. 받은 알림을 [분, 받는 역할, 종류]로 돌려준다.
// ai: 가짜 감시 AI를 주면 감시 AI를 켠 상태로 돈다. bossIdle: 감독들도 빈 입력창에서 쉰다(기본은 일하는 중).
// ledger: 앞 실행이 돌려준 원장을 주고 from을 올리면 감시기 재시작이다.
async function watch({from = 0, until, screen, live = () => true, ai = null, bossIdle = false, ledger = null}) {
  const epoch = Date.parse('2026-09-09T00:00:00Z'), t = new Date(epoch).toISOString(), controller = new AbortController();
  const entries = ledger ?? [...ROLES.map((role, i) => ({kind: 'start', role, session: `kadan-${role}`, panePid: i + 1, t})),
    {kind: 'send', role: WORKER, session: `kadan-${WORKER}`, taskId: 'a', executionKey: 'r/a', by: BOSS, t}];
  const cards = [{id: 'a', key: 'r/a', role: WORKER, board: 'g', status: 'assigned', workType: 'execution', activity: 'running', activityRole: WORKER, activityAt: t}];
  const messages = [];
  let minute = from;
  const load = os.loadavg; os.loadavg = () => [0, 0, 0];
  try {
    await runWatch({
      signal: controller.signal, intervalMs: 60_000, stallN: 5, stallAfterMs: 300_000, parents, routes: new Map(), superRole: TOP,
      now: () => epoch + minute * 60_000, ...(ai ? {judgeCmd: 'fake', ai} : {}),
      floor: {list: () => ROLES.map((role, i) => ({session: `kadan-${role}`, pid: i + 1})).filter(item => item.session !== `kadan-${WORKER}` || live(minute)),
        // 감독들은 일하는 중(시계가 움직임)이라 감독 쪽 경보는 나지 않는다.
        read: session => session === `kadan-${WORKER}` ? screen(minute)
          : bossIdle ? claudeBox(0).join('\n') : `✻ Working… (${minute}m 0s · esc to interrupt)\n\n${claudeBox(0).join('\n')}`},
      readEntries: () => entries, readCards: () => cards, readWorks: () => [],
      record: entry => entries.push({...entry, t: new Date(epoch + minute * 60_000).toISOString()}),
      sendAlert: (role, message) => messages.push({role, message, minute}), sendNudge: (role, message) => messages.push({role, message, minute}),
      print: () => {}, spawn: () => ({status: 0, stdout: ''}),
      sleep: async () => { await setImmediate(); minute += 1; if (minute >= until) controller.abort(); },
    });
  } finally { os.loadavg = load; }
  const kindOf = m => m.message.includes('일하는 표시 없이 멈춤') ? '멈춤' : m.message.includes('화면이 멈춤') ? '정체' : m.message.includes('세션 종료 의심') ? '죽음'
    : m.message.includes('놀고 있음') ? '놀고 있음' : m.message.includes('해소됨') ? '해소' : '기타';
  return {messages, ledger: entries, sent: messages.map(m => [m.minute, m.role, kindOf(m)]).filter(m => m[2] !== '해소')};
}

for (const [name, screen] of [['claude 끝난 턴 요약 줄의 shells still running', claudeBackground], ['codex 단독 줄의 background terminals running', codexBackground],
  ['codex Waiting for background terminal 줄', codexWaiting]]) {
  test(`백그라운드 표시(${name}): 29분까지 경보 0건, 30분에 멈춤 1건과 본문의 표시 시간`, async () => {
    const before = await watch({until: 30, screen: () => screen});
    assert.deepEqual(before.sent, [], '29분째 주기까지 아무 경보도 없다');
    const after = await watch({until: 45, screen: () => screen});
    assert.deepEqual(after.sent, [[30, BOSS, '멈춤']], '30분에 한 번, 그 뒤로 반복하지 않는다');
    assert.match(after.messages[0].message, /백그라운드 셸 표시 30분째/u);
  });
}

test('표시 없는 빈 입력창은 지금과 같다: 4분에 멈춤', async () => {
  const out = await watch({until: 20, screen: () => claudeIdle});
  assert.deepEqual(out.sent, [[4, BOSS, '멈춤']]);
  assert.doesNotMatch(out.messages[0].message, /백그라운드 셸 표시/u);
});

test('표시가 사라지면(셸이 끝남) 그때부터 4분을 센다', async () => {
  const out = await watch({until: 30, screen: minute => minute < 10 ? claudeBackground : claudeIdle});
  assert.deepEqual(out.sent, [[14, BOSS, '멈춤']]);
  assert.doesNotMatch(out.messages[0].message, /백그라운드 셸 표시/u);
});

test('다른 경보는 그대로다: 백그라운드 표시가 있어도 세션 죽음은 바로 알린다', async () => {
  const out = await watch({until: 12, screen: () => claudeBackground, live: minute => minute < 5});
  assert.ok(out.sent.some(m => m[2] === '죽음'), JSON.stringify(out.sent));
});

test('감시 AI를 켠 상태: 유예 30분 동안 화면이 그대로라서 부르는 정체 판정 AI 호출이 없다(표시가 없으면 지금처럼 부른다)', async () => {
  const counter = () => { const calls = []; return {calls, ai: {reports: {retire: () => {}}, run: async options => { calls.push([options.source, options.role]); return {ok: true, reason: 'reported'}; }}}; };
  const held = counter();
  await watch({until: 30, screen: () => claudeBackground, ai: held.ai});
  assert.deepEqual(held.calls.filter(([source, role]) => source === 'stall' && role === WORKER), []);
  // 대조: 일하는 표시도 빈 입력창도 아닌 화면(입력창에 글이 있음)은 멈춤 후보가 아니라 정체 판정으로 간다. 이 경로는 그대로다.
  const typed = counter();
  await watch({until: 30, screen: () => claudeIdle.replace('❯ ', '❯ 쓰다 만 글'), ai: typed.ai});
  assert.ok(typed.calls.some(([source, role]) => source === 'stall' && role === WORKER), JSON.stringify(typed.calls));
});

// 아래 셋은 이번 변경이 바꾸지 않는 것을 그대로 적어 둔다(유예는 멈춤과 화면이 그대로라서 나는 정체만 늦춘다).
test('감시 AI를 켠 60분: 정체 판정 호출은 없고, 진행 점검(running 실행의 주기 점검)은 유예와 무관하게 그대로 불린다', async () => {
  const calls = [];
  const ai = {reports: {retire: () => {}}, run: async options => { calls.push([options.source, options.role]); return {ok: true, reason: 'reported'}; }};
  const out = await watch({until: 61, screen: () => claudeBackground, ai});
  assert.deepEqual(calls.filter(([source]) => source === 'stall'), []);
  assert.ok(calls.some(([source, role]) => source === 'progress' && role === WORKER), '진행 점검은 이 변경의 범위 밖이라 그대로다');
  assert.deepEqual(out.sent, [[30, BOSS, '멈춤']]);
});

test('감독도 빈 입력창에서 쉬면 놀고 있음은 그대로 간다: 15분 감독 본인, 30분 상위(유예와 무관)', async () => {
  const out = await watch({until: 61, screen: () => claudeBackground, bossIdle: true});
  assert.deepEqual(out.sent, [[15, BOSS, '놀고 있음'], [30, BOSS, '멈춤'], [30, TOP, '놀고 있음']]);
});

test('감시기 재시작: 표시가 이어진 시간을 0부터 다시 세어, 이미 나간 멈춤은 닫혔다가 재시작 30분 뒤 한 번 더 난다', async () => {
  const first = await watch({until: 35, screen: () => claudeBackground});
  assert.deepEqual(first.sent, [[30, BOSS, '멈춤']]);
  const second = await watch({from: 35, until: 100, screen: () => claudeBackground, ledger: first.ledger});
  assert.deepEqual(second.sent, [[65, BOSS, '멈춤']]);
  assert.match(second.messages[0].message, /백그라운드 셸 표시 30분째/u);
});
