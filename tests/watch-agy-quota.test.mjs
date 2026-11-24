// agy "Individual quota reached" 화면 한도 정지 판정·해제 시각 안내·회귀 시험 (kadan/work-agy-quota-detect).
// 가짜 시계·가짜 바닥·가짜 전송기만 쓴다. 운영 역할 이름·개인 경로는 넣지 않는다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runWatch} from '../src/watch-runner.mjs';
import {assessRoles, screenDisconnects, disconnectKind} from '../src/watch.mjs';
import {changeDigest} from '../src/watch-roles.mjs';
import {
  STOP_PHRASES, SUPERVISOR_ERROR_PATTERN, agyQuotaLine, anyStopWordInBottom,
  parseResetInMs, phraseOfLine,
} from '../src/watch-stop-phrases.mjs';
import {RateLimitRetry, terminal429} from '../src/watch-rate-limit.mjs';
import {assessWaitingStops, waitingStopScreen} from '../src/watch-waiting-stop.mjs';
import {clockTime, formatAlertBody, itemizedAlert, resetAtNote} from '../src/watch-alert-body.mjs';
import {unreadMailMessage} from '../src/watch-notice-format.mjs';
import {codexBasis} from '../src/ocx-refresh.mjs';
import {ledgerHome} from '../src/ledger.mjs';
import {settingsPath} from '../src/runner-settings.mjs';

const RULE = '─'.repeat(152);
const FOOTER = '? for shortcuts                                                                                                                     Gemini 4 Neon · high';
const QUOTA_LINE = '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h15m59s.';
const ERROR_ID = 'Error ID: 00000000-0000-0000-0000-000000000000-313';
const AGY_COMPOSER = `${RULE}\n>\n${RULE}\n${FOOTER}`;

// 2026-11-24 실측 agy 한도 화면 구조(경로·역할·ID만 가짜 값으로 바꾼 고정본).
const REAL_AGY_SCREEN = [
  '  우편 ID: 00000000-0000-0000-0000-000000000001. 내용을 확인한 수신자가 직접 읽음 확인을 기록하라.',
  '  KADAN_ROLE=\'qa-worker\' kadan inbox ack \'00000000-0000-0000-0000-000000000001\' --role \'qa-worker\'',
  '',
  '○ Thought for 14.9s (The new flag disables permission checks, enabling uninterrupted command execution.)',
  '● Ran (KADAN_ROLE=qa-worker node src/cli.mjs inbox ack 00000000-0000-0000-0000-000000000001 --role qa-worker) (ctrl+o to expand)',
  '',
  QUOTA_LINE,
  ERROR_ID,
  '',
  AGY_COMPOSER,
].join('\n');

const claudeFixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/claude-limit-screens.json', import.meta.url), 'utf8'));
const CODEX_COMPOSER = '› Ask Codex to do anything';
const CODEX_LIMIT = "■ You've hit your usage limit. Try again at Nov 20th, 2026 3:00 PM.";
const CODEX_SCREEN = `• Ran npm test\n  └ ok 12 tests\n\n${CODEX_LIMIT}\n\n${CODEX_COMPOSER}\n\n  gpt-6.1-sol high · ~/Dev/demo · Context 20% used`;

