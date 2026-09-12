import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AutomaticReview} from '../src/automatic-review.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {CardStore} from '../src/card-store.mjs';
import {createDatabase,writeStorageMarker,appendStream} from '../src/storage.mjs';
import {appendLedger,readLedger,saveMailBody} from '../src/ledger.mjs';
import {guardedSend} from '../src/cli.mjs';

function fixture(){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-auto-review-'));
 createDatabase(home);writeStorageMarker(home,'sqlite');
 const works=new WorkStore(home),cards=new CardStore(home),key='test/automatic';
 works.create({key,title:'자동 전달 시험',goal:'독립검수 완료',scope:'시험 파일',acceptance:'필수 시험',owner:'test-super',board:'test',repoPath:home});
 const pids={'test-worker':'10001','test-reviewer':'10002','test-super':'10003'},sent=[];
 const floor={name:'tmux',alive:n=>!!pids[n.slice(6)],pid:n=>pids[n.slice(6)],read:()=>'',send:(name,message)=>{sent.push({name,message});return {};}};
 const start=(role,pid)=>{pids[role]=pid;appendLedger({kind:'start',role,session:`kadan-${role}`,floor:'tmux',panePid:pid},home);};
 for(const [role,pid] of Object.entries(pids))start(role,pid);
 for(const id of ['implementation','review']){let c=cards.create({repo:'test',id,repoPath:home,body:`# 原本 ${id}\n최초 지시를 그대로 따른다`});cards.update(c.key,{status:'ready',scope:'시험 파일'},{revision:1,note:'승인'});}
 let beforeSend=()=>{},observe=()=>null;
 const context={home,by:'test-super',floor,observeDone:s=>observe(s),send:({role,pid,message,taskId,workKey,executionKey,roleProfile,transmit})=>{
  beforeSend({role,taskId});
  return guardedSend({floor:{...floor,send:(n,m)=>transmit(()=>floor.send(n,m))},role,session:`kadan-${role}`,message,taskId,roleProfile,recordedPid:pid,
   env:{KADAN_HOME:home,KADAN_ROLE:'test-super'},readEntries:()=>readLedger(home),record:e=>appendLedger(e,home),saveBody:(d,b)=>saveMailBody(d,b,home),mailContext:{workKey,executionKey}});
 }};
 const auto=new AutomaticReview(context);
 const configure=(extra={})=>auto.configure(key,{revision:works.get(key).revision,implementation:'test/implementation',review:'test/review',worker:'test-worker',reviewer:'test-reviewer',notify:'test-super',...extra});
 const report=(outcome='implemented',write=true)=>{
  const s=auto.get(key),resultFile=path.join(home,s.current.key.split('/')[1]+'.md');if(write)fs.writeFileSync(resultFile,'실제 결과 원문 '+outcome);
  const r=new AutomaticReview({...context,by:s.current.role});return r.report(key,{execution:s.current.key,outcome,resultFile});
 };
 const done=(result='ok')=>{const s=auto.get(key);appendLedger({kind:'done',role:s.current.role,taskId:s.current.key.split('/')[1],result},home);};
 const finish=(outcome)=>{report(outcome);done();return auto.step(key);};
 return {home,key,auto,works,cards,pids,floor,sent,start,context,configure,report,done,finish,before:fn=>{beforeSend=fn;},observe:fn=>{observe=fn;}};
}

