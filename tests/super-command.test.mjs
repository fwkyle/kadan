import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {cmdSuper, gitRootOf, planSuper} from '../src/commands/super.mjs';
import {DEFAULT_FAMILIES} from '../src/runner-settings.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';

// 시험의 레포 이름은 고정된 가짜 이름(sample-repo)이다. 운영 이름(kadan-슈퍼감독)이 나오면 안 된다.
const cliPath = new URL('../src/cli.mjs', import.meta.url).pathname;
const tmpBase = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ksuper-')));
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], {encoding: 'utf8'});
function makeRepo(parent, name = 'sample-repo') {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, {recursive: true});
  assert.equal(git(dir, 'init', '-q').status, 0);
  return dir;
}
const start = (session, cwd, extra = {}) => ({kind: 'start', session, role: session.replace(/^kadan-/, ''), cwd, roleProfile: 'super', cmd: 'sleep 1', panePid: 100, ...extra});

// ---- 판정(planSuper): 기대 결과 표 ----
const HOME = '/nonexistent-kadan-home';
const fakeRoot = dir => (dir ? dir.replace(/\/sub$/, '') : null);
const plan = (cwd, entries, aliveSet, livePid = 100) => planSuper({
  cwd, home: HOME, entries, alive: name => aliveSet.includes(name), livePid: () => livePid, rootOf: fakeRoot,
});

test('표1: 해당 레포 슈퍼감독이 없으면 <레포>-슈퍼감독을 새로 시작한다', () => {
  const r = plan('/w/sample-repo', [], []);
  assert.deepEqual([r.action, r.role], ['start', 'sample-repo-슈퍼감독']);
});

test('표2: 같은 최상위의 super가 살아 있으면 attach, 이름이 달라도 같은 것으로 본다', () => {
  const entries = [start('kadan-sample-repo-슈퍼감독', '/w/sample-repo')];
  assert.equal(plan('/w/sample-repo', entries, ['kadan-sample-repo-슈퍼감독']).action, 'attach');
  const renamed = [start('kadan-내-슈퍼', '/w/sample-repo')];
  const r = plan('/w/sample-repo', renamed, ['kadan-내-슈퍼']);
  assert.deepEqual([r.action, r.target.role], ['attach', '내-슈퍼']);
});

test('표3: 하위 폴더에서 띄웠어도 최상위가 같으면 attach (지금 하위 폴더에서 쳐도 같다)', () => {
  const entries = [start('kadan-sample-repo-슈퍼감독', '/w/sample-repo/sub')];
  assert.equal(plan('/w/sample-repo', entries, ['kadan-sample-repo-슈퍼감독']).action, 'attach');
  assert.equal(plan('/w/sample-repo/sub', entries, ['kadan-sample-repo-슈퍼감독']).action, 'attach');
});

test('표4: 같은 최상위 super가 2개 이상이면 multiple', () => {
  const entries = [start('kadan-a-슈퍼', '/w/sample-repo'), start('kadan-b-슈퍼', '/w/sample-repo/sub')];
  const r = plan('/w/sample-repo', entries, ['kadan-a-슈퍼', 'kadan-b-슈퍼']);
  assert.deepEqual([r.action, r.matches.length], ['multiple', 2]);
});

test('표5: 지금 폴더가 KADAN_HOME 안이면 inside-home', () => {
  const home = tmpBase();
  const r = planSuper({cwd: path.join(home, 'x'), home, entries: [], alive: () => false});
  assert.equal(r.action, 'inside-home');
  assert.match(r.message, /카단 기록 폴더/);
});

test('표6: git 밖 폴더는 지금 폴더 이름이 레포 이름이다', () => {
  const dir = path.join(tmpBase(), 'plain-folder');
  fs.mkdirSync(dir);
  assert.equal(gitRootOf(dir), fs.realpathSync(dir));
  const r = planSuper({cwd: dir, home: HOME, entries: [], alive: () => false});
  assert.deepEqual([r.action, r.role], ['start', 'plain-folder-슈퍼감독']);
});

test('표7: 같은 이름이 살아 있으나 다른 최상위(또는 super 아님)에서 띄웠으면 conflict, 붙지 않는다', () => {
  const name = 'kadan-sample-repo-슈퍼감독';
  const other = plan('/w/sample-repo', [start(name, '/elsewhere/sample-repo')], [name]);
  assert.equal(other.action, 'conflict');
  assert.match(other.why, /다른 폴더\(\/elsewhere\/sample-repo\)/);
  const notSuper = plan('/w/sample-repo', [start(name, '/w/sample-repo', {roleProfile: 'worker'})], [name]);
  assert.equal(notSuper.action, 'conflict');
});

