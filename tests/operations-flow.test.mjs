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
 const record=value=>{appendLedger({t:new Date(Date.now()+60000+clock++*1000).toISOString(),...value},home);return readStream(home,'ledger.jsonl').length;};
 record({kind:'send',role:'작업자',taskId:id,by:'감독',executionKey:execution,workKey:work.key});
 record({kind:'done',role:'작업자',taskId:id,result:'ok'});
 const mail=(body,extra={})=>{
  const digest=createHash('sha256').update(body).digest('hex').slice(0,12),mailId=randomUUID();saveMailBody(digest,body,home);
  const seq=record({kind:'send',by:'작업자',role:'감독',mailId,digest,workKey:work.key,executionKey:execution,...extra});
  return {ref:`ledger:${seq}`,mailId,digest};
 };
 const letter=mail('완료 원문 <script>실행하면 안 됨</script>');
 const handoverId=randomUUID(),handover={id:handoverId,from:'작업자',to:'후임',taskIds:[id],phase:'accepted',receipt:'/격리/인수근거.json'};
 record({kind:'handover',handoverId,from:handover.from,to:handover.to,taskIds:[id],phase:'prepared'});
 record({kind:'handover',handoverId,from:handover.from,to:handover.to,phase:'accepted'});
 fs.mkdirSync(path.join(home,'handovers'));fs.writeFileSync(path.join(home,'handovers',`${handoverId}.json`),JSON.stringify(handover));
 return {home,store,cards,work,execution,id,record,mail,letter,handover,change,make};
}

for(const mode of ['sqlite','jsonl'])test(`${mode}: 완료 신호·미마감 업무·인수 수락을 분리하고 조회가 아무 기록도 쓰지 않는다`,()=>{
 const f=fixture(mode),streams=['ledger.jsonl',`works/${f.work.key}/events.jsonl`,`cards/${f.execution}/events.jsonl`];
 const before=streams.map(s=>readStream(f.home,s)),handFile=path.join(f.home,'handovers',`${f.handover.id}.json`),handBefore=fs.readFileSync(handFile,'utf8');
 const index=operationsFlowIndex(f.home);assert.equal(index.works[0].key,f.work.key);assert.equal(index.works[0].status,'open');
 assert.ok(!('goal'in index.works[0])&&!('executions'in index.works[0]));
 const detail=operationsFlowDetail(f.home,f.work.key);
 assert.equal(detail.work.status,'open');assert.equal(detail.executions[0].reportState,'ok');assert.equal(detail.executions[0].signals[0].by,null);
 assert.equal(detail.handovers[0].accepted,true);assert.equal(detail.handovers[0].phase,'accepted');assert.deepEqual(detail.handovers[0].executionKeys,[f.execution]);
 const body=operationsFlowMail(f.home,f.work.key,f.letter.ref);assert.match(body.body,/<script>/);assert.equal(body.workKey,f.work.key);
 assert.deepEqual(streams.map(s=>readStream(f.home,s)),before);assert.equal(fs.readFileSync(handFile,'utf8'),handBefore);
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

test('우편 100통 페이지를 제공하고 본문을 응답에 선적재하지 않는다',()=>{
 const f=fixture();for(let i=0;i<103;i++)f.record({kind:'send',workKey:f.work.key,by:'작업자',role:'감독',mailId:randomUUID(),digest:'a'.repeat(12)});
 const a=operationsFlowDetail(f.home,f.work.key),b=operationsFlowDetail(f.home,f.work.key,{page:2});
 assert.equal(a.mail.items.length,100);assert.equal(a.mail.total,105);assert.equal(b.mail.items.length,5);assert.equal(b.mail.page,2);
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
 const before=readStream(f.home,'ledger.jsonl');
 try{
  assert.equal((await fetch(base+'/api/operations-flow')).status,200);
  const d=await(await fetch(url)).json();assert.equal(d.work.status,'open');
  assert.equal((await fetch(url,{method:'POST'})).status,405);
  assert.equal((await fetch(url,{headers:{Origin:'https://outside.example'}})).status,403);
  assert.equal(await new Promise(resolve=>http.get(url,{headers:{Host:'outside.example'}},res=>{res.resume();resolve(res.statusCode);})),403);
  const body=await(await fetch(base+'/api/operations-flow/mail?'+new URLSearchParams({work:f.work.key,ref:f.letter.ref}))).json();assert.match(body.body,/완료 원문/);
  assert.equal(snapshots,0);assert.equal(notifications,0);assert.deepEqual(readStream(f.home,'ledger.jsonl'),before);
 }finally{await new Promise(resolve=>server.close(resolve));}
 const html=renderCenterWall({center:{cards:[],roles:[],boards:[],unregistered:[]},entries:[],collectedAt:new Date()});
 for(const route of ['dashboard','decisions','ledger','operations-flow'])assert.ok(html.includes(`data-route="${route}"`));
 for(const view of ['status','dashboard','decisions','ledger','sessions','mailbox','runs','operations-flow'])assert.ok(html.includes(`data-view="${view}"`));
 const flow=html.match(/<section id="operations-flow"[\s\S]*?<\/section>/)[0];assert.ok(!flow.includes('<form'));assert.match(flow,/ hidden/);
});
