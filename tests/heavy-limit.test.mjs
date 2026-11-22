import './helpers/isolated-home.mjs';
import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createExclusive, limitEnv, limitHolders, lockOwnerState, ORPHAN_LOCK_MS, processStartToken, runLimited, runLimitedResult,
  tryAcquireLimit} from '../src/heavy-limit.mjs';
import {MEMORY_GROUP_GONE_MS, MEMORY_KILL_GRACE_MS, MEMORY_OFF_ENV, MEMORY_POLL_MS, MEMORY_START_MAX_PCT, MEMORY_STOP_EXIT, MEMORY_STOP_PCT,
  MEMORY_STOP_STREAK, MEMORY_WAIT_EXIT, MEMORY_WAIT_MS, NO_STOP_STREAK, compressorPct, judgeRunning, judgeStart, memoryCheckEnabled,
  nextStopStreak, stopReason} from '../src/memory-check.mjs';
import {readMachineMemory} from '../src/machine-memory.mjs';
import {processStartedAt} from '../src/process-tree.mjs';
import {stopChild} from './helpers/child-cleanup.mjs';

const children = new Set();
afterEach(async () => { await Promise.all([...children].map(child => stopChild(child))); });

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
// 시험마다 새 카단 폴더. 실사용 카단 폴더의 잠금은 건드리지 않는다.
const freshHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-limit-'));
const node = script => [process.execPath, '-e', script];

function start(home, kind, command) {
  const child = spawn(process.execPath, [cli, 'limit', 'run', kind, '--', ...command], {env: {...process.env, KADAN_HOME: home}});
  children.add(child);
  child.once('exit', () => children.delete(child));
  const out = {stdout: '', stderr: ''};
  child.stdout.on('data', d => { out.stdout += d; });
  child.stderr.on('data', d => { out.stderr += d; });
  const done = new Promise(resolve => child.on('close', code => resolve({code, ...out})));
  return {child, out, done};
}
async function until(check, ms = 10000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('시간 초과'); await new Promise(r => setTimeout(r, 25)); }
}
const lockCount = home => fs.existsSync(path.join(home, 'limits')) ? fs.readdirSync(path.join(home, 'limits')).filter(n => n.endsWith('.lock')).length : 0;

test('rust는 동시에 하나만: 두 번째는 기다렸다가 첫 번째가 끝난 뒤 시작한다', async () => {
  const home = freshHome(), marks = path.join(home, 'marks.txt');
  const release = path.join(home, 'release');
  const job = name => node(`
    const fs = require('fs');
    const mark = phase => fs.appendFileSync(${JSON.stringify(marks)},
      '${name}-' + phase + ' ' + Date.now() + '\\n');
    mark('start');
    if ('${name}' === 'a') {
      const timer = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); mark('end'); }
      }, 25);
    } else mark('end');
  `);
  const a = start(home, 'rust', job('a'));
  await until(() => fs.existsSync(marks));
  const b = start(home, 'rust', job('b'));
  // 두 번째 CLI의 기동 속도 대신 실제 잠금 대기를 확인한 뒤 첫 작업을 끝낸다.
  try { await until(() => /대기: rust/.test(b.out.stderr)); }
  finally { fs.writeFileSync(release, 'release'); }
  const [ra, rb] = await Promise.all([a.done, b.done]);
  assert.equal(ra.code, 0); assert.equal(rb.code, 0);
  const at = Object.fromEntries(fs.readFileSync(marks, 'utf8').trim().split('\n').map(l => l.split(' ')).map(([k, v]) => [k, Number(v)]));
  assert.ok(at['b-start'] >= at['a-end'], JSON.stringify(at));
  assert.match(rb.stderr, /대기: rust 자리 모두 사용 중\(맥 전체 한 줄\) — heavy-1\.lock pid \d+ \S+ 종류 rust/);
  assert.equal(lockCount(home), 0);
});

// 맥 전체 한 줄: 종류가 달라도(build·install·rust) 같은 자리 하나를 나눠 쓴다. 둘째는 첫째가 끝나야 시작한다.
test('종류가 달라도 한 줄이다: build가 쥐고 있으면 install은 기다렸다가 첫째가 끝난 뒤 시작한다', async () => {
  const home = freshHome(), marks = path.join(home, 'marks.txt'), release = path.join(home, 'release');
  const job = name => node(`
    const fs = require('fs');
    const mark = phase => fs.appendFileSync(${JSON.stringify(marks)}, '${name}-' + phase + ' ' + Date.now() + '\\n');
    mark('start');
    if ('${name}' === 'a') {
      const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); mark('end'); } }, 25);
    } else mark('end');
  `);
  const a = start(home, 'build', job('a'));
  await until(() => fs.existsSync(marks));
  const b = start(home, 'install', job('b'));
  try { await until(() => /대기: install 자리 모두 사용 중/.test(b.out.stderr)); }
  finally { fs.writeFileSync(release, 'release'); }
  const [ra, rb] = await Promise.all([a.done, b.done]);
  assert.equal(ra.code, 0); assert.equal(rb.code, 0);
  const at = Object.fromEntries(fs.readFileSync(marks, 'utf8').trim().split('\n').map(l => l.split(' ')).map(([k, v]) => [k, Number(v)]));
  assert.ok(at['b-start'] >= at['a-end'], JSON.stringify(at));
  assert.match(rb.stderr, /heavy-1\.lock pid \d+ \S+ 종류 build/);
  assert.equal(lockCount(home), 0);
});

test('같은 종류도 기본은 하나이고, 설정 heavy를 올리면 그 개수만큼 동시에 돈다', async () => {
  const home = freshHome();
  fs.writeFileSync(path.join(home, 'resource-limits.json'), JSON.stringify({heavy: 2, limits: {install: 9}}));
  const jobs = ['install', 'build'].map(kind => start(home, kind, node('setTimeout(()=>{},2000)')));
  await until(() => lockCount(home) === 2);
  const results = await Promise.all(jobs.map(j => j.done));
  assert.deepEqual(results.map(r => [r.code, /대기/.test(r.stderr)]), [[0, false], [0, false]]);
  // 옛 limits는 더 쓰지 않는다: status가 한 줄로 알린다.
  const status = spawnSync(process.execPath, [cli, 'limit', 'status'], {env: {...process.env, KADAN_HOME: home}, encoding: 'utf8'});
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.heavy, 2);
  assert.match(parsed.notice, /limits.*더 이상 쓰지 않음/);
  assert.equal('limits' in parsed, false);
  const clean = freshHome();
  assert.equal(JSON.parse(spawnSync(process.execPath, [cli, 'limit', 'status'], {env: {...process.env, KADAN_HOME: clean}, encoding: 'utf8'}).stdout).heavy, 1);
  fs.writeFileSync(path.join(clean, 'resource-limits.json'), JSON.stringify({heavy: 0}));
  const bad = await start(clean, 'build', node('0')).done;
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /잘못된 동시 개수: heavy=0/);
});

test('명령이 실패해도, 중단돼도 잠금을 풀고 종료 코드를 돌려준다', async () => {
  const home = freshHome();
  const failed = await start(home, 'build', node('process.exit(7)')).done;
  assert.equal(failed.code, 7);
  assert.equal(lockCount(home), 0);
  const long = start(home, 'build', node('setTimeout(()=>{},20000)'));
  await until(() => lockCount(home) === 1);
  long.child.kill('SIGTERM');
  const stopped = await long.done;
  assert.equal(stopped.code, 128 + os.constants.signals.SIGTERM);
  assert.equal(lockCount(home), 0);
});

test('죽은 PID의 잠금은 회수한다', async () => {
  const home = freshHome();
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], {encoding: 'utf8'});
  fs.mkdirSync(path.join(home, 'limits'));
  fs.writeFileSync(path.join(home, 'limits', 'heavy-1.lock'), JSON.stringify({pid: Number(dead.stdout.trim()), command: ['cargo', 'build']}));
  assert.equal(limitHolders(home)[0].alive, false);
  const result = await start(home, 'rust', node('process.exit(0)')).done;
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stderr, /대기/);
  assert.equal(lockCount(home), 0);
});

test('`--` 뒤 인자는 카단 옵션으로 해석하지 않고 그대로 넘긴다', async () => {
  const home = freshHome();
  const result = await start(home, 'build', node('console.log(JSON.stringify(process.argv.slice(1)))').concat('--', '--release', '--', '-x')).done;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['--release', '--', '-x']);
});

test('rust는 CARGO_BUILD_JOBS=2를 붙이되 -j·기존 값은 존중한다; 알 수 없는 종류는 거부한다', async () => {
  assert.equal(limitEnv('rust', ['cargo', 'build'], {}).CARGO_BUILD_JOBS, '2');
  assert.equal(limitEnv('rust', ['cargo', 'build', '-j', '4'], {}).CARGO_BUILD_JOBS, undefined);
  assert.equal(limitEnv('rust', ['cargo', 'test', '--jobs=3'], {}).CARGO_BUILD_JOBS, undefined);
  assert.equal(limitEnv('rust', ['cargo', 'build'], {CARGO_BUILD_JOBS: '6'}).CARGO_BUILD_JOBS, '6');
  assert.equal(limitEnv('build', ['npm', 'test'], {}).CARGO_BUILD_JOBS, undefined);
  const home = freshHome();
  const seen = await start(home, 'rust', node('console.log(process.env.CARGO_BUILD_JOBS)')).done;
  assert.equal(seen.stdout.trim(), '2');
  const unknown = await start(home, 'video', node('0')).done;
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /알 수 없는 종류: video/);
});

// PID 재사용: 잠금에는 잡을 때 읽은 주인의 시작 표지(startToken)가 있다. PID가 살아 있어도 지금 그 PID의 표지가 다르면
// 번호만 같은 다른 프로세스다(재부팅 뒤 같은 번호를 다른 프로세스가 받은 경우 등). 아래 시험의 주인 PID는 이 시험 프로세스 자신이다.
const iso = ms => new Date(ms).toISOString();
const writeLock = (home, name, value) => {
  fs.mkdirSync(path.join(home, 'limits'), {recursive: true});
  fs.writeFileSync(path.join(home, 'limits', name), JSON.stringify(value));
};
const myToken = processStartToken(process.pid);
// 모양은 맞고 값만 다른 표지(= 다른 프로세스의 것): 끝 숫자(연도 또는 시작 틱)를 하나 올린다.
const otherToken = token => token.replace(/\d+$/, n => String(Number(n) + 1));
const deadPid = () => Number(spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], {encoding: 'utf8'}).stdout.trim());
// Linux /proc 모형: stat의 22번째 칸(부팅 뒤 틱으로 센 시작 시각)과 부팅 식별값.
const BOOT = '11111111-2222-3333-4444-555555555555';
const procFiles = ({ticks = '987654', boot = BOOT, comm = 'node (x) y'} = {}) => file => {
  if (file === '/proc/sys/kernel/random/boot_id') return `${boot}\n`;
  if (file === '/proc/4321/stat') return `4321 (${comm}) S 1 4321 4321 0 -1 4194304 100 0 0 0 5 3 0 0 20 0 11 0 ${ticks} 1000000 500\n`;
  throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'});
};
const noPs = () => assert.fail('Linux에서는 ps를 부르지 않는다');
const linuxToken = files => processStartToken(4321, {platform: 'linux', readFile: files, run: noPs});

