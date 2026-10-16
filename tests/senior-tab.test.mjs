import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {seniorCommand} from '../src/senior.mjs';
import {RottieFloorError, rottieFloor} from '../src/floor-rottie.mjs';
import {closeSeniorTab} from '../src/senior-tab.mjs';
import {initSettings, setRole} from '../src/runner-settings.mjs';
import {CardStore} from '../src/card-store.mjs';
import {readLedger} from '../src/ledger.mjs';

// 시니어 따라 보기 탭(2026-10-16 [kyle]): 호출 동안만 읽기 전용 로티 탭을 띄운다. 탭은 꾸밈이라 실패해도 자문은 그대로다.
// 이 파일은 실제 로티를 열지 않는다 — 가짜 로티 함수 또는 가짜 로티 실행 파일만 쓴다.
const followScript = new URL('../scripts/senior-follow.sh', import.meta.url).pathname;
const codexModels = [{slug: 'gpt-6-sol', supported_reasoning_levels: ['low', 'high'].map(effort => ({effort}))}];
const readCodexModels = () => ({models: codexModels});
const FAKE_BIN = '/fake/rottie';
const envOn = (extra = {}) => ({PATH: process.env.PATH, KADAN_WINDOW: 'rottie', KADAN_ROTTIE_BIN: FAKE_BIN,
  KADAN_ALLOW_FAKE_ROTTIE: '1', KADAN_SENIOR_TAB: 'on', ...extra});

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-senior-tab-'));
  const repo = path.join(home, 'repo'); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(home, 'agent-runners.json'), JSON.stringify({runners: [{id: 'codex', spawn: 'codex --model {model} -c model_reasoning_effort="{effort}"'}]}));
  initSettings(home, {by: 'kyle', reason: '시작', record: () => {}});
  setRole(home, {role: 'senior', runner: 'codex', model: 'gpt-6-sol', effort: 'high', revision: 1, by: 'kyle', reason: '시험', record: () => {}, readCodexModels});
  new CardStore(home).create({repo: 'qa', id: 'card-a', repoPath: repo, body: '# 시험 카드\n'});
  const calls = [];
  // 가짜 로티: 호출을 기록하고 create에는 실행 중 터미널을 돌려준다. show는 lingering이 true일 때만 남아 있다고 답한다.
  const rottieFn = ({lingering = false, createError = null, closeError = null} = {}) => argv => {
    calls.push(argv);
    const verb = argv[1];
    if (verb === 'create') {
      if (createError) throw createError;
      return {ok: true, result: {terminal: {id: 'term-1', state: 'running', pid: 4242, workspaceId: 'ws-1'}}, runtime: {build: 'b1'}};
    }
    if (verb === 'close' && closeError) throw closeError;
    if (verb === 'show' && !lingering) throw new RottieFloorError('없다', {code: 'ROTTIE_TERMINAL_NOT_FOUND', effect: 'none'});
    return {ok: true, result: {}};
  };
  const spawnFn = ({status = 0, error = null, stderr = ''} = {}) => async (command, settings) => {
    if (status === 0 && !error) fs.writeFileSync(path.join(settings.env.KADAN_SENIOR_DIR, 'result.txt'), '결론: 좋다');
    if (error) throw error;
    return {status, stderr, stdout: ''};
  };
  const run = (extra = {}, {env = envOn(), ...more} = {}) => seniorCommand(['qa/card-a'], {question: '합칠까?'}, {home, by: 'qa-감독', env, followScript, ...more, ...extra});
  const advices = () => readLedger(home).filter(e => e.kind === 'advice');
  return {home, repo, calls, rottieFn, spawnFn, run, advices};
}
const verbs = calls => calls.map(argv => argv[1]);

test('창이 none이거나 스위치가 off이면 로티를 한 번도 부르지 않고 tab: skipped로 남는다', async () => {
  const f = fixture();
  await f.run({spawn: f.spawnFn(), rottie: f.rottieFn()}, {env: envOn({KADAN_WINDOW: 'none'})});
  await f.run({spawn: f.spawnFn(), rottie: f.rottieFn()}, {env: envOn({KADAN_SENIOR_TAB: 'off'})});
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.advices().map(e => [e.tab, e.tabReason, e.reason]), [['skipped', 'window-none', 'ok'], ['skipped', 'tab-off', 'ok']]);
  assert.ok(f.advices().every(e => e.rottieTerminalId === undefined));
});

