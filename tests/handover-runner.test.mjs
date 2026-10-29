import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Handover } from '../src/handover.mjs';
import { HandoverRunner } from '../src/handover-runner.mjs';
import { guardedSend } from '../src/cli.mjs';

function fixture(options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-handover-runner-'));
  const hierarchy = path.join(home, 'parents.json'), context = path.join(home, 'context.md'), receipt = path.join(home, 'receipt.json');
  fs.writeFileSync(hierarchy, JSON.stringify({old:'upper',child:'old',upper:'@user'}));
  fs.writeFileSync(context, '승인된 작업');
  const rows = ['old','child','upper'].map((role,i) =>
    ({kind:'start',role,session:`kadan-${role}`,panePid:String(i+10),floor:'tmux',cmd:'cat',cwd:home}));
  rows.push({kind:'send',role:'old',taskId:'existing-task'});
  const live = new Map(rows.filter(e=>e.kind==='start').map(e=>[`kadan-${e.role}`,e.panePid]));
  const sent = [], stopped = [], notifications = [], spawns = [];
  let clock = Date.parse('2026-09-09T00:00:00Z');
  const f = {home,hierarchy,context,receipt,rows,live,sent,stopped,notifications,spawns,options};
  const floor = {name:'tmux',alive:s=>live.has(s),pid:s=>live.get(s),
    stop:s=>{stopped.push({session:s,pid:live.get(s)});if(!options.stopFails)live.delete(s);},
    send:(s,message)=>{sent.push({session:s,message});if(options.activationFails&&message.includes('인계 전환 완료'))throw new Error('send uncertain');}};
  const h = new Handover({home,floor,env:{KADAN_ROLE:'upper',KADAN_HOME:home,PRIVATE_TOKEN:'runner-canary'},
    readEntries:()=>rows,record:e=>rows.push(e),now:()=>clock,watchAlive:()=>!options.watchDead,
    start:role=>{live.set(`kadan-${role}`,'30');rows.push({kind:'start',role,session:`kadan-${role}`,panePid:'30'});},
    send:(role,message,pid)=>guardedSend({floor,session:`kadan-${role}`,role,message,recordedPid:pid || live.get(`kadan-${role}`),
      env:{KADAN_HOME:home},readEntries:()=>rows,record:e=>rows.push(e),saveBody:()=>{}}),
    sleep:ms=>{assert.ok(!fs.existsSync(path.join(home,'handovers','.lock')) || options.busyLock);clock+=ms;f.onSleep?.(clock-Date.parse('2026-09-09T00:00:00Z'));},
  });
  const runner = new HandoverRunner(h, {
    spawnProcess:(...args)=>{spawns.push(args);const child=new EventEmitter();child.pid=process.pid;child.unref=()=>{f.unref=true;};f.child=child;return child;},
    notify:(target,message)=>{
      notifications.push({target,message});
      assert.equal(JSON.parse(fs.readFileSync(runner.paths(f.s.id).result)).notification.status,'sending');
      if(options.notifyFails){const e=new Error('delivery uncertain');e.delivery='unknown';throw e;}
      if(target.transport==='mailbox')return {status:'stored',mailId:'fixture-mail'};
      guardedSend({floor,session:`kadan-${target.role}`,role:target.role,message,recordedPid:target.pid,
        env:{KADAN_HOME:home},readEntries:()=>rows,record:e=>rows.push(e),saveBody:()=>{}});
      return {status:'sent'};
    },
  });
  Object.assign(f,{h,runner});
  f.begin = (opts={}) => {
    const config=runner.prepare('old',opts);
    f.s=h.begin('old',{to:'old-next',hierarchy,context,atBoundary:true});
    return runner.start(f.s.id,config);
  };
  f.accept = () => {
    const previous=h.env.KADAN_ROLE;h.env.KADAN_ROLE='old-next';
    fs.writeFileSync(receipt,JSON.stringify({taskIds:['existing-task'],evidencePaths:[context],nextAction:'기존 작업 확인'}));
    try { h.accept(f.s.id,receipt); } finally { h.env.KADAN_ROLE=previous; }
  };
  f.loaded = () => rows.push({kind:'hierarchy-loaded',path:hierarchy,pid:process.pid,
    hash:createHash('sha256').update(fs.readFileSync(hierarchy)).digest('hex')});
  f.flow = () => {if(h.status(f.s.id).phase==='prepared')f.accept();else f.loaded();};
  return f;
}

