// Why: 이름만 같은 다른 프로세스에 본문·Enter를 넣거나 종료하지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {guardedSend} from '../src/cli-guarded-send.mjs';
import {sendTmux} from '../src/floor-tmux.mjs';
import {floor} from '../src/floor.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {cmdStop} from '../src/commands/stop.mjs';
import {cmdStart} from '../src/commands/start.mjs';
import {cmdMail} from '../src/commands/send.mjs';
import {readLedger} from '../src/ledger.mjs';
import {runUp} from '../src/quickstart.mjs';
import {clearForUp, readReviveState} from '../src/revive.mjs';
import {sessionOwner, assertSessionOwner} from '../src/session-ownership.mjs';

const start = (role='audit-a', pid='11') =>
  ({kind:'start', role, session:'kadan-audit-a', panePid:pid});

for (const [name, entries, code] of [
  ['기록 없음', [], 'KADAN_PID_MISSING'],
  ['PID 불일치', [start('audit-a','22')], 'KADAN_PID_MISMATCH'],
  ['원본 역할 충돌', [start('audit/a')], 'KADAN_ROLE_COLLISION'],
  ['종료 뒤 옛 PID', [start(), {kind:'stop',session:'kadan-audit-a'}], 'KADAN_PID_MISSING'],
]) test(`일반 우편 소유 검사: ${name}`, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(),'ownership-mail-'));
  let sends=0;
  assert.throws(() => guardedSend({
    floor:{name:'tmux',alive:()=>true,pid:()=> '11',send:()=> { sends++; }},
    session:'kadan-audit-a',role:'audit-a',message:'본문',omitInstructions:true,
    env:{KADAN_HOME:home},readEntries:()=>entries,record:()=>{},saveBody:()=>{},
  }), e => e.code === code && e.delivery === 'not-sent');
  assert.equal(sends,0);
});

test('일치하는 일반 우편·감시 알림 모두 바닥에 기대 PID를 전달한다', () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'ownership-ok-'));
  for (const omitInstructions of [false,true]) {
    let options;
    guardedSend({floor:{name:'tmux',alive:()=>true,pid:()=> '11',send:(_s,_m,o)=> { options=o; }},
      session:'kadan-audit-a',role:'audit-a',message:'본문',omitInstructions,
      env:{KADAN_HOME:home},readEntries:()=>[start()],record:()=>{},saveBody:()=>{}});
    assert.equal(options.expectedPid,'11');
  }
});

for (const role of ['watch','대시보드','디코','비서']) {
  test(`기반 stop → 수동 up 준비: ${role}, revive 뒤 낡은 PID`, () => {
    const previousHome=process.env.KADAN_HOME;
    const saved={alive:floor.alive,pid:floor.pid,stop:floor.stop};
    const home=fs.mkdtempSync(path.join(os.tmpdir(),'ownership-infra-'));
    process.env.KADAN_HOME=home;
    const session=`kadan-${role}`;
    appendLedger({kind:'start',role,session,panePid:'22'},home);
    appendLedger({kind:'revive',target:role,result:'started'},home);
    let stopped=0;
    floor.alive=()=>true; floor.pid=()=> '11'; floor.stop=()=> { stopped++; };
    try {
      cmdStop([role]);
      assert.equal(stopped,1);
      assert.equal(readReviveState(home).targets[role].state,'stopped');
      clearForUp(home);
      assert.deepEqual(readReviveState(home).targets,{});
    } finally {
      Object.assign(floor,saved);
      if (previousHome === undefined) delete process.env.KADAN_HOME;
      else process.env.KADAN_HOME=previousHome;
    }
  });
}

test('기반 예외는 stop에만 적용하고 최신 start PID가 있는 비서는 엄격하게 검사한다', () => {
  for (const role of ['watch','대시보드','디코','비서']) {
    const session=`kadan-${role}`;
    const missing=sessionOwner([{kind:'start',role,session}],session,role);
    assert.equal(assertSessionOwner(missing,'11',{infrastructure:true}),null);
    assert.throws(()=>assertSessionOwner(missing,'11'),e=>e.code==='KADAN_PID_MISSING');
    const current=sessionOwner([{kind:'revive',target:role,result:'started'},
      {kind:'start',role,session,panePid:'22'}],session,role);
    assert.throws(()=>assertSessionOwner(current,'11',{infrastructure:true}),
      e=>e.code==='KADAN_PID_MISMATCH');
  }
});

