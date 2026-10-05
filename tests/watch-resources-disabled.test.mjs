import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import {runWatch} from './helpers/watch-runner.mjs';
import {collectResources} from '../src/watch-resource.mjs';
import {assessResources} from '../src/watch.mjs';
import {buildWallSnapshot,renderWallHtml} from '../src/wall.mjs';

const t='2026-09-09T00:00:00.000Z';
const parents=new Map([['p-작업자','p-감독'],['p-감독','p-슈퍼감독'],['p-슈퍼감독','@user']]);
const starts=[...parents.keys()].map((role,i)=>({kind:'start',role,session:`kadan-${role}`,panePid:i+1,t}));
const card={id:'task',key:'repo/task',role:'p-작업자',board:'p',status:'assigned',workType:'execution'};
const send={kind:'send',role:card.role,taskId:card.id,t};
const samples=[
 {memory:'warning',freePercent:20,swapUsed:100,load5:1},
 {memory:'critical',freePercent:10,swapUsed:110,load5:5},
 {memory:'normal',freePercent:80,swapUsed:120,load5:5},
 {memory:'unknown',freePercent:null,swapUsed:120,load5:1},
 ...Array.from({length:3},()=>({memory:'normal',freePercent:80,swapUsed:120,load5:1})),
];

async function exercise(ctx,{scope='active',topAlive=true,death=false}={}) {
 let cycle=0;
 const stop=Error('resource fixture end'),messages=[],notifications=[],records=[],measurements=[],judges=[];
 const history=['RED','AMBER'].flatMap(level=>[true,false].flatMap(delivered=>[true,false].map(resolved=>
  ({kind:'alert',alertKind:'자원',level,recipient:level==='RED'?'@user':'p-슈퍼감독',delivered,resolved,by:'watch',t}))));
 const entries=[...starts,send,...history],before=JSON.stringify(entries);
 const readFile=fs.readFileSync;
 ctx.mock.method(os,'loadavg',()=>{measurements.push('loadavg');return [0,samples[cycle].load5,0];});
 ctx.mock.method(os,'cpus',()=>{measurements.push('cpus');return Array.from({length:4});});
 ctx.mock.method(fs,'readFileSync',(file,...args)=>{
  if(file!=='/proc/meminfo')return readFile(file,...args);
  measurements.push(file);
  const current=samples[cycle];
  return current.freePercent==null?'':`MemTotal: 102400 kB\nMemAvailable: ${current.freePercent*1024} kB\nSwapTotal: 1024000 kB\nSwapFree: ${(1000-current.swapUsed)*1024} kB`;
 });
 try {await assert.rejects(()=>runWatch({
  floor:{list:()=>starts.filter(s=>(topAlive||s.role!=='p-슈퍼감독')&&!(death&&[1,2].includes(cycle)&&s.role===card.role))
   .map(s=>({session:s.session,pid:s.panePid})),read:()=>`정상 작업 ${cycle}`},
  readEntries:()=>entries,readCards:scope==='legacy'?null:()=>scope==='empty'?[]:[card],parents,
  intervalMs:1000,stallN:2,routes:{p:'p-감독'},superRole:'p-슈퍼감독',userNotify:true,
  judgeCmd:'fake',ai:{reports:{retire:()=>{}},run:c=>{judges.push(c);return {ok:true};}},
  now:()=>Date.parse(t)+cycle*1000,record:e=>records.push(e),print:()=>{},
  sendAlert:(role,message)=>{
   messages.push({role,message});
   if(death&&role==='p-감독'){const error=Error('fixture recipient missing');error.delivery='not-sent';throw error;}
  },
  spawn:(command,args)=>{
   if(command==='sleep'){if(++cycle===samples.length)throw stop;return {status:0,stdout:''};}
   if(command==='osascript')notifications.push(args);
   if(command==='memory_pressure'){
    measurements.push(command);
    return {status:0,stdout:samples[cycle].freePercent==null?'':'System-wide memory free percentage: '+samples[cycle].freePercent+'%'};
   }
   if(command==='sysctl'){measurements.push(command);return {status:0,stdout:`used = ${samples[cycle].swapUsed}M`};}
   return {status:0,stdout:''};
  },
 }),error=>error===stop);} finally {ctx.mock.restoreAll();}
 assert.equal(cycle,samples.length);
 assert.equal(JSON.stringify(entries),before,'과거 자원 원장은 그대로 보존');
 return {messages,notifications,records,measurements,judges};
}

