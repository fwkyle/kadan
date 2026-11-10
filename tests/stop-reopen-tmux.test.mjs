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

test('실제 CLI: 시작 → stop(원장에 번호) → reopen(같은 번호·폴더·모델) → 다시 stop(같은 번호)', {skip}, t => {
  const s = setup(t, 'round');
  const created = launch({HOLD: `${s.lock(A)},${s.rollout(A)}`}, s, 'kadan-roundcase', 'roundcase');
  const stopped = kadan('stop', 'roundcase');
  assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
  assert.equal(stopped.stdout, '종료됨: kadan-roundcase\n', 'stdout은 예전과 같은 한 줄이다');
  assert.equal(tmuxFloor.alive('kadan-roundcase'), false);
  const [start, stop] = of('kadan-roundcase');
  assert.equal(stop.kind, 'stop');
  assert.equal(stop.conversation, A);
  assert.equal(stop.conversationStart, startDigest(start));

  // 꺼진 역할에 우편: 보관(종료 0)은 그대로이고, 다시 여는 명령 안내는 stderr에만 나온다.
  const mail = kadan('mail', 'roundcase', '끝난 뒤 질문');
  assert.equal(mail.status, 0, mail.stdout + mail.stderr);
  assert.match(mail.stderr, /받는 역할 roundcase은\(는\) 꺼져 있습니다 — 같은 대화로 다시 열기: kadan reopen roundcase/);
  assert.doesNotMatch(mail.stdout, /reopen/);
  assert.equal(JSON.parse(mail.stdout.trim().split('\n').at(-1)).wake, 'watch-required', 'stdout 마지막 줄은 예전처럼 보관 영수증 JSON이다');

  fs.rmSync(s.ready, {force: true});
  const reopened = kadan('reopen', 'roundcase');
  assert.equal(reopened.status, 0, reopened.stdout + reopened.stderr);
  assert.match(reopened.stdout, new RegExp(`^다시 열림: kadan-roundcase \\(codex test-model, 대화 ${A}, pane PID \\d+, 창: `));
  assert.match(reopened.stderr, /대화 파일이 남아 있는지는 확인하지 못했다/, '이 시험 설정에는 stored 칸이 없다');
  assert.equal(tmuxFloor.alive('kadan-roundcase'), true);
  assert.notEqual(String(tmuxFloor.pid('kadan-roundcase')), String(created.panePid), '새 프로세스다');
  until(() => fs.existsSync(s.ready + '.resumed'), '다시 연 가짜 실행기가 resume 표시를 남겼다');
  const resumed = JSON.parse(fs.readFileSync(s.ready + '.resumed', 'utf8'));
  assert.equal(resumed.id, A, '가짜 실행기가 같은 대화 번호로 떴다');
  assert.equal(fs.realpathSync(resumed.cwd), fs.realpathSync(s.work), '같은 작업 폴더다');
  assert.deepEqual(resumed.argv, ['--model', 'test-model', '-c', 'e=low', 'resume', A, '--no-alt-screen']);
  const after = of('kadan-roundcase').slice(2);
  // 우편 보관 기록(받는 이름으로 남는 것)은 빼고 본다: reopen이 더한 것은 start 하나다.
  const added = after.filter(e => e.kind === 'start');
  assert.equal(added.length, 1);
  assert.equal(added[0].reopenConversation, A); assert.equal(added[0].reopenOf, startDigest(start));
  assert.equal(added[0].reopenStopAt, stop.t); assert.equal(added[0].roleProfile, 'worker');
  assert.equal(added[0].conversationMode, 'resume'); assert.equal(added[0].model, 'test-model');
  assert.equal(fs.realpathSync(added[0].cwd), fs.realpathSync(s.work));
  const kinds = readLedger().map(e => e.kind);
  assert.equal(kinds.includes('compare-pick'), false, '비교 모드 예약을 만들지 않는다');
  assert.equal(readLedger().filter(e => e.kind === 'send' && e.session === 'kadan-roundcase' && e.t > added[0].t).length, 0, '시작 안내 우편을 보내지 않는다');

  // 살아 있으면 다시 열지 않는다.
  const twice = kadan('reopen', 'roundcase');
  assert.notEqual(twice.status, 0);
  assert.match(twice.stderr, /이미 살아 있다/);
  // 다시 연 세대를 끄면 같은 번호가 다시 남는다(가짜 실행기가 resume으로 그 대화 파일을 열었다).
  until(() => fs.existsSync(s.ready), '다시 연 가짜 실행기가 대화 파일을 열었다');
  const again = kadan('stop', 'roundcase');
  assert.equal(again.status, 0, again.stdout + again.stderr);
  const lastStop = of('kadan-roundcase').findLast(e => e.kind === 'stop');
  assert.equal(lastStop.conversation, A);
  assert.equal(lastStop.conversationStart, startDigest(of('kadan-roundcase').findLast(e => e.kind === 'start')));
});