test('스위치가 없으면 기본은 켬이다(2026-10-16 포커스 실측: 로티가 맨 앞으로 오지 않음)', async () => {
  const f = fixture();
  const r = await f.run({spawn: f.spawnFn(), rottie: f.rottieFn()}, {env: envOn({KADAN_SENIOR_TAB: undefined})});
  assert.equal(r.tab, 'closed'); assert.equal(verbs(f.calls)[0], 'create');
});

test('가짜 로티: create 인자는 역할용이 아니다(KADAN_ROLE·kadan-* 없음) — 제목·workspace·키·따라 보기 명령', async () => {
  const f = fixture();
  const r = await f.run({spawn: f.spawnFn(), rottie: f.rottieFn()});
  assert.equal(r.reason, 'ok'); assert.equal(r.tab, 'closed');
  const [create] = f.calls;
  assert.deepEqual(create.slice(0, 2), ['terminal', 'create']);
  const flag = name => create[create.indexOf(name) + 1];
  assert.equal(flag('--workspace'), f.repo); assert.equal(flag('--title'), '시니어 · qa/card-a');
  assert.match(flag('--idempotency-key'), new RegExp(`^kadan-senior-${r.adviceId}$`));
  const command = flag('--command');
  assert.match(command, new RegExp(`^/bin/bash .*senior-follow\\.sh .*${r.adviceId} ${process.pid}$`));
  assert.ok(!create.join(' ').includes('KADAN_ROLE') && !command.includes('env '), '역할용 env 접두가 없어야 한다');
  assert.ok(!flag('--title').startsWith('kadan-'), 'kadan-* 세션 이름을 쓰지 않는다');
  assert.match(r.follow, /^tail -F .*diagnostic\.log$/);
  assert.ok(fs.existsSync(path.join(r.evidencePath, 'diagnostic.log')));
});

test('성공: 열고 닫은 뒤 advice 사건에 tab·rottieTerminalId가 남고, start·stop 사건과 바닥 목록에는 잡히지 않는다', async () => {
  const f = fixture();
  await f.run({spawn: f.spawnFn(), rottie: f.rottieFn()});
  assert.deepEqual(verbs(f.calls), ['create', 'close', 'show']);
  const [entry] = f.advices();
  assert.equal(entry.tab, 'closed'); assert.equal(entry.rottieTerminalId, 'term-1'); assert.equal(entry.reason, 'ok');
  assert.deepEqual(readLedger(f.home).filter(e => ['start', 'stop'].includes(e.kind)), []);
  // 바닥 list()는 start 사건이 있는 세션만 본다 — 시니어 탭은 start가 없으므로 로티에 묻지도 않는다.
  const before = {home: process.env.KADAN_HOME, bin: process.env.KADAN_ROTTIE_BIN};
  process.env.KADAN_HOME = f.home; process.env.KADAN_ROTTIE_BIN = '/nonexistent/rottie';
  try { assert.deepEqual(rottieFloor.list(), []); }
  finally { process.env.KADAN_HOME = before.home; if (before.bin === undefined) delete process.env.KADAN_ROTTIE_BIN; else process.env.KADAN_ROTTIE_BIN = before.bin; }
});

test('닫은 뒤에도 목록에 남아 있으면 자기 탭만 remove한다', async () => {
  const f = fixture();
  const r = await f.run({spawn: f.spawnFn(), rottie: f.rottieFn({lingering: true})});
  assert.deepEqual(verbs(f.calls), ['create', 'close', 'show', 'remove']);
  assert.ok(f.calls.slice(1).every(argv => argv[argv.indexOf('--terminal') + 1] === 'term-1'));
  assert.equal(r.tab, 'closed'); assert.equal(f.advices()[0].tabReason, 'removed-after-close');
});

test('닫기가 실패해도 자문은 ok이고 tab: close-failed가 남는다', async () => {
  const f = fixture();
  const r = await f.run({spawn: f.spawnFn(), rottie: f.rottieFn({closeError: new RottieFloorError('닫기 실패', {code: 'ROTTIE_INTERNAL'})})});
  assert.equal(r.reason, 'ok'); assert.equal(f.advices()[0].tab, 'close-failed'); assert.match(f.advices()[0].tabReason, /ROTTIE_INTERNAL/);
});

