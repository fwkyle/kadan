// 429 자동 재개가 예약된 동안 이미 알린 '한도' 경보는 통지 없이 이월한다.
// 숨기면 dedup이 해소로 보고 감독에게 '한도 → 해소됨'이 깜빡였다(2026-10-05 점검 보고서 2-M2, 독립 검수 재현:
// 예약 중 새 터미널 입력으로 예약이 취소·재설정되는 조건).
import test from 'node:test';
import assert from 'node:assert/strict';
import {runWatch} from '../src/watch-runner.mjs';

const epoch=Date.parse('2026-09-09T00:00:00Z');
const stamp=m=>new Date(epoch+m*60_000).toISOString();
const failure='■ exceeded retry limit, last status: 429 Too Many Requests';
const screen429=`${failure}\n\n›\n kimi/k3[1m] max`;

async function run({clearAt=Infinity,stopAt=12}={}){
 const parents=new Map([['p-작업자','p-감독'],['p-감독','@user']]);
 const starts=[['p-작업자',1],['p-감독',2]].map(([role,pid])=>({kind:'start',role,session:'kadan-'+role,panePid:pid,t:stamp(0)}));
 const card={id:'t1',key:'repo/t1',role:'p-작업자',board:'p',status:'assigned',activity:'running',workType:'execution'};
 const records=[],sent=[];let minute=0;const controller=new AbortController();
 const entries=[...starts,{kind:'send',role:'p-작업자',taskId:'t1',t:stamp(0)}];
 await runWatch({signal:controller.signal,intervalMs:60_000,stallN:2,stallAfterMs:300_000,parents,routes:new Map(),superRole:'p-감독',
  now:()=>epoch+minute*60_000,
  floor:{list:()=>starts.map(s=>({session:s.session,pid:s.panePid})),read:s=>s==='kadan-p-작업자'?(minute>=1&&minute<clearAt?screen429:'Working... 출력 '+minute):'감독 화면',alive:()=>true},
  readEntries:()=>entries,readCards:()=>[card],readWorks:()=>[],
  resume429:()=>{},
  sendAlert:(role,msg)=>sent.push([minute,role,msg]),record:e=>{records.push(e);entries.push({...e,t:stamp(minute)});},
  print:()=>{},spawn:()=>({status:0,stdout:''}),
  sleep:async()=>{++minute;
   // 1분에 예약(dueAt=2분). 2분 주기 직전에 watch 미확인 우편 알림이 터미널에 붙어 예약이 취소·재설정된다.
   if(minute===2)entries.push({kind:'send',role:'p-작업자',by:'watch',source:'watch',notificationOnly:true,mailId:'m1',t:stamp(1.5)});
   if(minute>=stopAt)controller.abort();}});
 return {records,sent};
}

test('예약 중 새 입력으로 재개가 취소·재설정돼도 한도 경보는 해소됐다고 알리지 않는다',async()=>{
 const {records,sent}=await run();
 const retry=records.filter(e=>e.kind==='rate-limit-retry').map(e=>e.action);
 assert.ok(retry.includes('cancelled')&&retry.filter(a=>a==='scheduled').length>=2,'취소·재예약 조건이 재현돼야 한다: '+retry.join(','));
 const limitAlerts=records.filter(e=>e.kind==='alert'&&e.alertKind==='한도');
 assert.ok(limitAlerts.some(e=>!e.resolved&&e.delivered),'한도 경보는 한 번 전달된다');
 assert.equal(limitAlerts.filter(e=>e.resolved).length,0,'화면에 429가 남아 있는 동안 해소 기록이 없다');
 assert.equal(sent.filter(([,,m])=>/해소/.test(m)).length,0,'감독에게 해소 우편이 가지 않는다');
 assert.equal(sent.filter(([,,m])=>/한도/.test(m)&&!/해소/.test(m)).length,1,'한도 경보는 한 번만 보낸다');
});

test('화면에서 429가 사라지면 그때 한 번 해소된다',async()=>{
 const {records,sent}=await run({clearAt:8,stopAt:12});
 const resolved=records.filter(e=>e.kind==='alert'&&e.alertKind==='한도'&&e.resolved);
 assert.equal(resolved.length,1);
 assert.equal(sent.filter(([m,,x])=>/한도/.test(x)&&/해소/.test(x)&&m>=8).length,1);
});
