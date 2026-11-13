import './helpers/isolated-home.mjs';
import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {limitEnv, limitHolders, lockOwnerState, processStartToken, tryAcquireLimit} from '../src/heavy-limit.mjs';
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
  assert.match(rb.stderr, /대기: rust 자리 모두 사용 중 — rust-1\.lock pid \d+/);
  assert.equal(lockCount(home), 0);
});

test('install은 동시에 둘까지 바로 돈다', async () => {
  const home = freshHome();
  const jobs = [1, 2].map(() => start(home, 'install', node('setTimeout(()=>{},3000)')));
  await until(() => lockCount(home) === 2);
  const results = await Promise.all(jobs.map(j => j.done));
  assert.deepEqual(results.map(r => [r.code, /대기/.test(r.stderr)]), [[0, false], [0, false]]);
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
  fs.writeFileSync(path.join(home, 'limits', 'rust-1.lock'), JSON.stringify({pid: Number(dead.stdout.trim()), command: ['cargo', 'build']}));
  assert.equal(limitHolders(home, 'rust')[0].alive, false);
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
  const [held] = limitHolders(home, 'rust');
  assert.equal(held.pid, job.child.pid);
  assert.equal(held.startToken, processStartToken(job.child.pid));
  assert.equal(held.state, 'alive');
  fs.writeFileSync(release, '');
  assert.equal((await job.done).code, 0);
});

test('PID 재사용: 주인 PID가 살아 있어도 시작 표지가 다르면 회수해 자리를 잡는다', async () => {
  const home = freshHome();
  writeLock(home, 'rust-1.lock', {pid: process.pid, kind: 'rust', command: ['cargo', 'build'], since: iso(Date.now()), startToken: otherToken(myToken)});
  const [seen] = limitHolders(home, 'rust');
  assert.equal(seen.state, 'pid-reused'); assert.equal(seen.alive, false);
  const result = await start(home, 'rust', node('process.exit(0)')).done;
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /대기/);
  assert.equal(lockCount(home), 0);
});

test('시작 표지가 같으면 살아 있는 주인이다: 잡지 못하고 기다린다', async () => {
  const home = freshHome(), mark = path.join(home, 'ran');
  writeLock(home, 'rust-1.lock', {pid: process.pid, kind: 'rust', command: ['cargo', 'build'], since: iso(Date.now()), startToken: myToken});
  assert.equal(limitHolders(home, 'rust')[0].state, 'alive');
  const waiting = start(home, 'rust', node(`require('fs').writeFileSync(${JSON.stringify(mark)}, 'x')`));
  await until(() => /대기: rust 자리 모두 사용 중/.test(waiting.out.stderr));
  assert.doesNotMatch(waiting.out.stderr, /죽음|PID 재사용/);
  assert.equal(fs.existsSync(mark), false);
  // 시험이 만든 격리 홈의 잠금을 치워 자리를 내준다(주인이 일을 끝낸 것과 같다).
  fs.renameSync(path.join(home, 'limits', 'rust-1.lock'), path.join(home, 'released.lock'));
  assert.equal((await waiting.done).code, 0);
  assert.equal(fs.existsSync(mark), true);
});