test('표8: 꺼진 super는 살아 있는 것으로 세지 않아 새로 시작한다(세대 이어받기는 start 규칙)', () => {
  const entries = [start('kadan-sample-repo-슈퍼감독', '/w/sample-repo')];
  assert.equal(plan('/w/sample-repo', entries, []).action, 'start');
});

test('프로필 없는 옛 start는 이름이 같아도 super로 세지 않는다', () => {
  const name = 'kadan-sample-repo-슈퍼감독';
  const r = plan('/w/sample-repo', [start(name, '/w/sample-repo', {roleProfile: undefined})], [name]);
  assert.equal(r.action, 'conflict');
});

// ---- 수정 1: 소속 근거는 "지금 세대를 실제로 띄운 start"다 ----
test('수정1-발견1: 다른 폴더에서 start로 재사용해도(명령 없는 start, 같은 PID) 띄운 start의 폴더로 판정한다', () => {
  const name = 'kadan-sample-repo-슈퍼감독';
  const reuse = {kind: 'start', session: name, role: 'sample-repo-슈퍼감독', cwd: '/b/sample-repo', roleProfile: 'super', panePid: 100};
  const entries = [start(name, '/a/sample-repo'), reuse];
  assert.equal(plan('/a/sample-repo', entries, [name]).action, 'attach');
  const fromB = plan('/b/sample-repo', entries, [name]);
  assert.deepEqual([fromB.action, /다른 폴더\(\/a\/sample-repo\)/.test(fromB.why)], ['conflict', true]);
});

test('수정1-발견2: 띄운 start에 cwd가 없으면 어느 레포에도 넣지 않고, 같은 이름이면 소속 확인 불가로 멈춘다', () => {
  const name = 'kadan-sample-repo-슈퍼감독';
  const noCwd = [start(name, undefined)];
  const same = plan('/w/sample-repo', noCwd, [name]);
  assert.deepEqual([same.action, /소속 확인 불가/.test(same.why)], ['conflict', true]);
  const other = [start('kadan-zzz-슈퍼', undefined)];
  assert.equal(plan('/w/sample-repo', other, ['kadan-zzz-슈퍼']).action, 'start');
});

test('수정1-발견3: 띄운 start의 PID가 지금 pane PID와 다르면 후보가 아니다(같은 이름이면 멈춤)', () => {
  const name = 'kadan-sample-repo-슈퍼감독';
  const same = plan('/w/sample-repo', [start(name, '/w/sample-repo')], [name], 999);
  assert.deepEqual([same.action, /PID/.test(same.why)], ['conflict', true]);
  const renamed = [start('kadan-내-슈퍼', '/w/sample-repo')];
  assert.equal(plan('/w/sample-repo', renamed, ['kadan-내-슈퍼'], 999).action, 'start');
  assert.equal(plan('/w/sample-repo', [start(name, '/w/sample-repo'), {kind: 'stop', session: name}], [name]).action, 'conflict');
});

// ---- cmdSuper 배선: start·attach를 가짜로 끼워 호출 여부만 본다 ----
function run(entries, aliveSet, cwd = '/w/sample-repo') {
  const calls = [];
  const code = process.exitCode;
  cmdSuper([], {}, {
    cwd, home: HOME, entries, alive: name => aliveSet.includes(name), livePid: () => 100, rootOf: fakeRoot,
    start: (argv, flags) => calls.push(['start', argv, flags]),
    attach: argv => calls.push(['attach', argv]),
  });
  const exit = process.exitCode;
  process.exitCode = code;
  return {calls, exit};
}

test('배선: 없으면 start([역할], {profile: super}), 있으면 attach([역할]), 여럿·충돌이면 둘 다 안 부르고 종료 코드 1', () => {
  const silence = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(run([], []).calls, [['start', ['sample-repo-슈퍼감독'], {profile: 'super'}]]);
    const a = start('kadan-sample-repo-슈퍼감독', '/w/sample-repo');
    assert.deepEqual(run([a], [a.session]).calls, [['attach', ['sample-repo-슈퍼감독']]]);
    const b = start('kadan-b-슈퍼', '/w/sample-repo');
    assert.deepEqual(run([a, b], [a.session, b.session]), {calls: [], exit: 1});
    const c = start('kadan-sample-repo-슈퍼감독', '/elsewhere/sample-repo');
    assert.deepEqual(run([c], [c.session]), {calls: [], exit: 1});
  } finally { console.error = silence; }
});

