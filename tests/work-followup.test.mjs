import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {WorkStore} from '../src/work-store.mjs';
import {CardStore} from '../src/card-store.mjs';
import {DecisionStore} from '../src/decisions.mjs';
import {createDatabase,writeStorageMarker,readStream,appendStream} from '../src/storage.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {operationsFlowDetail,operationsFlowIndex} from '../src/operations-flow.mjs';
import {workCommand} from '../src/work-command.mjs';
import {elapsed} from '../src/work-followup.mjs';

function fixture(mode='sqlite',phase='review'){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-followup-'));
 if(mode==='sqlite'){createDatabase(home);writeStorageMarker(home,'sqlite');}
 const works=new WorkStore(home),cards=new CardStore(home),key='test/work';
 works.create({key,title:'종료 후속',goal:'다음 담당 확인',scope:'격리 시험',acceptance:'근거와 후속 분리',owner:'감독',repoPath:home});
 const change=(action,fields)=>works.change(key,action,fields,{revision:works.get(key).revision,by:'감독',note:'시험 판단'});
 const add=(phase,round=1)=>{
  change('execute',{title:phase,body:'읽지 않는 본문',phase,round});const link=works.get(key).executions.at(-1);
  cards.update(link.key,{status:'assigned',role:phase,scope:'시험',board:'test',rallyId:'work',rallyTitle:'시험',rallyRound:String(round),rallyStep:phase},{revision:1,note:'시험 배정'});
  return link.key;
 };
 const execution=add(phase),id=execution.split('/')[1],start=Date.now();
 const send=(key=execution,role=phase,t=Date.now())=>appendLedger({kind:'send',role,taskId:key,executionKey:key,by:'감독',t:new Date(t).toISOString()},home);
 send();
 const done=(result='ok',key=execution,role=phase,t=Date.now())=>appendLedger({kind:'done',role,taskId:key,executionKey:key,result,t:new Date(t).toISOString()},home);
 const report=(outcome,key=execution)=>{const c=cards.get(key);fs.writeFileSync(c.resultPath,'등록한 결과');cards.report(key,{revision:c.revision,outcome,by:c.role});};
 const detail=()=>operationsFlowDetail(home,key);
 const decisions=new DecisionStore(home,{notify:()=>{throw new Error('격리 전달 실패');}});
 return {home,works,cards,key,execution,id,start,change,add,send,done,report,detail,decisions};
}

for(const mode of ['jsonl','sqlite'])test(`${mode}: 수동 DONE과 품질 판정 분리, CLI·목록·상세 일치, 조회는 무쓰기`,()=>{
 const f=fixture(mode);f.done();
 let d=f.detail();assert.equal(d.work.status,'open');assert.equal(d.followup.state,'confirm');assert.equal(d.executions[0].quality,null);
 f.report('changes');d=f.detail();assert.equal(d.followup.state,'fix');assert.equal(d.followup.owner,'감독');
 const streams=['tasks/events.jsonl','mail/events.jsonl','decisions/events.jsonl',`works/${f.key}/events.jsonl`,`cards/${f.execution}/events.jsonl`];
 const before=streams.map(s=>readStream(f.home,s,{optional:true}));
 const cli=workCommand(['show',f.key],{},{home:f.home,by:'사람'});
 assert.deepEqual(cli.followup,d.followup);const {executions,...summary}=d.followup;assert.deepEqual(operationsFlowIndex(f.home).works[0].followup,summary);
 assert.deepEqual(streams.map(s=>readStream(f.home,s,{optional:true})),before);
 assert.ok(d.executions[0].timing.dispatchToDoneMs>=0);assert.ok(d.executions[0].timing.dispatchToResultMs>=0);
 assert.equal(d.timing.actualWorkMs,null);assert.equal(d.timing.completionConfirmationMs,null);
});

test('구현 완료 뒤 새 검수 연결을 우선하고 검수 합격을 후속으로 연결한다',()=>{
 const f=fixture('sqlite','implementation');f.done();f.report('implemented');assert.equal(f.detail().followup.state,'review');
 const review=f.add('review',2);f.send(review,'review');assert.equal(f.detail().followup.state,'unspecified');
 f.done('ok',review,'review');f.report('pass',review);assert.equal(f.detail().followup.state,'confirm');
});