test('구현→독립검수→동일 작업자 수정→조기 PASS, 새 실행ID·원문참조·감독 1회',()=>{
 const f=fixture();f.configure();let s=f.auto.step(f.key);
 assert.equal(s.phase,'implementation');assert.equal(s.status,'waiting');
 const first=s.current.key;assert.match(f.cards.get(first).body,/원본 지시:/);assert.doesNotMatch(f.cards.get(first).body,/原本/);
 s=f.finish('implemented');assert.equal(s.phase,'review');assert.equal(s.current.role,'test-reviewer');assert.equal(s.round,1);
 s=f.finish('changes');assert.equal(s.phase,'fix');assert.equal(s.current.role,'test-worker');assert.equal(s.round,2);
 s=f.finish('implemented');assert.equal(s.phase,'review');s=f.finish('pass');
 assert.equal(s.status,'pass');assert.equal(s.notification.status,'sent');assert.equal(f.works.get(f.key).status,'open');
 for(let i=0;i<3;i++)f.auto.step(f.key);
 const sends=readLedger(f.home).filter(e=>e.kind==='send');assert.equal(sends.length,5);assert.equal(sends.filter(e=>!e.taskId).length,1);
 assert.deepEqual(sends.map(e=>e.roleProfile),['worker','reviewer','worker','reviewer','conductor']);
 assert.ok(f.sent.slice(0,4).every(x=>x.message.includes('완료 방식: 자동.')));
 assert.equal(new Set(sends.filter(e=>e.taskId).map(e=>e.taskId)).size,4);
 assert.ok(f.sent.every(x=>!/^\s*KADAN:DONE\s+\S+\s+(?:ok|failed)\s*$/m.test(x.message)));
 assert.deepEqual(f.works.get(f.key).executions.map(x=>[x.phase,x.round]),[['implementation',1],['review',1],['fix',2],['review',2]]);
});

test('자동 최종 통지는 owner가 아닌 슈퍼 수신자의 명시 profile을 존중한다',()=>{
 const f=fixture();f.start('test-top','20003');
 appendLedger({kind:'start',role:'test-top',session:'kadan-test-top',floor:'tmux',panePid:'20003',roleProfile:'super'},f.home);
 f.configure({notify:'test-top'});f.auto.step(f.key);f.finish('implemented');const state=f.finish('pass');
 assert.equal(state.notification.status,'sent');
 const notice=readLedger(f.home).filter(e=>e.kind==='send').at(-1);
 assert.equal(notice.role,'test-top');assert.equal(notice.roleProfile,'super');
 assert.match(f.sent.at(-1).message,/next action/);assert.match(f.sent.at(-1).message,/kadan work show test\/automatic/);
 assert.equal(f.works.get(f.key).status,'open');
});

test('3라운드 경계는 한번 통지, 4라운드는 새 두 세션 확인 후에만 시작',()=>{
 const f=fixture();f.configure();f.auto.step(f.key);
 for(let i=1;i<=3;i++){f.finish('implemented');const s=f.finish('changes');assert.equal(s.status,i===3?'boundary':'waiting');}
 assert.equal(f.works.get(f.key).executions.length,6);f.auto.step(f.key);assert.equal(f.sent.length,7);
 assert.throws(()=>f.configure({nextBlock:true}),/교대/);
 f.start('test-worker-2','20001');assert.throws(()=>f.configure({nextBlock:true,worker:'test-worker-2'}),/교대/);
 f.start('test-reviewer-2','20002');f.configure({nextBlock:true,worker:'test-worker-2',reviewer:'test-reviewer-2'});
 const s=f.auto.step(f.key);assert.equal(s.round,4);assert.equal(s.block,2);assert.equal(s.phase,'fix');assert.equal(s.current.role,'test-worker-2');
});

test('업무 전체 18라운드까지만 허용, 6블록 세션 교대로 상한을 초기화하지 않음',()=>{
 const f=fixture();f.configure();f.auto.step(f.key);
 for(let round=1;round<=18;round++){
  f.finish('implemented');const s=f.finish('changes');
  if(round%3===0&&round<18){
   f.start(`test-w-${round}`,String(30000+round));f.start(`test-r-${round}`,String(40000+round));
   f.configure({nextBlock:true,worker:`test-w-${round}`,reviewer:`test-r-${round}`});f.auto.step(f.key);
  }else if(round===18)assert.equal(s.status,'limit');
 }
 assert.equal(f.works.get(f.key).executions.length,36);assert.throws(()=>f.configure({nextBlock:true}),/블록 경계/);assert.equal(f.works.get(f.key).status,'open');
});

