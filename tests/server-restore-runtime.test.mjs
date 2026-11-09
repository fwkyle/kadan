import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {launchServerRole, restoreEnvironment, restoreStartDigest, sendRestoreNotice,
  systemBootTime} from '../src/server-restore-runtime.mjs';
import {buildStartLedgerEntry} from '../src/cli-start-support.mjs';
import {appendLedger, readSystemLedger, readMailLedger} from '../src/ledger.mjs';
import {acquireReviveLock} from '../src/revive.mjs';
import {writeServerSessions} from '../src/server-sessions.mjs';
import {tmuxClientEnv} from '../src/floor-tmux.mjs';

const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'server-restore-runtime-'));

test('로티 연결 실패는 숨김, 성공은 기계 설정 창, launchd FORCE·TMUX는 전달 안 함', () => {
  const env = {KADAN_WINDOW: 'none', KADAN_WINDOW_FORCE: '1', TMUX: 'old', TMUX_PANE: '%1',
    KADAN_PANE_SOCKET: 'old', KADAN_ROLE: 'previous', KADAN_ROTTIE_BIN: '/old/rottie'};
  const setting = {window: 'rottie', rottieBin: '/fake/rottie'};
  for (const connected of [true, false]) {
    const actual = restoreEnvironment({home: '/fake/home', setting, connected, env});
    assert.equal(actual.KADAN_WINDOW, connected ? 'rottie' : 'none');
    assert.equal(actual.KADAN_ROTTIE_BIN, connected ? setting.rottieBin : undefined);
    assert.equal(actual.KADAN_ROLE, 'autostart');
    for (const key of ['KADAN_WINDOW_FORCE', 'TMUX', 'TMUX_PANE', 'KADAN_PANE_SOCKET']) {
      assert.equal(actual[key], undefined);
    }
  }
  assert.equal(env.KADAN_WINDOW_FORCE, '1', '호출자 환경은 불변');
});

test('기존 start CLI 경로·원장 연결·설정 override 사유·no-prompt를 검증', () => {
  const home = root();
  const start = {kind: 'start', role: 'test-lead', session: 'kadan-test-lead', cwd: home, cmd: 'old'};
  const entries = [start], calls = [];
  const item = {start, role: start.role, session: start.session, profile: 'conductor',
    command: `codex resume ${ID} --model test`};
  const run = (node, args, options) => {
    calls.push({node, args, options});
    entries.push(buildStartLedgerEntry({floorName: 'tmux', role: item.role, session: item.session,
      evidence: {panePid: '222'}, window: 'hidden', cmd: item.command, cwd: home, env: options.env}));
    return {status: 0};
  };
  assert.deepEqual(launchServerRole({home, item, id: ID, run, read: () => entries,
    window: () => ({window: 'rottie', rottieBin: '/fake/rottie'}), connect: () => false}), {hidden: true});
  assert.deepEqual(calls[0].args.slice(1), ['start', item.role, '--cmd', item.command,
    '--profile', 'conductor', '--reason', 'server-restore', '--no-prompt', '--hidden']);
  const last = entries.at(-1);
  assert.equal(last.reason, 'server-restore');
  assert.equal(last.by, 'autostart');
  assert.equal(last.serverRestoreId, ID);
  assert.equal(last.serverRestoreOf, restoreStartDigest(start));
  const floorEnv = tmuxClientEnv(calls[0].options.env);
  assert.equal(floorEnv.KADAN_SERVER_RESTORE_ID, undefined);
  assert.equal(floorEnv.KADAN_SERVER_RESTORE_OF, undefined);
  for (const options of [{env: calls[0].options.env, reused: true},
    {env: {...calls[0].options.env, KADAN_ROLE: 'test-lead'}}]) {
    const ordinary = buildStartLedgerEntry({floorName: 'tmux', role: item.role, session: item.session,
      evidence: {panePid: '222'}, window: 'hidden', cmd: item.command, ...options});
    assert.equal(ordinary.serverRestoreId, undefined);
  }
});

test('준비 후 stop·다른 start는 시작 금지, 종료 0만 있고 새 원장 없음은 실패', () => {
  for (const after of ['stop', 'start', 'no-receipt']) {
    const home = root();
    const start = {kind: 'start', role: 'test-lead', session: 'kadan-test-lead', cwd: home, cmd: 'old'};
    const item = {start, role: start.role, session: start.session, profile: 'conductor', command: 'new'};
    const entries = [start];
    if (after !== 'no-receipt') entries.push({kind: after, session: start.session});
    let calls = 0;
    assert.throws(() => launchServerRole({home, item, id: ID, read: () => entries,
      window: () => null, run: () => { calls++; return {status: 0}; }}));
    assert.equal(calls, after === 'no-receipt' ? 1 : 0);
  }
});

