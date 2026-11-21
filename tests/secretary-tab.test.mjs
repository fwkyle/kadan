import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {planSecretaryTab, openSecretaryTab, attachHiddenSecretary, TAB_CALL_TIMEOUT_MS} from '../src/secretary-tab.mjs';
import {resumeSecretary, checkpointSecretary} from '../src/secretary-resume.mjs';
import {inspectRecovery} from '../src/recovery.mjs';
import {currentRottieWindow} from '../src/restore.mjs';

const SETTING = {version: 1, window: 'rottie', rottieBin: '/fixture/rottie'};
const ok = {ok: true, bundleId: 'dev.fixture'};
const base = {setting: SETTING, auto: false, env: {KADAN_WINDOW: 'rottie'}, session: 'kadan-비서',
  entries: [], connect: () => ok, show: () => ({ok: true, state: 'running'})};
const withTab = {...base, entries: [{kind: 'start', session: 'kadan-비서', role: '비서', rottieTerminalId: 'old'}]};

test('plan: opens only when the machine setting is rottie and Rottie answers', () => {
  assert.equal(planSecretaryTab(base).open, true);
  assert.equal(planSecretaryTab({...base, setting: {version: 1, window: 'none'}}).reason, 'setting-not-rottie');
  assert.equal(planSecretaryTab({...base, setting: null}).reason, 'setting-not-rottie');
  assert.equal(planSecretaryTab({...base, connect: () => ({ok: false, code: 'X'})}).reason, 'rottie-unavailable');
});

test('plan: a human-chosen KADAN_WINDOW=none stays none, launchd-forced none is read as "Rottie may be absent"', () => {
  const none = {KADAN_WINDOW: 'none'};
  assert.equal(planSecretaryTab({...base, env: none}).open, false);
  assert.equal(planSecretaryTab({...base, env: {...none, KADAN_WINDOW_FORCE: '1'}}).open, false); // 사람이 FORCE로 고정한 none
  assert.equal(planSecretaryTab({...base, env: {...none, KADAN_WINDOW_FORCE: '1'}, auto: true}).open, true); // launchd
  assert.equal(planSecretaryTab({...base, env: none, auto: true}).open, true); // 옛 plist(FORCE 없음)도 `--auto`면 launchd 꼴
  assert.equal(planSecretaryTab({...base, env: none, auto: false}).open, false); // `--auto` 없는 사람의 none은 그대로 존중
  assert.equal(planSecretaryTab({...base, env: {KADAN_WINDOW: 'orca'}}).open, false);
  let called = false;
  planSecretaryTab({...base, env: none, connect: () => { called = true; return ok; }});
  assert.equal(called, false, '열지 않기로 한 판정은 로티를 부르지 않는다');
});

test('plan: an alive tab is never duplicated; unknown tab state does not open; gone or exited tab is replaced', () => {
  assert.equal(planSecretaryTab(withTab).reason, 'tab-alive');
  assert.equal(planSecretaryTab({...withTab, show: () => ({ok: true, state: 'created'})}).reason, 'tab-alive');
  assert.equal(planSecretaryTab({...withTab, show: () => ({ok: false, code: 'ROTTIE_SHOW_FAILED'})}).reason, 'tab-unknown');
  const gone = planSecretaryTab({...withTab, show: () => ({ok: false, code: 'ROTTIE_TERMINAL_NOT_FOUND'})});
  assert.deepEqual([gone.open, gone.replace], [true, {terminalId: 'old', state: '없음'}]);
  const exited = planSecretaryTab({...withTab, show: () => ({ok: true, state: 'exited'})});
  assert.deepEqual([exited.open, exited.replace.state], [true, 'exited']);
});

function fakeRottie({create = 'new', show = null, status = true} = {}) {
  const calls = [];
  const run = (bin, args, options) => {
    calls.push({bin, args, options});
    const json = value => ({status: 0, stdout: JSON.stringify(value)});
    if (args[0] === 'status') return status ? json({ok: true, runtime: {bundleId: 'dev.fixture'}}) : {status: 1, stdout: '', stderr: 'down'};
    if (args[0] === 'terminal' && args[1] === 'show') {
      return show ? json(show) : json({ok: false, error: {code: 'ROTTIE_TERMINAL_NOT_FOUND'}});
    }
    if (args[0] === 'terminal' && args[1] === 'create') {
      return create ? json({ok: true, result: {terminal: {id: create, pid: 1}}}) : json({ok: false, error: {code: 'ROTTIE_FAIL'}});
    }
    if (args[0] === 'terminal' && args[1] === 'remove') return json({ok: true});
    return {status: 1, stdout: ''};
  };
  return {calls, run};
}
// 시험은 실제 tmux에 묻지 않는다: 붙은 화면 수는 늘 가짜로 준다(기본은 "못 읽음" = 열지 않음).
const UNREAD = () => ({ok: false, code: 'FAKE_UNREAD'});
const ctx = {home: '/fixture-home', env: {KADAN_WINDOW: 'rottie'}, entries: [], session: 'kadan-비서', role: '비서',
  cwd: '/tmp', panePid: '30', platform: 'darwin', readSetting: () => SETTING, open: undefined, readClients: UNREAD};
test('open: bounded Rottie calls only use non-focus verbs and the new tab id is returned', async () => {
  const {openWindow} = await import('../src/floor-tmux.mjs');
  const fake = fakeRottie();
  const result = openSecretaryTab({...ctx, run: fake.run,
    open: (s, p, d) => openWindow(s, p, {...d, waitForClient: () => true})});
  assert.deepEqual([result.window, result.rottieTerminalId, result.rottieConnect], ['rottie', 'new', 'ok']);
  const verbs = fake.calls.map(c => c.args.slice(0, 2).join(' '));
  assert.deepEqual(verbs, ['status --json', 'terminal create']);
  for (const call of fake.calls) {
    assert.equal(call.bin, '/fixture/rottie');
    assert.equal(call.options.timeout, TAB_CALL_TIMEOUT_MS);
    // 앱 활성화·앞으로 가져오기·포커스 인자가 없다.
    assert.equal(call.args.some(a => /activate|focus|front|raise/i.test(a)), false, call.args.join(' '));
    assert.ok(['status', 'terminal', 'workspace'].includes(call.args[0]));
  }
});

