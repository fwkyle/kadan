import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createDatabase} from '../src/storage.mjs';
import {CardStore} from '../src/card-store.mjs';
import {appendLedger,readLedger} from '../src/ledger.mjs';
import {WatchReports} from '../src/watch-report.mjs';
import {WatchAI} from '../src/watch-ai.mjs';

const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
const parents=new Map([['p-작업자','p-감독'],['p-감독','p-슈퍼감독'],['p-슈퍼감독','@user']]);
function fixture({sqlite=true}={}) {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-watch-report-'));
 if(sqlite){createDatabase(home);fs.writeFileSync(path.join(home,'storage.json'),JSON.stringify({version:1,backend:'sqlite'}));}
 const f={home,at:Date.now(),cards:[{id:'a',key:'r/a',role:'p-작업자',board:'p',status:'assigned',workType:'execution'}],sent:[],live:['p-작업자','p-감독','p-슈퍼감독']};
 for(const [i,role] of f.live.entries())appendLedger({kind:'start',role,session:`kadan-${role}`,panePid:i+1},home);
 appendLedger({kind:'send',role:'p-작업자',taskId:'a'},home);
 f.options={home,now:()=>f.at,readCards:()=>f.cards,
  floor:{list:()=>f.live.map((role,i)=>({session:`kadan-${role}`,pid:i+1}))},send:(role,message)=>f.sent.push({role,message})};
 f.r=new WatchReports(f.options);f.request=(extra={})=>f.r.request({source:'stall',role:'p-작업자',parents,...extra});
 f.rows=()=>readLedger(home);
 return f;
}

