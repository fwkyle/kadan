import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ledgerHome, appendLedger, readLedger} from '../src/ledger.mjs';
import {tmuxFloor, tmux} from '../src/floor-tmux.mjs';
import {settingsWith} from './helpers/runner-table.mjs';

// 실제 tmux·ps·lsof·CLI로 "대화 파일의 주인" 경계를 확인한다. 실행기는 가짜 Node 스크립트이고(실제 AI·신뢰 설정 없음),
// 격리 홈·격리 tmux 서버만 쓴다. 가짜 codex 본체는 파일을 열고, 자식 Node가 다른 파일을 연다.
const A = '0197aaaa-1111-4222-8333-444455556666', B = '0197bbbb-1111-4222-8333-444455556666';
const cli = new URL('../src/cli.mjs', import.meta.url).pathname;

function setup(t, name) {
  const home = ledgerHome();
  process.env.KADAN_SOCKET = `r${process.pid}${name}`;
  process.env.TMUX_TMPDIR = fs.mkdtempSync('/tmp/kr-'); // 소켓 경로가 길면 tmux가 거절한다
  t.after(() => { tmux(['kill-server']); delete process.env.KADAN_SOCKET; delete process.env.TMUX_TMPDIR; });
  const dir = path.join(home, name);
  fs.mkdirSync(path.join(dir, 'codex-home/sessions/2026/10/14'), {recursive: true});
  fs.mkdirSync(path.join(dir, 'codex-home/thread-writer-locks'), {recursive: true});
  const rollout = id => path.join(dir, `codex-home/sessions/2026/10/14/rollout-2026-10-14T16-35-00-${id}.jsonl`);
  const lock = id => path.join(dir, `codex-home/thread-writer-locks/${id}.lock`);
  for (const f of [rollout(A), rollout(B), lock(A), lock(B)]) fs.writeFileSync(f, '{}');
  const ready = path.join(dir, 'ready');
  // 자식 Node: 인자로 받은 파일을 열고 유지한다.
  fs.writeFileSync(path.join(dir, 'child.js'), `const fs=require('fs');const fds=process.argv.slice(2).map(f=>fs.openSync(f,'r'));
fs.writeFileSync(${JSON.stringify(ready)}+'.child','ok');setInterval(()=>{},1000);`);
  // 가짜 codex 본체: HOLD로 받은 파일을 열고, CHILD_FILES가 있으면 자식에게 열게 한다.
  const fake = path.join(dir, 'codex');
  fs.writeFileSync(fake, `#!${process.execPath}
const fs=require('fs');const cp=require('child_process');
const fds=(process.env.HOLD||'').split(',').filter(Boolean).map(f=>fs.openSync(f,'r'));
const child=process.env.IS_SAME_CHILD==='1';
if(process.env.SPAWN_SAME)cp.spawn(process.execPath,[__filename,'--model','test-model','-c','e=low'],{env:{...process.env,HOLD:process.env.SAME_HOLD,SPAWN_SAME:'',IS_SAME_CHILD:'1'},stdio:'ignore'});
if(process.env.CHILD_FILES)cp.spawn(process.execPath,[${JSON.stringify(path.join(dir, 'child.js'))},...process.env.CHILD_FILES.split(',')],{stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(ready)}+(child?'.child':''),'ok');setInterval(()=>{},1000);`, {mode: 0o700});
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

test('실제 CLI: 본체가 직접 연 저장 대화(B)는 같은 대화로 다시 띄운다', {skip}, t => {
  const s = setup(t, 'body');
  const created = launch({HOLD: `${s.lock(B)},${s.rollout(B)}`, CHILD_FILES: s.rollout(A)}, s, 'kadan-bodycase', 'bodycase');
  const result = restart('bodycase');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const start = readLedger().filter(e => e.session === 'kadan-bodycase' && e.kind === 'start').at(-1);
  assert.match(start.cmd, new RegExp(`resume ${B}$`));
  assert.equal(start.restartConversation, B);
  assert.notEqual(String(tmuxFloor.pid('kadan-bodycase')), String(created.panePid));
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
  assert.match(readLedger().filter(e => e.session === 'kadan-chaincase' && e.kind === 'start').at(-1).cmd, new RegExp(`resume ${B}$`));
});
