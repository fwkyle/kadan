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
const NO_RESET_LINE = '⚠ Individual quota reached. Please upgrade your subscription to increase your limits.';
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

// ---- 수정 2 카드의 기대 결과 표(고정 규칙) 줄별 시험. 음성 화면은 모두 "그 줄만 빼면 한도"인 양성 대조군 위에 만든다. ----
const NO_ID_SCREEN = REAL_AGY_SCREEN.replace(`${ERROR_ID}\n`, '');
const mailNotice = preview => unreadMailMessage(
  [{role: 'qa-worker', by: 'qa-boss', mailId: 'm1', t: '2026-11-24T04:30:00Z', preview}], 'qa-worker');
const assertNotQuota = (name, screen) => {
  assert.equal(agyQuotaLine(screen), null, `${name}: agyQuotaLine`);
  assert.equal(screenDisconnects(screen).size, 0, `${name}: screenDisconnects`);
  assert.equal(waitingStopScreen(screen), null, `${name}: waitingStopScreen`);
};

test('표 1 — 실측 화면 두 꼴(1h15m59s. + Error ID, 3h9m58s + Error ID): 한도 + 대략 시각', () => {
  const now = new Date(2026, 10, 24, 13, 30, 0).getTime();
  const second = QUOTA_LINE.replace('1h15m59s.', '3h9m58s');
  for (const [line, seconds] of [[QUOTA_LINE, 4_559], [second, 11_398]]) {
    const screen = REAL_AGY_SCREEN.replace(QUOTA_LINE, line);
    assert.equal(agyQuotaLine(screen), line);
    const [found] = [...screenDisconnects(screen).values()];
    assert.equal(disconnectKind(found), '한도');
    assert.equal(parseResetInMs(found), seconds * 1_000);
    const clock = clockTime(Math.round((now + seconds * 1_000) / 60_000) * 60_000);
    assert.ok(formatAlertBody({kind: '한도', session: 'kadan-qa-worker', line: found}, now)
      .includes(`풀리는 시각(대략) ${clock} `), line);
  }
});

test('표 2 — Error ID 줄 없음(NBSP 입력창·우편 안내 끼임 포함): 한도 + 대략 시각, 같은 경보 키', () => {
  const nbspPrompt = REAL_AGY_SCREEN.replace('\n>\n', '\n>\u00a0\n');
  const withMail = REAL_AGY_SCREEN.replace(`\n\n${AGY_COMPOSER}`, `\n\n${mailNotice('다른 안내')}\n\n${AGY_COMPOSER}`);
  const baseKey = [...screenDisconnects(REAL_AGY_SCREEN).keys()];
  for (const [name, screen] of [['Error ID 없음', NO_ID_SCREEN], ['NBSP 입력창', nbspPrompt], ['우편 안내 끼임', withMail]]) {
    const found = screenDisconnects(screen);
    assert.deepEqual([...found.values()], [QUOTA_LINE], name);
    assert.deepEqual([...found.keys()], baseKey, `${name}: 같은 경보 키`);
    assert.equal(parseResetInMs([...found.values()][0]), 4_559_000, name);
  }
  // 남은 시간 숫자만 달라도 같은 키(중복 경보 없음).
  const later = REAL_AGY_SCREEN.replace('1h15m59s', '1h14m00s');
  assert.deepEqual([...screenDisconnects(later).keys()], baseKey);
});