test('open: failures, timeouts and a missing Rottie all end as hidden without throwing', async () => {
  const {openWindow} = await import('../src/floor-tmux.mjs');
  const open = (s, p, d) => openWindow(s, p, {...d, waitForClient: () => true});
  const quiet = fn => { const e = console.error; console.error = () => {}; try { return fn(); } finally { console.error = e; } };
  assert.equal(quiet(() => openSecretaryTab({...ctx, run: fakeRottie({create: null}).run, open})).window, 'hidden');
  assert.equal(quiet(() => openSecretaryTab({...ctx, run: fakeRottie({status: false}).run, open})).reason, 'rottie-unavailable');
  assert.equal(quiet(() => openSecretaryTab({...ctx, run: () => { throw new Error('boom'); }, open})).window, 'hidden');
  assert.equal(quiet(() => openSecretaryTab({...ctx, run: fakeRottie().run,
    open: (s, p, d) => openWindow(s, p, {...d, waitForClient: () => false})})).reason, 'open-failed');
  assert.equal(openSecretaryTab({...ctx, platform: 'linux', run: fakeRottie().run, open}).reason, 'not-darwin');
  assert.equal(openSecretaryTab({...ctx, readSetting: () => { throw new Error('손상'); }, open}).window, 'hidden');
});

