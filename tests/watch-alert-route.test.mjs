// HW-7-impl: 감시 알림이 죽은 이름으로 가서 사라지지 않게. 함수 호출·모의 목록만 쓴다(CI는 ubuntu).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {explainAlertRoute,routeAlert,failureEscalation} from '../src/watch.mjs';
import {watchRouteNameWarnings} from '../src/watch-profile.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {WatchReports} from '../src/watch-report.mjs';

const alert=(role,id='stall:x')=>({id,kind:'정체',role});
const live=(...roles)=>new Set(roles.map(role=>`kadan-${role}`));

test('1. route 이름이 죽었으면 같은 판 살아 있는 감독 → super → @user 순서로 건너뛴다',()=>{
 const routes=new Map([['w1','w1-지휘자']]);
 assert.deepEqual(explainAlertRoute(alert('w1-작업자'),routes,live('w1-지휘자','w1-감독'),'슈퍼'),{recipient:'w1-지휘자',basis:'board-route',skipped:[]});
 assert.deepEqual(explainAlertRoute(alert('w1-작업자'),routes,live('w1-감독','슈퍼'),'슈퍼'),{recipient:'w1-감독',basis:'role-name',skipped:['w1-지휘자(route 세션 없음)']});
 assert.deepEqual(explainAlertRoute(alert('w1-작업자'),routes,live('슈퍼'),'슈퍼'),{recipient:'슈퍼',basis:'supervisor',skipped:['w1-지휘자(route 세션 없음)']});
 assert.deepEqual(explainAlertRoute(alert('w1-작업자'),routes,live(),'슈퍼'),{recipient:'@user',basis:'user-fallback',skipped:['w1-지휘자(route 세션 없음)','슈퍼(super 세션 없음)']});
});
test('1. 감독 멈춤·원장 읽기 실패의 super도 죽었으면 @user, super 지정이 없으면 기존처럼 null',()=>{
 assert.equal(routeAlert({id:'idle:p',kind:'놀고 있음',role:'p-감독'},new Map(),live(),'슈퍼'),'@user');
 assert.equal(routeAlert({id:'ledger:unreadable'},new Map(),live(),'슈퍼'),'@user');
 assert.equal(routeAlert({id:'ledger:unreadable'},new Map(),live('슈퍼'),'슈퍼'),'슈퍼');
 assert.equal(routeAlert({id:'ledger:unreadable'},new Map(),live(),null),null);
 assert.equal(routeAlert({id:'resource',kind:'자원'},new Map(),live(),'슈퍼'),'@user');
});
test('1. 관계표·감시AI오류·자원 명시 수신자 동작은 그대로다',()=>{
 const chain=new Map([['worker','lead'],['lead','@user']]);
 assert.equal(routeAlert(alert('worker'),new Map(),live(),'슈퍼',chain),'@user');
 assert.equal(routeAlert({id:'ai',kind:'감시AI오류',role:'p-작업자'},{p:'p-감독'},live('p-감독'),'슈퍼'),'@user');
 assert.equal(routeAlert({id:'r',kind:'자원',recipient:'죽은-이름'},new Map(),live(),'슈퍼'),'죽은-이름');
});
test('1. 승격 전송: super가 죽었고 관계표에도 없으면 @user, 관계표 안이면 살아 있는 상위',()=>{
 assert.equal(failureEscalation('p-감독',new Map(),live('슈퍼'),'슈퍼',new Map()),'슈퍼');
 assert.equal(failureEscalation('p-감독',new Map(),live(),'슈퍼',new Map()),'@user');
 assert.equal(failureEscalation('p-감독',new Map(),live(),null,new Map()),null);
 const chain=new Map([['p-감독','top'],['top','@user']]);
 assert.equal(failureEscalation('p-감독',new Map(),live('top'),'슈퍼',chain),'top');
 assert.equal(failureEscalation('p-감독',new Map(),live(),'슈퍼',chain),'@user');
});
test('1. 감시AI 보고도 같은 경로: route·super가 죽으면 @user로 보내고 skipped를 기록한다',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-alert-route-'));
 appendLedger({kind:'start',role:'x-작업자',session:'kadan-x-작업자',panePid:1},home);
 appendLedger({kind:'send',role:'x-작업자',taskId:'a'},home);
 const sent=[];
 const r=new WatchReports({home,now:()=>Date.now(),readCards:()=>[{id:'a',key:'r/a',role:'x-작업자',board:'x',status:'assigned',workType:'execution'}],
  floor:{list:()=>[{session:'kadan-x-작업자',pid:1}]},send:(role,message)=>sent.push({role,message})});
 const job=r.request({source:'stall',role:'x-작업자',parents:new Map(),routes:[['x','x-죽은감독']],superRole:'죽은-슈퍼'});
 r.submit(job.requestId,'응답장애','입력에 응답하지 못함');
 assert.deepEqual(sent.map(item=>item.role),['@user']);
});
test('2. 시작 경고: route·--super 이름이 살아 있지 않으면 알려 주고, 모두 살아 있으면 조용하다',()=>{
 const lines=watchRouteNameWarnings(new Map([['w1','w1-감독'],['w2','w2-감독']]),'슈퍼',['kadan-w1-감독']);
 assert.equal(lines.length,2);
 assert.match(lines[0],/--route w2=w2-감독/u);assert.match(lines[1],/--super 슈퍼/u);
 assert.deepEqual(watchRouteNameWarnings(new Map([['w1','w1-감독']]),'슈퍼',['kadan-w1-감독','kadan-슈퍼']),[]);
 assert.deepEqual(watchRouteNameWarnings(new Map(),null,[]),[]);
});
test('3. 긴 역할 이름(<판>-신규-작업자)도 route 키가 접두사면 걸리고, 가장 긴 접두사가 이긴다',()=>{
 const l=live('w1-감독','w1-신규-전용','w1-지휘자');
 assert.equal(explainAlertRoute(alert('w1-신규-작업자'),new Map([['w1','w1-지휘자']]),l,'슈퍼').basis,'board-route');
 assert.equal(routeAlert(alert('w1-신규-작업자'),new Map([['w1','w1-지휘자']]),l,'슈퍼'),'w1-지휘자');
 assert.equal(routeAlert(alert('w1-신규-작업자'),new Map([['w1','w1-지휘자'],['w1-신규','w1-신규-전용']]),l,'슈퍼'),'w1-신규-전용');
 assert.equal(routeAlert(alert('w1-신규-작업자'),{w1:'w1-지휘자'},l,'슈퍼'),'w1-지휘자');
 assert.equal(routeAlert(alert('w10-작업자'),new Map([['w1','w1-지휘자']]),live('w1-지휘자','슈퍼'),'슈퍼'),'슈퍼');
});