test('이번 서버 손실을 새 감시기가 죽음으로 다시 기록해도 이미 고른 감독 복원은 이어감', () => {
  const home = root();
  const start = {kind: 'start', role: 'test-lead', session: 'kadan-test-lead', cwd: home, cmd: 'old'};
  const item = {start, role: start.role, session: start.session, profile: 'conductor',
    command: `codex resume ${ID} --model test`};
  const entries = [start, {kind: 'alert', role: start.role, alertKind: '죽음'}];
  const run = (_node, _args, options) => {
    entries.push(buildStartLedgerEntry({floorName: 'tmux', role: item.role, session: item.session,
      evidence: {panePid: '222'}, window: 'hidden', cmd: item.command, env: options.env}));
    return {status: 0};
  };
  assert.deepEqual(launchServerRole({home, item, id: ID, run, read: () => entries,
    window: () => null}), {hidden: true});
});

test('autostart 명의 send는 task 없이 한 번, 실패는 재전송하지 않음', () => {
  let calls = 0;
  assert.throws(() => sendRestoreNotice({home: root(), role: 'test-lead', message: 'check',
    run: (_node, args, options) => {
      calls++;
      assert.deepEqual(args.slice(1), ['send', 'test-lead', '--keep-turn', 'check']);
      assert.equal(options.env.KADAN_ROLE, 'autostart');
      return {status: 2};
    }}));
  assert.equal(calls, 1);
});

test('macOS 부팅 시각은 sysctl, 다른 OS는 uptime으로 계산, 오류는 NaN', () => {
  const now = 1_800_000;
  assert.equal(systemBootTime({platform: 'darwin', now, run: (_bin, args) => {
    assert.deepEqual(args, ['-n', 'kern.boottime']);
    return {status: 0, stdout: '{ sec = 1200, usec = 0 }'};
  }}), 1_200_000);
  assert.equal(systemBootTime({platform: 'linux', now, uptime: () => 600}), 1_200_000);
  assert.ok(Number.isNaN(systemBootTime({platform: 'darwin', run: () => ({status: 1})})));
});

// 실제 CLI·SQLite를 통과한다. tmux·sysctl은 가짜 실행 파일이고 AI·로티·포트·알림은 열지 않는다.
function fakeCliFixture() {
  const dir = root(), home = path.join(dir, 'home'), bin = path.join(dir, 'bin');
  fs.mkdirSync(home); fs.mkdirSync(bin);
  const calls = path.join(dir, 'calls.jsonl'), created = path.join(dir, 'created.json');
  const script = `#!/usr/bin/env node
delete process.env.TMUX; delete process.env.TMUX_PANE;
const fs = require('node:fs');
const args = process.argv.slice(2), file = ${JSON.stringify(created)};
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
const sessions = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
if (!args.includes('-L') && !args.includes('-S')) process.exit(91);
if (args.includes('list-sessions')) {
  if (!sessions.length) { console.error('no server running on /tmp/fake'); process.exit(1); }
  console.log(sessions.join('\\n'));
} else if (args.includes('new-session')) {
  const session = args[args.indexOf('-s') + 1];
  sessions.push(session); fs.writeFileSync(file, JSON.stringify(sessions));
} else if (args.includes('has-session')) {
  const session = args[args.indexOf('-t') + 1].replace(/^=/, '').replace(/:$/, '');
  process.exit(sessions.includes(session) ? 0 : 1);
} else if (args.includes('display-message')) console.log('987654');
else if (args.includes('capture-pane')) console.log('fake idle');
`;
  fs.writeFileSync(path.join(bin, 'tmux'), script, {mode: 0o755});
  fs.writeFileSync(path.join(bin, 'sysctl'), '#!/usr/bin/env node\n' +
    `console.log('{ sec = ' + (Math.floor(Date.now()/1000)-3600) + ', usec = 0 }');\n`, {mode: 0o755});
  fs.writeFileSync(path.join(home, 'quickstart.json'), JSON.stringify({runner: 'sh'}));
  fs.writeFileSync(path.join(home, 'revive-state.json'), JSON.stringify({targets:
    Object.fromEntries(['비서', '대시보드', '디코', 'watch'].map(role => [role, {state: 'stopped'}]))}));
  const start = {kind: 'start', role: 'test-recovery-lead', session: 'kadan-test-recovery-lead',
    floor: 'tmux', roleProfile: 'conductor', cwd: dir, panePid: '111',
    cmd: `codex resume ${ID} --model test 'FIRST_PROMPT_MUST_NOT_REPEAT'`};
  appendLedger(start, home);
  writeServerSessions(home, [start.session], Date.now() - 1000);
  const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, KADAN_HOME: home,
    KADAN_WINDOW: 'none', KADAN_WINDOW_FORCE: '1', KADAN_FLOOR: 'tmux', KADAN_ALT_CHECK_MS: '0',
    KADAN_NOTIFY: 'off', KADAN_TEST_NOTIFY_SINK: path.join(dir, 'notices.jsonl')};
  delete env.KADAN_ROLE; delete env.TMUX; delete env.TMUX_PANE;
  const invoke = () => spawnSync(process.execPath, [CLI, 'up', '--auto', '--hidden', '--no-prompt'],
    {env, cwd: dir, encoding: 'utf8', timeout: 20_000});
  return {home, dir, calls, created, env, invoke};
}

