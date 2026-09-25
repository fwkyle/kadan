import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {createDatabase,writeStorageMarker,readStream,appendStream} from '../src/storage.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {CardStore} from '../src/card-store.mjs';
import {appendLedger,saveMailBody} from '../src/ledger.mjs';
import {operationsFlowIndex,operationsFlowDetail,operationsFlowMail} from '../src/operations-flow.mjs';
import {createWallServer} from '../src/wall.mjs';
import {renderCenterWall} from '../src/center-wall.mjs';

function fixture(mode='sqlite'){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-operations-flow-'));
 if(mode==='sqlite'){createDatabase(home);writeStorageMarker(home,'sqlite');}
 const store=new WorkStore(home),cards=new CardStore(home);
 const make=(key='repo/flow')=>store.create({key,title:'운영 흐름 검토',goal:'보고·마감·인수를 구분',scope:'전체 연결 실행',acceptance:'세 상태와 원문 확인',owner:'감독',repoPath:home});
 const work=make();
 const change=(action,fields)=>store.change(work.key,action,fields,{revision:store.get(work.key).revision,by:'감독',note:'격리 시험'});
 change('execute',{title:'화면 확인',body:'카드 지시 원문 · 조회 금지 표식',phase:'implementation',round:1});
 const execution=store.get(work.key).executions[0].key,id=execution.split('/')[1];
 cards.update(execution,{role:'작업자',status:'assigned',board:'시험판',scope:'격리 시험 데이터만',rallyId:'r1',rallyTitle:'묶음',rallyRound:'1',rallyStep:'implementation'},{revision:1,by:'감독',note:'격리 시험 배정'});
 let clock=0;
 const record=value=>{appendLedger({t:new Date(Date.now()+60000+clock++*1000).toISOString(),...value},home);return Math.max(0,...['tasks/events.jsonl','mail/events.jsonl','system/events.jsonl'].flatMap(stream=>readStream(home,stream,{optional:true}).map(e=>e._ledgerOrder)));};
 record({kind:'send',role:'작업자',taskId:id,by:'감독',executionKey:execution,workKey:work.key});
 record({kind:'done',role:'작업자',taskId:id,result:'ok'});
 const mail=(body,extra={})=>{
  const digest=createHash('sha256').update(body).digest('hex').slice(0,12),mailId=randomUUID();saveMailBody(digest,body,home);
  const seq=record({kind:'send',by:'작업자',role:'감독',mailId,digest,workKey:work.key,executionKey:execution,...extra});
  return {ref:`ledger:new:${seq}`,mailId,digest};
 };
 const letter=mail('완료 원문 <script>실행하면 안 됨</script>');
 const handoverId=randomUUID(),handover={id:handoverId,from:'작업자',to:'후임',taskIds:[id],phase:'accepted',receipt:'/격리/인수근거.json'};
 record({kind:'handover',handoverId,from:handover.from,to:handover.to,taskIds:[id],phase:'prepared'});
 record({kind:'handover',handoverId,from:handover.from,to:handover.to,phase:'accepted'});
 fs.mkdirSync(path.join(home,'handovers'));fs.writeFileSync(path.join(home,'handovers',`${handoverId}.json`),JSON.stringify(handover));
 return {home,store,cards,work,execution,id,record,mail,letter,handover,change,make};
}