test('자원 AMBER→RED→모름→정상과 과거 raw 경고·해소가 있어도 watch 수집·발송·사용자 알림은 0',async ctx=>{
 let state=null;
 const levels=samples.map(current=>{const result=assessResources(state,current,4);state=result.state;return result.alerts[0]?.level??null;});
 assert.deepEqual(levels,['AMBER','RED','RED','AMBER','AMBER','AMBER',null]);
 // 카드 조회 없는 옛 호출은 감독 부재 자체를 알린다. 무발송은 그 오류가 없는 입력에서 확인한다.
 for(const scope of ['active','empty','legacy']) for(const topAlive of scope==='legacy'?[true]:[true,false]) {
  const r=await exercise(ctx,{scope,topAlive});
  assert.deepEqual(r.measurements,[]);
  assert.deepEqual(r.messages,[]);
  assert.deepEqual(r.judges,[]);
  // 최상위 슈퍼감독이 없는 활성 판은 2026-10-05부터 그 부재를 @user에게 알린다(자원 경보가 아니다). 그 밖에는 알림 0.
  const supervisorAbsent=scope==='active'&&!topAlive;
  assert.deepEqual(r.notifications.length>0,supervisorAbsent);
  assert(r.notifications.every(args=>args[1].includes('kadan-p-슈퍼감독')));
  assert(!r.records.some(e=>e.kind==='alert'&&e.alertKind!=='죽음'));
  assert.equal(r.records.some(e=>e.kind==='alert'),supervisorAbsent);
 }
});

test('같은 자원 상황에서 실제 죽음·전달 실패는 기존 수신자와 사용자에게 알리고, 해소는 기록만 남긴다',async ctx=>{
 const r=await exercise(ctx,{death:true});
 assert.deepEqual(r.measurements,[]);
 // 해소 우편은 없다(2026-10-05 [kyle]). 원장에 resolved 기록만 남는다.
 assert.deepEqual(r.messages.map(m=>m.role),['p-감독','p-슈퍼감독']);
 assert.match(r.messages[0].message,/세션 종료 의심 kadan-p-작업자/);
 assert.match(r.messages[1].message,/전달실패/);
 assert.equal(r.notifications.length,1);
 assert.deepEqual(r.records.filter(e=>e.kind==='alert').map(e=>[e.alertKind,e.delivered,e.resolved??false]),
  [['전달실패',true,false],['죽음',false,false],['죽음',false,true]]);
});

test('대시보드는 자원 수집의 메모리·스왑·CPU 원측정과 선택 평가를 계속 사용한다',()=>{
 const snapshot=buildWallSnapshot({collect:()=>collectResources(command=>({status:0,stdout:command==='memory_pressure'
  ?'System-wide memory free percentage: 10%':'used = 321.50M'}),
  {platform:'darwin',loadavg:()=>[1,5.25,3],cpus:()=>Array.from({length:4})})});
 assert.deepEqual(snapshot,{resources:{current:{memory:'critical',freePercent:10,swapUsed:321.5,load5:5.25,ncpu:4},ncpu:4},resourceError:null});
 const html=renderWallHtml({tree:[],entries:[],collectedAt:new Date(t),ledgerLines:0,judge:true,...snapshot});
 assert.match(html,/메모리 여유 10% \(critical\) · 스왑 321\.50MB · CPU 5분 5\.25\/4/);
 assert.match(html,/RED \(memory, cpu\)/);
});