// ---- HW-7-impl2: 검수(HW-7-review) 중요 4건 회귀 시험. 검수자 independent-boundaries.test.mjs 의 실패 6건을 옮겼다. ----
const worker={id:'death:worker',kind:'죽음',role:'p-작업자'};
const liveBoard=new Set(['kadan-p-감독','kadan-super']);

test('중요 1. 명시한 @user route는 생존 검사 없이 그대로 사용자에게 간다',()=>{
 assert.deepEqual(explainAlertRoute(worker,{p:'@user'},liveBoard,'super'),{recipient:'@user',basis:'board-route',skipped:[]});
});
test('중요 1. @user super는 basis supervisor로 남고 가짜 죽은 세션 skipped가 없다',()=>{
 assert.deepEqual(explainAlertRoute({...worker,role:'other-worker'},{},liveBoard,'@user'),{recipient:'@user',basis:'supervisor',skipped:[]});
 assert.equal(failureEscalation('dead',{},liveBoard,'@user'),'@user');
});
test('중요 1. 프로필 경고는 @user를 죽은 세션으로 말하지 않는다',()=>{
 assert.deepEqual(watchRouteNameWarnings({p:'@user'},'@user',[]),[]);
});
test('중요 2. 긴 역할 이름의 죽은 route는 같은 판 살아 있는 감독으로 대체한다',()=>{
 const actual=explainAlertRoute({...worker,role:'p-신규-작업자'},{p:'dead-route'},liveBoard,'super');
 assert.equal(actual.recipient,'p-감독');
 assert.deepEqual(actual.skipped,['dead-route(route 세션 없음)']);
});
test('중요 2. 가장 긴 접두사 키가 boardFromRole과 일치하는 짧은 키보다 우선한다',()=>{
 const actual=explainAlertRoute({...worker,role:'p-작업자-extra'},{p:'short','p-작업자':'long'},['kadan-short','kadan-long'],'super');
 assert.equal(actual.recipient,'long');
});
// 순회 중 원장 EACCES 시험용 모의. 바닥·OS 알림·전송은 모두 주입 모의다.
async function mockCycles({brokenLedger=false}={}) {
 const {runWatch}=await import('../src/watch-runner.mjs');
 const controller=new AbortController(),sent=[],notifications=[];
 let cycle=0,entryReads=0;
 const entries=[{kind:'start',role:'p-작업자',session:'kadan-p-작업자',panePid:1,t:'2026-10-01T00:00:00Z'},
  {kind:'start',role:'super',session:'kadan-super',panePid:2,t:'2026-10-01T00:00:00Z'}];
 await runWatch({floor:{list:()=>[{session:'kadan-super',pid:2},{session:'kadan-p-작업자',pid:1}],read:()=>'healthy'},
  readEntries:()=>{if(brokenLedger&&entryReads++>0)throw Error('EACCES mocked');return entries;},
  record:()=>{},sendAlert:(role,message)=>sent.push({role,message}),
  routes:{p:'dead-route'},superRole:'super',intervalMs:1000,stallN:100,signal:controller.signal,
  print:()=>{},now:()=>Date.parse('2026-10-12T00:00:00Z')+cycle*1000,
  sleep:async()=>{if(++cycle===3)controller.abort();},
  spawn:(cmd,args)=>{if(cmd==='osascript')notifications.push(args);return {status:0,stdout:''};}});
 return {sent:sent.map(x=>x.role),notifications:notifications.length};
}
test('중요 3. 원장 읽기 오류는 살아 있는 super를 @user로 바꾸지 않는다 — 조회 실패는 모름',async()=>{
 const after=await mockCycles({brokenLedger:true});
 assert.equal(after.notifications,0);
 assert.deepEqual(after.sent,['super']);
});
test('중요 3. 생존을 모르면(null) 적힌 이름 그대로 가고, 프로필 경고는 건너뛴다',()=>{
 assert.deepEqual(explainAlertRoute(worker,{p:'dead-route'},null,'super'),{recipient:'dead-route',basis:'board-route',skipped:[]});
 assert.equal(explainAlertRoute({id:'ledger:unreadable'},{},null,'super').recipient,'super');
 assert.equal(failureEscalation('p-감독',{},null,'super',new Map()),'super');
 assert.deepEqual(watchRouteNameWarnings({p:'dead'},'dead-super',null),[]);
});
test('중요 4. 점검 화면 판정(watchVerdict)에 이름 경고가 warn으로 나온다',async()=>{
 const {watchVerdict}=await import('../src/watch-cycle.mjs');
 const base={process:{state:'running',instances:[{pid:1}]},configuration:{state:'matched'},
  cycle:{state:'ok',ageMs:1000,settings:{hierarchy:'/h.json',judge:true}}};
 assert.equal(watchVerdict(base).level,'ok');
 const warned=watchVerdict({...base,routeNames:watchRouteNameWarnings({p:'dead'},null,[])});
 assert.equal(warned.level,'warn');assert.match(warned.text,/--route p=dead/u);
});
test('중요 4. watchOverview가 주기 기록의 route/super 이름과 살아 있는 역할로 경고를 만든다',async()=>{
 const {watchOverview}=await import('../src/watch-overview.mjs');
 const now=Date.parse('2026-10-12T00:10:00Z'),t=ms=>new Date(now-ms).toISOString();
 const proc={pid:7,startedAt:t(600_000)};
 const entries=[{kind:'watch-cycle',by:'watch',pid:7,t:t(1000),hierarchy:'/h.json',judge:true,routes:{p:'dead-route'},superRole:'super',ok:true}];
 const center={runtimeKnown:true,cards:[],boards:[],roles:[{role:'super',life:{state:'alive',pidState:'match'}}]};
 const result=watchOverview({center,entries,processes:[proc],now});
 assert.equal(result.routeNames.length,1);assert.match(result.routeNames[0],/dead-route/u);
 assert.match(result.verdict.text,/--route p=dead-route/u);
 const unknown=watchOverview({center:{...center,runtimeKnown:false},entries,processes:[proc],now});
 assert.deepEqual(unknown.routeNames,[]);
});