test('결정 요청만으로 진행 실행을 완료·보류로 바꾸지 않고 병렬 담당을 보존한다',()=>{
 const f=fixture(),other=f.add('implementation');f.send(other,'implementation');
 const c=f.cards.get(other);f.cards.update(other,{activity:'running'},{revision:c.revision,by:'implementation',noteKind:'progress',note:'진행'});
 const d=f.decisions.request(f.execution,{question:'범위 확대?',options:['유지','확대'],recommendation:'유지',reason:'범위 판단'},'슈퍼감독');
 let view=f.detail();assert.equal(view.followup.state,'parallel');
 assert.equal(view.followup.executions.find(x=>x.key===other).state,'running');
 assert.match(view.followup.executions.find(x=>x.key===f.execution).next,/보류·대기 연결 확인/);
 assert.equal(f.cards.get(f.execution).status,'assigned');
 f.decisions.answer(d.id,{revision:d.revision,choice:'유지'},'사람');view=f.detail();
 assert.equal(view.followup.executions.find(x=>x.key===f.execution).state,'answer');
 assert.match(view.followup.executions.find(x=>x.key===f.execution).next,/전달 실패/);
});

test('현재 보류·외부 대기와 종료를 구분하고 옛 결과는 새 발령의 합격이 아니다',()=>{
 const f=fixture();let c=f.cards.get(f.execution);
 f.cards.update(c.key,{activity:'waiting'},{revision:c.revision,by:c.role,noteKind:'progress',note:'외부 결과 대기'});
 assert.equal(f.detail().followup.state,'waiting');f.done();f.report('pass');
 assert.equal(f.detail().followup.state,'confirm');
 f.send(f.execution,'review',Date.now()+1000);
 const d=f.detail();assert.notEqual(d.followup.state,'confirm');assert.equal(d.executions[0].quality,null);
 c=f.cards.get(f.execution);f.cards.update(c.key,{status:'hold',nextAction:'답변 뒤 재개'},{revision:c.revision,note:'보류'});
 assert.equal(f.detail().followup.state,'hold');
});

test('음수 시간과 모호한 주소는 빠른 성공으로 표시하지 않는다',()=>{
 assert.equal(elapsed('2026-01-02','2026-01-01'),null);
 const f=fixture();f.done('ok',f.execution,'review',f.start-1000);
 assert.equal(f.detail().followup.state,'unknown');assert.equal(f.detail().executions[0].timing.dispatchToDoneMs,null);
});

test('자동 PASS·3라운드 경계·총 상한·예외가 다음 담당으로 연결되고 이후 실행은 옛 자동 상태를 쓰지 않는다',()=>{
 for(const status of ['pass','boundary','limit','exception']){
  const f=fixture();f.done();f.report(status==='pass'?'pass':'changes');
  appendStream(f.home,`automatic-review/${f.key}/events.jsonl`,{key:f.key,revision:1,links:f.works.get(f.key).executions,current:{key:f.execution},status,at:new Date().toISOString(),notification:{status:'sent'}});
  assert.equal(f.detail().followup.state,({pass:'confirm',boundary:'boundary',limit:'limit',exception:'exception'})[status]);
  const next=f.add('fix',2);f.send(next,'fix');assert.equal(f.detail().followup.state,'unspecified');
 }
});

test('업무의 새 후속 판단을 표시하고 전체 완료는 별도 기록으로 유지한다',()=>{
 const f=fixture();f.done();f.report('pass');f.change('update',{nextAction:'승인된 미리보기 적용',turnOwner:'배포담당'});
 const d=f.detail();assert.equal(d.followup.next,'승인된 미리보기 적용');assert.equal(d.followup.owner,'배포담당');assert.equal(d.work.status,'open');
 f.change('complete',{result:'전체 결과 확인'});assert.equal(f.detail().followup.state,'closed');assert.equal(f.detail().timing.pending,false);
});

test('근거 읽기 실패는 다음 행동 미지정으로 축소하지 않는다',()=>{
 const f=fixture('jsonl');fs.mkdirSync(path.join(f.home,'decisions'),{recursive:true});fs.appendFileSync(path.join(f.home,'decisions','events.jsonl'),'{broken\n',{flag:'a'});
 assert.equal(f.detail().followup.state,'unknown');
});

test('지난 실패는 보존하되 새 라운드의 합격과 명시 연결 감시 호출을 구분한다',()=>{
 const f=fixture();f.done('failed');
 const review=f.add('review',2);f.send(review,'review');f.done('ok',review,'review');f.report('pass',review);
 appendLedger({kind:'watch-ai-call',role:'review',taskId:review,requestId:'linked'},f.home);
 appendLedger({kind:'watch-ai-call',role:'review',requestId:'unlinked'},f.home);
 const d=f.detail();assert.equal(d.followup.state,'confirm');assert.equal(d.executions[0].reportState,'failed');
 assert.equal(d.timing.linkedWatchCalls,1);assert.equal(d.timing.watchCost,null);
});