test('실측 agy 한도 화면 고정본: 한도 정지(usage-limit, report)로 잡히고 429 자동 재개 대상이 아니다', () => {
  assert.equal(agyQuotaLine(REAL_AGY_SCREEN), QUOTA_LINE);
  const found = screenDisconnects(REAL_AGY_SCREEN);
  assert.equal(found.size, 1);
  const [line] = [...found.values()];
  assert.equal(line, QUOTA_LINE);
  assert.equal(disconnectKind(line), '한도');
  const phrase = phraseOfLine(line);
  assert.deepEqual({id: phrase.id, kind: phrase.kind, action: phrase.action, scope: phrase.scope},
    {id: 'usage-limit', kind: '한도', action: 'report', scope: ['worker']});
  assert.equal(STOP_PHRASES.find(p => p.id === 'rate-limit-429').action, 'auto-resume');
  assert.equal(terminal429(REAL_AGY_SCREEN, Date.now()), null, '최종 429 자동 재개 대상 아님');
  assert.equal(anyStopWordInBottom(REAL_AGY_SCREEN), true, '화면 아래 12줄 한도 문구로 일하는 중 오판 방지');
  // 앞선 429 뒤에 agy 한도 줄이 있으면 재개하지 않고(null), 429 본문 안 상세 줄에 섞이면 명시 한도(blocked)다.
  const old429 = '■ Exceeded retry limit, last status: 429 Too Many Requests';
  assert.equal(terminal429(`${old429}\n\n› x\n\n${QUOTA_LINE}\n\n${CODEX_COMPOSER}`, Date.now()), null);
  assert.equal(terminal429(`${old429}\n${QUOTA_LINE}\n\n${CODEX_COMPOSER}`, Date.now()), null);
  assert.equal(terminal429(`${old429}\n  detail: Individual quota reached\n\n${CODEX_COMPOSER}`, Date.now())?.blocked, true);
  // RateLimitRetry도 재개 예약·전송을 만들지 않는다.
  const entries = [], sent = [];
  const retry = new RateLimitRetry({record: e => entries.push(e), resume: r => sent.push(r)});
  const obs = new Map([['kadan-qa-worker', {role: 'qa-worker', alive: true, pid: 1, expectedPid: 1, startedAt: 1, screen: REAL_AGY_SCREEN}]]);
  const t0 = Date.parse('2026-11-24T04:30:00Z');
  for (const now of [t0, t0 + 60_000]) retry.tick({observations: obs, tasks: [{role: 'qa-worker', taskId: 't1'}], entries, now, fresh: () => true});
  assert.deepEqual([entries, sent], [[], []]);
});

test('좁은 창 줄 바꿈·Error ID 없음·NBSP·우편 안내 블록 끼임에서도 같은 한도 줄과 키로 잡는다', () => {
  const narrow80 = [
    '● Ran (cmd) (ctrl+o to expand)', '',
    '⚠ Individual quota reached. Please upgrade your subscription to increase your',
    'limits. Resets in 1h15m59s.',
    ERROR_ID, '', '─'.repeat(80), '>', '─'.repeat(80), '? for shortcuts   Gemini 4 Neon · high',
  ].join('\n');
  const narrow55 = [
    '● Ran (cmd) (ctrl+o to expand)', '',
    '⚠ Individual quota reached. Please upgrade your',
    'subscription to increase your limits. Resets in',
    '1h15m59s.',
    'Error ID: 00000000-0000-0000-0000-000000000000-',
    '313', '', '─'.repeat(55), '>', '─'.repeat(55), '? for shortcuts   Gemini 4 Neon',
  ].join('\n');
  const noErrorId = `${QUOTA_LINE}\n\n${AGY_COMPOSER}`;
  const nbspPrompt = REAL_AGY_SCREEN.replace('\n>\n', '\n>\u00a0\n');
  const notice = unreadMailMessage([{role: 'qa-worker', by: 'qa-boss', mailId: 'm1', t: '2026-11-24T04:30:00Z', preview: '다른 안내'}], 'qa-worker');
  const withMail = REAL_AGY_SCREEN.replace(`\n\n${AGY_COMPOSER}`, `\n\n${notice}\n\n${AGY_COMPOSER}`);
  const barePrompt = `${QUOTA_LINE}\n${ERROR_ID}\n\n>\n`;
  const baseKey = [...screenDisconnects(REAL_AGY_SCREEN).keys()];
  for (const [name, screen] of [['80칸', narrow80], ['55칸', narrow55], ['Error ID 없음', noErrorId],
    ['NBSP 입력창', nbspPrompt], ['우편 안내 끼임', withMail], ['가로줄 없는 단독 >', barePrompt]]) {
    const found = screenDisconnects(screen);
    assert.deepEqual([...found.values()], [QUOTA_LINE], name);
    assert.deepEqual([...found.keys()], baseKey, `${name}: 창 너비·꾸밈이 달라도 같은 경보 키`);
  }
  // 남은 시간 숫자만 달라도 같은 키(중복 경보 없음).
  const later = REAL_AGY_SCREEN.replace('1h15m59s', '1h14m00s');
  assert.deepEqual([...screenDisconnects(later).keys()], baseKey);
});