test('CLI: 실행 시작의 서버 없음 → 새 start 연결 기록·autostart 우편, 다음 주기 복원 0', () => {
  const f = fakeCliFixture();
  const result = f.invoke();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const entries = readSystemLedger(f.home);
  const starts = entries.filter(e => e.kind === 'start');
  assert.equal(starts.length, 2, result.stdout + result.stderr);
  assert.equal(starts[1].by, 'autostart');
  assert.equal(starts[1].reason, 'server-restore');
  assert.equal(starts[1].harness, 'codex');
  assert.equal(starts[1].model, 'test');
  assert.doesNotMatch(starts[1].cmd, /FIRST_PROMPT/);
  const events = entries.filter(e => e.kind === 'revive' && e.reason === 'server-loss');
  assert.equal(events.length, 1);
  assert.equal(events[0].restoreId, starts[1].serverRestoreId);
  assert.equal(events[0].results[0].result, 'started');
  assert.equal(events[0].results[0].mail, 'accepted');
  assert.equal(readMailLedger(f.home).filter(e => e.kind === 'send' && e.by === 'autostart').length, 1);
  const calls = fs.readFileSync(f.calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls[0].includes('list-sessions'), '기반 프로세스 생성 전에 서버 없음을 관찰');
  assert.equal(f.invoke().status, 0);
  assert.equal(readSystemLedger(f.home).filter(e => e.kind === 'start').length, 2);
  assert.equal(readSystemLedger(f.home).filter(e => e.kind === 'revive').length, 1);
});

test('CLI: revive 잠금이 있으면 서버 조회·시작·알림 모두 없음', () => {
  const f = fakeCliFixture();
  const release = acquireReviveLock(f.home);
  try {
    assert.equal(f.invoke().status, 0);
    assert.equal(fs.existsSync(f.calls), false);
    assert.equal(readSystemLedger(f.home).filter(e => e.kind === 'start').length, 1);
  } finally { release(); }
});

test('CLI: 기반 세션 생성으로 서버가 생겨도 최초 서버 없음 관찰을 보존하여 감독 복원', () => {
  const f = fakeCliFixture();
  fs.writeFileSync(path.join(f.home, 'revive-state.json'), JSON.stringify({targets: {}}));
  const result = f.invoke();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = fs.readFileSync(f.calls, 'utf8').trim().split('\n').map(JSON.parse);
  const created = calls.filter(args => args.includes('new-session')).map(args => args[args.indexOf('-s') + 1]);
  assert.deepEqual(created, ['kadan-비서', 'kadan-대시보드', 'kadan-test-recovery-lead']);
  const restored = readSystemLedger(f.home).find(e => e.reason === 'server-loss');
  assert.equal(restored.results[0].result, 'started');
  assert.equal(readSystemLedger(f.home).filter(e => e.kind === 'revive' && e.reason === 'server-loss').length, 1);
});

test('CLI: 끄는 파일·서버 조회 오류는 감독 복원 0, 조회 오류에도 정상 종료', () => {
  const disabled = fakeCliFixture();
  fs.writeFileSync(path.join(disabled.home, 'server-restore.off'), '');
  assert.equal(disabled.invoke().status, 0);
  assert.equal(readSystemLedger(disabled.home).filter(e => e.kind === 'start').length, 1);
  assert.equal(fs.existsSync(disabled.calls), true);
  const denied = fakeCliFixture();
  fs.writeFileSync(path.join(denied.dir, 'bin', 'tmux'),
    '#!/usr/bin/env node\nconsole.error("Permission denied"); process.exit(1);\n', {mode: 0o755});
  const result = denied.invoke();
  assert.equal(result.status, 0);
  assert.match(result.stderr, /서버 존재 조회 실패/);
  assert.equal(fs.existsSync(denied.created), false);
  assert.equal(readSystemLedger(denied.home).filter(e => e.kind === 'start').length, 1);
});