test('호출이 실패·시간 초과해도 탭을 닫고, 자문 실패 처리(던짐·원장)는 탭 유무와 같다', async () => {
  const f = fixture();
  await assert.rejects(() => f.run({spawn: f.spawnFn({status: 1}), rottie: f.rottieFn()}), /자문 실패\(call-failed\)/);
  const timeout = Object.assign(new Error('시간 초과'), {code: 'ETIMEDOUT'});
  await assert.rejects(() => f.run({spawn: f.spawnFn({error: timeout}), rottie: f.rottieFn()}), /자문 실패\(timeout\)/);
  assert.deepEqual(verbs(f.calls), ['create', 'close', 'show', 'create', 'close', 'show']);
  assert.deepEqual(f.advices().map(e => [e.reason, e.tab]), [['call-failed', 'closed'], ['timeout', 'closed']]);
});

test('create가 typed 오류(앱 꺼짐·workspace 없음)를 내도 자문은 ok이고 tab: skipped, workspace를 추가하지 않는다', async () => {
  for (const code of ['ROTTIE_APP_NOT_RUNNING', 'ROTTIE_WORKSPACE_NOT_OPEN']) {
    const f = fixture();
    const r = await f.run({spawn: f.spawnFn(), rottie: f.rottieFn({createError: new RottieFloorError('안 됨', {code, effect: 'none'})})});
    assert.equal(r.reason, 'ok'); assert.equal(r.tab, 'skipped'); assert.equal(f.advices()[0].tabReason, code);
    assert.deepEqual(verbs(f.calls), ['create']);
    assert.ok(!f.calls.some(argv => argv[0] === 'workspace'));
    assert.equal(f.advices()[0].rottieTerminalId, undefined);
  }
});

test('기본이 아닌 홈 + rottie는 허용 플래그 없이 거절되어 로티를 부르지 않고, 허용 플래그가 있으면 열린다', async () => {
  const f = fixture();
  const denied = envOn({KADAN_ALLOW_FAKE_ROTTIE: undefined});
  const r = await f.run({spawn: f.spawnFn(), rottie: f.rottieFn()}, {env: denied});
  assert.equal(r.reason, 'ok'); assert.equal(r.tab, 'skipped'); assert.equal(f.advices()[0].tabReason, 'KADAN_LIVE_FLOOR_DENIED');
  assert.deepEqual(f.calls, []);
  await f.run({spawn: f.spawnFn(), rottie: f.rottieFn()}, {env: {...denied, KADAN_ALLOW_LIVE_FLOOR: '1'}});
  assert.equal(verbs(f.calls)[0], 'create');
});

// 가짜 로티 실행 파일: 인자를 한 줄씩 기록하고 JSON 봉투로 답한다. show는 표시 파일이 있을 때만 남아 있다고 답한다.
function fakeRottieBin(dir) {
  const bin = path.join(dir, 'rottie');
  fs.writeFileSync(bin, `#!/bin/bash
printf '%s\\n' "$*" >>"${dir}/calls.log"
case "$2" in
  create) echo '{"ok":true,"result":{"terminal":{"id":"term-bin","state":"running","pid":7,"workspaceId":"ws"}},"runtime":{"build":"b"}}';;
  show) echo '{"ok":false,"error":{"code":"ROTTIE_TERMINAL_NOT_FOUND","message":"없다","effect":"none"}}'; exit 1;;
  *) echo '{"ok":true,"result":{}}';;
esac
`, {mode: 0o755});
  return bin;
}

