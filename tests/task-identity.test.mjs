import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {taskIdentity} from '../src/task-identity.mjs';
import {CardStore} from '../src/card-store.mjs';
import {appendLedger,readLedger} from '../src/ledger.mjs';
import {readStream,createDatabase,writeStorageMarker} from '../src/storage.mjs';
import {buildCardCenter} from '../src/card-center.mjs';
import {buildTree,guardedSend,planCards,confirmDone,runWaitLoop} from '../src/cli.mjs';
import {buildWatchScope,buildSupervisorScope} from '../src/watch-scope.mjs';
import {workEntries,effectiveCardRole,openTaskIds} from '../src/handover-state.mjs';
import {resolveWorkMail,workLetters} from '../src/work-mail.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {watchResponsibility} from '../src/watch-report.mjs';
import {assessMissingStartReports,alertedStartReports} from '../src/watch-start-report.mjs';
import {executionHealth} from '../src/dashboard-execution.mjs';
import {DecisionStore} from '../src/decisions.mjs';
const t=n=>new Date(Date.UTC(2026,0,1,0,n)).toISOString();
const card=(repo='r',role='p-worker')=>({id:'c',key:`${repo}/c`,repo,role,status:'assigned',scope:'local',board:'p',at:t(0),history:[],workType:'execution'});
const send=(taskId='c',role='p-worker',extra={})=>({kind:'send',role,session:`kadan-${role}`,taskId,t:t(1),...extra});
const done=(taskId='c',result='ok',extra={})=>({...send(taskId),kind:'done',result,t:t(2),...extra});
const start={kind:'start',role:'p-worker',session:'kadan-p-worker',panePid:11,t:t(0)};
const alive={'kadan-p-worker':{alive:true,pid:11}};
const center=(cards,entries)=>buildCardCenter({cards,entries,tree:buildTree([start,...entries],alive,cards)});
function fixture(mode='jsonl'){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-task-identity-'));
 if(mode==='sqlite'){createDatabase(home);writeStorageMarker(home,'sqlite');}
 const store=new CardStore(home),c=store.create({repo:'r',id:'c',repoPath:home,body:'# local'});
 store.update(c.key,{status:'assigned',role:'p-worker',board:'p',scope:'local',rallyId:'rally',rallyTitle:'rally',rallyRound:'1',rallyStep:'implementation'},{revision:1,note:'approved'});
 return {home,store,env:{KADAN_HOME:home},cards:store.list()};
}

test('두 주소의 send/done 양방향, 최초 done, 역할별 실행, 재발령을 같은 계산으로 읽는다',()=>{
 for(const [s,d] of [['c','r/c'],['r/c','c']]){
  const cards=[card()],entries=[send(s),done(d,'failed'),done(s,'ok',{t:t(3)})];
  assert.equal(center(cards,entries).cards[0].displayState,'failed');
  assert.equal(buildTree(entries,alive,cards)[0].roles[0].cards[0].result,'failed');
  assert.equal(buildWatchScope(cards,entries).sessions.size,0);
  assert.deepEqual(openTaskIds(entries,'p-worker',cards),[]);
  assert.equal(center(cards,[...entries,send(s,'other')]).cards[0].runs.length,2);
  assert.equal(buildWatchScope(cards,[...entries,send(s,'p-worker',{t:t(4)})]).sessions.size,1);
 }
});

test('동명 full key는 구분, bare는 모호함, 틀린 repo는 연결 실패, legacy bare는 미등록',()=>{
 const cards=[card(),card('s')],entries=[send('r/c'),done('s/c'),send('c'),send('wrong/c'),send('legacy')];
 const result=center(cards,entries);
 assert.equal(result.cards.find(c=>c.key==='r/c').runs.length,1);
 assert.equal(result.cards.find(c=>c.key==='s/c').runs[0].state,'done');
 assert.equal(result.unregistered.length,3);
 assert.equal(result.unregistered.find(r=>r.taskId==='legacy').connectionLabel,'중앙 카드 미등록');
 assert.equal(result.unregistered.find(r=>r.taskId==='wrong/c').connectionLabel,'기록 연결 실패');
 assert.equal(executionHealth(result.cards[0]).healthLabel,'기록 연결 실패');
 assert.deepEqual(buildWatchScope(cards,entries).entries.map(e=>e.taskId),['r/c']);
 const valid=center(cards,[send('r/c'),done('s/c')]);
 assert(valid.cards.every(c=>!c.ambiguous));
});

