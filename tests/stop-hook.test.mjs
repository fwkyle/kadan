import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {handleStopHook} from '../src/stop-hook.mjs';
import {appendSpool, readSpool, hookDoneSince, spoolPath} from '../src/stop-hook-spool.mjs';
import {withStopHook, writeClaudeSettings, claudeSettingsPath, claudeSettingsBody, HOOK_SCRIPT} from '../src/stop-hook-settings.mjs';
import {withInlineScreen, withoutInlineScreen} from '../src/inline-screen.mjs';
import {launchIdentityOf, matchesAiProcess, commandWords} from '../src/ai-identity.mjs';
import {launchFor} from '../src/runner-settings.mjs';
import {buildTmuxCreateArgv} from '../src/floor-tmux.mjs';
import {rebuildResumeCommand} from '../src/runner-table.mjs';
import {conversationOf} from '../src/conversation-ref.mjs';
import {codexStopHookTrust, assessStopHookTrust, codexHookCommand} from '../src/stop-hook-codex-trust.mjs';
import {collectRoles} from '../src/watch-roles.mjs';
import {screenDoneResult, runWaitLoop} from '../src/cli-wait-done.mjs';
import {explainAlertRoute} from '../src/watch.mjs';
import {formatAlertBody} from '../src/watch-alert-body.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-stop-hook-'));
const input = (message, extra = {}) => JSON.stringify({hook_event_name: 'Stop', session_id: 's1', last_assistant_message: message, ...extra});
const claudeInput = (message, extra) => input(message, {prompt_id: 'p1', effort: 'low', ...extra});
const codexInput = (message, extra) => input(message, {turn_id: 't1', model: 'm', ...extra});
const fixed = () => new Date('2026-10-18T10:00:00.000Z');

test('훅: KADAN_ROLE이 없거나 Stop이 아니거나 마커가 없으면 아무것도 쓰지 않는다', () => {
  const home = tmp();
  const env = {KADAN_ROLE: 'r', KADAN_HOME: home};
  assert.equal(handleStopHook(claudeInput('KADAN:DONE a ok'), {KADAN_HOME: home}, fixed), 0); // 개인 실행기
  assert.equal(handleStopHook(input('KADAN:DONE a ok', {hook_event_name: 'SessionStart'}), env, fixed), 0);
  assert.equal(handleStopHook(claudeInput('그냥 응답'), env, fixed), 0);
  assert.equal(handleStopHook('not json', env, fixed), 0);
  assert.equal(handleStopHook(JSON.stringify({hook_event_name: 'Stop'}), env, fixed), 0);
  assert.equal(fs.existsSync(spoolPath(home)), false);
});

test('훅: 마커 줄만 기록하고 응답 본문은 저장하지 않는다. 실행기는 입력 키로 가른다', () => {
  const home = tmp();
  const env = {KADAN_ROLE: 'p-worker', KADAN_HOME: home};
  const body = '비밀 같은 긴 응답 본문 SECRET-BODY\n⏺ KADAN:DONE card-a ok\n';
  assert.equal(handleStopHook(claudeInput(body), env, fixed), 1);
  assert.equal(handleStopHook(codexInput('• KADAN:DONE card-b failed'), env, fixed), 1);
  const rows = readSpool(home);
  assert.deepEqual(rows, [
    {at: '2026-10-18T10:00:00.000Z', role: 'p-worker', harness: 'claude', sessionId: 's1', taskId: 'card-a', result: 'ok'},
    {at: '2026-10-18T10:00:00.000Z', role: 'p-worker', harness: 'codex', sessionId: 's1', taskId: 'card-b', result: 'failed'},
  ]);
  assert.ok(!fs.readFileSync(spoolPath(home), 'utf8').includes('SECRET-BODY'));
});

test('훅 감싸개: 어떤 입력에서도 종료 0이고, 마커가 있으면 spool에 한 줄이 남는다', () => {
  const home = tmp();
  const run = (stdin, role) => spawnSync('/bin/sh', [HOOK_SCRIPT], {input: stdin, encoding: 'utf8',
    env: {PATH: process.env.PATH, HOME: os.homedir(), KADAN_HOME: home, ...(role ? {KADAN_ROLE: role} : {})}});
  assert.equal(run('garbage', 'r').status, 0);
  assert.equal(run(claudeInput('KADAN:DONE a ok')).status, 0);
  assert.equal(readSpool(home).length, 0);
  const done = run(claudeInput('끝\nKADAN:DONE a ok'), 'r');
  assert.equal(done.status, 0);
  assert.equal(readSpool(home).length, 1);
});

