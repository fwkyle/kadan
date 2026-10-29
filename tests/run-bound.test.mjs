import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {runTestFile} from './helpers/run-file.mjs';
import {stopChild} from './helpers/child-cleanup.mjs';

const gone = pid => {
  const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], {encoding: 'utf8'});
  return r.status === 1 || (r.status === 0 && r.stdout.trim().startsWith('Z'));
};
function fixture(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-bound-'));
  const file = path.join(dir, 'fake.test.mjs'), info = path.join(dir, 'pids.json');
  fs.writeFileSync(file, `import test from 'node:test'; import fs from 'node:fs';
import {spawn} from 'node:child_process';
test('fake', async () => { ${body} });`);
  return {file, info};
}

test('파일 상한: 단언 실패 뒤 남은 자식·detached 손자까지 끝내고 파일과 PID를 알린다', async () => {
  const f = fixture('');
  fs.writeFileSync(f.file, `import test from 'node:test'; import fs from 'node:fs';
import {spawn} from 'node:child_process';
test('fake', async () => {
  const child = spawn(process.execPath, ['-e',
    "process.on('SIGTERM',()=>{}); console.log('ready'); setTimeout(()=>{},10000)"],
    {detached:true, stdio:['ignore','pipe','ignore']});
  await new Promise(r=>child.stdout.once('data',r));
  fs.writeFileSync(${JSON.stringify(f.info)}, JSON.stringify([process.pid,child.pid]));
  throw new Error('단언 실패를 흉내 낸다');
});`);
  const messages = [], start = Date.now();
  const code = await runTestFile(f.file, {env: process.env, timeoutMs: 2000,
    stdio: 'ignore', report: message => messages.push(message)});
  assert.equal(code, 1);
  assert.ok(Date.now() - start < 6000, '10초 타이머를 끝까지 기다리지 않는다');
  const pids = JSON.parse(fs.readFileSync(f.info, 'utf8'));
  assert.match(messages.join('\n'), /파일 종료 상한 2000ms 초과/);
  assert.ok(messages.some(m => m.includes(f.file)));
  for (const pid of pids) {
    assert.ok(messages.some(m => m.includes(String(pid))), `PID ${pid} 진단`);
    assert.ok(gone(pid), `PID ${pid} 종료`);
  }
});

test('파일 상한: 정상 성공과 정상 실패의 종료 코드는 유지한다', async () => {
  for (const [body, code] of [['', 0], ["throw new Error('expected')", 1]]) {
    const {file} = fixture(body);
    assert.equal(await runTestFile(file, {env: process.env, timeoutMs: 2000, stdio: 'ignore'}), code);
  }
});

test('파일 상한: 중간 부모가 끝난 detached 자손을 정리하고 무관한 자식은 보존한다', async t => {
  const f = fixture('');
  const middle = path.join(path.dirname(f.file), 'middle.mjs');
  fs.writeFileSync(middle, `import {spawn} from 'node:child_process'; import fs from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)'],
  {detached:true, stdio:'ignore'});
child.unref();
fs.writeFileSync(${JSON.stringify(f.info)}, JSON.stringify({pid:child.pid,parent:process.pid}));`);
  fs.writeFileSync(f.file, `import test from 'node:test'; import {spawn} from 'node:child_process';
import {once} from 'node:events';
test('orphan', async () => {
  const p = spawn(process.execPath, [${JSON.stringify(middle)}], {stdio:'ignore'});
  await once(p, 'exit');
  setTimeout(()=>{},5000);
  throw new Error('expected');
});`);
  const sentinel = spawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], {stdio: 'ignore'});
  t.after(() => stopChild(sentinel));
  const messages = [], started = Date.now();
  const code = await runTestFile(f.file, {env: process.env, timeoutMs: 1000,
    stdio: 'ignore', report: message => messages.push(message)});
  const {pid, parent} = JSON.parse(fs.readFileSync(f.info));
  // 실패해도 유한 타이머가 끝날 때까지 확인하여 재현 자손을 남기지 않는다.
  t.after(async () => {
    if (!gone(pid)) await new Promise(resolve => setTimeout(resolve, Math.max(0, 6000 - (Date.now() - started))));
    assert.ok(gone(pid));
  });
  assert.equal(code, 1);
  assert.ok(gone(parent), '상한 전에 중간 부모 종료');
  assert.ok(messages.some(message => message.includes(String(pid))), '분리된 자손 진단');
  assert.ok(gone(pid), '분리된 자손 종료');
  assert.equal(gone(sentinel.pid), false, '파일별 표지가 없는 형제는 유지');
  assert.ok(Date.now() - started < 4500, '유한 종료');
});

test('finally 정리는 단언 실패에도 실행되며 SIGTERM 무응답에는 SIGKILL을 쓴다', async () => {
  const child = spawn(process.execPath, ['-e',
    "process.on('SIGTERM',()=>{}); console.log('ready'); setTimeout(()=>{},10000)"],
  {stdio: ['ignore', 'pipe', 'ignore']});
  try {
    await once(child.stdout, 'data');
    await assert.rejects(async () => {
      try { assert.fail('expected'); } finally { await stopChild(child, 100); }
    }, /expected/);
    assert.equal(child.signalCode, 'SIGKILL');
    assert.ok(gone(child.pid));
  } finally { await stopChild(child); }
});

test('실제 실행기 파일 상한은 단언 실패 뒤 남은 유한 타이머를 기다리지 않는다', () => {
  const f = fixture(`
    spawn(process.execPath, ['-e', 'setTimeout(()=>{},6000)']);
    throw new Error('expected assertion failure');
  `);
  const inject = path.join(path.dirname(f.file), 'clock.mjs');
  // 실행기의 시계만 단축한다. Node 시험 자식의 실행 인자·환경은 바꾸지 않는다.
  fs.writeFileSync(inject, `const original = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => original(fn, ms === 300_000 ? 1000 : ms, ...args);`);
  const runner = process.env.KADAN_BOUND_RUNNER ?? new URL('./run.mjs', import.meta.url).pathname;
  const env = {...process.env}; delete env.NODE_TEST_CONTEXT;
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--import', inject, runner, f.file],
    {env, encoding: 'utf8', timeout: 12_000});
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /파일 종료 상한 .*남은 자식 PID/);
  assert.ok(result.stderr.includes(f.file));
  assert.ok(Date.now() - started < 5000, '6초 자식 수명보다 먼저 실패로 끝난다');
});