test('한도 줄 뒤에 새 출력이 이어진 화면·일하는 중·입력 중·인용·울타리·타 실행기는 한도가 아니다', () => {
  const notice = unreadMailMessage([{role: 'qa-worker', by: 'qa-boss', mailId: 'm1', t: '2026-11-24T04:30:00Z', preview: QUOTA_LINE}], 'qa-worker');
  const negatives = {
    after_response: `${QUOTA_LINE}\n${ERROR_ID}\n\n> 계속해 줘\n\n  작업을 이어갑니다.\n\n${AGY_COMPOSER}`,
    after_tool: `${QUOTA_LINE}\n${ERROR_ID}\n\n○ Thought for 2s\n● Ran (npm test)\n\n${AGY_COMPOSER}`,
    after_error_id_tight_tool: `${QUOTA_LINE}\n${ERROR_ID}\n● 계속 진행했습니다.\n\n${AGY_COMPOSER}`,
    after_error_id_tight_word: `${QUOTA_LINE}\n${ERROR_ID}\n완료했습니다.\n\n${AGY_COMPOSER}`,
    after_quota_tight_prose: `${QUOTA_LINE}\n다시 시도해 완료했습니다.\n\n${AGY_COMPOSER}`,
    working_footer: REAL_AGY_SCREEN.replace('? for shortcuts', 'esc to cancel'),
    working_spinner: REAL_AGY_SCREEN.replace(`\n\n${AGY_COMPOSER}`, `\n\n⣟  Generating...\n${AGY_COMPOSER}`),
    typing: REAL_AGY_SCREEN.replace('\n>\n', '\n> 계속 진행해 줘\n'),
    indented_reply: `  ${QUOTA_LINE}\n\n${AGY_COMPOSER}`,
    blockquote: `  > ${QUOTA_LINE}\n\n${AGY_COMPOSER}`,
    intro_colon: `  화면에 아래처럼 뜹니다:\n\n${QUOTA_LINE}\n\n${AGY_COMPOSER}`,
    fenced: `  예시:\n\`\`\`text\n${QUOTA_LINE}\n\`\`\`\n\n${AGY_COMPOSER}`,
    mail_preview: `● Ran (cmd)\n\n${notice}\n\n${AGY_COMPOSER}`,
    codex_screen: `${QUOTA_LINE}\n\n${CODEX_COMPOSER}`,
    claude_screen: `${QUOTA_LINE}\n\n${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  ~/Dev/demo[main]`,
    footer_prompt: `${REAL_AGY_SCREEN}\n> 이어서 입력`,
    no_composer: `${QUOTA_LINE}\n${ERROR_ID}`,
  };
  for (const [name, screen] of Object.entries(negatives)) {
    assert.equal(agyQuotaLine(screen), null, `${name}: agyQuotaLine`);
    assert.equal(screenDisconnects(screen).size, 0, `${name}: screenDisconnects`);
    assert.equal(waitingStopScreen(screen), null, `${name}: waitingStopScreen`);
  }
});