test('spool 조회: 같은 역할·발령 뒤·같은 카드만 증거로 친다', () => {
  const home = tmp();
  const row = (at, role, taskId, result = 'ok') => appendSpool(home, {at, role, harness: 'claude', sessionId: 's', taskId, result});
  row('2026-10-18T09:00:00.000Z', 'r', 'a');         // 발령 전
  row('2026-10-18T10:05:00.000Z', 'other', 'a');     // 다른 역할
  row('2026-10-18T10:06:00.000Z', 'r', 'b');         // 다른 카드
  row('2026-10-18T10:07:00.000Z', 'r', 'a', 'failed');
  fs.appendFileSync(spoolPath(home), 'broken line\n{"at":"x"}\n');
  const since = '2026-10-18T10:00:00.000Z';
  assert.deepEqual(hookDoneSince({home, role: 'r', since, taskMatches: id => id === 'a'}),
    [{taskId: 'a', result: 'failed', at: '2026-10-18T10:07:00.000Z', via: 'hook'}]);
  assert.deepEqual(hookDoneSince({home, role: 'r', since: 'bad', taskMatches: () => true}), []);
  assert.deepEqual(hookDoneSince({home: tmp(), role: 'r', since, taskMatches: () => true}), []);
});

const CLAUDE = 'claude --model claude-fable-5-1 --effort high';

test('claude 주입: 설정 파일이 있을 때만, 실행 파일 바로 뒤에 한 번만 끼운다', () => {
  const home = tmp();
  assert.equal(withStopHook(CLAUDE, home), CLAUDE); // 파일 없음 = 지금과 똑같다
  const {path: file, changed} = writeClaudeSettings(home);
  assert.equal(changed, true);
  assert.equal(writeClaudeSettings(home).changed, false);
  assert.equal(file, claudeSettingsPath(home));
  assert.equal(fs.readFileSync(file, 'utf8'), claudeSettingsBody());
  const hooked = withStopHook(CLAUDE, home);
  assert.equal(hooked, `claude --settings '${file}' --model claude-fable-5-1 --effort high`);
  assert.equal(withStopHook(hooked, home), hooked);
  assert.equal(withStopHook('claude --settings /x.json --model m', home), 'claude --settings /x.json --model m'); // 사람 설정은 건드리지 않는다
  assert.equal(withStopHook('LC_ALL=C /opt/bin/claude --model m "첫 프롬프트"', home),
    `LC_ALL=C /opt/bin/claude --settings '${file}' --model m "첫 프롬프트"`);
  assert.equal(withStopHook('"/opt/my bin/claude" --model m', home), `"/opt/my bin/claude" --settings '${file}' --model m`);
  for (const cmd of ['codex --model m', 'cat', 'claude --model m && echo hi', '', undefined]) assert.equal(withStopHook(cmd, home), cmd, String(cmd));
});

test('claude 주입: 신원 비교·모델 판독·프로세스 대조는 붙은 플래그에 흔들리지 않는다', () => {
  const home = tmp();
  writeClaudeSettings(home);
  const hooked = withStopHook(CLAUDE, home);
  assert.deepEqual(launchIdentityOf(hooked), {ok: true, harness: 'claude', model: 'claude-fable-5-1'});
  assert.equal(matchesAiProcess(hooked, 'claude', 'claude-fable-5-1'), true);
  assert.equal(matchesAiProcess(hooked, 'claude', 'other-model'), false); // 모델 다름 = 거절
  assert.equal(withoutInlineScreen(hooked), withoutInlineScreen(CLAUDE));
  assert.equal(withoutInlineScreen(withInlineScreen(hooked)), withoutInlineScreen(CLAUDE));
  assert.notEqual(withoutInlineScreen(`${hooked} --extra`), withoutInlineScreen(CLAUDE)); // 다른 인자는 여전히 다르다
  assert.notEqual(withoutInlineScreen(hooked.replace('--effort high', '--effort low')), withoutInlineScreen(CLAUDE)); // 강도 다름 = 경고
  // `=` 꼴과 사람이 준 다른 --settings는 걷어내지 않는다
  assert.equal(withoutInlineScreen(`claude --settings=${claudeSettingsPath(home)} --model m`), withoutInlineScreen('claude --model m'));
  assert.notEqual(withoutInlineScreen('claude --settings /mine.json --model m'), withoutInlineScreen('claude --model m'));
});