test('가짜 로티 실행 파일(기본 호출 경로): create·close가 실제 인자로 나가고 SIGTERM에서도 close가 불린다', async () => {
  const f = fixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-senior-fakebin-'));
  const bin = fakeRottieBin(dir);
  const env = envOn({KADAN_ROTTIE_BIN: bin});
  await f.run({spawn: f.spawnFn()}, {env});
  const lines = fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n');
  assert.match(lines[0], /^terminal create --workspace .*repo --title 시니어 · qa\/card-a --command \/bin\/bash .* --idempotency-key kadan-senior-/);
  assert.deepEqual(lines.slice(1).map(l => l.split(' ').slice(0, 2).join(' ')), ['terminal close', 'terminal show']);

  // SIGTERM: 호출이 끝나지 않는 동안 신호를 받으면 탭을 닫고 143으로 나간다.
  fs.rmSync(path.join(dir, 'calls.log'));
  const harness = path.join(dir, 'harness.mjs');
  fs.writeFileSync(harness, `import fs from 'node:fs';
import {seniorCommand} from ${JSON.stringify(new URL('../src/senior.mjs', import.meta.url).href)};
await seniorCommand(['qa/card-a'], {question: '합칠까?'}, {home: ${JSON.stringify(f.home)}, by: 'qa-감독', env: ${JSON.stringify(env)},
  followScript: ${JSON.stringify(followScript)}, spawn: () => { fs.writeFileSync(${JSON.stringify(path.join(dir, 'spawned'))}, '1'); return new Promise(() => setInterval(() => {}, 1000)); }});
`);
  const child = spawn(process.execPath, [harness], {stdio: 'ignore'});
  const exited = new Promise(resolve => child.on('close', (code, signal) => resolve({code, signal})));
  const deadline = Date.now() + 10_000;
  // spawn이 불렸다는 것은 탭이 열리고 신호 처리기가 설치된 뒤라는 뜻이다.
  while (!fs.existsSync(path.join(dir, 'spawned')) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  assert.ok(fs.existsSync(path.join(dir, 'spawned')), '탭이 열리지 않았다');
  child.kill('SIGTERM');
  const result = await exited;
  assert.equal(result.code, 143);
  const after = fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n').map(l => l.split(' ').slice(0, 2).join(' '));
  assert.deepEqual(after, ['terminal create', 'terminal close', 'terminal show']);
});

function followSetup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-senior-follow-'));
  const env = {...process.env, KADAN_SENIOR_FOLLOW_INTERVAL: '0.1'};
  return {dir, env};
}
const waitClose = (child, ms = 15_000) => new Promise((resolve, reject) => {
  let out = '';
  child.stdout.on('data', d => { out += d; });
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`따라 보기가 끝나지 않았다: ${out}`)); }, ms);
  child.on('close', code => { clearTimeout(timer); resolve({code, out}); });
});

test('따라 보기: diagnostic.log가 늦게 생겨도 보여 주고, exit-code.txt가 생기면 종료 코드와 답변 경로를 보이며 끝난다', async () => {
  const {dir, env} = followSetup();
  const parent = spawn('sleep', ['60']);
  const child = spawn('/bin/bash', [followScript, dir, String(parent.pid)], {env});
  const done = waitClose(child);
  await new Promise(r => setTimeout(r, 300));
  fs.writeFileSync(path.join(dir, 'diagnostic.log'), '첫 줄\n둘째 줄\n');
  await new Promise(r => setTimeout(r, 2000));
  fs.writeFileSync(path.join(dir, 'exit-code.txt'), '0\n');
  const {code, out} = await done;
  parent.kill();
  assert.equal(code, 0); assert.match(out, /첫 줄\n둘째 줄/); assert.match(out, /시니어 호출 끝: 종료 코드 0, 답변: .*result\.txt/);
});

test('따라 보기: exit-code.txt가 없어도 부모 프로세스가 사라지면 끝난다(TERM으로 죽은 kadan senior)', async () => {
  const {dir, env} = followSetup();
  fs.writeFileSync(path.join(dir, 'diagnostic.log'), '진행\n');
  const parent = spawn('sleep', ['60']);
  const child = spawn('/bin/bash', [followScript, dir, String(parent.pid)], {env});
  const done = waitClose(child);
  await new Promise(r => setTimeout(r, 400));
  parent.kill('SIGKILL');
  const {code, out} = await done;
  assert.equal(code, 0); assert.match(out, /진행/); assert.match(out, /kadan senior가 사라졌다/);
});

test('따라 보기: 인자 오류는 거절하고 입력을 받지 않는다', () => {
  assert.equal(spawnSync('/bin/bash', [followScript], {encoding: 'utf8'}).status !== 0, true);
  assert.equal(spawnSync('/bin/bash', [followScript, os.tmpdir(), 'abc'], {encoding: 'utf8'}).status, 2);
  assert.equal(spawnSync('/bin/bash', [followScript, '/없는/폴더', '1'], {encoding: 'utf8'}).status, 2);
});