test('시작 표지: 실제 limit run이 잠금에 자기 표지를 적고, 다른 프로세스가 다시 읽어도 같은 값이다', async () => {
  assert.match(myToken, /^(linux|ps):./);
  assert.equal(processStartToken(process.pid), myToken);
  const home = freshHome(), release = path.join(home, 'release');
  const job = start(home, 'rust', node(`
    const fs = require('fs');
    const wait = () => fs.existsSync(${JSON.stringify(release)}) ? process.exit(0) : setTimeout(wait, 25);
    wait();`));
  await until(() => lockCount(home) === 1);
  const [held] = limitHolders(home);
  assert.equal(held.pid, job.child.pid);
  // startToken은 출력 허용 목록에 없다. 잠금 파일에 적힌 값을 직접 본다.
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'limits', 'heavy-1.lock'), 'utf8'));
  assert.equal(saved.startToken, processStartToken(job.child.pid));
  assert.equal(held.state, 'alive');
  fs.writeFileSync(release, '');
  assert.equal((await job.done).code, 0);
});

test('PID 재사용: 주인 PID가 살아 있어도 시작 표지가 다르면 회수해 자리를 잡는다', async () => {
  const home = freshHome();
  writeLock(home, 'heavy-1.lock', {pid: process.pid, kind: 'rust', command: ['cargo', 'build'], since: iso(Date.now()), startToken: otherToken(myToken)});
  const [seen] = limitHolders(home);
  assert.equal(seen.state, 'pid-reused'); assert.equal(seen.alive, false);
  const result = await start(home, 'rust', node('process.exit(0)')).done;
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /대기/);
  assert.equal(lockCount(home), 0);
});

test('시작 표지가 같으면 살아 있는 주인이다: 잡지 못하고 기다린다', async () => {
  const home = freshHome(), mark = path.join(home, 'ran');
  writeLock(home, 'heavy-1.lock', {pid: process.pid, kind: 'rust', command: ['cargo', 'build'], since: iso(Date.now()), startToken: myToken});
  assert.equal(limitHolders(home)[0].state, 'alive');
  const waiting = start(home, 'rust', node(`require('fs').writeFileSync(${JSON.stringify(mark)}, 'x')`));
  await until(() => /대기: rust 자리 모두 사용 중/.test(waiting.out.stderr));
  assert.doesNotMatch(waiting.out.stderr, /죽음|PID 재사용/);
  assert.equal(fs.existsSync(mark), false);
  // 시험이 만든 격리 홈의 잠금을 치워 자리를 내준다(주인이 일을 끝낸 것과 같다).
  fs.renameSync(path.join(home, 'limits', 'heavy-1.lock'), path.join(home, 'released.lock'));
  assert.equal((await waiting.done).code, 0);
  assert.equal(fs.existsSync(mark), true);
});

test('시계 보정: 판정은 잠금 시각(since)과 벽시계를 보지 않는다 — 표지가 같으면 살아 있는 주인이다', () => {
  const home = freshHome(), started = processStartedAt(process.pid);
  // 잠금을 잡은 뒤 시계가 앞으로 5초·1시간 보정된 것처럼 since가 프로세스 시작보다 이르게 보여도 회수하지 않는다.
  for (const since of [iso(started - 5000), iso(started - 3600_000), iso(Date.now() + 3600_000), undefined]) {
    writeLock(home, 'heavy-1.lock', {pid: process.pid, kind: 'rust', since, startToken: myToken});
    assert.equal(limitHolders(home)[0].state, 'alive', String(since));
    assert.equal(tryAcquireLimit(home, {pid: process.pid, kind: 'rust'}), null);
  }
  // Linux: 표지는 부팅 식별값과 부팅 뒤 틱뿐이라, 벽시계가 바뀌어 ps의 시작 시각이 밀려도 그대로다(ps를 부르지 않는다).
  const recorded = linuxToken(procFiles());
  assert.equal(recorded, `linux:${BOOT}:987654`);
  const owner = {pid: process.pid, since: iso(started), startToken: recorded};
  assert.equal(lockOwnerState(owner, {startToken: () => linuxToken(procFiles())}), 'alive');
  // 재부팅 뒤 같은 번호를 받은 다른 프로세스(부팅 식별값이 다름), 같은 부팅 안의 PID 재사용(시작 틱이 다름)은 회수 대상이다.
  const rebooted = linuxToken(procFiles({boot: '99999999-2222-3333-4444-555555555555'}));
  assert.equal(lockOwnerState(owner, {startToken: () => rebooted}), 'pid-reused');
  assert.equal(lockOwnerState(owner, {startToken: () => linuxToken(procFiles({ticks: '987655'}))}), 'pid-reused');
});

test('주인 판정: 모르면 살아 있음(표지 없음·모양 이상·못 읽음·방법 다름), 죽은 PID에는 표지를 읽지 않는다', () => {
  let asked = 0;
  const count = () => { asked++; return otherToken(myToken); };
  for (const startToken of [undefined, null, '', 42, 'ps:garbage', 'linux:not-a-boot-id', 'Fri Nov 13 03:51:27 2026']) {
    assert.equal(lockOwnerState({pid: process.pid, startToken}, {startToken: count}), 'alive', String(startToken));
  }
  const dead = deadPid();
  assert.equal(lockOwnerState({pid: dead, startToken: myToken}, {startToken: count}), 'dead');
  assert.equal(lockOwnerState({startToken: myToken}, {startToken: count}), 'dead');
  assert.equal(asked, 0);
  const mine = {pid: process.pid, startToken: myToken};
  assert.equal(lockOwnerState(mine, {startToken: () => { throw new Error('ps 시간 초과'); }}), 'alive');
  for (const current of [null, undefined, '', 'ps:garbage', 42]) {
    assert.equal(lockOwnerState(mine, {startToken: () => current}), 'alive', String(current));
  }
  // 적힌 표지와 지금 읽는 방법이 다르면 비교하지 않는다.
  const foreign = myToken.startsWith('ps:') ? `linux:${BOOT}:987654` : 'ps:Fri Nov 13 03:51:27 2026';
  assert.equal(lockOwnerState(mine, {startToken: () => foreign}), 'alive');
});

test('시작 표지 읽기: 실패·이상한 출력은 null이고, 명령 이름에 공백·괄호가 있어도 시작 틱을 바로 읽는다', () => {
  const ps = result => processStartToken(4321, {platform: 'darwin', readFile: () => assert.fail('파일을 읽지 않는다'), run: () => result});
  assert.equal(ps({status: 0, stdout: 'Fri Nov 13 03:51:27 2026    \n'}), 'ps:Fri Nov 13 03:51:27 2026');
  assert.equal(ps({status: 0, stdout: 'Tue Nov  3 03:51:27 2026\n'}), 'ps:Tue Nov  3 03:51:27 2026');
  for (const result of [{status: 1, stdout: ''}, {status: 0, stdout: ''}, {status: 0, stdout: 'not-a-date'},
    {status: null, stdout: '', error: Object.assign(new Error('timeout'), {code: 'ETIMEDOUT'})}, {status: 0}]) {
    assert.equal(ps(result), null, JSON.stringify(result));
  }
  assert.equal(processStartToken(4321, {platform: 'darwin', run: () => { throw new Error('spawn 실패'); }}), null);
  // Linux·macOS가 아닌 OS는 표지를 만들지 않는다(ps도 /proc도 읽지 않는다).
  assert.equal(processStartToken(4321, {platform: 'freebsd', run: noPs, readFile: noPs}), null);
  assert.equal(linuxToken(procFiles({comm: 'a) S 1 2 (b'})), `linux:${BOOT}:987654`);
  assert.equal(linuxToken(procFiles({ticks: 'x'})), null);
  assert.equal(linuxToken(procFiles({boot: ''})), null);
  assert.equal(linuxToken(() => { throw new Error('EACCES'); }), null);
  for (const pid of [0, -1, 1.5, '4321', null]) assert.equal(processStartToken(pid, {run: noPs, readFile: noPs}), null);
});

test('표시: status와 대기 줄이 죽은 PID와 PID 재사용을 구분해 보인다', async () => {
  const home = freshHome(), dead = deadPid();
  // 자리는 하나(heavy-1)다. 2·3번 잠금 파일은 자리 밖이라 회수되지 않고 표시만 된다.
  writeLock(home, 'heavy-1.lock', {pid: process.pid, kind: 'rust', since: iso(Date.now()), startToken: myToken});
  writeLock(home, 'heavy-2.lock', {pid: process.pid, kind: 'rust', since: iso(Date.now()), startToken: otherToken(myToken)});
  writeLock(home, 'heavy-3.lock', {pid: dead, kind: 'rust', since: iso(Date.now()), startToken: myToken});
  const status = spawnSync(process.execPath, [cli, 'limit', 'status'], {env: {...process.env, KADAN_HOME: home}, encoding: 'utf8'});
  assert.equal(status.status, 0, status.stderr);
  const holders = Object.fromEntries(JSON.parse(status.stdout).holders.map(h => [h.lock, h]));
  assert.deepEqual(['heavy-1.lock', 'heavy-2.lock', 'heavy-3.lock'].map(name => [holders[name].state, holders[name].alive]),
    [['alive', true], ['pid-reused', false], ['dead', false]]);
  const waiting = start(home, 'rust', node('process.exit(0)'));
  await until(() => /대기/.test(waiting.out.stderr));
  assert.match(waiting.out.stderr, new RegExp(`heavy-1\\.lock pid ${process.pid} `));
  assert.match(waiting.out.stderr, new RegExp(`heavy-2\\.lock pid ${process.pid}\\(PID 재사용: 시작 표지 다름\\)`));
  assert.match(waiting.out.stderr, new RegExp(`heavy-3\\.lock pid ${dead}\\(죽음\\)`));
  fs.renameSync(path.join(home, 'limits', 'heavy-1.lock'), path.join(home, 'released.lock'));
  assert.equal((await waiting.done).code, 0);
});