test('claude 주입: 실행 모델 설정(fill)이 만든 기본 명령도 같은 꼴이라 옛 세션과 같은 명령으로 본다', () => {
  const home = tmp(), old = process.env.KADAN_HOME;
  process.env.KADAN_HOME = home;
  try {
    const settings = {revision: 1, activePreset: 'B',
      runners: {claude: {spawn: 'claude --model {model} --effort {effort}'}, codex: {spawn: 'codex --model {model}'}},
      presets: {B: {roles: {reviewer: {runner: 'claude', model: 'claude-fable-5-1', effort: 'high'},
        worker: {runner: 'codex', model: 'gpt-6-sol'}}}}};
    const before = launchFor(settings, 'reviewer').cmd;
    assert.equal(before, CLAUDE);
    writeClaudeSettings(home);
    const after = launchFor(settings, 'reviewer').cmd;
    assert.notEqual(after, before);
    assert.equal(withoutInlineScreen(after), withoutInlineScreen(before)); // dispatch-runner-guard가 쓰는 비교
    assert.equal(launchFor(settings, 'worker').cmd, withInlineScreen('codex --model gpt-6-sol')); // codex는 그대로
  } finally {
    if (old === undefined) delete process.env.KADAN_HOME; else process.env.KADAN_HOME = old;
  }
});

test('restart 재조립: 붙은 --settings를 지키고 resume 꼬리만 바꾼다. 다시 불러도 한 번만 붙는다', () => {
  const home = tmp();
  writeClaudeSettings(home);
  const settings = {runners: {claude: {spawn: 'claude --model {model}', resume: 'claude --model {model} --resume {conversation}'}}};
  const id = '0197aaaa-1111-4222-8333-444455556666';
  const old = withStopHook('claude --model claude-fable-5-1', home);
  const rebuilt = withStopHook(withInlineScreen(rebuildResumeCommand(settings, 'claude', old, id)), home);
  assert.deepEqual(commandWords(rebuilt), commandWords(`${old} --resume ${id}`)); // 재조립은 따옴표를 다시 쓸 수 있어 낱말로 견준다
  assert.equal(rebuilt.split('--settings').length, 2);
  assert.deepEqual(conversationOf(rebuilt), {conversationMode: 'resume', conversationRef: id});
  assert.deepEqual(launchIdentityOf(rebuilt), {ok: true, harness: 'claude', model: 'claude-fable-5-1'});
  // 훅 도입 전 옛 start 줄에서 다시 열면 이번에 붙는다
  const fromOld = withStopHook(withInlineScreen(rebuildResumeCommand(settings, 'claude', 'claude --model claude-fable-5-1', id)), home);
  assert.deepEqual(commandWords(fromOld), commandWords(rebuilt));
});

test('역할 프로세스 환경: KADAN_HOME은 넘겨받은 값이 있을 때만 tmux -e로 넣는다', () => {
  const base = {session: 'kadan-x', role: 'x', cwd: '/tmp', cmd: 'codex --model m'};
  assert.ok(!buildTmuxCreateArgv(base).some(arg => arg.startsWith('KADAN_HOME=')));
  const argv = buildTmuxCreateArgv({...base, home: '/h/k'});
  assert.deepEqual(argv.slice(argv.indexOf('KADAN_ROLE=x') - 1, argv.indexOf('KADAN_ROLE=x') + 3), ['-e', 'KADAN_ROLE=x', '-e', 'KADAN_HOME=/h/k']);
});

// --- 소비처 ---
const role = 'p-worker', session = `kadan-${role}`;
const start = {kind: 'start', role, session, panePid: 1, t: '2026-10-18T09:00:00Z'};
const dispatch = {kind: 'send', role, session, taskId: 'a', executionKey: 'repo/a', baselineMarkers: [], t: '2026-10-18T10:00:00Z'};
const cards = [{id: 'a', key: 'repo/a'}, {id: 'b', key: 'repo/b'}];
const screenOf = text => ({list: () => [{session, pid: 1}], read: () => text});
const hookRow = (home, extra = {}) => appendSpool(home, {at: '2026-10-18T10:05:00.000Z', role, harness: 'codex', sessionId: 's',
  taskId: 'a', result: 'ok', ...extra});