for(const order of ['report-first','done-first','missing-file'])test(`완료·보고 도착순서와 결과 저장 전 마커: ${order}`,()=>{
 const f=fixture();f.configure();f.auto.step(f.key);
 if(order==='report-first'){f.report();f.report();f.auto.step(f.key);assert.equal(f.sent.length,1);f.done();f.done();}
 else if(order==='done-first'){f.done();f.auto.step(f.key);assert.equal(f.sent.length,1);f.report();}
 else{f.report('implemented',false);f.done();f.auto.step(f.key);assert.equal(f.sent.length,1);fs.writeFileSync(f.auto.get(f.key).report.resultFile,'뒤늦게 저장한 결과');}
 const restarted=new AutomaticReview(f.context);restarted.step(f.key);restarted.step(f.key);assert.equal(f.sent.length,2);assert.equal(restarted.get(f.key).phase,'review');
});

test('실행 failed는 품질 수정 필요와 구별해 즉시 감독에게 전달',()=>{
 const f=fixture();f.configure();f.auto.step(f.key);f.report();f.done('failed');const s=f.auto.step(f.key);
 assert.equal(s.status,'exception');assert.match(s.reason,/실행 자체 실패/);assert.equal(f.works.get(f.key).executions.length,1);assert.equal(f.sent.length,2);
});

test('판정 불명확·범위 밖은 명시 exception, 자유본문 PASS를 해석하지 않음',()=>{
 const f=fixture();f.configure();f.auto.step(f.key);f.finish('implemented');
 const s=f.auto.get(f.key),r=new AutomaticReview({...f.context,by:s.current.role});
 assert.throws(()=>r.report(f.key,{execution:s.current.key,outcome:'maybe',resultFile:'/tmp/example'}),/명시/);
 f.report('exception');fs.writeFileSync(f.auto.get(f.key).report.resultFile,'PASS라고 적혀 있어도 범위 밖');f.done();
 assert.equal(f.auto.step(f.key).status,'exception');assert.equal(f.works.get(f.key).executions.length,2);
});

for(const change of ['hold','cancel','scope','owner','occupancy','pid','card-hold','card-scope','card-role','turn','reference'])test(`전송 바로 전 변경 차단: ${change}`,()=>{
 const f=fixture();f.configure();let once=false;
 f.before(({taskId})=>{
  if(!taskId||once)return;once=true;const w=f.works.get(f.key),s=f.auto.get(f.key);
  if(['hold','scope','owner','turn'].includes(change))f.works.change(f.key,'update',change==='hold'?{status:'hold'}:change==='scope'?{scope:'새 범위'}:change==='owner'?{owner:'다른감독'}:{turnOwner:'다른담당'},{revision:w.revision,note:'동시 변경'});
  if(change==='cancel'||change.startsWith('card-')){const c=f.cards.get(s.current.key);f.cards.update(c.key,change==='cancel'?{status:'cancelled'}:change==='card-hold'?{status:'hold'}:change==='card-scope'?{scope:'다른 범위'}:{role:'다른담당'},{revision:c.revision,note:'동시 변경'});}
  if(change==='reference')fs.appendFileSync(f.cards.get('test/review').path,'범위 변경');
  if(change==='pid')f.pids['test-worker']='99999';
  if(change==='occupancy'){let c=f.cards.create({repo:'test',id:'other',repoPath:f.home,body:'다른 작업'});f.cards.update(c.key,{status:'assigned',scope:'다른 범위',role:'test-worker',board:'other',rallyId:'r1',rallyTitle:'묶음',rallyRound:'1',rallyStep:'implementation'},{revision:1,note:'다른 발령'});}
 });
 const s=f.auto.step(f.key);assert.equal(s.status,'exception');assert.equal(f.sent.filter(e=>e.name!=='kadan-test-super').length,0,'작업 발령 0회');assert.equal(readLedger(f.home).filter(e=>e.kind==='send'&&e.taskId).length,0);
});

test('전송 성공 여부 불명확 뒤 재시작은 재전송하지 않고 상위 통지 1회',()=>{
 const f=fixture();f.configure();const original=f.floor.send;
 f.floor.send=(n,m)=>{original(n,m);throw new Error('응답 유실');};
 assert.equal(f.auto.step(f.key).status,'exception');f.floor.send=original;
 new AutomaticReview(f.context).step(f.key);new AutomaticReview(f.context).step(f.key);
 assert.equal(f.sent.filter(s=>s.name==='kadan-test-worker').length,1);assert.equal(f.sent.filter(s=>s.name==='kadan-test-super').length,1);
});

