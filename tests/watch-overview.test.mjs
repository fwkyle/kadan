import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {watchOverview,readWatchProcesses,attachWatchOverview} from '../src/watch-overview.mjs';
import {renderWatchOverview,renderWatchVerdict} from '../src/watch-overview-wall.mjs';
import {buildWatchScope,buildSupervisorScope} from '../src/watch-scope.mjs';
import {watchAILabel} from '../src/watch-report.mjs';
const text=JSON.stringify({worker:'supervisor',supervisor:'super',super:'@user'}),hash=createHash('sha256').update(text).digest('hex');
const now=Date.parse('2026-09-07T02:00:00Z');
const center={runtimeKnown:true,roles:[{role:'worker',life:{state:'alive',pidState:'match'}},{role:'super',life:{state:'alive',pidState:'match'}}],boards:[{name:'p',cards:[{id:'c',key:'r/c',role:'worker',status:'assigned',workType:'execution',displayState:'running',runs:[]}],runs:[]}]};
const send={kind:'send',role:'worker',taskId:'c',t:'2026-09-07T01:01:00Z'};
const base={center,entries:[{kind:'hierarchy-loaded',pid:42,path:'/test/hierarchy.json',hash,t:'2026-09-07T01:00:00Z'},send],processes:[{pid:42,startedAt:'2026-09-07T00:00:00Z'}],readFile:()=>text,now};
test('화면은 작업자 감시와 일반감독의 1시간 점검을 함께 표시한다',()=>{
 const m=watchOverview(base);assert.equal(m.process.state,'running');assert.equal(m.configuration.state,'matched');assert.equal(m.cycle.state,'unknown');
 // 최상위 super도 감독 점검 대상이라 역할 목록에 들어가고 상신 경로는 사용자다(2026-10-05).
 assert.equal(m.boards[0].state,'configured');assert.equal(m.boards[0].totalRoles,3);assert.equal(m.boards[0].roles[2].recipient,'super');assert.equal(m.boards[0].roles[0].recipient,'@user');assert.deepEqual(m.boards[0].roles.map(r=>r.role),['super','supervisor','worker']);
 const html=renderWatchOverview({...center,monitoring:m},center.boards[0]);assert.match(html,/이 판의 감시 대상 3명 · 작업자 1 · 감독 2/);assert.match(html,/상신 경로: super → 사용자 · OS 알림 · supervisor → super · worker → super/);assert.doesNotMatch(html,/감시기 실행 중/);assert.equal((html.match(/data-hierarchy-depth=/g)||[]).length,3);
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
 assert.deepEqual(m.boards[0].aiActivity,[{source:'worker',label:'작업 감시AI',requests:2,reported:1,timeouts:1,failed:0,offline:0},
  {source:'supervisor-health',label:'감독 관찰AI',requests:1,reported:0,timeouts:0,failed:1,offline:0}]);
 const html=renderWatchOverview({...center,monitoring:m},center.boards[0]);
 assert.match(html,/작업 감시AI/);assert.match(html,/감독 관찰AI/);
 for(const overrides of [{entries:null},{readFile:()=>{throw Error('unreadable');}}]){
  assert(watchOverview({...base,...overrides}).boards[0].aiActivity.every(a=>a.requests===null&&a.timeouts===null));
 }
});