// ps를 쓰는 macOS에서만: 호출을 적고 진짜 ps로 넘기는 가짜 ps를 PATH 앞에 둔다. Linux는 /proc 파일만 읽어 ps 호출이 없다.
test('대기 한 바퀴에서 주인 하나의 시작 표지는 한 번만 읽는다', {skip: process.platform !== 'darwin'}, async () => {
  const home = freshHome(), bin = path.join(home, 'bin'), calls = path.join(home, 'ps-calls.txt');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexec /bin/ps "$@"\n`, {mode: 0o755});
  // 같은 주인이 자리 둘을 다 쥔 모양(heavy 2): 한 바퀴에 잠금 둘을 보지만 PID는 하나다.
  fs.writeFileSync(path.join(home, 'resource-limits.json'), JSON.stringify({heavy: 2}));
  for (const name of ['heavy-1.lock', 'heavy-2.lock']) writeLock(home, name, {pid: process.pid, kind: 'build', since: iso(Date.now()), startToken: myToken});
  const child = spawn(process.execPath, [cli, 'limit', 'run', 'build', '--', ...node('process.exit(0)')],
    {env: {...process.env, KADAN_HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`}});
  children.add(child);
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  const done = new Promise(resolve => child.on('close', resolve));
  await until(() => /대기: build 자리 모두 사용 중/.test(stderr));
  // 한 바퀴에 회수 시도가 잠금 둘, 대기 줄이 잠금 둘을 본다. 바퀴마다 한 번만 읽으면 1번, 잠금마다 읽으면 4번이다.
  // 시험 프로세스가 느려 다음 바퀴(2초 뒤)를 한두 번 넘겨 봐도 3번을 넘지 않는다.
  const asked = fs.readFileSync(calls, 'utf8').split('\n').filter(line => line.endsWith(`-p ${process.pid}`));
  assert.ok(asked.length >= 1 && asked.length <= 3, fs.readFileSync(calls, 'utf8'));
  for (const name of ['heavy-1.lock', 'heavy-2.lock']) fs.renameSync(path.join(home, 'limits', name), path.join(home, `released-${name}`));
  assert.equal(await done, 0);
});

// 다른 실행의 명령줄은 대기 안내·status에 나오지 않는다. 옛 형식 잠금(command·cwd 있음)을 읽어도 새지 않아야 한다(허용 목록).
// 값은 모두 가짜다. 시험은 격리 홈에서만 돈다.
const LEAK = ['TOKEN', '가짜값', 'PATH=/x', 'pnpm', 'smoke', '/secret/cwd', 'SECRET=', 'extra-field'];
const noLeak = (text, label) => { for (const word of LEAK) assert.ok(!text.includes(word), `${label}에 ${word}가 나왔다: ${text}`); };

test('옛 형식 잠금: 대기 안내 줄과 status(JSON)에 명령 인자·cwd·모르는 필드가 나오지 않고 이름·PID·시작 시각은 나온다', async () => {
  const home = freshHome(), since = iso(Date.now());
  writeLock(home, 'heavy-1.lock', {pid: process.pid, kind: 'rust', since, startToken: myToken,
    command: ['env', '-i', 'PATH=/x', 'TOKEN=가짜값', 'pnpm', 'smoke'], cwd: '/secret/cwd', extra: 'SECRET=extra-field', role: 'TOKEN=가짜값'});
  const status = spawnSync(process.execPath, [cli, 'limit', 'status'], {env: {...process.env, KADAN_HOME: home}, encoding: 'utf8'});
  assert.equal(status.status, 0, status.stderr);
  noLeak(status.stdout, 'status');
  const [held] = JSON.parse(status.stdout).holders;
  assert.deepEqual(Object.keys(held).sort(), ['alive', 'kind', 'lock', 'pid', 'since', 'state']);
  assert.deepEqual([held.lock, held.pid, held.kind, held.since, held.state], ['heavy-1.lock', process.pid, 'rust', since, 'alive']);
  const waiting = start(home, 'rust', node('process.exit(0)'));
  await until(() => /대기: rust 자리 모두 사용 중/.test(waiting.out.stderr));
  noLeak(waiting.out.stderr, '대기 줄');
  assert.match(waiting.out.stderr, new RegExp(`heavy-1\\.lock pid ${process.pid} ${since}`));
  fs.renameSync(path.join(home, 'limits', 'heavy-1.lock'), path.join(home, 'released.lock'));
  assert.equal((await waiting.done).code, 0);
});

test('새 잠금: command·cwd를 저장하지 않고, KADAN_ROLE이 있으면 역할만 저장·표시한다', async () => {
  for (const role of ['kadan-제한기-작업자', undefined]) {
    const home = freshHome(), release = path.join(home, 'release');
    const env = {...process.env, KADAN_HOME: home};
    if (role) env.KADAN_ROLE = role; else delete env.KADAN_ROLE;
    const child = spawn(process.execPath, [cli, 'limit', 'run', 'build', '--', ...node(`
      const fs = require('fs');
      const wait = () => fs.existsSync(${JSON.stringify(release)}) ? process.exit(0) : setTimeout(wait, 25);
      wait(); // TOKEN=가짜값`)], {env});
    children.add(child);
    const done = new Promise(resolve => child.on('close', resolve));
    await until(() => lockCount(home) === 1);
    const file = path.join(home, 'limits', 'heavy-1.lock');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(saved).sort(), ['kind', 'pid', 'since', 'startToken', ...(role ? ['role'] : [])].filter(k => k !== 'startToken' || saved.startToken).sort());
    assert.equal(saved.role, role);
    assert.ok(!('command' in saved) && !('cwd' in saved), JSON.stringify(saved));
    noLeak(fs.readFileSync(file, 'utf8'), '잠금 파일');
    const [seen] = limitHolders(home);
    assert.equal(seen.role, role);
    fs.writeFileSync(release, '');
    assert.equal(await done, 0);
  }
});

test('허용 목록: 모양이 다른 값(PID·시각·역할·종류)은 버린다', () => {
  const home = freshHome();
  writeLock(home, 'heavy-1.lock', {pid: process.pid, kind: 'TOKEN=가짜값', since: 'TOKEN=가짜값', role: 'a b', startToken: myToken});
  writeLock(home, 'heavy-2.lock', {pid: '123', kind: 'rust', role: 'a=b'});
  const holders = limitHolders(home);
  noLeak(JSON.stringify(holders), 'holders');
  assert.deepEqual(holders.map(h => Object.keys(h).sort()), [['alive', 'lock', 'pid', 'state'], ['alive', 'kind', 'lock', 'state']]);
});

// 역할 이름은 카단이 역할 설정(role-instructions)에서 받는 범위와 같다: 유니코드 문자·숫자·밑줄·하이픈, 길이 제한 없음.
const lockRecordOf = (home, role) => {
  assert.ok(tryAcquireLimit(home, {pid: process.pid, kind: 'rust', since: iso(Date.now()), role}));
  return JSON.parse(fs.readFileSync(path.join(home, 'limits', 'heavy-1.lock'), 'utf8'));
};

test('역할 이름: 유니코드·긴 이름은 저장·표시하고, 명령줄 조각이 될 수 있는 값은 버린다', () => {
  const good = ['fixture-검수자_2', 'fixture-réviseur-3', 'fixture-レビュー2', `fixture-${'a'.repeat(73)}`];
  const bad = ['a=b', 'a b', 'a.b', '/etc/passwd', 'a\nb', '--flag=x', ''];
  for (const role of good) {
    const home = freshHome();
    assert.equal(lockRecordOf(home, role).role, role);
    assert.equal(limitHolders(home)[0].role, role);
  }
  for (const role of bad) {
    const home = freshHome();
    assert.equal(lockRecordOf(home, role).role, undefined, JSON.stringify(role));
    writeLock(home, 'heavy-2.lock', {pid: process.pid, kind: 'rust', since: iso(Date.now()), role});
    assert.equal(limitHolders(home).find(h => h.lock === 'heavy-2.lock').role, undefined, JSON.stringify(role));
  }
});

test('역할 이름: 실제 limit run이 유니코드 KADAN_ROLE을 잠금에 적고 대기 줄·status에 보인다', async () => {
  const home = freshHome(), release = path.join(home, 'release'), role = 'fixture-réviseur-レビュー2';
  const env = {...process.env, KADAN_HOME: home, KADAN_ROLE: role};
  const holder = spawn(process.execPath, [cli, 'limit', 'run', 'rust', '--', ...node(`
    const fs = require('fs');
    const wait = () => fs.existsSync(${JSON.stringify(release)}) ? process.exit(0) : setTimeout(wait, 25);
    wait();`)], {env});
  children.add(holder);
  const holderDone = new Promise(resolve => holder.on('close', resolve));
  await until(() => lockCount(home) === 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'limits', 'heavy-1.lock'), 'utf8')).role, role);
  const waiting = start(home, 'rust', node('process.exit(0)'));
  await until(() => /대기: rust 자리 모두 사용 중/.test(waiting.out.stderr));
  assert.match(waiting.out.stderr, new RegExp(`역할 ${role}`, 'u'));
  const status = spawnSync(process.execPath, [cli, 'limit', 'status'], {env, encoding: 'utf8'});
  assert.equal(JSON.parse(status.stdout).holders[0].role, role);
  fs.writeFileSync(release, '');
  assert.equal(await holderDone, 0);
  assert.equal((await waiting.done).code, 0);
});

// ---- 메모리 보호(시작 관문 + 실행 중 보호): 실제 메모리를 채우지 않고 실제 sysctl도 부르지 않는다. ----
// 측정(measure)·시계·간격은 인자로 넣는다. 시험은 우분투 CI와 tests/run.mjs(끄는 스위치) 아래에서도 돌아야 하므로
// 관문·보호를 보는 시험은 enabled: true와 platform: 'darwin'을 함께 넣는다. 제목 끝의 [표 N]은 카드의 고정한 동작 표 번호다.
const sample = (segmentPct, {pagePct = 10, pressure = 1, swapUsedMb = 0} = {}) =>
  ({known: true, segmentPct, pagePct, pressure, swapUsedMb, recoveryAllowed: true});
const UNREAD = {known: false, reason: 'read'};
const MAC = {enabled: true, platform: 'darwin'};
// 모양은 이 맥의 실제 `sysctl` 출력에서 가져왔다(2026-11-22). 세그먼트 한도 100, 보관 페이지 한도 1000으로 비율을 읽기 쉽게 했다.
const SYSCTL = ({segments, pages = 100, pressure = 1}) => [
  `kern.memorystatus_vm_pressure_level: ${pressure}`,
  'vm.swapusage: total = 8192.00M  used = 7065.60M  free = 1126.40M  (encrypted)',
  `vm.compressor.segment.total: ${segments}`,
  'vm.compressor.segment.limit: 100',
  `vm.compressor.pages_compressed: ${pages}`,
  'vm.compressor.pages_compressed_limit: 1000',
  '',
].join('\n');
const fromSysctl = options => readMachineMemory(() => ({status: 0, stdout: SYSCTL(options)}), 'darwin');

const memoryHome = () => {
  const home = freshHome();
  return {home, mark: path.join(home, 'ran.txt'), command: node(`require('fs').writeFileSync(${JSON.stringify(path.join(home, 'ran.txt'))}, 'x')`)};
};
// 가짜 시계: 대기(sleep)가 시계를 앞으로 보낸다.
const clock = () => { let t = 0; return {now: () => t, sleepFn: async ms => { t += ms; }}; };
const quiet = {env: {}, log: () => {}, stdio: 'ignore'};
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

