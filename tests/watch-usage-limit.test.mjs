// 실제 사용 한도 화면(일일·주간·세션·사용)을 감시가 '한도'로 알아보고 교대 명령 한 줄을 붙이는 경로 (kadan/work-limit-fallback PR B).
// 지켜야 할 것: 화면 끝 한도 줄만 읽음(인용·우편·도구 출력 제외), 자동 재개 대상 아님, 검수자 포함, 순회마다 원장을 새로 읽지 않음.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runWatch} from '../src/watch-runner.mjs';
import {assessRoles, screenDisconnects, disconnectKind} from '../src/watch.mjs';
import {changeDigest} from '../src/watch-roles.mjs';
import {STOP_PHRASES, WORKER_PHRASES, phraseOfLine, anyStopWordInBottom} from '../src/watch-stop-phrases.mjs';
import {terminal429} from '../src/watch-rate-limit.mjs';
import {ledgerHome} from '../src/ledger.mjs';
import {settingsPath} from '../src/runner-settings.mjs';

const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/claude-limit-screens.json', import.meta.url), 'utf8'));
const COMPOSER = '› Ask Codex to do anything';
const CODEX_LINE = "■ You've hit your usage limit. Try again at Nov 20th, 2026 3:00 PM.";
// codex 화면: 도구 출력(들여쓴 줄) 뒤 빈 줄, 오류 줄, 빈 입력창.
const codex = line => `• Ran npm test\n  └ ok 12 tests\n\n${line}\n\n${COMPOSER}\n\n  gpt-6.1-sol high · ~/Dev/kadan · Context 20% used`;

test('낱말표: usage-limit은 한도 종류·report 행동·작업자 범위이고, 기존 429 자동 재개 항목은 그대로다', () => {
  const entry = STOP_PHRASES.find(p => p.id === 'usage-limit');
  assert.deepEqual({kind: entry.kind, action: entry.action, scope: entry.scope}, {kind: '한도', action: 'report', scope: ['worker']});
  assert.ok(WORKER_PHRASES.includes(entry));
  assert.equal(STOP_PHRASES.find(p => p.id === 'rate-limit-429').action, 'auto-resume');
  assert.equal(phraseOfLine("■ You've hit your usage limit.").id, 'usage-limit');
  assert.equal(disconnectKind("⎿  You've hit your session limit · resets 3pm"), '한도');
  assert.equal(phraseOfLine('문장 중간의 You\'ve hit your usage limit 인용'), null, '줄 맨 앞이 아니면 낱말이 아니다');
});

test('실제 두 줄: claude 세션 한도 줄과 codex 사용 한도 줄(화면 끝)이 한도로 읽힌다', () => {
  for (const name of ['pos-plain', 'pos-response-symbol', 'pos-tool-symbol', 'pos-two-lines', 'pos-after-old-response', 'pos-after-turn-done',
    'real-2.1.308-bullet', 'real-2.1.308-tmux']) {
    const found = screenDisconnects(fixtures[name]);
    assert.equal(found.size, 1, name);
    assert.equal(disconnectKind([...found.values()][0]), '한도', name);
  }
  const found = screenDisconnects(codex(CODEX_LINE));
  assert.equal(found.size, 1);
  assert.equal(disconnectKind([...found.values()][0]), '한도');
  // 시계 숫자만 다른 같은 줄은 한 줄로 센다(중복 경보 없음).
  const other = screenDisconnects(codex("■ You've hit your usage limit. Try again at Nov 21st, 2026 4:00 PM."));
  assert.deepEqual([...found.keys()].map(k => k.split('|')[0]), [...other.keys()].map(k => k.split('|')[0]));
});

test('인용·우편 본문·도구 출력·설명 문장·입력 중인 글·코드 울타리 속 같은 문장은 한도가 아니다', () => {
  const negatives = {
    claude_fixtures: Object.keys(fixtures).filter(k => k.startsWith('neg-') || k.startsWith('sample-neg-')).map(k => fixtures[k]),
    mail_body: [`• 우편 도착:\n  > ${CODEX_LINE}\n\n${COMPOSER}`],
    tool_output: [`• Ran rg -n "You've hit your usage limit" src\n  └ src/senior.mjs: ${CODEX_LINE}\n\n${COMPOSER}`],
    intro_colon: [`• 화면에 이렇게 뜹니다:\n\n${CODEX_LINE}\n\n${COMPOSER}`],
    prose_mid: [`• 문구는 You've hit your usage limit 이고 자동 재개 대상이 아닙니다\n\n${COMPOSER}`],
    typed: [`${CODEX_LINE}\n\n› 이 줄을 설명해 줘`],
    fenced: [`• 예:\n\`\`\`text\n${CODEX_LINE}\n\`\`\`\n\n${COMPOSER}`],
    not_at_end: [`${CODEX_LINE}\n\n• 다시 일하는 중\n\n• Working (3s • esc to interrupt)\n\n${COMPOSER}`],
  };
  for (const [name, screens] of Object.entries(negatives))
    for (const screen of screens) assert.equal(screenDisconnects(screen).size, 0, name);
});