test('감시: 화면에 마커가 없어도(#57·#180 꼴) 훅 증거가 있으면 완료로 읽고 hook이라 적는다', () => {
  const home = tmp();
  const noMarkerScreen = '작업을 마쳤다\n› 입력창\ngpt-6 · 바닥글 모양이 바뀜';
  const quiet = collectRoles(screenOf(noMarkerScreen), [start, dispatch], null, cards, {hookHome: home}).observations.get(session);
  assert.equal(quiet.doneMarker, null);
  assert.equal(quiet.doneSource, null);
  hookRow(home);
  const hooked = collectRoles(screenOf(noMarkerScreen), [start, dispatch], null, cards, {hookHome: home}).observations.get(session);
  assert.deepEqual(hooked.doneMarker, {taskId: 'a', result: 'ok'});
  assert.equal(hooked.doneSource, 'hook');
});

test('감시: 다른 역할·발령 전·다른 카드의 훅 증거는 무시하고, 없으면 화면 판정이 그대로다', () => {
  const home = tmp();
  hookRow(home, {role: 'p-other'});
  hookRow(home, {at: '2026-10-18T09:59:00.000Z'});
  hookRow(home, {taskId: 'b'});
  const screen = '⏺ KADAN:DONE a failed\n';
  const seen = collectRoles(screenOf(screen), [start, dispatch], null, cards, {hookHome: home}).observations.get(session);
  assert.deepEqual(seen.doneMarker, {taskId: 'a', result: 'failed'});
  assert.equal(seen.doneSource, 'screen');
  // 다른 세대(재시작) 뒤의 발령 없는 새 세션은 옛 증거로 완료가 되지 않는다
  const restarted = [start, dispatch, {...start, panePid: 2, t: '2026-10-18T10:30:00Z'}];
  hookRow(home);
  const fresh = collectRoles({list: () => [{session, pid: 2}], read: () => '대기'}, restarted, null, cards, {hookHome: home}).observations.get(session);
  assert.equal(fresh.doneMarker, null);
});

test('감독 확정(--from-screen): 훅 증거를 먼저 보고 via를 돌려준다', () => {
  const home = tmp();
  const check = hookHome => screenDoneResult({text: '아직 마커 없음', entries: [start, dispatch], role, taskId: 'repo/a', cards, hookHome});
  assert.equal(check(home).result, null);
  hookRow(home, {result: 'failed'});
  const hooked = check(home);
  assert.equal(hooked.result, 'failed');
  assert.equal(hooked.via, 'hook');
  assert.equal(check(null).result, null); // hookHome이 없으면 지금 동작
  const screenOnly = screenDoneResult({text: 'KADAN:DONE a ok', entries: [start, dispatch], role, taskId: 'repo/a', cards, hookHome: tmp()});
  assert.equal(screenOnly.result, 'ok');
  assert.equal(screenOnly.via, undefined);
});

test('kadan wait: 화면이 안 바뀌어도 훅 증거가 발령 뒤에 있으면 완료로 끝내고 원장 done에 via를 남긴다', () => {
  const home = tmp(), recorded = [];
  hookRow(home);
  const floor = {name: 'fake', read: () => ({text: '변화 없음', cursor: 'c', incremental: false}), waitForChange() {}};
  const result = runWaitLoop({floor, session, role, intervalMs: 1, timeoutMs: 1000, quietMs: 500, baselineMarkers: [],
    cards, record: entry => recorded.push(entry), hook: {home, since: dispatch.t}});
  assert.equal(result.code, 0);
  assert.equal(result.via, 'hook');
  assert.deepEqual(recorded.map(e => [e.kind, e.taskId, e.result, e.via]), [['done', 'a', 'ok', 'hook']]);
  const plain = runWaitLoop({floor: {...floor, read: () => ({text: 'KADAN:DONE a ok', cursor: 'c', incremental: false})}, session, role,
    intervalMs: 1, timeoutMs: 1000, quietMs: 500, baselineMarkers: [], cards, record: () => {}, hook: {home: tmp(), since: dispatch.t}});
  assert.equal(plain.via, 'screen');
});

// --- codex 신뢰 확인(읽기 전용, 가짜 CODEX_HOME) ---
function fakeCodexHome({groups, trusted}) {
  const home = tmp();
  fs.writeFileSync(path.join(home, 'hooks.json'), JSON.stringify({hooks: {Stop: groups}}));
  const lines = ['model = "x"', '', '[hooks.state]'];
  for (const key of trusted ?? []) lines.push('', `[hooks.state."${key}"]`, 'trusted_hash = "sha256:abc123"');
  lines.push('', '[tui]', 'x = 1');
  fs.writeFileSync(path.join(home, 'config.toml'), `${lines.join('\n')}\n`);
  return home;
}
const group = command => ({hooks: [{type: 'command', command, timeout: 10}]});

