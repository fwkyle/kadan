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
import {MEMORY_OFF_ENV, MEMORY_WAIT_EXIT, judgeMemory, memoryCheckEnabled, parseFreePercent, parseSwapUsedMb, readMemory} from '../src/memory-check.mjs';
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

// ---- 시작 직전 메모리 확인: 실제 memory_pressure·sysctl은 부르지 않는다. 측정·시계·대기는 인자로 넣는다 ----
// 모양은 이 맥의 실제 출력에서 가져왔다(2026-11-21).
const PRESSURE = free => `The system has 17179869184 (1048576 pages with a page size of 16384).\n\nPageouts: 21960 \nSwapins: 0 \nSwapouts: 0 \n\nSystem-wide memory free percentage: ${free}%\n`;
const SWAP = used => `vm.swapusage: total = 2048.00M  used = ${used}  free = 2048.00M  (encrypted)\n`;
const fakeRun = ({free = 58, swap = '0.00M'} = {}) => (cmd) => ({status: 0, stdout: cmd === 'memory_pressure' ? PRESSURE(free) : SWAP(swap)});

test('메모리 파싱: 여유 비율은 마지막 줄 값, 스왑 used는 단위(K·M·G)를 MB로 바꾼다', () => {
  assert.equal(parseFreePercent(PRESSURE(58)), 58);
  assert.equal(parseFreePercent('System-wide memory free percentage: 12%\nSystem-wide memory free percentage: 31%\n'), 31);
  assert.equal(parseSwapUsedMb(SWAP('0.00M')), 0);
  assert.equal(parseSwapUsedMb(SWAP('0.25M')), 0.25);
  assert.equal(parseSwapUsedMb(SWAP('1.50G')), 1536);
  assert.equal(parseSwapUsedMb(SWAP('512.00K')), 0.5);
  for (const bad of ['', 'garbage', undefined, null, 'System-wide memory free percentage: ?%']) assert.equal(parseFreePercent(bad), null);
  for (const bad of ['', 'garbage', undefined, null, 'vm.swapusage: total = 1M']) assert.equal(parseSwapUsedMb(bad), null);
});

test('메모리 판정: 여유 29%는 대기, 30%는 시작; 스왑 used 0.00M은 시작, 0.25M은 대기', () => {
  const judge = (free, swap) => judgeMemory(readMemory({platform: 'darwin', run: fakeRun({free, swap})}));
  assert.equal(judge(29, '0.00M').ok, false);
  assert.equal(judge(30, '0.00M').ok, true);
  assert.equal(judge(58, '0.00M').ok, true);
  assert.equal(judge(58, '0.25M').ok, false);
  assert.equal(judge(29, '0.25M').ok, false);
  assert.match(judge(29, '0.25M').line, /여유 29%\(30% 이상 필요\)·스왑 used 0\.25M\(0이어야 함\)/);
});

test('메모리 읽기: 맥이 아니거나 값을 못 읽으면 막지 않고 이유만 낸다(여유·스왑 어느 쪽이든)', () => {
  assert.deepEqual(readMemory({platform: 'linux', run: () => assert.fail('리눅스에서는 부르지 않는다')}), {skip: '맥이 아님(linux)'});
  const outcomes = [
    ['memory_pressure 없음', () => ({status: null, error: new Error('ENOENT')})],
    ['여유 비율 못 읽음', () => ({status: 0, stdout: 'garbage'})],
    ['실행 예외', () => { throw new Error('boom'); }],
    ['스왑 못 읽음', cmd => ({status: 0, stdout: cmd === 'memory_pressure' ? PRESSURE(10) : 'garbage'})],
  ];
  for (const [label, run] of outcomes) {
    const memory = readMemory({platform: 'darwin', run});
    assert.ok(memory.skip, label);
    assert.deepEqual(judgeMemory(memory), {ok: true, skip: memory.skip}, label);
  }
});

const memoryHome = () => {
  const home = freshHome();
  return {home, mark: path.join(home, 'ran.txt'), command: node(`require('fs').writeFileSync(${JSON.stringify(path.join(home, 'ran.txt'))}, 'x')`)};
};
// 가짜 시계: 대기(sleep)가 시계를 앞으로 보낸다.
const clock = () => { let t = 0; return {now: () => t, sleepFn: async ms => { t += ms; }}; };