test('정상은 기록만, 같은 문제는 최초 1회, 정상 뒤 재발은 새 보고: SQLite/JSONL',()=>{
 for(const sqlite of [true,false]){
  const f=fixture({sqlite});
  f.r.submit(f.request().requestId,'입력대기','정상적인 결과 대기');assert.equal(f.sent.length,0);
  const job=f.request();f.r.submit(job.requestId,'정체','입력 대기에서 다음 작업을 시작하지 않음');
  assert.equal(f.r.submit(job.requestId,'정체','같은 요청').duplicate,true);
  f.r.submit(f.request().requestId,'정체','같은 문제의 다른 설명');assert.equal(f.sent.length,1);
  f.r.submit(f.request().requestId,'진행중','도구 작업 진행');assert.equal(f.sent.length,1);
  assert(f.rows().some(e=>e.kind==='alert'&&e.resolution==='ai-normal'&&e.delivered===false));
  f.r.submit(f.request().requestId,'정체','다시 멈춤');assert.equal(f.sent.length,2);
  assert.equal(f.sent[0].role,'p-감독');assert.match(f.sent[0].message,/다음 작업/);
 }
});
test('근거 부족과 반복 조정은 AI 이유를 보존하고 반복 2회만 RED로 올린다',()=>{
 const f=fixture();
 f.cards=[{id:'a',key:'r/a',role:'p-작업자',status:'assigned',activity:'running',workType:'execution'}];
 const unknown=f.r.submit(f.request().requestId,'모름','화면에 현재 작업을 식별할 자료가 없음');
 assert.equal(fs.readFileSync(unknown.reasonPath,'utf8'),'화면에 현재 작업을 식별할 자료가 없음');
 assert.match(f.sent[0].message,/판단 근거 부족/);
 const run=()=>f.r.submit(f.request({source:'progress',taskId:'a'}).requestId,'조정','같은 오류가 반복되고 수정 근거가 없음');
 assert.equal(run().level,'AMBER');assert.equal(run().level,'RED');run();assert.equal(f.sent.length,3);
 assert.match(f.sent[2].message,/상위 감독/);
});
test('완료·재배정·새 세션·기한 종료·호출 종료·후속 호출 이후 늦은 보고는 보내지 않는다',()=>{
 for(const change of [
  f=>appendLedger({kind:'done',role:'p-작업자',taskId:'a'},f.home),
  f=>Object.assign(f.cards[0],{activity:'waiting',activityRole:'p-작업자',activityAt:f.rows().find(e=>e.kind==='send').t}),
  f=>f.cards=[{id:'a',key:'r/a',status:'assigned',role:'p-검수자'}],
  f=>appendLedger({kind:'start',role:'p-작업자',session:'kadan-p-작업자',panePid:99},f.home),
  (f,j)=>f.at=j.expiresAt+1,
  (f,j)=>appendLedger({kind:'watch-ai-call',requestId:j.requestId,reason:'timeout'},f.home),
  f=>f.request(),
 ]){
  const f=fixture(),job=f.request();change(f,job);
  assert.equal(f.r.submit(job.requestId,'응답장애','종료 의심').accepted,false);assert.equal(f.sent.length,0);
 }
});
test('assigned 실행 완료 후 작업자의 늦은 보고와 이전 경보를 조용히 제외하고 새 send는 감시한다',()=>{
 const role='p-작업자';
  const f=fixture();f.cards=[{id:'a',key:'r/a',role:'p-작업자',board:'p',status:'assigned',at:f.rows().find(e=>e.kind==='send').t}];
  const request=()=>f.request({role});
  f.r.submit(request().requestId,'정체','멈춤');
  const later=request();
  appendLedger({kind:'done',role:'p-작업자',taskId:'a'},f.home);
  const report=f.r.submit(later.requestId,'응답장애','완료 후 도착한 이전 판정');
  assert.equal(report.accepted,false);assert.equal(report.notify,false);assert.equal(request(),null);
  f.r.retire(f.rows(),f.cards,parents);assert.equal(f.sent.length,1);
  assert(f.rows().some(e=>e.kind==='watch-ai-retired'&&e.requestId!==later.requestId));
  assert(f.rows().some(e=>e.resolution==='scope-exit'&&e.role===role&&e.delivered===false));
  assert.equal(f.rows().filter(e=>e.kind==='watch-ai-delivery').length,1);
  assert.equal(f.cards[0].status,'assigned');
  f.at+=1000;appendLedger({kind:'send',role:'p-작업자',taskId:'a',t:new Date(f.at).toISOString()},f.home);
  assert.equal(f.r.submit(request().requestId,'정체','새 발령이 멈춤').accepted,true);
  assert.equal(f.sent.length,2);
});
test('감독의 과거 AI 요청·경보는 관리 카드가 assigned여도 조용히 제외한다',()=>{
 const f=fixture(),role='p-감독';
 f.cards.push({id:'management',key:'r/management',role,status:'assigned',workType:'coordination'});
 appendLedger({kind:'send',role,taskId:'management'},f.home);
 // 이전 정책이 남긴 요청과 경보를 저장 형식 그대로 준비한다.
 const request={...f.request(),role,session:`kadan-${role}`,requestId:'old-supervisor',key:'stall:old-supervisor',responsibility:'previous-policy'};
 appendLedger({...request,requestId:'old-report'},f.home);
 appendLedger({...request,kind:'watch-ai-report',requestId:'old-report',accepted:true,notify:true,verdict:'응답장애',level:'RED'},f.home);
 appendLedger(request,f.home);
 for(const manager of [role,'p-슈퍼감독'])assert.equal(f.request({role:manager}),null);
 const result=f.r.submit(request.requestId,'응답장애','입력 대기 중인 감독의 늦은 종료 의심');
 assert.equal(result.accepted,false);assert.equal(result.notify,false);
 f.r.retire(f.rows(),f.cards,parents);
 assert(f.rows().some(e=>e.kind==='watch-ai-retired'&&e.requestId==='old-report'));
 assert(f.rows().some(e=>e.resolution==='scope-exit'&&e.role===role&&e.delivered===false));
 assert.deepEqual(f.sent,[]);assert.equal(f.rows().filter(e=>e.kind==='watch-ai-delivery').length,0);
});
test('진행 조정 도중 결과 대기로 바뀌면 늦은 판정과 이전 조정 경보를 조용히 제외한다',()=>{
 const f=fixture();f.cards=[{id:'a',key:'r/a',role:'p-작업자',status:'assigned',activity:'running'}];
 f.r.submit(f.request({source:'progress',taskId:'a'}).requestId,'조정','같은 오류 반복');
 const later=f.request({source:'progress',taskId:'a'});f.cards[0].activity='waiting';
 assert.equal(f.r.submit(later.requestId,'조정','늦은 판정').accepted,false);
 f.r.retire(f.rows(),f.cards,parents);assert.equal(f.sent.length,1);
 assert(f.rows().some(e=>e.kind==='watch-ai-retired'));
});
test('부재한 직속은 같은 사슬의 상위, 상위도 없으면 사용자로 보고한다',()=>{
 for(const [live,target] of [[['p-작업자','p-슈퍼감독'],'p-슈퍼감독'],[['p-작업자'],'@user']]){
  const f=fixture();f.live=live;f.r.submit(f.request().requestId,'응답장애','세션 종료 메시지');assert.equal(f.sent[0].role,target);
 }
});
test('확실한 미전송만 상신하고 불확실한 전송은 재시도하지 않는다',()=>{
 for(const delivery of ['not-sent','unknown','sent']){
  const f=fixture();f.r.send=(role,message)=>{f.sent.push({role,message});if(role==='p-감독'){const e=Error('failure');e.delivery=delivery;throw e;}};
  const job=f.request();f.r.submit(job.requestId,'정체','멈춤');f.r.submit(job.requestId,'정체','중복');
  assert.deepEqual(f.sent.map(s=>s.role),delivery==='not-sent'?['p-감독','p-슈퍼감독']:['p-감독']);
  assert.equal(f.r.receipt(job.requestId).delivery.delivery,delivery);
 }
});
test('외부 보고 동안 SQLite 쓰기 잠금을 잡지 않는다',()=>{
 const f=fixture();
 f.r.send=()=>{
  const module=fileURLToPath(new URL('../src/ledger.mjs',import.meta.url));
  const r=spawnSync(process.execPath,['--input-type=module','-e',`import {appendLedger} from ${JSON.stringify(module)};appendLedger({kind:'external-write'},process.env.KADAN_HOME);`],
   {env:{...process.env,KADAN_HOME:f.home},encoding:'utf8',timeout:7000});
  assert.equal(r.status,0,r.stderr);
 };
 const report=f.r.submit(f.request().requestId,'정체','멈춤');assert.equal(report.delivery,'sent');
 assert(f.rows().some(e=>e.kind==='external-write'));
});
test('동시 CLI 실행도 같은 호출을 한 번만 기록하며 임의 수신자를 받지 않는다',async()=>{
 const f=fixture(),job=f.request();
 const store=new CardStore(f.home);
 let card=store.create({repo:'r',id:'a',repoPath:f.home,body:'# 격리된 실제 실행'});
 card=store.update(card.key,{status:'ready',board:'p',role:'p-작업자',scope:'격리 시험'},{revision:card.revision,note:'시험 배정'});
 store.update(card.key,{status:'assigned',board:'p',role:'p-작업자',rallyId:'r1',rallyTitle:'묶음',rallyRound:'1',rallyStep:'implementation'},{revision:card.revision,note:'시험 실행'});
 const args=[cli,'watch-report',job.requestId,'--verdict','진행중','--reason','생성 중'];
 await Promise.all([1,2].map(()=>promisify(execFile)(process.execPath,args,{env:{...process.env,KADAN_HOME:f.home}})));
 assert.equal(f.rows().filter(e=>e.kind==='watch-ai-report').length,1);
 assert.equal(f.rows().find(e=>e.kind==='watch-ai-report').accepted,true);
 const r=spawnSync(process.execPath,[...args,'--to','wrong'],{env:{...process.env,KADAN_HOME:f.home},encoding:'utf8'});
 assert.equal(r.status,1);assert.equal(f.sent.length,0);
});
test('감시sh는 호칭·잡음 stdout을 무시하고 실제 보고 명령 실행만 확인한다', async () =>{
 const f=fixture();
 const ai=new WatchAI({...f.options,spawn:(_cmd,options)=>{
  f.r.submit(options.env.KADAN_JUDGE_REQUEST,'입력대기','정상 결과 대기');
  return {status:0,stdout:'[감시] 입력대기\nhook: finished'};
 }});
 const result=await ai.run({judgeCmd:'fake',source:'stall',role:'p-작업자',parents,input:{screen:'waiting'}});
 assert.equal(result.reason,'reported');assert.equal(f.sent.length,0);
 assert.equal(f.rows().filter(e=>e.kind==='watch-ai-report').length,1);
 assert(f.rows().some(e=>e.kind==='watch-ai-call'&&e.outputBytes>0));
});
test('낱말 응답만 하면 보고 누락, 실행 실패·시간 초과는 각각 별도 장애', async () =>{
 for(const [fake,reason] of [[{status:0,stdout:'진행중'},'report-missing'],[{status:1,stdout:'진행중'},'call-failed'],[{status:null,error:{code:'ETIMEDOUT'}},'timeout']]){
  const f=fixture();const ai=new WatchAI({...f.options,spawn:()=>fake});
  const r=await ai.run({judgeCmd:'fake',source:'stall',role:'p-작업자',parents,input:{screen:'screen'}});
  assert.equal(r.reason,reason);assert.equal(r.ok,false);assert.equal(f.sent.length,0);
  assert.equal(f.r.submit(r.requestId,'정체','늦은 보고').accepted,false);
 }
});
test('보고까지 끝낸 뒤 일반 답변이 실패해도 같은 보고를 다시 보내지 않는다', async () =>{
 const f=fixture();const ai=new WatchAI({...f.options,spawn:(_cmd,options)=>{
  f.r.submit(options.env.KADAN_JUDGE_REQUEST,'정체','멈춤');return {status:1,stdout:''};
 }});
 const result=await ai.run({judgeCmd:'fake',source:'stall',role:'p-작업자',parents,input:{screen:'screen'}});
 assert.equal(result.reason,'reported');assert.equal(f.sent.length,1);assert.deepEqual(result.deliveredRecipients,['p-감독']);
});

