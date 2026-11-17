import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ledgerHome, appendLedger, readLedger} from '../src/ledger.mjs';
import {tmuxFloor, tmux} from '../src/floor-tmux.mjs';

// 실제 tmux·ps·CLI로 "역할이 자기 세션 안에서 kadan stop을 치면" 끝까지 정리되는지 본다.
// pane 안의 스크립트가 자기 역할을 kadan stop한다. 로티는 호출을 기록만 하는 가짜 실행 파일이고,
// 격리 홈·격리 tmux 서버만 쓴다(운영 홈·소켓에 닿으면 pane 스크립트가 실행을 거절한다).
const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function until(check, what, ms = 15000) {
  for (let i = 0; i < ms / 50 && !check(); i++) wait(50);
  assert.ok(check(), `기다렸지만 되지 않음: ${typeof what === 'function' ? what() : what}`);
}
const skip = spawnSync('tmux', ['-V']).status !== 0;
const ps = (field, pid) => spawnSync('ps', ['-o', `${field}=`, '-p', String(pid)], {encoding: 'utf8'}).stdout.trim();

function setup(t, name) {
  const home = ledgerHome();
  const prior = {socket: process.env.KADAN_SOCKET, tmpdir: process.env.TMUX_TMPDIR};
  const socket = `o${process.pid}${name}`;
  process.env.KADAN_SOCKET = socket;
  const sockDir = fs.mkdtempSync('/tmp/ks-'); // 소켓 경로가 길면 tmux가 거절한다
  process.env.TMUX_TMPDIR = sockDir;
  t.after(() => {
    tmux(['kill-server']); // 이 시험의 격리 소켓 서버만 끈다
    fs.rmSync(sockDir, {recursive: true, force: true});
    for (const [key, value] of [['KADAN_SOCKET', prior.socket], ['TMUX_TMPDIR', prior.tmpdir]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const dir = path.join(home, name);
  fs.mkdirSync(dir, {recursive: true});
  const calls = path.join(dir, 'rottie-calls.jsonl');
  const rottie = path.join(dir, 'rottie');
  // 가짜 로티: 호출을 기록하고 모두 성공으로 답한다.
  fs.writeFileSync(rottie, `#!${process.execPath}
const fs=require('fs'),args=process.argv.slice(2),id=args[args.indexOf('--terminal')+1];
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
console.log(JSON.stringify({ok:true,runtime:{bundleId:'example.rottie'},result:{terminal:{id,state:'running'}}}));
`, {mode: 0o700});
  const out = path.join(dir, 'pane-out.json');
  const pane = path.join(dir, 'pane.js');
  // pane 안의 스크립트: 자기 역할을 kadan stop하고, 돌아오면 결과를 적은 채 살아 있는다.
  fs.writeFileSync(pane, `const fs=require('fs'),{spawn}=require('child_process');
if(process.env.KADAN_HOME!==${JSON.stringify(home)}||process.env.KADAN_SOCKET!==${JSON.stringify(socket)}){
  fs.writeFileSync(${JSON.stringify(out)},JSON.stringify({refused:'시험 홈·소켓이 아니다'}));process.exit(3);}
fs.writeFileSync(${JSON.stringify(out + '.ready')},String(process.pid));
while(!fs.existsSync(${JSON.stringify(out + '.go')}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);
// AI 도구처럼 명령을 자기 프로세스 묶음에서 돌리고, 세션이 끊기면(SIGHUP) 그 묶음을 SIGKILL로 죽인다(실제 사례의 137).
const child=spawn(process.execPath,[${JSON.stringify(cli)},'stop',process.env.KADAN_ROLE],{env:process.env,detached:true,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
process.on('SIGHUP',()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}process.exit(129);});
child.on('close',(status,signal)=>fs.writeFileSync(${JSON.stringify(out)},JSON.stringify({status,signal,stdout,stderr,panePid:process.pid,childPid:child.pid})));
setInterval(()=>{},1000);
`);
  return {home, dir, calls, rottie, out, pane, socket, sockDir};
}

function launch(s, session, role) {
  const env = {KADAN_HOME: s.home, KADAN_SOCKET: s.socket, TMUX_TMPDIR: s.sockDir, KADAN_FLOOR: 'tmux', KADAN_WINDOW: 'none',
    KADAN_ROTTIE_BIN: s.rottie, KADAN_ROTTIE_AUTO_ATTACH: 'off', KADAN_NOTIFY: 'off', KADAN_ROLE: role};
  const cmd = `${process.execPath} ${s.pane}`;
  const created = tmuxFloor.create({session, role, cwd: s.sockDir,
    cmd: `env ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')} ${cmd}`});
  appendLedger({kind: 'start', floor: 'tmux', role, session, cwd: s.sockDir, cmd, roleProfile: 'worker', by: 'test',
    rottieTerminalId: 'tab-1', ...created});
  until(() => fs.existsSync(s.out + '.ready') || fs.existsSync(s.out), 'pane 스크립트가 떴다');
  fs.writeFileSync(s.out + '.go', 'go'); // 시작 기록을 쓴 뒤에 stop을 치게 한다
  return created;
}
const calls = s => fs.existsSync(s.calls) ? fs.readFileSync(s.calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];

test('실제 tmux: 역할이 자기 세션 안에서 kadan stop하면 세션 종료 뒤 탭 닫기·지우기·원장 기록이 끝까지 된다', {skip}, t => {
  const s = setup(t, 'selfstop');
  const session = 'kadan-selfcase', role = 'selfcase';
  const created = launch(s, session, role);
  const panePgid = ps('pgid', created.panePid);
  // 끝나기를 기다린다: 세션이 사라지고, 정리가 끝났다면 stop 기록이 생긴다.
  const paneOut = () => fs.existsSync(s.out) ? fs.readFileSync(s.out, 'utf8') : '(pane 결과 파일 없음)';
  until(() => !tmuxFloor.alive(session), () => `세션이 꺼졌다 — pane 결과: ${paneOut()}`);
  until(() => readLedger().some(e => e.kind === 'stop' && e.session === session), () => `stop 원장 기록이 생겼다 — 가짜 로티 호출 ${JSON.stringify(calls(s))}`, 8000);

  const stops = readLedger().filter(e => e.kind === 'stop' && e.session === session);
  assert.equal(stops.length, 1);
  const [stop] = stops;
  assert.equal(stop.role, role);
  assert.equal(stop.by, role, '명령을 친 쪽(KADAN_ROLE)이 by로 남는다');
  assert.ok('conversation' in stop || 'conversationMissing' in stop, '대화 번호 칸이 있다');
  assert.equal(stop.rottieTerminalId, 'tab-1');
  assert.equal(stop.rottieWindowClosed, true);
  assert.equal(stop.rottieWindowRemoved, true);
  const terminalCalls = calls(s).filter(a => a[0] === 'terminal').map(a => a[1]);
  assert.deepEqual(terminalCalls, ['show', 'close', 'remove'], '가짜 로티의 조회·닫기·지우기가 각각 한 번이다');

  const pane = JSON.parse(fs.readFileSync(s.out, 'utf8'));
  assert.equal(pane.status, 0, pane.stderr);
  assert.match(pane.stdout, /자기 세션 종료를 분리된 프로세스로 넘김\(기록: .+\)/);

  // 넘겨받은 프로세스의 근거: 끄기 직전에 pane 트리 밖이었다.
  const logPath = /기록: (.+)\)/.exec(pane.stdout)[1];
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const before = lines.filter(l => l.step === 'before-stop');
  assert.equal(before.length, 1, '끄기 직전 기록이 한 줄이다(다시 넘기지 않는다)');
  const [b] = before;
  t.diagnostic(`before-stop 근거: ${JSON.stringify(b)} / pane pgid ${panePgid} / pane pid ${created.panePid}`);
  assert.equal(String(b.panePid), String(created.panePid));
  assert.equal(b.inPaneTree, false);
  assert.notEqual(String(b.ppid), String(created.panePid), '부모가 pane 프로세스가 아니다');
  assert.ok(!b.ancestors.map(String).includes(String(created.panePid)), '조상 사슬에 pane 프로세스가 없다');
  assert.notEqual(String(b.pgid), String(panePgid), '프로세스 묶음이 pane과 다르다');
  assert.equal(lines.filter(l => l.step === 'handoff').length, 1, '넘기기는 한 번뿐이다(넘겨받은 쪽은 다시 넘기지 않는다)');
  assert.equal(lines.at(-1).step, 'done');
});

test('실제 tmux: 같은 역할 이름이 아닌 바깥 프로세스가 끄는 정상 stop은 넘기지 않고 예전처럼 끝난다', {skip}, t => {
  const s = setup(t, 'outsider');
  const session = 'kadan-outcase', role = 'outcase';
  // pane은 아무것도 하지 않는 스크립트다(자기 stop을 치지 않게 다른 역할 이름으로 시작한다).
  fs.writeFileSync(s.pane, 'setInterval(()=>{},1000);fs=require("fs");fs.writeFileSync(process.argv[2]+".ready","1");');
  const created = tmuxFloor.create({session, role, cwd: s.sockDir, cmd: `${process.execPath} ${s.pane} ${s.out}`});
  appendLedger({kind: 'start', floor: 'tmux', role, session, cwd: s.sockDir, roleProfile: 'worker', by: 'test',
    rottieTerminalId: 'tab-2', ...created});
  const run = spawnSync(process.execPath, [cli, 'stop', role], {encoding: 'utf8',
    env: {...process.env, KADAN_HOME: s.home, KADAN_FLOOR: 'tmux', KADAN_WINDOW: 'none', KADAN_ROTTIE_BIN: s.rottie,
      KADAN_ROTTIE_AUTO_ATTACH: 'off', KADAN_ROLE: 'outsider-supervisor'}});
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /종료됨: kadan-outcase/);
  assert.doesNotMatch(run.stdout, /분리된 프로세스/);
  assert.equal(tmuxFloor.alive(session), false);
  const stop = readLedger().findLast(e => e.kind === 'stop' && e.session === session);
  assert.equal(stop.by, 'outsider-supervisor');
  assert.equal(stop.rottieWindowRemoved, true);
});