// 원장 색인(판마다 원장 전체를 훑던 것을 한 번 훑기로) 회귀.
// 아래 세 식은 색인으로 바꾸기 전의 판별 훑기 식(c301233의 watch-overview.mjs)이고, 새 결과가 같은지 대조하는 기준이다.
const DAY=24*60*60_000;
const iso=offset=>new Date(now+offset).toISOString();
const oldActivity=(entries,names,at)=>['worker','supervisor-health'].map(source=>{
 const events=entries.filter(e=>names.has(e.role)&&Date.parse(e.t)>=at-DAY&&Date.parse(e.t)<=at&&
  (source==='supervisor-health'?e.source===source:['stall','progress'].includes(e.source)));
 const count=fn=>events.filter(fn).length;
 return {source,label:watchAILabel(source),requests:count(e=>e.kind==='watch-ai-request'),
  reported:count(e=>e.kind==='watch-ai-call'&&e.reason==='reported'),
  timeouts:count(e=>e.kind==='watch-ai-call'&&e.reason==='timeout'),
  failed:count(e=>e.kind==='watch-ai-call'&&
   ['call-failed','report-missing','report-incomplete','report-error'].includes(e.reason)),
  offline:count(e=>e.kind==='watch-ai-call'&&['network','slept'].includes(e.reason))};
});
const oldAlerts=(entries,names)=>entries
 .filter(e=>e.kind==='alert'&&(names.has(e.role)||names.has(e.recipient))).slice(-3)
 .map(e=>({at:e.t,role:e.role??null,kind:e.alertKind,recipient:e.recipient,route:e.route??null,
  delivered:e.delivered??null,resolved:e.resolved===true}));
const oldLastChecked=(entries,role)=>
 entries.findLast(e=>e.kind==='watch-ai-report'&&e.role===role&&e.source==='supervisor-health'&&e.accepted)?.t??null;
function sameAsOld(m,entries,at=now){
 for(const board of m.boards){
  const names=new Set(board.roles.map(r=>r.role));
  assert.deepEqual(board.aiActivity,oldActivity(entries,names,at));
  assert.deepEqual(board.recentAlerts,oldAlerts(entries,names));
  for(const role of board.roles.filter(r=>r.scope==='supervisor-health')){
   assert.equal(role.lastCheckedAt,oldLastChecked(entries,role.role));
  }
 }
}
// 판 p는 worker·supervisor·super, 판 q는 관계표에 없는 solo 한 명이다.
const soloCard={id:'d',key:'r/d',role:'solo',status:'assigned',workType:'execution',displayState:'running',runs:[]};
const twoBoards={...center,boards:[center.boards[0],{name:'q',cards:[soloCard],runs:[]}]};
const soloSend={kind:'send',role:'solo',taskId:'d',t:'2026-09-07T01:02:00Z'};
const alert=(role,recipient,extra={})=>({kind:'alert',role,recipient,alertKind:'정체',t:iso(-1000),...extra});
const ai=(role,source,kind,extra={})=>({role,source,kind,t:iso(-1000),...extra});
const report=(role,extra={})=>
 ({kind:'watch-ai-report',role,source:'supervisor-health',accepted:true,t:iso(-1000),...extra});
const builds=async()=>(await import('../src/watch-overview.mjs')).watchLedgerIndexInfo().builds;

test('최근 알림은 역할·수신자 어느 쪽으로 걸려도 한 번만, 원장 순서의 마지막 3개다',()=>{
 const entries=[...base.entries,soloSend,
  alert('worker','supervisor',{alertKind:'a1',t:iso(-5000)}), // 역할·수신자가 둘 다 판 p
  alert('solo','super',{alertKind:'a2'}), // 역할은 판 q, 수신자는 판 p
  alert('unrelated','nobody',{alertKind:'a3'}),
  alert('worker','@user',{alertKind:'a4',t:iso(-9000),route:'os',delivered:true,resolved:true}), // 시각은 앞서지만 원장에서는 뒤
  alert(undefined,'supervisor',{alertKind:'a5'}),
  alert('super','super',{alertKind:'a6',t:iso(-7000)})]; // 역할과 수신자가 같은 이름
 const m=watchOverview({...base,center:twoBoards,entries});
 assert.deepEqual(m.boards[0].roles.map(r=>r.role),['super','supervisor','worker']);
 assert.deepEqual(m.boards[1].roles.map(r=>r.role),['solo']);
 assert.deepEqual(m.boards[0].recentAlerts.map(a=>a.kind),['a4','a5','a6']);
 assert.deepEqual(m.boards[0].recentAlerts[0],
  {at:iso(-9000),role:'worker',kind:'a4',recipient:'@user',route:'os',delivered:true,resolved:true});
 assert.deepEqual(m.boards[0].recentAlerts[1],
  {at:iso(-1000),role:null,kind:'a5',recipient:'supervisor',route:null,delivered:null,resolved:false});
 assert.deepEqual(m.boards[1].recentAlerts.map(a=>a.kind),['a2']);
 sameAsOld(m,entries);
 // 3개가 안 될 때도 한 알림이 역할·수신자 두 번으로 늘지 않는다.
 const few=[...base.entries,
  alert('worker','supervisor',{alertKind:'b1'}),alert('supervisor','worker',{alertKind:'b2'})];
 const fewer=watchOverview({...base,entries:few});
 assert.deepEqual(fewer.boards[0].recentAlerts.map(a=>a.kind),['b1','b2']);
 sameAsOld(fewer,few);
 assert.deepEqual(watchOverview(base).boards[0].recentAlerts,[]);
});