// 실행 중 보호 시험이 쓰는 작은 실제 프로세스: 자식 하나와 그 자식이 띄운 손자 하나. 둘 다 스스로 끝나는 상한이 있어 남지 않는다.
// 손자는 (SIGTERM을 무시하게 했다면 처리기를 건 뒤에) 자기 PID를 파일에 적는다. 시험은 그 파일이 생긴 뒤에만 문턱을 넘긴다.
const leftovers = new Set();
afterEach(() => {
  for (const file of leftovers) {
    try { process.kill(Number(fs.readFileSync(file, 'utf8')), 'SIGKILL'); } catch { /* 이미 없으면 그만 */ }
  }
  leftovers.clear();
});
function tree(home, {ignoreTerm = false} = {}) {
  const pidFile = path.join(home, 'grandchild.pid');
  leftovers.add(pidFile);
  const grand = `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}
    require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    setTimeout(() => process.exit(0), 20000);`;
  const command = node(`
    require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grand)}], {stdio: 'ignore'});
    setTimeout(() => process.exit(3), 20000);
  `);
  return {pidFile, command, grandPid: () => Number(fs.readFileSync(pidFile, 'utf8'))};
}
// 끝난 뒤 남은 것: 이 프로세스의 타이머 수와 신호·exit 처리기 수. runLimited 앞뒤로 같아야 한다.
const residue = () => JSON.stringify({
  timers: process.getActiveResourcesInfo().filter(name => name === 'Timeout').length,
  listeners: ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'].map(name => process.listenerCount(name)),
});

test('시작 판정: 압축 공간(세그먼트·보관 페이지 중 큰 값) 74.99%는 시작, 75%는 대기; 압박 위급은 낮아도 대기; 압박 모름은 위급 아님; 못 읽으면 대기 [표 2·3]', () => {
  assert.equal(compressorPct(sample(40, {pagePct: 62.5})), 62.5);
  assert.equal(compressorPct(UNREAD), null);
  assert.equal(compressorPct({...sample(40), known: false, pagePct: null}), null); // 한 축만 읽은 값은 읽음이 아니다
  assert.equal(judgeStart(sample(74.99)).ok, true);
  assert.equal(judgeStart(sample(75)).ok, false);
  assert.equal(judgeStart(sample(10, {pagePct: 74.99})).ok, true);
  assert.equal(judgeStart(sample(10, {pagePct: 75})).ok, false);
  assert.equal(judgeStart(sample(20, {pressure: 4})).ok, false);
  assert.equal(judgeStart(sample(74, {pressure: 2})).ok, true);
  assert.equal(judgeStart(sample(74, {pressure: null})).ok, true);
  // 스왑은 판정에 쓰지 않는다: 평소 스왑 16.7GiB에서도 시작한다.
  assert.equal(judgeStart(sample(30, {swapUsedMb: 17100})).ok, true);
  for (const unread of [UNREAD, {known: false, reason: 'timeout'}, null, undefined, {}]) {
    assert.deepEqual(judgeStart(unread), {ok: false, line: '못 읽음'});
  }
  assert.equal(judgeStart(sample(80.04, {pagePct: 33.3, pressure: 2, swapUsedMb: 7065.6})).line,
    '압축 공간 80.0%(세그먼트 80.0%·보관 페이지 33.3%)·압박 경고·스왑 6.9G(참고)');
  // 가짜 sysctl 출력으로도 같다: 읽기는 감시기와 같은 readMachineMemory()다.
  assert.equal(judgeStart(fromSysctl({segments: 74})).ok, true);
  assert.equal(judgeStart(fromSysctl({segments: 75})).ok, false);
  assert.equal(judgeStart(fromSysctl({segments: 20, pages: 750})).ok, false);
  assert.equal(judgeStart(fromSysctl({segments: 20, pressure: 4})).ok, false);
  assert.equal(judgeStart(readMachineMemory(() => ({status: 0, stdout: 'garbage\n'}), 'darwin')).ok, false);
  assert.equal(judgeStart(readMachineMemory(() => { throw new Error('boom'); }, 'darwin')).ok, false);
  assert.deepEqual([MEMORY_START_MAX_PCT, MEMORY_WAIT_MS, MEMORY_POLL_MS, MEMORY_WAIT_EXIT], [75, 90_000, 5000, 75]);
});

test('실행 중 판정과 연속 셈: 기준 둘(85% 이상 / 위급이면서 75% 이상)을 따로 세고, 내려오거나 못 읽으면 그 셈이 0으로 돌아간다 [표 5·6·7·8]', () => {
  const marks = value => { const {read, over, critical} = judgeRunning(value); return {read, over, critical}; };
  assert.deepEqual(marks(sample(85)), {read: true, over: true, critical: false});
  assert.deepEqual(marks(sample(84.99)), {read: true, over: false, critical: false});
  assert.deepEqual(marks(sample(10, {pagePct: 85})), {read: true, over: true, critical: false});
  assert.deepEqual(marks(sample(84.99, {pressure: 2})), {read: true, over: false, critical: false});
  assert.deepEqual(marks(sample(75, {pressure: 4})), {read: true, over: false, critical: true});
  assert.deepEqual(marks(sample(74.99, {pressure: 4})), {read: true, over: false, critical: false});
  assert.deepEqual(marks(sample(85, {pressure: 4})), {read: true, over: true, critical: true}); // 한 값이 둘 다 만족
  assert.deepEqual(marks(sample(80, {pressure: null})), {read: true, over: false, critical: false});
  assert.deepEqual(judgeRunning(UNREAD), {read: false, over: false, critical: false, line: '못 읽음'});
  assert.deepEqual(judgeRunning(null), {read: false, over: false, critical: false, line: '못 읽음'});
  // 회차마다의 [(가) 셈, (나) 셈]. null은 스위치가 꺼져 재지 않은 회차다.
  const streaks = values => {
    let s = NO_STOP_STREAK;
    return values.map(value => { s = nextStopStreak(s, value === null ? null : judgeRunning(value)); return [s.over, s.critical, stopReason(s) !== null]; });
  };
  const urgent = pct => sample(pct, {pressure: 4});
  assert.deepEqual(streaks([sample(90), sample(90)]), [[1, 0, false], [2, 0, true]]); // (가) 2번 연속이면 끊는다
  assert.deepEqual(streaks([urgent(80), urgent(80)]), [[0, 1, false], [0, 2, true]]); // (나) 2번 연속이면 끊는다
  assert.deepEqual(streaks([sample(90), urgent(80)]), [[1, 0, false], [0, 1, false]]); // 섞인 순서는 끊지 않는다
  assert.deepEqual(streaks([urgent(80), sample(90)]), [[0, 1, false], [1, 0, false]]);
  assert.deepEqual(streaks([urgent(90), urgent(80)]), [[1, 1, false], [0, 2, true]]); // 둘 다 만족한 값은 둘 다 센다
  assert.deepEqual(streaks([urgent(90), sample(85)]), [[1, 1, false], [2, 0, true]]);
  assert.deepEqual(streaks([sample(90), sample(50), sample(90)]), [[1, 0, false], [0, 0, false], [1, 0, false]]); // 1번 걸리고 내려옴
  assert.deepEqual(streaks([sample(90), UNREAD, sample(90)]), [[1, 0, false], [0, 0, false], [1, 0, false]]); // 못 읽음이 사이에 낌
  assert.deepEqual(streaks([urgent(90), null, urgent(90)]), [[1, 1, false], [0, 0, false], [1, 1, false]]); // 꺼진 회차는 둘 다 0으로
  assert.deepEqual(streaks([UNREAD, UNREAD, UNREAD]), [[0, 0, false], [0, 0, false], [0, 0, false]]); // 못 읽음은 끊는 근거가 아니다
  assert.equal(stopReason({over: 2, critical: 0}), '압축 공간 85% 이상이 2번 연속');
  assert.equal(stopReason({over: 0, critical: 2}), '압박 위급이면서 압축 공간 75% 이상이 2번 연속');
  assert.deepEqual([MEMORY_STOP_PCT, MEMORY_STOP_STREAK, MEMORY_KILL_GRACE_MS, MEMORY_STOP_EXIT], [85, 2, 10_000, 76]);
});

test('맥이 아니면 건너뜀 한 줄만 남기고 시작하고, 실행 중에도 재지 않는다 [표 1]', async () => {
  const {home, mark} = memoryHome(), logs = [];
  let calls = 0;
  const slow = node(`require('fs').writeFileSync(${JSON.stringify(mark)}, 'x'); setTimeout(() => {}, 150)`);
  const outcome = await runLimitedResult(home, 'build', slow, {...quiet, log: m => logs.push(m),
    memory: {enabled: true, platform: 'linux', pollMs: 10, measure: () => { calls += 1; return sample(99, {pressure: 4}); }}});
  assert.deepEqual(outcome, {code: 0, started: true});
  assert.deepEqual(logs, ['메모리 확인 건너뜀: 맥이 아님(linux)']);
  assert.equal(calls, 0);
  assert.ok(fs.existsSync(mark));
  assert.equal(lockCount(home), 0);
});

test('압축 공간 75% 미만이고 압박 위급이 아니면 기다리지 않고 바로 시작한다 [표 2]', async () => {
  const {home, mark, command} = memoryHome(), logs = [];
  let calls = 0;
  const outcome = await runLimitedResult(home, 'build', command, {...quiet, log: m => logs.push(m),
    memory: {...MAC, sleepFn: () => assert.fail('기다리지 않는다'), measure: () => { calls += 1; return sample(74.9, {pressure: 2, swapUsedMb: 17000}); }}});
  assert.deepEqual(outcome, {code: 0, started: true});
  assert.deepEqual(logs, []);
  assert.ok(calls >= 1);
  assert.ok(fs.existsSync(mark));
});

test('75% 이상·압박 위급·못 읽음이면 자리를 쥔 채 5초마다 다시 재다가 풀리면 시작한다; 같은 값은 대기 줄을 다시 내지 않는다 [표 3]', async () => {
  const {home, mark, command} = memoryHome(), logs = [], seen = [], slept = [];
  const readings = [sample(80), sample(80), sample(40, {pressure: 4}), UNREAD, sample(60)];
  const c = clock();
  const outcome = await runLimitedResult(home, 'build', command, {...quiet, log: m => logs.push(m),
    memory: {...MAC, now: c.now, sleepFn: async ms => { slept.push(ms); await c.sleepFn(ms); }, measure: () => {
      seen.push(lockCount(home)); // 재는 동안에도 자리는 쥐고 있다
      return readings.length ? readings.shift() : sample(60);
    }}});
  assert.deepEqual(outcome, {code: 0, started: true});
  assert.deepEqual(seen.slice(0, 5), [1, 1, 1, 1, 1]);
  assert.deepEqual(slept, [5000, 5000, 5000, 5000]); // 기본 간격은 5초
  assert.ok(fs.existsSync(mark));
  const waits = logs.filter(m => /^대기: 메모리/.test(m));
  assert.equal(waits.length, 3, logs.join('\n')); // 80%(같은 값 한 번 생략)·압박 위급·못 읽음
  assert.match(waits[0], /^대기: 메모리 — 압축 공간 80\.0%\(세그먼트 80\.0%·보관 페이지 10\.0%\)·압박 정상·스왑 0\.0G\(참고\)\. 압축 공간 75% 미만·압박 위급 아님이어야 시작한다\. 자리는 쥔 채 기다림\(최대 90초\)$/);
  assert.match(waits[1], /압축 공간 40\.0%.*압박 위급/);
  assert.match(waits[2], /^대기: 메모리 — 못 읽음\./);
  assert.equal(lockCount(home), 0);
});

