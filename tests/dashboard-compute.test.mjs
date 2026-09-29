import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDomainStreams,ledgerStreams} from '../src/ledger-domains.mjs';
import {mailboxLetters} from '../src/mailbox-state.mjs';
import {dashboardData} from '../src/dashboard-api.mjs';
import {dashboardFixture} from './helpers/dashboard-fixture.mjs';

function completed(id,order,role='worker') {
 const request={kind:'send',taskId:id,executionKey:`repo/${id}`,role,by:'lead',mailId:`request-${id}`,dispatchId:`request-${id}`,expectReply:true,_ledgerOrder:order};
 const dispatch={kind:'dispatch',taskId:id,executionKey:`repo/${id}`,role,by:'lead',mailId:request.mailId,dispatchId:request.mailId,_ledgerOrder:order};
 const done={kind:'done',taskId:id,executionKey:`repo/${id}`,role,result:'ok',completionMailId:`done-${id}`,_ledgerOrder:order+1};
 const mail={kind:'send',by:role,role:'lead',mailId:done.completionMailId,replyTo:request.mailId,replyFinal:true,completion:true,transport:'mailbox',systemGenerated:'task-completion',completionTaskId:id,executionKey:done.executionKey,result:'ok',_ledgerOrder:order+2};
 return {request,dispatch,done,mail};
}

test('완료 연결 검증은 완료 건마다 무관한 감시 이력을 다시 훑지 않는다',()=>{
 let visits=0;
 const legacy=Array.from({length:2000},()=>({get kind(){visits++;return 'watch-observation';}}));
 const tasks=[],mail=[];
 for(let i=0;i<80;i++){
  const row=completed(`card-${i}`,i*3+1);
  tasks.push(row.dispatch,row.done);mail.push(row.request,row.mail);
 }
 const ordered=validateDomainStreams(new Map([[ledgerStreams.tasks,tasks],[ledgerStreams.mail,mail]]),legacy);
 assert.ok(visits<30_000,`무관한 이력을 완료마다 재검사: ${visits}`);
 visits=0;
 const entries=[...legacy,...ordered.filter(e=>e.kind!=='dispatch')];
 const before=JSON.stringify(entries);
 visits=0;
 const letters=mailboxLetters(entries);
 assert.equal(letters.filter(e=>e.replyStatus==='answered').length,80);
 assert.ok(visits<30_000,`우편 투영에서 무관한 이력을 완료마다 재검사: ${visits}`);
 assert.equal(JSON.stringify(entries),before);
});

test('나중에 생긴 같은 짧은 카드 주소는 이미 완료된 우편 연결을 바꾸지 않는다',()=>{
 const row=completed('same',1);
 const later={kind:'send',taskId:'same',executionKey:'other/same',role:'other',by:'lead',mailId:'later',dispatchId:'later',_ledgerOrder:4};
 const dispatch={kind:'dispatch',taskId:later.taskId,executionKey:later.executionKey,role:later.role,by:later.by,mailId:later.mailId,dispatchId:later.mailId,_ledgerOrder:4};
 delete row.request.executionKey;delete row.dispatch.executionKey;
 const streams=new Map([[ledgerStreams.tasks,[row.dispatch,row.done,dispatch]],[ledgerStreams.mail,[row.request,row.mail,later]]]);
 const ordered=validateDomainStreams(streams);
 const entries=ordered.filter(e=>e.kind!=='dispatch');
 assert.equal(mailboxLetters(entries).find(e=>e.mailId===row.request.mailId).replyStatus,'answered');
 const corrupt=structuredClone(streams);
 corrupt.get(ledgerStreams.mail)[1].replyTo='later';
 assert.throws(()=>validateDomainStreams(corrupt),/완료 우편 연결 손상/);
});