test('429 자동 재개 판정(terminal429)은 사용 한도 줄을 집지 않는다', () => {
  assert.equal(terminal429(codex(CODEX_LINE), Date.now()), null);
  assert.equal(terminal429(fixtures['pos-plain'], Date.now()), null);
  // 같은 모양의 429 줄은 그대로 재개 대상이다.
  assert.ok(terminal429(codex('■ Exceeded retry limit, last status: 429 Too Many Requests'), Date.now()));
});

test('사용 한도 줄이 화면 아래 12줄에 있으면 일하는 중으로 묻히지 않는다(정체 경로로 간다)', () => {
  assert.equal(anyStopWordInBottom(codex(CODEX_LINE)), true);
  assert.equal(anyStopWordInBottom(fixtures['pos-plain']), true);
});

const observe = (role, screen) => new Map([[`kadan-${role}`, {role, alive: true, pid: 1, expectedPid: 1, screen, digest: changeDigest(screen)}]]);
const alertsOf = (role, screen) => assessRoles(new Map(), observe(role, screen), 60_000, 60_000, 20).alerts;

test('작업자와 검수자 세션 모두 첫 주기에 한도 경보 1건(감시 AI·정체 시간 없이)', () => {
  for (const role of ['p-작업자', 'p-검수자']) {
    for (const screen of [codex(CODEX_LINE), fixtures['pos-plain']]) {
      const alerts = alertsOf(role, screen).filter(a => a.kind === '한도');
      assert.equal(alerts.length, 1, `${role}`);
      assert.equal(alerts[0].role, role);
      assert.match(alerts[0].line, /You.ve hit your (usage|session) limit/);
    }
  }
});

// ---- 감시기 전체 경로: 설정 파일을 읽어 경보 본문에 교대 줄이 붙고, 원장 읽기는 늘지 않는다 ----
const epoch = Date.parse('2026-11-18T00:00:00Z');
const stamp = m => new Date(epoch + m * 60_000).toISOString();
const SETTINGS = {version: 1, revision: 4, activePreset: 'main',
  runners: {claude: {spawn: 'claude --model {model} --effort {effort}'}, codex: {spawn: 'codex --model {model}'}},
  presets: {main: {roles: {worker: {runner: 'claude', model: 'claude-sonnet-5-5', effort: 'high'}},
    fallback: {worker: [{runner: 'codex', model: 'gpt-6-astra'}]}}}};
const putSettings = value => {
  if (value === null) fs.rmSync(settingsPath(ledgerHome()), {force: true});
  else fs.writeFileSync(settingsPath(ledgerHome()), JSON.stringify(value));
};

async function run({screenAt, profile = 'worker', settings = SETTINGS, stopAt = 6}) {
  putSettings(settings);
  const role = 'p-작업자';
  const parents = new Map([[role, 'p-감독'], ['p-감독', '@user']]);
  const starts = [
    {kind: 'start', role, session: `kadan-${role}`, harness: 'claude', model: 'claude-sonnet-5-5', panePid: 1,
      cmd: 'claude --model claude-sonnet-5-5 --effort high', ...(profile ? {roleProfile: profile} : {}), t: stamp(0)},
    {kind: 'start', role: 'p-감독', session: 'kadan-p-감독', panePid: 99, t: stamp(0)}];
  const cards = [{id: 't0', key: 'repo/t0', role, board: 'p', status: 'assigned', activity: 'running', workType: 'execution'}];
  const entries = [...starts, {kind: 'send', role, taskId: 't0', t: stamp(0)}];
  const records = [], sent = [], resumes = [];
  let minute = 0, reads = 0;
  const controller = new AbortController();
  await runWatch({signal: controller.signal, intervalMs: 60_000, stallN: 2, stallAfterMs: 300_000, parents, routes: new Map(), superRole: 'p-감독',
    now: () => epoch + minute * 60_000,
    floor: {list: () => starts.map(s => ({session: s.session, pid: s.panePid})), read: s => (s === `kadan-${role}` ? screenAt(minute) : '감독 화면'), alive: () => true},
    readEntries: () => { reads++; return entries; }, resume429: (r, msg) => resumes.push([minute, r]), readCards: () => cards, readWorks: () => [],
    sendAlert: (r, msg) => sent.push([minute, r, msg]), record: e => { records.push(e); entries.push({...e, t: stamp(minute)}); },
    print: () => {}, notifyLog: null, spawn: () => ({status: 0, stdout: ''}),
    sleep: async () => { if (++minute >= stopAt) controller.abort(); }});
  return {records, sent, resumes, reads};
}
const working = m => `Working... 출력 ${m}`;
const limitFrom = (at, screen) => m => (m >= at ? screen : working(m));
const limitMsgs = sent => sent.filter(([, , m]) => /한도/.test(m) && !/해소/.test(m));