test('실제 start·mail 입구에서 역할명 충돌을 거절하고 PID 없는 알려진 역할의 우편은 보관한다', () => {
  const previousHome=process.env.KADAN_HOME, previousExit=process.exit;
  const saved={alive:floor.alive,pid:floor.pid,send:floor.send};
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'ownership-cli-'));
  process.env.KADAN_HOME=home;
  process.exit=code=> { throw new Error(`exit ${code}`); };
  let sends=0;
  floor.alive=()=>true; floor.pid=()=> '11'; floor.send=()=> { sends++; };
  try {
    appendLedger(start('audit/a'),home);
    assert.throws(()=>cmdStart(['audit-a'],{hidden:true,'no-prompt':true}));
    assert.throws(()=>cmdMail(['audit-a','본문'],{}));
    assert.equal(readLedger(home).filter(e=>e.kind==='send').length,0);
    appendLedger({kind:'start',role:'known',session:'kadan-known'},home);
    cmdMail(['known','보관할 본문'],{});
    assert.equal(readLedger(home).filter(e=>e.kind==='send' && e.transport==='mailbox').length,1);
    assert.equal(sends,0);
  } finally {
    Object.assign(floor,saved); process.exit=previousExit;
    if (previousHome === undefined) delete process.env.KADAN_HOME;
    else process.env.KADAN_HOME=previousHome;
  }
});

test('up은 종료된 대시보드를 명령으로 만들고 감시기 시작 경로를 이어간다', () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'ownership-up-'));
  const starts=[];
  const result=runUp({home,flags:{cmd:'sh',hidden:true,'no-prompt':true},
    floor:{alive:session=>session==='kadan-비서',attach:()=> 'fake attach'},
    sessionName:role=>`kadan-${role}`,
    cliPath:'/fixture/cli.mjs',start:(args,flags)=>starts.push({args,flags}),
    startWatch:()=> 'started',log:()=>{}});
  assert.equal(result.dashboard,'started');
  assert.equal(result.watch,'started');
  assert.deepEqual(starts.map(s=>s.args),[['대시보드']]);
  assert.match(starts[0].flags.cmd,/dashboard --port 8790/);
});

for (const change of ['none','load','sleep']) test(`일반 우편 바닥 PID 경합: ${change}`, () => {
  let pid='11'; const calls=[];
  const options = {expectedPid:'11',
    run(args) {
      calls.push(args);
      if (args.includes('#{pane_pid}|#{pane_dead}')) return `${pid}|0`;
      if (args.includes('#{pane_in_mode}')) return '0';
      if (args[0] === 'load-buffer' && change === 'load') pid='22';
      return '';
    },
    spawn() { if (change === 'sleep') pid='22'; return {status:0}; },
  };
  if (change === 'none') sendTmux('kadan-audit-a','본문',options);
  else assert.throws(() => sendTmux('kadan-audit-a','본문',options), e =>
    e.code === 'KADAN_PID_MISMATCH' && e.delivery === (change === 'load' ? 'not-sent' : 'unknown'));
  assert.equal(calls.filter(a=>a[0]==='paste-buffer').length,change === 'load' ? 0 : 1);
  assert.equal(calls.filter(a=>a[0]==='send-keys').length,change === 'none' ? 1 : 0);
});

for (const [name, entries, allowed] of [
  ['기록 없음', [], false], ['일치', [start()], true],
  ['불일치', [start('audit-a','22')], false], ['이름 충돌', [start('audit/a')], false],
]) test(`실제 stop 명령: ${name}`, () => {
  const previousHome=process.env.KADAN_HOME, previousExit=process.exit;
  const saved={alive:floor.alive,pid:floor.pid,stop:floor.stop};
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'ownership-stop-'));
  process.env.KADAN_HOME=home;
  for (const e of entries) appendLedger(e,home);
  let stopped=0;
  floor.alive=()=>true; floor.pid=()=> '11'; floor.stop=()=> { stopped++; };
  process.exit=code=> { throw new Error(`exit ${code}`); };
  try {
    if (allowed) cmdStop(['audit-a']);
    else assert.throws(()=>cmdStop(['audit-a']));
    assert.equal(stopped,allowed ? 1 : 0);
  } finally {
    Object.assign(floor,saved); process.exit=previousExit;
    if (previousHome === undefined) delete process.env.KADAN_HOME;
    else process.env.KADAN_HOME=previousHome;
  }
});
