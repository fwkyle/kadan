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
  assert.deepEqual([other.reason, other.otherCwd], ['other-root', '/elsewhere/sample-repo']);
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
  assert.deepEqual([fromB.action, fromB.reason, fromB.otherCwd], ['conflict', 'other-root', '/a/sample-repo']);
});

test('수정1-발견2: 띄운 start에 cwd가 없으면 어느 레포에도 넣지 않고, 같은 이름이면 소속 확인 불가로 멈춘다', () => {
  const name = 'kadan-sample-repo-슈퍼감독';
  const noCwd = [start(name, undefined)];
  const same = plan('/w/sample-repo', noCwd, [name]);
  assert.deepEqual([same.action, same.reason], ['conflict', 'no-cwd']);
  const other = [start('kadan-zzz-슈퍼', undefined)];
  assert.equal(plan('/w/sample-repo', other, ['kadan-zzz-슈퍼']).action, 'start');
});

test('수정1-발견3: 띄운 start의 PID가 지금 pane PID와 다르면 후보가 아니다(같은 이름이면 멈춤)', () => {
  const name = 'kadan-sample-repo-슈퍼감독';
  const same = plan('/w/sample-repo', [start(name, '/w/sample-repo')], [name], 999);
  assert.deepEqual([same.action, same.reason], ['conflict', 'pid-changed']);
  const renamed = [start('kadan-내-슈퍼', '/w/sample-repo')];
  assert.equal(plan('/w/sample-repo', renamed, ['kadan-내-슈퍼'], 999).action, 'start');
  assert.equal(plan('/w/sample-repo', [start(name, '/w/sample-repo'), {kind: 'stop', session: name}], [name]).action, 'conflict');
});

// 최종 기대 결과 표(수정 3, 감독 결정): 같은 이름 세션 상태 × 이 레포의 그 밖 확인된 후보 수. 오류 문구가 아니라 이유 코드로만 갈린다.
test('수정3 최종 표: 같은 이름 상태 × 별칭 후보 수의 모든 칸', () => {
  const name = 'kadan-sample-repo-슈퍼감독';
  const good = start(name, '/w/sample-repo');
  const aliases = n => Array.from({length: n}, (_, i) => start(`kadan-alias${i}-슈퍼`, '/w/sample-repo'));
  const run = (sameEntries, sameAlive, n) => {
    const a = aliases(n);
    return plan('/w/sample-repo', [...sameEntries, ...a], [...(sameAlive ? [name] : []), ...a.map(e => e.session)]);
  };
  // 같은 이름 세션 없음: 후보 0/1/2+
  assert.equal(run([], false, 0).action, 'start');
  const one = run([], false, 1);
  assert.deepEqual([one.action, one.target.session], ['attach', 'kadan-alias0-슈퍼']);
  assert.deepEqual([run([], false, 2).action, run([], false, 3).action], ['multiple', 'multiple']);
  // 같은 이름이 살아 있고 확인된 후보: 별칭 0이면 같은 이름 attach, 1+이면 multiple
  const solo = run([good], true, 0);
  assert.deepEqual([solo.action, solo.target.session], ['attach', name]);
  const withAlias = run([good], true, 1);
  assert.deepEqual([withAlias.action, withAlias.matches.length], ['multiple', 2]);
  // 살아 있으나 확인 안 됨(5가지 이유): 별칭 0이든 1+이든 같은 이유로 conflict
  const bad = {
    'no-record': [],
    'no-cwd': [start(name, undefined)],
    'pid-changed': [start(name, '/w/sample-repo', {panePid: 7})],
    'other-root': [start(name, '/elsewhere/sample-repo')],
    'other-profile': [start(name, '/w/sample-repo', {roleProfile: 'worker'})],
  };
  for (const [reason, entries] of Object.entries(bad)) {
    for (const n of [0, 1, 2]) {
      const r = run(entries, true, n);
      assert.deepEqual([r.action, r.reason], ['conflict', reason], `${reason} + 별칭 ${n}`);
    }
  }
  // 꺼진 마지막 사건(stop)은 기록 없음과 같다
  assert.equal(run([good, {kind: 'stop', session: name}], true, 1).reason, 'no-record');
});

