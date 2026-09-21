import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync,spawn} from 'node:child_process';
import {createDatabase,writeStorageMarker} from '../src/storage.mjs';
import {readLedger,readMailLedger,readTaskLedger,readMailBody} from '../src/ledger.mjs';
import {digest,findDoneMarkers} from '../src/cli.mjs';

const cli=new URL('../src/cli.mjs',import.meta.url).pathname;
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";

test('격리 SQLite + 실제 tmux + CLI 자동 프로그램: 구현→검수→수정→PASS·마커·동시 실행',async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-auto-review-cli-'));
 createDatabase(home);writeStorageMarker(home,'sqlite');
 const socket=`auto-review-test-${process.pid}-${Date.now()}`;
 const env={...process.env,KADAN_HOME:home,KADAN_SOCKET:socket,KADAN_FLOOR:'tmux',KADAN_WINDOW:'none',KADAN_ROLE:'ar-test-super'};
 const roles=['ar-test-worker','ar-test-reviewer','ar-test-super'],transcript=[];
 const run=(...args)=>{const p=spawnSync(process.execPath,[cli,...args],{env,encoding:'utf8',timeout:15000});transcript.push({args,status:p.status,stdout:p.stdout,stderr:p.stderr});assert.equal(p.status,0,p.stderr||p.error?.message);return p.stdout;};
 const receiver=path.join(home,'receiver.mjs');
 fs.writeFileSync(receiver,`
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import readline from 'node:readline';
import {spawnSync} from 'node:child_process';
const home=process.env.KADAN_HOME,role=process.env.KADAN_ROLE;let count=0,pending=null;
readline.createInterface({input:process.stdin,terminal:false}).on('line',line=>{
 fs.appendFileSync(path.join(home,role+'.received'),line+'\\n');
 const match=line.match(/카드 id는 (exec-[a-f0-9-]+)이다/);if(match)pending=match[1];
 // 실제 AI처럼 원문과 첨부를 모두 받은 뒤 결과를 낸다. 원문 줄의 ID 파싱은 유지한다.
 if(line!=='<!-- /kadan:receiver-instructions -->'||!pending)return;
 count++;const id=pending;pending=null;
 const shown=spawnSync(process.execPath,[${JSON.stringify(cli)},'card','show','ar-test/'+id],{encoding:'utf8',env:process.env});
 const result=JSON.parse(shown.stdout).resultPath;
 const outcome=role==='ar-test-reviewer'?(count===1?'changes':'pass'):'implemented';
 fs.writeFileSync(result,'실제 CLI 결과 '+role+' '+outcome+'\\n');
 const p=spawnSync(process.execPath,[${JSON.stringify(cli)},'work','auto-report','ar-test/work','--execution','ar-test/'+id,'--outcome',outcome],{encoding:'utf8',env:process.env});
 fs.appendFileSync(path.join(home,role+'.reports'),JSON.stringify({status:p.status,stdout:p.stdout,stderr:p.stderr})+'\\n');
 if(p.status!==0){console.log('보고 실패 '+p.stderr);return;}
 console.log(['KADAN:DONE',id,'ok'].join(' '));
});
`);
 const started=[];
 try{
  run('work','create','ar-test/work','--title','실제 CLI 왕복','--goal','왕복 완료','--scope','격리 receiver','--acceptance','마커와 원문','--owner','ar-test-super','--board','ar-test','--repo-path',home);
  for(const id of ['implementation','review']){
   const source=path.join(home,id+'.md');fs.writeFileSync(source,'# 격리 원본\n결과 저장 뒤 현재 실행 완료 마커');
   run('card','create','ar-test/'+id,'--source',source,'--repo-path',home);
   run('card','update','ar-test/'+id,'--revision','1','--status','ready','--scope','격리 receiver','--note','시험 승인');
  }
  // 카드 전달은 등록 실행기+모델로 시작한 세대만 받는다 — 시험 실행기도 그 형태를 갖춘다.
  const harness=path.join(home,'codex');
  fs.writeFileSync(harness,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(receiver)} "$@"\n`);fs.chmodSync(harness,0o755);
  for(const role of roles){run('start',role,'--cmd',`${quote(harness)} --model test-model`);started.push(role);}
  run('work','auto-configure','ar-test/work','--revision','1','--implementation','ar-test/implementation','--review','ar-test/review','--worker',roles[0],'--reviewer',roles[1],'--notify',roles[2],'--deadline',new Date(Date.now()+45000).toISOString());
  const program=()=>new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[cli,'work','auto-run','ar-test/work','--interval','0.1'],{env});let stdout='',stderr='';
   const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('격리 프로그램 50초 상한'));},50000);
   child.stdout.on('data',b=>{stdout+=b});child.stderr.on('data',b=>{stderr+=b});
   child.on('error',reject);child.on('close',code=>{clearTimeout(timer);transcript.push({args:['work','auto-run'],status:code,stdout,stderr});if(code!==0)reject(new Error(stderr));else resolve(JSON.parse(stdout));});
  });
  const results=await Promise.all([program(),program()]);
  const state=JSON.parse(run('work','auto-show','ar-test/work'));
  assert.equal(state.status,'pass');assert.equal(state.notification.status,'sent');
  assert.ok(results.some(s=>s.status==='pass'));
  const before=readLedger(home).filter(e=>e.kind==='send').length;run('work','auto-step','ar-test/work');assert.equal(readLedger(home).filter(e=>e.kind==='send').length,before);
  const work=JSON.parse(run('work','show','ar-test/work'));assert.equal(work.status,'open');assert.equal(work.executions.length,4);
  for(const execution of work.executions){
   const card=JSON.parse(run('card','show',execution.key));
   assert.equal(card.resultPath,path.join(home,'cards',...card.key.split('/'),'result.md'));
   assert.equal(card.result.path,card.resultPath);
   assert.equal(card.result.sha256,createHash('sha256').update(fs.readFileSync(card.resultPath)).digest('hex'));
  }
  const entries=readLedger(home),mail=readMailLedger(home),tasks=readTaskLedger(home);
  const sends=mail.filter(e=>e.kind==='send'&&e.transport!=='mailbox'),completions=mail.filter(e=>e.kind==='send'&&e.completion);
  assert.equal(mail.filter(e=>e.kind==='send').length,9);assert.equal(completions.length,4);
  assert.equal(tasks.filter(e=>e.kind==='dispatch').length,4);
  for(const dispatch of tasks.filter(e=>e.kind==='dispatch')){
   const stored=completions.filter(e=>e.replyTo===dispatch.mailId);assert.equal(stored.length,1);
   const completion=stored[0],done=tasks.find(e=>e.kind==='done'&&e.completionMailId===completion.mailId);
   assert.ok(done);assert.equal(completion.by,dispatch.role);assert.equal(completion.role,dispatch.by);
   assert.equal(completion.transport,'mailbox');assert.equal(completion.systemGenerated,'task-completion');
   assert.equal(completion.taskId,undefined);assert.equal(completion.executionKey,dispatch.executionKey);
   assert.equal(completion.workKey,dispatch.workKey);assert.equal(completion.result,done.result);
   const body=readMailBody(completion.digest,home);assert.equal(typeof body,'string');
   assert.equal(completion.bytes,Buffer.byteLength(body));assert.equal(completion.digest,createHash('sha256').update(body).digest('hex'));
   assert.ok(!fs.readFileSync(path.join(home,completion.role+'.received'),'utf8').includes(body+'\n'),'저장 완료 통지는 감독 화면에 주입하지 않는다');
  }
  assert.deepEqual(sends.map(e=>e.role),[roles[0],roles[1],roles[0],roles[1],roles[2]]);
  assert.deepEqual(sends.map(e=>e.roleProfile),['worker','reviewer','worker','reviewer','conductor']);
  for(const e of sends){
   const body=readMailBody(e.digest,home);assert.equal(e.bytes,Buffer.byteLength(body));assert.equal(e.digest,digest(body));
   assert.deepEqual(findDoneMarkers(body),[]);
   if(e.taskId){assert.ok(body.startsWith('중앙 카드 '));assert.match(body,/완료 방식: 자동\./);}
   else {assert.match(body,/next action/);assert.match(body,/kadan work show ar-test\/work/);}
   const end=Date.now()+2000;
   while(Date.now()<end&&!fs.readFileSync(path.join(home,e.role+'.received'),'utf8').includes(body+'\n'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
   assert.ok(fs.readFileSync(path.join(home,e.role+'.received'),'utf8').includes(body+'\n'));
  }
  assert.equal(new Set(sends.filter(e=>e.taskId).map(e=>e.taskId)).size,4);assert.equal(entries.filter(e=>e.kind==='done').length,4);
  assert.equal(sends.filter(e=>!e.taskId).length,1);
  for(const role of roles){run('read',role,'--lines','30');assert.ok(fs.readFileSync(path.join(home,role+'.received'),'utf8').length>0);}
 }finally{
  for(const role of started)run('stop',role);
  fs.writeFileSync(path.join(home,'cli-transcript.json'),JSON.stringify(transcript,null,2)+'\n');
  console.log('실제 CLI 증거: '+path.join(home,'cli-transcript.json')+' / socket='+socket);
 }
});