test('감시기: claude 작업자가 한도로 멈추면 경보 1건에 교대 명령 한 줄(설정을 읽어 폴백 1번)', async () => {
  const r = await run({screenAt: limitFrom(2, fixtures['pos-plain'])});
  const msgs = limitMsgs(r.sent);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0][2], /한도 kadan-p-작업자 \(You've hit your session limit · resets 3pm \(Asia\/Seoul\)\) · 대체 후보 1번 있음 — 옛 세션 정리 뒤 kadan start <새 이름> --profile worker --fallback 1 --reason "한도: /);
  assert.equal(r.resumes.length, 0, '자동 재개 없음');
  assert.equal(r.records.filter(e => e.kind === 'rate-limit-retry').length, 0, '재개 예약 기록 없음');
  assert.equal(r.records.filter(e => ['start', 'stop'].includes(e.kind)).length, 0, '감시기는 세션을 띄우거나 끄지 않는다');
});

test('감시기: 설정 파일이 없거나 후보가 없으면 경보는 그대로이고 교대 줄만 빠진다', async () => {
  for (const settings of [null, {...SETTINGS, presets: {main: {...SETTINGS.presets.main, fallback: {}}}}]) {
    const msgs = limitMsgs((await run({screenAt: limitFrom(2, fixtures['pos-plain']), settings})).sent);
    assert.equal(msgs.length, 1);
    assert.ok(!msgs[0][2].includes('대체 후보'));
  }
});

test('감시기: 감독 프로필 세션·프로필 기록 없는 세션에는 교대 줄이 없다', async () => {
  for (const profile of ['conductor', null]) {
    const msgs = limitMsgs((await run({screenAt: limitFrom(2, fixtures['pos-plain']), profile})).sent);
    assert.equal(msgs.length, 1);
    assert.ok(!msgs[0][2].includes('대체 후보'), String(profile));
  }
});

test('감시기: 최종 429 재개가 예약된 세션에는 한도 경보도 교대 줄도 없고 재개가 먼저다', async () => {
  const final429 = '■ Exceeded retry limit, last status: 429 Too Many Requests\n\n› Ask Codex to do anything';
  const r = await run({screenAt: limitFrom(2, final429)});
  assert.equal(r.records.filter(e => e.kind === 'rate-limit-retry' && e.action === 'scheduled').length, 1);
  assert.ok(!r.sent.some(([, , m]) => m.includes('대체 후보')), JSON.stringify(r.sent));
});

test('감시기: 원장을 새로 읽는 호출이 늘지 않는다(한도 화면이 있어도 순회당 읽기 횟수가 같다)', async () => {
  const idle = await run({screenAt: working});
  const limited = await run({screenAt: limitFrom(2, fixtures['pos-plain'])});
  assert.equal(limitMsgs(limited.sent).length, 1);
  assert.equal(limited.reads, idle.reads);
});

// ---- PR #434 검수 수정(exec-3a02d2ae): 우편 안내 블록·응답 한 줄 아래·Claude 오탐·지난 429 재개·같은 세대 시작 기록 ----
import {unreadMailMessage} from '../src/watch-notice-format.mjs';
import {RateLimitRetry} from '../src/watch-rate-limit.mjs';
import {currentErrorBlock} from '../src/watch-stop-phrases.mjs';
import {codexBasis, generationStart} from '../src/ocx-refresh.mjs';

