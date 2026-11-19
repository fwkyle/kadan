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
// "기대 결과 표"라고 적은 시험은 발령 카드의 표 한 줄씩이다(판정 기준: main에서는 대기 세션에 관한 경보가 늘 0이다).
const fixture = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const INCIDENT = fixture('waiting-capacity-screens.json').incident;
const CAPACITY = '■ Selected model is at capacity. Please try a different model.';
const COMPOSER = '› Ask Codex to do anything\n\n  gpt-6.1-sol high · ~/Dev/PROJ · main · Context 41% used\n';
const TOOL = '• Ran npm test\n  └ 4 passed\n    +2 lines';
const errorScreen = (...block) => `${TOOL}\n\n${block.join('\n')}\n\n${COMPOSER}`;
const IDLE = `• 다른 시험이 끝나면 전체 시험을 돌리겠습니다.\n\n${COMPOSER}`;
const WORKING = `• Ran sleep 60\n\n• Working (3m 10s • esc to interrupt)\n\n${COMPOSER}`;
const TERMINAL_429 = '■ Exceeded retry limit, last status: 429 Too Many Requests';
const LIMIT_429 = errorScreen(TERMINAL_429);
const FENCED_429 = ['• 장애 로그 설명을 추가했습니다.', '', '```text', TERMINAL_429, '```', '', COMPOSER].join('\n');
const PAST_429 = [TOOL, '', TERMINAL_429, '', '• 다시 시도해 확인을 끝냈습니다.', '', COMPOSER].join('\n');
const PARTIAL = {
  'quoted-capacity': '■ Could not read documentation entry "Selected model is at capacity".',
  'capacity-planning': '■ Selected model is at capacity planning stage.',
};
// tmux가 좁은 창에서 줄을 접는 모양: 칸 수대로 자르고(낱말 중간도), 줄 끝 공백은 화면 읽기(capture-pane -p)에서 사라진다.
const wrap = (screen, width) => screen.split('\n').flatMap(line => {
  const chars = [...line], rows = [];
  for (let at = 0; at < Math.max(chars.length, 1); at += width) rows.push(chars.slice(at, at + width).join('').trimEnd());
  return rows;
}).join('\n');
const WIDTHS = Array.from({length: 71}, (_, index) => 30 + index); // 30~100칸. 입력창 줄(26칸)이 접히지 않는 범위

const epoch = Date.parse('2026-11-18T06:54:00Z');
const stamp = minute => new Date(epoch + minute * 60_000).toISOString();
const WORKER = 'qa-reviewer', BOSS = 'qa-boss', TOP = 'qa-top', LEAD = 'qa-lead', SESSION = `kadan-${WORKER}`;
const parents = new Map([[WORKER, BOSS], [BOSS, TOP], [TOP, '@user']]);
const start = (role, panePid) => ({kind: 'start', role, session: `kadan-${role}`, panePid, harness: 'codex', model: 'm', t: stamp(0)});
const starts = [start(WORKER, 1), start(BOSS, 2), start(TOP, 3), start(LEAD, 4)];
const KEY = 'qa/qa-task';
const running = {id: 'qa-task', key: KEY, role: WORKER, board: 'qa', status: 'assigned', workType: 'execution',
  activity: 'running', activityRole: WORKER, activityAt: stamp(0), at: stamp(0)};
const WAIT_NOTE = '다른 시험 종료 뒤 전체 시험 대기';
const waiting = {...running, activity: 'waiting', activityAt: stamp(1), at: stamp(1), noteKind: 'progress', note: WAIT_NOTE, by: WORKER};
const dispatch = (by = BOSS) => ({kind: 'send', role: WORKER, session: SESSION, taskId: 'qa-task', executionKey: KEY, by, t: stamp(0)});

