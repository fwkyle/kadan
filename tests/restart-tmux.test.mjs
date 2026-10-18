import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ledgerHome, appendLedger, readLedger} from '../src/ledger.mjs';
import {tmuxFloor, tmux} from '../src/floor-tmux.mjs';
import {settingsWith} from './helpers/runner-table.mjs';
import {restartRoleDefault} from '../src/center-wall.mjs';

// 실제 tmux·ps·lsof·CLI로 "대화 파일의 주인" 경계를 확인한다. 실행기는 가짜 Node 스크립트이고(실제 AI·신뢰 설정 없음),
// 격리 홈·격리 tmux 서버만 쓴다. 가짜 codex 본체는 파일을 열고, 자식 Node가 다른 파일을 연다.
const A = '0197aaaa-1111-4222-8333-444455556666', B = '0197bbbb-1111-4222-8333-444455556666';
const cli = new URL('../src/cli.mjs', import.meta.url).pathname;

// 가짜 실행기·자식은 부모(창 안 프로세스)가 사라지면 스스로 끝난다. 창을 끄는 쪽이 자식까지 못 끄면 고아로 남았다(2026-10-16).
const WATCH_PARENT = "const pp=process.ppid;setInterval(()=>{try{process.kill(pp,0)}catch{process.exit(0)}},200);";

