import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {handleStopHook, lastLineMarker, mayBeSameRun} from '../src/stop-hook.mjs';
import {appendSpool, readSpool, hookDoneSince, spoolPath} from '../src/stop-hook-spool.mjs';
import {withStopHook, writeClaudeSettings, claudeSettingsPath, claudeProfileSettingsPath, DENIED_MCP_SERVERS, withProfileStopHookOnRestart, hasMcpOptions, claudeSettingsBody, shellQuote, hookCommand, HOOK_SCRIPT} from '../src/stop-hook-settings.mjs';
import {withInlineScreen, withoutInlineScreen} from '../src/inline-screen.mjs';
import {launchIdentityOf, matchesAiProcess, commandWords} from '../src/ai-identity.mjs';
import {launchFor} from '../src/runner-settings.mjs';
import {buildTmuxCreateArgv} from '../src/floor-tmux.mjs';
import {rebuildResumeCommand} from '../src/runner-table.mjs';
import {conversationOf} from '../src/conversation-ref.mjs';
import {codexStopHookTrust, assessStopHookTrust, codexHookCommand} from '../src/stop-hook-codex-trust.mjs';
import {collectRoles} from '../src/watch-roles.mjs';
import {screenDoneResult, runWaitLoop, hookTaskMatcher} from '../src/cli-wait-done.mjs';
import {explainAlertRoute} from '../src/watch.mjs';
import {formatAlertBody, recordAlert} from '../src/watch-alert-body.mjs';
import {openAlerts} from '../src/dashboard-band.mjs';

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
  const body = '비밀 같은 긴 응답 본문 SECRET-BODY\nKADAN:DONE card-a ok\n';
  assert.equal(handleStopHook(claudeInput(body), env, fixed), 1);
  assert.equal(handleStopHook(codexInput('KADAN:DONE card-b failed'), env, fixed), 1);
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
    cards, record: entry => recorded.push(entry), hook: {home, since: dispatch.t, taskMatches: hookTaskMatcher({cards, dispatch})}});
  assert.equal(result.code, 0);
  assert.equal(result.via, 'hook');
  assert.deepEqual(recorded.map(e => [e.kind, e.taskId, e.result, e.via]), [['done', 'a', 'ok', 'hook']]);
  const plain = runWaitLoop({floor: {...floor, read: () => ({text: 'KADAN:DONE a ok', cursor: 'c', incremental: false})}, session, role,
    intervalMs: 1, timeoutMs: 1000, quietMs: 500, baselineMarkers: [], cards, record: () => {}, hook: {home: tmp(), since: dispatch.t, taskMatches: hookTaskMatcher({cards, dispatch})}});
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

// --- PR #191 검수 수정 1라운드 ---
test('훅 규칙: 마지막 비어 있지 않은 줄이 마커일 때만 완료 — 응답 중간 인용은 기록하지 않는다', () => {
  const quoted = '이렇게 끝내라고 했다:\n```\nKADAN:DONE a ok\n```\n아직 작업 중이며 다음 턴에서 계속합니다';
  assert.equal(lastLineMarker(quoted), null);
  assert.equal(lastLineMarker('KADAN:DONE a ok\n```'), null); // 코드 블록 닫는 줄은 마지막 줄이 아니다
  assert.deepEqual(lastLineMarker('끝\nKADAN:DONE a ok  \n\n \n'), {taskId: 'a', result: 'ok', conflict: false}); // 뒤 공백은 허용
  assert.equal(lastLineMarker('끝\n  KADAN:DONE a ok'), null); // 3라운드: 앞 공백(들여쓰기)은 이제 훅이 아니다
  const home = tmp();
  assert.equal(handleStopHook(claudeInput(quoted), {KADAN_ROLE: 'r', KADAN_HOME: home}, fixed), 0);
  assert.equal(fs.existsSync(spoolPath(home)), false);
});