// screen·card·alive는 분(minute)을 받아 그 순회의 값을 준다. keys: 대기 세션에 닿을 수 있는 모든 입력 길(재개·큐 Enter·알림·넛지).
// gone: 창이 없는 역할 이름들. sendFail(role, minute): 그 전송에서 던질 오류(없으면 성공). attempts: 전송 시도(실패 포함).
async function simulate({screen = () => INCIDENT, card = () => waiting, alive = () => true, until = 14, seed = null, by = BOSS,
  extra = () => [], gone = [], sendFail = () => null} = {}) {
  let minute = 0;
  const entries = seed ?? [...starts, dispatch(by)];
  const before = entries.length, sent = [], attempts = [], keys = [], aiCalls = [];
  const controller = new AbortController();
  await runWatch({signal: controller.signal, intervalMs: 60_000, stallN: 2, stallAfterMs: 300_000, idleMs: 15 * 60_000,
    parents, routes: new Map(), superRole: TOP, now: () => epoch + minute * 60_000,
    floor: {list: () => starts.filter(s => s.role === WORKER ? alive(minute) : !gone.includes(s.role)).map(s => ({session: s.session, pid: s.panePid})),
      read: session => session === SESSION ? screen(minute) : `• 맡긴 재판정 결과를 기다립니다. ${minute}분\n\n${COMPOSER}`, alive: () => true},
    readEntries: () => [...entries, ...extra(minute)], readCards: () => [card(minute)], readWorks: () => [],
    resume429: (role, text) => keys.push(['resume429', role, text]),
    sendQueueEnter: session => keys.push(['queue-enter', session]),
    sendAlert: (role, message) => {
      attempts.push([minute, role]);
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
  return {entries, records, sent, attempts, keys, alerts,
    opened: alerts.filter(e => !e.resolved), resolved: alerts.filter(e => e.resolved),
    waitingStops: alerts.filter(e => e.alertKind === '대기중정지' && !e.resolved),
    stopMails: sent.filter(m => /대기 표시 중/u.test(m.message)),
    workerAI: aiCalls.filter(([, , role]) => role === WORKER), aiCalls,
    retries: records.filter(e => e.kind === 'rate-limit-retry' || e.kind === 'queue-resume')};
}

test('기대 결과 표 1: 사고 원문 고정본 + 빈 입력창(80칸)이면 경보 1회, 다음 주기 0회, 키 0회, AI 0회', async () => {
  assert.ok(INCIDENT.split('\n').every(line => [...line].length <= 80), '고정본은 80칸 안이다');
  const r = await simulate();
  assert.equal(r.waitingStops.length, 1, '14주기 동안 경보 기록은 한 번');
  assert.deepEqual([r.waitingStops[0].recipient, r.waitingStops[0].delivered, r.waitingStops[0].level], [BOSS, true, 'AMBER']);
  assert.deepEqual(r.stopMails.map(m => [m.minute, m.role]), [[0, BOSS]], '정체 시간을 기다리지 않고 처음 본 주기에 한 번');
  const since = new Date(stamp(1)); // 본문은 기계 시간대의 월/일 시:분으로 적는다
  const when = `${since.getMonth() + 1}/${since.getDate()} ${String(since.getHours()).padStart(2, '0')}:${String(since.getMinutes()).padStart(2, '0')}`;
  for (const text of [SESSION, KEY, WAIT_NOTE, CAPACITY, '대기 표시 때문에 정체 감시 밖이었음', `대기 표시 ${when}`])
    assert.ok(r.stopMails[0].message.includes(text), `알림에 "${text}" 없음: ${r.stopMails[0].message}`);
  assert.deepEqual(r.resolved, [], '화면이 그대로인 동안 풀리지도 퇴역(감시제외)하지도 않는다');
  assert.deepEqual(r.keys, [], '대기 세션에는 아무 입력도 보내지 않는다');
  assert.deepEqual(r.workerAI, [], '대기 세션을 두고 AI를 부르지 않는다');
  assert.deepEqual(r.retries, [], '자동 재개·큐 재개 기록 없음');
  // 감시기가 다시 떠도(원장에서 열린 경보를 복원) 같은 경보를 다시 보내지 않는다.
  const again = await simulate({seed: r.entries, until: 4});
  assert.deepEqual([again.waitingStops, again.resolved, again.stopMails], [[], [], []]);
});

test('기대 결과 표 2: 같은 화면이 55칸·45칸 창에서 접혀도 경보 1회(창 너비가 달라도 같은 경보)', async () => {
  for (const width of [55, 45]) {
    const screen = wrap(INCIDENT, width);
    assert.ok(!screen.includes(CAPACITY), `${width}칸: 사고 문장이 두 줄로 접혀 있다`);
    const r = await simulate({screen: () => screen, until: 6});
    assert.equal(r.waitingStops.length, 1, `${width}칸`);
    assert.deepEqual([r.stopMails.length, r.keys, r.workerAI, r.resolved], [1, [], [], []], `${width}칸`);
    assert.ok(r.stopMails[0].message.includes(`화면: ${CAPACITY}`), '본문에는 이어 붙인 한 줄을 적는다');
  }
  // 30~100칸 어느 너비에서도(낱말 중간에서 접혀도) 읽고, 정지 줄과 키가 같다 — 창 크기를 바꿔도 다시 울리지 않는다.
  const found = WIDTHS.map(width => waitingStopScreen(wrap(INCIDENT, width)));
  assert.deepEqual(WIDTHS.filter((_, index) => !found[index]), [], '못 읽은 너비');
  assert.deepEqual([...new Set(found.map(f => `${f.key}\n${f.line}`))], [`${waitingStopScreen(INCIDENT).key}\n${CAPACITY}`]);
  // 재검수의 실제 tmux 화면 모양(도구 출력 → 빈 줄 → 접힌 문장 → 빈 입력창).
  for (const rows of [['■ Selected model is at capacity. Please try a different', ' model.'], ['■ Selected model is at capacity. Please try a', ' different model.']])
    assert.equal(waitingStopScreen(['tool output', '', ...rows, '', '', '› ', ''].join('\n'))?.line, CAPACITY);
  // 창이 좁아 한 화면이 두 번 바뀌어도(80 → 45 → 80) 경보는 하나다.
  const resized = await simulate({screen: minute => minute >= 2 && minute < 4 ? wrap(INCIDENT, 45) : INCIDENT, until: 6});
  assert.deepEqual([resized.waitingStops.length, resized.resolved], [1, []]);
});

test('기대 결과 표 3: 도구 출력 아래의 최종 429 + 빈 입력창이면 경보 1회, 키 0회(자동 재개 없음)', async () => {
  const r = await simulate({screen: () => LIMIT_429});
  assert.deepEqual([r.waitingStops.length, r.waitingStops[0].recipient], [1, BOSS]);
  assert.deepEqual(r.keys, [], '대기 세션에 재개 문구를 보냈다');
  assert.deepEqual([r.retries, r.workerAI], [[], []], '재개 예약도 AI 호출도 없다');
  assert.match(r.stopMails[0].message, /429 Too Many Requests/u);
  // 대조: 같은 화면이 감시 범위 안(대기 표시 없음)이면 재개가 실제로 예약·전송된다 — 위 키 0회가 빈 검사가 아님을 보인다.
  const watched = await simulate({screen: () => LIMIT_429, card: () => running, until: 6});
  assert.ok(watched.keys.some(([kind, role]) => kind === 'resume429' && role === WORKER), `감시 범위 안에서는 재개 문구가 가야 한다: ${JSON.stringify(watched.retries.map(e => e.action))}`);
});

test('기대 결과 표 4: 정상 작업 중(시계 움직임)·정상 빈 입력창은 경보 0회, AI 0회, 키 0회', async () => {
  const ticking = minute => `• Ran sleep 60\n\n• Working (${minute + 3}m 10s • esc to interrupt)\n\n${COMPOSER}`;
  for (const screen of [ticking, () => WORKING, () => IDLE]) {
    const r = await simulate({screen, until: 40});
    assert.deepEqual(r.alerts, [], '대기 세션에 관한 경보 기록이 하나도 없다');
    assert.deepEqual([r.workerAI, r.keys, r.retries], [[], [], []]);
  }
  // 감시 범위 안이었다면 정체 판정 AI가 불리는 화면(입력창에 글이 남은 채 그대로)이어도 대기 세션에는 부르지 않는다.
  const still = '• 다른 시험이 끝나기를 기다립니다.\n\n› 감독에게 보낼 메모를 쓰는 중';
  const r = await simulate({screen: () => still, until: 20});
  assert.deepEqual(r.workerAI, [], '대기 세션을 두고 AI를 불렀다');
  assert.deepEqual([r.alerts, r.keys], [[], []]);
  const watched = await simulate({screen: () => still, card: () => running, until: 20});
  assert.ok(watched.workerAI.some(([, source]) => source === 'stall'), `대조: 감시 범위 안에서는 정체 판정 AI가 불려야 한다: ${JSON.stringify(watched.aiCalls)}`);
});

test('기대 결과 표 5: 코드 울타리 안의 429, 429 뒤에 정상 응답이 이어진 화면은 경보 0회', async () => {
  for (const [name, screen] of Object.entries({'fenced-429': FENCED_429, 'past-429': PAST_429})) {
    assert.equal(waitingStopScreen(screen), null, name);
    const r = await simulate({screen: () => screen, until: 12});
    assert.deepEqual(r.alerts, [], `${name}: 대기 세션에 관한 경보가 없어야 한다`);
    assert.deepEqual([r.keys, r.workerAI, r.retries], [[], [], []], name);
  }
  // 본문·코드 울타리·설명에 인용된 용량 초과 문장, 일하는 표시 위·쓰는 중인 입력창 위의 문장, 낱말 capacity만 있는 오류도 아니다.
  const quoted = [
    `• 화면에 "${CAPACITY}"가 뜨면 감독에게 알린다고 문서에 적었습니다.\n\n${COMPOSER}`,
    `• 예시 화면:\n\n\`\`\`\n${CAPACITY}\n\`\`\`\n\n${COMPOSER}`,
    `• 사고 화면은 다음과 같습니다:\n\n${CAPACITY}\n\n${COMPOSER}`,
    `${CAPACITY}\n\n• Working (1m 02s • esc to interrupt)\n\n${COMPOSER}`,
    `${CAPACITY}\n\n› 지금 쓰는 중인 답장`,
    errorScreen('■ Model is overloaded, retry later', '  └ capacity exceeded'),
  ];
  for (const screen of quoted) {
    for (const width of [80, 55, 45]) assert.equal(waitingStopScreen(wrap(screen, width)), null, `${width}칸: ${screen}`);
    const r = await simulate({screen: () => screen, until: 3});
    assert.deepEqual([r.waitingStops, r.keys], [[], []], screen);
  }
});

test('기대 결과 표 6: 용량 초과 부분 일치 두 반례는 어떤 너비에서도 경보 0회', async () => {
  const more = {
    'prefix': '■ Note: Selected model is at capacity. Please try a different model.',
    'suffix': '■ Selected model is at capacity. Please try a different model. (see docs)',
    'first-sentence-only': '■ Selected model is at capacity.',
    'no-error-mark': 'Selected model is at capacity. Please try a different model.',
    'extra-line': `${CAPACITY}\n  └ request id 12ab`,
  };
  for (const [name, line] of Object.entries({...PARTIAL, ...more})) {
    const screen = errorScreen(line);
    const hits = WIDTHS.filter(width => waitingStopScreen(wrap(screen, width)) || screenDisconnects(wrap(screen, width)).size);
    assert.deepEqual(hits, [], `${name}: 정지로 읽은 너비(대기 경로·감시 범위 안 둘 다 0이어야 한다)`);
  }
  for (const [name, line] of Object.entries(PARTIAL)) for (const width of [80, 55, 45]) {
    const r = await simulate({screen: () => wrap(errorScreen(line), width), until: 6});
    assert.deepEqual(r.alerts, [], `${name} ${width}칸`);
    assert.deepEqual([r.keys, r.workerAI], [[], []], `${name} ${width}칸`);
  }
  // 실제 오류 줄은 대소문자·다른 오류 표시·줄 끝 공백이 달라도 같은 한 줄로 읽는다.
  for (const line of [CAPACITY, CAPACITY.toUpperCase(), `${CAPACITY}  `])
    assert.equal(waitingStopScreen(errorScreen(line))?.line, CAPACITY, line);
  assert.equal(waitingStopScreen(errorScreen(`✕${CAPACITY.slice(1)}`))?.line, `✕${CAPACITY.slice(1)}`);
  // 다른 오류 줄에 딸린 줄이면 그 오류를 읽는다(용량 초과 문장 하나가 덩어리 전체가 아니다).
  assert.equal(waitingStopScreen(errorScreen('■ stream error', `  ${CAPACITY}`))?.line, '■ stream error');
});

// 재검수 2(2026-11-19): 정상 답변이 지난 오류를 콜론 없이 바로 아래에 옮겨 적고 빈 입력창이 온 화면. 좁은 창에서는 답변의 끝 조각만
// 오류 줄 바로 위에 남고 머리표(`•`)는 그 위 줄에 있다. main은 어떤 너비에서도 0회다.
const QUOTE_HEAD = '• This is the error message copied from the earlier run for reference only.';
const quoteScreen = (gap, line = CAPACITY) => [QUOTE_HEAD, ...gap, line, '', COMPOSER].join('\n');

test('좁은 창에서 접힌 답변의 인용은 정지가 아니다: 80·55·45칸 모두 0회, 같은 너비의 실제 사고 화면은 1회', async () => {
  for (const width of [80, 55, 45]) {
    for (const [name, gap] of [['바로 아래', []], ['빈 줄 하나 건너', ['']]]) {
      const screen = wrap(quoteScreen(gap), width);
      if (width < 77) assert.ok(!screen.split('\n')[1].startsWith('•') && !screen.includes(QUOTE_HEAD), `${width}칸: 답변이 접혀 있다`);
      const active = await simulate({screen: () => screen, card: () => running, until: 4});
      assert.deepEqual(active.opened.map(e => e.alertKind), [], `${width}칸 ${name}: 실행 중 끊김 0회`);
      const held = await simulate({screen: () => screen, until: 4});
      assert.deepEqual([held.alerts, held.keys, held.workerAI], [[], [], []], `${width}칸 ${name}: 대기 중 0회`);
    }
    // 양성 대조: 같은 너비의 실제 사고 화면은 실행 중 끊김 1회, 대기 중 대기중정지 1회.
    const incident = wrap(INCIDENT, width);
    const active = await simulate({screen: () => incident, card: () => running, until: 4});
    assert.deepEqual(active.opened.map(e => e.alertKind), ['끊김'], `${width}칸: 실제 사고(실행 중)`);
    const held = await simulate({screen: () => incident, until: 4});
    assert.deepEqual(held.opened.map(e => e.alertKind), ['대기중정지'], `${width}칸: 실제 사고(대기 중)`);
  }
  // 재검수의 실제 tmux 화면 모양 그대로.
  for (const rows of [
    ['• This is the error message copied from the earlier run', ' for reference only.', '■ Selected model is at capacity. Please try a different', ' model.'],
    ['• This is the error message copied from the e', 'arlier run for reference only.', '■ Selected model is at capacity. Please try a', ' different model.'],
  ]) assert.equal(screenDisconnects([...rows, '', '', '› ', ''].join('\n')).size, 0, rows[1]);
});

test('인용 판정은 오류 줄 위의 논리 줄을 본다: 어떤 너비에서도 답변 문단 아래는 0회, 도구 출력 아래는 1회', () => {
  const read = screen => [waitingStopScreen(screen) !== null, screenDisconnects(screen).size > 0];
  // 답변이 몇 줄로 접히든(30~100칸), 화면이 스스로 들여써 나눈 여러 줄 답변이든, 그 문단 바로 아래의 문장은 인용이다.
  const paragraphs = [quoteScreen([]), quoteScreen(['']),
    ['• This is the error message copied from the earlier run', '  for reference only. It shows what happened at 07:05.', '', CAPACITY, '', COMPOSER].join('\n'),
    ['⏺ 지난 실행의 오류를 참고로 그대로 옮깁니다', CAPACITY, '', COMPOSER].join('\n')];
  for (const screen of paragraphs) {
    const hits = WIDTHS.filter(width => read(wrap(screen, width)).some(Boolean));
    assert.deepEqual(hits, [], `정지로 읽은 너비: ${screen.split('\n')[0]}`);
  }
  // 도구 출력(`• Ran …` 아래의 `│ └` 줄, 그 아래 들여쓴 출력) 바로 아래의 오류는 답변 문단이 아니다: 모든 너비에서 읽는다.
  const tools = [INCIDENT, errorScreen(CAPACITY), `• Ran date\n  │ if test -e log; then wc -l log; fi\n\n${CAPACITY}\n\n${COMPOSER}`,
    `⏺ Bash(npm test)\n  ⎿  12 passed\n     and one more line of output\n\n${CAPACITY}\n\n${COMPOSER}`, `tool output\n\n${CAPACITY}\n\n› \n`];
  // 실제 codex 화면(보안 필터 표본)의 알림 덩어리만 용량 초과 줄로 바꾼 것: `• Edited … (+5 -0)` 아래에 4칸 들여쓴 줄만 있고
  // `│ └` 표시가 없다. 깊게 들여쓴 줄은 접힌 답변 조각이 아니라 출력이라, 그 아래의 오류는 현재 오류다.
  const real = fixture('security-filter-screens.json')['A-test-output-then-notice'];
  const edited = `${real.slice(0, real.indexOf('ⓘ This content'))}${CAPACITY}\n\n\n${COMPOSER}`;
  assert.match(edited, /\n• Edited [^\n]+\n {4}\d+ [^\n]*\n(?: {4,}[^\n]*\n)+\n■ Selected/u, '편집 블록 모양 확인');
  for (const screen of [...tools, edited]) {
    const misses = WIDTHS.filter(width => !read(wrap(screen, width)).every(Boolean));
    assert.deepEqual(misses, [], `못 읽은 너비: ${screen.split('\n')[0]}`);
  }
  // 앞선 다른 오류 줄 바로 아래는 답변 문단이 아니다(그 위가 답변이어도 오류 표시 줄에서 끊는다).
  assert.deepEqual(read(`• 다시 시도합니다.\n\n■ stream error\n${CAPACITY}\n\n${COMPOSER}`), [true, true]);
  // 논리 줄은 빈 줄에서 끊는다: 빈 줄 건너 그 위에 답변이 있어도, 오류 바로 위 문단이 머리표 없는 출력이면 답변 문단이 아니다.
  for (const width of [80, 55, 45])
    assert.deepEqual(read(wrap(`• 앞선 답변입니다. 시험을 돌려 보겠습니다.\n\ntool output without any marker\n\n${CAPACITY}\n\n${COMPOSER}`, width)), [true, true], `${width}칸`);
});

test('다른 문구의 판정은 main 그대로다: 접힌 답변 아래의 429는 지금처럼 바로 위 한 줄만 본다', () => {
  // 논리 줄 판정은 접힌 줄을 이어 붙여 읽는 용량 초과에만 쓴다. 429·끊김 등은 main과 같은 한 줄 판정이라 결과가 달라지지 않는다.
  // 아래 값은 main 소스와 나란히 돌려 같음을 확인한 것이다(문구 11종 × 화면 모양 10종 × 30~100칸, 차이 0).
  const sizes = line => [80, 55, 45].map(width => screenDisconnects(wrap(quoteScreen([], line), width)).size);
  assert.deepEqual(sizes('■ 429 Too Many Requests'), [0, 1, 1], '짧은 오류 줄: 답변이 접히면 main도 읽는다');
  assert.deepEqual(sizes('■ stream error'), [0, 1, 1]);
  assert.deepEqual(sizes(TERMINAL_429), [0, 0, 0], '오류 줄 자체가 접히면 main은 읽지 못한다(접힌 줄을 잇는 것은 용량 초과뿐이다)');
});

test('기대 결과 표 7: 같은 정지 줄에서 위쪽의 옛 오류가 스크롤 밖으로 밀려도 추가 경보 0회', async () => {
  const scrolled = line => minute => [minute < 3 ? '■ An older unrelated error' : null, minute < 3 ? '' : null, TOOL, '', line, '', COMPOSER]
    .filter(row => row !== null).join('\n');
  for (const line of [TERMINAL_429, CAPACITY]) {
    const r = await simulate({screen: scrolled(line), until: 6});
    assert.equal(r.waitingStops.length, 1, line);
    assert.deepEqual(r.resolved, [], line);
    assert.equal(new Set([0, 1, 2, 3, 4, 5].map(minute => waitingStopScreen(scrolled(line)(minute)).key)).size, 1, line);
  }
  // 시계·횟수 숫자만 다른 같은 줄도 같은 경보다.
  const ticking = await simulate({screen: minute => `x\n• Reconnecting... ${minute % 5}/5 (${minute}m 0${minute % 10}s • esc to interrupt)\n${COMPOSER}`, until: 8});
  assert.deepEqual([ticking.waitingStops.length, ticking.resolved], [1, []]);
});

test('기대 결과 표 8: 대기 표시가 풀리거나 실행이 끝나면 경보가 해제된다', async () => {
  const r = await simulate({card: minute => minute < 3 ? waiting : {...running, activityAt: stamp(3), at: stamp(3)}, until: 8});
  assert.equal(r.waitingStops.length, 1);
  assert.deepEqual(r.resolved.map(e => e.alertKind), ['대기중정지']);
  assert.ok(r.resolved[0].t >= stamp(3), '대기가 풀린 주기에 닫힌다');
  assert.deepEqual(r.opened.map(e => e.alertKind), ['대기중정지', '끊김'], '풀린 뒤 같은 화면은 정상 감시의 끊김으로 난다');
  // 실행이 끝나면(done 기록, 카드 종료) 닫힌다.
  const done = await simulate({extra: minute => minute >= 2 ? [{kind: 'done', role: WORKER, taskId: 'qa-task', executionKey: KEY, result: 'ok', t: stamp(2)}] : [], until: 5});
  assert.deepEqual([done.waitingStops.length, done.resolved.map(e => e.alertKind)], [1, ['대기중정지']]);
  const closed = await simulate({card: minute => minute < 2 ? waiting : {...waiting, status: 'done'}, until: 5});
  assert.deepEqual([closed.waitingStops.length, closed.resolved.map(e => e.alertKind)], [1, ['대기중정지']]);
  // 화면이 회복되면 닫히고, 다른 정지 줄이 뜨면 새 경보다.
  const recovered = await simulate({screen: minute => minute < 2 ? INCIDENT : WORKING, until: 6});
  assert.deepEqual([recovered.waitingStops.length, recovered.resolved.map(e => e.alertKind)], [1, ['대기중정지']]);
  const changed = await simulate({screen: minute => minute < 2 ? INCIDENT : errorScreen('■ stream disconnected before completion'), until: 6});
  assert.equal(changed.waitingStops.length, 2);
  assert.notEqual(changed.waitingStops[0].id, changed.waitingStops[1].id);
});

test('기대 결과 표 9: #434 한도 화면 3종은 대기 경보 1개 또는 정상 감시 한도 경보 1개이고 겹치지 않는다', async () => {
  const usage = "■ You've hit your usage limit. Try again at Nov 20th, 2026 3:00 PM.";
  const screens = {
    'codex 사용 한도': errorScreen(usage),
    '사용 한도 + 딸린 용량 초과 줄': errorScreen(usage, `  ${CAPACITY}`),
    'claude 한도 고정본': fixture('claude-limit-incident-screens.json')['pos-banner-after-detail'],
  };
  for (const [name, screen] of Object.entries(screens)) {
    assert.equal(typeof screen, 'string', name);
    const held = await simulate({screen: () => screen, until: 4});
    assert.deepEqual([held.opened.map(e => e.alertKind), held.keys, held.workerAI], [['대기중정지'], [], []], `${name}: 대기 중`);
    const active = await simulate({screen: () => screen, card: () => running, until: 4});
    assert.deepEqual([active.opened.map(e => e.alertKind), active.keys], [['한도'], []], `${name}: 감시 범위 안`);
  }
});

test('범위 밖(알려진 한계, 요구가 아니라 지금 동작의 기록): 응답 한 줄 바로 아래의 오류, 대기 세션의 죽음', async () => {
  // 오류 줄 바로 위가 응답 한 줄이면 현재 오류 덩어리 규칙이 인용·설명으로 보아 읽지 않는다(용량 초과·최종 429 둘 다).
  // 감시 범위 안이면 이 모양의 429는 자동 재개가 받지만 대기 세션에는 자동 재개가 없다.
  for (const line of [CAPACITY, TERMINAL_429]) {
    assert.equal(waitingStopScreen(`• 전체 시험을 돌리겠습니다.\n\n${line}\n\n${COMPOSER}`), null, line);
    assert.equal(waitingStopScreen(`• 직전 답변입니다.\n${line}\n\n${COMPOSER}`), null, line);
  }
  // 대기 중 세션이 사라져도 알리지 않는다(이 검사는 살아 있는 세션의 화면만 본다).
  const died = await simulate({screen: () => IDLE, alive: minute => minute < 2, until: 6});
  assert.deepEqual([died.alerts, died.keys], [[], []]);
  // 정지 경보가 열린 채 세션이 사라지면 경보는 닫힌다(화면이 없으면 정지 화면도 없다).
  const stopped = await simulate({alive: minute => minute < 2, until: 6});
  assert.deepEqual([stopped.waitingStops.length, stopped.resolved.map(e => e.alertKind)], [1, ['대기중정지']]);
});

test('대기 경로가 정지로 보는 화면은 정상 감시의 즉시 경보 기준이 정지로 보는 화면과 같다(더 넓지도 좁지도 않다)', () => {
  const screens = [INCIDENT, wrap(INCIDENT, 55), wrap(INCIDENT, 45), LIMIT_429, FENCED_429, PAST_429, IDLE, WORKING,
    `• 시험을 다시 돌립니다.\n${TERMINAL_429}\n\n${COMPOSER}`, ...Object.values(PARTIAL).map(line => errorScreen(line)),
    errorScreen('■ stream disconnected before completion'), `x\n• Reconnecting... 2/5 (9m 34s • esc to interrupt)\n${COMPOSER}`,
    `${CAPACITY}\n\n› 지금 쓰는 중인 답장`];
  for (const screen of screens) {
    const normal = screenDisconnects(screen), found = waitingStopScreen(screen);
    assert.equal(found !== null, normal.size > 0, screen);
    if (found) assert.deepEqual([normal.has(found.key), normal.get(found.key)], [true, found.line], screen);
  }
  assert.deepEqual(screens.map(s => waitingStopScreen(s) !== null),
    [true, true, true, true, false, false, false, false, false, false, false, true, true, false]);
});

test('감시 대상 안 작업자의 용량 초과 화면은 정지 문구(끊김)로 바로 잡히고, 좁은 창에서도 같다', async () => {
  assert.deepEqual([...screenDisconnects(INCIDENT).values()], [CAPACITY]);
  assert.equal(disconnectKind(CAPACITY), '끊김');
  for (const screen of [INCIDENT, wrap(INCIDENT, 45)]) {
    const r = await simulate({screen: () => screen, card: () => running, until: 6});
    assert.deepEqual(r.opened.map(e => [e.alertKind, e.recipient]), [['끊김', BOSS]]);
    assert.deepEqual([r.waitingStops, r.keys, r.retries], [[], [], []], '용량 초과에는 자동 재개를 붙이지 않는다');
  }
});

test('용량 초과 문장이 화면 아래에 보여도 시계가 도는 정상 작업은 일하는 중이고 정체 판정 AI를 부르지 않는다', async () => {
  const moving = screenOf => {
    const assess = (states, screen) => assessRoles(states, new Map([[SESSION,
      {role: WORKER, alive: true, pid: 1, expectedPid: 1, screen, digest: changeDigest(screen)}]]), 60_000, 60_000, 2);
    return assess(assess(new Map(), screenOf(1)).states, screenOf(2)).states.get(SESSION).workingMoving;
  };
  // 첫 검수 재현 'active ticking': 문장을 인용한 응답 아래에서 일하는 시계가 돈다. main과 같이 일하는 중이어야 한다.
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

test('판정 함수: 상태도 원장 읽기도 없다. 살아 있고 PID가 같은 세션의 화면만 본다', () => {
  const entry = {session: SESSION, role: WORKER, taskId: 'qa-task', executionKey: KEY, by: LEAD, card: waiting};
  const seen = over => new Map([[SESSION, {role: WORKER, alive: true, pid: 1, expectedPid: 1, screen: INCIDENT, ...over}]]);
  assert.equal(assessWaitingStops.length, 2, '인자는 대기 실행 목록과 이번 순회의 관측 둘뿐이다(원장·지난 상태를 받지 않는다)');
  const [alert, ...rest] = assessWaitingStops([entry], seen());
  assert.deepEqual([rest, alert.dispatcher, alert.waitingNote, alert.line, alert.level], [[], LEAD, WAIT_NOTE, CAPACITY, 'AMBER']);
  assert.deepEqual(assessWaitingStops([entry], seen()), [alert], '같은 입력이면 같은 경보(id 포함)');
  for (const over of [{pid: 9}, {alive: false}, {screen: null}, {screen: IDLE}]) assert.deepEqual(assessWaitingStops([entry], seen(over)), [], JSON.stringify(over));
  assert.deepEqual([assessWaitingStops([entry], new Map()), assessWaitingStops([], seen()), assessWaitingStops(undefined, seen())], [[], [], []]);
  // 대기 사유는 그 대기 표시를 만든 보고 한 줄이다. 뒤에 붙은 일반 메모는 사유가 아니다(사유 없이 알린다).
  const memo = {...waiting, at: stamp(5), noteKind: 'decision', note: '감독 메모'};
  assert.equal(assessWaitingStops([{...entry, card: memo}], seen())[0].waitingNote, '');
  assert.equal(assessWaitingStops([{...entry, card: {...waiting, noteKind: 'decision'}}], seen())[0].waitingNote, '');
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
  const alertOf = () => assessWaitingStops(buildWatchScope(readers.cards.read(), entries, parents, [], {waiting: true}).waitingSessions, observed);
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
  const [alert] = assessWaitingStops([entry], new Map([[SESSION, {role: WORKER, alive: true, pid: 1, expectedPid: 1, screen: INCIDENT}]]));
  const body = formatAlertBody(alert);
  assert.match(body, new RegExp(`^대기 표시 중 오류 화면으로 멈춤 ${SESSION} / ${KEY} \\(`, 'u'));
  for (const text of [`"${WAIT_NOTE}"`, `화면: ${CAPACITY}`, '대기 표시 때문에 정체 감시 밖이었음', `발령 ${LEAD}`, '감독 확인 필요']) assert.ok(body.includes(text), text);
  const mail = itemizedAlert(alert, '15:00');
  assert.ok(mail.includes('상태: 대기 표시 중 오류 화면으로 멈춤') && mail.includes('근거: 대기 표시'), mail);
  const restored = seedAlertState([{kind: 'alert', id: alert.id, alertKind: alert.kind, level: 'AMBER', role: WORKER, session: SESSION, taskId: 'qa-task', delivered: true, recipient: BOSS}]).active[0];
  assert.equal(formatAlertBody(restored), `대기 표시 중 오류 화면으로 멈춤 ${SESSION} / qa-task (대기 표시; 대기 표시 때문에 정체 감시 밖이었음 — 감독 확인 필요)`);
});

test('받는 쪽: 감시 범위 안 작업자의 끊김 경보와 같은 경로다(직속 상위, 죽었으면 그 위). 발령한 역할은 본문에만 적는다', async () => {
  // 같은 정지 화면을 대기 중(대기중정지)과 감시 범위 안(끊김)으로 각각 돌려 받는 사람을 견준다.
  for (const [name, options, expected] of [['직속 상위가 살아 있음', {}, BOSS], ['발령한 역할이 직속 상위와 다름', {by: LEAD}, BOSS],
    ['직속 상위 창이 없음', {gone: [BOSS]}, TOP], ['발령한 역할을 모름', {seed: [...starts, {...dispatch(), by: undefined}]}, BOSS]]) {
    const held = await simulate({...options, until: 3});
    const active = await simulate({...options, seed: options.seed && [...options.seed], card: () => running, until: 3});
    assert.deepEqual(held.waitingStops.map(e => [e.recipient, e.delivered]), [[expected, true]], name);
    assert.deepEqual(active.opened.map(e => [e.alertKind, e.recipient, e.delivered]), [['끊김', expected, true]], name);
    assert.deepEqual(held.waitingStops[0].route, active.opened[0].route, `${name}: 경로 기록(근거·건너뛴 이유)까지 같다`);
    assert.deepEqual(held.stopMails.map(m => m.role), [expected], name);
  }
  const led = await simulate({by: LEAD, until: 3});
  assert.ok(led.stopMails[0].message.includes(`발령 ${LEAD}`));
  assert.deepEqual(led.attempts.filter(([, role]) => role === LEAD), [], '발령한 역할에게 따로 보내지 않는다');
});

test('받는 쪽: 전달 결과를 모르는 실패는 다시 보내지 않고, 보내기 전에 거절된 실패는 기존처럼 그 위 상위로 올라간다', async () => {
  const fail = delivery => Object.assign(new Error('전달 확인 불가'), delivery ? {delivery} : {});
  for (const delivery of ['unknown', null]) {
    const r = await simulate({until: 6, sendFail: role => role === BOSS ? fail(delivery) : null});
    assert.deepEqual(r.attempts, [[0, BOSS]], `${delivery}: 한 번 시도하고 다시 보내지 않는다(다른 역할로도 보내지 않는다)`);
    assert.deepEqual(r.waitingStops.map(e => [e.recipient, e.delivered]), [[BOSS, false]], String(delivery));
  }
  const rejected = await simulate({until: 6, sendFail: role => role === BOSS ? fail('not-sent') : null});
  assert.deepEqual(rejected.attempts, [[0, BOSS], [0, TOP]]);
  assert.deepEqual(rejected.records.filter(e => e.alertKind === '전달실패').map(e => [e.recipient, e.delivered]), [[TOP, true]]);
  // 사람이 그 창에서 입력 중이라 미룬 알림은 같은 사람에게 다음 주기에 다시 보낸다(다른 경보와 같은 규칙).
  const held = await simulate({until: 6, sendFail: (role, minute) => role === BOSS && minute < 2 ? Object.assign(fail('not-sent'), {code: 'KADAN_HUMAN_ACTIVE'}) : null});
  assert.deepEqual([held.attempts, held.stopMails.map(m => [m.minute, m.role])], [[[0, BOSS], [1, BOSS], [2, BOSS]], [[2, BOSS]]]);
});

test('운영 읽기 경로: 감시 명령이 쓰는 원장·카드 읽기(지난 주기 감시 역할만 준비)로도 대기 세션이 잡혀 직속 상위에게 간다', async () => {
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
    parents, routes: new Map(), superRole: TOP, now: () => Date.now() + cycle * 60_000,
    floor: {list: () => starts.map(s => ({session: s.session, pid: s.panePid})),
      read: session => session === SESSION ? wrap(INCIDENT, 55) : `• 맡긴 재판정 결과를 기다립니다. ${cycle}분\n\n${COMPOSER}`, alive: () => true},
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
  assert.deepEqual(alerts.map(e => [e.recipient, e.delivered, e.taskId, Boolean(e.resolved)]), [[BOSS, true, made.id, false]], '4주기 동안 직속 상위에게 한 번');
  const mails = sent.filter(m => /대기 표시 중/u.test(m.message));
  assert.deepEqual(mails.map(m => m.role), [BOSS]);
  for (const text of [made.key, WAIT_NOTE, CAPACITY, `발령 ${LEAD}`]) assert.ok(mails[0].message.includes(text), text);
  assert.deepEqual([keys, aiCalls.filter(([, role]) => role === WORKER)], [[], []]);
});
