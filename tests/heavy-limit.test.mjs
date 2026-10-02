import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {limitEnv, limitHolders} from '../src/heavy-limit.mjs';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
// 시험마다 새 카단 폴더. 실사용 카단 폴더의 잠금은 건드리지 않는다.
const freshHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-limit-'));
const node = script => [process.execPath, '-e', script];

function start(home, kind, command) {
  const child = spawn(process.execPath, [cli, 'limit', 'run', kind, '--', ...command], {env: {...process.env, KADAN_HOME: home}});
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
  const job = name => node(`const fs=require('fs');fs.appendFileSync(${JSON.stringify(marks)},'${name}-start '+Date.now()+'\\n');setTimeout(()=>fs.appendFileSync(${JSON.stringify(marks)},'${name}-end '+Date.now()+'\\n'),400)`);
  const a = start(home, 'rust', job('a'));
  await until(() => fs.existsSync(marks));
  const b = start(home, 'rust', job('b'));
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