test('훅 규칙: 같은 실행의 failed·ok 상충은 conflict로 남고 소비처는 훅으로 판정하지 않는다', () => {
  const since = '2026-10-18T09:00:00.000Z', env = home => ({KADAN_ROLE: p, KADAN_HOME: home});
  const home = tmp();
  assert.equal(handleStopHook(claudeInput('KADAN:DONE a failed\n수정함\nKADAN:DONE a ok'), env(home), fixed), 1);
  assert.equal(readSpool(home)[0].conflict, true);
  assert.equal(readSpool(home)[0].result, 'ok');
  assert.deepEqual(hookDoneSince({home, role: p, since, taskMatches: id => id === 'a'}), []);
  // 같은 카드의 이전 정상 줄이 있어도 가장 최근 응답이 상충이면 쓰지 않는다
  const earlier = tmp();
  appendSpool(earlier, {at: '2026-10-18T09:30:00.000Z', role: p, harness: 'claude', sessionId: 's', taskId: 'a', result: 'ok'});
  handleStopHook(claudeInput('KADAN:DONE a failed\nKADAN:DONE a ok'), env(earlier), fixed);
  assert.deepEqual(hookDoneSince({home: earlier, role: p, since, taskMatches: id => id === 'a'}), []);
  // 다른 카드의 마커가 섞인 응답은 상충이 아니다
  const other = tmp();
  handleStopHook(claudeInput('KADAN:DONE b failed\nKADAN:DONE a ok'), env(other), fixed);
  assert.equal(readSpool(other)[0].conflict, undefined);
});
const p = 'p-worker';

test('화면 경로의 같은 입력 판정(바꾸지 않은 한계): 인용·상충도 화면은 마지막 마커를 완료로 읽는다', () => {
  const entries = [start, dispatch];
  const quoted = screenDoneResult({text: '```\nKADAN:DONE a ok\n```\n아직 작업 중', entries, role, taskId: 'repo/a', cards});
  assert.equal(quoted.result, 'ok');
  const both = screenDoneResult({text: 'KADAN:DONE a failed\nKADAN:DONE a ok', entries, role, taskId: 'repo/a', cards});
  assert.equal(both.result, 'ok');
  assert.equal(both.count, 2);
});

test('kadan wait: 같은 역할의 이전 실행 마커만 있으면 끝나지 않고 done도 기록하지 않는다', () => {
  const home = tmp(), recorded = [];
  hookRow(home, {taskId: 'b'}); // 현재 발령은 a
  const floor = {name: 'fake', read: () => ({text: '변화 없음', cursor: 'c', incremental: false}), waitForChange() {}};
  let clock = 0;
  const result = runWaitLoop({floor, session, role, intervalMs: 1, timeoutMs: 100, quietMs: 50, baselineMarkers: [], cards,
    record: entry => recorded.push(entry), now: () => (clock += 10),
    hook: {home, since: dispatch.t, taskMatches: hookTaskMatcher({cards, dispatch})}});
  assert.notEqual(result.code, 0);
  assert.deepEqual(recorded, []);
  // 카드 조건이 없으면(발령에 taskId가 없음) 훅 증거를 쓰지 않는다
  assert.equal(hookTaskMatcher({cards, dispatch: {t: dispatch.t}}), null);
  assert.deepEqual(hookDoneSince({home, role, since: dispatch.t}), []);
  // 정식 실행 주소로 적힌 같은 카드는 맞는다
  assert.equal(hookTaskMatcher({cards, dispatch})('repo/a'), true);
  assert.equal(hookTaskMatcher({cards, dispatch})('b'), false);
});

test('wait가 상충 응답에서 failed·ok를 둘 다 기록하지 않는다: 훅 증거는 마지막 하나, 상충이면 화면 판정', () => {
  const home = tmp(), recorded = [];
  hookRow(home, {result: 'failed', at: '2026-10-18T10:05:00.000Z'});
  hookRow(home, {result: 'ok', at: '2026-10-18T10:06:00.000Z'});
  const floor = {name: 'fake', read: () => ({text: '변화 없음', cursor: 'c', incremental: false}), waitForChange() {}};
  const result = runWaitLoop({floor, session, role, intervalMs: 1, timeoutMs: 1000, quietMs: 500, baselineMarkers: [], cards,
    record: entry => recorded.push(entry), hook: {home, since: dispatch.t, taskMatches: hookTaskMatcher({cards, dispatch})}});
  assert.equal(result.code, 0);
  assert.deepEqual(recorded.map(e => e.result), ['ok']);
});