test('실제 자식 프로세스의 무응답은 제한시간 안에 종료하고 늦은 보고를 막는다', async () =>{
 const f=fixture();const helper=path.join(f.home,'hang.mjs');
 fs.writeFileSync(helper,"import fs from 'node:fs';fs.writeFileSync(process.env.KADAN_HOME+'/hang.pid',String(process.pid));setInterval(()=>{},1000);\n");
 const ai=new WatchAI(f.options),started=Date.now();
 const result=await ai.run({judgeCmd:`'${process.execPath}' '${helper}'`,source:'stall',role:'p-작업자',parents,input:{},timeoutMs:250});
 assert.equal(result.reason,'timeout');assert(Date.now()-started<2500);
 const pid=Number(fs.readFileSync(path.join(f.home,'hang.pid'),'utf8'));
 assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');
 assert.equal(f.r.submit(result.requestId,'정체','늦은 응답').accepted,false);
});

test('기본 보고 기한은 5분이며 3분 이후의 유효한 보고도 접수한다',()=>{
 const f=fixture(),request=f.request();
 assert.equal(request.expiresAt-f.at,300_000);
 f.at+=240_000;
 assert.equal(f.r.submit(request.requestId,'진행중','실제 진전').accepted,true);
});

test('5분 기한을 넘긴 보고는 접수하거나 전달하지 않는다',()=>{
 const f=fixture(),request=f.request();f.at+=300_001;
 assert.equal(f.r.submit(request.requestId,'정체','늦은 보고').accepted,false);
 assert.equal(f.sent.length,0);
});