function setup(t, name) {
  const home = ledgerHome();
  const prior = {socket: process.env.KADAN_SOCKET, tmpdir: process.env.TMUX_TMPDIR};
  process.env.KADAN_SOCKET = `r${process.pid}${name}`;
  const sockDir = fs.mkdtempSync('/tmp/kr-'); // 소켓 경로가 길면 tmux가 거절한다
  process.env.TMUX_TMPDIR = sockDir;
  // 원래 값으로 되돌린다: 지우면 뒤 시험과 자식이 운영 기본 소켓(kadan)으로 돌아간다(2026-10-16 누수).
  t.after(() => {
    tmux(['kill-server']);
    fs.rmSync(sockDir, {recursive: true, force: true});
    for (const [key, value] of [['KADAN_SOCKET', prior.socket], ['TMUX_TMPDIR', prior.tmpdir]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const dir = path.join(home, name);
  fs.mkdirSync(path.join(dir, 'codex-home/sessions/2026/10/14'), {recursive: true});
  fs.mkdirSync(path.join(dir, 'codex-home/thread-writer-locks'), {recursive: true});
  const rollout = id => path.join(dir, `codex-home/sessions/2026/10/14/rollout-2026-10-14T16-35-00-${id}.jsonl`);
  const lock = id => path.join(dir, `codex-home/thread-writer-locks/${id}.lock`);
  for (const f of [rollout(A), rollout(B), lock(A), lock(B)]) fs.writeFileSync(f, '{}');
  const ready = path.join(dir, 'ready');
  // 자식 Node: 인자로 받은 파일을 열고 유지한다.
  fs.writeFileSync(path.join(dir, 'child.js'), `const fs=require('fs');const fds=process.argv.slice(2).map(f=>fs.openSync(f,'r'));
fs.writeFileSync(${JSON.stringify(ready)}+'.child','ok');${WATCH_PARENT}`);
  // 가짜 codex 본체: HOLD로 받은 파일을 열고, CHILD_FILES가 있으면 자식에게 열게 한다.
  const fake = path.join(dir, 'codex');
  fs.writeFileSync(fake, `#!${process.execPath}
const fs=require('fs');const cp=require('child_process');
const fds=(process.env.HOLD||'').split(',').filter(Boolean).map(f=>fs.openSync(f,'r'));
fs.writeFileSync(${JSON.stringify(path.join(dir, 'env.json'))},JSON.stringify({reason:process.env.KADAN_RESTART_REASON??null,expectPid:process.env.KADAN_RESTART_EXPECT_PID??null}));
const ri=process.argv.indexOf('resume');if(ri>0&&process.argv[ri+1]){const id=process.argv[ri+1];const base=__dirname;for(const f of [base+'/codex-home/thread-writer-locks/'+id+'.lock',base+'/codex-home/sessions/2026/10/14/rollout-2026-10-14T16-35-00-'+id+'.jsonl'])try{fs.openSync(f,'r')}catch{}}
const child=process.env.IS_SAME_CHILD==='1';
if(process.env.SPAWN_SAME)cp.spawn(process.execPath,[__filename,'--model','test-model','-c','e=low'],{env:{...process.env,HOLD:process.env.SAME_HOLD,SPAWN_SAME:'',IS_SAME_CHILD:'1'},stdio:'ignore'});
if(process.env.CHILD_FILES)cp.spawn(process.execPath,[${JSON.stringify(path.join(dir, 'child.js'))},...process.env.CHILD_FILES.split(',')],{stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(ready)}+(child?'.child':''),'ok');${WATCH_PARENT}`, {mode: 0o700});
  const settings = settingsWith({codex: {
    spawn: `${fake} --model {model} -c e={effort}`, resume: `${fake} --model {model} -c e={effort} resume {conversation}`,
    conversation: {kind: 'open-file', pattern: '/sessions/.+/rollout-[0-9T-]+-([0-9a-f-]{36})\\.jsonl$',
      evidence: ['/thread-writer-locks/([0-9a-f-]{36})\\.lock$']}}});
  fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify(settings));
  return {home, dir, fake, rollout, lock, ready};
}

function launch(env, {home, dir, fake, ready}, session, role) {
  const cmd = `${fake} --model test-model -c e=low`;
  const created = tmuxFloor.create({session, role, cwd: dir, cmd: `env ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')} ${cmd}`});
  appendLedger({kind: 'start', floor: 'tmux', role, session, cwd: dir, cmd, by: 'test', ...created});
  for (let i = 0; i < 100 && !(fs.existsSync(ready) && (!(env.CHILD_FILES || env.SPAWN_SAME) || fs.existsSync(ready + '.child'))); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  assert.ok(fs.existsSync(ready), '가짜 실행기가 파일을 열었다');
  return created;
}
const restart = role => spawnSync(process.execPath, [cli, 'restart', role], {encoding: 'utf8',
  env: {...process.env, KADAN_WINDOW: 'none', KADAN_FLOOR: 'tmux'}});
const skip = spawnSync('tmux', ['-V']).status !== 0;

test('실제 CLI: 본체는 A lock만, 자식이 B 저장 대화를 연 경우 거절하고 기존 pane을 끄지 않는다', {skip}, t => {
  const s = setup(t, 'child');
  const created = launch({HOLD: s.lock(A), CHILD_FILES: s.rollout(B)}, s, 'kadan-childcase', 'childcase');
  const result = restart('childcase');
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /대화 파일이 없다/);
  assert.equal(tmuxFloor.alive('kadan-childcase'), true);
  assert.equal(String(tmuxFloor.pid('kadan-childcase')), String(created.panePid));
  assert.equal(readLedger().filter(e => e.session === 'kadan-childcase' && e.kind === 'stop').length, 0);
});

test('실제 CLI: --reason·--expect-pid로 띄우면 stop·start에 이유·사람이 남고, 옛 세대 표시는 거절한다', {skip}, t => {
  const s = setup(t, 'gen');
  const created = launch({HOLD: `${s.lock(A)},${s.rollout(A)}`}, s, 'kadan-gencase', 'gencase');
  const env = {...process.env, KADAN_WINDOW: 'none', KADAN_FLOOR: 'tmux', KADAN_ROLE: ''};
  const run = args => spawnSync(process.execPath, [cli, 'restart', 'gencase', ...args], {encoding: 'utf8', env});
  const stale = run(['--reason', '옛 화면에서 누름', '--expect-pid', '999999']);
  assert.notEqual(stale.status, 0, '세대가 다르면 거절');
  assert.match(stale.stderr, /세대와 다르다/);
  assert.equal(String(tmuxFloor.pid('kadan-gencase')), String(created.panePid), '거절은 기존 pane을 끄지 않는다');
  assert.equal(readLedger().filter(e => e.session === 'kadan-gencase' && e.kind === 'stop').length, 0);
  const ok = run(['--reason', '화면에서 다시 띄움', '--expect-pid', String(created.panePid)]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, new RegExp(`다시 띄움: kadan-gencase .*대화 ${A}`));
  const entries = readLedger().filter(e => e.session === 'kadan-gencase');
  const stop = entries.find(e => e.kind === 'stop'), start = entries.findLast(e => e.kind === 'start');
  assert.equal(stop.restart, true); assert.equal(stop.reason, '화면에서 다시 띄움'); assert.equal(stop.by, '사람');
  assert.ok(start.restartOf); assert.equal(start.reason, '화면에서 다시 띄움'); assert.equal(start.by, '사람');
  assert.equal(start.restartConversation, A);
  const twice = run(['--reason', '같은 요청 다시', '--expect-pid', String(created.panePid)]);
  assert.notEqual(twice.status, 0, '같은 요청을 두 번내면 두 번째는 거절된다');
  assert.match(twice.stderr, /세대와 다르다/);
  assert.equal(readLedger().filter(e => e.session === 'kadan-gencase' && e.kind === 'stop').length, 1);
});

// 2라운드(2026-10-15, 검수 중요 1·2): 화면에서 온 값이 CLI 옵션으로 재해석되지 않고, 별칭 역할이 보호를 우회하지 않는다.
test('실제 CLI: 환경변수로 온 이유 --force·--·줄바꿈은 이유로만 읽히고, 별칭 역할은 거절한다', {skip}, t => {
  const s = setup(t, 'inj');
  const created = launch({HOLD: `${s.lock(A)},${s.rollout(A)}`}, s, 'kadan-injcase', 'injcase');
  appendLedger({kind: 'send', role: 'injcase', session: 'kadan-injcase', taskId: 'inj-1', bytes: 1, digest: 'i', by: 'test'});
  const env = extra => ({...process.env, KADAN_WINDOW: 'none', KADAN_FLOOR: 'tmux', KADAN_ROLE: '', ...extra});
  const stops = () => readLedger().filter(e => e.session === 'kadan-injcase' && e.kind === 'stop').length;
  // (0) 인자 형태 '--reason --force'는 2라운드 전까지 이유 없는 강제 실행으로 읽혔다 — 거절로 고친다
  const argvInject = spawnSync(process.execPath, [cli, 'restart', 'injcase', '--reason', '--force'], {encoding: 'utf8', env: env({})});
  assert.notEqual(argvInject.status, 0, '빈 --reason은 거절');
  assert.match(argvInject.stderr, /이유/);
  assert.equal(stops(), 0);
  // (1) 이유 '--force'는 강제가 아니라 이유다 — 끝나지 않은 카드 보호가 그대로 걸린다
  const forced = spawnSync(process.execPath, [cli, 'restart', 'injcase'], {encoding: 'utf8',
    env: env({KADAN_RESTART_REASON: '--force', KADAN_RESTART_EXPECT_PID: String(created.panePid)})});
  assert.notEqual(forced.status, 0);
  assert.match(forced.stderr, /끝나지 않은 카드/);
  assert.equal(stops(), 0, '강제 재시작 0회');
  // (2) 이유 '--'는 옵션 끝 표시가 아니다 — 세대 대조가 그대로 걸린다
  const dashes = spawnSync(process.execPath, [cli, 'restart', 'injcase'], {encoding: 'utf8',
    env: env({KADAN_RESTART_REASON: '--', KADAN_RESTART_EXPECT_PID: '999999'})});
  assert.notEqual(dashes.status, 0);
  assert.match(dashes.stderr, /세대와 다르다/);
  assert.equal(stops(), 0, '세대 대조 유지');
  // (3) 별칭 역할(앞뒤 하이픈)은 거절한다 — 같은 세션을 가리켜도 미해결 카드 보호를 우회할 수 없다
  for (const alias of ['-injcase', 'injcase-', '--injcase']) {
    const r = spawnSync(process.execPath, [cli, 'restart', alias], {encoding: 'utf8',
      env: env({KADAN_RESTART_REASON: '별칭', KADAN_RESTART_EXPECT_PID: String(created.panePid)})});
    assert.notEqual(r.status, 0, alias);
    assert.match(r.stderr + r.stdout, /정확한 이름|사용법/, alias);
  }
  assert.equal(stops(), 0, '별칭으로는 끄지 않는다');
  assert.equal(String(tmuxFloor.pid('kadan-injcase')), String(created.panePid));
  // (4) 숫자가 아닌 세대 표시·빈 이유는 CLI가 거절한다(화면 경로 방어)
  const badPid = spawnSync(process.execPath, [cli, 'restart', 'injcase'], {encoding: 'utf8',
    env: env({KADAN_RESTART_REASON: 'r', KADAN_RESTART_EXPECT_PID: 'abc'})});
  assert.notEqual(badPid.status, 0);
  assert.match(badPid.stderr, /숫자/);
  const emptyReason = spawnSync(process.execPath, [cli, 'restart', 'injcase'], {encoding: 'utf8',
    env: env({KADAN_RESTART_REASON: '   ', KADAN_RESTART_EXPECT_PID: String(created.panePid)})});
  assert.notEqual(emptyReason.status, 0);
  assert.match(emptyReason.stderr, /이유/);
});

test('실제 CLI: 환경변수로 온 이유는 원문 그대로 원장에 남는다(줄바꿈 포함)', {skip}, t => {
  const s = setup(t, 'verb');
  const created = launch({HOLD: `${s.lock(A)},${s.rollout(A)}`}, s, 'kadan-verbcase', 'verbcase');
  const reason = '--\n두 번째 줄 --expect-pid=1';
  const ok = spawnSync(process.execPath, [cli, 'restart', 'verbcase'], {encoding: 'utf8',
    env: {...process.env, KADAN_WINDOW: 'none', KADAN_FLOOR: 'tmux', KADAN_ROLE: '',
      KADAN_RESTART_REASON: reason, KADAN_RESTART_EXPECT_PID: String(created.panePid)}});
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const start = readLedger().filter(e => e.session === 'kadan-verbcase' && e.kind === 'start').at(-1);
  assert.equal(start.reason, reason, '이유 원문 그대로');
  assert.equal(start.forced, undefined, 'force가 켜지지 않는다');
});

// 3라운드(2026-10-15, 재검수 중요): 화면 전달용 환경변수는 한 번 쓰고 지워야 한다.
// 지우지 않으면 마지막 역할 재시작 때 새 tmux 서버·새 역할 환경에 남아 후속 명시 CLI를 덮어쓴다.
test('실제 CLI: 전달 환경변수는 소비 뒤 지워지고, 명시 옵션이 남은 환경값과 다르면 거절한다', {skip}, async t => {
  const s = setup(t, 'cut');
  const created = launch({HOLD: `${s.lock(A)},${s.rollout(A)}`}, s, 'kadan-cutcase', 'cutcase');
  const env = {...process.env, KADAN_WINDOW: 'none', KADAN_FLOOR: 'tmux', KADAN_ROLE: ''};
  const latestPid = () => readLedger().findLast(e => e.session === 'kadan-cutcase' && e.kind === 'start').panePid;
  // (1) 마지막 남은 역할을 화면 경로(restartRoleDefault)로 재시작한다 — 옛 서버가 종료되고 새 서버가 뜨는 조건
  const first = await restartRoleDefault({role: 'cutcase', reason: '첫 화면 이유', expectPid: String(created.panePid),
    cli, env, responseTimeout: 25_000});
  assert.ok(first.output.includes('다시 띄움'), JSON.stringify(first));
  // 새 tmux 서버의 전역 환경과 새 역할 프로세스 환경에 두 값이 남아 있으면 안 된다
  for (const key of ['KADAN_RESTART_REASON', 'KADAN_RESTART_EXPECT_PID'])
    assert.notEqual(tmux(['show-environment', '-g', key]).status, 0, key + '가 tmux 서버 전역에 남았다');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.dir, 'env.json'), 'utf8')), {reason: null, expectPid: null},
    '새 역할 프로세스 환경에 남지 않는다');
  // (2) 남은 환경값과 다른 명시 옵션이 만나면 조용히 고르지 않고 거절한다
  const conflict = spawnSync(process.execPath, [cli, 'restart', 'cutcase', '--reason', '터미널 이유', '--expect-pid', String(latestPid())],
    {encoding: 'utf8', env: {...env, KADAN_RESTART_REASON: '우연히 남은 옛 이유'}});
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /다르다/);
  assert.equal(readLedger().filter(e => e.session === 'kadan-cutcase' && e.kind === 'stop').length, 1, '충돌 거절은 끄지 않는다');
  // (3) 깨끗한 환경에서 명시 이유·PID로 재시작하면 정상 처리되고 원장 이유는 새 값이다
  const second = spawnSync(process.execPath, [cli, 'restart', 'cutcase', '--reason', '터미널 이유', '--expect-pid', String(latestPid())],
    {encoding: 'utf8', env});
  assert.equal(second.status, 0, second.stdout + second.stderr);
  const start = readLedger().filter(e => e.session === 'kadan-cutcase' && e.kind === 'start').at(-1);
  assert.equal(start.reason, '터미널 이유');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.dir, 'env.json'), 'utf8')), {reason: null, expectPid: null});
});

