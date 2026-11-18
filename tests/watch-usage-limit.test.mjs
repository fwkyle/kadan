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