test('셸 인용: 작은따옴표 경로는 큰따옴표로, 인용할 수 없으면 null — 만든 명령이 실제 /bin/sh -c로 종료 0이다', () => {
  assert.equal(shellQuote('/a b/c'), "'/a b/c'");
  assert.equal(shellQuote("/q'd dir/x"), '"/q\'d dir/x"');
  assert.equal(shellQuote(`/a'b"c`), null);
  assert.equal(shellQuote("/a'b$c"), null);
  assert.deepEqual(commandWords(`sh ${shellQuote("/q'd dir/x")}`), ['sh', "/q'd dir/x"]);
  const base = tmp(), dir = path.join(base, "quote'd dir", 'scripts');
  fs.mkdirSync(dir, {recursive: true});
  const script = path.join(dir, 'stop-hook.sh');
  fs.writeFileSync(script, '#!/bin/sh\nexit 0\n');
  for (const command of [hookCommand(script), JSON.parse(claudeSettingsBody(script)).hooks.Stop[0].hooks[0].command, codexHookCommand(script)]) {
    assert.equal(spawnSync('/bin/sh', ['-c', command]).status, 0, command);
  }
  assert.throws(() => hookCommand(`/a'b"c/x`), /인용/);
  // codex 신뢰 확인도 같은 명령 문자열로 찾는다
  const codex = fakeCodexHome({groups: [group(codexHookCommand(script))]});
  assert.equal(codexStopHookTrust({home: codex, script}).state, 'untrusted');
});

test('claude 주입: KADAN_HOME에 작은따옴표가 있어도 붙고, 인용할 수 없으면 조용히 빠지지 않고 경고한다', () => {
  const warnings = [];
  const quotedHome = path.join(tmp(), "user's home");
  writeClaudeSettings(quotedHome);
  const hooked = withStopHook(CLAUDE, quotedHome, m => warnings.push(m));
  assert.notEqual(hooked, CLAUDE);
  assert.equal(commandWords(hooked)[2], claudeSettingsPath(quotedHome));
  assert.deepEqual(launchIdentityOf(hooked), {ok: true, harness: 'claude', model: 'claude-fable-5-1'});
  assert.equal(withoutInlineScreen(hooked), withoutInlineScreen(CLAUDE));
  assert.deepEqual(warnings, []);
  const bad = path.join(tmp(), `a'b"c`);
  fs.mkdirSync(path.dirname(claudeSettingsPath(bad)), {recursive: true});
  fs.writeFileSync(claudeSettingsPath(bad), '{}');
  assert.equal(withStopHook(CLAUDE, bad, m => warnings.push(m)), CLAUDE);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Stop 훅을 붙이지 못했다/);
  // 파일이 없거나 claude가 아니면 경고하지 않는다(훅을 안 쓰는 기계)
  assert.equal(withStopHook(CLAUDE, tmp(), m => warnings.push(m)), CLAUDE);
  assert.equal(withStopHook('codex --model m', bad, m => warnings.push(m)), 'codex --model m');
  assert.equal(warnings.length, 1);
});

