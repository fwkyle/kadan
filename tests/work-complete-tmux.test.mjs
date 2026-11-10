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
console.log('›');fs.writeFileSync(${JSON.stringify(ready)},'ok');${WATCH_PARENT}`, {mode: 0o700});
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
import {CardStore} from '../src/card-store.mjs';

test('실제 CLI: work complete가 두 세션을 끄고(stop에 번호), stdout은 JSON만이며, reopen으로 하나를 다시 연다', {skip}, t => {
  const s = setup(t, 'wc');
  launch({HOLD: `${s.lock(A)},${s.rollout(A)}`}, s, 'kadan-wcworker', 'wcworker');
  fs.rmSync(s.ready, {force: true});
  launch({HOLD: `${s.lock(B)},${s.rollout(B)}`}, s, 'kadan-wcreview', 'wcreview');
  const home = ledgerHome(), store = new WorkStore(home), cards = new CardStore(home);
  store.create({key: 'repo/wc', title: '업무', goal: '결과', scope: '범위', acceptance: '조건', owner: 'wcboss', repoPath: s.work});
  for (const role of ['wcworker', 'wcreview']) {
    store.change('repo/wc', 'execute', {title: role, body: '본문', phase: 'implementation', round: '1'}, {revision: store.get('repo/wc').revision, by: 'wcboss', note: '발령'});
    const key = store.get('repo/wc').executions.at(-1).key, id = key.split('/')[1];
    cards.update(key, {status: 'assigned', role, board: 'b', scope: '범위', rallyId: 'r', rallyTitle: 'r', rallyRound: '1', rallyStep: 'implementation'}, {revision: cards.get(key).revision, note: '배정', by: 'wcboss'});
    appendLedger({kind: 'send', by: 'wcboss', role, taskId: id, executionKey: key, digest: role + id});
    appendLedger({kind: 'done', by: role, role, taskId: id, executionKey: key, result: 'ok'});
  }
  const args = ['work', 'complete', 'repo/wc', '--revision', String(store.get('repo/wc').revision), '--result', '근거', '--note', '확인'];
  const env = {KADAN_ROLE: 'wcboss'};
  const run = extra => spawnSync(process.execPath, [cli, ...args, ...extra], {encoding: 'utf8', env: {...process.env, KADAN_WINDOW: 'none', KADAN_FLOOR: 'tmux', ...env}});
  // --keep-roles: 아무것도 끄지 않는다(그리고 마감은 기록된다).
  const kept = run(['--keep-roles']);
  assert.equal(kept.status, 0, kept.stdout + kept.stderr);
  assert.equal(JSON.parse(kept.stdout).status, 'done');
  assert.match(kept.stderr, /꺼졌을 역할 2개\(--keep-roles: 끄지 않음\)/);
  assert.equal(tmuxFloor.alive('kadan-wcworker'), true); assert.equal(tmuxFloor.alive('kadan-wcreview'), true);
  if (process.env.WC_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.WC_EVIDENCE_DIR, 'work-complete-keep-roles.txt'), 'STDOUT:\n' + kept.stdout + '\nSTDERR:\n' + kept.stderr);
  // 마감된 업무를 다시 열고 이번엔 끈다.
  store.change('repo/wc', 'reopen', {}, {revision: store.get('repo/wc').revision, by: 'wcboss', note: '재개'});
  args[args.indexOf('--revision') + 1] = String(store.get('repo/wc').revision);
  const done = run([]);
  assert.equal(done.status, 0, done.stdout + done.stderr);
  const json = JSON.parse(done.stdout);
  assert.equal(json.status, 'done'); assert.equal(json.roleCleanup.closed.length, 2);
  assert.match(done.stderr, new RegExp(`끈 역할 2개: .*wcworker\\(대화 ${A} — 다시 열기: kadan reopen wcworker\\)`));
  assert.equal(tmuxFloor.alive('kadan-wcworker'), false); assert.equal(tmuxFloor.alive('kadan-wcreview'), false);
  assert.equal(of('kadan-wcworker').findLast(e => e.kind === 'stop').conversation, A);
  assert.equal(of('kadan-wcreview').findLast(e => e.kind === 'stop').conversation, B);
  if (process.env.WC_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.WC_EVIDENCE_DIR, 'work-complete-closed.txt'), 'STDOUT:\n' + done.stdout + '\nSTDERR(2>&1 뒤쪽):\n' + done.stderr);
  const reopened = kadan('reopen', 'wcworker');
  assert.equal(reopened.status, 0, reopened.stdout + reopened.stderr);
  assert.equal(tmuxFloor.alive('kadan-wcworker'), true);
  assert.equal(tmuxFloor.alive('kadan-wcreview'), false);
  kadan('stop', 'wcworker');
});

test('실제 CLI(F1): 같은 이름을 새 대화로 다시 쓴 세션은 옛 업무를 마감해도 꺼지지 않는다', {skip}, t => {
  const s = setup(t, 'reuse');
  launch({HOLD: `${s.lock(A)},${s.rollout(A)}`}, s, 'kadan-reuserole', 'reuserole');
  const home = ledgerHome(), store = new WorkStore(home), cards = new CardStore(home);
  store.create({key: 'repo/old', title: '옛 업무', goal: '결과', scope: '범위', acceptance: '조건', owner: 'wcboss', repoPath: s.work});
  store.change('repo/old', 'execute', {title: 'x', body: '본문', phase: 'implementation', round: '1'}, {revision: 1, by: 'wcboss', note: '발령'});
  const key = store.get('repo/old').executions[0].key, id = key.split('/')[1];
  cards.update(key, {status: 'assigned', role: 'reuserole', board: 'b', scope: '범위', rallyId: 'r', rallyTitle: 'r', rallyRound: '1', rallyStep: 'implementation'}, {revision: cards.get(key).revision, note: '배정', by: 'wcboss'});
  appendLedger({kind: 'send', by: 'wcboss', role: 'reuserole', taskId: id, executionKey: key, digest: 'r' + id});
  appendLedger({kind: 'done', by: 'reuserole', role: 'reuserole', taskId: id, executionKey: key, result: 'ok'});
  assert.equal(kadan('stop', 'reuserole').status, 0);
  wait(30);
  fs.rmSync(s.ready, {force: true});
  launch({HOLD: `${s.lock(B)},${s.rollout(B)}`}, s, 'kadan-reuserole', 'reuserole'); // 같은 이름, 새 대화
  const done = spawnSync(process.execPath, [cli, 'work', 'complete', 'repo/old', '--revision', String(store.get('repo/old').revision), '--result', '근거', '--note', '확인'],
    {encoding: 'utf8', env: {...process.env, KADAN_WINDOW: 'none', KADAN_FLOOR: 'tmux', KADAN_ROLE: 'wcboss'}});
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.equal(JSON.parse(done.stdout).status, 'done');
  assert.equal(tmuxFloor.alive('kadan-reuserole'), true, '새 대화 세션은 살아 있어야 한다');
  assert.match(done.stderr, /reuserole — 이 업무의 발령을 받은 대화 세대가 아님 · 끄려면 kadan stop reuserole/);
  kadan('stop', 'reuserole');
});

// 공통: 역할 하나를 띄우고, 그 역할에 실행 하나를 발령·done한 업무를 만든다.
function oneRoleWork(t, name, role, workKey) {
  const s = setup(t, name);
  launch({HOLD: `${s.lock(A)},${s.rollout(A)}`}, s, `kadan-${role}`, role);
  const home = ledgerHome(), store = new WorkStore(home), cards = new CardStore(home);
  store.create({key: workKey, title: '업무', goal: '결과', scope: '범위', acceptance: '조건', owner: 'wcboss', repoPath: s.work});
  store.change(workKey, 'execute', {title: 'x', body: '본문', phase: 'implementation', round: '1'}, {revision: 1, by: 'wcboss', note: '발령'});
  const key = store.get(workKey).executions[0].key, id = key.split('/')[1];
  cards.update(key, {status: 'assigned', role, board: 'b', scope: '범위', rallyId: 'r', rallyTitle: 'r', rallyRound: '1', rallyStep: 'implementation'}, {revision: cards.get(key).revision, note: '배정', by: 'wcboss'});
  appendLedger({kind: 'send', by: 'wcboss', role, taskId: id, executionKey: key, digest: 'd' + id});
  appendLedger({kind: 'done', by: role, role, taskId: id, executionKey: key, result: 'ok'});
  const complete = () => spawnSync(process.execPath, [cli, 'work', 'complete', workKey, '--revision', String(store.get(workKey).revision), '--result', '근거', '--note', '확인'],
    {encoding: 'utf8', env: {...process.env, KADAN_WINDOW: 'none', KADAN_FLOOR: 'tmux', KADAN_ROLE: 'wcboss'}});
  return {s, home, store, key, complete};
}

test('실제 CLI(R1): 새 대화로 다시 쓴 이름에 옛 실행 주소의 일반 우편만 있으면 마감해도 꺼지지 않는다', {skip}, t => {
  const w = oneRoleWork(t, 'r1', 'r1role', 'repo/r1');
  assert.equal(kadan('stop', 'r1role').status, 0);
  wait(30);
  fs.rmSync(w.s.ready, {force: true});
  launch({HOLD: `${w.s.lock(B)},${w.s.rollout(B)}`}, w.s, 'kadan-r1role', 'r1role');
  const mail = kadan('mail', 'r1role', '--execution', w.key, '옛 실행에 대한 일반 질문');
  assert.equal(mail.status, 0, mail.stdout + mail.stderr);
  const general = of('kadan-r1role').filter(e => e.kind === 'send' && e.executionKey === w.key && !e.taskId);
  assert.ok(general.length >= 1, '실행 주소만 붙고 taskId가 없는 일반 우편이 원장에 남았다');
  const done = w.complete();
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.equal(tmuxFloor.alive('kadan-r1role'), true);
  assert.match(done.stderr, /r1role — 이 업무의 발령을 받은 대화 세대가 아님/);
  kadan('stop', 'r1role');
});

test('실제 CLI(R2): 진행 중인 인계(prepared)에 묶인 역할은 마감해도 꺼지지 않고, 끝난 인계면 꺼진다', {skip}, t => {
  const w = oneRoleWork(t, 'r2', 'r2role', 'repo/r2');
  const dir = path.join(w.home, 'handovers'); fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'h.json'), JSON.stringify({id: 'h', phase: 'prepared', from: 'r2role', to: 'r2next'}));
  const done = w.complete();
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.equal(tmuxFloor.alive('kadan-r2role'), true);
  assert.match(done.stderr, /r2role — 진행 중인 인계에 묶여 있음/);
  // 인계가 끝난 뒤 업무를 다시 열고 마감하면 꺼진다(정상 방향).
  fs.writeFileSync(path.join(dir, 'h.json'), JSON.stringify({id: 'h', phase: 'complete', from: 'r2role', to: 'r2next'}));
  w.store.change('repo/r2', 'reopen', {}, {revision: w.store.get('repo/r2').revision, by: 'wcboss', note: '재개'});
  const again = w.complete();
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(tmuxFloor.alive('kadan-r2role'), false);
});