test('Resets in 상대 시간 파싱과 대략 풀리는 시각 문구(읽은 시각 기준·부정확 가능 명시, 못 읽으면 문구만)', () => {
  assert.equal(parseResetInMs(QUOTA_LINE), (1 * 3600 + 15 * 60 + 59) * 1000);
  assert.equal(parseResetInMs('⚠ Individual quota reached. Resets in 45m.'), 45 * 60_000);
  assert.equal(parseResetInMs('⚠ Individual quota reached. Resets in 2h 5m 10s.'), (2 * 3600 + 5 * 60 + 10) * 1000);
  assert.equal(parseResetInMs('⚠ Individual quota reached. Resets in 1d2h3m4s.'), (86400 + 7200 + 180 + 4) * 1000);
  assert.equal(parseResetInMs('⚠ Individual quota reached. Resets in 30s'), 30_000);
  for (const bad of [
    '⚠ Individual quota reached. Please upgrade your subscription.',
    '⚠ Individual quota reached. Resets in 0s.',
    '⚠ Individual quota reached. Resets in soon.',
    '⚠ Individual quota reached. Resets in 1h 5x.',
    '⚠ Individual quota reached. Resets in 1h15m59ms.',
    '⚠ Individual quota reached. Resets in 1000d.',
    "You've hit your session limit · resets 3pm (Asia/Seoul)",
    CODEX_LIMIT,
  ]) assert.equal(parseResetInMs(bad), null, bad);

  // 같은 날: HH:MM
  const baseSameDay = new Date(2026, 10, 24, 13, 30, 0).getTime();
  const expectedSameDay = clockTime(Math.round((baseSameDay + 4_559_000) / 60_000) * 60_000);
  const noteSame = resetAtNote(QUOTA_LINE, baseSameDay);
  assert.equal(noteSame, `풀리는 시각(대략) ${expectedSameDay} (화면을 읽은 시각 기준 계산·부정확할 수 있음)`);

  // 자정 넘김: M/D HH:MM
  const baseMidnight = new Date(2026, 10, 24, 23, 30, 0).getTime();
  const targetMidnight = new Date(Math.round((baseMidnight + 4_559_000) / 60_000) * 60_000);
  const expectedMidnight = `${targetMidnight.getMonth() + 1}/${targetMidnight.getDate()} ${clockTime(targetMidnight)}`;
  assert.equal(resetAtNote(QUOTA_LINE, baseMidnight),
    `풀리는 시각(대략) ${expectedMidnight} (화면을 읽은 시각 기준 계산·부정확할 수 있음)`);

  // 경보 본문: 읽을 수 있으면 풀리는 시각 붙고, 못 읽거나 기준 시각 없으면 문구만.
  const body = formatAlertBody({kind: '한도', session: 'kadan-qa-worker', line: QUOTA_LINE}, baseSameDay);
  assert.equal(body, `한도 kadan-qa-worker (${QUOTA_LINE}) · ${noteSame}`);
  const noTimeLine = '⚠ Individual quota reached. Please upgrade your subscription to increase your limits.';
  assert.equal(formatAlertBody({kind: '한도', session: 'kadan-qa-worker', line: noTimeLine}, baseSameDay),
    `한도 kadan-qa-worker (${noTimeLine})`);
  assert.equal(formatAlertBody({kind: '한도', session: 'kadan-qa-worker', line: QUOTA_LINE}),
    `한도 kadan-qa-worker (${QUOTA_LINE})`, '기준 시각 없으면 시각을 지어내지 않고 문구만');
  // usage-limit이 아닌 끊김 경보에는 붙지 않는다.
  assert.equal(formatAlertBody({kind: '끊김', session: 'kadan-qa-worker', line: '■ stream error. Resets in 5m.'}, baseSameDay),
    '끊김 kadan-qa-worker (■ stream error. Resets in 5m.)');
});

test('기존 claude·codex 한도 화면 판정은 그대로다(해제 시각 계산 문구 안 붙음)', () => {
  const now = new Date(2026, 10, 24, 13, 30, 0).getTime();
  for (const [name, screen] of [['claude', claudeFixtures['pos-plain']], ['codex', CODEX_SCREEN]]) {
    const found = screenDisconnects(screen);
    assert.equal(found.size, 1, name);
    const [line] = [...found.values()];
    assert.equal(disconnectKind(line), '한도', name);
    assert.equal(resetAtNote(line, now), null, `${name}: 상대 Resets in 아님`);
    assert.equal(formatAlertBody({kind: '한도', session: 'kadan-qa-worker', line}, now), `한도 kadan-qa-worker (${line})`, name);
  }
  assert.ok(terminal429(`■ Exceeded retry limit, last status: 429 Too Many Requests\n\n${CODEX_COMPOSER}`, now));
});