test('gitRootOf: 하위 폴더에서도 같은 최상위(realpath)를 준다', () => {
  const repo = makeRepo(tmpBase());
  const sub = path.join(repo, 'a', 'b');
  fs.mkdirSync(sub, {recursive: true});
  assert.equal(gitRootOf(sub), fs.realpathSync(repo));
  assert.equal(gitRootOf(path.join(repo, 'gone')), null, '없는 폴더는 모른다');
  assert.equal(gitRootOf(''), null);
  assert.equal(gitRootOf(undefined), null);
});

// ---- 실제 CLI + 격리 tmux(-L 소켓, TMUX 제거, 창 none). 운영 소켓·운영 이름은 쓰지 않는다 ----
const skip = spawnSync('tmux', ['-V']).status !== 0;
const sleepMs = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function isolated() {
  const work = fs.realpathSync(fs.mkdtempSync('/tmp/ksp-'));
  const home = path.join(work, 'home');
  fs.mkdirSync(home);
  const socket = `ksp${process.pid}`;
  const tmuxDir = path.join(work, 't');
  fs.mkdirSync(tmuxDir);
  fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify({
    version: 1, revision: 1, activePreset: 'A', families: DEFAULT_FAMILIES, blocked: [],
    runners: {fake: {spawn: 'sleep 120', models: [{model: 'm1', efforts: ['high']}]}},
    presets: {A: {label: '시험', roles: {super: {runner: 'fake', model: 'm1', effort: 'high'}}}},
  }));
  // LANG를 UTF-8로 둔다: 없으면 tmux가 한글 세션 이름의 글자를 밑줄로 바꿔 이름 대조가 어긋난다.
  const env = {PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TMPDIR: work, TMUX_TMPDIR: tmuxDir,
    KADAN_HOME: home, KADAN_SOCKET: socket, KADAN_FLOOR: 'tmux', KADAN_ROLE: '', KADAN_WINDOW: 'none',
    KADAN_ALT_CHECK_MS: '0', KADAN_NOTIFY: 'off'};
  const cli = (cwd, args) => spawnSync(process.execPath, [cliPath, ...args], {cwd, env, encoding: 'utf8', timeout: 60000});
  const tmuxArgs = args => spawnSync('tmux', ['-L', socket, ...args], {env: {...env}, encoding: 'utf8'});
  const cleanup = () => {
    console.error(`격리 tmux 소켓 종료: ${socket}`);
    tmuxArgs(['kill-server']);
    fs.rmSync(work, {recursive: true, force: true});
  };
  return {work, home, env, cli, tmuxArgs, cleanup};
}

test('실제 CLI: 새로 띄움 → 다시 치면 새 start 없이 attach → 같은 이름 다른 레포는 멈춤 → KADAN_HOME 안 거절 → 맨몸 kadan 그대로', {skip}, t => {
  const f = isolated();
  t.after(f.cleanup);
  const repo = makeRepo(f.work);
  const role = 'sample-repo-슈퍼감독';
  const starts = () => readLedgerAt(f.home).filter(e => e.kind === 'start' && e.session === `kadan-${role}`);

  const first = f.cli(repo, ['super']);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  for (let i = 0; i < 40 && starts().length === 0; i++) sleepMs(50);
  assert.equal(starts().length, 1, '새로 시작한 start 사건 1건');
  assert.equal(starts()[0].roleProfile, 'super');
  assert.equal(starts()[0].cwd, repo);
  assert.match(f.tmuxArgs(['ls']).stdout, new RegExp(`kadan-${role}`));

  const sub = path.join(repo, 'sub');
  fs.mkdirSync(sub);
  const again = f.cli(sub, ['super']); // 하위 폴더에서 쳐도 같은 최상위
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(starts().length, 1, '두 번째는 새 start 사건이 없다');
  assert.match(again.stdout, new RegExp(`kadan-${role}`), 'attach 경로의 출력');

  const otherRepo = makeRepo(path.join(f.work, 'elsewhere'));
  const conflict = f.cli(otherRepo, ['super']);
  assert.equal(conflict.status, 1, conflict.stdout + conflict.stderr);
  assert.match(conflict.stderr, /다른 폴더/);
  assert.equal(starts().length, 1);

  const inside = f.cli(f.home, ['super']);
  assert.equal(inside.status, 2, inside.stdout + inside.stderr);
  assert.match(inside.stderr, /카단 기록 폴더/);

  const bare = f.cli(repo, []);
  assert.equal(bare.status, 0);
  assert.match(bare.stdout, /카단 — 여러 AI 도구/);
  assert.equal(f.cli(repo, ['super', '--help']).status, 0);
  assert.equal(f.cli(repo, ['super', 'x']).status, 2);
  f.cli(repo, ['stop', role]);
});

function readLedgerAt(home) {
  const keep = process.env.KADAN_HOME;
  process.env.KADAN_HOME = home;
  try { return readLedger(home); } finally { process.env.KADAN_HOME = keep; }
}