function fixture() {
  const home = fs.mkdtempSync(path.join(process.env.KADAN_HOME, 'sectab-'));
  const transcript = path.join(home, 'rollout-exact.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({type: 'session_meta', payload: {id: 'exact', cwd: home}}) + '\n');
  const entries = [{kind: 'start', floor: 'tmux', role: '비서', session: 'kadan-비서', panePid: '20', cwd: home,
    roleProfile: 'secretary', rottieTerminalId: 'old', cmd: 'codex --model test-model'}];
  let pane = {pid: '20'}; const calls = [];
  const floor = {name: 'tmux', alive: () => Boolean(pane), pid: () => pane?.pid,
    create: o => { calls.push('create'); pane = {pid: '30'}; return {panePid: '30'}; }};
  const deps = {home, floor, read: () => entries, record: e => entries.push(e), findTranscript: () => transcript,
    startNew: () => calls.push('new')};
  checkpointSecretary(deps);
  return {home, entries, calls, deps, setPane: v => { pane = v; }};
}

test('resume: session first, then the tab; the start records window rottie and the new tab id', () => {
  const f = fixture(); f.setPane(null);
  let seenCreateFirst = false;
  const result = resumeSecretary({...f.deps, openTab: tab => {
    seenCreateFirst = f.calls.includes('create'); assert.equal(tab.panePid, '30');
    return {window: 'rottie', rottieTerminalId: 'new', rottieBundleId: 'dev.fixture', rottieConnect: 'ok'};
  }});
  assert.equal(result, 'restored'); assert.ok(seenCreateFirst);
  const start = f.entries.at(-1);
  assert.deepEqual([start.window, start.rottieTerminalId, start.rottieConnect], ['rottie', 'new', 'ok']);
  assert.equal(currentRottieWindow(f.entries, 'kadan-비서').rottieTerminalId, 'new');
});

test('resume: no tab / failed tab / throwing tab opener still starts hidden and succeeds', () => {
  for (const openTab of [undefined, () => ({window: 'hidden', reason: 'open-failed'}), () => { throw new Error('x'); }]) {
    const f = fixture(); f.setPane(null);
    assert.equal(resumeSecretary({...f.deps, openTab}), 'restored');
    const start = f.entries.at(-1);
    assert.equal(start.window, 'hidden');
    assert.equal(start.rottieTerminalId, 'old'); // 옛 탭 기록은 지금처럼 잇는다
  }
});

test('race: up --auto resume and Rottie restore never leave two secretaries or two tabs', () => {
  // (a) 재개가 먼저 새 탭을 열면 로티가 들고 있는 옛 탭 ID의 복원 요청은 "교체됨"으로 거절된다.
  const a = fixture(); a.setPane(null);
  resumeSecretary({...a.deps, openTab: () => ({window: 'rottie', rottieTerminalId: 'new', rottieConnect: 'ok'})});
  assert.throws(() => inspectRecovery({terminal: 'old'}, {home: a.home, entries: a.entries, livePane: () => ({pid: '30', dead: false, created: '1'})}),
    /교체됐을 수 있습니다/);
  assert.equal(a.calls.filter(c => c === 'create').length, 1);
  // (b) 로티 복원이 먼저 새 탭을 붙인 뒤(window 사건) 재개가 오면 그 탭이 살아 있어 두 번째 탭을 만들지 않는다.
  const b = fixture(); b.setPane(null);
  b.entries.push({kind: 'window', role: '비서', session: 'kadan-비서', rottieTerminalId: 'by-rottie', panePid: '20'});
  const fake = fakeRottie({show: {ok: true, result: {terminal: {state: 'running'}}}});
  let created = 0;
  const run = (bin, args, o) => { if (args[1] === 'create') created++; return fake.run(bin, args, o); };
  resumeSecretary({...b.deps, openTab: tab => openSecretaryTab({...ctx, ...tab, run, entries: tab.entries,
    readSetting: () => SETTING, open: () => { created++; return {rottieTerminalId: 'dup'}; }})});
  assert.equal(created, 0);
  assert.equal(b.entries.at(-1).rottieTerminalId, 'by-rottie');
});

test('aux: a hidden secretary gets one tab after Rottie appears; failures write nothing; existing tab is left alone', () => {
  const hidden = [{kind: 'start', role: '비서', session: 'kadan-비서', panePid: '30', window: 'hidden'}];
  const recorded = [];
  const floor = {pid: () => '30'};
  const attach = (entries, open, readSetting = () => SETTING) => attachHiddenSecretary({home: 'h', floor,
    session: 'kadan-비서', readEntries: () => entries, record: e => recorded.push(e), open, readSetting});
  assert.equal(attach(hidden, () => ({window: 'hidden', reason: 'rottie-unavailable'})).attached, false);
  assert.equal(recorded.length, 0);
  assert.equal(attach(hidden, () => ({window: 'rottie', rottieTerminalId: 'T1'})).attached, true);
  assert.deepEqual([recorded[0].kind, recorded[0].rottieTerminalId, recorded[0].panePid], ['window', 'T1', '30']);
  assert.equal(currentRottieWindow([...hidden, recorded[0]], 'kadan-비서').rottieTerminalId, 'T1');
  assert.equal(attach([...hidden, recorded[0]], () => { throw new Error('다시 열면 안 된다'); }).reason, 'has-tab');
  assert.equal(recorded.length, 1);
  let read = false;
  const none = attachHiddenSecretary({home: 'h', floor, session: 'kadan-비서', readSetting: () => ({version: 1, window: 'none'}),
    readEntries: () => { read = true; return hidden; }, record: () => {}});
  assert.equal(none.reason, 'setting-not-rottie'); assert.equal(read, false, 'rottie 설정이 아니면 원장을 읽지 않는다');
  assert.equal(attach([...hidden, {kind: 'stop', session: 'kadan-비서'}], () => ({window: 'rottie', rottieTerminalId: 'X'})).reason,
    'generation-unclear');
  assert.equal(attachHiddenSecretary({home: 'h', floor: {pid: () => '99'}, session: 'kadan-비서', readSetting: () => SETTING,
    readEntries: () => hidden, record: () => {}, open: () => ({window: 'rottie', rottieTerminalId: 'X'})}).reason, 'generation-unclear');
});

// ---- PR #407 검수 수정(F1·F2·S1): 0621837에서 실패하는 재현 ----
const realOpen = async () => {
  const {openWindow} = await import('../src/floor-tmux.mjs');
  return (s, p, d) => openWindow(s, p, {...d, waitForClient: () => true});
};
const shownState = state => ({ok: true, result: {terminal: {state}}});

test('F1: an unknown/empty/unrecognized tab state never opens a new tab (only a confirmed exited tab is replaced)', async () => {
  const open = await realOpen();
  for (const state of ['unknown', '', 'weird-new-state']) {
    const fake = fakeRottie({show: shownState(state)});
    const result = openSecretaryTab({...ctx, entries: withTab.entries, run: fake.run, open});
    assert.equal(result.window, 'hidden', state);
    const verbs = fake.calls.map(c => c.args.slice(0, 2).join(' '));
    assert.deepEqual(verbs, ['status --json', 'terminal show'], `${state}: create/remove 0회`);
  }
  const exited = fakeRottie({show: shownState('exited')});
  assert.equal(openSecretaryTab({...ctx, entries: withTab.entries, run: exited.run, open}).window, 'rottie');
});

const inheritedHidden = () => [{kind: 'start', role: '비서', session: 'kadan-비서', panePid: '30', window: 'hidden',
  rottieTerminalId: 'old'}];
const attachWith = async (entries, fake, record, readClients = UNREAD) => {
  const open = await realOpen();
  return attachHiddenSecretary({home: 'h', floor: {pid: () => '30'}, session: 'kadan-비서', readEntries: () => entries,
    record, readSetting: () => SETTING,
    open: c => openSecretaryTab({...c, env: {KADAN_WINDOW: 'rottie'}, platform: 'darwin', readSetting: () => SETTING, run: fake.run, open,
      readClients})});
};

test('F2: a hidden generation that inherited a gone/exited old tab id is still attached, once', async () => {
  for (const show of [null, shownState('exited')]) { // null = 로티가 NOT_FOUND로 답함
    const entries = inheritedHidden(), recorded = [];
    const fake = fakeRottie({show});
    const result = await attachWith(entries, fake, e => { recorded.push(e); entries.push(e); });
    assert.equal(result.attached, true);
    assert.deepEqual([recorded[0].kind, recorded[0].rottieTerminalId], ['window', 'new']);
    assert.equal(currentRottieWindow(entries, 'kadan-비서').rottieTerminalId, 'new');
    const again = await attachWith(entries, fakeRottie(), e => recorded.push(e));
    assert.equal(again.reason, 'has-tab'); assert.equal(recorded.length, 1);
  }
});

test('F2: inherited id whose tab is alive/unknown is left alone; a tab of the current generation the human closed is not reopened', async () => {
  for (const state of ['running', 'unknown']) {
    const recorded = [];
    const r = await attachWith(inheritedHidden(), fakeRottie({show: shownState(state)}), e => recorded.push(e));
    assert.equal(r.attached, false, state); assert.equal(recorded.length, 0);
  }
  const current = [{kind: 'start', role: '비서', session: 'kadan-비서', panePid: '30', window: 'rottie', rottieTerminalId: 'mine'}];
  const fake = fakeRottie(); // 현재 세대 탭이 NOT_FOUND(사람이 닫음)여도 다시 열지 않는다
  const r = await attachWith(current, fake, () => assert.fail('기록하면 안 된다'));
  assert.equal(r.reason, 'has-tab'); assert.equal(fake.calls.length, 0);
});

test('S1: the automatic attach path stays silent on failure (no repeated stderr line)', async () => {
  const lines = [], original = console.error; console.error = line => lines.push(line);
  try {
    for (let i = 0; i < 2; i++) await attachWith(inheritedHidden(), fakeRottie({create: null}), () => assert.fail('실패는 기록 없음'));
  } finally { console.error = original; }
  assert.deepEqual(lines, []);
});

// ---- PR #407 2차: 자동 실패는 같은 원인이면 처음 한 번만, 이유와 함께 남는다 ----
test('R1: the automatic attach failure keeps its concrete reason and is logged once per cause across cycles', async () => {
  const {attachFailureLine} = await import('../src/secretary-tab.mjs');
  const {changedOutput} = await import('../src/revive.mjs');
  const home = fs.mkdtempSync(path.join(process.env.KADAN_HOME, 'r1-'));
  const cycle = async (fake, entries = inheritedHidden()) => {
    const result = await attachWith(entries, fake, e => entries.push(e));
    const line = attachFailureLine(result);
    return {result, logged: changedOutput(home, line ? [line] : [])};
  };
  const failing = () => fakeRottie({create: null});
  const first = await cycle(failing());
  assert.equal(first.result.attached, false);
  assert.match(first.result.detail, /ROTTIE_FAIL/);          // 구체 오류 코드를 버리지 않는다
  assert.equal(first.logged.length, 1);
  assert.match(first.logged[0], /비서 로티 탭 붙이기 실패.*ROTTIE_FAIL/);
  for (let i = 0; i < 2; i++) assert.deepEqual((await cycle(failing())).logged, []); // 같은 원인 반복은 0줄
  const entries = inheritedHidden();
  const ok = await cycle(fakeRottie(), entries);              // 성공 → 같은 줄을 지움
  assert.equal(ok.result.attached, true); assert.deepEqual(ok.logged, []);
  assert.equal((await cycle(fakeRottie(), entries)).result.reason, 'has-tab'); // 중복 탭 없음
  assert.equal((await cycle(failing())).logged.length, 1);    // 성공 뒤 다시 실패하면 다시 한 번
  const other = await cycle(fakeRottie({create: 'x', show: shownState('unknown')}));
  assert.match(other.logged[0], /tab-unknown|알 수 없/);       // 원인이 바뀌면 다시 한 번
  // 정상 건너뜀(탭 있음·로티 없음·설정 none)은 줄이 없다
  for (const reason of ['has-tab', 'setting-not-rottie', 'generation-unclear', 'tab-alive', 'not-darwin'])
    assert.equal(attachFailureLine({attached: false, reason}), null, reason);
});

// ---- 운영 plist 꼴: FORCE 없는 옛 설치 (`KADAN_WINDOW=none`만 있음, `up --hidden --auto`) ----
const attachAs = async (entries, fake, record, {env, auto = true} = {}) => {
  const open = await realOpen();
  return attachHiddenSecretary({home: 'h', floor: {pid: () => '30'}, session: 'kadan-비서', readEntries: () => entries,
    record, readSetting: () => SETTING, auto,
    open: c => openSecretaryTab({...c, env, platform: 'darwin', readSetting: () => SETTING, run: fake.run, open, readClients: UNREAD})});
};
const hiddenNoTab = () => [{kind: 'start', role: '비서', session: 'kadan-비서', panePid: '30', window: 'hidden'}];

test('old launchd plist (none, no FORCE) with --auto attaches exactly one tab; the new plist shape still does', async () => {
  for (const env of [{KADAN_WINDOW: 'none'}, {KADAN_WINDOW: 'none', KADAN_WINDOW_FORCE: '1'}]) {
    const entries = hiddenNoTab(), recorded = [], fake = fakeRottie();
    const first = await attachAs(entries, fake, e => { recorded.push(e); entries.push(e); }, {env});
    assert.equal(first.attached, true, JSON.stringify(env));
    assert.equal(recorded.filter(e => e.kind === 'window').length, 1);
    assert.equal(fake.calls.filter(c => c.args[1] === 'create').length, 1);
    assert.equal((await attachAs(entries, fakeRottie(), e => recorded.push(e), {env})).reason, 'has-tab');
    assert.equal(recorded.length, 1);
  }
});

test('a human-typed none (no --auto) never attaches, with or without FORCE', async () => {
  for (const env of [{KADAN_WINDOW: 'none'}, {KADAN_WINDOW: 'none', KADAN_WINDOW_FORCE: '1'}]) {
    const fake = fakeRottie();
    const result = await attachAs(hiddenNoTab(), fake, () => assert.fail('기록하면 안 된다'), {env, auto: false});
    assert.deepEqual([result.attached, result.reason], [false, 'env-window-none']);
    assert.equal(fake.calls.length, 0, '열지 않기로 한 판정은 로티를 부르지 않는다');
  }
});

test('skips on this path are no longer silent: the first cause is logged once through the #407 route', async () => {
  const {attachFailureLine} = await import('../src/secretary-tab.mjs');
  const {changedOutput} = await import('../src/revive.mjs');
  const home = fs.mkdtempSync(path.join(process.env.KADAN_HOME, 'skip-'));
  const cycle = async (env, fake) => {
    const result = await attachAs(hiddenNoTab(), fake, () => {}, {env});
    const line = attachFailureLine(result);
    return changedOutput(home, line ? [line] : []);
  };
  const orca = await cycle({KADAN_WINDOW: 'orca'}, fakeRottie());
  assert.equal(orca.length, 1); assert.match(orca[0], /KADAN_WINDOW=orca/);
  assert.deepEqual(await cycle({KADAN_WINDOW: 'orca'}, fakeRottie()), []);   // 같은 원인 반복 0줄
  const down = await cycle({KADAN_WINDOW: 'none'}, fakeRottie({status: false}));
  assert.equal(down.length, 1); assert.match(down[0], /로티/);                // 원인이 바뀌면 다시 한 번
  assert.deepEqual(await cycle({KADAN_WINDOW: 'none'}, fakeRottie({status: false})), []);
});

// ---- tab-unknown 이유 기록 (2026-11-21: 재부팅 뒤 비서 탭이 tab-unknown으로 안 붙었는데 로티가 뭐라 답했는지 버려졌다) ----
test('T1: plan keeps what Rottie said when the tab state is unknown (state when show worked, code/message when it failed)', () => {
  const state = planSecretaryTab({...withTab, entries: [{kind: 'start', session: 'kadan-비서', role: '비서',
    rottieTerminalId: 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb'}], show: () => ({ok: true, state: 'unknown'})});
  assert.equal(state.open, false); assert.equal(state.reason, 'tab-unknown');
  assert.equal(state.detail, '탭 aaaaaaaa show 응답 state=unknown');       // 탭 ID는 앞 8자만 남긴다
  const failed = planSecretaryTab({...withTab, show: () => ({ok: false, code: 'ROTTIE_QUERY_FAILED', message: 'daemon\u0007 busy\n(retry)'})});
  assert.equal(failed.reason, 'tab-unknown');
  assert.equal(failed.detail, '탭 old show 실패 code=ROTTIE_QUERY_FAILED message=daemon busy (retry)'); // 제어 문자·줄바꿈 정리
  const empty = planSecretaryTab({...withTab, show: () => ({ok: true, state: ''})});
  assert.equal(empty.detail, '탭 old show 응답 state=(빈 값)');
  const long = planSecretaryTab({...withTab, show: () => ({ok: false, code: 7, message: 'x'.repeat(500)})});
  assert.match(long.detail, /code=7 message=x{200}…$/);                                              // message는 200자에서 자른다
  // 판정은 그대로다: 살아 있음·종료 확정·없음은 detail이 없고 열기/건너뜀 결정도 바뀌지 않는다.
  assert.equal(planSecretaryTab(withTab).detail, undefined);
  assert.equal(planSecretaryTab({...withTab, show: () => ({ok: true, state: 'exited'})}).detail, undefined);
  assert.equal(planSecretaryTab({...withTab, show: () => ({ok: false, code: 'ROTTIE_TERMINAL_NOT_FOUND'})}).detail, undefined);
});

test('T2: the open result and the autostart.log line carry the Rottie answer; the same answer logs once, a new answer logs again', async () => {
  const {attachFailureLine} = await import('../src/secretary-tab.mjs');
  const {changedOutput} = await import('../src/revive.mjs');
  const home = fs.mkdtempSync(path.join(process.env.KADAN_HOME, 't2-'));
  const oneClient = () => ({ok: true, count: 1}); // 이 시험의 unknown은 tmux에 화면이 붙어 있어 열지 않는 경우다
  const cycle = async fake => {
    const entries = inheritedHidden();
    const result = await attachWith(entries, fake, e => entries.push(e), oneClient);
    const line = attachFailureLine(result);
    return {result, line, logged: changedOutput(home, line ? [line] : [])};
  };
  const unknown = await cycle(fakeRottie({show: shownState('unknown')}));
  assert.equal(unknown.result.attached, false); assert.equal(unknown.result.reason, 'tab-unknown');
  assert.equal(unknown.result.detail, '탭 old show 응답 state=unknown · tmux 붙은 화면 1개');
  assert.equal(unknown.line, '비서 로티 탭 붙이기 실패: tab-unknown (탭 old show 응답 state=unknown · tmux 붙은 화면 1개)');
  assert.deepEqual(unknown.logged, [unknown.line]);
  for (let i = 0; i < 2; i++) assert.deepEqual((await cycle(fakeRottie({show: shownState('unknown')}))).logged, []); // 같은 답은 매분 반복하지 않는다
  const other = await cycle(fakeRottie({show: shownState('lost')}));                  // 답이 바뀌면 다시 한 번
  assert.deepEqual(other.logged, ['비서 로티 탭 붙이기 실패: tab-unknown (탭 old show 응답 state=lost)']);
  const errorCode = await cycle(fakeRottie({show: {ok: false, error: {code: 'ROTTIE_TERMINAL_QUERY_FAILED', message: '데몬 조회 실패'}}}));
  assert.deepEqual(errorCode.logged,
    ['비서 로티 탭 붙이기 실패: tab-unknown (탭 old show 실패 code=ROTTIE_TERMINAL_QUERY_FAILED message=데몬 조회 실패)']);
  // 5초 시간 초과: 로티가 답하지 못한 호출도 code가 남는다. 이때도 create·remove는 0회다.
  const calls = [];
  const timedOut = {calls, run: (bin, args) => {
    calls.push(args.slice(0, 2).join(' '));
    if (args[0] === 'status') return {status: 0, stdout: JSON.stringify({ok: true, runtime: {bundleId: 'dev.fixture'}})};
    return {status: null, stdout: null, error: Object.assign(new Error('spawnSync ETIMEDOUT'), {code: 'ETIMEDOUT'})};
  }};
  const slow = await cycle(timedOut);
  assert.match(slow.line, /tab-unknown \(탭 old show 실패 code=ETIMEDOUT message=spawnSync ETIMEDOUT\)$/);
  assert.deepEqual(calls, ['status --json', 'terminal show']);
  // 상세가 없는 옛 결과의 줄 모양은 그대로다.
  assert.equal(attachFailureLine({attached: false, reason: 'tab-unknown'}), '비서 로티 탭 붙이기 실패: tab-unknown');
});

// ---- A안: 로티 unknown + tmux에 이 세션을 보는 화면이 확실히 0이면 옛 탭을 바꾼다 (2026-11-21) ----
const withClients = (clients, show) => ({...withTab, show, clients});
const unknownShow = () => ({ok: true, state: 'unknown'});

test('U1: rottie unknown opens a replacement tab only when tmux surely reads 0 attached screens', () => {
  const asked = [];
  const zero = planSecretaryTab(withClients(s => { asked.push(s); return {ok: true, count: 0}; }, unknownShow));
  assert.deepEqual([zero.open, zero.replace], [true, {terminalId: 'old', state: 'unknown'}]);
  assert.deepEqual(asked, ['kadan-비서'], '이 비서 세션 하나만 묻는다');
  for (const count of [1, 3]) {
    const seen = planSecretaryTab(withClients(() => ({ok: true, count}), unknownShow));
    assert.deepEqual([seen.open, seen.reason], [false, 'tab-unknown'], `count ${count}`);
    assert.equal(seen.detail, `탭 old show 응답 state=unknown · tmux 붙은 화면 ${count}개`);
  }
  const unread = planSecretaryTab(withClients(() => ({ok: false, code: 'tmux-exit-1'}), unknownShow));
  assert.deepEqual([unread.open, unread.reason], [false, 'tab-unknown']);
  assert.equal(unread.detail, '탭 old show 응답 state=unknown · tmux 화면 수 확인 못함 code=tmux-exit-1');
  const thrown = planSecretaryTab(withClients(() => { throw Object.assign(new Error('boom'), {code: 'EBOOM'}); }, unknownShow));
  assert.deepEqual([thrown.open, thrown.detail], [false, '탭 old show 응답 state=unknown · tmux 화면 수 확인 못함 code=EBOOM']);
  // 이상한 읽기값은 0으로 읽지 않는다(실패 닫힘).
  for (const weird of [undefined, null, {}, {ok: true}, {ok: true, count: '0'}, {ok: true, count: -1}, {ok: true, count: 0.5}, {ok: 'yes', count: 0}]) {
    const plan = planSecretaryTab(withClients(() => weird, unknownShow));
    assert.equal(plan.open, false, JSON.stringify(weird));
    assert.match(plan.detail, /tmux 화면 수 확인 못함 code=tmux-unreadable$/, JSON.stringify(weird));
  }
});

test('U2: only the rottie unknown state is widened — alive, exited, gone, other states and show failures behave as before', () => {
  const never = () => { throw new Error('unknown이 아니면 tmux에 묻지 않는다'); };
  for (const state of ['running', 'created']) {
    assert.equal(planSecretaryTab(withClients(never, () => ({ok: true, state}))).reason, 'tab-alive', state);
  }
  const exited = planSecretaryTab(withClients(never, () => ({ok: true, state: 'exited'})));
  assert.deepEqual([exited.open, exited.replace], [true, {terminalId: 'old', state: 'exited'}]);
  const gone = planSecretaryTab(withClients(never, () => ({ok: false, code: 'ROTTIE_TERMINAL_NOT_FOUND'})));
  assert.deepEqual([gone.open, gone.replace], [true, {terminalId: 'old', state: '없음'}]);
  // 그 밖의 state(lost·빈 값·처음 보는 값)와 show 실패(나 갈래)는 화면 수가 0이어도 열지 않는다.
  const zero = () => ({ok: true, count: 0});
  for (const state of ['lost', '', 'weird-new-state', 'Unknown']) {
    const plan = planSecretaryTab({...withTab, clients: zero, show: () => ({ok: true, state})});
    assert.deepEqual([plan.open, plan.reason], [false, 'tab-unknown'], state);
    assert.doesNotMatch(plan.detail, /tmux/, `${state}: 화면 수를 묻지 않았으니 상세에 tmux가 없다`);
  }
  const failed = planSecretaryTab({...withTab, clients: zero, show: () => ({ok: false, code: 'ROTTIE_SHOW_FAILED'})});
  assert.deepEqual([failed.open, failed.reason], [false, 'tab-unknown']);
  // 이을 탭이 없으면 화면 수는 보지 않고 연다(기존 그대로).
  assert.equal(planSecretaryTab({...base, clients: never}).open, true);
  // 열지 않기로 한 설정·환경은 tmux도 로티도 부르지 않는다.
  assert.equal(planSecretaryTab({...withTab, clients: never, setting: {version: 1, window: 'none'}, show: unknownShow}).reason, 'setting-not-rottie');
});

test('U3: unknown + 0 screens opens exactly one tab, tries to remove the old one once, records the swap, and the next cycle opens nothing', async () => {
  const {attachFailureLine} = await import('../src/secretary-tab.mjs');
  const entries = inheritedHidden();
  const recorded = [];
  const fake = fakeRottie({create: 'new-tab', show: shownState('unknown')});
  const result = await attachWith(entries, fake, e => { recorded.push(e); entries.push(e); }, () => ({ok: true, count: 0}));
  assert.equal(result.attached, true); assert.equal(result.rottieTerminalId, 'new-tab');
  assert.deepEqual([result.restoredFrom, result.oldState], ['old', 'unknown']);
  // 만든 뒤 옛 탭을 다시 확인(show)하고, 옛 탭이 안 살아 있으면 제거한다(fix2).
  assert.deepEqual(fake.calls.map(c => c.args.slice(0, 2).join(' ')),
    ['status --json', 'terminal show', 'terminal create', 'terminal show', 'terminal remove']);
  const removal = fake.calls.find(c => c.args[1] === 'remove');
  assert.equal(removal.args[removal.args.indexOf('--terminal') + 1], 'old'); // 지우는 것은 옛 탭 하나뿐
  assert.equal(attachFailureLine(result), null);
  assert.equal(recorded.length, 1);
  assert.deepEqual([recorded[0].kind, recorded[0].rottieTerminalId, recorded[0].restoredFrom, recorded[0].oldState, recorded[0].by],
    ['window', 'new-tab', 'old', 'unknown', 'autostart']);
  // 다음 주기: 이 세대에 연결한 탭이 있으니 로티·tmux·create 어느 것도 부르지 않는다.
  const next = fakeRottie({create: 'again', show: shownState('unknown')});
  const second = await attachWith(entries, next, e => recorded.push(e), () => { throw new Error('다시 묻지 않는다'); });
  assert.deepEqual([second.attached, second.reason], [false, 'has-tab']);
  assert.equal(next.calls.length, 0);
  // 같은 새 탭이 살아 있으면(열기 직접 호출) 화면이 붙었든 아니든 다시 열지 않는다: 탭 하나.
  const alive = fakeRottie({show: shownState('running')});
  const again = openSecretaryTab({...ctx, entries: [{kind: 'start', session: 'kadan-비서', role: '비서', rottieTerminalId: 'new-tab'}],
    run: alive.run, open: await realOpen(), readClients: () => ({ok: true, count: 0})});
  assert.deepEqual([again.window, again.reason], ['hidden', 'tab-alive']);
  assert.deepEqual(alive.calls.map(c => c.args.slice(0, 2).join(' ')), ['status --json', 'terminal show']);
});

test('U4: unknown + screens attached or unreadable never creates or removes a tab', async () => {
  for (const seen of [{ok: true, count: 1}, {ok: true, count: 2}, {ok: false, code: 'tmux-exit-1'}]) {
    const entries = inheritedHidden(); const recorded = [];
    const fake = fakeRottie({create: 'x', show: shownState('unknown')});
    const result = await attachWith(entries, fake, e => recorded.push(e), () => seen);
    assert.deepEqual([result.attached, result.reason], [false, 'tab-unknown'], JSON.stringify(seen));
    assert.deepEqual(fake.calls.map(c => c.args.slice(0, 2).join(' ')), ['status --json', 'terminal show'], 'create·remove 0회');
    assert.equal(recorded.length, 0);
  }
});

test('U5: sessionClientCount reads 0 / N / unreadable as three separate answers (list-clients failure is not "0")', async () => {
  const {sessionClientCount} = await import('../src/floor-tmux.mjs');
  const seen = [];
  const run = result => (args, input, options) => { seen.push({args, input, options}); return result; };
  assert.deepEqual(sessionClientCount('kadan-비서', {run: run({status: 0, stdout: ''})}), {ok: true, count: 0});
  assert.deepEqual(seen[0].args, ['list-clients', '-t', '=kadan-비서', '-F', '#{client_pid}']);   // `=`: 정확히 그 이름의 세션
  assert.equal(seen[0].options.timeout, 5000);
  assert.deepEqual(sessionClientCount('s', {run: run({status: 0, stdout: '101\n202\n'})}), {ok: true, count: 2});
  assert.deepEqual(sessionClientCount('s', {run: run({status: 1, stdout: '', stderr: "can't find session"})}), {ok: false, code: 'tmux-exit-1'});
  assert.deepEqual(sessionClientCount('s', {run: run({status: null, stdout: null, error: Object.assign(new Error('t'), {code: 'ETIMEDOUT'})})}),
    {ok: false, code: 'ETIMEDOUT'});
  assert.deepEqual(sessionClientCount('s', {run: run({status: 0, stdout: 'garbage\n'})}), {ok: false, code: 'tmux-output-unreadable'});
  assert.deepEqual(sessionClientCount('s', {run: () => { throw Object.assign(new Error('x'), {code: 'EX'}); }}), {ok: false, code: 'EX'});
  assert.deepEqual(sessionClientCount('s', {run: () => { throw new Error('no code'); }}), {ok: false, code: 'tmux-error'});
});

// ---- fix2: 0개를 읽은 뒤 옛 탭이 늦게 붙는 경합 (2026-11-21 검수 changes) ----
// 가짜 로티: show는 호출 차례대로 답하고(마지막 답을 반복), create는 차례대로 답하며, remove·close는 대상 ID별로 정한다.
// calls는 'status' · 'show <id>' · 'create' · 'remove <id>' · 'close <id>' 순서 기록이다.
function scriptedRottie({shows = [shownState('unknown')], creates = [{id: 'new-tab'}], remove = {}, close = {}} = {}) {
  const calls = []; const createArgs = [];
  let shown = 0, made = 0;
  const json = (value, status = 0) => ({status, stdout: JSON.stringify(value)});
  const verdict = (table, id) => { const r = table[id] ?? {ok: true}; return r.ok === false ? json({ok: false, error: {code: r.code}}, 3) : json({ok: true}); };
  const run = (bin, args) => {
    const at = args.indexOf('--terminal');
    const id = at >= 0 ? args[at + 1] : null;
    calls.push(args[0] === 'status' ? 'status' : `${args[1]}${id ? ` ${id}` : ''}`);
    if (args[0] === 'status') return json({ok: true, runtime: {bundleId: 'dev.fixture'}});
    if (args[1] === 'show') return json(shows[Math.min(shown++, shows.length - 1)]);
    if (args[1] === 'create') {
      createArgs.push(args);
      const made_ = creates[Math.min(made++, creates.length - 1)];
      return made_.id ? json({ok: true, result: {terminal: {id: made_.id, pid: 1}}}) : json({ok: false, error: {code: made_.code}});
    }
    if (args[1] === 'remove') return verdict(remove, id);
    if (args[1] === 'close') return verdict(close, id);
    return {status: 1, stdout: ''};
  };
  return {calls, createArgs, run};
}
const zeroScreens = () => ({ok: true, count: 0});
const runCycle = async (fake, {entries = inheritedHidden(), clients = zeroScreens} = {}) => {
  const recorded = [];
  const result = await attachWith(entries, fake, e => { recorded.push(e); entries.push(e); }, clients);
  return {result, recorded, entries};
};
const RACED_LINE = detail => `비서 로티 탭 붙이기 실패: tab-raced (${detail})`;

test('W1: the old tab comes back after the 0-screen read — the new tab is closed and removed, nothing is recorded as attached', async () => {
  const {attachFailureLine} = await import('../src/secretary-tab.mjs');
  const fake = scriptedRottie({shows: [shownState('unknown'), shownState('running')]});
  const {result, recorded, entries} = await runCycle(fake);
  assert.deepEqual([result.attached, result.reason], [false, 'tab-raced']);
  assert.deepEqual(fake.calls, ['status', 'show old', 'create', 'show old', 'close new-tab', 'remove new-tab']); // 옛 탭은 건드리지 않는다
  assert.equal(recorded.length, 0);
  const detail = '옛 탭 old · 새 탭 new-tab: 옛 탭이 다시 running; 새 탭 닫고 제거함';
  assert.equal(result.detail, detail);
  assert.equal(attachFailureLine(result), RACED_LINE(detail));
  // 다음 주기: 옛 탭이 running이니 아무것도 열지 않는다(탭 하나, 옛 탭).
  const next = scriptedRottie({shows: [shownState('running')]});
  const again = await runCycle(next, {entries});
  assert.deepEqual([again.result.reason, next.calls], ['tab-alive', ['status', 'show old']]);
  assert.equal(attachFailureLine(again.result), null);
});

test('W2: a refused old-tab removal means the old tab may be alive — the new tab is cleaned up and nothing is recorded', async () => {
  const {attachFailureLine} = await import('../src/secretary-tab.mjs');
  for (const code of ['ROTTIE_TERMINAL_RUNNING', 'ROTTIE_TERMINAL_QUERY_FAILED']) {   // 어떤 거절이든 성공으로 보지 않는다
    const fake = scriptedRottie({remove: {old: {ok: false, code}}});
    const {result, recorded} = await runCycle(fake);
    assert.deepEqual([result.attached, result.reason], [false, 'tab-raced'], code);
    assert.deepEqual(fake.calls, ['status', 'show old', 'create', 'show old', 'remove old', 'close new-tab', 'remove new-tab'], code);
    assert.equal(recorded.length, 0, code);
    assert.equal(attachFailureLine(result), RACED_LINE(`옛 탭 old · 새 탭 new-tab: 옛 탭 제거 거절 code=${code}; 새 탭 닫고 제거함`));
  }
});

test('W3: normal swap — the old tab is gone after the re-check (removed or NOT_FOUND): one record, one tab, next cycle opens nothing', async () => {
  for (const remove of [{}, {old: {ok: false, code: 'ROTTIE_TERMINAL_NOT_FOUND'}}]) {
    const fake = scriptedRottie({remove});
    const {result, recorded, entries} = await runCycle(fake);
    assert.deepEqual([result.attached, result.rottieTerminalId, result.restoredFrom, result.oldState], [true, 'new-tab', 'old', 'unknown']);
    assert.deepEqual(fake.calls, ['status', 'show old', 'create', 'show old', 'remove old']);          // 새 탭은 건드리지 않는다
    assert.deepEqual(recorded.map(e => [e.kind, e.rottieTerminalId, e.restoredFrom, e.oldState]), [['window', 'new-tab', 'old', 'unknown']]);
    const next = scriptedRottie();
    assert.equal((await runCycle(next, {entries})).result.reason, 'has-tab');
    assert.equal(next.calls.length, 0);
  }
});

test('W4: when the new tab cannot be cleaned up either, nothing is recorded and both ids and codes are in the log line', async () => {
  const {attachFailureLine} = await import('../src/secretary-tab.mjs');
  const closeFails = scriptedRottie({shows: [shownState('unknown'), shownState('running')], close: {'new-tab': {ok: false, code: 'ROTTIE_CLOSE_FAILED'}}});
  const a = await runCycle(closeFails);
  assert.deepEqual([a.result.attached, a.result.reason, a.recorded.length], [false, 'tab-raced', 0]);
  assert.deepEqual(closeFails.calls, ['status', 'show old', 'create', 'show old', 'close new-tab']);     // 닫지 못했으면 remove는 시도하지 않는다
  assert.equal(attachFailureLine(a.result),
    RACED_LINE('옛 탭 old · 새 탭 new-tab: 옛 탭이 다시 running; 새 탭 닫기 실패 code=ROTTIE_CLOSE_FAILED (새 탭이 남아 있을 수 있어 사람 확인 필요)'));
  const removeFails = scriptedRottie({shows: [shownState('unknown'), shownState('created')], remove: {'new-tab': {ok: false, code: 'ROTTIE_TERMINAL_RUNNING'}}});
  const b = await runCycle(removeFails);
  assert.deepEqual([b.result.attached, b.result.reason, b.recorded.length], [false, 'tab-raced', 0]);
  assert.equal(attachFailureLine(b.result),
    RACED_LINE('옛 탭 old · 새 탭 new-tab: 옛 탭이 다시 created; 새 탭 닫음, 제거 실패 code=ROTTIE_TERMINAL_RUNNING (종료됨으로 남음)'));
  // 같은 원인은 비서 줄 칸에서 한 번만 남는다.
  const {changedOutput} = await import('../src/revive.mjs');
  const home = fs.mkdtempSync(path.join(process.env.KADAN_HOME, 'w4-'));
  const line = attachFailureLine(b.result);
  assert.deepEqual(changedOutput(home, [line], 'lastSecretaryOutput'), [line]);
  assert.deepEqual(changedOutput(home, [line], 'lastSecretaryOutput'), []);
});

test('W5: exited and gone tabs keep their old behaviour (no second show, old removal result not judged)', async () => {
  const exited = scriptedRottie({shows: [shownState('exited')], remove: {old: {ok: false, code: 'ROTTIE_TERMINAL_RUNNING'}}});
  const a = await runCycle(exited, {clients: () => { throw new Error('exited는 tmux에 묻지 않는다'); }});
  assert.deepEqual([a.result.attached, a.result.rottieTerminalId, a.result.oldState], [true, 'new-tab', 'exited']);
  assert.deepEqual(exited.calls, ['status', 'show old', 'create', 'remove old']);
  const gone = scriptedRottie({shows: [{ok: false, error: {code: 'ROTTIE_TERMINAL_NOT_FOUND'}}]});
  const b = await runCycle(gone, {clients: () => { throw new Error('없는 탭은 tmux에 묻지 않는다'); }});
  assert.deepEqual([b.result.attached, b.result.oldState], [true, '없음']);
  assert.deepEqual(gone.calls, ['status', 'show old', 'create']);
});

test('W6: after a raced cleanup the same generation may open again — an idempotency-key conflict is retried once with a new key', async () => {
  const fake = scriptedRottie({creates: [{code: 'ROTTIE_IDEMPOTENCY_CONFLICT'}, {id: 'new-tab'}]});
  const {result} = await runCycle(fake);
  assert.deepEqual([result.attached, result.rottieTerminalId], [true, 'new-tab']);
  const keys = fake.createArgs.map(args => args[args.indexOf('--idempotency-key') + 1]);
  assert.deepEqual(keys, ['kadan-kadan-비서-30', 'kadan-kadan-비서-30-secretary-retry']);
});

test('W7: the secretary line is deduplicated on its own, not together with the rest of the cycle output', async () => {
  const {changedOutput, readReviveState} = await import('../src/revive.mjs');
  const home = fs.mkdtempSync(path.join(process.env.KADAN_HOME, 'w7-'));
  const S = '비서 로티 탭 붙이기 실패: tab-unknown (탭 old show 응답 state=unknown · tmux 붙은 화면 1개)';
  const W = '감시기: 다시 띄움(이번 1시간 1번째)';
  const cycle = (block, secretary) => [...changedOutput(home, block), ...changedOutput(home, secretary, 'lastSecretaryOutput')];
  assert.deepEqual(cycle([W], [S]), [W, S]);        // 처음
  assert.deepEqual(cycle([], [S]), []);             // 감시기 줄이 빠져도 같은 비서 줄은 다시 나오지 않는다
  assert.deepEqual(cycle([W], [S]), [W]);           // 감시기 줄이 다시 끼어도 비서 줄은 나오지 않는다
  assert.deepEqual(cycle([], []), []);              // 조용한 주기는 비서 칸을 비운다
  assert.deepEqual(cycle([], [S]), [S]);            // 그 뒤 같은 원인이 다시 오면 한 번 더
  const state = readReviveState(home);
  assert.equal(state.corrupt, undefined); assert.equal(state.lastSecretaryOutput, S);
  // 옛 방식(한 묶음)은 두 번째 주기에 같은 비서 줄을 다시 낸다: 이 시험이 막는 회귀.
  const joined = fs.mkdtempSync(path.join(process.env.KADAN_HOME, 'w7b-'));
  assert.deepEqual(changedOutput(joined, [W, S]), [W, S]);
  assert.deepEqual(changedOutput(joined, [S]), [S]);
  // 새 칸의 모양이 틀리면 손상으로 본다(다른 칸과 같은 기준).
  fs.writeFileSync(path.join(home, 'revive-state.json'), JSON.stringify({lastSecretaryOutput: 5}));
  assert.equal(readReviveState(home).corrupt, true);
});