test('codex 신뢰 표 헤더 변형: 작은따옴표 키·점 주변 공백·주석을 같은 키로 읽고, 읽을 수 없으면 unknown', () => {
  const script = '/main/scripts/stop-hook.sh';
  const make = tomlFor => {
    const home = fakeCodexHome({groups: [group(codexHookCommand(script))]});
    const key = `${path.join(home, 'hooks.json')}:stop:0:0`;
    fs.writeFileSync(path.join(home, 'config.toml'), tomlFor(key));
    return codexStopHookTrust({home, script}).state;
  };
  const hash = 'trusted_hash = "sha256:abc123"';
  assert.equal(make(k => `[hooks.state."${k}"]\n${hash}\n`), 'trusted');
  assert.equal(make(k => `[hooks.state.'${k}']\n${hash}\n`), 'trusted');
  assert.equal(make(k => `[ hooks . state . "${k}" ]  # 메모\n${hash}\n`), 'trusted');
  assert.equal(make(k => `[hooks.state."${k}"]\ntrusted_hash = 'sha256:abc123'\n`), 'trusted');
  assert.equal(make(() => '[tui]\nx = 1\n'), 'untrusted'); // 읽을 수 있고 항목이 없다
  assert.equal(make(() => ''), 'untrusted');
  assert.equal(make(k => `[hooks.state]\n"${k}".trusted_hash = "sha256:abc123"\n`), 'unknown'); // 점으로 이은 키: 해석 불가
  assert.equal(make(k => `[hooks.state."${k}\\q"]\n${hash}\n`), 'unknown'); // 잘못된 이스케이프
  const [alert] = assessStopHookTrust({enabled: true, trust: {state: 'unknown'}});
  assert.equal(alert.id, 'stop-hook:unknown');
  assert.match(formatAlertBody(alert), /신뢰 확인 불가/);
  assert.equal(explainAlertRoute(alert, new Map(), [], 'p-super').recipient, '@user');
});

// --- PR #191 검수 수정 2라운드 ---
test('상충 검사: 짧은 ID와 정식 주소는 같은 실행일 수 있어 상충이고, 다른 저장소의 같은 조각은 섞지 않는다', () => {
  assert.equal(mayBeSameRun('current', 'fixture/current'), true);
  assert.equal(mayBeSameRun('fixture/current', 'fixture/current'), true);
  assert.equal(mayBeSameRun('a/x', 'b/x'), false);
  assert.equal(mayBeSameRun('a/x', 'x'), true); // 한쪽에 저장소가 없으면 같은 실행일 수 있다 — 소비처가 최종 판정
  assert.equal(mayBeSameRun('fixture/current', 'fixture/other'), false);
  assert.equal(lastLineMarker('KADAN:DONE fixture/current failed\nKADAN:DONE current ok').conflict, true);
  assert.equal(lastLineMarker('KADAN:DONE current failed\nKADAN:DONE fixture/current ok').conflict, true);
  assert.equal(lastLineMarker('KADAN:DONE a/x failed\nKADAN:DONE b/x ok').conflict, false);
  assert.equal(lastLineMarker('KADAN:DONE current ok\nKADAN:DONE fixture/current ok').conflict, false); // 같은 결과는 상충이 아니다
  // 소비처: 긴 주소로 적힌 상충도 현재 실행이면 훅으로 판정하지 않는다
  const home = tmp();
  handleStopHook(claudeInput('KADAN:DONE repo/a failed\nKADAN:DONE a ok'), {KADAN_ROLE: role, KADAN_HOME: home}, () => new Date('2026-10-18T10:05:00Z'));
  assert.deepEqual(hookDoneSince({home, role, since: dispatch.t, taskMatches: hookTaskMatcher({cards, dispatch})}), []);
});