for(const mode of ['sqlite','jsonl'])test(`${mode}: 완료 신호·미마감 업무·인수 수락을 분리하고 조회가 아무 기록도 쓰지 않는다`,()=>{
 const f=fixture(mode),streams=['ledger.jsonl','tasks/events.jsonl','mail/events.jsonl','system/events.jsonl',`works/${f.work.key}/events.jsonl`,`cards/${f.execution}/events.jsonl`];
 const before=streams.map(s=>readStream(f.home,s,{optional:true})),handFile=path.join(f.home,'handovers',`${f.handover.id}.json`),handBefore=fs.readFileSync(handFile,'utf8');
 const index=operationsFlowIndex(f.home);assert.equal(index.works[0].key,f.work.key);assert.equal(index.works[0].status,'open');
 assert.ok(!('goal'in index.works[0])&&!('executions'in index.works[0]));
 const detail=operationsFlowDetail(f.home,f.work.key);
 assert.equal(detail.work.status,'open');assert.equal(detail.executions[0].reportState,'ok');assert.equal(detail.executions[0].signals[0].by,null);
 assert.equal(detail.handovers[0].accepted,true);assert.equal(detail.handovers[0].phase,'accepted');assert.deepEqual(detail.handovers[0].executionKeys,[f.execution]);
 const body=operationsFlowMail(f.home,f.work.key,f.letter.ref);assert.match(body.body,/<script>/);assert.equal(body.workKey,f.work.key);
 assert.deepEqual(streams.map(s=>readStream(f.home,s,{optional:true})),before);assert.equal(fs.readFileSync(handFile,'utf8'),handBefore);
 assert.ok(!JSON.stringify(detail).includes('완료 원문'));assert.ok(!JSON.stringify(detail).includes('카드 지시 원문'));
});

test('목록·상세는 우편/카드 본문을 읽지 않고 원문 요청에서 한 파일만 읽는다',t=>{
 const f=fixture(),opened=[],original=fs.openSync;
 t.mock.method(fs,'openSync',function(file,...args){if(typeof file==='string'&&(file.includes('/mail/')||file.endsWith('/card.md')))opened.push(file);return original.call(this,file,...args);});
 operationsFlowIndex(f.home);operationsFlowDetail(f.home,f.work.key);assert.deepEqual(opened,[]);
 operationsFlowMail(f.home,f.work.key,f.letter.ref);assert.deepEqual(opened,[path.join(f.home,'mail',`${f.letter.digest}.txt`)]);
});

test('업무 마감·다시 열기·병렬 실행은 저장 기록을 그대로 표시한다',()=>{
 const f=fixture();f.change('complete',{result:'감독의 최종 확인'});
 assert.equal(operationsFlowDetail(f.home,f.work.key).work.status,'done');
 f.change('reopen',{});f.change('execute',{title:'후속 검수',body:'격리 검수 지시',phase:'review',round:2});
 let d=operationsFlowDetail(f.home,f.work.key);assert.equal(d.work.status,'open');assert.equal(d.executions[0].reportState,'ok');assert.equal(d.executions[1].reportState,'unreported');
 const second=d.executions[1];f.record({kind:'done',role:'검수자',taskId:second.id,result:'failed',by:'감독'});
 d=operationsFlowDetail(f.home,f.work.key);assert.equal(d.executions[1].reportState,'failed');assert.equal(d.work.status,'open');
});

test('최초 DONE 규약을 유지하고 재발령 뒤 과거 완료를 현재 완료로 쓰지 않는다',()=>{
 const f=fixture();f.record({kind:'done',role:'작업자',taskId:f.id,result:'failed'});
 assert.equal(operationsFlowDetail(f.home,f.work.key).executions[0].reportState,'ok');
 f.record({kind:'send',role:'작업자',taskId:f.id,by:'감독'});
 f.record({kind:'done',role:'작업자',taskId:f.id,result:'ok'});
 assert.equal(operationsFlowDetail(f.home,f.work.key).executions[0].reportState,'unreported');
});

test('동일 ID가 여러 저장소에 있으면 완료/인수와 옛 task 우편을 자동 연결하지 않는다',()=>{
 const f=fixture();f.cards.create({repo:'other',id:f.id,repoPath:f.home,body:'다른 카드'});
 const old=f.mail('옛 task 우편',{workKey:undefined,executionKey:undefined,taskId:f.id});
 const d=operationsFlowDetail(f.home,f.work.key);assert.equal(d.executions[0].reportState,'unknown');assert.equal(d.handovers.length,0);
 assert.ok(!d.mail.items.some(m=>m.ref===old.ref));assert.throws(()=>operationsFlowMail(f.home,f.work.key,old.ref),/연결된 원문이 아닙니다/);
 assert.equal(d.work.status,'open');
});