test('감독 관찰 경로(SUPERVISOR_ERROR_PATTERN): usage-limit은 작업자 범위라 감독 오류 패턴에 들지 않는다', () => {
  // claude·codex usage-limit과 같은 규칙: 감독이 작업자 한도 경보 우편을 화면에 띄워도 오탐하지 않도록 작업자 범위만 둔다.
  assert.equal(SUPERVISOR_ERROR_PATTERN.test(REAL_AGY_SCREEN.split('\n').slice(-20).join('\n')), false);
});

// ---- 감시기 전체 경로: agy 작업자·검수자 즉시 경보 + 해제 시각 + 교대 명령 + 대기중정지 + ocx 없음 ----
const epoch = new Date(2026, 10, 24, 13, 30, 0).getTime();
const stamp = m => new Date(epoch + m * 60_000).toISOString();
const SETTINGS = {
  version: 1, revision: 5, activePreset: 'main',
  runners: {
    agy: {spawn: 'agy --model {model}'},
    claude: {spawn: 'claude --model {model} --effort {effort}'},
    codex: {spawn: 'codex --model {model}'},
  },
  presets: {
    main: {
      roles: {
        worker: {runner: 'agy', model: 'google/gemini-4-neon'},
        reviewer: {runner: 'agy', model: 'google/gemini-4-neon'},
      },
      fallback: {
        worker: [{runner: 'claude', model: 'claude-sonnet-5-5', effort: 'high'}],
        reviewer: [{runner: 'codex', model: 'gpt-6-astra'}, {runner: 'claude', model: 'claude-sonnet-5-5', effort: 'high'}],
      },
    },
  },
};

async function runAgyWatch({screenAt, profile = 'worker', activity = 'running', reviewFor = null, stopAt = 5}) {
  fs.writeFileSync(settingsPath(ledgerHome()), JSON.stringify(SETTINGS));
  const role = profile === 'reviewer' ? 'qa-검수자' : 'qa-작업자';
  const session = `kadan-${role}`;
  const parents = new Map([[role, 'qa-감독'], ['qa-감독', '@user']]);
  const starts = [
    {
      kind: 'start', role, session, harness: 'agy', model: 'google/gemini-4-neon', panePid: 1,
      cmd: 'agy --model google/gemini-4-neon', roleProfile: profile,
      ...(reviewFor ? {reviewFor} : {}), t: stamp(0),
    },
    {kind: 'start', role: 'qa-감독', session: 'kadan-qa-감독', panePid: 99, t: stamp(0)},
  ];
  const card = {
    id: 't-agy', key: 'qa/t-agy', role, board: 'qa', status: 'assigned', activity,
    activityRole: role, activityAt: stamp(0), at: stamp(0), workType: 'execution',
    ...(activity === 'waiting' ? {noteKind: 'progress', note: '결과 대기'} : {}),
  };
  const entries = [...starts, {kind: 'send', role, session, taskId: 't-agy', executionKey: 'qa/t-agy', by: 'qa-감독', t: stamp(0)}];
  const records = [], sent = [], resumes = [];
  let minute = 0, reads = 0;
  const controller = new AbortController();
  await runWatch({
    signal: controller.signal, intervalMs: 60_000, stallN: 2, stallAfterMs: 300_000,
    parents, routes: new Map(), superRole: 'qa-감독',
    now: () => epoch + minute * 60_000,
    floor: {
      list: () => starts.map(s => ({session: s.session, pid: s.panePid})),
      read: s => (s === session ? screenAt(minute) : '감독 화면'),
      alive: () => true,
    },
    readEntries: () => { reads++; return entries; },
    resume429: (r, msg) => resumes.push([minute, r, msg]),
    readCards: () => [card], readWorks: () => [],
    sendAlert: (r, msg) => sent.push([minute, r, msg]),
    record: e => { records.push(e); entries.push({...e, t: stamp(minute)}); },
    print: () => {}, notifyLog: null, spawn: () => ({status: 0, stdout: ''}),
    sleep: async () => { if (++minute >= stopAt) controller.abort(); },
  });
  return {records, sent, resumes, reads, starts};
}

