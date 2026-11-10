import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ledgerHome, appendLedger, readLedger} from '../src/ledger.mjs';
import {tmuxFloor, tmux} from '../src/floor-tmux.mjs';
import {settingsWith} from './helpers/runner-table.mjs';
import {startDigest} from '../src/secretary-resume.mjs';
import {reopenRole} from '../src/reopen.mjs';
import {createWatchMailReader} from '../src/watch-mail-reader.mjs';
import {watchRoleState} from '../src/watch-role-facts.mjs';
import {collectRoles} from '../src/watch-roles.mjs';

// 실제 tmux·ps·lsof·CLI로 "끌 때 대화 번호 남기기 → 그 번호로 다시 열기" 왕복을 확인한다.
// 실행기는 가짜 Node 스크립트이고(실제 AI 없음), 격리 홈·격리 tmux 서버만 쓴다(restart-tmux.test.mjs와 같은 틀).
const A = '0197aaaa-1111-4222-8333-444455556666', B = '0197bbbb-1111-4222-8333-444455556666';
const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
// 가짜 실행기·자식은 부모(창 안 프로세스)가 사라지면 스스로 끝난다.
const WATCH_PARENT = "const pp=process.ppid;setInterval(()=>{try{process.kill(pp,0)}catch{process.exit(0)}},200);";
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// 조건이 참이 될 때까지 최대 20초 기다린다(부하가 높을 때 가짜 실행기가 늦게 뜬다). 끝내 안 되면 무엇을 기다렸는지 밝히고 실패한다.
function until(check, what) {
  for (let i = 0; i < 400 && !check(); i++) wait(50);
  assert.ok(check(), `기다렸지만 되지 않음: ${what}`);
}