const mailOf = preview => unreadMailMessage([{role: 'p-작업자', by: 'p-감독', mailId: 'mail-1', t: '2026-11-18T03:00:00Z', preview}], 'p-작업자');
const NOTICE = mailOf('다른 검수 자료가 도착했습니다.');
const kinds = screen => [...screenDisconnects(screen).values()].map(disconnectKind);
// 감시기가 입력으로 넣은 안내가 화면에 되울릴 때의 모양: 첫 줄 `› `, 이어지는 줄 2칸 들여쓰기, 창 너비로 접힘.
const echoed = (text, width = 56) => text.split('\n').flatMap(line => (line === '' ? [''] : line.match(new RegExp(`.{1,${width}}`, 'gu')))).map((line, i) => (i === 0 ? `› ${line}` : line === '' ? '' : `  ${line}`)).join('\n');

test('우편 안내 블록(실제 포매터)이 한도 줄과 빈 입력창 사이에 끼어도 한도로 읽는다', () => {
  assert.deepEqual(kinds(`${CODEX_LINE}\n\n${NOTICE}\n\n${COMPOSER}`), ['한도']);
  assert.deepEqual(kinds(codex(CODEX_LINE).replace(`\n\n${COMPOSER}`, `\n\n${NOTICE}\n\n${COMPOSER}`)), ['한도'], '도구 출력 뒤 현실적인 화면');
  assert.deepEqual(kinds(`${CODEX_LINE}\n\n${echoed(NOTICE)}\n\n${COMPOSER}`), ['한도'], '되울림(› 머리·들여쓰기·접힌 줄)');
  assert.deepEqual(kinds(`${CODEX_LINE}\n\n${NOTICE}\n\n${NOTICE}\n\n${COMPOSER}`), ['한도'], '안내가 연달아 두 번');
  const many = unreadMailMessage(Array.from({length: 7}, (_, i) => ({role: 'p-작업자', mailId: `m${i}`, preview: '본문'})), 'p-작업자');
  assert.deepEqual(kinds(`${CODEX_LINE}\n\n${many}\n\n${COMPOSER}`), ['한도'], '5통 넘는 안내(외 N건 줄 포함)');
  assert.deepEqual(kinds(`${CODEX_LINE}\n\n${NOTICE}\n${COMPOSER}`), ['한도'], '빈 줄 없이 붙은 입력창');
});

test('우편 안내 블록 안의 문장(미리보기 인용)은 한도가 아니다 — 안내 위의 현재 오류만 본다', () => {
  assert.equal(kinds(`${mailOf(CODEX_LINE)}\n\n${COMPOSER}`).length, 0, '미리보기 인용 단독');
  assert.equal(kinds(`${mailOf(`${CODEX_LINE} 라고 보냄`)}\n\n${COMPOSER}`).length, 0);
  assert.equal(kinds(`• 정상 작업 결과\n  └ ok\n\n${mailOf(CODEX_LINE)}\n\n${COMPOSER}`).length, 0, '위에 오류가 없으면 안내 속 인용은 무시');
  assert.deepEqual(kinds(`${CODEX_LINE}\n\n${mailOf(CODEX_LINE)}\n\n${COMPOSER}`), ['한도'], '진짜 한도는 안내 위에서 읽는다');
  // 안내의 끝줄을 못 찾는 변형(형식이 바뀐 안내)은 건너뛰지 않는다 — 예전 판정 그대로(경보 없음, 정체 경로).
  assert.equal(kinds(`${CODEX_LINE}\n\n[감시sh] 미확인 우편 1건\n보낸이: x\n확인: kadan inbox read m\n\n${COMPOSER}`).length, 0);
  // 안내 뒤에 새 출력이 있으면 그 출력이 현재 오류다(안내 위의 옛 한도가 아니다).
  assert.equal(kinds(`${CODEX_LINE}\n\n${NOTICE}\n\n• 새 작업 결과\n\n${COMPOSER}`).length, 0);
  assert.deepEqual(kinds(`■ authentication failed\n\n${NOTICE}\n\n${CODEX_LINE}\n\n${COMPOSER}`), ['한도']);
});

test('안내 블록 건너뛰기는 다른 오류 낱말에도 같은 규칙이고, 기본 판정의 다른 조건은 그대로다', () => {
  assert.ok(currentErrorBlock(`■ authentication failed\n\n${NOTICE}\n\n${COMPOSER}`));
  assert.equal(currentErrorBlock(`${NOTICE}\n\n${COMPOSER}`), null);
  assert.equal(currentErrorBlock(`• 응답 한 줄\n\n■ authentication failed\n\n${COMPOSER}`), null, '기본 판정은 응답 한 줄 아래의 오류를 덩어리로 읽지 않는다(그대로)');
  assert.equal(screenDisconnects(`• 응답 한 줄\n\n■ authentication failed\n\n${COMPOSER}`).size, 0);
});