test('표 3 — 한도 줄과 입력 상자 사이에 다른 줄이 하나라도 있으면 한도가 아니다', () => {
  // 대조군: 끼운 줄을 빼면 둘 다 한도다.
  assert.equal(agyQuotaLine(REAL_AGY_SCREEN), QUOTA_LINE);
  assert.equal(agyQuotaLine(NO_ID_SCREEN), QUOTA_LINE);
  const extras = ['10s.', 'Recovered', 'done', '● Ran (npm test)', 'Please wait while I continue.', 'Resets done.',
    'Upgrade finished.', '완료했습니다.', '  작업을 이어갑니다.', '⣟  Generating...', '313', '  313', '42', 'cafe', '-', '—',
    ERROR_ID, 'Error ID: 00000000-0000-0000-0000-000000000000-313 Recovered', 'Error ID: bad_id'];
  for (const extra of extras) {
    assertNotQuota(`Error ID 바로 뒤 [${extra}]`, REAL_AGY_SCREEN.replace(ERROR_ID, `${ERROR_ID}\n${extra}`));
    assertNotQuota(`Error ID 뒤 빈 줄 건너 [${extra}]`, REAL_AGY_SCREEN.replace(ERROR_ID, `${ERROR_ID}\n\n${extra}`));
    if (extra === ERROR_ID) continue; // Error ID 없는 화면에 Error ID 한 줄을 넣으면 실측 꼴이다
    assertNotQuota(`한도 줄 바로 뒤 [${extra}]`, NO_ID_SCREEN.replace(QUOTA_LINE, `${QUOTA_LINE}\n${extra}`));
    assertNotQuota(`한도 줄과 Error ID 사이 [${extra}]`, REAL_AGY_SCREEN.replace(QUOTA_LINE, `${QUOTA_LINE}\n${extra}`));
  }
  // 재검수 재현 그대로: Error ID 없는 화면에서 끝난 해제 문장 뒤 별도 줄 10s.
  assertNotQuota('재검수 10s.', NO_ID_SCREEN.replace('Resets in 1h15m59s.', 'Resets in 1h15m59s.\n10s.'));
  const negatives = {
    after_response: REAL_AGY_SCREEN.replace(`\n\n${AGY_COMPOSER}`, `\n\n> 계속해 줘\n\n  작업을 이어갑니다.\n\n${AGY_COMPOSER}`),
    after_tool: REAL_AGY_SCREEN.replace(`\n\n${AGY_COMPOSER}`, `\n\n○ Thought for 2s\n● Ran (npm test)\n\n${AGY_COMPOSER}`),
    after_footer_tool: `${REAL_AGY_SCREEN}\n● Ran (npm test)\n`,
    after_footer_prose: `${REAL_AGY_SCREEN}\n  작업을 이어갑니다.\n`,
    footer_replaced_with_tool: REAL_AGY_SCREEN.replace(FOOTER, '● Ran (npm test)'),
    footer_replaced_with_word: REAL_AGY_SCREEN.replace(FOOTER, 'Recovered'),
    footer_prompt: `${REAL_AGY_SCREEN}\n> 이어서 입력`,
    working_footer: REAL_AGY_SCREEN.replace('? for shortcuts', 'esc to cancel'),
    working_spinner: REAL_AGY_SCREEN.replace(`\n\n${AGY_COMPOSER}`, `\n\n⣟  Generating...\n${AGY_COMPOSER}`),
    typing: REAL_AGY_SCREEN.replace('\n>\n', '\n> 계속 진행해 줘\n'),
    indented_reply: REAL_AGY_SCREEN.replace(QUOTA_LINE, `  ${QUOTA_LINE}`),
    blockquote: REAL_AGY_SCREEN.replace(QUOTA_LINE, `  > ${QUOTA_LINE}`),
    intro_colon: `  화면에 아래처럼 뜹니다:\n\n${QUOTA_LINE}\n\n${AGY_COMPOSER}`,
    fenced: `  예시:\n\`\`\`text\n${QUOTA_LINE}\n\`\`\`\n\n${AGY_COMPOSER}`,
    mail_preview: `● Ran (cmd)\n\n${mailNotice(QUOTA_LINE)}\n\n${AGY_COMPOSER}`,
    codex_screen: `${QUOTA_LINE}\n\n${CODEX_COMPOSER}`,
    claude_screen: `${QUOTA_LINE}\n\n${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  ~/Dev/demo[main]`,
    no_composer: `${QUOTA_LINE}\n${ERROR_ID}`,
  };
  for (const [name, screen] of Object.entries(negatives)) assertNotQuota(name, screen);
});