function setup(t, name) {
  const home = ledgerHome();
  const prior = {socket: process.env.KADAN_SOCKET, tmpdir: process.env.TMUX_TMPDIR};
  process.env.KADAN_SOCKET = `o${process.pid}${name}`;
  const sockDir = fs.mkdtempSync('/tmp/ko-'); // 소켓 경로가 길면 tmux가 거절한다
  process.env.TMUX_TMPDIR = sockDir;
  t.after(() => {
    tmux(['kill-server']);
    fs.rmSync(sockDir, {recursive: true, force: true});
    for (const [key, value] of [['KADAN_SOCKET', prior.socket], ['TMUX_TMPDIR', prior.tmpdir]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const dir = path.join(home, name);
  fs.mkdirSync(path.join(dir, 'codex-home/sessions/2026/11/10'), {recursive: true});
  fs.mkdirSync(path.join(dir, 'codex-home/thread-writer-locks'), {recursive: true});
  const rollout = id => path.join(dir, `codex-home/sessions/2026/11/10/rollout-2026-11-10T16-35-00-${id}.jsonl`);
  const lock = id => path.join(dir, `codex-home/thread-writer-locks/${id}.lock`);
  for (const f of [rollout(A), rollout(B), lock(A), lock(B)]) fs.writeFileSync(f, '{}');
  const ready = path.join(dir, 'ready');
  fs.writeFileSync(path.join(dir, 'child.js'), `const fs=require('fs');const fds=process.argv.slice(2).map(f=>fs.openSync(f,'r'));
fs.writeFileSync(${JSON.stringify(ready)}+'.child','ok');${WATCH_PARENT}`);
  // 가짜 codex 본체: HOLD로 받은 파일을 열고, `resume <id>`로 뜨면 그 대화의 lock·저장 파일을 연다(다시 열렸는지의 증거).
  const fake = path.join(dir, 'codex');
  fs.writeFileSync(fake, `#!${process.execPath}
const fs=require('fs');const cp=require('child_process');
const fds=(process.env.HOLD||'').split(',').filter(Boolean).map(f=>fs.openSync(f,'r'));
const ri=process.argv.indexOf('resume');
if(ri>0&&process.argv[ri+1]){const id=process.argv[ri+1];const base=__dirname;for(const f of [base+'/codex-home/thread-writer-locks/'+id+'.lock',base+'/codex-home/sessions/2026/11/10/rollout-2026-11-10T16-35-00-'+id+'.jsonl'])try{fs.openSync(f,'r')}catch{}
fs.writeFileSync(${JSON.stringify(ready)}+'.resumed',JSON.stringify({id,cwd:process.cwd(),argv:process.argv.slice(2)}));}
if(process.env.CHILD_FILES)cp.spawn(process.execPath,[${JSON.stringify(path.join(dir, 'child.js'))},...process.env.CHILD_FILES.split(',')],{stdio:'ignore'});
if(process.stdin.isTTY)process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('data',()=>process.stdout.write('\\x1b[2J\\x1b[H› \\n'));console.log('›');fs.writeFileSync(${JSON.stringify(ready)},'ok');${WATCH_PARENT}`, {mode: 0o700});
  const settings = settingsWith({codex: {
    spawn: `${fake} --model {model} -c e={effort}`, resume: `${fake} --model {model} -c e={effort} resume {conversation}`,
    models: [{model: 'test-model', efforts: ['low']}],
    conversation: {kind: 'open-file', pattern: '/sessions/.+/rollout-[0-9T-]+-([0-9a-f-]{36})\\.jsonl$',
      evidence: ['/thread-writer-locks/([0-9a-f-]{36})\\.lock$']}}});
  fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify(settings));
  return {home, dir, fake, rollout, lock, ready, work: sockDir};
}

// 역할의 작업 폴더는 KADAN_HOME 밖이어야 한다. 소켓 폴더가 이미 홈 밖의 정리 대상이라 그것을 쓴다.
function launch(env, {fake, ready, work}, session, role) {
  const cmd = `${fake} --model test-model -c e=low`;
  const created = tmuxFloor.create({session, role, cwd: work, cmd: `env ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')} ${cmd}`});
  appendLedger({kind: 'start', floor: 'tmux', role, session, cwd: work, cmd, roleProfile: 'worker', by: 'test', ...created});
  until(() => fs.existsSync(ready) && (!env.CHILD_FILES || fs.existsSync(ready + '.child')), '가짜 실행기가 파일을 열었다');
  return created;
}
const kadan = (...args) => spawnSync(process.execPath, [cli, ...args], {encoding: 'utf8',
  env: {...process.env, KADAN_WINDOW: 'none', KADAN_FLOOR: 'tmux', KADAN_ROLE: ''}});
const of = session => readLedger().filter(e => e.session === session);
const skip = spawnSync('tmux', ['-V']).status !== 0;




import {WorkStore} from '../src/work-store.mjs';

// Why: 업무 마감 때 작업자·검수자를 함께 끄는 일을 실제 CLI 자식 프로세스·격리 홈·격리 tmux·가짜 실행기로 확인한다.
// 발령과 done은 appendLedger로 흉내 내지 않고 실제 명령(work execute --assign --dispatch · dispatch --task · send --task · done)으로 만든다
// (3차 검수 S1: 가짜 발령 기록을 쓴 시험이 실제 발령의 header 표시를 놓쳤다).
const BOSS = 'wcboss';
const bossEnv = () => ({...process.env, KADAN_WINDOW: 'none', KADAN_FLOOR: 'tmux', KADAN_ROLE: BOSS}); // setup()이 격리 소켓을 정한 뒤에 읽는다
const cliAs = (env, ...args) => spawnSync(process.execPath, [cli, ...args], {encoding: 'utf8', env});
const boss = (...args) => { const r = cliAs(bossEnv(), ...args); assert.equal(r.status, 0, args.join(' ') + '\n' + r.stdout + r.stderr); return r; };
const asRole = (role, ...args) => cliAs({...bossEnv(), KADAN_ROLE: role}, ...args);

// 업무를 만들고 실행을 하나씩 발령하는 도우미. via: 'assign-dispatch' | 'dispatch' | 'send'
function workFixture(s, workKey) {
  const body = path.join(s.dir, 'body.md');
  fs.writeFileSync(body, '# 실행\n## Why\n격리 검증\n## 읽고 시작할 것\n- ' + cli + '\n');
  boss('work', 'create', workKey, '--title', '업무', '--goal', '결과', '--scope', '범위', '--acceptance', '조건', '--owner', BOSS, '--repo-path', s.work, '--board', 'b');
  const store = () => new WorkStore(ledgerHome());
  let round = 0;
  const execute = (role, via) => {
    round += 1;
    const args = ['work', 'execute', workKey, '--revision', String(store().get(workKey).revision), '--phase', 'implementation', '--round', String(round),
      '--title', 'e' + round, '--body-file', body, '--note', '발령', '--assign', role];
    if (via === 'assign-dispatch') args.push('--dispatch', '시작하라');
    const key = JSON.parse(boss(...args).stdout).card.key, id = key.split('/')[1];
    if (via === 'dispatch') boss('dispatch', role, '--task', id, '--work', workKey, '--execution', key, '시작하라');
    if (via === 'send') boss('send', role, '--task', id, '--work', workKey, '--execution', key, '시작하라');
    return {key, id};
  };
  const finish = (role, id) => { const r = asRole(role, 'done', role, id, 'ok'); assert.equal(r.status, 0, r.stdout + r.stderr); };
  const complete = (...extra) => cliAs(bossEnv(), 'work', 'complete', workKey, '--revision', String(store().get(workKey).revision), '--result', '근거', '--note', '확인', ...extra);
  return {execute, finish, complete, store};
}
const roleLaunch = (s, role, env) => { fs.rmSync(s.ready, {force: true}); return launch(env, s, 'kadan-' + role, role); };

test('실제 CLI: 세 발령 경로(work execute --assign --dispatch · dispatch --task · send --task)로 일한 보통 작업자·검수자가 마감 뒤 꺼지고 stop에 대화 번호가 남는다', {skip}, t => {
  const s = setup(t, 'three');
  roleLaunch(s, 'wa', {HOLD: s.lock(A) + ',' + s.rollout(A)});
  roleLaunch(s, 'wb', {HOLD: s.lock(B) + ',' + s.rollout(B)});
  roleLaunch(s, 'wc', {HOLD: ''});
  const w = workFixture(s, 'repo/three');
  for (const [role, via] of [['wa', 'assign-dispatch'], ['wb', 'dispatch'], ['wc', 'send']]) w.finish(role, w.execute(role, via).id);
  // --keep-roles: 마감은 기록되고 아무것도 끄지 않는다.
  const kept = w.complete('--keep-roles');
  assert.equal(kept.status, 0, kept.stdout + kept.stderr);
  assert.match(kept.stderr, /꺼졌을 역할 3개\(--keep-roles: 끄지 않음\)/);
  for (const r of ['wa', 'wb', 'wc']) assert.equal(tmuxFloor.alive('kadan-' + r), true);
  if (process.env.WC_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.WC_EVIDENCE_DIR, 'real-keep-roles.txt'), 'STDOUT:\n' + kept.stdout + '\nSTDERR:\n' + kept.stderr);
  w.store().change('repo/three', 'reopen', {}, {revision: w.store().get('repo/three').revision, by: BOSS, note: '재개'});
  const done = w.complete();
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.equal(JSON.parse(done.stdout).status, 'done', 'stdout은 JSON 한 덩어리다');
  assert.equal(JSON.parse(done.stdout).roleCleanup.closed.length, 3);
  for (const r of ['wa', 'wb', 'wc']) assert.equal(tmuxFloor.alive('kadan-' + r), false, r);
  assert.equal(of('kadan-wa').findLast(e => e.kind === 'stop').conversation, A);
  assert.equal(of('kadan-wb').findLast(e => e.kind === 'stop').conversation, B);
  if (process.env.WC_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.WC_EVIDENCE_DIR, 'real-three-paths-closed.txt'), 'STDOUT:\n' + done.stdout + '\nSTDERR:\n' + done.stderr);
  // 실제 발령이 남긴 모양: 세 경로 모두 taskId·dispatchId·header가 붙은 send다.
  const sends = readLedger().filter(e => e.kind === 'send' && e.taskId && ['kadan-wa', 'kadan-wb', 'kadan-wc'].includes(e.session));
  assert.equal(sends.length, 3); assert.ok(sends.every(e => e.dispatchId && e.header === true && e.keyDelivery === 'sent'));
  const reopened = kadan('reopen', 'wa');
  assert.equal(reopened.status, 0, reopened.stdout + reopened.stderr);
  assert.equal(tmuxFloor.alive('kadan-wa'), true);
  kadan('stop', 'wa');
});

test('실제 CLI: kadan restart·kadan reopen으로 다시 띄운 세션은 마감해도 남고 이유가 나온다', {skip}, t => {
  const s = setup(t, 'cont');
  roleLaunch(s, 'ra', {HOLD: s.lock(A) + ',' + s.rollout(A)});
  roleLaunch(s, 'rb', {HOLD: s.lock(B) + ',' + s.rollout(B)});
  const w = workFixture(s, 'repo/cont');
  w.finish('ra', w.execute('ra', 'assign-dispatch').id);
  w.finish('rb', w.execute('rb', 'assign-dispatch').id);
  const restarted = kadan('restart', 'rb'); // 같은 대화로 프로그램만 다시 띄운다
  assert.equal(restarted.status, 0, restarted.stdout + restarted.stderr);
  // reopen: 끈 뒤 같은 대화로 다시 연다.
  assert.equal(kadan('stop', 'ra').status, 0);
  fs.rmSync(s.ready, {force: true});
  const reopened = kadan('reopen', 'ra');
  assert.equal(reopened.status, 0, reopened.stdout + reopened.stderr);
  until(() => fs.existsSync(s.ready), '다시 연 가짜 실행기가 떴다');
  const done = w.complete();
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.equal(tmuxFloor.alive('kadan-ra'), true, 'reopen으로 이은 세션은 남는다');
  assert.match(done.stderr, /ra — 다시 띄우거나 이어 연 세션 — 직접 끄려면 kadan stop · 끄려면 kadan stop ra/);
  assert.equal(tmuxFloor.alive('kadan-rb'), true, 'restart로 다시 띄운 세션도 남는다');
  assert.match(done.stderr, /rb — 다시 띄우거나 이어 연 세션/);
  kadan('stop', 'ra'); kadan('stop', 'rb');
});

test('실제 CLI: 같은 이름을 새 대화로 다시 쓰면(옛 업무 마감) 남고, 일반 우편만 받은 새 대화도 남는다', {skip}, t => {
  const s = setup(t, 'reuse2');
  roleLaunch(s, 'ua', {HOLD: s.lock(A) + ',' + s.rollout(A)});
  const w = workFixture(s, 'repo/reuse2');
  w.finish('ua', w.execute('ua', 'assign-dispatch').id);
  assert.equal(kadan('stop', 'ua').status, 0);
  wait(30);
  roleLaunch(s, 'ua', {HOLD: s.lock(B) + ',' + s.rollout(B)}); // 같은 이름, 새 대화
  const mail = kadan('mail', 'ua', '--execution', w.store().get('repo/reuse2').executions[0].key, '옛 실행에 대한 일반 질문');
  assert.equal(mail.status, 0, mail.stdout + mail.stderr);
  const done = w.complete();
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.equal(tmuxFloor.alive('kadan-ua'), true);
  assert.match(done.stderr, /ua — 이 업무의 발령을 받은 대화 세대가 아님/);
  kadan('stop', 'ua');
});

test('실제 CLI: 인계 상태 파일이 있으면(진행 중이든 모양을 알 수 없든) 마감해도 남는다', {skip}, t => {
  const s = setup(t, 'hand');
  roleLaunch(s, 'ha', {HOLD: s.lock(A) + ',' + s.rollout(A)});
  const w = workFixture(s, 'repo/hand');
  w.finish('ha', w.execute('ha', 'assign-dispatch').id);
  const dir = path.join(ledgerHome(), 'handovers'); fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'x.json'), JSON.stringify({id: 'x', phase: 'complete'})); // 참가자(from·to)가 빠진 불완전한 파일
  const done = w.complete();
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.equal(tmuxFloor.alive('kadan-ha'), true);
  assert.match(done.stderr, /ha — 인계 상태를 읽지 못함/);
  kadan('stop', 'ha');
  fs.rmSync(path.join(dir, 'x.json'), {force: true}); // 홈은 이 파일의 시험이 함께 쓴다 — 다음 시험에 남기지 않는다
});