test('90초 안에 풀리지 않으면 명령을 돌리지 않고 자리를 풀고 종료 75·잰 값 한 줄이다; 맥에서 못 읽어도 같다 [표 3]', async () => {
  const cases = [
    [() => sample(88, {pagePct: 20, swapUsedMb: 300}), /^메모리 보호로 시작하지 않음\(종료 75\): 압축 공간 88\.0%\(세그먼트 88\.0%·보관 페이지 20\.0%\)·압박 정상·스왑 0\.3G\(참고\)\. 90초 기다렸지만 풀리지 않아 명령은 돌리지 않고 자리를 풀었다$/],
    [() => UNREAD, /^메모리 보호로 시작하지 않음\(종료 75\): 못 읽음\. 90초 기다렸지만/],
    [() => { throw new Error('측정 예외'); }, /^메모리 보호로 시작하지 않음\(종료 75\): 못 읽음\./],
  ];
  for (const [measure, lastLine] of cases) {
    const {home, mark, command} = memoryHome(), logs = [];
    const before = residue();
    const outcome = await runLimitedResult(home, 'build', command, {...quiet, log: m => logs.push(m), memory: {...MAC, ...clock(), measure}});
    assert.deepEqual(outcome, {code: 75, started: false});
    assert.equal(fs.existsSync(mark), false); // 부작용 없음
    assert.equal(lockCount(home), 0); // 자리를 풀었다
    assert.match(logs.at(-1), lastLine);
    assert.equal(residue(), before);
    // 시험 실패(1)와 구별된다: 같은 자리에서 다음 명령은 그대로 돈다.
    assert.equal(await runLimited(home, 'build', command, {...quiet, memory: {...MAC, measure: () => sample(30)}}), 0);
    assert.ok(fs.existsSync(mark));
  }
});

test('90초 경계: 89,999ms에 통과한 측정은 시작하고, 90,000ms부터는 통과여도 시작하지 않는다(재는 중에 넘어도 같다) [표 3]', async () => {
  for (const [at, code] of [[89_999, 0], [90_000, 75], [90_001, 75]]) {
    // 대기 뒤의 시각이 at이다.
    const first = memoryHome();
    let now = 0;
    const logs = [];
    assert.deepEqual(await runLimitedResult(first.home, 'build', first.command, {...quiet, log: m => logs.push(m),
      memory: {...MAC, now: () => now, sleepFn: async () => { now = at; }, measure: () => sample(now === 0 ? 75 : 74)}}),
      {code, started: code === 0}, `대기 뒤 ${at}ms`);
    assert.equal(fs.existsSync(first.mark), code === 0);
    assert.equal(lockCount(first.home), 0);
    if (code === 75) assert.match(logs.at(-1), /압축 공간 75\.0%.*90초 기다렸지만/); // 마지막으로 걸린 값을 보인다
    // 두 번째 측정이 끝난 시각이 at이다(측정 중에 시계가 넘어감).
    const second = memoryHome();
    let clockMs = 0, calls = 0;
    assert.deepEqual(await runLimitedResult(second.home, 'build', second.command, {...quiet,
      memory: {...MAC, now: () => clockMs, sleepFn: async () => { clockMs = 5000; },
        measure: () => { if (++calls === 1) return sample(80); clockMs = at; return sample(10); }}}),
      {code, started: code === 0}, `측정 종료 ${at}ms`);
    assert.equal(calls, 2);
    assert.equal(fs.existsSync(second.mark), code === 0);
  }
});

test('메모리를 기다리는 동안 자리를 쥐고 있어 다른 무거운 작업은 시작하지 않는다 [표 3]', async () => {
  const {home, mark, command} = memoryHome();
  let enough = false;
  const holder = runLimited(home, 'rust', command, {...quiet, pollMs: 10,
    memory: {...MAC, pollMs: 20, waitMs: 60_000, measure: () => sample(enough ? 20 : 95)}});
  try {
    await until(() => lockCount(home) === 1);
    const other = start(home, 'install', node('0'));
    await until(() => /대기: install 자리 모두 사용 중\(맥 전체 한 줄\) — heavy-1\.lock pid \d+ \S+ 종류 rust/.test(other.out.stderr));
    assert.equal(fs.existsSync(mark), false);
    assert.equal(lockCount(home), 1);
    enough = true; // 메모리가 풀리면 기다리던 쪽이 돌고 끝나서 자리를 내주고, 그제야 둘째가 돈다
    assert.equal(await holder, 0);
    assert.equal((await other.done).code, 0);
  } finally { enough = true; }
  assert.equal(lockCount(home), 0);
});

test('끄는 스위치(파일·환경 변수)가 있으면 시작 관문도 실행 중 보호도 재지 않는다 [표 4]', async () => {
  const slowHome = () => {
    const {home, mark} = memoryHome();
    return {home, mark, command: node(`require('fs').writeFileSync(${JSON.stringify(mark)}, 'x'); setTimeout(() => {}, 150)`)};
  };
  let calls = 0;
  // enabled를 넣지 않는다: 스위치 판정 자체를 본다. 값은 시작 관문도 실행 중 보호도 걸리는 값이다.
  const memory = {platform: 'darwin', pollMs: 10, measure: () => { calls += 1; return sample(99, {pressure: 4}); }};
  // 시험 실행기(tests/run.mjs)가 깐 이 프로세스의 스위치를 잠시 치운다. 치우지 않으면 아래가 그 스위치 때문에 통과한다.
  const inherited = process.env[MEMORY_OFF_ENV];
  delete process.env[MEMORY_OFF_ENV];
  try {
    // 파일 스위치
    const byFile = slowHome(), logs = [];
    fs.writeFileSync(path.join(byFile.home, 'memory-check.off'), '');
    assert.deepEqual(await runLimitedResult(byFile.home, 'build', byFile.command, {...quiet, log: m => logs.push(m), memory}), {code: 0, started: true});
    assert.ok(fs.existsSync(byFile.mark));
    assert.deepEqual(logs, []);
    assert.equal(memoryCheckEnabled(byFile.home, {}), false);
    // 환경 변수 스위치(넘겨받은 환경)
    const byEnv = slowHome();
    assert.deepEqual(await runLimitedResult(byEnv.home, 'build', byEnv.command, {...quiet, env: {[MEMORY_OFF_ENV]: 'off'}, memory}), {code: 0, started: true});
    assert.ok(fs.existsSync(byEnv.mark));
    assert.equal(calls, 0, '스위치가 있으면 시작 전에도 도는 중에도 재지 않는다');
    // 스위치가 없으면 같은 측정·같은 명령이 시작 관문에 걸린다: 위 통과가 스위치 덕분임을 보인다.
    const on = slowHome();
    assert.deepEqual(await runLimitedResult(on.home, 'build', on.command, {...quiet, memory: {...memory, ...clock()}}), {code: 75, started: false});
    assert.equal(fs.existsSync(on.mark), false);
    assert.ok(calls > 0);
  } finally { if (inherited !== undefined) process.env[MEMORY_OFF_ENV] = inherited; }
  // 넘겨받은 환경이 비어 있어도 이 프로세스의 환경에 스위치가 있으면 끈다(tests/run.mjs 아래의 시험이 맥을 재지 않게).
  calls = 0;
  const underRunner = slowHome();
  assert.deepEqual(await runLimitedResult(underRunner.home, 'build', underRunner.command, {...quiet, memory}), {code: 0, started: true});
  assert.equal(calls, 0);
});

test('운영 기본은 켜짐이고, tests/run.mjs 아래(KADAN_MEMORY_CHECK=off)는 꺼짐이다 [표 4]', () => {
  assert.equal(memoryCheckEnabled(freshHome(), {}), true);
  assert.equal(memoryCheckEnabled(freshHome(), {[MEMORY_OFF_ENV]: 'on'}), true);
  assert.equal(memoryCheckEnabled(freshHome(), process.env), false, 'npm test(tests/run.mjs)로 돌려야 한다');
  assert.match(fs.readFileSync(fileURLToPath(new URL('./run.mjs', import.meta.url)), 'utf8'), /env\.KADAN_MEMORY_CHECK = 'off'/);
});

test('실행 중 압축 공간 85% 이상이 2번 연속이면 프로세스 그룹을 끊는다: 손자까지 끝나고 종료 76·memoryStop이다 [표 5·11]', async () => {
  const home = freshHome(), {pidFile, command, grandPid} = tree(home), logs = [], seen = [];
  const before = residue();
  const outcome = await runLimitedResult(home, 'build', command, {...quiet, log: m => logs.push(m),
    memory: {...MAC, pollMs: 20, graceMs: 5000, measure: () => {
      const value = fs.existsSync(pidFile) ? sample(91.2, {swapUsedMb: 2048}) : sample(10);
      seen.push([value.segmentPct, lockCount(home)]);
      return value;
    }}});
  assert.deepEqual(outcome, {code: 76, started: true, memoryStop: true});
  // 끊기로 한 뒤에는 더 재지 않는다: 위험한 읽기는 정확히 2번이고, 재는 동안 자리는 쥐고 있었다.
  assert.equal(seen.filter(([pct]) => pct > 85).length, 2, JSON.stringify(seen));
  assert.ok(seen.every(([, locks]) => locks === 1));
  await until(() => !alive(grandPid()), 3000); // 손자까지 끝났다
  assert.equal(lockCount(home), 0);
  assert.deepEqual(logs.filter(m => /^메모리 보호/.test(m)).length, 1);
  assert.match(logs.at(-1), /^메모리 보호로 명령을 끊음\(종료 76\): 압축 공간 91\.2%\(세그먼트 91\.2%·보관 페이지 10\.0%\)·압박 정상·스왑 2\.0G\(참고\)\. 압축 공간 85% 이상이 2번 연속이라 이 명령의 프로세스 그룹을 끊는다\. 같은 명령을 바로 다시 돌리지 않는다$/);
  assert.equal(residue(), before); // 남은 타이머·신호 처리기 없음
});

test('SIGTERM을 무시하는 손자는 유예가 지난 뒤 그룹 SIGKILL로 끝나고, 그 뒤에야 자리를 푼다 [표 5·11]', async () => {
  const home = freshHome(), {pidFile, command, grandPid} = tree(home, {ignoreTerm: true});
  const before = residue(), graceMs = 400;
  let stopAt = null, lockAtReturn = null;
  const run = runLimitedResult(home, 'build', command, {...quiet,
    log: m => { if (/^메모리 보호로 명령을 끊음/.test(m)) stopAt = performance.now(); },
    memory: {...MAC, pollMs: 20, graceMs, measure: () => sample(fs.existsSync(pidFile) ? 97 : 10)}});
  const outcome = await run.then(value => { lockAtReturn = lockCount(home); return value; });
  const took = performance.now() - stopAt;
  assert.deepEqual(outcome, {code: 76, started: true, memoryStop: true});
  assert.ok(took >= graceMs * 0.9, `유예(${graceMs}ms) 전에 끝남: ${took}ms`); // 자식이 먼저 죽어도 손자를 기다렸다
  await until(() => !alive(grandPid()), 3000);
  assert.equal(lockAtReturn, 0);
  assert.equal(residue(), before);
});

