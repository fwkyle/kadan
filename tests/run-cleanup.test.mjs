import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {stopChild} from './helpers/child-cleanup.mjs';
import {sweepRun, ownership, commandOwned, cwdOwned} from './helpers/run-sweep.mjs';

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
  t.after(() => stopChild(child));
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

// 2026-11-04: 시험 파일이 띄운 격리 tmux 서버·자식이 실행 폴더를 지운 뒤 부모 1로 남았다(11개). 실행기가 끝날 때
// 자기 runTmp 소속만 끄는지 본다. 여기의 tmux 호출은 모두 -L/-S이고, 실행별 TMUX_TMPDIR 안이 아니면 건너뛴다(실패 닫힘).
const runTmux = /\/kadan-run-[^/]+\/tmux$/.test(process.env.TMUX_TMPDIR ?? '');
const skipLeak = skip || !runTmux;

function leakFixture(t, body = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-leak-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const info = path.join(dir, 'info.json'), outside = path.join(dir, 'outside.sock');
  const file = path.join(dir, 'leak.test.mjs');
  // 정리 없이 끝나는 시험: 실행별 TMUX_TMPDIR 아래 -L 서버, 실행 폴더 밖 -S 서버, 분리된 sleep 자식.
  fs.writeFileSync(file, `import test from 'node:test';import fs from 'node:fs';
import {spawn, spawnSync} from 'node:child_process';
test('leak', () => {
  if (!/\\/kadan-run-[^/]+\\/tmux$/.test(process.env.TMUX_TMPDIR ?? '')) throw new Error('실행별 TMUX_TMPDIR 아님');
  const name = 'leak-' + process.pid;
  spawnSync('tmux', ['-u', '-L', name, 'new-session', '-d', 'sleep 300']);
  spawnSync('tmux', ['-u', '-S', ${JSON.stringify(outside)}, 'new-session', '-d', 'sleep 300']);
  const pid = args => Number(spawnSync('tmux', [...args, 'display', '-p', '#{pid}'], {encoding: 'utf8'}).stdout);
  const child = spawn('sleep', ['300'], {cwd: process.env.TMPDIR, detached: true, stdio: 'ignore'}); child.unref();
  fs.writeFileSync(${JSON.stringify(info)}, JSON.stringify({tmpdir: process.env.TMPDIR,
    pids: [pid(['-L', name]), pid(['-S', ${JSON.stringify(outside)}]), child.pid]}));
  ${body}
});`);
  return {file, info};
}
const leakedPids = info => JSON.parse(fs.readFileSync(info, 'utf8')).pids;

test('실행기 그물: 정리 없이 끝난 시험의 tmux 서버(폴더 안·밖 소켓)와 분리된 자식을 끝에 끈다', {skip: skipLeak}, async t => {
  const {file, info} = leakFixture(t);
  const result = spawnSync(process.execPath, [runner, file], {encoding: 'utf8', env: nestedEnv()});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const pids = leakedPids(info);
  assert.equal(pids.length, 3); assert.ok(pids.every(pid => pid > 1), JSON.stringify(pids));
  for (const pid of pids) assert.equal(await waitFor(() => !alive(pid)), true, `PID ${pid}가 남았다`);
  assert.match(result.stderr, /실행기 정리: tmux 소켓 \d+개 종료, 남은 소속 프로세스 \d+개 종료/);
});

for (const [signal, code] of [['SIGTERM', 143], ['SIGHUP', 129]]) {
  test(`실행기 그물: ${signal}로 중단해도 새는 서버와 자식을 끈다`, {skip: skipLeak}, async t => {
    const {file, info} = leakFixture(t, 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);');
    const child = await run(file, nestedEnv());
    t.after(() => stopChild(child));
    const done = exited(child);
    assert.equal(await waitFor(() => fs.existsSync(info), 20_000), true, '가짜 시험이 시작했다');
    child.kill(signal);
    assert.equal((await done).code, code);
    const {tmpdir} = JSON.parse(fs.readFileSync(info, 'utf8'));
    assert.equal(fs.existsSync(tmpdir), false, '실행별 폴더가 지워졌다');
    for (const pid of leakedPids(info)) assert.equal(await waitFor(() => !alive(pid)), true, `PID ${pid}가 남았다`);
  });
}

