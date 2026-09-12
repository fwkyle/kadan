import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { appendLedger, readLedger, readMailBody } from '../src/ledger.mjs';
import { createDatabase, writeStorageMarker } from '../src/storage.mjs';

for (const profileSource of ['start','roles']) test(`09-07 실제 CLI 인계: ${profileSource} 프로필 승계와 이름 접두사가 겹치는 후임 보존`, {skip:spawnSync('tmux',['-V']).status!==0}, ()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-handover-cli-test-'));
 const cli=new URL('../src/cli.mjs',import.meta.url).pathname;
 const env={...process.env,KADAN_HOME:home,KADAN_SOCKET:path.basename(home),KADAN_WINDOW:'none',KADAN_FLOOR:'tmux',KADAN_ROLE:'비서'};
 const run=(args,role='비서')=>{
  const r=spawnSync(process.execPath,[cli,...args],{env:{...env,KADAN_ROLE:role},cwd:home,encoding:'utf8'});
  assert.equal(r.status,0,r.stderr+r.stdout);return r.stdout;
 };
 const graph=path.join(home,'parents.json'),context=path.join(home,'context.md'),receipt=path.join(home,'receipt.json');
 fs.writeFileSync(graph,JSON.stringify({'qa-감독':'@user'}));fs.writeFileSync(context,'격리 시험 범위');
 try {
  run(['start','qa-감독','--cmd','cat',...(profileSource==='start'?['--profile','conductor']:[])]);
  // 이미 시작한 legacy 선임에 정확한 role 매핑만 추가된 경우도 승계한다.
  fs.writeFileSync(path.join(home,'role-instructions.json'),JSON.stringify({version:1,roles:{'qa-감독':profileSource==='start'?'worker':'conductor','qa-감독-2':'reviewer'}}));
  assert.equal(readLedger(home).filter(e=>e.kind==='start'&&e.role==='qa-감독').at(-1).roleProfile,profileSource==='start'?'conductor':undefined);
  const s=JSON.parse(run(['handover','qa-감독','--manual','--to','qa-감독-2','--at-boundary','--hierarchy',graph,'--context',context,'--cwd',home,'--cmd','cat']));
  assert.equal(s.runner,null);
  assert.equal(s.roleProfile,'conductor');
  assert.equal(readLedger(home).filter(e=>e.kind==='start'&&e.role===s.to).at(-1).roleProfile,'conductor');
  const prepared=readLedger(home).filter(e=>e.kind==='send'&&e.role===s.to).at(-1);
  assert.equal(prepared.roleProfile,'conductor');assert.ok(readMailBody(prepared.digest,home).startsWith('인수 준비:'));
  assert.match(readMailBody(prepared.digest,home),/전환 완료 전 새 작업 금지/);
  assert.equal(spawnSync('tmux',['-L',env.KADAN_SOCKET,'has-session','-t','=kadan-qa-감독']).status,0);
  fs.writeFileSync(path.join(home,'profile-inheritance.json'),JSON.stringify({profileSource,state:s,prepared,body:readMailBody(prepared.digest,home)},null,2));
  console.log(`교대 프로필 승계 증거: ${home}/profile-inheritance.json`);
  fs.writeFileSync(receipt,JSON.stringify({taskIds:[],evidencePaths:[context],nextAction:'시험 종료'}));
  run(['handover','accept',s.id,'--receipt',receipt],s.to);
  assert.equal(JSON.parse(run(['handover','finish',s.id,'--timeout','0'])).phase,'routes-pending');
  // watch 재로딩은 별도 시험. 여기서는 승인 신호만 격리 원장에 모의 입력한다.
  appendLedger({kind:'hierarchy-loaded',path:graph,hash:createHash('sha256').update(fs.readFileSync(graph)).digest('hex'),pid:process.pid},home);
  assert.equal(JSON.parse(run(['handover','finish',s.id,'--timeout','0'])).phase,'complete');
  assert.match(run(['read',s.to,'--lines','200']),/kadan:receiver-instructions/);
  // 긴 첨부 앞 원문은 현재 화면 밖에 있으므로 실제 수신 화면 기록까지 확인한다.
  const captured=spawnSync('tmux',['-L',env.KADAN_SOCKET,'capture-pane','-p','-J','-S','-2000','-t',`=kadan-${s.to}:`],{encoding:'utf8'});
  assert.equal(captured.status,0,captured.stderr);assert.match(captured.stdout,/인계 전환 완료/);
  assert.equal(spawnSync('tmux',['-L',env.KADAN_SOCKET,'has-session','-t','=kadan-qa-감독']).status,1);
  assert.equal(spawnSync('tmux',['-L',env.KADAN_SOCKET,'has-session','-t','=kadan-qa-감독-2']).status,0);
 } finally {
  for(const role of ['qa-감독','qa-감독-2'])spawnSync(process.execPath,[cli,'stop',role],{env,cwd:home,encoding:'utf8'});
 }
});