test('다른 업무·상충하는 실행 주소의 원문과 유일하지 않은 답장 지문은 노출하지 않는다',()=>{
 const f=fixture(),other=f.make('other/work');
 const foreign=f.mail('다른 업무 원문',{workKey:other.key,executionKey:undefined});
 const conflict=f.mail('상충하는 연결',{executionKey:'other/execution'});
 const duplicate=f.mail('중복 본문'),foreignDuplicate=f.mail('중복 본문',{workKey:other.key,executionKey:undefined});
 const reply=f.mail('어느 편지의 답장인지 모름',{workKey:undefined,executionKey:undefined,replyTo:duplicate.digest});
 const validReply=f.mail('고유 ID 답장',{workKey:undefined,executionKey:undefined,replyTo:duplicate.mailId});
 const d=operationsFlowDetail(f.home,f.work.key);
 for(const letter of [foreign,conflict,reply,foreignDuplicate]){assert.ok(!d.mail.items.some(x=>x.ref===letter.ref));assert.throws(()=>operationsFlowMail(f.home,f.work.key,letter.ref),/연결된 원문이 아닙니다/);}
 assert.ok(d.mail.items.some(x=>x.ref===validReply.ref));
});

test('손상된 연결 원장은 모름이고 업무 저장 상태는 유지한다',()=>{
 const f=fixture('jsonl');fs.appendFileSync(path.join(f.home,'ledger.jsonl'),'손상된 줄\n');
 const d=operationsFlowDetail(f.home,f.work.key);assert.equal(d.work.status,'open');assert.equal(d.mail.total,null);assert.equal(d.handovers,null);assert.equal(d.executions[0].reportState,'unknown');assert.equal(d.errors.length,1);
});

test('인수 파일을 못 읽으면 마지막 원장 상태와 미확인을 함께 표시한다',()=>{
 const f=fixture(),file=path.join(f.home,'handovers',`${f.handover.id}.json`);fs.renameSync(file,file+'.preserved');
 const h=operationsFlowDetail(f.home,f.work.key).handovers[0];assert.equal(h.accepted,true);assert.equal(h.phase,'accepted');assert.match(h.error,/미확인/);
});

test('우편 50통 페이지를 제공하고 본문을 응답에 선적재하지 않는다',()=>{
 const f=fixture();for(let i=0;i<103;i++)f.record({kind:'send',workKey:f.work.key,by:'작업자',role:'감독',mailId:randomUUID(),digest:'a'.repeat(12)});
 const a=operationsFlowDetail(f.home,f.work.key),b=operationsFlowDetail(f.home,f.work.key,{page:3});
 assert.equal(a.mail.items.length,50);assert.equal(a.mail.total,106);assert.equal(b.mail.items.length,6);assert.equal(b.mail.page,3);
 assert.ok(a.mail.items.every(m=>!('body'in m)&&!('preview'in m)));
});

test('원문 주소 우회·없는 원문·심볼릭 링크는 읽지 않는다',()=>{
 const f=fixture();assert.throws(()=>operationsFlowDetail(f.home,'../outside'),/업무 주소/);
 assert.throws(()=>operationsFlowMail(f.home,f.work.key,'../../outside'),/기록 주소/);
 const bad=f.mail('잘못된 지문',{digest:'../../outside'});assert.throws(()=>operationsFlowMail(f.home,f.work.key,bad.ref),/참조/);
 const file=path.join(f.home,'mail',`${f.letter.digest}.txt`);fs.renameSync(file,file+'.preserved');
 assert.throws(()=>operationsFlowMail(f.home,f.work.key,f.letter.ref),/파일이 없습니다/);
 fs.symlinkSync(file+'.preserved',file);assert.throws(()=>operationsFlowMail(f.home,f.work.key,f.letter.ref),/읽을 수 없습니다/);
});

