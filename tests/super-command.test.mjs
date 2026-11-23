import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {cmdSuper, gitRootOf, planSuper} from '../src/commands/super.mjs';
import {DEFAULT_FAMILIES} from '../src/runner-settings.mjs';
import {readLedger} from '../src/ledger.mjs';

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
const start = (session, cwd, extra = {}) => ({kind: 'start', session, role: session.replace(/^kadan-/, ''), cwd, roleProfile: 'super', ...extra});

// ---- 판정(planSuper): 기대 결과 표 ----
const HOME = '/nonexistent-kadan-home';
const plan = (cwd, entries, aliveSet) => planSuper({
  cwd, home: HOME, entries, alive: name => aliveSet.includes(name), rootOf: dir => dir.replace(/\/sub$/, ''),
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
  assert.deepEqual([other.action, other.other.cwd], ['conflict', '/elsewhere/sample-repo']);
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

// ---- cmdSuper 배선: start·attach를 가짜로 끼워 호출 여부만 본다 ----
function run(entries, aliveSet, cwd = '/w/sample-repo') {
  const calls = [];
  const code = process.exitCode;
  cmdSuper([], {}, {
    cwd, home: HOME, entries, alive: name => aliveSet.includes(name), rootOf: dir => dir.replace(/\/sub$/, ''),
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
  assert.equal(gitRootOf(path.join(repo, 'gone')), path.resolve(repo, 'gone'));
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