// 4차 검수 T1: 실제 `kadan start`가 만든 start 기록의 모양으로 확인한다.
const realStart = (s, role) => {
  fs.rmSync(s.ready, {force: true});
  const r = boss('start', role, '--profile', 'worker', '--cmd', `${s.fake} --model test-model -c e=low`);
  until(() => fs.existsSync(s.ready), '가짜 실행기가 떴다');
  return r;
};

test('실제 CLI(T1): 살아 있는 세션에 kadan start를 다시 친 재사용 기록이 낀 보통 세션은 마감 뒤 꺼진다', {skip}, t => {
  const s = setup(t, 'reuse3');
  realStart(s, 'ta');
  const w = workFixture(s, 'repo/reuse3');
  w.finish('ta', w.execute('ta', 'assign-dispatch').id);
  boss('start', 'ta', '--profile', 'worker'); // 이미 살아 있음 → 재사용 기록
  const starts = of('kadan-ta').filter(e => e.kind === 'start');
  assert.equal(starts.length, 2);
  assert.equal(starts[1].cmd, undefined, '재사용 기록에는 명령이 없다');
  assert.equal(starts[1].reuseOf, startDigest(starts[0]), 'reuseOf는 띄운 start의 지문이다');
  const done = w.complete();
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.equal(tmuxFloor.alive('kadan-ta'), false, done.stderr);
  assert.equal(JSON.parse(done.stdout).roleCleanup.closed.length, 1);
});

test('실제 CLI(T1): 실제 start 기록 모양(명령·출력 기록 경로·같은 PID)의 새 시작 기록이 stop 없이 뒤에 있으면 옛 발령으로 끄지 않는다', {skip}, t => {
  const s = setup(t, 'pidreuse');
  realStart(s, 'tb');
  const w = workFixture(s, 'repo/pidreuse');
  w.finish('tb', w.execute('tb', 'assign-dispatch').id);
  const real = of('kadan-tb').find(e => e.kind === 'start');
  const {t: _t, ...shape} = real; // 실제 CLI가 만든 기록의 칸 그대로, 출력 기록 경로만 새 세대의 것
  appendLedger({...shape, outputLog: real.outputLog.replace(/[^/]+(?=\/manifest\.json$)/, 'new-generation')});
  const done = w.complete();
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.equal(tmuxFloor.alive('kadan-tb'), true, '새 프로세스로 보이는 start 기록이 있으면 옛 세대 발령으로 끄지 않는다');
  assert.match(done.stderr, /tb — 이 업무의 발령을 받은 대화 세대가 아님/);
  kadan('stop', 'tb');
});