test('압박 위급이면서 압축 공간 75% 이상이 2번 연속이어도 끊는다 [표 6]', async () => {
  const home = freshHome(), {pidFile, command, grandPid} = tree(home), logs = [];
  const outcome = await runLimitedResult(home, 'build', command, {...quiet, log: m => logs.push(m),
    memory: {...MAC, pollMs: 20, graceMs: 5000, measure: () => sample(fs.existsSync(pidFile) ? 76 : 10, {pressure: fs.existsSync(pidFile) ? 4 : 1})}});
  assert.deepEqual(outcome, {code: 76, started: true, memoryStop: true});
  await until(() => !alive(grandPid()), 3000);
  assert.match(logs.at(-1), /^메모리 보호로 명령을 끊음\(종료 76\): 압축 공간 76\.0%.*압박 위급.*\. 압박 위급이면서 압축 공간 75% 이상이 2번 연속이라/);
  assert.equal(lockCount(home), 0);
});

test('1번만 걸리고 내려오거나 못 읽음·측정 예외가 사이에 끼면 끊지 않는다 [표 7·8]', async () => {
  const home = freshHome(), release = path.join(home, 'release'), logs = [];
  // 위험한 읽기는 여러 번이지만 한 번도 2번 연속이 아니다. 준비한 읽기를 다 쓰면 명령을 스스로 끝나게 한다.
  const readings = [sample(60), sample(90), sample(50), sample(90), UNREAD, sample(90), 'throw', sample(90),
    sample(74.9, {pressure: 4}), sample(84.9), sample(90), {known: false, reason: 'timeout'}, sample(96)];
  const total = readings.length + 1; // 시작 관문의 첫 읽기(sample 60) 포함
  let calls = 0;
  const command = node(`
    const fs = require('fs');
    setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(0); }, 10);
    setTimeout(() => process.exit(3), 20000);
  `);
  const before = residue();
  const outcome = await runLimitedResult(home, 'build', command, {...quiet, log: m => logs.push(m),
    memory: {...MAC, pollMs: 15, graceMs: 5000, measure: () => {
      calls += 1;
      if (calls === 1) return sample(60);
      const value = readings.shift();
      if (!readings.length) fs.writeFileSync(release, 'x');
      if (value === undefined) return sample(10);
      if (value === 'throw') throw new Error('측정 예외');
      return value;
    }}});
  assert.deepEqual(outcome, {code: 0, started: true}); // 메모리 보호 표시 없음
  assert.ok(calls >= total, `읽기 ${calls}번`);
  assert.deepEqual(logs, []);
  assert.equal(lockCount(home), 0);
  assert.equal(residue(), before);
});

test('명령이 스스로 75·76으로 끝나면 보통 종료다: 코드는 그대로이고 메모리 보호 표시가 없다 [표 9]', async () => {
  const {home, command} = memoryHome();
  const fine = {...MAC, pollMs: 10, measure: () => sample(20)};
  assert.deepEqual(await runLimitedResult(home, 'build', node('process.exit(76)'), {...quiet, memory: fine}), {code: 76, started: true});
  assert.deepEqual(await runLimitedResult(home, 'build', node('process.exit(75)'), {...quiet, memory: fine}), {code: 75, started: true});
  assert.equal(await runLimited(home, 'build', node('process.exit(76)'), {...quiet, memory: fine}), 76);
  // 메모리로 못 시작한 75는 started false로 구별된다.
  assert.deepEqual(await runLimitedResult(home, 'build', command, {...quiet, memory: {...MAC, ...clock(), waitMs: 2000, measure: () => sample(99)}}),
    {code: 75, started: false});
  // 스위치가 꺼져 있어도 같다.
  assert.deepEqual(await runLimitedResult(home, 'build', node('process.exit(76)'), {...quiet, memory: {enabled: false}}), {code: 76, started: true});
});

test('limit run이 받은 SIGINT·SIGTERM·SIGHUP은 자식 하나가 아니라 그 프로세스 그룹에 간다: 손자까지 끝난다 [표 10·11]', async () => {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const home = freshHome(), {pidFile, command, grandPid} = tree(home);
    const run = start(home, 'build', command);
    await until(() => fs.existsSync(pidFile) && lockCount(home) === 1);
    const pid = grandPid();
    assert.equal(alive(pid), true);
    run.child.kill(signal);
    const result = await run.done;
    assert.equal(result.code, 128 + os.constants.signals[signal], `${signal}: ${result.stderr}`);
    await until(() => !alive(pid), 3000);
    assert.equal(lockCount(home), 0);
  }
});

test('명령은 표준 입력을 받지 않는다: 부모의 표준 입력이 열려 있어도 명령은 바로 끝(EOF)을 읽는다', async () => {
  const home = freshHome();
  // start()는 limit run의 표준 입력을 열린 파이프로 둔다. 명령이 그 파이프를 물려받았다면 끝을 읽지 못해 9로 끝난다.
  const result = await start(home, 'build', node(`
    process.stdin.on('end', () => process.exit(0)); process.stdin.resume();
    setTimeout(() => process.exit(9), 5000);
  `)).done;
  assert.equal(result.code, 0, result.stderr);
});

test('끝난 뒤 남는 것이 없다: 정상 종료·실패·실행 파일 없음 어느 쪽이든 타이머·신호 처리기·자리가 남지 않는다 [표 11]', async () => {
  const home = freshHome(), before = residue();
  const memory = {...MAC, pollMs: 10, measure: () => sample(20)};
  assert.deepEqual(await runLimitedResult(home, 'build', node('setTimeout(() => {}, 60)'), {...quiet, memory}), {code: 0, started: true});
  assert.equal(residue(), before);
  assert.deepEqual(await runLimitedResult(home, 'build', node('setTimeout(() => process.exit(7), 60)'), {...quiet, memory}), {code: 7, started: true});
  assert.equal(residue(), before);
  const logs = [];
  assert.deepEqual(await runLimitedResult(home, 'build', [path.join(home, '없는-실행-파일')], {...quiet, log: m => logs.push(m), memory}),
    {code: 127, started: false});
  assert.match(logs.at(-1), /^실행 실패:/);
  assert.equal(residue(), before);
  assert.equal(lockCount(home), 0);
});

// ---- 2026-11-22 검수(exec-3ab62698) 발견을 개정된 동작 표로 고정한 회귀 시험. [재현 N행]은 검수자 재현 시험의 줄 번호다 ----
// 준비한 읽기를 실행 중 회차에 차례로 주고, 다 쓰면 명령을 스스로 끝나게 한다(끊기지 않았다면 종료 0).
async function runReadings(readings) {
  const home = freshHome(), release = path.join(home, 'release'), logs = [], queue = [...readings];
  const command = node(`
    const fs = require('fs');
    setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(0); }, 10);
    setTimeout(() => process.exit(3), 20000);
  `);
  let calls = 0;
  const outcome = await runLimitedResult(home, 'build', command, {...quiet, log: m => logs.push(m),
    memory: {...MAC, pollMs: 15, graceMs: 5000, measure: () => {
      calls += 1;
      if (calls === 1) return sample(20); // 시작 관문
      if (!queue.length) { fs.writeFileSync(release, 'x'); return sample(20); }
      return queue.shift();
    }}});
  assert.equal(lockCount(home), 0);
  return {outcome, logs, left: queue.length};
}

test('두 기준은 따로 센다: 85%와 위급+75%를 한 번씩 번갈아 만족하면 끊지 않고, 어느 한쪽이 2번 연속이면 끊는다 [표 5·6, 재현 18행]', async () => {
  const urgent = pct => sample(pct, {pressure: 4});
  const kept = {code: 0, started: true}, cut = {code: 76, started: true, memoryStop: true};
  const over = /^메모리 보호로 명령을 끊음\(종료 76\): .*\. 압축 공간 85% 이상이 2번 연속이라 이 명령의 프로세스 그룹을 끊는다/;
  const critical = /^메모리 보호로 명령을 끊음\(종료 76\): .*\. 압박 위급이면서 압축 공간 75% 이상이 2번 연속이라 이 명령의 프로세스 그룹을 끊는다/;
  for (const [label, readings, expected, reason] of [
    ['85%·정상 → 80%·위급', [sample(85), urgent(80)], kept],
    ['80%·위급 → 85%·정상', [urgent(80), sample(85)], kept],
    ['85% → 80%·위급 → 85%', [sample(85), urgent(80), sample(85)], kept],
    ['85% → 80%·정상', [sample(85), sample(80)], kept],
    ['85% 두 번', [sample(85), sample(85)], cut, over],
    ['80%·위급 두 번', [urgent(80), urgent(80)], cut, critical],
    ['90%·위급 → 80%·위급: (나)가 2번', [urgent(90), urgent(80)], cut, critical],
    ['80%·위급 → 90%·위급: (나)가 2번', [urgent(80), urgent(90)], cut, critical],
    ['90%·위급 → 85%·정상: (가)가 2번', [urgent(90), sample(85)], cut, over],
  ]) {
    const {outcome, logs, left} = await runReadings(readings);
    assert.deepEqual(outcome, expected, label);
    assert.equal(left, 0, `${label}: 준비한 읽기를 모두 썼다`);
    if (reason) assert.match(logs.at(-1), reason, label);
    else assert.deepEqual(logs, [], label);
  }
});

test('도는 중에 끄는 스위치 파일을 놓으면 다음 회차부터 재지 않고 셈을 0으로 돌리며, 치우면 다시 잰다 [표 4, 재현 39행]', async () => {
  const home = freshHome(), off = path.join(home, 'memory-check.off');
  const ready = path.join(home, 'ready'), release = path.join(home, 'release');
  const command = node(`
    const fs = require('fs');
    fs.writeFileSync(${JSON.stringify(ready)}, 'x');
    setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(0); }, 10);
    setTimeout(() => process.exit(3), 20000);
  `);
  // enabled를 넣지 않고 실제 스위치 판정으로 본다. 시험 실행기가 깐 이 프로세스의 스위치는 잠시 치운다.
  const inherited = process.env[MEMORY_OFF_ENV];
  delete process.env[MEMORY_OFF_ENV];
  try {
    let phase = 'before', whileOff = 0, afterBack = 0;
    const outcome = await runLimitedResult(home, 'build', command, {...quiet,
      memory: {platform: 'darwin', pollMs: 15, graceMs: 5000, measure: () => {
        if (fs.existsSync(off)) { whileOff += 1; return sample(91); } // 꺼져 있는데 쟀다면 여기로 온다
        if (!fs.existsSync(ready)) return sample(20);
        if (phase === 'before') {
          // 위험한 읽기 1번(셈 1) 직후 스위치를 놓는다. 회차 간격의 여러 배 뒤에 치운다: 그 사이 꺼진 회차가 적어도 한 번 돈다.
          phase = 'off';
          fs.writeFileSync(off, '격리 시험 스위치');
          setTimeout(() => { fs.rmSync(off); phase = 'back'; }, 200);
          return sample(91);
        }
        afterBack += 1;
        // 꺼진 회차가 셈을 0으로 돌렸으므로 이 위험한 읽기는 다시 1번째다(이어 셌다면 2번째라 끊긴다).
        if (afterBack === 1) return sample(91);
        fs.writeFileSync(release, 'x');
        return sample(20);
      }}});
    assert.deepEqual(outcome, {code: 0, started: true});
    assert.equal(whileOff, 0, '스위치가 놓인 동안에는 재지 않는다');
    assert.ok(afterBack >= 2, '스위치를 치운 뒤 다시 쟀다');
    assert.equal(phase, 'back');
    assert.equal(lockCount(home), 0);
  } finally { if (inherited !== undefined) process.env[MEMORY_OFF_ENV] = inherited; }
});