for(const mode of ['jsonl','sqlite'])test(`${mode}: 원문 보존, 충돌 done이 뒤 정상 done의 최초 완료를 소모하지 않는다`,()=>{
 const f=fixture(mode),rows=[send(),done('wrong','failed',{executionKey:'r/c'}),done('c','ok',{executionKey:'r/c'}),done('r/c','failed')];
 for(const row of rows)appendLedger(row,f.home);
 const snapshot=()=>['tasks/events.jsonl','mail/events.jsonl','system/events.jsonl','ledger.jsonl'].map(stream=>readStream(f.home,stream,{optional:true}));
 const before=JSON.stringify(snapshot());
 const raw=readLedger(f.home);
 assert.deepEqual(raw.map(e=>e.taskId),rows.map(e=>e.taskId));
 assert.equal(center(f.cards,raw).cards[0].runs[0].state,'done');
 assert.equal(buildWatchScope(f.cards,raw).sessions.size,0);
 assert.equal(JSON.stringify(snapshot()),before);
});

test('missing/conflict done은 연결된 실행을 끝내거나 인계하지 못한다',()=>{
 for(const bad of [done('c','failed',{executionKey:'missing/c'}),done('wrong','failed',{executionKey:'r/c'}),done('r/c','failed',{executionKey:'s/c'})]){
  const cards=[card(),card('s')],entries=[send('r/c'),bad];
  assert.equal(buildWatchScope(cards,entries).sessions.size,1);
  assert.equal(center(cards,entries).cards.find(c=>c.key==='r/c').runs[0].state,'unconfirmed');
  assert.deepEqual(openTaskIds(entries,'p-worker',cards),['r/c']);
 }
});

test('인계는 전체 목록으로만 bare 별칭을 판단하고 서로 다른 카드/역할은 보존한다',()=>{
 const cards=[card(),card('s')],transfer={kind:'handover',phase:'transferred',from:'p-worker',to:'next',taskIds:['c'],t:t(3)};
 assert.equal(effectiveCardRole(cards[0],[transfer],cards),'p-worker');
 assert.equal(effectiveCardRole(cards[1],[transfer],cards),'p-worker');
 assert.equal(effectiveCardRole(cards[0],[transfer]),'p-worker');
 assert.equal(effectiveCardRole({id:'c',role:'p-worker'},[transfer]),'p-worker');
 const full={...transfer,taskIds:['r/c']};
 const entries=[send('r/c'),send('s/c'),full,done('r/c','ok',{role:'next'})];
 assert.equal(effectiveCardRole(cards[0],entries,cards),'next');
 assert.equal(effectiveCardRole(cards[1],entries,cards),'p-worker');
 assert.equal(center(cards,entries).cards.find(c=>c.key==='r/c').runs[0].state,'done');
 assert.deepEqual(openTaskIds(entries,'p-worker',cards),['s/c']);
 assert.equal(workEntries(entries,cards).find(e=>e.kind==='send'&&e.taskId==='r/c').inheritedFrom,'p-worker');
});

test('전체 주소도 send 상태/담당/범위 guard를 적용하며 raw 옵션도 우회하지 못한다',()=>{
 const f=fixture();let sent=0;const records=[];
 const args={floor:{name:'tmux',alive:()=>true,pid:()=>'11',send:()=>{sent++;return {}}},session:start.session,role:'p-worker',taskId:'r/c',raw:true,message:'go',env:f.env,recordedPid:11,record:e=>records.push(e),readEntries:()=>[{...start,cmd:'codex --model test-model'}],saveBody:()=>{}};
 guardedSend(args);assert.equal(sent,1);assert.equal(records[0].taskId,'c');assert.equal(records[0].executionKey,'r/c');assert.equal(records[0].rawTaskId,'r/c');
 assert.throws(()=>guardedSend({...args,role:'other'}),/발령 불가/);
 assert.throws(()=>guardedSend({...args,taskId:'wrong/c'}),/연결 실패/);
 const held=f.store.update('r/c',{status:'hold'},{revision:2,note:'hold'});
 assert.throws(()=>guardedSend(args),/발령 불가/);
 assert.throws(()=>f.store.checkSend('r/c','p-worker',[{...held,status:'assigned',scope:''}]),/발령 불가/);
 assert.equal(sent,1);
});