test('훅 인정 규칙(애매하면 화면으로): 다섯 라운드의 검수자 재현은 모두 훅 완료가 아니고, 울타리 없는 정상 응답은 훅 완료다', () => {
  const none = text => assert.equal(lastLineMarker(text), null, JSON.stringify(text));
  // 1라운드: 인용 + 아직 작업 중 / 상충
  none('이렇게 끝내라고 했다:\n```\nKADAN:DONE a ok\n```\n아직 작업 중이며 다음 턴에서 계속합니다');
  assert.equal(lastLineMarker('KADAN:DONE a failed\n수정함\nKADAN:DONE a ok').conflict, true);
  // 2라운드: ID 혼합 상충(위 시험), 줄 시작 열린 울타리
  none('인용:\n```\n설명\nKADAN:DONE a ok');
  none('~~~\nKADAN:DONE a ok');
  // 3라운드: 목록 표식과 같은 줄에서 열린 울타리 + 들여쓴 마커
  none('- ```text\n  KADAN:DONE a ok');
  none('1. ```text\n   KADAN:DONE a ok');
  none('- ~~~\n  KADAN:DONE a ok');
  none('> ```\n> KADAN:DONE a ok');
  // 글자 종류가 섞여 짝이 안 맞는 경우, 길이가 다른 울타리, 닫는 줄 뒤 글
  none('```\n~~~\nKADAN:DONE a ok');
  none('````\n```\n안쪽\n```\nKADAN:DONE a ok');
  // 들여쓴 마커는 훅 아님(2라운드의 '들여쓰기도 훅'을 뒤집었다)
  none('끝\n    KADAN:DONE a ok');
  none('끝\n\tKADAN:DONE a ok');
  // 4라운드: 개수가 짝수인데 CommonMark상 열린 블록
  none('```text\n```python\nKADAN:DONE a ok');
  none('```text\n~~~\nKADAN:DONE a ok');
  none('```\n```js\nKADAN:DONE a ok');
  none('```\n``` 계속\nKADAN:DONE a ok');
  none('```\n``\x60`\n```\nKADAN:DONE a ok');
  // 5라운드: 한 줄 ~~~text~~~ 는 인라인이 아니라 정보 문자열 text~~~ 를 가진 여는 줄이다
  none('~~~text~~~\nKADAN:DONE a ok');
  none('``\x60text``\x60\nKADAN:DONE a ok');
  // 5라운드: 울타리가 하나라도 있으면 훅 아님 — 닫힌 블록이 앞에 있어도, 인라인 울타리도, 닫힌 ~~~ 블록도
  none('```\n코드\n```\n끝\nKADAN:DONE a ok');
  none('쓰기: ```KADAN:DONE a ok``` 라고\nKADAN:DONE a ok');
  none('~~~\n코드\n~~~\nKADAN:DONE a failed');
  none('```js\n코드\n```\n```\n또\n```\nKADAN:DONE a ok');
  none('```\r\n코드\r\n```\r\nKADAN:DONE a ok\r\n');
  // 정상 응답: 요약 → 빈 줄 → 마커, CRLF, 단일·이중 백틱 인라인
  assert.equal(lastLineMarker('작업을 마쳤다.\nKADAN:DONE a ok').result, 'ok'); // 맨 끝 줄 마커
  assert.equal(lastLineMarker('요약 문장이다.\n\nKADAN:DONE a failed').result, 'failed');
  assert.equal(lastLineMarker('요약 문장이다.\r\n\r\nKADAN:DONE a ok\r\n').result, 'ok');
  assert.equal(lastLineMarker('`x`를 고쳤고 ``y``도 봤다.\nKADAN:DONE a ok').result, 'ok');
});

test('훅 경로의 알려진 한계: 마커 뒤에 맺음말이 붙으면 훅 빠른 길이 아니라 화면 판정으로 간다', () => {
  const home = tmp();
  assert.equal(handleStopHook(claudeInput('KADAN:DONE a ok\n이상입니다.'), {KADAN_ROLE: role, KADAN_HOME: home}, fixed), 0);
  assert.equal(fs.existsSync(spoolPath(home)), false);
});

test('신뢰 경보 기록: unknown과 untrusted의 상태 설명이 원장 경보와 열린 경보 목록에 남고 설정 내용은 없다', () => {
  const entries = [];
  for (const state of ['unknown', 'untrusted']) {
    const [alert] = assessStopHookTrust({enabled: true, trust: {state, key: '/secret/config/path'}});
    recordAlert(e => entries.push({...e, t: '2026-10-18T10:00:00Z'}), alert, '@user', true);
  }
  const items = openAlerts(entries).items;
  const by = Object.fromEntries(items.map(i => [i.id, i]));
  assert.equal(by['stop-hook:unknown'].trustState, 'unknown');
  assert.match(by['stop-hook:unknown'].trustText, /읽지 못했다/);
  assert.equal(by['stop-hook:untrusted'].trustState, 'untrusted');
  assert.match(by['stop-hook:untrusted'].trustText, /신뢰하지 않았다/);
  assert.ok(!JSON.stringify(entries).includes('/secret/config/path') && !JSON.stringify(entries).includes('trusted_hash'));
});