test('앞선 다른 카드 인계와 중복 인계 ID도 완료 책임을 임의로 옮기지 않는다',()=>{
 const row=completed('target',1);
 const transfer={kind:'handover',phase:'transferred',handoverId:'transfer',from:'worker',to:'next',taskIds:['repo/other']};
 const legacy=[row.request,transfer,{...transfer,taskIds:['repo/target']}];
 const {done,mail}=row;
 done._ledgerOrder=1;mail._ledgerOrder=2;
 const streams=new Map([[ledgerStreams.tasks,[done]],[ledgerStreams.mail,[mail]]]);
 assert.doesNotThrow(()=>validateDomainStreams(streams,legacy));
 const corrupt=structuredClone(streams);
 corrupt.get(ledgerStreams.tasks)[0].role='next';
 corrupt.get(ledgerStreams.mail)[0].by='next';
 assert.throws(()=>validateDomainStreams(corrupt,legacy),/완료 우편 연결 손상/);
});

test('메뉴 요약은 카드 본문과 워크 상세 진행을 계산하지 않고 숫자를 읽는다',()=>{
 const f=dashboardFixture({count:2}),snapshot=f.snapshot();
 for(const card of snapshot.center.cards)Object.defineProperty(card,'body',{get(){throw Error('목록에 불필요한 본문 접근');}});
 for(const work of snapshot.registeredWorks)Object.defineProperty(work,'history',{get(){throw Error('요약에 불필요한 워크 상세 접근');}});
 const summary=dashboardData(snapshot,new URL('http://local/api/dashboard/summary'));
 assert.deepEqual(summary.counts,{work:1,executions:2,unlinked:1});
 assert.equal(summary.waiting,1);
 assert.deepEqual(summary.errors,['격리 시험: 자원 미수집']);
});

test('카드 목록은 워크 상세를 읽지 않고 부모 연결과 미연결 필터를 유지한다',()=>{
 const f=dashboardFixture({count:2}),snapshot=f.snapshot();
 for(const work of snapshot.registeredWorks)Object.defineProperty(work,'history',{get(){throw Error('카드 목록에 불필요한 워크 상세 접근');}});
 const read=route=>dashboardData(snapshot,new URL('http://local/api/dashboard/'+route));
 const list=read('workspace?collection=executions&state=all');
 assert.equal(list.workError,null);
 assert.equal(list.rows.find(row=>row.key==='demo/card-1').parentWorkKey,'work:demo/dashboard');
 assert.equal(list.total,2);
 assert.deepEqual(read('workspace?collection=unlinked&state=all').rows.map(row=>row.key),['demo/card-2']);
 assert.throws(()=>read('workspace?collection=work'),/워크 상세 접근/);
});

test('요약의 워크 조회 실패와 새 수집의 연결 변경을 숨기거나 재사용하지 않는다',()=>{
 const f=dashboardFixture({count:2}),snapshot=f.snapshot(),url=new URL('http://local/api/dashboard/summary');
 assert.equal(dashboardData(snapshot,url).counts.unlinked,1);
 const next={...snapshot,registeredWorks:[{...snapshot.registeredWorks[0],executions:[]}]};
 assert.equal(dashboardData(next,url).counts.unlinked,2);
 const failed={...snapshot};Object.defineProperty(failed,'registeredWorks',{get(){throw Error('워크 읽기 실패');}});
 const data=dashboardData(failed,url);
 assert.equal(data.counts.work,null);
 assert.ok(data.errors.includes('워크 읽기 실패'));
 assert.throws(()=>dashboardData({...snapshot,centerError:'카드 읽기 실패'},url),/카드 읽기 실패/);
});

test('전체 현황에서 계산한 카드 행은 같은 수집의 카드 목록에서도 재사용한다',()=>{
 const f=dashboardFixture({count:2}),snapshot=f.snapshot();
 let reads=0;
 for(const card of snapshot.center.cards){const body=card.body;Object.defineProperty(card,'body',{get(){reads++;return body;}});}
 dashboardData(snapshot,new URL('http://local/api/dashboard/status'));
 const before=reads;
 const list=dashboardData(snapshot,new URL('http://local/api/dashboard/workspace?collection=executions&state=all'));
 assert.equal(list.total,2);
 assert.equal(reads,before,'현황에 이미 계산된 카드 설명을 다시 만들지 않는다');
});