test('독립 runner: 정상 6분 독해를 유지하고 watch 확인 후 정확 선임만 종료, 활성화/최종통지 각 1회',()=>{
  const f=fixture();const begun=f.begin();
  assert.equal(begun.runner.status,'starting');assert.equal(begun.originalHierarchy,undefined);
  assert.equal(begun.command,undefined);assert.equal(f.stopped.length,0);
  assert.equal(f.spawns.length,1);assert.equal(f.spawns[0][1].length,2);
  assert.deepEqual(f.spawns[0][2].stdio,'ignore');assert.equal(f.spawns[0][2].detached,true);assert.ok(f.unref);
  assert.equal(JSON.stringify(fs.readFileSync(f.runner.paths(f.s.id).config,'utf8')).includes('runner-canary'),false);
  f.onSleep=elapsed=>{if(elapsed>=360000)f.flow();};
  const result=f.runner.run(f.s.id);
  assert.equal(result.status,'complete');assert.equal(result.phase,'complete');
  assert.deepEqual(f.stopped,[{session:'kadan-old',pid:'10'}]);assert.equal(f.live.get('kadan-child'),'11');
  assert.equal(f.sent.filter(x=>x.message.includes('\n\n인계 전환 완료')).length,1);
  assert.equal(f.notifications.length,1);assert.equal(result.notification.delivery,'sent');
  assert.equal(f.rows.filter(e=>e.phase==='transferred').length,1);
});

for(const stage of ['accept','watch','dead-watch']) test(`전체 대기 상한: ${stage} 미확인 시 선임/하위 보존, 실패 통지 1회`,()=>{
  const f=fixture({watchDead:stage==='dead-watch'});f.begin({waitTimeout:3});
  if(stage!=='accept')f.onSleep=()=>{if(f.h.status(f.s.id).phase==='prepared')f.accept();else if(stage==='dead-watch')f.loaded();};
  const result=f.runner.run(f.s.id);assert.equal(result.status,'timed-out');
  assert.equal(result.error.code,'HANDOVER_WAIT_TIMEOUT');assert.equal(f.stopped.length,0);
  assert.equal(f.live.get('kadan-old'),'10');assert.equal(f.live.get('kadan-child'),'11');assert.equal(f.notifications.length,1);
  if(stage==='watch'){
    f.loaded();assert.equal(f.h.finish(f.s.id,{timeout:0}).phase,'complete');
    assert.equal(f.runner.status(f.s.id).runner.status,'timed-out');assert.equal(f.notifications.length,1);
  }
});

for(const change of ['context','receipt','task','hierarchy','successor-dead','old-pid']) test(`대기 중 ${change} 변경은 선임 종료/책임 이전 없이 실패 저장`,()=>{
  const f=fixture();f.begin();let changed=false;
  f.onSleep=()=>{
    if(f.h.status(f.s.id).phase==='prepared')f.accept();
    else if(!changed){
      changed=true;f.loaded();
      if(change==='context')fs.appendFileSync(f.context,'변경');
      if(change==='receipt')fs.appendFileSync(f.receipt,' ');
      if(change==='task')f.rows.push({kind:'send',role:'old',taskId:'new-task'});
      if(change==='hierarchy')fs.appendFileSync(f.hierarchy,' ');
      if(change==='successor-dead')f.live.delete('kadan-old-next');
      if(change==='old-pid')f.live.set('kadan-old','99');
    }
  };
  const result=f.runner.run(f.s.id);assert.equal(result.status,'failed');assert.ok(result.error.message);
  assert.equal(f.stopped.length,0);assert.equal(f.rows.filter(e=>e.phase==='transferred').length,0);
  assert.equal(f.notifications.length,1);
});