test('시계 보정: 판정은 잠금 시각(since)과 벽시계를 보지 않는다 — 표지가 같으면 살아 있는 주인이다', () => {
  const home = freshHome(), started = processStartedAt(process.pid);
  // 잠금을 잡은 뒤 시계가 앞으로 5초·1시간 보정된 것처럼 since가 프로세스 시작보다 이르게 보여도 회수하지 않는다.
  for (const since of [iso(started - 5000), iso(started - 3600_000), iso(Date.now() + 3600_000), undefined]) {
    writeLock(home, 'rust-1.lock', {pid: process.pid, kind: 'rust', since, startToken: myToken});
    assert.equal(limitHolders(home, 'rust')[0].state, 'alive', String(since));
    assert.equal(tryAcquireLimit(home, 'rust', {pid: process.pid, kind: 'rust'}), null);
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
  assert.equal(linuxToken(procFiles({comm: 'a) S 1 2 (b'})), `linux:${BOOT}:987654`);
  assert.equal(linuxToken(procFiles({ticks: 'x'})), null);
  assert.equal(linuxToken(procFiles({boot: ''})), null);
  assert.equal(linuxToken(() => { throw new Error('EACCES'); }), null);
  for (const pid of [0, -1, 1.5, '4321', null]) assert.equal(processStartToken(pid, {run: noPs, readFile: noPs}), null);
});

test('표시: status와 대기 줄이 죽은 PID와 PID 재사용을 구분해 보인다', async () => {
  const home = freshHome(), dead = deadPid();
  // rust는 자리가 하나다. 2·3번 잠금 파일은 자리 밖이라 회수되지 않고 표시만 된다.
  writeLock(home, 'rust-1.lock', {pid: process.pid, kind: 'rust', since: iso(Date.now()), startToken: myToken});
  writeLock(home, 'rust-2.lock', {pid: process.pid, kind: 'rust', since: iso(Date.now()), startToken: otherToken(myToken)});
  writeLock(home, 'rust-3.lock', {pid: dead, kind: 'rust', since: iso(Date.now()), startToken: myToken});
  const status = spawnSync(process.execPath, [cli, 'limit', 'status'], {env: {...process.env, KADAN_HOME: home}, encoding: 'utf8'});
  assert.equal(status.status, 0, status.stderr);
  const holders = Object.fromEntries(JSON.parse(status.stdout).holders.map(h => [h.lock, h]));
  assert.deepEqual(['rust-1.lock', 'rust-2.lock', 'rust-3.lock'].map(name => [holders[name].state, holders[name].alive]),
    [['alive', true], ['pid-reused', false], ['dead', false]]);
  const waiting = start(home, 'rust', node('process.exit(0)'));
  await until(() => /대기/.test(waiting.out.stderr));
  assert.match(waiting.out.stderr, new RegExp(`rust-1\\.lock pid ${process.pid} `));
  assert.match(waiting.out.stderr, new RegExp(`rust-2\\.lock pid ${process.pid}\\(PID 재사용: 시작 표지 다름\\)`));
  assert.match(waiting.out.stderr, new RegExp(`rust-3\\.lock pid ${dead}\\(죽음\\)`));
  fs.renameSync(path.join(home, 'limits', 'rust-1.lock'), path.join(home, 'released.lock'));
  assert.equal((await waiting.done).code, 0);
});

// ps를 쓰는 OS에서만: 호출을 적고 진짜 ps로 넘기는 가짜 ps를 PATH 앞에 둔다. Linux는 /proc 파일만 읽어 ps 호출이 없다.
test('대기 한 바퀴에서 주인 하나의 시작 표지는 한 번만 읽는다', {skip: process.platform === 'linux'}, async () => {
  const home = freshHome(), bin = path.join(home, 'bin'), calls = path.join(home, 'ps-calls.txt');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexec /bin/ps "$@"\n`, {mode: 0o755});
  // 같은 주인이 자리 둘을 다 쥔 모양: 한 바퀴에 잠금 둘을 보지만 PID는 하나다.
  for (const name of ['build-1.lock', 'build-2.lock']) writeLock(home, name, {pid: process.pid, kind: 'build', since: iso(Date.now()), startToken: myToken});
  const child = spawn(process.execPath, [cli, 'limit', 'run', 'build', '--', ...node('process.exit(0)')],
    {env: {...process.env, KADAN_HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`}});
  children.add(child);
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  const done = new Promise(resolve => child.on('close', resolve));
  await until(() => /대기: build 자리 모두 사용 중/.test(stderr));
  // 첫 바퀴가 끝난 시점: 회수 시도가 잠금 둘, 대기 줄이 잠금 둘을 봤지만 주인 PID의 ps 호출은 한 번이다(다음 바퀴는 2초 뒤).
  const asked = fs.readFileSync(calls, 'utf8').split('\n').filter(line => line.endsWith(`-p ${process.pid}`));
  assert.equal(asked.length, 1, fs.readFileSync(calls, 'utf8'));
  for (const name of ['build-1.lock', 'build-2.lock']) fs.renameSync(path.join(home, 'limits', name), path.join(home, `released-${name}`));
  assert.equal(await done, 0);
});
