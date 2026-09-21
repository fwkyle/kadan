import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createDatabase,writeStorageMarker} from '../src/storage.mjs';
import {readLedger} from '../src/ledger.mjs';
import {CardStore} from '../src/card-store.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {inferDispatchTask,resolveWorkMail} from '../src/work-mail.mjs';
import {buildWatchScope} from '../src/watch-scope.mjs';

const cli=new URL('../src/cli.mjs',import.meta.url).pathname;
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
const rally={rallyId:'rally',rallyTitle:'묶음',rallyRound:'1',rallyStep:'implementation'};

function fixture(){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-exec-link-'));
 createDatabase(home);writeStorageMarker(home,'sqlite');
 const store=new CardStore(home);
 const assign=(key,role='p-worker')=>store.update(key,{status:'assigned',role,board:'p',scope:'시험 범위',...rally},{revision:1,note:'배정'});
 return {home,store,assign};
}

test('inferDispatchTask는 수신 역할의 발령 카드만 추론한다',()=>{
 const {home,store,assign}=fixture();
 const c=store.create({repo:'r',id:'card-a',repoPath:home,body:'# 지시'});
 assign(c.key,'p-worker');
 assert.equal(inferDispatchTask(home,{executionKey:c.key,role:'p-worker'}),'card-a');
 // 답장 표시가 있으면 연결 우편이므로 추론하지 않는다
 assert.equal(inferDispatchTask(home,{executionKey:c.key,role:'p-worker',replyTo:'mail-1'}),null);
 // 다른 담당의 실행, 미발령 카드, 없는 주소, 수신 역할 누락은 추론하지 않는다
 assert.equal(inferDispatchTask(home,{executionKey:c.key,role:'other'}),null);
 const draft=store.create({repo:'r',id:'card-b',repoPath:home,body:'# 초안'});
 assert.equal(inferDispatchTask(home,{executionKey:draft.key,role:'p-worker'}),null);
 assert.equal(inferDispatchTask(home,{executionKey:'r/missing',role:'p-worker'}),null);
 assert.equal(inferDispatchTask(home,{executionKey:c.key}),null);
 assert.equal(inferDispatchTask(home,{role:'p-worker'}),null);
});

test('send --execution만 쓴 발령은 taskId로 기록되고 감시 범위에 들어간다',{skip:spawnSync('tmux',['-V']).status!==0},()=>{
 const {home,store,assign}=fixture();
 const socket=path.basename(home),env={...process.env,KADAN_HOME:home,KADAN_SOCKET:socket,KADAN_WINDOW:'none',KADAN_FLOOR:'tmux',KADAN_ROLE:''};
 const call=(...args)=>spawnSync(process.execPath,[cli,...args],{env,cwd:home,encoding:'utf8',timeout:10000});
 const run=(...args)=>{const r=call(...args);assert.equal(r.status,0,r.stderr);return r;};
 const receiver=path.join(home,'receiver.mjs');
 fs.writeFileSync(receiver,"import fs from 'node:fs';import path from 'node:path';process.stdin.on('data',b=>fs.appendFileSync(path.join(process.env.KADAN_HOME,process.env.KADAN_ROLE+'.received'),b));\n");
 run('start','p-worker','--hidden','--cmd',`${quote(process.execPath)} ${quote(receiver)}`);
 const mine=store.create({repo:'r',id:'card-x',repoPath:home,body:'# 지시'});assign(mine.key,'p-worker');
 const other=store.create({repo:'r',id:'card-y',repoPath:home,body:'# 지시'});assign(other.key,'q-worker');
 const sends=()=>readLedger(home).filter(e=>e.kind==='send'&&e.transport!=='mailbox');
 try{
  // 재현 조합: --task 없이 --execution만 — 수신 역할의 발령 카드이므로 taskId로 기록한다
  const incident=call('send','p-worker','--execution',mine.key,'카드 지시를 확인하고 수행하라');
  assert.equal(incident.status,0,incident.stderr);
  assert.match(incident.stderr,/발령 카드/);
  const first=sends().at(-1);
  assert.equal(first.taskId,'card-x');assert.equal(first.executionKey,'r/card-x');assert.ok(first.mailId);
  assert.ok(buildWatchScope(store.list(),readLedger(home)).sessions.has('kadan-p-worker'),'감시 범위에 수신 역할 포함');
  // 정상 발령 --task도 같은 연결을 기록한다
  run('send','p-worker','--task','card-x','두 번째 지시');
  const second=sends().at(-1);
  assert.equal(second.taskId,'card-x');assert.equal(second.executionKey,'r/card-x');
  // 충돌: --task와 --execution이 다른 카드 — 전송 전 실패, 부분 우편·부분 원장 없음
  const count=sends().length;
  const clash=call('send','p-worker','--task','card-x','--execution',other.key,'모순된 발령');
  assert.notEqual(clash.status,0);assert.match(clash.stderr,/다릅니다|실패/);
  assert.equal(sends().length,count);
  // 회귀: 답장(--reply-to)과 다른 담당 실행 연결은 taskId를 만들지 않는다
  run('send','p-worker','--reply-to',first.mailId,'--execution',mine.key,'첫 편지에 대한 답장');
  const reply=sends().at(-1);
  assert.equal(reply.taskId,undefined);assert.equal(reply.executionKey,'r/card-x');assert.equal(reply.replyTo,first.mailId);
  run('send','p-worker','--execution',other.key,'다른 역할의 실행을 참고하라');
  const link=sends().at(-1);
  assert.equal(link.taskId,undefined);assert.equal(link.executionKey,'r/card-y');
  // 없는 실행 주소는 기존처럼 전송 전에 실패한다
  const missing=call('send','p-worker','--execution','r/missing','없는 실행 연결');
  assert.notEqual(missing.status,0);assert.match(missing.stderr,/연결할 실행 없음/);
 }finally{
  spawnSync('tmux',['-L',socket,'kill-session','-t','kadan-p-worker'],{env});
 }
});

test('추론된 taskId도 resolveWorkMail의 기존 발령 검사를 그대로 통과한다',()=>{
 const {home,store,assign}=fixture();
 const c=store.create({repo:'r',id:'card-z',repoPath:home,body:'# 지시'});assign(c.key,'p-worker');
 const inferred=inferDispatchTask(home,{executionKey:c.key,role:'p-worker'});
 assert.deepEqual(resolveWorkMail(home,{taskId:inferred,executionKey:c.key}),{executionKey:'r/card-z'});
 // 추론된 taskId와 같은 값을 직접 주면 업무 연결까지 채운다(기존 동작)
 const works=new WorkStore(home);
 let work=works.create({key:'r/w',title:'업무',goal:'결과',scope:'전체',acceptance:'확인',owner:'p-boss',repoPath:home,board:'p'});
 works.change(work.key,'link',{execution:c.key,phase:'implementation',round:1},{revision:work.revision,note:'연결'});
 assert.deepEqual(resolveWorkMail(home,{taskId:inferred,executionKey:c.key}),{workKey:'r/w',executionKey:'r/card-z'});
});