test('표 4 — 한도 줄이 두 줄로 접힌 화면은 한도가 아니다(정체 경로)', () => {
  const narrow = (rows, width) => [
    '● Ran (cmd) (ctrl+o to expand)', '', ...rows, '',
    '─'.repeat(width), '>', '─'.repeat(width), '? for shortcuts   Gemini 4 Neon',
  ].join('\n');
  // 대조군: 같은 틀에 한 줄 한도 문장이면 한도다.
  assert.equal(agyQuotaLine(narrow([QUOTA_LINE, ERROR_ID], 80)), QUOTA_LINE);
  const wrapped = {
    wrap_80: narrow(['⚠ Individual quota reached. Please upgrade your subscription to increase your',
      'limits. Resets in 1h15m59s.', ERROR_ID], 80),
    wrap_55: narrow(['⚠ Individual quota reached. Please upgrade your',
      'subscription to increase your limits. Resets in', '1h15m59s.', ERROR_ID], 55),
    wrap_inside_duration: NO_ID_SCREEN.replace('Resets in 1h15m59s.', 'Resets in 1h 15m\n59s.'),
    error_id_wrap_mid_uuid: REAL_AGY_SCREEN.replace(ERROR_ID, 'Error ID: 159c71e6-9291-4cac-a07f-ed7912\na7e8b5-313'),
    error_id_wrap_suffix: REAL_AGY_SCREEN.replace(ERROR_ID, `${ERROR_ID.slice(0, -3)}\n${ERROR_ID.slice(-3)}`),
  };
  for (const [name, screen] of Object.entries(wrapped)) assertNotQuota(name, screen);
});

test('고정 규칙 밖 꼴 — Resets in으로 끝나지 않는 줄·가로줄 없는 단독 > 는 한도가 아니다', () => {
  const outside = {
    no_resets_clause: REAL_AGY_SCREEN.replace(QUOTA_LINE, NO_RESET_LINE),
    no_resets_clause_no_id: NO_ID_SCREEN.replace(QUOTA_LINE, NO_RESET_LINE),
    resets_without_value: REAL_AGY_SCREEN.replace(' 1h15m59s.', ''),
    bare_prompt: `${QUOTA_LINE}\n${ERROR_ID}\n\n>\n`,
    bare_prompt_with_footer: `${QUOTA_LINE}\n${ERROR_ID}\n\n>\n${FOOTER}`,
    rule_only_above_prompt: `${QUOTA_LINE}\n${ERROR_ID}\n\n${RULE}\n>\n${FOOTER}`,
  };
  for (const [name, screen] of Object.entries(outside)) assertNotQuota(name, screen);
  // 가운데 문장은 따지지 않는다: 한 줄이고 끝이 Resets in <값>이면 한도다.
  const other = '⚠ Individual quota reached. Your plan limit was hit. Resets in 45m.';
  assert.equal(agyQuotaLine(REAL_AGY_SCREEN.replace(QUOTA_LINE, other)), other);
  const short = '⚠ Individual quota reached. Resets in 45m.';
  assert.equal(agyQuotaLine(REAL_AGY_SCREEN.replace(QUOTA_LINE, short)), short);
});

test('표 5 — Resets in 1d.·20m:garbage.: 한도로 읽되 시각은 붙이지 않는다', () => {
  const now = new Date(2026, 10, 24, 13, 30, 0).getTime();
  for (const value of ['1d.', '20m:garbage.']) {
    const line = QUOTA_LINE.replace('1h15m59s.', value);
    for (const base of [REAL_AGY_SCREEN, NO_ID_SCREEN]) {
      const screen = base.replace(QUOTA_LINE, line);
      assert.equal(agyQuotaLine(screen), line, value);
      assert.deepEqual([...screenDisconnects(screen).values()], [line], value);
    }
    assert.equal(parseResetInMs(line), null, value);
    assert.equal(resetAtNote(line, now), null, value);
    assert.equal(formatAlertBody({kind: '한도', session: 'kadan-qa-worker', line}, now), `한도 kadan-qa-worker (${line})`);
  }
});