test('전용 GET은 전체 관제 수집·쓰기·통지를 호출하지 않으며 기존 화면은 유지한다',async()=>{
 const f=fixture();let snapshots=0,notifications=0;
 const server=createWallServer(()=>{snapshots++;throw new Error('관제 전체 수집 금지');},{home:f.home,notify:()=>notifications++});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`,url=base+'/api/operations-flow?'+new URLSearchParams({work:f.work.key});
 const streams=['ledger.jsonl','tasks/events.jsonl','mail/events.jsonl','system/events.jsonl'];
 const before=streams.map(name=>readStream(f.home,name,{optional:true}));
 try{
  assert.equal((await fetch(base+'/api/operations-flow')).status,200);
  const d=await(await fetch(url)).json();assert.equal(d.work.status,'open');
  assert.equal((await fetch(url,{method:'POST'})).status,405);
  assert.equal((await fetch(url,{headers:{Origin:'https://outside.example'}})).status,403);
  assert.equal(await new Promise(resolve=>http.get(url,{headers:{Host:'outside.example'}},res=>{res.resume();resolve(res.statusCode);})),403);
  const body=await(await fetch(base+'/api/operations-flow/mail?'+new URLSearchParams({work:f.work.key,ref:f.letter.ref}))).json();assert.match(body.body,/완료 원문/);
  assert.equal(snapshots,0);assert.equal(notifications,0);assert.deepEqual(streams.map(name=>readStream(f.home,name,{optional:true})),before);
 }finally{await new Promise(resolve=>server.close(resolve));}
 const html=renderCenterWall({center:{cards:[],roles:[],boards:[],unregistered:[]},entries:[],collectedAt:new Date()});
 for(const route of ['dashboard','decisions','ledger'])assert.ok(html.includes(`data-route="${route}"`));
 // 업무 흐름은 위 메뉴가 아니라 작업 화면의 보기 전환에서 연다(2026-09-24 UX 3차).
 assert.ok(!html.includes('data-route="operations-flow"'));assert.match(html,/<a class="dw-layout-link" href="#operations-flow"[^>]*>업무 흐름<\/a>/);
 for(const view of ['status','dashboard','decisions','ledger','sessions','mailbox','runs','operations-flow'])assert.ok(html.includes(`data-view="${view}"`));
 const flow=html.match(/<section id="operations-flow"[\s\S]*?<\/section>/)[0];assert.ok(!flow.includes('<form'));assert.match(flow,/ hidden/);
});

test('과거 seq와 신규 순번이 같아도 원문 참조가 충돌하지 않고 옛 주소는 과거 원문만 가리킨다',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-operations-refs-'));
 createDatabase(home);writeStorageMarker(home,'sqlite');
 const work=new WorkStore(home).create({key:'repo/refs',title:'원문 구분',goal:'과거와 신규 구분',scope:'격리 기록',acceptance:'원문 확인',owner:'boss',repoPath:home});
 const oldBody='과거 원문',newBody='새 원문';
 const oldDigest=createHash('sha256').update(oldBody).digest('hex'),newDigest=createHash('sha256').update(newBody).digest('hex');
 saveMailBody(oldDigest,oldBody,home);saveMailBody(newDigest,newBody,home);
 const old={kind:'send',mailId:randomUUID(),workKey:work.key,by:'worker',role:'boss',digest:oldDigest};
 appendStream(home,'ledger.jsonl',old);
 appendLedger({...old,mailId:randomUUID(),digest:newDigest},home);
 const detail=operationsFlowDetail(home,work.key);
 assert.equal(detail.mail.total,2);assert.deepEqual(detail.mail.items.map(m=>m.ref),['ledger:new:1','ledger:legacy:1']);
 assert.equal(operationsFlowMail(home,work.key,'ledger:new:1').body,newBody);
 assert.equal(operationsFlowMail(home,work.key,'ledger:legacy:1').body,oldBody);
 assert.equal(operationsFlowMail(home,work.key,'ledger:1').body,oldBody);
 assert.deepEqual(readStream(home,'ledger.jsonl'),[old]);
});

test('새 완료 결과 우편은 실행 담당을 늘리지 않고 읽음·중간 답장·최종 답변·취소를 조회한다',()=>{
 const f=fixture();
 let detail=operationsFlowDetail(f.home,f.work.key);
 assert.equal(detail.executions[0].reportState,'ok');
 assert.deepEqual(detail.executions[0].signals.map(s=>s.role),['작업자']);
 const completions=detail.mail.items.filter(m=>m.completion);
 assert.equal(completions.length,1);assert.equal(completions[0].notificationOnly,true);assert.equal(completions[0].read,false);
 const q=f.mail('답변할 질문',{expectReply:true});
 f.record({kind:'mail-read',mailId:q.mailId,role:'감독',by:'감독'});
 f.mail('중간 답장',{replyTo:q.mailId,by:'감독',role:'작업자'});
 detail=operationsFlowDetail(f.home,f.work.key);
 assert.equal(detail.mail.items.find(m=>m.mailId===q.mailId).read,true);
 assert.equal(detail.mail.items.find(m=>m.mailId===q.mailId).replyStatus,'waiting');
 f.mail('최종 답변',{replyTo:q.mailId,by:'감독',role:'작업자',replyFinal:true});
 assert.equal(operationsFlowDetail(f.home,f.work.key).mail.items.find(m=>m.mailId===q.mailId).replyStatus,'answered');
 const cancelled=f.mail('취소할 질문',{expectReply:true});
 f.record({kind:'mail-cancel',mailId:cancelled.mailId,role:'감독',by:'작업자'});
 detail=operationsFlowDetail(f.home,f.work.key);
 assert.equal(detail.mail.items.find(m=>m.mailId===cancelled.mailId).replyStatus,'cancelled');
 assert.equal(detail.executions[0].reportState,'ok');
});

for(const mode of ['sqlite','jsonl'])test(`${mode}: 카드 없는 연속 인계도 우편 현재 책임에 반영하고 원본·조회 전후 기록을 보존한다`,()=>{
 const f=fixture(mode),q=f.mail('인계 뒤 답할 질문',{expectReply:true});
 f.record({kind:'handover',phase:'transferred',handoverId:randomUUID(),from:'감독',to:'다음감독',taskIds:[]});
 f.record({kind:'handover',phase:'transferred',handoverId:randomUUID(),from:'다음감독',to:'최종감독',taskIds:[]});
 f.record({kind:'handover',phase:'transferred',handoverId:randomUUID(),from:'작업자',to:'다음작업자',taskIds:[]});
 f.record({kind:'mail-read',mailId:q.mailId,role:'최종감독',by:'최종감독'});
 const streams=['ledger.jsonl','tasks/events.jsonl','mail/events.jsonl','system/events.jsonl'];
 const before=streams.map(name=>readStream(f.home,name,{optional:true}));
 const detail=operationsFlowDetail(f.home,f.work.key),letter=detail.mail.items.find(m=>m.mailId===q.mailId);
 assert.equal(letter.by,'작업자');assert.equal(letter.to,'감독');
 assert.equal(letter.currentSender,'다음작업자');assert.equal(letter.currentRecipient,'최종감독');
 assert.equal(letter.read,true);assert.equal(letter.replyStatus,'waiting');
 const body=operationsFlowMail(f.home,f.work.key,q.ref);
 assert.equal(body.body,'인계 뒤 답할 질문');assert.equal(body.currentRecipient,'최종감독');assert.equal(body.currentSender,'다음작업자');
 assert.deepEqual(streams.map(name=>readStream(f.home,name,{optional:true})),before);
 assert.equal(detail.handovers.length,1); // 우편 책임용 인계를 실행 인수 목록에 추가하지 않는다.
});