test('사용 한도 줄 바로 위에 응답 한 줄(• …)이 있어도 한도로 읽고, 콜론 소개·코드 울타리·입력 중인 글은 여전히 아니다', () => {
  assert.deepEqual(kinds(`• 이전 작업을 정리했습니다.\n\n${CODEX_LINE}\n\n${COMPOSER}`), ['한도']);
  assert.deepEqual(kinds(`• 이전 작업을 정리했습니다.\n${CODEX_LINE}\n${COMPOSER}`), ['한도']);
  assert.equal(kinds(`• 이 오류 문장을 예로 듭니다:\n\n${CODEX_LINE}\n\n${COMPOSER}`).length, 0);
  assert.equal(kinds(`• 예:\n~~~text\n${CODEX_LINE}\n~~~\n\n${COMPOSER}`).length, 0);
  assert.equal(kinds(`• 정리했습니다.\n\n${CODEX_LINE}\n\n› 다음 단계 요약`).length, 0);
  assert.deepEqual(kinds(`• 정리했습니다.\n\n${CODEX_LINE}\n\n${NOTICE}\n\n${COMPOSER}`), ['한도'], '응답 한 줄 + 우편 안내 함께');
});

const claudeScreen = (...body) => `${body.join('\n')}\n\n✻ Crunched for 1s · done 11:56 AM\n\n${'─'.repeat(120)}\n❯ \n${'─'.repeat(120)}\n  ~/Dev/app[main]\n  Opus 5.5 | effort:high\n`;

test('Claude: 실측 한도 줄(세션·Fable)은 잡고, 도구 출력 안 맨 문구(f5)·한도 뜻 설명(f7)은 한도로 올리지 않는다', () => {
  for (const name of ['real-2.1.308-bullet', 'real-2.1.308-tmux', 'pos-plain', 'pos-two-lines', 'pos-after-turn-done', 'pos-after-old-response'])
    assert.deepEqual(kinds(fixtures[name]), ['한도'], name);
  // 2026-11-17 실제 화면(감시 AI 입력 기록)의 꼴: 모델 이름이 들어간 한도와 슬래시 안내 줄.
  const FABLE = ['  ⎿  You\'ve hit your Fable limit · resets Nov 17 at 4pm (Asia/Seoul)', '     /usage-credits to finish what you’re working on.'];
  assert.deepEqual(kinds(claudeScreen('⏺ 이전 답변', '', '✻ Baked for 10s · done 4:40 PM', ...FABLE)), ['한도'], '턴 끝 줄 뒤 Fable 한도');
  // 알려진 한계(넓히지 않음): 같은 줄이 응답 머리표(`⏺ …`) 바로 아래에 붙은 꼴(2026-11-17 실제 화면)은 기존 claudeLimitLine이 응답 안의 글일 수 있어 버린다.
  // 도구 출력 안의 같은 문구(known-f5)와 구조가 같아 이 경보 경로에서 풀지 않았다 — 그런 화면은 기존 정체 경로로 간다.
  assert.equal(kinds(claudeScreen('⏺ Background command "x" completed (exit code 0)', ...FABLE)).length, 0);
  for (const name of ['known-f5-multiline-response', 'known-f7-response-first-line', 'sample-neg-quote-in-reply', 'neg-list-in-response'])
    assert.equal(kinds(fixtures[name]).length, 0, name);
  // 같은 꼴이라도 줄 끝까지 한도 꼴이 아니면(뒤에 설명이 이어짐) 아니다.
  assert.equal(kinds(claudeScreen('⏺ 화면에는 이렇게 보입니다', "⏺ You've hit your session limit · resets 3pm 라는 문구입니다")).length, 0);
});

const RETRY_NOW = Date.parse('2026-11-18T03:00:00Z');
function planAndAdvance(screen) {
  const entries = [], sent = [];
  const retry = new RateLimitRetry({record: e => entries.push(e), resume: name => sent.push(name)});
  const observations = new Map([['kadan-w', {role: 'w', alive: true, pid: 41, expectedPid: 41, startedAt: 1, screen}]]);
  for (const now of [RETRY_NOW, RETRY_NOW + 60_000]) retry.tick({observations, tasks: [{role: 'w', taskId: 't1'}], entries, now, fresh: () => true});
  return {retryMatch: terminal429(screen, RETRY_NOW) != null, events: entries.map(e => e.action), sent: sent.length};
}
const OLD_429 = '■ Exceeded retry limit, last status: 429 Too Many Requests';