test('실제 CLI: 본체는 A lock만, 자식이 B 대화를 연 경우 B를 적지 않고 끈다 — reopen은 거절하고 세션을 만들지 않는다', {skip}, t => {
  const s = setup(t, 'child');
  launch({HOLD: s.lock(A), CHILD_FILES: s.rollout(B)}, s, 'kadan-childstop', 'childstop');
  const stopped = kadan('stop', 'childstop');
  assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
  assert.equal(tmuxFloor.alive('kadan-childstop'), false, '못 찾아도 끈다');
  const stop = of('kadan-childstop').find(e => e.kind === 'stop');
  assert.equal(stop.conversation, undefined);
  assert.equal(stop.conversationMissing, 'undetermined');
  const mail = kadan('mail', 'childstop', '질문');
  assert.equal(mail.status, 0);
  assert.doesNotMatch(mail.stderr, /reopen/, '다시 열 번호가 없으면 안내하지 않는다');
  const reopened = kadan('reopen', 'childstop');
  assert.notEqual(reopened.status, 0);
  assert.match(reopened.stderr, /stop 기록에 대화 번호가 없다\(끌 때 못 찾음: undetermined\)/);
  assert.equal(tmuxFloor.alive('kadan-childstop'), false);
  assert.equal(of('kadan-childstop').filter(e => e.kind === 'start').length, 1);
});

test('실제 CLI: 없는 세션의 stop과 실행기가 아닌 세션의 stop은 예전 출력·종료 코드 그대로다', {skip}, t => {
  const s = setup(t, 'plain');
  const missing = kadan('stop', 'nosuch');
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.equal(missing.stderr, '오류: 세션 없음: kadan-nosuch\n');
  const created = tmuxFloor.create({session: 'kadan-shellcase', role: 'shellcase', cwd: s.work, cmd: 'sleep 300'});
  appendLedger({kind: 'start', floor: 'tmux', role: 'shellcase', session: 'kadan-shellcase', cwd: s.work, cmd: 'sleep 300', by: 'test', ...created});
  const started = Date.now();
  const stopped = kadan('stop', 'shellcase');
  assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
  assert.equal(stopped.stdout, '종료됨: kadan-shellcase\n');
  assert.equal(stopped.stderr, '');
  assert.equal(of('kadan-shellcase').find(e => e.kind === 'stop').conversationMissing, 'not-ai-runner');
  assert.ok(Date.now() - started < 30_000);
  const reopened = kadan('reopen', 'shellcase');
  assert.notEqual(reopened.status, 0);
  assert.equal(tmuxFloor.alive('kadan-shellcase'), false);
  const usage = kadan('reopen');
  assert.notEqual(usage.status, 0);
  assert.match(usage.stderr, /사용법: kadan reopen <역할> \[--hidden\]/);
  const help = kadan('reopen', 'shellcase', '--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /사용법: kadan reopen/);
  assert.equal(tmuxFloor.alive('kadan-shellcase'), false, '--help는 아무것도 열지 않는다');
});