test('send/plan/manual done/DONE 수집은 같은 주소를 기록하고 중복 별칭은 원장 쓰기 전에 거절',()=>{
 const f=fixture(),records=[];
 planCards({board:'p',taskIds:['r/c'],env:f.env,record:e=>records.push(e)});
 assert.equal(records[0].taskId,'c');assert.equal(records[0].executionKey,'r/c');
 assert.throws(()=>planCards({board:'p',taskIds:['r/c','c'],env:f.env,record:e=>records.push(e)}),/중복/);
 assert.throws(()=>planCards({board:'p',taskIds:['legacy','wrong/c'],env:f.env,record:e=>records.push(e)}),/연결 실패/);
 assert.equal(records.length,1);
 const result=confirmDone({entries:[start,send()],role:'p-worker',taskId:'r/c',result:'ok',env:f.env,record:e=>records.push(e)});
 assert.equal(result.executionKey,'r/c');
 assert.throws(()=>confirmDone({entries:[start,done('r/c')],role:'p-worker',taskId:'c',result:'ok',env:f.env,record:e=>records.push(e)}),/이미 완료/);
 const wait=runWaitLoop({floor:{name:'tmux',read:()=>({text:'KADAN:DONE r/c ok\n'})},session:start.session,role:'p-worker',baselineMarkers:[],snapshotHome:f.home,intervalMs:1,timeoutMs:1,quietMs:1,record:e=>records.push(e)});
 assert.equal(wait.code,0);assert.equal(records.at(-1).executionKey,'r/c');assert.equal(records.at(-1).taskId,'c');
 const duplicate=f.store.create({repo:'s',id:'c',repoPath:f.home,body:'# second'});
 assert.throws(()=>f.store.checkSend('c','p-worker'),/연결 실패/);
 assert.throws(()=>confirmDone({entries:[start],role:'p-worker',taskId:'c',result:'ok',env:f.env,record:()=>{}}),/연결 실패/);
 assert.throws(()=>runWaitLoop({floor:{read:()=>({text:'KADAN:DONE c ok\n'})},role:'p-worker',session:start.session,baselineMarkers:[],cards:f.store.list(),record:()=>{throw Error('unexpected write')}}),/연결 실패/);
 assert.equal(taskIdentity(f.store.list()).write(duplicate.key).taskId,'s/c');
});

test('작업 우편/감독 책임은 full key를 연결하고 다른 저장소 이름을 붙이지 않는다',()=>{
 const f=fixture(),store=new WorkStore(f.home);
 let work=store.create({key:'r/w',title:'work',goal:'result',scope:'local',acceptance:'tests',owner:'p-boss',repoPath:f.home,board:'p'});
 work=store.change(work.key,'link',{execution:'r/c',phase:'implementation',round:1},{revision:work.revision,note:'link'});
 assert.deepEqual(resolveWorkMail(f.home,{taskId:'r/c'}),{workKey:'r/w',executionKey:'r/c'});
 assert.throws(()=>resolveWorkMail(f.home,{taskId:'wrong/c'}),/연결 실패/);
 assert.equal(workLetters(work,[send('r/c'),send('wrong/c')],f.cards).length,1);
 const parents=new Map([['p-worker','p-boss'],['p-boss','top'],['top','@user']]);
 assert(buildSupervisorScope(f.cards,[send('r/c'),done('c')],parents,[work]).sessions.has('kadan-p-boss'));
});