test('끄는 스위치가 놓인 채 시작해도 도는 중에 치우면 다음 회차부터 재서 끊는다 [표 4]', async () => {
  const home = freshHome(), off = path.join(home, 'memory-check.off'), {pidFile, command, grandPid} = tree(home);
  fs.writeFileSync(off, '격리 시험 스위치');
  const inherited = process.env[MEMORY_OFF_ENV];
  delete process.env[MEMORY_OFF_ENV];
  try {
    let calls = 0;
    const logs = [];
    const run = runLimitedResult(home, 'build', command, {...quiet, log: m => logs.push(m),
      memory: {platform: 'darwin', pollMs: 15, graceMs: 5000, measure: () => { calls += 1; return sample(93); }}});
    await until(() => fs.existsSync(pidFile));
    await new Promise(resolve => setTimeout(resolve, 150)); // 꺼진 회차가 여러 번 돈다
    assert.equal(calls, 0, '시작 관문도 꺼진 회차도 재지 않는다');
    assert.deepEqual(logs, []);
    fs.rmSync(off);
    assert.deepEqual(await run, {code: 76, started: true, memoryStop: true});
    assert.equal(calls, 2);
    await until(() => !alive(grandPid()), 3000);
    assert.equal(lockCount(home), 0);
  } finally { if (inherited !== undefined) process.env[MEMORY_OFF_ENV] = inherited; }
});

test('시작 전 대기는 측정에 걸린 시간만큼 덜 쉰다: 측정이 1.1초씩 걸려도 90초에 자리를 푼다 [표 3, 재현 73행]', async () => {
  const {home, mark, command} = memoryHome(), slept = [];
  let now = 0, calls = 0;
  const outcome = await runLimitedResult(home, 'build', command, {...quiet,
    memory: {...MAC, now: () => now, sleepFn: async ms => { slept.push(ms); now += ms; },
      measure: () => { now += 1100; calls += 1; return sample(95); }}});
  assert.deepEqual({now, calls, outcome}, {now: 90_000, calls: 18, outcome: {code: 75, started: false}});
  assert.deepEqual([...new Set(slept)], [3900]); // 5초 간격에서 측정 1.1초를 뺀 만큼만 쉰다
  assert.equal(fs.existsSync(mark), false);
  assert.equal(lockCount(home), 0);
  // 상한까지 남은 시간보다 오래 쉬지 않는다: 상한 12초면 5초·5초 뒤에는 2초만 쉬고 12초에 푼다.
  const late = memoryHome(), lateSlept = [];
  let clockMs = 0, lateCalls = 0;
  assert.deepEqual(await runLimitedResult(late.home, 'build', late.command, {...quiet,
    memory: {...MAC, waitMs: 12_000, now: () => clockMs, sleepFn: async ms => { lateSlept.push(ms); clockMs += ms; },
      measure: () => { lateCalls += 1; return sample(95); }}}),
    {code: 75, started: false});
  assert.deepEqual({lateSlept, clockMs, lateCalls}, {lateSlept: [5000, 5000, 2000], clockMs: 12_000, lateCalls: 3});
  // 상한은 "90초 + 측정 1회"다: 89.9초에 시작한 측정이 1.1초 걸리면 91초에 푼다.
  const edge = memoryHome();
  let edgeMs = 0, edgeCalls = 0;
  assert.deepEqual(await runLimitedResult(edge.home, 'build', edge.command, {...quiet,
    memory: {...MAC, now: () => edgeMs, sleepFn: async () => { edgeMs = 89_900; },
      measure: () => { edgeCalls += 1; if (edgeCalls === 2) edgeMs += 1100; return sample(edgeCalls === 1 ? 95 : 10); }}}),
    {code: 75, started: false});
  assert.deepEqual({edgeMs, edgeCalls}, {edgeMs: 91_000, edgeCalls: 2});
});

test('명령이 정상으로 끝나면 같은 그룹에 손자가 남아 있어도 자리를 푼다(받아들인 한계: 끝날 때 그룹을 정리하지 않는다) [표 11·한계, 재현 88행]', async t => {
  const nativeKill = process.kill.bind(process), groupSignals = [];
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid < 0 && signal !== 0) groupSignals.push(signal);
    return nativeKill(pid, signal);
  });
  for (const code of [0, 7]) {
    const home = freshHome(), pidFile = path.join(home, 'grandchild.pid');
    const stop = path.join(home, 'stop'), heard = path.join(home, 'heard');
    leftovers.add(pidFile);
    const grand = `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setInterval(() => { if (fs.existsSync(${JSON.stringify(stop)})) { fs.writeFileSync(${JSON.stringify(heard)}, 'x'); process.exit(0); } }, 10);
      setTimeout(() => process.exit(0), 20000);`;
    const command = node(`
      const fs = require('fs');
      require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grand)}], {stdio: 'ignore'}).unref();
      setInterval(() => { if (fs.existsSync(${JSON.stringify(pidFile)})) process.exit(${code}); }, 10);
      setTimeout(() => process.exit(111), 20000);
    `);
    const before = residue();
    const outcome = await runLimitedResult(home, 'build', command, {...quiet, memory: {...MAC, pollMs: 15, measure: () => sample(20)}});
    assert.deepEqual(outcome, {code, started: true});
    assert.equal(lockCount(home), 0); // 손자가 남아 있어도 자리는 풀렸다
    assert.equal(residue(), before); // 타이머·신호 처리기는 정리됐다
    assert.deepEqual(groupSignals, []); // 그룹에 신호를 보내지 않았다
    // 손자는 실제로 돌고 있다: 멈춤 파일에 스스로 답하고 끝난다(좀비가 아니다).
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.equal(alive(pid), true);
    fs.writeFileSync(stop, 'x');
    await until(() => fs.existsSync(heard), 3000);
    await until(() => !alive(pid), 3000);
  }
});

test('그룹 번호: 조회에서 없다고 본 뒤에는 같은 번호가 다시 보여도 조회도 신호도 하지 않는다 [표 5·한계, 재현 134행]', async t => {
  const home = freshHome(), ready = path.join(home, 'ready'), stop = path.join(home, 'stop');
  const nativeKill = process.kill.bind(process), calls = [];
  let seenGone = false;
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid > 0) return nativeKill(pid, signal); // 잠금 주인 확인 등은 그대로
    calls.push([signal, seenGone ? '없다고 본 뒤' : '원래 그룹']);
    if (seenGone) return true; // 같은 번호의 다른 그룹이 보이는 상황. 여기로 오면 안 된다
    if (signal === 'SIGTERM') { fs.writeFileSync(stop, 'x'); return true; } // 원래 그룹은 곧 스스로 끝난다
    try { return nativeKill(pid, signal); }
    catch (error) { if (error.code === 'ESRCH') seenGone = true; throw error; }
  });
  const command = node(`
    const fs = require('fs');
    fs.writeFileSync(${JSON.stringify(ready)}, 'x');
    setInterval(() => { if (fs.existsSync(${JSON.stringify(stop)})) process.exit(0); }, 5);
    setTimeout(() => process.exit(99), 20000);
  `);
  const outcome = await runLimitedResult(home, 'build', command, {...quiet,
    memory: {...MAC, pollMs: 15, graceMs: 5000, goneMs: 5000, measure: () => sample(fs.existsSync(ready) ? 91 : 20)}});
  assert.deepEqual(outcome, {code: 76, started: true, memoryStop: true});
  assert.equal(seenGone, true, '조회가 그룹 없음(ESRCH)을 봤다');
  assert.deepEqual(calls.filter(([, when]) => when === '없다고 본 뒤'), []);
  assert.deepEqual(calls.filter(([signal]) => signal !== 0).map(([signal]) => signal), ['SIGTERM']); // SIGKILL을 보내지 않았다
  assert.equal(lockCount(home), 0);
});

test('SIGKILL 뒤에도 그룹이 보이면 정해진 시간만 보고 "그룹이 남았다" 한 줄을 남긴 뒤 자리를 푼다 [표 5]', async t => {
  const home = freshHome(), ready = path.join(home, 'ready'), stop = path.join(home, 'stop'), logs = [];
  const nativeKill = process.kill.bind(process), signals = [];
  // 그룹이 끝내 사라지지 않는 것처럼 보이게 한다(죽지 않는 프로세스, 또는 그 번호가 다른 그룹에 다시 쓰인 경우 — 번호로만 알아보는 한계).
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid > 0) return nativeKill(pid, signal);
    if (signal === 0) return true;
    signals.push(signal);
    if (signal === 'SIGTERM') fs.writeFileSync(stop, 'x'); // 실제 명령은 스스로 끝나 시험 뒤에 남지 않는다
    return true;
  });
  const command = node(`
    const fs = require('fs');
    fs.writeFileSync(${JSON.stringify(ready)}, 'x');
    setInterval(() => { if (fs.existsSync(${JSON.stringify(stop)})) process.exit(0); }, 5);
    setTimeout(() => process.exit(99), 20000);
  `);
  const before = residue(), graceMs = 150, goneMs = 250;
  let stopAt = null;
  const outcome = await runLimitedResult(home, 'build', command, {...quiet,
    log: m => { logs.push(m); if (/^메모리 보호로 명령을 끊음/.test(m)) stopAt = performance.now(); },
    memory: {...MAC, pollMs: 15, graceMs, goneMs, measure: () => sample(fs.existsSync(ready) ? 91 : 20)}});
  const took = performance.now() - stopAt;
  assert.deepEqual(outcome, {code: 76, started: true, memoryStop: true});
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.match(logs.at(-1), /^메모리 보호: SIGKILL 뒤 \d+초가 지나도 프로세스 그룹\(\d+\)이 남았다\. 자리는 푼다/);
  assert.ok(took >= (graceMs + goneMs) * 0.9, `정해진 시간을 다 보지 않음: ${took}ms`);
  assert.ok(took < 5000, `무기한 쥐지 않는다: ${took}ms`);
  assert.equal(lockCount(home), 0);
  assert.equal(residue(), before);
  assert.equal(MEMORY_GROUP_GONE_MS, 10_000);
});