test('감시 AI 호출 수의 24시간 창은 조회 시각 기준이고 양 끝을 포함한다',async()=>{
 const entries=[...base.entries,
  ai('worker','stall','watch-ai-request',{t:iso(-DAY)}), // 딱 경계: 포함
  ai('worker','stall','watch-ai-request',{t:iso(-DAY-1)}), // 1ms 밖: 제외
  ai('worker','progress','watch-ai-request',{t:iso(0)}), // 조회 시각과 같음: 포함
  ai('worker','progress','watch-ai-request',{t:iso(1)}), // 조회 시각보다 미래: 제외
  ai('worker','stall','watch-ai-request',{t:'시각 아님'}),
  ai('worker','stall','watch-ai-request',{t:undefined}),
  ai('worker','stall','watch-ai-call',{reason:'network'}),ai('worker','stall','watch-ai-call',{reason:'slept'}),
  ai('worker','stall','watch-ai-call',{reason:'report-missing'}),
  ai('worker','stall','watch-ai-call',{reason:'constructor'}), // 모르는 이유는 어느 칸에도 세지 않는다
  ai('worker','other','watch-ai-request'), // 모르는 호출 이유(source)
  ai('worker','stall','start'), // 감시 AI 사건이 아님
  ai('supervisor','supervisor-health','watch-ai-call',{reason:'reported'}),
  ai('supervisor','stall','watch-ai-request'), // 감독 이름이어도 작업 감시 호출로 센다
  ai('unrelated','stall','watch-ai-request')];
 const m=watchOverview({...base,entries});
 assert.deepEqual(m.boards[0].aiActivity,[
  {source:'worker',label:'작업 감시AI',requests:3,reported:0,timeouts:0,failed:1,offline:2},
  {source:'supervisor-health',label:'감독 관찰AI',requests:0,reported:1,timeouts:0,failed:0,offline:0}]);
 sameAsOld(m,entries);
 // 같은 원장을 하루 뒤에 보면 창만 옮겨 간다. 색인은 시각을 담고 있을 뿐이라 다시 만들지 않는다.
 const before=await builds(),later=now+DAY;
 const next=watchOverview({...base,entries,now:later});
 assert.equal(await builds(),before);
 assert.deepEqual(next.boards[0].aiActivity.map(a=>a.requests),[2,0]);
 assert.deepEqual(next.boards[0].aiActivity.map(a=>a.failed+a.offline+a.reported),[0,0]);
 sameAsOld(next,entries,later);
});

test('감독 관찰 보고의 마지막 접수 시각은 원장 순서로 마지막에 접수된 보고의 시각이다',()=>{
 const entries=[...base.entries,
  report('supervisor',{t:iso(-60_000)}),
  report('supervisor',{t:iso(-120_000)}), // 시각은 앞서지만 원장에서는 뒤
  report('supervisor',{accepted:false,t:iso(-10)}),
  report('supervisor',{source:'stall',t:iso(-5)}),
  report('worker',{t:iso(-1)}),
  report('super',{accepted:1,t:iso(DAY)})]; // 참 같은 값이면 접수, 시간 창은 없다
 const m=watchOverview({...base,entries});
 const role=name=>m.boards[0].roles.find(r=>r.role===name);
 assert.equal(role('supervisor').lastCheckedAt,iso(-120_000));
 assert.equal(role('super').lastCheckedAt,iso(DAY));
 assert.equal('lastCheckedAt' in role('worker'),false);
 sameAsOld(m,entries);
 // 마지막 접수 보고에 시각이 없으면 앞 보고로 내려가지 않고 모름(null)이다.
 const untimed=[...entries,report('supervisor',{t:undefined})];
 const after=watchOverview({...base,entries:untimed});
 assert.equal(after.boards[0].roles.find(r=>r.role==='supervisor').lastCheckedAt,null);
 sameAsOld(after,untimed);
 assert.equal(watchOverview(base).boards[0].roles.find(r=>r.role==='supervisor').lastCheckedAt,null);
});