test('codex 신뢰: 설치 위치(그룹·훅 순번)는 hooks.json에서 읽고 [hooks.state] 항목으로 신뢰를 본다', () => {
  const script = '/main/scripts/stop-hook.sh';
  const ours = codexHookCommand(script), memory = group("/bin/sh '/x/memory-hook.sh'");
  assert.deepEqual(codexStopHookTrust({home: tmp(), script}), {state: 'no-hooks-file'});
  const none = fakeCodexHome({groups: [memory]});
  assert.deepEqual(codexStopHookTrust({home: none, script}), {state: 'not-installed'});
  const other = fakeCodexHome({groups: [memory, group("/bin/sh '/old/scripts/stop-hook.sh'")]});
  assert.equal(codexStopHookTrust({home: other, script}).state, 'other-path');
  // 배열 끝에 새 그룹으로 붙이면 키는 :stop:1:0 이다(:stop:0:1 이 아니다)
  const home = fakeCodexHome({groups: [memory, group(ours)]});
  const key = `${path.join(home, 'hooks.json')}:stop:1:0`;
  assert.deepEqual(codexStopHookTrust({home, script}), {state: 'untrusted', key});
  const memoryOnly = fakeCodexHome({groups: [memory, group(ours)], trusted: [`${path.join(home, 'hooks.json')}:stop:0:0`]});
  assert.equal(codexStopHookTrust({home: memoryOnly, script}).state, 'untrusted'); // 다른 훅의 신뢰는 우리 것이 아니다
  const trustedHome = fakeCodexHome({groups: [memory, group(ours)]});
  fs.appendFileSync(path.join(trustedHome, 'config.toml'), `\n[hooks.state."${path.join(trustedHome, 'hooks.json')}:stop:1:0"]\ntrusted_hash = "sha256:abc123"\n`);
  assert.equal(codexStopHookTrust({home: trustedHome, script}).state, 'trusted');
  assert.deepEqual(codexStopHookTrust({home: fs.mkdtempSync(path.join(os.tmpdir(), 'x-')), script}), {state: 'no-hooks-file'});
});

test('codex 신뢰 경보: 훅을 켠 기계에서 신뢰가 아닐 때만, 상태당 같은 id 하나, 사용자에게만 간다', () => {
  assert.deepEqual(assessStopHookTrust({enabled: false, trust: {state: 'untrusted'}}), []);
  assert.deepEqual(assessStopHookTrust({enabled: true, trust: {state: 'trusted'}}), []);
  const [alert] = assessStopHookTrust({enabled: true, trust: {state: 'untrusted', key: 'k'}});
  assert.equal(alert.id, 'stop-hook:untrusted');
  assert.equal(alert.kind, '훅신뢰');
  assert.equal(assessStopHookTrust({enabled: true, trust: {state: 'untrusted'}})[0].id, alert.id);
  assert.equal(explainAlertRoute(alert, new Map(), [], 'p-super').recipient, '@user');
  assert.match(formatAlertBody(alert), /Stop 훅 신뢰 필요/);
});

test('kadan stop-hook: claude-settings는 홈 안에 파일 하나만 만들고 status는 읽기만 한다', async () => {
  const {cmdStopHook} = await import('../src/commands/stop-hook.mjs');
  const home = tmp(), lines = [], print = line => lines.push(line);
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tmp(); // 가짜 codex 홈: 운영 ~/.codex를 읽지 않는다
  try {
    cmdStopHook(['status'], {}, {home, print});
    assert.match(lines.at(-1), /claude 설정 파일: 없음/);
    assert.match(lines.at(-1), /no-hooks-file/);
    assert.deepEqual(fs.readdirSync(home), []); // status는 아무것도 만들지 않는다
    cmdStopHook(['claude-settings'], {}, {home, print});
    assert.match(lines.at(-1), /^만들었다/);
    assert.deepEqual(fs.readdirSync(home), ['stop-hook']);
    cmdStopHook(['claude-settings'], {}, {home, print});
    assert.match(lines.at(-1), /^이미 같은 내용이다/);
    cmdStopHook(['status'], {}, {home, print});
    assert.match(lines.at(-1), /claude 설정 파일: 있음/);
  } finally {
    if (before === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before;
  }
});