test('메모리가 모자라면 자리를 쥔 채 기다리다가 풀리면 명령을 돌린다; 같은 값은 대기 줄을 다시 내지 않는다', async () => {
  const {home, mark, command} = memoryHome(), logs = [], seen = [];
  const readings = [{freePercent: 20, swapUsedMb: 0}, {freePercent: 20, swapUsedMb: 0}, {freePercent: 25, swapUsedMb: 0}, {freePercent: 40, swapUsedMb: 0}];
  const c = clock();
  const code = await runLimited(home, 'build', command, {env: {}, log: m => logs.push(m), stdio: 'ignore',
    memory: {enabled: true, ...c, pollMs: 1000, waitMs: 60_000, measure: () => {
      seen.push(lockCount(home)); // 재는 동안에도 자리는 쥐고 있다
      return readings.shift();
    }}});
  assert.equal(code, 0);
  assert.deepEqual(seen, [1, 1, 1, 1]);
  assert.ok(fs.existsSync(mark));
  const waits = logs.filter(m => /^대기: 메모리 부족/.test(m));
  assert.equal(waits.length, 2, logs.join('\n')); // 20% 한 번(두 번째 같은 값은 생략), 25% 한 번
  assert.match(waits[0], /여유 20%\(30% 이상 필요\)·스왑 used 0M\(0이어야 함\)\. 자리는 쥔 채 기다림\(최대 1분\)/);
  assert.equal(lockCount(home), 0);
});

test('대기 상한을 넘으면 명령을 돌리지 않고 자리를 풀고 종료 코드 75와 잰 값을 낸다', async () => {
  const {home, mark, command} = memoryHome(), logs = [];
  const code = await runLimited(home, 'build', command, {env: {}, log: m => logs.push(m), stdio: 'ignore',
    memory: {enabled: true, ...clock(), pollMs: 1000, waitMs: 3000, measure: () => ({freePercent: 12, swapUsedMb: 300})}});
  assert.equal(code, MEMORY_WAIT_EXIT);
  assert.equal(MEMORY_WAIT_EXIT, 75);
  assert.equal(fs.existsSync(mark), false); // 부작용 없음
  assert.equal(lockCount(home), 0); // 자리를 풀었다
  assert.match(logs.at(-1), /^메모리 부족으로 시작하지 않음\(종료 75\): 여유 12%\(30% 이상 필요\)·스왑 used 300M\(0이어야 함\)\. 3초 기다렸지만/);
  // 시험 실패(1)와 구별된다: 같은 자리에서 다음 명령은 그대로 돈다.
  assert.equal(await runLimited(home, 'build', command, {env: {}, log: () => {}, stdio: 'ignore',
    memory: {enabled: true, measure: () => ({freePercent: 80, swapUsedMb: 0})}}), 0);
  assert.ok(fs.existsSync(mark));
});