test('Resets in 상대 시간 파싱과 대략 풀리는 시각 문구(읽은 시각 기준·부정확 가능 명시, 못 읽으면 문구만)', () => {
  assert.equal(parseResetInMs(QUOTA_LINE), (1 * 3600 + 15 * 60 + 59) * 1000);
  assert.equal(parseResetInMs('⚠ Individual quota reached. Resets in 45m.'), 45 * 60_000);
  assert.equal(parseResetInMs('⚠ Individual quota reached. Resets in 2h 5m 10s.'), (2 * 3600 + 5 * 60 + 10) * 1000);
  assert.equal(parseResetInMs('⚠ Individual quota reached. Resets in 3h9m58s'), (3 * 3600 + 9 * 60 + 58) * 1000);
  assert.equal(parseResetInMs('⚠ Individual quota reached. Resets in 30s'), 30_000);
  for (const bad of [
    // 일(d) 단위는 받지 않는다(h·m·s 조합만).
    '⚠ Individual quota reached. Resets in 1d.',
    '⚠ Individual quota reached. Resets in 1d2h3m4s.',
    '⚠ Individual quota reached. Please upgrade your subscription.',
    '⚠ Individual quota reached. Resets in 0s.',
    '⚠ Individual quota reached. Resets in soon.',
    '⚠ Individual quota reached. Resets in 1h 5x.',
    '⚠ Individual quota reached. Resets in 1h15m59ms.',
    '⚠ Individual quota reached. Resets in 1000d.',
    // F2 검수 재현: 잘못된 남은 시간 뒤 찌꺼기·구분자·추가 문장은 앞부분을 잘라 쓰지 않고 null.
    '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 20m:garbage.',
    '⚠ Individual quota reached. Resets in 20m,garbage.',
    '⚠ Individual quota reached. Resets in 20m;garbage.',
    '⚠ Individual quota reached. Resets in 20m!garbage.',
    '⚠ Individual quota reached. Resets in 20m..',
    '⚠ Individual quota reached. Resets in 20m. extra.',
    '⚠ Individual quota reached. Resets in 20 m.',
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

test('감시기(표 3·4): 사이에 다른 줄이 있거나 접힌 한도 화면은 한도 경보 0건, 교대 명령도 안 나간다', async () => {
  const screens = {
    'Error ID 뒤 Recovered': REAL_AGY_SCREEN.replace(ERROR_ID, ERROR_ID + '\nRecovered'),
    '바닥글 뒤 ● Ran': REAL_AGY_SCREEN + '\n● Ran (npm test)\n',
    '재검수 10s.': NO_ID_SCREEN.replace('Resets in 1h15m59s.', 'Resets in 1h15m59s.\n10s.'),
    '두 줄로 접힌 시간': NO_ID_SCREEN.replace('Resets in 1h15m59s.', 'Resets in 1h 15m\n59s.'),
  };
  for (const [name, screen] of Object.entries(screens)) {
    const r = await runAgyWatch({screenAt: () => screen, stopAt: 4});
    const limitAlerts = r.records.filter(e => e.kind === 'alert' && ['한도', '대기중정지'].includes(e.alertKind));
    assert.deepEqual(limitAlerts, [], name + ': 한도 경보 0건');
    assert.equal(r.sent.some(([, , m]) => /한도|대체 후보/.test(m)), false, name + ': 교대 명령 안 나감');
  }
});

test('감시기(표 5): Resets in 20m:garbage.·1d.는 한도 경보 1건만 내고 풀리는 시각은 붙이지 않는다', async () => {
  for (const value of ['20m:garbage.', '1d.']) {
    const r = await runAgyWatch({screenAt: () => REAL_AGY_SCREEN.replace('1h15m59s.', value), stopAt: 4});
    const msgs = r.sent.filter(([, , m]) => /한도/.test(m) && !/해소/.test(m));
    assert.equal(msgs.length, 1, value + ': 한도 경보는 1건');
    assert.ok(msgs[0][2].includes('Resets in ' + value), msgs[0][2]);
    assert.ok(!msgs[0][2].includes('풀리는 시각'), value + ': 시각을 붙이면 안 됨: ' + msgs[0][2]);
    assert.match(msgs[0][2], /대체 후보 1번 있음/);
  }
});