test('보고·전달을 확정하면 최종 답변이 없어도 호출과 자식을 일찍 종료한다',async()=>{
 const f=fixture(),helper=path.join(f.home,'report-then-hang.mjs');
 const reportModule=new URL('../src/watch-report.mjs',import.meta.url).href;
 fs.writeFileSync(helper,`import fs from 'node:fs';import {spawn} from 'node:child_process';
import {WatchReports} from ${JSON.stringify(reportModule)};
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync(process.env.KADAN_HOME+'/report.pids',JSON.stringify([process.pid,child.pid]));
const r=new WatchReports({home:process.env.KADAN_HOME,readCards:()=>${JSON.stringify(f.cards)},readWorks:()=>[],floor:{list:()=>${JSON.stringify(f.live.map((role,i)=>({session:'kadan-'+role,pid:i+1})))}},send:()=>{}});
setTimeout(()=>r.submit(process.env.KADAN_JUDGE_REQUEST,'정체','실제 진전이 멈춤'),80);
setInterval(()=>{},1000);
`);
 const started=Date.now(),ai=new WatchAI(f.options);
 const result=await ai.run({judgeCmd:`'${process.execPath}' '${helper}'`,source:'stall',role:'p-작업자',parents,input:{},timeoutMs:5000});
 assert.equal(result.reason,'reported');assert.equal(result.ok,true);
 assert(Date.now()-started<2500,'최종 답변/전체 제한을 기다리지 않음');
 assert.equal(f.rows().filter(e=>e.kind==='watch-ai-delivery').length,1);
 assert.equal(f.rows().filter(e=>e.kind==='watch-ai-call').length,1);
 assert.equal(f.rows().find(e=>e.kind==='watch-ai-call').exitCode,0);
 const pids=JSON.parse(fs.readFileSync(path.join(f.home,'report.pids'),'utf8'));
 for(const pid of pids)assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');
});

