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
 r.submit(job.requestId,'정체','입력 대기에서 멈춤');
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