const hasTmux=spawnSync('tmux',['-V']).status===0;
const cli=new URL('../src/cli.mjs',import.meta.url).pathname;
const runnerFile=new URL('../src/handover-runner.mjs',import.meta.url).pathname;
const isAlive=pid=>{try{process.kill(Number(pid),0);return true;}catch{return false;}};
async function until(check, timeout=12000) {
 const end=Date.now()+timeout;
 while(Date.now()<end){const value=check();if(value)return value;await delay(50);}
 throw new Error('격리 CLI 시험 대기 상한 도달');
}
function backgroundFixture({human=false,sqlite=false}={}) {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-handover-background-'));
 if(sqlite&&Number(process.versions.node.split('.')[0])>=24){createDatabase(home);writeStorageMarker(home,'sqlite');}
 const env={PATH:process.env.PATH,HOME:process.env.HOME,LANG:'en_US.UTF-8',
  KADAN_HOME:home,KADAN_SOCKET:path.basename(home),KADAN_WINDOW:'none',KADAN_FLOOR:'tmux',KADAN_ROLE:human?'':'qa-상위'};
 const graph=path.join(home,'parents.json'),context=path.join(home,'context.md'),receipt=path.join(home,'receipt.json');
 fs.writeFileSync(graph,JSON.stringify({'qa-감독':'qa-상위','qa-작업자':'qa-감독','qa-상위':'@user'}));
 fs.writeFileSync(context,'격리 CLI 시험만 승인');
 const roles=['qa-감독','qa-작업자',...(!human?['qa-상위']:[])];
 const raw=(args,role=env.KADAN_ROLE)=>spawnSync(process.execPath,[cli,...args],{cwd:home,env:{...env,KADAN_ROLE:role},encoding:'utf8',timeout:8000});
 const run=(args,role)=>{const r=raw(args,role);assert.equal(r.status,0,r.stderr+r.stdout);return r.stdout;};
 const beginArgs=['handover','qa-감독','--to','qa-감독-2','--at-boundary','--hierarchy',graph,'--context',context,'--cwd',home,'--cmd','cat'];
 const pid=role=>spawnSync('tmux',['-L',env.KADAN_SOCKET,'display-message','-p','-t',`=kadan-${role}:`,'#{pane_pid}'],{encoding:'utf8'}).stdout.trim();
 const f={home,env,graph,context,receipt,roles,raw,run,beginArgs,pid};
 f.begin=extra=>{
  const started=Date.now(),invocation=raw([...beginArgs,...extra]);
  assert.equal(invocation.status,0,invocation.stderr+invocation.stdout);
  f.s=JSON.parse(invocation.stdout);f.elapsed=Date.now()-started;f.parentPid=invocation.pid;
  return f.s;
 };
 f.result=()=>JSON.parse(fs.readFileSync(f.s.runner.resultPath));
 f.accept=()=>{
  fs.writeFileSync(receipt,JSON.stringify({taskIds:[],evidencePaths:[context],nextAction:'격리 시험 결과 확인'}));
  run(['handover','accept',f.s.id,'--receipt',receipt],'qa-감독-2');
 };
 f.cleanup=()=>{
  if(f.watch?.exitCode===null)f.watch.kill('SIGTERM');
  if(f.s?.runner.pid){
   const command=spawnSync('ps',['-p',String(f.s.runner.pid),'-o','command='],{encoding:'utf8'}).stdout;
   if(command.includes(runnerFile)&&command.includes(f.s.id))process.kill(f.s.runner.pid,'SIGTERM');
  }
  for(const role of [...roles,'qa-감독-2'])spawnSync('tmux',['-L',env.KADAN_SOCKET,'kill-session','-t',`=kadan-${role}`],{encoding:'utf8'});
 };
 return f;
}