test('감시기: agy 작업자가 한도로 멈추면 즉시 경보 1건 + 대략 풀리는 시각 + 교대 명령, 자동 재개·ocx 없음', async () => {
  const working = m => `● Ran (step ${m})\n\n${AGY_COMPOSER}`;
  const r = await runAgyWatch({screenAt: m => (m >= 2 ? REAL_AGY_SCREEN : working(m))});
  const expectedClock = clockTime(Math.round((epoch + 2 * 60_000 + 4_559_000) / 60_000) * 60_000);
  const msgs = r.sent.filter(([, , m]) => /한도/.test(m) && !/해소/.test(m));
  assert.equal(msgs.length, 1);
  const [, recipient, body] = msgs[0];
  assert.equal(recipient, 'qa-감독');
  assert.ok(body.includes(QUOTA_LINE), body);
  assert.ok(body.includes(`풀리는 시각(대략) ${expectedClock} (화면을 읽은 시각 기준 계산·부정확할 수 있음)`), body);
  assert.match(body, /대체 후보 1번 있음 — .*kadan start <새 이름> --profile worker --fallback 1 --reason "한도: /);
  assert.ok(!body.includes('ocx'), 'agy는 ocx 대상이 아니다');
  assert.equal(codexBasis(r.starts, 'qa-작업자').reason, 'not-codex');
  assert.equal(r.resumes.length, 0, '자동 재개 없음');
  assert.equal(r.records.filter(e => e.kind === 'rate-limit-retry' || e.kind === 'ocx-refresh').length, 0);
  // 원장 읽기 횟수도 늘지 않는다.
  const idle = await runAgyWatch({screenAt: working});
  assert.equal(r.reads, idle.reads);
});

test('감시기: agy 검수자 한도 경보는 작업자와 다른 계열 대체 후보를 안내한다', async () => {
  const r = await runAgyWatch({
    profile: 'reviewer',
    reviewFor: {role: 'qa-작업자', model: 'gpt-6.1-sol', family: 'gpt'},
    screenAt: m => (m >= 1 ? REAL_AGY_SCREEN : `● Ran (step ${m})\n\n${AGY_COMPOSER}`),
  });
  const msgs = r.sent.filter(([, , m]) => /한도/.test(m) && !/해소/.test(m));
  assert.equal(msgs.length, 1);
  // 후보 1번(gpt)은 작업자와 같은 계열이라 건너뛰고 2번(claude) 안내.
  assert.match(msgs[0][2], /대체 후보 2번 있음 — .*--profile reviewer --fallback 2 /);
});

test('감시기: waiting 표시 중 agy 한도 화면은 대기중정지 경보 1건과 대략 풀리는 시각을 알린다', async () => {
  const r = await runAgyWatch({activity: 'waiting', screenAt: () => REAL_AGY_SCREEN, stopAt: 4});
  const stops = r.sent.filter(([, , m]) => /대기 표시 중 오류 화면으로 멈춤/.test(m));
  assert.equal(stops.length, 1);
  const expectedClock = clockTime(Math.round((epoch + 4_559_000) / 60_000) * 60_000);
  assert.ok(stops[0][2].includes(QUOTA_LINE), stops[0][2]);
  assert.ok(stops[0][2].includes(`풀리는 시각(대략) ${expectedClock} (화면을 읽은 시각 기준 계산·부정확할 수 있음)`), stops[0][2]);
  assert.equal(r.resumes.length, 0);
  // assessWaitingStops·itemizedAlert 단위 경로도 동일.
  const entry = {
    session: 'kadan-qa-작업자', role: 'qa-작업자', taskId: 't-agy', executionKey: 'qa/t-agy', by: 'qa-감독',
    card: {activity: 'waiting', activityAt: stamp(0), at: stamp(0), noteKind: 'progress', note: '결과 대기'},
  };
  const [alert] = assessWaitingStops([entry], new Map([['kadan-qa-작업자', {role: 'qa-작업자', alive: true, pid: 1, expectedPid: 1, screen: REAL_AGY_SCREEN}]]));
  assert.equal(alert.kind, '대기중정지');
  assert.equal(alert.line, QUOTA_LINE);
  assert.ok(itemizedAlert(alert, '13:30', {now: epoch}).includes(`풀리는 시각(대략) ${expectedClock}`));
});