test('beforeStart·afterExit는 자리를 쥔 동안 부르고, 75로 시작하지 못하면 부르지 않으며, 예외가 나도 자리는 풀린다 [표 12]', async () => {
  const {home, mark, command} = memoryHome(), order = [];
  const fine = {...MAC, pollMs: 10, measure: () => sample(20)};
  const hooks = {
    beforeStart: () => order.push(['before', lockCount(home), fs.existsSync(mark)]),
    afterExit: result => order.push(['after', lockCount(home), fs.existsSync(mark), result]),
  };
  assert.deepEqual(await runLimitedResult(home, 'build', command, {...quiet, memory: fine, ...hooks}), {code: 0, started: true});
  assert.deepEqual(order, [['before', 1, false], ['after', 1, true, {code: 0, started: true}]]);
  assert.equal(lockCount(home), 0);
  // 시작하지 못한 75: 둘 다 부르지 않는다.
  order.length = 0;
  fs.rmSync(mark);
  assert.deepEqual(await runLimitedResult(home, 'build', command, {...quiet, ...hooks,
    memory: {...MAC, ...clock(), measure: () => sample(99)}}), {code: 75, started: false});
  assert.deepEqual(order, []);
  // 실패한 명령과 띄우지 못한 명령에도 afterExit는 결과와 함께 불린다.
  await runLimitedResult(home, 'build', node('process.exit(7)'), {...quiet, memory: fine, ...hooks});
  await runLimitedResult(home, 'build', [path.join(home, '없는-실행-파일')], {...quiet, memory: fine, ...hooks});
  assert.deepEqual(order.filter(([name]) => name === 'after').map(entry => entry.at(-1)),
    [{code: 7, started: true}, {code: 127, started: false}]);
  assert.ok(order.every(([, locks]) => locks === 1));
  // 예외: 그대로 나가고 자리·타이머·신호 처리기는 남지 않는다.
  const before = residue();
  await assert.rejects(runLimitedResult(home, 'build', command, {...quiet, memory: fine,
    beforeStart: () => { throw new Error('시작 직전 처리 실패'); }}), /시작 직전 처리 실패/);
  assert.equal(fs.existsSync(mark), false); // 명령은 띄우지 않았다
  assert.equal(lockCount(home), 0);
  assert.equal(residue(), before);
  await assert.rejects(runLimitedResult(home, 'build', command, {...quiet, memory: fine,
    afterExit: () => { throw new Error('끝난 직후 처리 실패'); }}), /끝난 직후 처리 실패/);
  assert.equal(fs.existsSync(mark), true);
  assert.equal(lockCount(home), 0);
  assert.equal(residue(), before);
});

test('옛 <종류>-N.lock은 세지도 회수하지도 않는다(머지 직후 잠깐 겹침을 막는 장치는 없다)', async () => {
  const home = freshHome();
  writeLock(home, 'rust-1.lock', {pid: process.pid, kind: 'rust', since: iso(Date.now()), startToken: myToken});
  assert.deepEqual(limitHolders(home), []);
  const result = await start(home, 'build', node('process.exit(0)')).done;
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stderr, /대기/);
  assert.ok(fs.existsSync(path.join(home, 'limits', 'rust-1.lock')));
});

// ---- 2026-11-21 검수 중요 4건: 검수자의 재현 순서를 기대 동작으로 옮긴 시험 ----
const aged = (file, ms = ORPHAN_LOCK_MS + 5000) => { const t = new Date(Date.now() - ms); fs.utimesSync(file, t, t); };
const holderOf = (pid, kind) => ({pid, kind, since: new Date(0).toISOString()});

test('잠금 생성은 내용과 함께 한 번에 만들어진다: 내용 없는 잠금이 보이지 않고 임시 파일도 남지 않는다', () => {
  const home = freshHome(), file = path.join(home, 'limits', 'heavy-1.lock');
  assert.equal(createExclusive(file, {pid: 1, kind: 'build'}), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {pid: 1, kind: 'build'});
  assert.equal(createExclusive(file, {pid: 2}), false); // 이미 있으면 거절, 내용은 그대로
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['heavy-1.lock']);
});

test('내용 없음·깨진 JSON·pid 없음 잠금: 오래되면 세 종류 모두 회수하고, 막 생긴 것은 바로 회수하지 않는다', () => {
  for (const [label, content] of [['빈 파일', ''], ['깨진 JSON', '{"pid": 12'], ['JSON 아님', 'garbage'], ['pid 없음', '{"kind":"build"}']]) {
    for (const kind of ['build', 'install', 'rust']) {
      const home = freshHome();
      writeLock(home, 'heavy-1.lock', content);
      const lock = path.join(home, 'limits', 'heavy-1.lock');
      fs.writeFileSync(lock, content);
      assert.equal(tryAcquireLimit(home, holderOf(process.pid, kind)), null, `${label}: 막 생긴 잠금은 두고 기다린다`);
      assert.equal(fs.readFileSync(lock, 'utf8'), content, `${label}: 그대로`);
      aged(lock);
      assert.equal(tryAcquireLimit(home, holderOf(process.pid, kind)), lock, `${label}/${kind}: 오래되면 회수`);
      assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).kind, kind);
    }
  }
});

test('빈 잠금이 오래되면 실제 limit run도 기다리지 않고 자리를 잡는다', async () => {
  const home = freshHome(), lock = path.join(home, 'limits', 'heavy-1.lock');
  fs.mkdirSync(path.dirname(lock)); fs.writeFileSync(lock, ''); aged(lock);
  const result = await start(home, 'rust', node('process.exit(0)')).done;
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /대기/);
  assert.equal(lockCount(home), 0);
});

test('동시 회수: 둘째 회수자가 옛 주인을 읽은 직후 첫째가 회수하고 새로 잡아도, 둘째는 자리를 얻지 못하고 기다린다', () => {
  const home = freshHome();
  const original = {...holderOf(process.ppid, 'rust'), startToken: 'linux:deadbeef:1'};
  const lock = tryAcquireLimit(home, original);
  const fresh = () => 'linux:deadbeef:2'; // 표지가 달라 옛 주인은 pid-reused(죽은 잠금)
  let resultA = null, stateA = null, injected = false;
  const resultB = tryAcquireLimit(home, holderOf(process.pid, 'build'), {
    startToken() {
      if (!injected) { // 둘째의 첫 판정 직후, 첫째가 먼저 회수하고 새 잠금을 잡는다
        injected = true;
        resultA = tryAcquireLimit(home, holderOf(process.ppid, 'install'), {startToken: fresh});
        stateA = limitHolders(home)[0];
      }
      return fresh();
    },
  });
  assert.equal(resultA, lock);
  assert.equal(stateA.state, 'alive');
  assert.equal(stateA.kind, 'install');
  assert.equal(resultB, null, '둘째는 살아 있는 새 주인의 잠금을 치우지 않는다');
  const [now] = limitHolders(home);
  assert.deepEqual([now.kind, now.pid, now.state], ['install', process.ppid, 'alive']);
  assert.deepEqual(fs.readdirSync(path.join(home, 'limits')), ['heavy-1.lock']); // 회수 표지·옛 잠금 조각이 남지 않는다
});

const readLock = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const deadLock = home => { writeLock(home, 'heavy-1.lock', {pid: deadPid(), kind: 'rust', since: iso(Date.now())}); return path.join(home, 'limits', 'heavy-1.lock'); };

test('회수 표지 1: 살아 있는 회수자가 rename 직전에 멈춰 표지가 오래돼도(11초) 둘째는 표지를 치우지 않고 기다린다', () => {
  const home = freshHome();
  const lock = tryAcquireLimit(home, {...holderOf(process.ppid, 'rust'), startToken: 'linux:deadbeef:1'});
  const guard = `${lock}.reclaim`;
  const mineToken = processStartToken(process.pid);
  // 옛 주인(ppid)의 표지만 다른 값으로 속이고, 회수자(이 프로세스)는 실제 표지를 돌려준다.
  const deps = {startToken: pid => (pid === process.pid ? mineToken : 'linux:deadbeef:2')};
  const rename = fs.renameSync;
  let paused = false, first, second, owner;
  fs.renameSync = (from, to) => {
    if (from === lock && !paused) {
      paused = true;
      aged(guard, 11_000); // 표지 수정 시각만 11초 전
      first = tryAcquireLimit(home, holderOf(process.ppid, 'install'), deps);
      second = tryAcquireLimit(home, holderOf(process.ppid, 'install'), deps);
      owner = fs.existsSync(guard) ? readLock(guard).pid : null;
    }
    return rename(from, to);
  };
  let resultA;
  try { resultA = tryAcquireLimit(home, holderOf(process.pid, 'build'), deps); } finally { fs.renameSync = rename; }
  assert.ok(paused);
  assert.equal(first, null);
  assert.equal(second, null);
  assert.equal(owner, process.pid, '둘째가 표지를 치우지 않았다');
  assert.equal(resultA, lock); // 첫째가 이어서 정상 회수·획득
  assert.deepEqual([readLock(lock).kind, readLock(lock).pid], ['build', process.pid]);
  assert.deepEqual(fs.readdirSync(path.dirname(lock)), ['heavy-1.lock']);
});

test('회수 표지 1b: 회수자가 표지를 쥔 채 죽었으면(PID 없음) 다음 사람이 표지를 치우고 회수·획득한다', () => {
  const home = freshHome(), lock = deadLock(home), guard = `${lock}.reclaim`;
  fs.writeFileSync(guard, JSON.stringify({pid: deadPid(), since: iso(Date.now()), nonce: 'gone'}));
  assert.equal(tryAcquireLimit(home, holderOf(process.pid, 'build')), lock);
  assert.equal(readLock(lock).pid, process.pid);
  assert.deepEqual(fs.readdirSync(path.dirname(lock)), ['heavy-1.lock']);
});

test('회수 표지 1c: 내용 없음·깨진 표지는 잠금과 같은 고아 규칙이다(60초 넘으면 치움, 막 생긴 것은 둠)', () => {
  for (const body of ['', 'garbage', '{"pid": 12']) {
    const home = freshHome(), lock = deadLock(home), guard = `${lock}.reclaim`;
    fs.writeFileSync(guard, body);
    assert.equal(tryAcquireLimit(home, holderOf(process.pid, 'build')), null, `막 생긴 표지(${JSON.stringify(body)})는 둔다`);
    assert.equal(fs.existsSync(guard), true);
    aged(guard);
    assert.equal(tryAcquireLimit(home, holderOf(process.pid, 'build')), lock, '오래된 표지는 치우고 회수');
    assert.equal(readLock(lock).pid, process.pid);
  }
});

test('실행 파일이 없으면 started false·코드 127이다', async () => {
  const home = freshHome(), logs = [];
  const outcome = await runLimitedResult(home, 'build', [path.join(home, '없는-실행-파일')], {env: {}, log: m => logs.push(m), stdio: 'ignore',
    memory: {enabled: false}});
  assert.deepEqual(outcome, {code: 127, started: false});
  assert.match(logs.at(-1), /^실행 실패:/);
  assert.equal(lockCount(home), 0);
});