function startIsolatedWatch(f) {
 // 실제 runWatch의 파일 재로딩/원장 기록을 사용한다. 전역 watch 조회, 자원 경고,
 // 사용자 OS 알림은 이 시험의 대상이 아니므로 주입 경계에서 차단한다. AI 호출 없음.
 const helper=path.join(f.home,'watch-fixture.mjs');
 fs.writeFileSync(helper,`
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {runWatch} from ${JSON.stringify(new URL('../src/watch-runner.mjs',import.meta.url).href)};
import {tmuxFloor} from ${JSON.stringify(new URL('../src/floor-tmux.mjs',import.meta.url).href)};
import {readLedger,appendLedger} from ${JSON.stringify(new URL('../src/ledger.mjs',import.meta.url).href)};
import {parseHierarchy} from ${JSON.stringify(new URL('../src/hierarchy.mjs',import.meta.url).href)};
const graph=${JSON.stringify(f.graph)};
runWatch({floor:tmuxFloor,readEntries:()=>readLedger(),readCards:()=>[],readWorks:()=>[],
 record:e=>appendLedger(e),sendAlert:()=>{throw new Error('unexpected alert');},print:()=>{},
 intervalMs:100,stallN:9999,routes:{},superRole:null,
 loadHierarchy:()=>{const text=fs.readFileSync(graph,'utf8');return {path:graph,hash:createHash('sha256').update(text).digest('hex'),parents:parseHierarchy(JSON.parse(text))};},
 spawn:(cmd)=>{
  if(cmd==='sleep'){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);return {status:0};}
  if(cmd==='ps')return {status:0,stdout:''};
  if(cmd==='memory_pressure')return {status:0,stdout:'System-wide memory free percentage: 80%'};
  if(cmd==='sysctl')return {status:0,stdout:'used = 0M'};
  throw new Error('unexpected external command');
 }
});
`);
 const log=fs.openSync(path.join(f.home,'watch-fixture.log'),'a',0o600);
 try { f.watch=spawn(process.execPath,[helper],{env:f.env,cwd:f.home,stdio:['ignore',log,log]}); }
 finally {fs.closeSync(log);}
 return f.watch;
}