test('프로필 시작 전용 설정: ui-inspector 차단은 프로필 명령에만, --cmd·사람 --settings·비 claude는 그대로', () => {
  const home = tmp();
  const plain = claudeSettingsPath(home), prof = claudeProfileSettingsPath(home);
  assert.equal(withStopHook(CLAUDE, home, undefined, {profile: true}), CLAUDE); // 파일 없음 = 지금과 똑같다
  const result = writeClaudeSettings(home);
  assert.equal(result.profile.path, prof);
  assert.deepEqual(JSON.parse(fs.readFileSync(prof, 'utf8')).deniedMcpServers, DENIED_MCP_SERVERS);
  assert.equal(JSON.parse(fs.readFileSync(plain, 'utf8')).deniedMcpServers, undefined); // 공용 파일(--cmd)은 막지 않는다
  assert.deepEqual(JSON.parse(fs.readFileSync(prof, 'utf8')).hooks, JSON.parse(fs.readFileSync(plain, 'utf8')).hooks);
  assert.equal(writeClaudeSettings(home).profile.changed, false);
  const viaProfile = withStopHook(CLAUDE, home, undefined, {profile: true}), viaCmd = withStopHook(CLAUDE, home);
  assert.ok(commandWords(viaProfile).includes(prof));
  assert.ok(commandWords(viaCmd).includes(plain));
  assert.equal(withStopHook(viaProfile, home, undefined, {profile: true}), viaProfile); // 멱등
  assert.equal(withStopHook('claude --settings /x.json', home, undefined, {profile: true}), 'claude --settings /x.json');
  assert.equal(withStopHook('codex --model m', home, undefined, {profile: true}), 'codex --model m');
  // 프로필 파일이 없는 옛 설치는 공용 파일로 돌아간다
  fs.rmSync(prof);
  assert.ok(commandWords(withStopHook(CLAUDE, home, undefined, {profile: true})).includes(plain));
});

test('표시·비교: 프로필 파일을 붙인 명령과 공용 파일 명령은 withoutInlineScreen에서 같다', () => {
  const home = tmp();
  writeClaudeSettings(home);
  const viaProfile = withStopHook(CLAUDE, home, undefined, {profile: true}), viaCmd = withStopHook(CLAUDE, home);
  assert.notEqual(viaProfile, viaCmd);
  assert.equal(withoutInlineScreen(viaProfile), withoutInlineScreen(viaCmd));
  assert.equal(withoutInlineScreen(viaProfile), withoutInlineScreen(CLAUDE));
});

test('restart 재조립: 프로필 파일이 붙은 시작 명령은 재시작 뒤에도 프로필 파일을 지킨다', () => {
  const home = tmp();
  writeClaudeSettings(home);
  const settings = {runners: {claude: {spawn: 'claude --model {model}', resume: 'claude --model {model} --resume {conversation}'}}};
  const id = '0197aaaa-1111-4222-8333-444455556666';
  const old = withStopHook('claude --model claude-fable-5-1', home, undefined, {profile: true});
  const rebuilt = withStopHook(withInlineScreen(rebuildResumeCommand(settings, 'claude', old, id)), home);
  assert.ok(commandWords(rebuilt).includes(claudeProfileSettingsPath(home)));
  assert.equal(rebuilt.split('--settings').length, 2);
});

test('재시작 출처 판정: runnerChoice 출신은 공용·옵션 없음 → 프로필 파일, 이미 프로필·사람 --settings·MCP 옵션은 그대로', () => {
  const home = tmp();
  writeClaudeSettings(home);
  const plain = claudeSettingsPath(home), prof = claudeProfileSettingsPath(home);
  const fromPlain = withStopHook(CLAUDE, home), fromProfile = withStopHook(CLAUDE, home, undefined, {profile: true});
  assert.deepEqual(commandWords(withProfileStopHookOnRestart(fromPlain, home)), commandWords(fromProfile));
  assert.deepEqual(commandWords(withProfileStopHookOnRestart(CLAUDE, home)), commandWords(fromProfile)); // 설정 옵션 없음
  assert.equal(withProfileStopHookOnRestart(fromProfile, home), fromProfile);
  assert.equal(withProfileStopHookOnRestart('claude --settings /x.json --model m', home), 'claude --settings /x.json --model m');
  assert.equal(withProfileStopHookOnRestart(`claude --settings=${plain} --model m`, home).includes(prof), true); // = 꼴도 바꾼다
  for (const cmd of ['claude --mcp-config /m.json --model m', 'claude --model m --strict-mcp-config', 'claude --mcp-config=/m.json']) {
    assert.ok(hasMcpOptions(commandWords(cmd)));
    assert.ok(!commandWords(withProfileStopHookOnRestart(cmd, home)).includes(prof), cmd); // 차단을 끼우지 않는다(공용 파일만)
    assert.ok(!commandWords(withStopHook(cmd, home, undefined, {profile: true})).includes(prof), cmd);
  }
  assert.equal(withProfileStopHookOnRestart('codex --model m', home), 'codex --model m');
});