test('수정3: 다른 폴더 같은 이름의 결과는 시작 폴더 경로 문자열(소속 확인 불가 포함 여부)과 무관하다', () => {
  const name = 'kadan-sample-repo-슈퍼감독', alias = start('kadan-alias-슈퍼', '/w/sample-repo');
  for (const elsewhere of ['/elsewhere/sample-repo', '/소속 확인 불가/sample-repo', '/x/소속 확인 불가(PID 다름)/sample-repo']) {
    const r = plan('/w/sample-repo', [start(name, elsewhere), alias], [name, alias.session]);
    assert.deepEqual([r.action, r.reason, r.otherCwd], ['conflict', 'other-root', elsewhere], elsewhere);
  }
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
    // kill-server 직후에도 출력 기록 도우미가 잠깐 더 쓸 수 있어 ENOTEMPTY가 난다(병렬 실행 중 실측). 재시도로 기다린다.
    fs.rmSync(work, {recursive: true, force: true, maxRetries: 20, retryDelay: 100});
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
// tmux 조회가 성공(종료 0)했을 때만 pane PID 문자열을 준다. 실패·빈 값은 ''(숫자가 아니므로 대기 조건이 통과하지 않는다).
const panePid = (f, session) => {
  const r = f.tmuxArgs(['display-message', '-p', '-t', `=${session}:`, '#{pane_pid}']);
  return r.status === 0 ? r.stdout.trim() : '';
};
// 한 번 얻은 값 하나로 "숫자이고 이전 값과 다름"을 판단한다(두 번 조회해 섞지 않는다).
const waitForNewPid = (f, session, before) => waitFor(() => { const now = panePid(f, session); return /^[0-9]+$/.test(now) && now !== before; });
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
  const pid = panePid(f, session);
  assert.match(pid, /^[0-9]+$/);
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
  const before = panePid(f, session);
  assert.match(before, /^[0-9]+$/);
  assert.equal(f.tmuxArgs(['respawn-pane', '-k', '-t', `=${session}:`, 'sleep 130']).status, 0);
  assert.ok(waitForNewPid(f, session, before), '새 숫자 PID가 나올 때까지');
  const r = f.cli(repo, ['super']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /PID/);
  assert.equal(startsOf(f.home, session).length, 1, '새 start도 attach도 없다');
  f.cli(repo, ['stop', role]);
});

test('실제 CLI 수정2: PID 바뀐 같은 이름 + 정상 별칭, cwd 없는 같은 이름 + 정상 별칭 모두 종료 1, attach·새 start 없음', {skip}, t => {
  const f = isolated();
  t.after(f.cleanup);
  const repo = makeRepo(f.work);
  const role = 'sample-repo-슈퍼감독', session = `kadan-${role}`, alias = 'sample-alias-슈퍼', aliasSession = `kadan-${alias}`;
  const total = () => readLedger(f.home).filter(e => e.kind === 'start').length;

  // 조합 1: 같은 이름의 PID를 바꾸고, 같은 레포에 정상 별칭을 따로 띄운다.
  assert.equal(f.cli(repo, ['super']).status, 0);
  assert.ok(waitFor(() => startsOf(f.home, session).length === 1));
  const before = panePid(f, session);
  assert.match(before, /^[0-9]+$/);
  assert.equal(f.tmuxArgs(['respawn-pane', '-k', '-t', `=${session}:`, 'sleep 130']).status, 0);
  assert.ok(waitForNewPid(f, session, before), '새 숫자 PID가 나올 때까지');
  const made = f.cli(repo, ['start', alias, '--profile', 'super']);
  assert.equal(made.status, 0, made.stdout + made.stderr);
  assert.ok(waitFor(() => startsOf(f.home, aliasSession).length === 1));
  const count1 = total();
  const r1 = f.cli(repo, ['super']);
  assert.equal(r1.status, 1, r1.stdout + r1.stderr);
  assert.match(r1.stderr, /PID/);
  assert.doesNotMatch(r1.stdout, new RegExp(aliasSession), '별칭 attach 없음');
  assert.equal(total(), count1, '새 start 없음');

  // 조합 2: 같은 이름을 cwd 없는 기록으로 바꿔 둔 새 홈 상태(이 홈에서는 이름이 같은 새 세션이 필요해 다른 레포 이름을 쓴다).
  const repo2 = makeRepo(f.work, 'repo-two');
  const role2 = 'repo-two-슈퍼감독', session2 = `kadan-${role2}`, alias2 = 'two-alias-슈퍼', aliasSession2 = `kadan-${alias2}`;
  assert.equal(f.tmuxArgs(['new-session', '-d', '-s', session2, 'sleep 120']).status, 0);
  const pid2 = panePid(f, session2);
  assert.match(pid2, /^[0-9]+$/);
  appendLedger({kind: 'start', floor: 'tmux', role: role2, session: session2, roleProfile: 'super', cmd: 'sleep 120',
    panePid: Number(pid2), by: 'test'}, f.home);
  assert.equal(f.cli(repo2, ['start', alias2, '--profile', 'super']).status, 0);
  assert.ok(waitFor(() => startsOf(f.home, aliasSession2).length === 1));
  const count2 = total();
  const r2 = f.cli(repo2, ['super']);
  assert.equal(r2.status, 1, r2.stdout + r2.stderr);
  assert.match(r2.stderr, /소속 확인 불가/);
  assert.doesNotMatch(r2.stdout, new RegExp(aliasSession2), '별칭 attach 없음');
  assert.equal(total(), count2, '새 start 없음');
  f.cli(repo, ['stop', alias]);
  f.cli(repo2, ['stop', alias2]);
});