test('독립 CLI 한 사이클: 부모 종료→지연 accept→실제 watch 기록→정확 선임 종료/하위 보존/활성화와 최종통지 1회', {skip:!hasTmux,timeout:25000},async t=>{
 const f=backgroundFixture({sqlite:true});
 try {
  for(const role of f.roles)f.run(['start',role,'--cmd','cat']);
  const oldPid=f.pid('qa-감독'),childPid=f.pid('qa-작업자');const s=f.begin([]);
  assert.ok(f.elapsed<5000,`begin ${f.elapsed}ms`);assert.ok(s.runner.pid);assert.notEqual(s.runner.pid,f.parentPid);
  assert.ok(!isAlive(f.parentPid));
  await until(()=>f.result().status==='waiting-accept');
  assert.equal(isAlive(s.runner.pid),true);assert.equal(f.pid('qa-감독'),oldPid);
  assert.equal(Date.parse(f.result().deadlineAt)-Date.parse(f.result().startedAt),1800000);
  assert.equal(fs.existsSync(path.join(f.home,'handovers','.lock')),false);
  const duplicate=spawnSync(process.execPath,[runnerFile,s.id],{env:f.env,cwd:f.home,encoding:'utf8',timeout:4000});
  assert.equal(duplicate.status,1);
  f.accept();
  await until(()=>JSON.parse(fs.readFileSync(s.statePath)).phase==='routes-pending');
  assert.equal(f.pid('qa-감독'),oldPid);assert.equal(f.pid('qa-작업자'),childPid);
  startIsolatedWatch(f);
  await until(()=>f.result().notification?.delivery==='sent');
  const result=f.result();assert.equal(result.status,'complete');assert.equal(result.notification.recipient,'qa-상위');
  assert.equal(result.notification.pid,s.runner.notification.pid??f.pid('qa-상위'));
  const rows=readLedger(f.home),mails=rows.filter(e=>e.kind==='send').map(e=>({...e,body:readMailBody(e.digest,f.home)}));
  assert.equal(rows.filter(e=>e.kind==='handover'&&e.phase==='transferred').length,1);
  assert.equal(rows.filter(e=>e.kind==='stop'&&e.role==='qa-감독').length,1);
  assert.ok(rows.some(e=>e.kind==='hierarchy-loaded'&&e.pid===f.watch.pid&&e.hash===JSON.parse(fs.readFileSync(s.statePath)).routesHash));
  assert.equal(mails.filter(e=>e.body?.startsWith('인계 전환 완료')).length,1);
  assert.equal(mails.filter(e=>e.body?.startsWith('인계 프로그램 종결')).length,1);
  assert.equal(f.pid('qa-감독'),'');assert.equal(f.pid('qa-작업자'),childPid);assert.ok(f.pid('qa-감독-2'));
  f.run(['handover','finish',s.id,'--timeout','0']);
  assert.equal(readLedger(f.home).filter(e=>e.kind==='send').length,rows.filter(e=>e.kind==='send').length);
  const status=JSON.parse(f.run(['handover','status',s.id]));assert.equal(status.originalHierarchy,undefined);assert.equal(status.runner.resultPath,s.runner.resultPath);
  t.diagnostic(`home=${f.home}; begin=${f.elapsed}ms; parent=${f.parentPid}; runner=${s.runner.pid}; transfer/stop/activation/notification=1/1/1/1`);
 } finally {f.cleanup();}
});

test('사람 CLI는 상한 뒤 기존 비서 우편 1건을 보관하고 가상 비서 역할을 생성하지 않는다', {skip:!hasTmux,timeout:15000},async t=>{
 const f=backgroundFixture({human:true});
 try {
  for(const role of f.roles)f.run(['start',role,'--cmd','cat']);
  const oldPid=f.pid('qa-감독');f.begin(['--wait-timeout','3']);
  await until(()=>f.result().notification?.delivery==='sent');
  const result=f.result();assert.equal(result.status,'timed-out');assert.equal(result.notification.status,'stored');
  assert.equal(f.pid('qa-감독'),oldPid);
  const rows=readLedger(f.home);
  assert.equal(rows.filter(e=>e.transport==='mailbox'&&e.role==='비서').length,1);
  assert.equal(rows.filter(e=>e.kind==='start'&&e.role==='비서').length,0);
  assert.equal(f.raw(['handover','finish',f.s.id,'--wait-timeout','1']).status,1);
  assert.equal(f.raw([...f.beginArgs,'--timeout','90']).status,1);
  t.diagnostic(`home=${f.home}; timeout=${result.status}; secretary-mail=1; source-preserved=true`);
 } finally {f.cleanup();}
});