test('유일한 카드의 경보 ID/책임 지문/해소 기록은 주소를 바꿔 읽어도 그대로다',()=>{
 const cards=[card()],raw=[start,send()],full=[start,send('r/c')];
 assert.equal(watchResponsibility('p-worker',cards,raw,new Map()),watchResponsibility('p-worker',cards,full,new Map()));
 const observations=new Map([[start.session,{alive:true,pid:11,expectedPid:11,digest:'x',screen:'idle'}]]),now=Date.parse(t(10));
 const before=assessMissingStartReports(cards,raw,observations,now,1000);
 const after=assessMissingStartReports(cards,full,observations,now,1000);
 assert.equal(before.length,1);assert.deepEqual(after,before);
 const alerted=alertedStartReports([{kind:'alert',id:before[0].id,resolved:true}]);
 assert.deepEqual(assessMissingStartReports(cards,full,observations,now,1000,{alerted}),[]);
});

test('사용자 결정 답변은 무관한 인계를 따르지 않고 실제 카드의 인계만 따른다',()=>{
 const f=fixture(),notices=[],store=new DecisionStore(f.home,{notify:role=>notices.push(role)});
 const request=store.request('r/c',{question:'choose',options:['a','b'],recommendation:'a',reason:'needed /r/c/result.md'},'p-슈퍼감독');
 appendLedger({kind:'handover',phase:'transferred',from:'p-슈퍼감독',to:'wrong',taskIds:['unrelated'],t:'2099-01-01T00:00:00Z'},f.home);
 store.answer(request.id,{revision:1,choice:'a'},'사람');assert.deepEqual(notices,['p-슈퍼감독']);
});

test('동명 카드의 전체 주소 쓰기와 같은 역할의 두 done은 원문에서도 분리한다',()=>{
 const f=fixture('sqlite');
 const second=f.store.create({repo:'s',id:'c',repoPath:f.home,body:'# second'});
 f.store.update(second.key,{status:'assigned',role:'p-worker',board:'p',scope:'local',rallyId:'two',rallyTitle:'two',rallyRound:'1',rallyStep:'implementation'},{revision:1,note:'approved'});
 const record=e=>appendLedger(e,f.home),cards=f.store.list();
 planCards({board:'p',taskIds:['r/c','s/c'],env:f.env,record});
 const args={floor:{name:'tmux',alive:()=>true,pid:()=>'11',send:()=>({})},session:start.session,role:'p-worker',raw:true,message:'go',env:f.env,recordedPid:11,record,readEntries:()=>[{...start,cmd:'codex --model test-model'}],saveBody:()=>{}};
 for(const key of ['r/c','s/c'])guardedSend({...args,taskId:key});
 for(const [taskId,result] of [['r/c','failed'],['s/c','ok']])confirmDone({entries:[start,...readLedger(f.home)],role:'p-worker',taskId,result,env:f.env,record});
 const rows=readLedger(f.home);
 assert.deepEqual(rows.filter(e=>e.kind==='done').map(e=>[e.taskId,e.executionKey,e.result]),[['r/c','r/c','failed'],['s/c','s/c','ok']]);
 const result=center(cards,rows);
 assert.equal(result.cards.find(c=>c.key==='r/c').runs[0].state,'failed');
 assert.equal(result.cards.find(c=>c.key==='s/c').runs[0].state,'done');
 assert.equal(result.unregistered.length,0);
 assert.equal(buildWatchScope(cards,rows).sessions.size,0);
});

test('전체 주소 완료는 업무 최종 완료 검사에서도 종료로 연결한다',()=>{
 const f=fixture(),works=new WorkStore(f.home);
 let w=works.create({key:'r/work',title:'work',goal:'result',scope:'local',acceptance:'tests',owner:'p-boss',repoPath:f.home});
 w=works.change(w.key,'link',{execution:'r/c',phase:'implementation',round:1},{revision:1,note:'link'});
 appendLedger({...send(),t:'2099-01-01T00:00:00Z'},f.home);
 appendLedger({...done('r/c'),t:'2099-01-01T00:01:00Z'},f.home);
 assert.equal(works.change(w.key,'complete',{result:'verified'},{revision:w.revision,by:'p-boss',note:'checked'}).status,'done');
});