test('실행기 그물: 다른 실행 폴더의 서버·자식은 살려 두고, 자기 폴더 것만 끈다', {skip: skipLeak}, async t => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-a-')), b = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-b-'));
  const socket = path.join(b, 'tmux-test', 'srv');
  fs.mkdirSync(path.dirname(socket));
  const tmuxB = (...args) => spawnSync('tmux', ['-u', '-S', socket, ...args],
    {encoding: 'utf8', env: {...nestedEnv(), TMPDIR: b}});
  const sleeper = spawn('sleep', ['300'], {cwd: b, detached: true, stdio: 'ignore', env: {...process.env, TMPDIR: b}});
  sleeper.unref();
  t.after(() => {
    if (alive(sleeper.pid)) process.kill(sleeper.pid, 'SIGKILL');
    console.error(`격리 소켓 kill-server: ${socket}`); tmuxB('kill-server');
    for (const dir of [a, b]) fs.rmSync(dir, {recursive: true, force: true});
  });
  assert.equal(tmuxB('new-session', '-d', 'sleep 300').status, 0);
  const server = Number(tmuxB('display', '-p', '#{pid}').stdout);
  assert.ok(server > 1 && sleeper.pid > 1);
  const swept = sweepRun(a);
  assert.deepEqual([swept.sockets, swept.signaled], [[], []], '다른 폴더 것은 대상이 아니다');
  assert.equal(alive(server) && alive(sleeper.pid), true, '두 번째 실행 폴더의 서버·자식이 살아 있다');
  const own = sweepRun(b);
  assert.deepEqual(own.sockets, [socket]);
  assert.equal(await waitFor(() => !alive(server) && !alive(sleeper.pid)), true, '자기 폴더 것은 끈다');
});

test('실행기 그물: 소속을 확인 못 한 도우미·운영 소켓(-L kadan)·번호가 재사용된 프로세스는 끄지 않는다', t => {
  // cwd는 realpath로 판정하므로 실제 폴더를 만든다. 접두 경계 시험을 위해 이름이 겹치는 형제 폴더도 둔다.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-own-')));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const runTmp = path.join(base, 'kadan-run-AbCdEf'), sibling = `${runTmp}X`, other = path.join(base, 'other');
  const child = path.join(runTmp, 'kadan-handover-background-x');
  for (const dir of [child, sibling, other]) fs.mkdirSync(dir, {recursive: true});
  const at = 'Wed Nov  4 02:22:02 2026';
  const rows = [
    {pid: 900001, identity: `${at} kadan-watch:kadan-qa-1`}, // 이름이 바뀐 도우미: cwd를 모름
    {pid: 900002, identity: `${at} kadan-watch:kadan-qa-2`}, // cwd가 다른 폴더
    {pid: 900003, identity: `${at} tmux -u -L kadan -f /x/tmux.conf new-session TMPDIR=${runTmp}`}, // 운영 소켓
    {pid: 900004, identity: `${at} sleep 300 TMPDIR=${sibling}`}, // 이름이 겹치는 다른 폴더
    {pid: 900005, identity: `${at} kadan-watch:kadan-qa-3`}, // cwd가 이 폴더: 대상
    {pid: 900006, identity: `${at} sleep 300 TMPDIR=${runTmp}`}, // 환경에 이 폴더: 대상
    {pid: 900007, identity: `${at} node ${runTmp}/x.mjs`}, // 조회 사이에 번호가 재사용됨
  ];
  const cwds = new Map([[900002, other], [900003, runTmp], [900005, child]]);
  const sent = [];
  const swept = sweepRun(runTmp, {
    list: () => rows, cwds: () => cwds, sleep: () => {}, graceMs: 0,
    check: pid => rows.filter(r => r.pid === pid).map(r => (r.pid === 900007 ? {...r, identity: `${at} 다른 명령`} : r)),
    signal: (pid, sig) => sent.push([pid, sig]), killServer: () => { throw new Error('소켓 없음'); },
  });
  assert.deepEqual(swept.signaled, [900005, 900006]);
  assert.deepEqual(sent.map(([pid]) => pid).filter((pid, i, all) => all.indexOf(pid) === i), [900005, 900006]);
  assert.equal(ownership(rows[2], runTmp, {cwd: runTmp}), null, '운영 소켓 줄은 어떤 근거로도 대상이 아니다');
  const noCwd = sweepRun(runTmp, {list: () => rows, cwds: () => { throw new Error('lsof 실패'); },
    check: pid => rows.filter(r => r.pid === pid), signal: () => {}, killServer: () => {},
    sleep: () => {}, graceMs: 0});
  assert.deepEqual(noCwd.signaled, [900006, 900007], 'cwd 조회가 실패하면 명령줄 근거만 쓴다(900005는 끄지 않는다)');
  assert.deepEqual(sweepRun('kadan-run-AbCdEf').skipped, ['실행 폴더가 절대경로가 아님']);
});