test('같은 인계의 중복 launch/run은 첫 실행 파일/통지에 손대지 않는다',()=>{
  const f=fixture();f.begin();
  assert.throws(()=>f.runner.start(f.s.id,f.runner.prepare('old')),/이미 예약/);
  f.onSleep=()=>{assert.throws(()=>f.runner.run(f.s.id),/중복/);f.flow();};
  f.runner.run(f.s.id);const before=fs.readFileSync(f.runner.paths(f.s.id).result);
  assert.throws(()=>f.runner.run(f.s.id),/중복/);
  assert.deepEqual(fs.readFileSync(f.runner.paths(f.s.id).result),before);
  assert.equal(f.spawns.length,1);assert.equal(f.notifications.length,1);
});

test('인수와 finish 잠금 경합은 유한 대기하며 남은 잠금을 강제 제거하지 않는다',()=>{
  for(const release of [true,false]){
    const f=fixture({busyLock:true});f.begin({waitTimeout:4});const lock=path.join(f.home,'handovers','.lock');
    let created=false;
    f.onSleep=elapsed=>{
      if(!created){f.accept();fs.mkdirSync(lock);created=true;}
      else if(release&&elapsed===2000){assert.ok(fs.existsSync(lock));fs.renameSync(lock,`${lock}.test-preserved`);}
      else if(release)f.loaded();
    };
    assert.equal(f.runner.run(f.s.id).status,release?'complete':'timed-out');
    if(release)assert.equal(f.runner.status(f.s.id).runner.waiting,undefined);
    assert.equal(fs.existsSync(lock),!release);
    if(!release)assert.equal(f.stopped.length,0);
  }
});

test('활성화 불확실은 activation-pending으로 보존하고 자동/수동 재전송 0회',()=>{
  const f=fixture({activationFails:true});f.begin();f.onSleep=f.flow;
  const result=f.runner.run(f.s.id);assert.equal(result.status,'failed');assert.equal(result.phase,'activation-pending');
  assert.throws(()=>f.h.finish(f.s.id,{timeout:0}),/activation-pending/);
  assert.throws(()=>f.runner.run(f.s.id),/중복/);
  assert.equal(f.sent.filter(x=>x.message.includes('\n\n인계 전환 완료')).length,1);assert.equal(f.notifications.length,1);
});

test('책임 이전 후 종료 실패는 거짓완료 없이 종료; 명시 수동 finish만 복구한다',()=>{
  const f=fixture({stopFails:true});f.begin();f.onSleep=f.flow;
  const result=f.runner.run(f.s.id);assert.equal(result.status,'failed');assert.equal(result.phase,'transferred');
  assert.equal(f.stopped.length,1);assert.equal(f.live.get('kadan-old'),'10');
  f.options.stopFails=false;assert.equal(f.h.finish(f.s.id,{timeout:0}).phase,'complete');
  assert.equal(f.runner.status(f.s.id).runner.status,'failed');assert.equal(f.notifications.length,1);
});

test('최종통지 불확실은 송신 전에 저장한 시도 1회로 끝내고 재전송하지 않는다',()=>{
  const f=fixture({notifyFails:true});f.begin();f.onSleep=f.flow;
  const result=f.runner.run(f.s.id);assert.equal(result.status,'complete');
  assert.equal(result.notification.status,'failed');assert.equal(result.notification.delivery,'unknown');
  assert.throws(()=>f.runner.run(f.s.id),/중복/);assert.equal(f.notifications.length,1);
});