test('실제 CLI 수정3: 다른 레포 같은 이름 + 로컬 별칭은 시작 폴더 경로에 "소속 확인 불가"가 있든 없든 똑같이 멈춘다', {skip}, t => {
  for (const parent of ['x-plain', '소속 확인 불가-x']) {
    const f = isolated();
    t.after(f.cleanup);
    const other = makeRepo(path.join(f.work, parent)), local = makeRepo(path.join(f.work, 'local'));
    const role = 'sample-repo-슈퍼감독', session = `kadan-${role}`, alias = 'local-alias-슈퍼', aliasSession = `kadan-${alias}`;
    assert.equal(f.cli(other, ['super']).status, 0, parent);
    assert.ok(waitFor(() => startsOf(f.home, session).length === 1));
    assert.equal(f.cli(local, ['start', alias, '--profile', 'super']).status, 0, parent);
    assert.ok(waitFor(() => startsOf(f.home, aliasSession).length === 1));
    const total = readLedger(f.home).filter(e => e.kind === 'start').length;
    const r = f.cli(local, ['super']);
    assert.equal(r.status, 1, `${parent}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /다른 폴더/, parent);
    assert.doesNotMatch(r.stdout, new RegExp(aliasSession), `${parent}: 별칭 attach 없음`);
    assert.equal(readLedger(f.home).filter(e => e.kind === 'start').length, total, `${parent}: 새 start 없음`);
    f.cli(other, ['stop', role]);
    f.cli(local, ['stop', alias]);
  }
});

test('실제 CLI 수정3: 원장 기록이 전혀 없는 같은 이름 세션 + 정상 별칭도 멈춘다(tmux 세션 존재로 본다)', {skip}, t => {
  const f = isolated();
  t.after(f.cleanup);
  const repo = makeRepo(f.work);
  const role = 'sample-repo-슈퍼감독', session = `kadan-${role}`, alias = 'norec-alias-슈퍼', aliasSession = `kadan-${alias}`;
  assert.equal(f.tmuxArgs(['new-session', '-d', '-s', session, 'sleep 120']).status, 0);
  assert.equal(f.cli(repo, ['start', alias, '--profile', 'super']).status, 0);
  assert.ok(waitFor(() => startsOf(f.home, aliasSession).length === 1));
  assert.equal(startsOf(f.home, session).length, 0, '같은 이름은 원장 기록이 없다');
  const total = readLedger(f.home).filter(e => e.kind === 'start').length;
  const r = f.cli(repo, ['super']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /시작 기록을 찾지 못했다/);
  assert.doesNotMatch(r.stdout, new RegExp(aliasSession), '별칭 attach 없음');
  assert.equal(readLedger(f.home).filter(e => e.kind === 'start').length, total, '새 start 없음');
  f.cli(repo, ['stop', alias]);
});