test('restartRole: runnerChoice 있는 시작은 프로필 파일로, 출처 필드를 이어 적어 2회 연속에서도 보존. --cmd 출신은 공용 유지', async () => {
  const {restartRole} = await import('../src/restart.mjs');
  const {settingsWith} = await import('./helpers/runner-table.mjs');
  const home = tmp();
  writeClaudeSettings(home);
  const plain = claudeSettingsPath(home), prof = claudeProfileSettingsPath(home);
  const id = '0197aaaa-1111-4222-8333-444455556666';
  const run = (name, startExtra) => {
    const user = path.join(home, name, 'user'), cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-rs-cwd-'));
    fs.mkdirSync(path.join(user, '.claude/sessions'), {recursive: true});
    fs.mkdirSync(path.join(user, '.claude/projects/-x'), {recursive: true});
    fs.mkdirSync(cwd, {recursive: true});
    fs.writeFileSync(path.join(user, '.claude/sessions/150.json'), JSON.stringify({sessionId: id, tmux: 'kadan-probe:@3.%3'}));
    fs.writeFileSync(path.join(user, `.claude/projects/-x/${id}.jsonl`), '{}');
    const original = withStopHook('claude --model claude-haiku-5-5 --effort low', home);
    let pid = '100';
    const entries = [{kind: 'start', floor: 'tmux', role: 'probe', session: 'kadan-probe', cmd: original, cwd, panePid: pid,
      roleProfile: 'worker', ...startExtra}];
    const floor = {name: 'tmux', alive: () => true, pid: () => pid, stop() {}, create() { pid = String(Number(pid) + 100); return {panePid: pid}; }};
    const deps = {read: () => entries, record: e => entries.push(e), pendingCards: () => [], closeWindow: () => ({}),
      openWindow: () => ({method: 'hidden'}), paneInfo: () => ({panePid: pid, location: 'kadan-probe:@3.%3'}),
      processTree: () => [{pid, ppid: '1', args: '-zsh'}, {pid: '150', ppid: pid, args: entries.at(-1).cmd}],
      openFiles: () => [], readJson: f => JSON.parse(fs.readFileSync(f)), homeDir: user};
    const again = () => restartRole({home, role: 'probe', session: 'kadan-probe', floor, settings: settingsWith(), deps});
    return {entries, again};
  };
  const choice = {runner: 'claude', model: 'claude-haiku-5-5', effort: 'low'};
  const a = run('a', {launchSource: 'settings', settingsPreset: 'p1', settingsRevision: 3, runnerChoice: choice});
  const first = a.again();
  assert.ok(commandWords(first.command).includes(prof) && !commandWords(first.command).includes(plain));
  const startA = a.entries.at(-1);
  assert.deepEqual(startA.runnerChoice, choice);
  assert.equal(startA.launchSource, 'settings');
  assert.equal(startA.settingsPreset, 'p1');
  assert.equal(startA.compareMode, undefined);
  const second = a.again(); // 연속 재시작
  assert.ok(commandWords(second.command).includes(prof));
  assert.deepEqual(a.entries.at(-1).runnerChoice, choice);
  const b = run('b', {launchSource: 'settings'}); // runnerChoice 없음(옛 기록·--cmd)
  const viaCmd = b.again();
  assert.ok(commandWords(viaCmd.command).includes(plain) && !commandWords(viaCmd.command).includes(prof));
  assert.equal(b.entries.at(-1).runnerChoice, undefined);
});