test('CLI 수신자 세대 변경과 명시 notify: 새 PID로 자동 우회 없이 통지 실패 보관', {skip:!hasTmux,timeout:15000},async t=>{
 const f=backgroundFixture();
 try {
  for(const role of f.roles)f.run(['start',role,'--cmd','cat']);
  const previous=f.pid('qa-상위');f.begin(['--wait-timeout','3','--notify','qa-상위']);
  f.run(['stop','qa-상위']);f.run(['start','qa-상위','--cmd','cat']);assert.notEqual(f.pid('qa-상위'),previous);
  await until(()=>f.result().notification?.status==='failed');
  const result=f.result();assert.equal(result.notification.pid,previous);assert.equal(result.notification.delivery,'not-sent');
  assert.equal(result.notification.error.code,'KADAN_PID_MISMATCH');
  assert.equal(readLedger(f.home).filter(e=>e.kind==='send'&&e.role==='qa-상위').length,0);
  t.diagnostic(`home=${f.home}; recipient-generation-mismatch=not-sent; fallback=0`);
 } finally {f.cleanup();}
});

test('CLI runner 중단은 status에 드러나며 자동 재실행 없이 수동 abort를 유지한다', {skip:!hasTmux,timeout:15000},async t=>{
 const f=backgroundFixture();
 try {
  for(const role of f.roles)f.run(['start',role,'--cmd','cat']);
  const denied=f.raw(f.beginArgs,'qa-감독');assert.equal(denied.status,1);assert.match(denied.stderr,/자기 종료/);
  assert.equal(f.pid('qa-감독-2'),'');
  f.begin(['--wait-timeout','10']);await until(()=>f.result().status==='waiting-accept');
  process.kill(f.s.runner.pid,'SIGTERM');await until(()=>!isAlive(f.s.runner.pid));
  const status=JSON.parse(f.run(['handover','status',f.s.id]));assert.equal(status.runner.status,'interrupted');
  const before=fs.readFileSync(f.s.runner.resultPath);
  const duplicate=spawnSync(process.execPath,[runnerFile,f.s.id],{env:f.env,cwd:f.home,encoding:'utf8'});
  assert.equal(duplicate.status,1);assert.deepEqual(fs.readFileSync(f.s.runner.resultPath),before);
  assert.equal(JSON.parse(f.run(['handover','abort',f.s.id])).phase,'aborted');
  assert.ok(f.pid('qa-감독'));assert.ok(f.pid('qa-감독-2'));
  assert.equal(readLedger(f.home).filter(e=>e.kind==='send'&&e.role==='qa-상위').length,0);
  t.diagnostic(`home=${f.home}; interrupted=true; duplicate-send=0; manual-abort=aborted`);
 } finally {f.cleanup();}
});

test('자동 시작 stdout만 수신자와 응답종료 안내를 담고 status/실패 결과에는 안내를 넣지 않는다', {skip:!hasTmux,timeout:15000},async t=>{
 const f=backgroundFixture();
 try {
  for(const role of f.roles)f.run(['start',role,'--cmd','cat']);
  const recipientPid=f.pid('qa-상위'),s=f.begin(['--wait-timeout','3']);
  assert.deepEqual(s.runner.notification,{status:'not-attempted',recipient:'qa-상위',pid:recipientPid});
  assert.equal(s.nextAction,'별도 프로그램이 후임 인수와 전환을 이어갑니다. 상태를 반복 조회하지 말고 응답을 끝내세요. 완료/문제는 지정 수신자에게 1회 통지됩니다.');
  assert.equal(f.result().notification.recipient,'qa-상위');assert.equal(f.result().notification.pid,recipientPid);
  assert.equal(f.result().nextAction,undefined);
  assert.equal(JSON.parse(f.run(['handover','status',s.id])).nextAction,undefined);
  await until(()=>f.result().notification?.delivery==='sent');
  const status=JSON.parse(f.run(['handover','status',s.id]));
  assert.equal(status.runner.status,'timed-out');assert.equal(status.nextAction,undefined);
  assert.equal(status.runner.nextAction,undefined);assert.equal(f.result().nextAction,undefined);
  t.diagnostic(`home=${f.home}; start-nextAction=1; status/failure-nextAction=0; recipient-pid=${recipientPid}`);
 } finally {f.cleanup();}
});