// 격리 tmux 위의 실제 CLI로 수정 1의 세 줄을 덮는다. 검수자 재현(exec-37516bdd isolated-review.mjs)을 시험 안에 옮겼다.
const waitFor = (fn, tries = 200) => { for (let i = 0; i < tries && !fn(); i++) sleepMs(50); return fn(); };
const startsOf = (home, session) => readLedger(home).filter(e => e.kind === 'start' && e.session === session);

test('실제 CLI 수정1-발견1: A에서 띄운 super를 B(같은 폴더 이름)에서 start로 재사용한 뒤 A는 attach, B는 멈춘다', {skip}, t => {
  const f = isolated();
  t.after(f.cleanup);
  const a = makeRepo(path.join(f.work, 'a')), b = makeRepo(path.join(f.work, 'b'));
  const role = 'sample-repo-슈퍼감독', session = `kadan-${role}`;
  assert.equal(f.cli(a, ['super']).status, 0);
  assert.ok(waitFor(() => startsOf(f.home, session).length === 1));
  const reuse = f.cli(b, ['start', role]); // 살아 있는 세션 재사용: 명령 없는 start, cwd는 b
  assert.equal(reuse.status, 0, reuse.stdout + reuse.stderr);
  const afterReuse = startsOf(f.home, session);
  assert.equal(afterReuse.length, 2, '재사용 start가 하나 더 적혔다');
  assert.equal(afterReuse[1].cwd, b);
  const fromA = f.cli(a, ['super']);
  assert.equal(fromA.status, 0, fromA.stdout + fromA.stderr);
  assert.match(fromA.stdout, new RegExp(session));
  const fromB = f.cli(b, ['super']);
  assert.equal(fromB.status, 1, fromB.stdout + fromB.stderr);
  assert.match(fromB.stderr, /다른 폴더/);
  assert.equal(startsOf(f.home, session).length, 2, 'super는 start를 더 적지 않았다');
  f.cli(a, ['stop', role]);
});

test('실제 CLI 수정1-발견2: 띄운 start에 cwd가 없으면 어느 레포에서도 attach하지 않고 같은 이름이면 멈춘다', {skip}, t => {
  const f = isolated();
  t.after(f.cleanup);
  const role = 'sample-repo-슈퍼감독', session = `kadan-${role}`;
  assert.equal(f.tmuxArgs(['new-session', '-d', '-s', session, 'sleep 120']).status, 0);
  const pid = f.tmuxArgs(['display-message', '-p', '-t', `=${session}:`, '#{pane_pid}']).stdout.trim();
  appendLedger({kind: 'start', floor: 'tmux', role, session, roleProfile: 'super', cmd: 'sleep 120', panePid: Number(pid), by: 'test'}, f.home);
  const same = f.cli(makeRepo(f.work), ['super']);
  assert.equal(same.status, 1, same.stdout + same.stderr);
  assert.match(same.stderr, /소속 확인 불가/);
  assert.equal(startsOf(f.home, session).length, 1);
  const other = f.cli(makeRepo(f.work, 'other-repo'), ['super']);
  assert.equal(other.status, 0, other.stdout + other.stderr);
  assert.doesNotMatch(other.stdout, new RegExp(session), '다른 레포는 이 세션에 붙지 않는다');
  assert.ok(waitFor(() => startsOf(f.home, 'kadan-other-repo-슈퍼감독').length === 1), '다른 레포는 자기 이름으로 새로 시작');
  f.cli(f.work, ['stop', 'other-repo-슈퍼감독']);
});

test('실제 CLI 수정1-발견3: pane PID가 원장과 다르면 attach하지 않고 같은 이름이면 멈춘다', {skip}, t => {
  const f = isolated();
  t.after(f.cleanup);
  const repo = makeRepo(f.work);
  const role = 'sample-repo-슈퍼감독', session = `kadan-${role}`;
  assert.equal(f.cli(repo, ['super']).status, 0);
  assert.ok(waitFor(() => startsOf(f.home, session).length === 1));
  const before = f.tmuxArgs(['display-message', '-p', '-t', `=${session}:`, '#{pane_pid}']).stdout.trim();
  assert.equal(f.tmuxArgs(['respawn-pane', '-k', '-t', `=${session}:`, 'sleep 130']).status, 0);
  assert.ok(waitFor(() => f.tmuxArgs(['display-message', '-p', '-t', `=${session}:`, '#{pane_pid}']).stdout.trim() !== before));
  const r = f.cli(repo, ['super']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /PID/);
  assert.equal(startsOf(f.home, session).length, 1, '새 start도 attach도 없다');
  f.cli(repo, ['stop', role]);
});