test('지난 429 뒤에 최신 사용 한도가 있으면 자동 재개를 예약·실행하지 않는다(현재 429 단독은 그대로 재개)', () => {
  const mixed = `${OLD_429}\n\n› 예전 재시도\n• 이전 요청 처리\n  결과 완료.\n\n${CODEX_LINE}\n\n${COMPOSER}`;
  assert.deepEqual(kinds(mixed), ['한도']);
  assert.deepEqual(planAndAdvance(mixed), {retryMatch: false, events: [], sent: 0});
  assert.deepEqual(planAndAdvance(`${OLD_429}\n\n›\n\n${CODEX_LINE}\n\n${COMPOSER}`), {retryMatch: false, events: [], sent: 0}, '사이에 빈 입력창만');
  assert.deepEqual(planAndAdvance(`${OLD_429}\n\n${COMPOSER}`), {retryMatch: true, events: ['scheduled', 'attempt'], sent: 1}, '현재 429 단독');
  // 사용 한도가 먼저고 429가 더 최근이면 지금의 오류는 429라서 기존대로 재개한다.
  assert.equal(planAndAdvance(`${CODEX_LINE}\n\n› x\n\n${OLD_429}\n\n${COMPOSER}`).sent, 1);
});

test('재사용 start(명령 없음)가 붙은 살아 있는 codex 역할: ocx 대상 판단과 교대 안내가 같은 세대 시작 기록을 쓴다', async () => {
  const {limitFallbackLine} = await import('../src/watch-limit-fallback.mjs');
  const cmd = 'codex --model gpt-6.1-sol';
  const base = {kind: 'start', role: 'w', session: 'kadan-w', panePid: 41};
  const launch = {...base, cmd, harness: 'codex', model: 'gpt-6.1-sol', roleProfile: 'worker'};
  const reuse = {...base, reuseOf: 'fingerprint'};
  assert.equal(generationStart([launch, reuse], 'w'), launch);
  assert.equal(generationStart([launch, {...reuse, reuseOf: undefined, reused: true}], 'w'), launch);
  assert.equal(codexBasis([launch, reuse], 'w').target, true, '재사용이 붙어도 openai codex');
  assert.equal(codexBasis([reuse], 'w').reason, 'not-codex', '세대 시작이 없으면 모른다');
  const settings = {version: 1, revision: 3, activePreset: 'main', runners: {codex: {spawn: 'codex --model {model}'}, claude: {spawn: 'claude --model {model}'}},
    presets: {main: {roles: {worker: {runner: 'codex', model: 'gpt-6.1-sol'}}, fallback: {worker: [{runner: 'claude', model: 'claude-opus-5-5'}]}}}};
  const alert = {kind: '한도', id: 'disconnect:kadan-w:x', role: 'w', session: 'kadan-w', line: CODEX_LINE};
  const ask = (entries, ocx) => limitFallbackLine({alert, entries, settings, ocx});
  assert.equal(ask([launch, reuse], null), null, '사용량 확인 결과 없음 → 줄 없음');
  assert.equal(ask([launch, reuse], {outcome: 'ok', usage: {weekly: 5}}), null, '가짜 한도');
  assert.match(ask([launch, reuse], {outcome: 'ok', usage: {weekly: 98}}), /^대체 후보 1번 있음/);
  assert.match(ask([launch], {outcome: 'ok', usage: {weekly: 98}}), /^대체 후보 1번 있음/, '재사용 없는 대조');
});

test('감시기: 지난 429 + 최신 사용 한도 화면은 재개 예약 없이 한도 경보가 나가고 교대 줄이 붙는다', async () => {
  const mixed = `${OLD_429}\n\n› 예전 재시도\n• 이전 요청 처리\n  결과 완료.\n\n${CODEX_LINE}\n\n${COMPOSER}`;
  const r = await run({screenAt: limitFrom(2, mixed)});
  assert.equal(r.resumes.length, 0, '자동 재개 없음');
  assert.equal(r.records.filter(e => e.kind === 'rate-limit-retry').length, 0, '재개 예약 기록 없음');
  const msgs = limitMsgs(r.sent);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0][2], /대체 후보 1번 있음/);
});