test('실제 CLI: 본체가 직접 연 저장 대화(B)는 같은 대화로 다시 띄운다', {skip}, t => {
  const s = setup(t, 'body');
  const created = launch({HOLD: `${s.lock(B)},${s.rollout(B)}`, CHILD_FILES: s.rollout(A)}, s, 'kadan-bodycase', 'bodycase');
  const result = restart('bodycase');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const start = readLedger().filter(e => e.session === 'kadan-bodycase' && e.kind === 'start').at(-1);
  assert.match(start.cmd, new RegExp(`resume ${B} --no-alt-screen$`));
  assert.equal(start.restartConversation, B);
  assert.notEqual(String(tmuxFloor.pid('kadan-bodycase')), String(created.panePid));
  assert.equal(readLedger().filter(e => e.session === 'kadan-bodycase' && e.kind === 'send').length, 0, '같은 대화로 이어 열면 첫 안내를 보내지 않는다');
});

test('실제 CLI: 본체는 A lock만, 같은 실행기·모델의 하위 프로세스가 B rollout을 연 경우 거절하고 pane을 끄지 않는다', {skip}, t => {
  const s = setup(t, 'same');
  const created = launch({HOLD: s.lock(A), SPAWN_SAME: '1', SAME_HOLD: s.rollout(B)}, s, 'kadan-samecase', 'samecase');
  const result = restart('samecase');
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /서로 다른 대화 2개/);
  assert.equal(String(tmuxFloor.pid('kadan-samecase')), String(created.panePid));
  assert.equal(readLedger().filter(e => e.session === 'kadan-samecase' && e.kind === 'stop').length, 0);
});

test('실제 CLI: 본체와 하위 프로세스가 같은 대화 하나만 열면(사슬 한 줄) 진행한다', {skip}, t => {
  const s = setup(t, 'chain');
  launch({HOLD: s.rollout(B), SPAWN_SAME: '1', SAME_HOLD: s.rollout(B)}, s, 'kadan-chaincase', 'chaincase');
  const result = restart('chaincase');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(readLedger().filter(e => e.session === 'kadan-chaincase' && e.kind === 'start').at(-1).cmd, new RegExp(`resume ${B} --no-alt-screen$`));
});