test('완료 신호 파일만으로 성공하지 않고 원장의 보고·전달 접수를 대조한다',async()=>{
 const f=fixture(),helper=path.join(f.home,'false-completion.mjs');
 fs.writeFileSync(helper,"import fs from 'node:fs';fs.writeFileSync(process.env.KADAN_JUDGE_DIR+'/report-complete','fake');setInterval(()=>{},1000);\n");
 const result=await new WatchAI(f.options).run({judgeCmd:`'${process.execPath}' '${helper}'`,source:'stall',role:'p-작업자',parents,input:{},timeoutMs:350});
 assert.equal(result.reason,'timeout');assert.equal(result.ok,false);assert.equal(f.sent.length,0);
});

test('감시 종료 신호는 해당 AI만 취소하고 늦은 보고를 허용하지 않는다',async()=>{
 const f=fixture(),helper=path.join(f.home,'cancel-hang.mjs');
 fs.writeFileSync(helper,"import fs from 'node:fs';fs.writeFileSync(process.env.KADAN_HOME+'/cancel.pid',String(process.pid));setInterval(()=>{},1000);\n");
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),200);
 try{
  const result=await new WatchAI(f.options).run({judgeCmd:`'${process.execPath}' '${helper}'`,source:'stall',role:'p-작업자',parents,input:{},signal:controller.signal,timeoutMs:5000});
  assert.equal(result.reason,'cancelled');assert.equal(f.sent.length,0);
  assert.equal(f.r.submit(result.requestId,'정체','취소 뒤 늦은 보고').accepted,false);
  const pid=Number(fs.readFileSync(path.join(f.home,'cancel.pid'),'utf8'));
  assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');
 }finally{clearTimeout(timer);}
});

test('진행 중인 카드의 작업자가 아무것도 묻지 않은 채 입력 대기면 감독에게 알린다',()=>{
 const f=fixture();
 f.cards=[{id:'a',key:'r/a',role:'p-작업자',board:'p',status:'assigned',activity:'running',workType:'execution'}];
 const idle=f.r.submit(f.request({source:'progress',taskId:'a'}).requestId,'입력대기','카드 절차가 남았는데 프롬프트로 돌아가 멈춰 있음');
 assert.equal(idle.idleWithoutAsk,true);
 assert.equal(f.sent.length,1);
 assert.equal(f.sent[0].role,'p-감독');
 assert.match(f.sent[0].message,/카드 미완인데 입력 대기/);
 // 같은 상태를 반복해서 다시 알리지 않는다.
 f.r.submit(f.request({source:'progress',taskId:'a'}).requestId,'입력대기','여전히 같은 상태');
 assert.equal(f.sent.length,1);
 // 다시 움직이면 해소로 기록한다.
 f.r.submit(f.request({source:'progress',taskId:'a'}).requestId,'진행중','도구 실행 재개');
 assert.equal(f.sent.length,1);
 assert(f.rows().some(e=>e.kind==='alert'&&e.resolution==='ai-normal'&&e.alertKind==='입력대기'));
});
test('작업자가 감독에게 편지를 보낸 뒤의 입력 대기는 정상으로 본다',()=>{
 const f=fixture();
 f.cards=[{id:'a',key:'r/a',role:'p-작업자',board:'p',status:'assigned',activity:'running',workType:'execution'}];
 appendLedger({kind:'send',role:'p-감독',by:'p-작업자',taskId:'a'},f.home);
 const waiting=f.r.submit(f.request({source:'progress',taskId:'a'}).requestId,'입력대기','승인 답을 기다리는 중');
 assert.equal(waiting.idleWithoutAsk,undefined);
 assert.equal(f.sent.length,0);
});
test('발령 뒤 감독이 답을 보내면 기준이 다시 그 시점으로 옮겨간다',()=>{
 const f=fixture();
 f.cards=[{id:'a',key:'r/a',role:'p-작업자',board:'p',status:'assigned',activity:'running',workType:'execution'}];
 appendLedger({kind:'send',role:'p-감독',by:'p-작업자',taskId:'a'},f.home);
 appendLedger({kind:'send',role:'p-작업자',by:'p-감독',taskId:'a'},f.home);
 const idle=f.r.submit(f.request({source:'progress',taskId:'a'}).requestId,'입력대기','답을 받고도 다시 멈춰 있음');
 assert.equal(idle.idleWithoutAsk,true);
 assert.equal(f.sent.length,1);
});