test('F2: close 뒤 show가 NOT_FOUND면 사라짐(remove 없음), 그 밖의 오류면 자기 id를 remove하고 실패하면 close-failed', async () => {
  const run = showError => {
    const calls = [];
    const out = closeSeniorTab({rottieTerminalId: 'own', call: argv => {
      calls.push(argv[1]);
      if (argv[1] === 'show') throw showError;
      if (argv[1] === 'remove' && showError.removeFails) throw new RottieFloorError('x', {code: 'ROTTIE_INTERNAL'});
      return {ok: true};
    }});
    return {out, calls};
  };
  assert.deepEqual(run(new RottieFloorError('없다', {code: 'ROTTIE_TERMINAL_NOT_FOUND', effect: 'none'})), {out: {tab: 'closed'}, calls: ['close', 'show']});
  const other = run(new RottieFloorError('내부', {code: 'ROTTIE_INTERNAL'}));
  assert.deepEqual(other.calls, ['close', 'show', 'remove']);
  assert.equal(other.out.tab, 'closed'); assert.match(other.out.tabReason, /^removed-after-show-error: ROTTIE_INTERNAL/);
  const bad = run(Object.assign(new RottieFloorError('내부', {code: 'ROTTIE_INTERNAL'}), {removeFails: true}));
  assert.deepEqual(bad.calls, ['close', 'show', 'remove']); assert.equal(bad.out.tab, 'close-failed'); assert.match(bad.out.tabReason, /remove/);
});

test('F1: create 응답이 유실되면(effect unknown·형식 오류) tab: unknown과 키만 남기고 목록을 뒤지지 않는다', async () => {
  const f = fixture();
  for (const make of [() => argv => { f.calls.push(argv); throw new RottieFloorError('모름', {code: 'ROTTIE_JSON_PARSE', effect: 'unknown'}); },
    () => argv => { f.calls.push(argv); return {ok: true, result: {terminal: {id: 'x', state: 'exited'}}}; }]) {
    const r = await f.run({spawn: f.spawnFn(), rottie: make()});
    assert.equal(r.reason, 'ok'); assert.equal(r.tab, 'unknown');
  }
  const entries = f.advices();
  assert.ok(entries.every(e => e.tab === 'unknown' && /^kadan-senior-/.test(e.tabKey) && e.tabKey.endsWith(e.adviceId) && e.rottieTerminalId === undefined));
  assert.deepEqual(verbs(f.calls), ['create', 'create']);
});

for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
  test(`F1: create 응답을 기다리는 중 ${signal}를 받아도 응답 뒤 자기 탭을 close·show·remove하고 ${code}로 끝난다`, async () => {
    const f = fixture();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-senior-sig-'));
    const bin = path.join(dir, 'rottie'), log = path.join(dir, 'calls.log'), ready = path.join(dir, 'creating');
    // 가짜 로티: create는 표시를 남기고 0.8초 뒤에 답한다. show는 남아 있다고 답해 remove까지 가게 한다.
    fs.writeFileSync(bin, `#!/bin/bash
echo "$2" >>"${log}"
case "$2" in
  create) touch "${ready}"; sleep 0.8; echo '{"ok":true,"result":{"terminal":{"id":"term-sig","state":"running","pid":7,"workspaceId":"ws"}},"runtime":{"build":"b"}}';;
  *) echo '{"ok":true,"result":{}}';;
esac
`, {mode: 0o755});
    const harness = path.join(dir, 'harness.mjs');
    fs.writeFileSync(harness, `import {seniorCommand} from ${JSON.stringify(new URL('../src/senior.mjs', import.meta.url).href)};
await seniorCommand(['qa/card-a'], {question: '합칠까?'}, {home: ${JSON.stringify(f.home)}, by: 'qa-감독', env: ${JSON.stringify(envOn({KADAN_ROTTIE_BIN: bin}))},
  followScript: ${JSON.stringify(followScript)}, spawn: () => new Promise(() => setInterval(() => {}, 1000))});
`);
    const child = spawn(process.execPath, [harness], {stdio: 'ignore'});
    const exited = new Promise(resolve => child.on('close', (c, s) => resolve({code: c, signal: s})));
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    assert.ok(fs.existsSync(ready), 'create가 시작되지 않았다');
    child.kill(signal);
    assert.equal((await exited).code, code);
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['create', 'close', 'show', 'remove']);
  });
}

// 라운드 2: 생성 응답이 유실돼도 키를 잃지 않는다 — 호출 폴더 tab.json과 interrupted 사건이 복구 근거다.
const tabJson = home => {
  const [id] = fs.readdirSync(path.join(home, 'advice'));
  return {id, dir: path.join(home, 'advice', id), state: JSON.parse(fs.readFileSync(path.join(home, 'advice', id, 'tab.json'), 'utf8'))};
};

