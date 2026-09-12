import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {watchOverview,readWatchProcesses,attachWatchOverview} from '../src/watch-overview.mjs';
import {renderWatchOverview,renderWatchVerdict} from '../src/watch-overview-wall.mjs';
import {buildWatchScope,buildSupervisorScope} from '../src/watch-scope.mjs';
const text=JSON.stringify({worker:'supervisor',supervisor:'super',super:'@user'}),hash=createHash('sha256').update(text).digest('hex');
const now=Date.parse('2026-09-07T02:00:00Z');
const center={runtimeKnown:true,roles:[{role:'worker',life:{state:'alive',pidState:'match'}},{role:'super',life:{state:'alive',pidState:'match'}}],boards:[{name:'p',cards:[{id:'c',key:'r/c',role:'worker',status:'assigned',workType:'execution',displayState:'running',runs:[]}],runs:[]}]};
const send={kind:'send',role:'worker',taskId:'c',t:'2026-09-07T01:01:00Z'};
const base={center,entries:[{kind:'hierarchy-loaded',pid:42,path:'/test/hierarchy.json',hash,t:'2026-09-07T01:00:00Z'},send],processes:[{pid:42,startedAt:'2026-09-07T00:00:00Z'}],readFile:()=>text,now};
test('화면은 작업자 감시와 일반감독의 1시간 점검을 함께 표시한다',()=>{
 const m=watchOverview(base);assert.equal(m.process.state,'running');assert.equal(m.configuration.state,'matched');assert.equal(m.cycle.state,'unknown');
 assert.equal(m.boards[0].state,'configured');assert.equal(m.boards[0].totalRoles,2);assert.equal(m.boards[0].roles[1].recipient,'super');assert.deepEqual(m.boards[0].roles.map(r=>r.role),['supervisor','worker']);
 const html=renderWatchOverview({...center,monitoring:m},center.boards[0]);assert.match(html,/이 판의 감시 대상 2명 · 작업자 1 · 감독 1/);assert.match(html,/상신 경로: supervisor → super · worker → super/);assert.doesNotMatch(html,/감시기 실행 중/);assert.equal((html.match(/data-hierarchy-depth=/g)||[]).length,2);
 // 전역 상태는 한 줄 판정으로 한 번만 그린다. 주기 기록이 없는 감시기는 정상으로 올리지 않는다.
 const global=renderWatchVerdict({...center,monitoring:m});assert.match(global,/data-watch-level="warn"/);assert.match(global,/감시기 설정 확인 불가 · 주기 기록 없음/);assert.match(global,/마지막 주기<\/dt><dd>기록 없음/);
 const cycled=watchOverview({...base,entries:[...base.entries,{kind:'watch-cycle',pid:42,t:new Date(now-60_000).toISOString(),hierarchy:'/test/hierarchy.json',judge:true,ok:true}],profilePath:'/home/watch-profile.json'});
 assert.equal(cycled.cycle.state,'ok');assert.equal(cycled.verdict.level,'ok');assert.match(renderWatchVerdict({...center,monitoring:cycled}),/감시 정상 · 관계 파일 반영 · AI 판정 켜짐 · 마지막 주기 1분 전/);
 const bare=watchOverview({...base,entries:[send,{kind:'watch-cycle',pid:42,t:new Date(now-60_000).toISOString(),hierarchy:null,judge:false,ok:true}],profilePath:'/home/watch-profile.json'});
 assert.equal(bare.verdict.level,'warn');assert.match(renderWatchVerdict({...center,monitoring:bare}),/감시 설정 빠짐 · 관계 파일 없음 · AI 판정 꺼짐/);assert.match(renderWatchVerdict({...center,monitoring:bare}),/kadan watch --profile \/home\/watch-profile.json/);
 assert.match(renderWatchVerdict({}),/감시 정보 미수집/);
});
test('PID 재사용·관계 파일 변경·읽기 오류를 정상 설정으로 보여주지 않는다',()=>{
 assert.equal(watchOverview({...base,processes:[{pid:42,startedAt:'2026-09-07T01:30:00Z'}]}).configuration.state,'unknown');
 assert.equal(watchOverview({...base,readFile:()=>text+' '}).configuration.state,'changed');
 assert.equal(watchOverview({...base,readFile:()=>'{'}).configuration.state,'unknown');
 assert.equal(watchOverview({...base,entries:[]}).configuration.state,'missing');
 assert.equal(watchOverview({...base,entries:[{broken:'bad'}]}).configuration.state,'unknown');
 assert.equal(watchOverview({...base,processError:'ps failed',processes:[]}).process.state,'unknown');
 assert.equal(watchOverview({...base,processes:[]}).boards[0].state,'absent');
 assert.equal(watchOverview({...base,processes:[...base.processes,{pid:43}]}).boards[0].state,'duplicate');
});
test('활성 작업자의 직속 미등록은 드러내고 실행 없는 미배정 카드는 대상에 넣지 않는다',()=>{
 const c={...center,boards:[{name:'p',cards:[{...center.boards[0].cards[0],role:'unknown'}],runs:[]}]};
 const m=watchOverview({...base,center:c,entries:[...base.entries,{...send,role:'unknown'}]});assert.equal(m.boards[0].state,'incomplete');assert.deepEqual(m.boards[0].missingRoles,['unknown']);
 assert.equal(watchOverview({...base,center:{...center,runtimeKnown:false}}).boards[0].roles[0].recipientKnown,false);
 assert.equal(watchOverview({...base,center:{...center,boards:[{name:'p',cards:[{displayState:'draft',runs:[]}],runs:[]}]}}).boards[0].state,'not-required');
});
test('완료·ready·관리 카드와 옛 실행의 표적은 실제 선별 결과와 같다',()=>{
 for(const status of ['assigned','done','hold','ready'])for(const workType of ['execution','coordination']){
  const card={...center.boards[0].cards[0],status,workType};
  for(const events of [[send],[send,{...send,kind:'done'}],[send,{...send,kind:'done'},send]]){
   const entries=[base.entries[0],...events,{kind:'start',role:'super',session:'kadan-super'}, {kind:'send',role:'legacy',taskId:'old'}];
   const board={name:'p',cards:[card,{id:'manager',role:'supervisor',status:'assigned',workType:'coordination'}],runs:[{role:'legacy',state:'unconfirmed'}]};
   const m=watchOverview({...base,entries,center:{...center,boards:[board]}});
   const scope=buildWatchScope(board.cards,entries,new Map(Object.entries(JSON.parse(text))));
   const managers=buildSupervisorScope(board.cards,entries,new Map(Object.entries(JSON.parse(text))));
   assert.deepEqual(m.boards[0].roles.map(r=>'kadan-'+r.role).sort(),[...scope.sessions,...managers.sessions].sort());
   assert.equal(m.boards[0].totalRoles,scope.sessions.size+managers.sessions.size);
  }
 }
});
test('원장·관계·대상 조회 실패는 화면에서 대상 0이나 정상으로 승격하지 않는다',()=>{
 for(const overrides of [{entries:[{broken:'bad'}]},{entries:null},{readFile:()=>{throw Error('read failed');}},{readFile:()=>text+' '},{center:{...center,cards:{}}}]){
  const m=watchOverview({...base,...overrides});
  assert.equal(m.boards[0].state,'unknown');assert.equal(m.boards[0].totalRoles,null);assert.equal(m.boards[0].registeredRoles,null);
  assert.doesNotMatch(renderWatchOverview({...center,monitoring:m},center.boards[0]),/감시 대상 없음/);
 }
});
test('ps는 정확한 프로세스 이름만 읽고 UTC 시작 시각과 조회 실패를 구분한다',()=>{
 const p=readWatchProcesses((cmd,args,opts)=>{assert.equal(opts.env.TZ,'UTC');return{status:0,stdout:' 42 Mon Sep  7 00:00:00 2026 kadan-watch\n43 Mon Sep  7 00:00:00 2026 node test-kadan-watch\n'};});
 assert.deepEqual(p,[{pid:42,startedAt:'2026-09-07T00:00:00.000Z'}]);assert.throws(()=>readWatchProcesses(()=>({status:1})),/조회 실패/);
 const out=attachWatchOverview(center,base.entries,{readProcesses:()=>base.processes,readFile:base.readFile,now});assert.strictEqual(out.boards[0].monitoring,out.monitoring.boards[0]);
});
test('감시 역할은 입력 순서와 무관하게 상위 다음 소속 역할, 미등록은 마지막이다',async()=>{
 const {orderWatchRoles}=await import('../src/watch-overview.mjs');
 const roles=[{role:'b-worker10',parent:'b-director',registered:true},{role:'unregistered',parent:null,registered:false},{role:'a-director',parent:'super',registered:true},{role:'super',parent:'@user',registered:true},{role:'b-director',parent:'super',registered:true},{role:'b-worker2',parent:'b-director',registered:true},{role:'a-worker',parent:'a-director',registered:true}];
 const ordered=orderWatchRoles(roles);
 assert.deepEqual(ordered.map(r=>r.role),['super','a-director','a-worker','b-director','b-worker2','b-worker10','unregistered']);
 assert.deepEqual(ordered.map(r=>r.hierarchyDepth),[0,1,2,1,2,2,0]);
 assert.deepEqual(orderWatchRoles([...roles].reverse()),ordered);
 assert.equal(roles[0].hierarchyDepth,undefined);
});

