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
const ctx = {home: '/fixture-home', env: {KADAN_WINDOW: 'rottie'}, entries: [], session: 'kadan-비서', role: '비서',
  cwd: '/tmp', panePid: '30', platform: 'darwin', readSetting: () => SETTING, open: undefined};
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
const attachWith = async (entries, fake, record) => {
  const open = await realOpen();
  return attachHiddenSecretary({home: 'h', floor: {pid: () => '30'}, session: 'kadan-비서', readEntries: () => entries,
    record, readSetting: () => SETTING,
    open: c => openSecretaryTab({...c, env: {KADAN_WINDOW: 'rottie'}, platform: 'darwin', readSetting: () => SETTING, run: fake.run, open})});
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
    open: c => openSecretaryTab({...c, env, platform: 'darwin', readSetting: () => SETTING, run: fake.run, open})});
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