test('메모리를 기다리는 동안 자리를 쥐고 있어 다른 무거운 작업은 시작하지 않는다', async () => {
  const {home, mark, command} = memoryHome();
  let enough = false;
  const holder = runLimited(home, 'rust', command, {env: {}, log: () => {}, stdio: 'ignore', pollMs: 10,
    memory: {enabled: true, pollMs: 20, waitMs: 60_000, measure: () => ({freePercent: enough ? 80 : 5, swapUsedMb: 0})}});
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

test('못 읽거나 맥이 아니면 건너뛰고 한 줄만 남긴다(대기 아님); 끄는 스위치 파일이 있으면 재지도 않는다', async () => {
  const {home, mark, command} = memoryHome(), logs = [];
  const code = await runLimited(home, 'build', command, {env: {}, log: m => logs.push(m), stdio: 'ignore',
    memory: {enabled: true, measure: () => readMemory({platform: 'linux'})}});
  assert.equal(code, 0);
  assert.deepEqual(logs, ['메모리 확인 건너뜀: 맥이 아님(linux)']);
  assert.ok(!logs.some(m => /대기/.test(m)));
  fs.rmSync(mark);
  // 스위치 파일: measure가 불리면 안 된다.
  fs.writeFileSync(path.join(home, 'memory-check.off'), '');
  const quiet = [];
  assert.equal(await runLimited(home, 'build', command, {env: {}, log: m => quiet.push(m), stdio: 'ignore',
    memory: {measure: () => assert.fail('스위치가 있으면 재지 않는다')}}), 0);
  assert.deepEqual(quiet, []);
  assert.ok(fs.existsSync(mark));
  // 환경 변수 스위치(env 인자가 비어 있어도 이 프로세스의 환경을 본다는 것은 아래 기본값 시험이 따로 확인한다).
  assert.equal(memoryCheckEnabled(home, {}), false);
  assert.equal(memoryCheckEnabled(freshHome(), {[MEMORY_OFF_ENV]: 'off'}), false);
});

test('운영 기본은 켜짐이고, tests/run.mjs 아래(KADAN_MEMORY_CHECK=off)는 꺼짐이다', () => {
  assert.equal(memoryCheckEnabled(freshHome(), {}), true);
  assert.equal(memoryCheckEnabled(freshHome(), {[MEMORY_OFF_ENV]: 'on'}), true);
  assert.equal(memoryCheckEnabled(freshHome(), process.env), false, 'npm test(tests/run.mjs)로 돌려야 한다');
  assert.match(fs.readFileSync(fileURLToPath(new URL('./run.mjs', import.meta.url)), 'utf8'), /env\.KADAN_MEMORY_CHECK = 'off'/);
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

test('회수 표지: 다른 회수자가 쥐고 있으면 회수하지 않고, 오래 남은 표지(회수하다 죽음)는 치운 뒤 다음에 회수한다', () => {
  const home = freshHome(), dir = path.join(home, 'limits');
  writeLock(home, 'heavy-1.lock', {pid: deadPid(), kind: 'rust', since: iso(Date.now())});
  const guard = path.join(dir, 'heavy-1.lock.reclaim');
  fs.writeFileSync(guard, '{}');
  assert.equal(tryAcquireLimit(home, holderOf(process.pid, 'build')), null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'heavy-1.lock'), 'utf8')).kind, 'rust');
  aged(guard, 60_000);
  assert.equal(tryAcquireLimit(home, holderOf(process.pid, 'build')), null); // 이번엔 표지만 치운다
  assert.equal(fs.existsSync(guard), false);
  assert.equal(tryAcquireLimit(home, holderOf(process.pid, 'build')), path.join(dir, 'heavy-1.lock'));
});

test('5분 상한: 상한을 넘은 뒤의 측정이 통과여도 시작하지 않는다(종료 75·명령 미실행·자리 해제)', async () => {
  for (const finalFree of [29, 30]) {
    const {home, mark, command} = memoryHome();
    let clock = 0;
    const logs = [];
    const code = await runLimited(home, 'build', command, {env: {}, log: m => logs.push(m), stdio: 'ignore',
      memory: {enabled: true, now: () => clock, sleepFn: async () => { clock = 300_001; }, // MEMORY_WAIT_MS(300000) 직후
        measure: () => ({freePercent: clock === 0 ? 29 : finalFree, swapUsedMb: 0})}});
    assert.equal(code, MEMORY_WAIT_EXIT, `두 번째 측정 ${finalFree}%`);
    assert.equal(fs.existsSync(mark), false);
    assert.equal(lockCount(home), 0);
    assert.match(logs.at(-1), /여유 29%.*5분 기다렸지만/);
  }
  // 상한 직전(299,999ms)의 측정이 통과하면 시작한다.
  const {home, mark, command} = memoryHome();
  let clock = 0;
  assert.equal(await runLimited(home, 'build', command, {env: {}, log: () => {}, stdio: 'ignore',
    memory: {enabled: true, now: () => clock, sleepFn: async () => { clock = 299_999; },
      measure: () => ({freePercent: clock === 0 ? 29 : 30, swapUsedMb: 0})}}), 0);
  assert.ok(fs.existsSync(mark));
});

test('runLimitedResult: 메모리로 못 시작하면 started false, 명령이 돌고 75로 끝나면 started true', async () => {
  const {home, command} = memoryHome();
  let clock = 0;
  const memory = {enabled: true, now: () => clock, sleepFn: async ms => { clock += ms; }, pollMs: 1000, waitMs: 2000,
    measure: () => ({freePercent: 1, swapUsedMb: 0})};
  assert.deepEqual(await runLimitedResult(home, 'build', command, {env: {}, log: () => {}, stdio: 'ignore', memory}),
    {code: MEMORY_WAIT_EXIT, started: false});
  assert.deepEqual(await runLimitedResult(home, 'build', node('process.exit(75)'), {env: {}, log: () => {}, stdio: 'ignore',
    memory: {enabled: true, measure: () => ({freePercent: 90, swapUsedMb: 0})}}), {code: 75, started: true});
  assert.equal(await runLimited(home, 'build', node('process.exit(75)'), {env: {}, log: () => {}, stdio: 'ignore',
    memory: {enabled: true, measure: () => ({freePercent: 90, swapUsedMb: 0})}}), 75);
});
