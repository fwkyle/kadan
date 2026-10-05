import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {runWatch} from '../src/watch-runner.mjs';
import {watchResponsibility} from '../src/watch-report.mjs';

const epoch=Date.parse('2026-09-09T00:00:00Z');
const stamp=minute=>new Date(epoch+minute*60_000).toISOString();
const parents=new Map([['w1','boss'],['w2','boss'],['boss','top'],['top','@user']]);
const starts=['w1','w2','boss','top'].map((role,i)=>({kind:'start',role,session:'kadan-'+role,panePid:i+1,t:stamp(0)}));
const card=role=>({id:role,key:'r/'+role,role,status:'assigned',activity:'running',workType:'execution'});

async function simulate({from=0,until=66,workers=1,rows=null,screen=()=> '실행 중',onRead=()=>{},hold=()=>false,releaseAt=null}={}) {
 const records=rows??[...starts,...['w1','w2'].slice(0,workers).map(role=>({kind:'send',role,taskId:role,t:stamp(0)}))];
 const cards=['w1','w2'].slice(0,workers).map(card),calls=[],controller=new AbortController();
 let minute=from,running=0,peak=0,finish=null;
 await runWatch({signal:controller.signal,intervalMs:60_000,stallN:2,stallAfterMs:300_000,
  parents,routes:new Map(),superRole:'top',judgeCmd:'fake',now:()=>epoch+minute*60_000,
  floor:{list:()=>starts.map(s=>({session:s.session,pid:s.panePid})),read:session=>screen(session,minute)},
  readEntries:()=>{onRead(records,minute);return records;},readCards:()=>cards,
  sendAlert:()=>{},record:e=>records.push({...e,t:stamp(minute)}),print:()=>{},spawn:()=>({status:0,stdout:''}),
  ai:{reports:{retire:()=>{}},run:args=>{
   calls.push({minute,role:args.role,source:args.source,screen:args.input.screen??args.input.current});
   records.push({kind:'watch-ai-request',role:args.role,session:args.session,source:args.source,
    evidenceDigest:args.evidenceDigest,responsibility:watchResponsibility(args.role,cards,records,parents,args.source),t:stamp(minute)});
   peak=Math.max(peak,++running);
   if(!hold(args,minute)){running--;return {ok:true};}
   return new Promise(resolve=>{let done=false;finish=()=>{if(done)return;done=true;running--;resolve({ok:true});};args.signal.addEventListener('abort',finish,{once:true});});
  }},
  sleep:async()=>{if(minute===releaseAt)finish?.();await setImmediate();if(++minute>=until)controller.abort();},
 });
 return {calls,records,peak};
}

test('같은 실행·같은 근거는 5분 뒤 최초 호출하고 30분마다 재확인하며 진행 검사와 중복하지 않는다',async()=>{
 const {calls}=await simulate();
 // 최상위 top도 감독 점검 대상(2026-10-05). 한 주기 한 명이라 boss 다음 주기에 온다.
 assert.deepEqual(calls.map(c=>[c.minute,c.role,c.source]),[[5,'w1','stall'],[35,'w1','stall'],[60,'boss','supervisor-health'],[61,'top','supervisor-health'],[65,'w1','stall']]);
});
test('새 우편 근거는 기존 5분 간격 뒤 확인하고 같은 우편으로 다시 5분마다 호출하지 않는다',async()=>{
 const {calls}=await simulate({until:45,onRead:(rows,minute)=>{
  if(minute===12)rows.push({kind:'send',role:'w1',by:'boss',preview:'범위를 다시 확인해 주세요',t:stamp(12)});
 }});
 assert.deepEqual(calls.map(c=>c.minute),[5,12,42]);
});
test('감시기를 재시작해도 원장에 남긴 같은 근거의 실제 호출 시각을 재사용한다',async()=>{
 const first=await simulate({until:12});
 const second=await simulate({from:12,until:36,rows:first.records});
 assert.deepEqual(first.calls.map(c=>c.minute),[5]);
 assert.deepEqual(second.calls.map(c=>c.minute),[35]);
});
test('움직이는 실행도 30분 진행 검사를 받고 같은 시각 감독 관찰을 먼저 처리한다',async()=>{
 const {calls}=await simulate({until:63,screen:(session,minute)=>session==='kadan-w1'?'출력 '+minute:'정당한 대기'});
 // 감독 관찰(boss 60분, top 61분)이 진행 검사보다 먼저다.
 assert.deepEqual(calls.map(c=>[c.minute,c.source]),[[30,'progress'],[60,'supervisor-health'],[61,'supervisor-health'],[62,'progress']]);
});
test('대기 중 감독 관찰을 작업자보다 먼저 시작하고 다음 1시간은 실제 시작부터 센다',async()=>{
 const {calls,peak}=await simulate({until:123,workers:2,
  screen:(session,minute)=>session==='kadan-boss'?'감독 화면 '+minute:minute<53?'실행 출력 '+minute:'고정 화면',
  hold:(args,minute)=>args.role==='w1'&&minute===58,releaseAt:61,
 });
 assert.equal(peak,1);
 // 감독 관찰이 작업자보다 먼저다: boss(62) → top(63) → w2(64). top은 2026-10-05부터 점검 대상이다.
 assert.deepEqual(calls.filter(c=>c.minute>=58&&c.minute<=64).map(c=>[c.minute,c.role]),[[58,'w1'],[62,'boss'],[63,'top'],[64,'w2']]);
 const supervisors=calls.filter(c=>c.source==='supervisor-health'&&c.role==='boss');
 assert.deepEqual(supervisors.map(c=>c.minute),[62,122]);
 assert.equal(supervisors[0].screen,'감독 화면 62');
});