// 2026-11-04 검수 P1: 끝 구분자(: = 공백 따옴표)를 받는 검색식이 kadan-run-AB:other 같은 다른 폴더를 소속으로 잡았다.
// 이제 cwd는 realpath + '/' 경계, 명령줄·환경은 낱말(KEY=VALUE는 ':' 항목) 단위의 정확한 경로 비교다.
test('실행기 그물(경로 경계): 이름이 겹치는 다른 폴더·구분자 뒤 문자열은 소속이 아니고, 자기 폴더와 별칭·PATH 항목은 소속이다', t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-edge-')));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const a = path.join(base, 'kadan-run-AB');
  fs.mkdirSync(path.join(a, 'child'), {recursive: true});
  for (const dir of [`${a}:other`, `${a}=other`, `${a} other`, `${a}C`, path.join(base, 'x', 'kadan-run-AB', 'y')]) {
    fs.mkdirSync(dir, {recursive: true});
  }
  // cwd: 비슷한 이름의 다른 폴더는 소속이 아니다.
  for (const dir of [`${a}:other`, `${a}=other`, `${a} other`, `${a}C`, path.join(base, 'x', 'kadan-run-AB', 'y')]) {
    assert.equal(cwdOwned(dir, a), false, dir);
  }
  assert.equal(cwdOwned(path.join(base, 'nope'), a), false, 'realpath 실패는 소속이 아니다');
  assert.equal(cwdOwned('상대/경로', a), false);
  assert.equal(cwdOwned(a, a), true);
  assert.equal(cwdOwned(path.join(a, 'child'), a), true);
  // 명령줄·환경: 낱말 단위. 구분자 뒤의 문자열이나 다른 경로 안의 문자열은 소속이 아니다.
  for (const text of [`sleep 1 ${a}C`, `sleep 1 ${a}:other`, `sleep 1 X=${a}=other`, `sleep 1 /o/${a}`,
    `sleep 1 --dir=${a}`, `sleep 1 TMPDIR=/o${a}`, `sleep 1 ${a}x/y`]) {
    assert.equal(commandOwned(text, a), false, text);
  }
  for (const text of [`sleep 1 ${a}`, `node ${a}/x.mjs`, `sleep 1 TMPDIR=${a}`, `sleep 1 TMPDIR='${a}/t'`,
    `sleep 1 PATH=/usr/bin:${a}/osascript-net:/bin`]) {
    assert.equal(commandOwned(text, a), true, text);
  }
  // /tmp ↔ /private/tmp 별칭은 같은 폴더다.
  const alias = '/private/tmp/kadan-run-Alias';
  assert.equal(commandOwned('sleep 1 TMPDIR=/tmp/kadan-run-Alias/t', alias), true);
  assert.equal(commandOwned('sleep 1 TMPDIR=/private/tmp/kadan-run-Alias', alias), true);
  assert.equal(commandOwned('sleep 1 TMPDIR=/tmp/kadan-run-AliasZ', alias), false);
});

test('실행기 그물(경로 경계): 실제 sweepRun이 이름이 겹치는 폴더의 자식은 살려 두고 자기 폴더의 자식만 끈다', async t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-real-')));
  const a = path.join(base, 'kadan-run-AB'), lookalike = `${a}:other`;
  fs.mkdirSync(a); fs.mkdirSync(lookalike);
  const start = cwd => { const c = spawn('sleep', ['300'], {cwd, detached: true, stdio: 'ignore'}); c.unref(); return c; };
  const own = start(a), foreign = start(lookalike);
  t.after(() => {
    for (const c of [own, foreign]) if (alive(c.pid)) process.kill(c.pid, 'SIGKILL');
    fs.rmSync(base, {recursive: true, force: true});
  });
  assert.ok(own.pid > 1 && foreign.pid > 1);
  // 호출 전에 두 자식이 lsof에 보일 때까지 기다린다.
  await new Promise(resolve => setTimeout(resolve, 300));
  const swept = sweepRun(a, {killServer: () => {}});
  assert.ok(swept.signaled.includes(own.pid), '자기 폴더 자식에게 신호가 갔다');
  assert.equal(swept.signaled.includes(foreign.pid), false, '이름이 겹치는 다른 폴더 자식에게는 신호가 가지 않았다');
  assert.equal(await waitFor(() => !alive(own.pid)), true, '자기 자식은 끝났다');
  assert.equal(alive(foreign.pid), true, '다른 폴더 자식은 살아 있다');
});

test('실행기 그물(정적): kill-server는 -S 절대경로나 실행기 자기 소켓에만 쓰고 운영 이름 kadan을 넣지 않는다', () => {
  for (const file of [runner, new URL('./helpers/run-sweep.mjs', import.meta.url).pathname]) {
    const source = fs.readFileSync(file, 'utf8');
    const lines = source.split('\n').filter(line => line.includes("'kill-server'"));
    assert.ok(lines.length >= 1, file);
    for (const line of lines) assert.match(line, /'-S', socket|'-L', env\.KADAN_SOCKET/, `${file}: ${line.trim()}`);
    assert.doesNotMatch(source, /['"]-L['"],\s*['"]kadan['"]/, file);
  }
});