test('원장이 그대로면 색인을 다시 만들지 않고, 사건이 붙으면 새로 만든다',async()=>{
 const {watchLedgerIndexInfo}=await import('../src/watch-overview.mjs');
 const entries=[...base.entries];
 const first=watchOverview({...base,entries});
 const start=await builds();
 assert.equal(watchLedgerIndexInfo().length,entries.length);
 assert.deepEqual(watchOverview({...base,entries}),first);
 assert.equal(await builds(),start); // 같은 배열·같은 길이: 원장 훑기 0회
 entries.push(alert('worker','supervisor',{alertKind:'pushed'})); // 같은 배열에 이어 붙음
 const pushed=watchOverview({...base,entries});
 assert.equal(await builds(),start+1);
 assert.deepEqual(pushed.boards[0].recentAlerts.map(a=>a.kind),['pushed']);
 const next=entries.concat([alert('worker','supervisor',{alertKind:'concat'})]); // 새 배열(서버의 증분 읽기 꼴)
 const concat=watchOverview({...base,entries:next});
 assert.equal(await builds(),start+2);
 assert.deepEqual(concat.boards[0].recentAlerts.map(a=>a.kind),['pushed','concat']);
 sameAsOld(concat,next);
 // 색인은 한 세대만 든다. 앞 배열로 돌아가면 그 배열로 다시 만들고 결과도 그 배열의 것이다.
 assert.deepEqual(watchOverview({...base,entries}),pushed);
 assert.equal(await builds(),start+3);
 // 깨진 사건이 섞인 원장은 색인을 쓰지 않고 모름으로 남긴다.
 const broken=watchOverview({...base,entries:[...entries,{broken:'bad'},alert('worker','supervisor')]});
 assert.equal(broken.boards[0].state,'unknown');assert.equal(broken.boards[0].recentAlerts,null);
 assert.equal(broken.cycle.state,'unknown');assert(broken.boards[0].aiActivity.every(a=>a.requests===null));
});

test('감시기 프로세스·관계 파일이 바뀌면 원장이 그대로여도 결과가 바뀐다',async()=>{
 const cycle={kind:'watch-cycle',pid:42,t:iso(-60_000),hierarchy:'/test/hierarchy.json',judge:true,ok:true};
 const entries=[...base.entries,cycle];
 const states=m=>[m.process.state,m.configuration.state,m.cycle.state,m.verdict.level,m.boards[0].state];
 const running=watchOverview({...base,entries});
 assert.deepEqual(states(running),['running','matched','ok','ok','configured']);
 const start=await builds();
 const gone=watchOverview({...base,entries,processes:[]});
 assert.deepEqual(states(gone),['absent','unknown','absent','bad','absent']);
 assert.equal(gone.boards[0].totalRoles,null);
 assert.equal(watchOverview({...base,entries,readFile:()=>text+' '}).configuration.state,'changed');
 const other=[{pid:43,startedAt:'2026-09-07T00:00:00Z'}]; // 다른 감시기: 이 PID의 관계 반영 기록이 없다
 assert.equal(watchOverview({...base,entries,processes:other}).configuration.state,'missing');
 assert.deepEqual(watchOverview({...base,entries}),running);
 assert.equal(await builds(),start); // 위 호출 모두 같은 원장: 색인은 그대로, 결과만 매번 다시 계산
});