test('최종 수신자의 같은 이름 새 PID에는 보내지 않고 실패를 저장한다',()=>{
  const f=fixture();f.begin();f.live.set('kadan-upper','100');
  f.rows.push({kind:'start',role:'upper',panePid:'100'});f.onSleep=f.flow;
  const result=f.runner.run(f.s.id);assert.equal(result.status,'complete');
  assert.equal(result.notification.pid,'12');assert.equal(result.notification.delivery,'not-sent');
  assert.equal(result.notification.error.code,'KADAN_PID_MISMATCH');
  assert.equal(f.sent.filter(x=>x.session==='kadan-upper').length,0);
});

test('사람은 가상 비서 우편, 명시 notify는 지정 PID; 선임 자기종료/잘못된 상한은 생성 전 거절',()=>{
  const f=fixture();f.h.env.KADAN_ROLE='';assert.equal(f.runner.prepare('old').target.transport,'mailbox');
  f.h.env.KADAN_ROLE='old';assert.throws(()=>f.runner.prepare('old',{notify:'upper'}),/자기 종료/);
  f.h.env.KADAN_ROLE='upper';
  for(const waitTimeout of [0,-1,NaN,Infinity,true])assert.throws(()=>f.runner.prepare('old',{waitTimeout}),/wait-timeout/);
  assert.equal(f.spawns.length,0);f.begin({notify:'child'});f.onSleep=f.flow;
  const result=f.runner.run(f.s.id);assert.equal(result.notification.recipient,'child');assert.equal(result.notification.pid,'11');
});

test('spawn error는 동기 main을 기다리게 하지 않고 실패 파일/통지 1회로 종결한다',()=>{
  const f=fixture();f.runner.spawnProcess=()=>{const child=new EventEmitter();f.child=child;return child;};
  assert.throws(()=>f.begin(),/runner 시작 실패/);
  f.child.emit('error',new Error('late spawn failure'));
  const result=f.runner.status(f.s.id).runner;assert.equal(result.status,'failed');
  assert.equal(result.failureStage,'launch');
  assert.equal(f.notifications.length,1);assert.equal(f.stopped.length,0);
  const file=f.runner.paths(f.s.id).result,before=fs.readFileSync(file);
  const duplicate=spawnSync(process.execPath,[new URL('../src/handover-runner.mjs',import.meta.url).pathname,f.s.id],
    {env:{PATH:process.env.PATH,HOME:process.env.HOME,KADAN_HOME:f.home,KADAN_SOCKET:path.basename(f.home),KADAN_WINDOW:'none',KADAN_FLOOR:'tmux'},encoding:'utf8'});
  assert.equal(duplicate.status,1);assert.deepEqual(fs.readFileSync(file),before);
});

test('독립 프로세스의 import 실패는 시작 실패와 구분하고 통지 미시도를 영속한다',()=>{
  const f=fixture();f.begin();
  const file=path.join(f.home,'handover-runner.mjs');
  fs.copyFileSync(new URL('../src/handover-runner.mjs',import.meta.url),file);
  const r=spawnSync(process.execPath,[file,f.s.id],{env:{PATH:process.env.PATH,KADAN_HOME:f.home},encoding:'utf8'});
  assert.equal(r.status,1);assert.equal(r.stdout,'');assert.equal(r.stderr,'');
  const result=f.runner.status(f.s.id).runner;assert.equal(result.failureStage,'bootstrap-import');
  assert.equal(result.notification.status,'not-attempted');assert.equal(f.notifications.length,0);assert.equal(f.stopped.length,0);
  const resultFile=f.runner.paths(f.s.id).result,before=fs.readFileSync(resultFile);
  assert.equal(spawnSync(process.execPath,[file,f.s.id],{env:{PATH:process.env.PATH,KADAN_HOME:f.home},encoding:'utf8'}).status,1);
  assert.deepEqual(fs.readFileSync(resultFile),before);
});

test('수동 abort를 관찰한 runner는 선임/후임 보존과 종결통지 뒤 멈춘다',()=>{
  const f=fixture();f.begin();f.onSleep=()=>f.h.abort(f.s.id);
  assert.equal(f.runner.run(f.s.id).status,'aborted');assert.equal(f.stopped.length,0);assert.equal(f.notifications.length,1);
});