test('살아 있는 전송 예약 경합과 죽은 프로그램 예약 모두 중복발령0',()=>{
 const f=fixture();f.configure();f.before(({taskId})=>{if(taskId)assert.equal(new AutomaticReview(f.context).step(f.key).status,'sending');});
 f.auto.step(f.key);assert.equal(f.sent.length,1);
 const s=f.auto.get(f.key);appendStream(f.home,f.auto.stream(f.key),{...s,status:'sending',claim:'crash',claimOwner:2147483647});
 const out=new AutomaticReview(f.context).step(f.key);assert.equal(out.status,'exception');assert.match(out.reason,/再|재전송 금지/);assert.equal(f.sent.length,2);
 f.auto.step(f.key);assert.equal(f.sent.length,2);
});

test('통지 응답 유실·통지 예약 후 종료에도 통지를 반복하지 않음',()=>{
 const f=fixture();f.configure();f.auto.step(f.key);f.finish('implemented');
 const send=f.floor.send;f.floor.send=(n,m)=>{send(n,m);if(n==='kadan-test-super')throw new Error('통지 응답 유실');};
 const s=f.finish('pass');assert.equal(s.notification.status,'unknown');f.auto.step(f.key);assert.equal(f.sent.length,3);
 appendStream(f.home,f.auto.stream(f.key),{...s,status:'notifying',terminal:'pass',claimOwner:2147483647,claim:'notice-crash'});
 f.auto.step(f.key);assert.equal(f.sent.length,3);assert.equal(f.auto.get(f.key).notification.status,'unknown');
});

test('현재 실행ID·담당 보고만 수용, 충돌 보고·결과 파일 변조 차단',()=>{
 const f=fixture();f.configure();f.auto.step(f.key);const s=f.auto.get(f.key);
 assert.throws(()=>f.auto.report(f.key,{execution:s.current.key,outcome:'implemented',resultFile:'/tmp/a'}),/담당만/);
 const r=new AutomaticReview({...f.context,by:s.current.role});assert.throws(()=>r.report(f.key,{execution:'test/old',outcome:'implemented',resultFile:'/tmp/a'}),/현재 자동/);
 f.report();
 f.done();f.auto.step(f.key);fs.appendFileSync(f.auto.get(f.key).previous.resultFile,'변조');assert.equal(f.auto.step(f.key).status,'exception');
});

test('같은 실행의 서로 다른 결과 보고는 감독 판단으로 넘김',()=>{
 const f=fixture();f.configure();f.auto.step(f.key);f.report();
 const s=f.auto.get(f.key),r=new AutomaticReview({...f.context,by:s.current.role});
 assert.equal(r.report(f.key,{execution:s.current.key,outcome:'exception',resultFile:'/tmp/different'}).status,'exception');
 const end=f.auto.step(f.key);assert.match(end.reason,/충돌/);assert.equal(end.notification.status,'sent');assert.equal(f.works.get(f.key).executions.length,1);
});

test('기존 시한·수동 업무·원본·미설정 경로 보존',()=>{
 const f=fixture(),before=JSON.stringify(f.works.get(f.key));assert.equal(f.auto.get(f.key),null);assert.throws(()=>f.auto.step(f.key),/설정되지/);assert.equal(JSON.stringify(f.works.get(f.key)),before);
 const body=f.cards.get('test/implementation').body;f.configure({deadline:new Date(Date.now()+60000).toISOString()});
 const late=new AutomaticReview({...f.context,now:()=>Date.now()+120000});assert.equal(late.step(f.key).status,'exception');assert.equal(f.works.get(f.key).executions.length,0);assert.equal(f.cards.get('test/implementation').body,body);
});

test('마커만 먼저 관측해도 결과 없이 검수 발령하지 않음',()=>{
 const f=fixture();f.configure();f.auto.step(f.key);f.observe(()=> 'ok');f.auto.step(f.key);assert.equal(f.sent.length,1);
 assert.equal(readLedger(f.home).filter(e=>e.kind==='done').length,1);f.report();f.auto.step(f.key);assert.equal(f.sent.length,2);
});