test('R2: 터미널 Ctrl-C처럼 프로세스 그룹 전체가 SIGINT를 받아 로티 CLI도 죽어도 tab.json 키·unknown·interrupted 사건이 남고 remove는 0회', async () => {
  const f = fixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-senior-grp-'));
  const bin = path.join(dir, 'rottie'), log = path.join(dir, 'calls.log'), ready = path.join(dir, 'creating');
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, argv[1] + '\\n');
if (argv[1] === 'create') { process.on('SIGINT', () => process.exit(130)); fs.writeFileSync(${JSON.stringify(ready)}, '1'); setTimeout(() => {}, 3000); }
else console.log('{"ok":true,"result":{}}');
`, {mode: 0o755});
  const harness = path.join(dir, 'harness.mjs');
  fs.writeFileSync(harness, `import {seniorCommand} from ${JSON.stringify(new URL('../src/senior.mjs', import.meta.url).href)};
await seniorCommand(['qa/card-a'], {question: '합칠까?'}, {home: ${JSON.stringify(f.home)}, by: 'qa-감독', env: ${JSON.stringify(envOn({KADAN_ROTTIE_BIN: bin}))},
  followScript: ${JSON.stringify(followScript)}, spawn: () => new Promise(() => setInterval(() => {}, 1000))});
`);
  const child = spawn(process.execPath, [harness], {detached: true, stdio: 'ignore'});
  const exited = new Promise(resolve => child.on('close', (c, s) => resolve({code: c, signal: s})));
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  assert.ok(fs.existsSync(ready), 'create가 시작되지 않았다');
  process.kill(-child.pid, 'SIGINT');
  assert.equal((await exited).code, 130);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['create']);
  const {id, state} = tabJson(f.home);
  assert.equal(state.key, `kadan-senior-${id}`); assert.equal(state.state, 'unknown');
  const [entry] = f.advices();
  assert.equal(entry.reason, 'interrupted'); assert.equal(entry.tab, 'unknown'); assert.equal(entry.tabKey, state.key);
  assert.equal(entry.evidencePath, path.join(f.home, 'advice', id)); assert.equal(entry.rottieTerminalId, undefined);
});

test('R2: 로티 CLI가 JSON 없이 비정상 종료(130·신호)해도 skipped가 아니라 unknown이고 키가 남으며 remove·목록 조회가 없다', async () => {
  for (const body of ['process.exit(130);', 'process.kill(process.pid, "SIGKILL");', 'console.log("not json"); process.exit(0);']) {
    const f = fixture();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-senior-nojson-'));
    const bin = path.join(dir, 'rottie'), log = path.join(dir, 'calls.log');
    fs.writeFileSync(bin, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, process.argv[3] + '\\n');\n${body}\n`, {mode: 0o755});
    const r = await f.run({spawn: f.spawnFn()}, {env: envOn({KADAN_ROTTIE_BIN: bin})});
    assert.equal(r.reason, 'ok'); assert.equal(r.tab, 'unknown');
    const {id, state} = tabJson(f.home);
    assert.equal(state.state, 'unknown'); assert.equal(f.advices()[0].tabKey, `kadan-senior-${id}`);
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['create']);
  }
});

test('R2: tab.json은 create 전에 creating으로 쓰이고 열림·닫힘으로 갱신된다, skipped(생성 없음 확실)는 키 없이 tab: skipped', async () => {
  const f = fixture();
  let seenBeforeCreate = null;
  const r = await f.run({spawn: f.spawnFn(), rottie: argv => {
    if (argv[1] === 'create') { const t = tabJson(f.home); seenBeforeCreate = t.state; }
    return f.rottieFn()(argv);
  }});
  assert.equal(seenBeforeCreate.state, 'creating'); assert.equal(seenBeforeCreate.key, `kadan-senior-${r.adviceId}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.evidencePath, 'tab.json'), 'utf8')).state, 'closed');
  const g = fixture();
  const s = await g.run({spawn: g.spawnFn(), rottie: g.rottieFn({createError: new RottieFloorError('안 됨', {code: 'ROTTIE_APP_NOT_RUNNING', effect: 'none'})})});
  assert.equal(s.tab, 'skipped'); assert.equal(g.advices()[0].tabKey, undefined);
});
