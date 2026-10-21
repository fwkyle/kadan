import './helpers/isolated-home.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {assessMissingStartReports} from '../src/watch-start-report.mjs';
import {collectRoles} from '../src/watch-roles.mjs';
import {appendSpool} from '../src/stop-hook-spool.mjs';
// 시작보고 누락 경보는 감시기 완료 판정과 같은 함수로 '그 발령 이후·그 카드'의 DONE 증거를 본다.
const t0='2026-10-21T00:00:00Z',t1='2026-10-21T01:00:00Z',t2='2026-10-21T02:00:00Z',grace=5*60000;
const session='kadan-worker',card={id:'c',key:'r/c',status:'assigned',role:'worker'};
const start={kind:'start',role:'worker',session,panePid:'1',t:t0};
const send=(t,extra={})=>({kind:'send',role:'worker',session,taskId:'c',executionKey:'r/c',t,...extra});
const floor=screen=>({list:()=>[{session,pid:'1'}],read:()=>screen});
const home=()=>fs.mkdtempSync(path.join(os.tmpdir(),'kadan-sr-'));
const alerts=(screen,entries,hookHome,now=Date.parse(t2)+10*60000)=>{
 const seen=collectRoles(floor(screen),entries,null,[card],{hookHome}).observations;
 return assessMissingStartReports([card],entries,seen,now,grace,{hookHome});
};
const filler=n=>Array.from({length:n},(_,i)=>`작업 ${i}`).join('\n');

test('화면 7줄 위로 밀린 그 카드의 DONE은 경보를 내지 않는다',()=>{
 const screen=`KADAN:DONE r/c ok\n${filler(7)}`;
 assert.equal(alerts(screen,[start,send(t1)],home()).length,0);
 assert.equal(alerts(filler(7),[start,send(t1)],home()).length,1,'마커가 없으면 그대로 경보');
});
test('훅으로만 기록된 그 카드의 DONE(발령 이후)은 경보를 내지 않는다',()=>{
 const h=home();appendSpool(h,{at:'2026-10-21T01:30:00Z',role:'worker',taskId:'r/c',result:'ok'});
 assert.equal(alerts(filler(3),[start,send(t1)],h).length,0);
});
test('앞 카드의 DONE 뒤 같은 역할에 재발령하면 옛 증거는 경보를 숨기지 못한다(#204)',()=>{
 const old=`KADAN:DONE r/c ok\n${filler(3)}`;
 // 화면에 옛 마커가 남은 경우: 두 번째 발령이 그 마커를 기준선으로 삼는다.
 const rows=[start,send(t0),{kind:'done',role:'worker',taskId:'c',executionKey:'r/c',result:'ok',t:t1},
  send(t2,{baselineMarkers:[{taskId:'r/c',result:'ok'}]})];
 assert.equal(alerts(old,rows,home()).length,1,'화면의 옛 마커');
 // 훅에 옛 기록이 있는 경우: 발령 이전 기록이다.
 const h=home();appendSpool(h,{at:'2026-10-21T01:30:00Z',role:'worker',taskId:'r/c',result:'ok'});
 assert.equal(alerts(filler(3),rows,h).length,1,'훅의 옛 기록');
 // 다른 카드 id의 훅·화면 마커도 증거가 아니다.
 const other=home();appendSpool(other,{at:'2026-10-21T02:05:00Z',role:'worker',taskId:'r/other',result:'ok'});
 assert.equal(alerts(`KADAN:DONE r/other ok\n${filler(3)}`,rows,other).length,1,'다른 카드');
 // 발령 뒤의 새 마커·새 훅은 증거다.
 const fresh=home();appendSpool(fresh,{at:'2026-10-21T02:05:00Z',role:'worker',taskId:'r/c',result:'ok'});
 assert.equal(alerts(filler(3),rows,fresh).length,0,'발령 뒤 훅');
 assert.equal(alerts(`${old}\nKADAN:DONE r/c failed`,rows,home()).length,0,'발령 뒤 새 화면 마커');
});
