import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';

// 실행기(tests/run.mjs)가 실행별 임시 폴더와 자기 tmux 서버를 성공·실패·중단(SIGINT) 모두에서 정리하는지 본다.
// 가짜 시험 파일이 TMPDIR 아래에 폴더를 만들고 tmux 서버를 띄운 뒤 그 값을 info 파일에 적는다.
const runner = new URL('./run.mjs', import.meta.url).pathname;
const skip = spawnSync('tmux', ['-V']).status !== 0;

function fixture(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-cleanup-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const info = path.join(dir, 'info.json');
  const file = path.join(dir, 'fake.test.mjs');
  fs.writeFileSync(file, `import test from 'node:test';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawnSync} from 'node:child_process';
test('fake', () => {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-'));
  spawnSync('tmux', ['-u', '-L', process.env.KADAN_SOCKET, 'new-session', '-d', 'sleep 300']);
  const pid = Number(spawnSync('tmux', ['-L', process.env.KADAN_SOCKET, 'display', '-p', '#{pid}'], {encoding: 'utf8'}).stdout);
  fs.writeFileSync(${JSON.stringify(info)}, JSON.stringify({tmpdir: process.env.TMPDIR, tmuxTmp: process.env.TMUX_TMPDIR, made, pid}));
  ${body}
});`);
  return {file, info};
}
// 바깥 node --test가 넣는 NODE_TEST_CONTEXT가 있으면 안쪽 node --test가 시험을 실행하지 않고 건너뛴다.
const nestedEnv = () => { const env = {...process.env}; delete env.NODE_TEST_CONTEXT; return env; };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = (fn, ms = 10_000) => new Promise(resolve => {
  const end = Date.now() + ms;
  (function poll() { if (fn() || Date.now() > end) resolve(fn()); else setTimeout(poll, 100); })();
});
const run = (file, env) => new Promise(resolve => {
  const child = spawn(process.execPath, [runner, file], {stdio: 'ignore', env});
  resolve(child);
});
const exited = child => new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));

function assertCleaned(info) {
  const {tmpdir, tmuxTmp, made, pid} = JSON.parse(fs.readFileSync(info, 'utf8'));
  assert.match(path.basename(tmpdir), /^kadan-run-/, '실행별 TMPDIR');
  assert.ok(made.startsWith(tmpdir), '시험이 만든 폴더가 실행별 TMPDIR 안에 있다');
  assert.equal(fs.existsSync(tmpdir), false, '실행별 TMPDIR이 지워졌다');
  assert.ok(tmuxTmp.startsWith(tmpdir), 'tmux 소켓 폴더도 실행별 폴더 안에 있다');
  assert.equal(fs.existsSync(tmuxTmp), false, '실행별 tmux 소켓 폴더가 지워졌다');
  assert.ok(pid > 1);
  return pid;
}

test('실행기: 시험이 성공해도 실행별 폴더와 tmux 서버를 정리한다', {skip}, async t => {
  const {file, info} = fixture(t, '');
  const result = spawnSync(process.execPath, [runner, file], {encoding: 'utf8', env: nestedEnv()});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const pid = assertCleaned(info);
  assert.equal(await waitFor(() => !alive(pid)), true, 'tmux 서버가 끝났다');
});

test('실행기: 시험이 실패하면 종료 코드는 그대로 실패이고 정리는 한다', {skip}, async t => {
  const {file, info} = fixture(t, "throw new Error('일부러 실패');");
  const result = spawnSync(process.execPath, [runner, file], {encoding: 'utf8', env: nestedEnv()});
  assert.notEqual(result.status, 0, '실패가 성공으로 바뀌지 않는다');
  const pid = assertCleaned(info);
  assert.equal(await waitFor(() => !alive(pid)), true, 'tmux 서버가 끝났다');
});

test('실행기: SIGINT로 중단해도 실행별 폴더와 tmux 서버를 정리한다', {skip}, async t => {
  const {file, info} = fixture(t, 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);');
  const child = await run(file, nestedEnv());
  const done = exited(child);
  assert.equal(await waitFor(() => fs.existsSync(info), 20_000), true, '가짜 시험이 시작했다');
  child.kill('SIGINT');
  const {code} = await done;
  assert.equal(code, 130);
  const pid = assertCleaned(info);
  assert.equal(await waitFor(() => !alive(pid)), true, 'tmux 서버가 끝났다');
});

test('실행기: 폴더를 만든 직후 시작 단계에서 예외가 나도 만든 폴더를 남기지 않는다', {skip}, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-fault-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const info = path.join(dir, 'info.json'), inject = path.join(dir, 'inject.mjs');
  // 실행기가 tmux 소켓 폴더를 만드는 순간 EACCES를 던져 시작 단계 실패를 흉내 낸다.
  fs.writeFileSync(inject, `import fs from 'node:fs';
const original = fs.mkdirSync;
fs.mkdirSync = function (p, ...rest) {
  if (/\\/kadan-run-[^/]+\\/tmux$/.test(String(p))) {
    fs.writeFileSync(${JSON.stringify(info)}, JSON.stringify({runTmp: String(p).replace(/\\/tmux$/, '')}));
    throw Object.assign(new Error('주입한 시작 실패'), {code: 'EACCES'});
  }
  return original.call(fs, p, ...rest);
};`);
  const result = spawnSync(process.execPath, ['--import', inject, runner, import.meta.filename], {encoding: 'utf8', env: nestedEnv()});
  assert.notEqual(result.status, 0, '시작 실패는 실패로 끝난다');
  const {runTmp} = JSON.parse(fs.readFileSync(info, 'utf8'));
  assert.match(path.basename(runTmp), /^kadan-run-/);
  assert.equal(fs.existsSync(runTmp), false, '시작 단계 예외 뒤에도 실행별 폴더가 지워졌다');
});