test('최근 24시간 호출 수를 작업 감시와 감독 관찰로 나누고 보고 완료·시간 초과를 분리한다',()=>{
 const event=(role,source,kind,extra={})=>({role,source,kind,t:new Date(now-1000).toISOString(),...extra});
 const entries=[...base.entries,event('worker','stall','watch-ai-request'),event('worker','stall','watch-ai-call',{reason:'reported',outputBytes:0}),
  event('worker','progress','watch-ai-request'),event('worker','progress','watch-ai-call',{reason:'timeout'}),
  event('supervisor','supervisor-health','watch-ai-request'),event('supervisor','supervisor-health','watch-ai-call',{reason:'call-failed'}),
  event('worker','stall','watch-ai-request',{t:new Date(now-25*60*60_000).toISOString()}),event('unrelated','stall','watch-ai-request')];
 const m=watchOverview({...base,entries});
 assert.deepEqual(m.boards[0].aiActivity,[{source:'worker',label:'작업 감시AI',requests:2,reported:1,timeouts:1,failed:0},
  {source:'supervisor-health',label:'감독 관찰AI',requests:1,reported:0,timeouts:0,failed:1}]);
 const html=renderWatchOverview({...center,monitoring:m},center.boards[0]);
 assert.match(html,/작업 감시AI/);assert.match(html,/감독 관찰AI/);
 for(const overrides of [{entries:null},{readFile:()=>{throw Error('unreadable');}}]){
  assert(watchOverview({...base,...overrides}).boards[0].aiActivity.every(a=>a.requests===null&&a.timeouts===null));
 }
});
