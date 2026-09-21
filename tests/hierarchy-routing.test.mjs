import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { parseHierarchy } from '../src/hierarchy.mjs';
import { routeAlert } from '../src/watch.mjs';
import { assessSupervisorIdle } from '../src/watch-supervisor.mjs';
import { runWatch } from './helpers/watch-runner.mjs';
const parents = parseHierarchy({ 'prod-슈퍼감독': '@user', 'prod-감독': 'prod-슈퍼감독',
  'other-prefix-작업자': 'prod-감독', 'other-prefix-검수자': 'prod-감독' });
const live = [...parents.keys()].map(role => `kadan-${role}`);
const alert = role => ({ id: 'idle:example', role });
test('09-07 다른 접두사도 직속 감독, 감독은 슈퍼, 슈퍼는 사용자에게 간다', () => {
  for (const [role, expected] of parents) {
    for (const id of ['stall:a','idle:a','death:a','screen-read:a','complete-candidate:a'])
      assert.equal(routeAlert({id,role},{prod:role},live,'옛-슈퍼',parents), expected);
  }
  assert.equal(routeAlert(alert('other-prefix-작업자'),{},['kadan-prod-슈퍼감독'],'옛-슈퍼',parents),'prod-슈퍼감독');
  assert.equal(routeAlert(alert('other-prefix-작업자'),{},[],'옛-슈퍼',parents),'@user');
  assert.equal(routeAlert({id:'stall:x',role:'legacy-작업자'},{legacy:'legacy-감독'},live,'옛-슈퍼',parents),'legacy-감독');
});
test('09-07 순환과 누락된 상위를 잘못된 설정으로 거부한다', () => {
  for(const value of [null, [], {a:'a'}, {a:'b'}, {a:'b',b:'a'}, {a:42}, {'@user':'@user'}])
    assert.throws(()=>parseHierarchy(value));
});
const t = '2026-09-07T00:00:00Z';
const pending = {kind:'send',role:'other-prefix-작업자',taskId:'card-1',t};
function states(ms=60000) {return new Map([...parents.keys()].map(role=>[`kadan-${role}`,{role,alive:true,digest:'x',unchangedMs:ms}]))}
test('09-07 작업 없는 대기는 정상, 미완료 후 무진행은 직속 두 층에서 탐지한다',()=>{
  const now=Date.parse(t)+60000;
  assert.deepEqual(assessSupervisorIdle([],states(),now,30000,null,parents),[]);
  const found=assessSupervisorIdle([pending],states(),now,30000,null,parents);
  assert.deepEqual(found.map(x=>x.role).sort(),['prod-감독','prod-슈퍼감독'].sort());
  assert.ok(found.every(x=>x.openCards===1));
  assert.deepEqual(assessSupervisorIdle([pending,{...pending,kind:'done'}],states(),now,30000,null,parents),[]);
  const active=states();active.get('kadan-other-prefix-작업자').unchangedMs=1000;
  assert.deepEqual(assessSupervisorIdle([pending],active,now,30000,null,parents),[]);
});
test('09-07 다른 역할의 같은 카드 done은 내 미완료를 지우지 않는다', async () =>{
  const events=[pending,{...pending,kind:'done',role:'other-prefix-검수자'}];
  assert.equal(assessSupervisorIdle(events,states(),Date.parse(t)+60000,30000,null,parents).length,2);
});
async function watchExercise({role='prod-슈퍼감독', notificationFails=false, sendFails=false}={}) {
  let cycle=0;const sent=[],notifications=[],records=[],lines=[];
  const oldLoad=os.loadavg;os.loadavg=()=>[0,0,0];
  const starts=[...parents.keys()].map((r,i)=>({kind:'start',role:r,session:`kadan-${r}`,panePid:i+1,t}));
  const sentinel=new Error('test-finished');
  try {await assert.rejects(()=>runWatch({completionGraceMs:0,
    parents, routes:{prod:'prod-감독'},superRole:'옛-슈퍼', intervalMs:1000,stallN:100,
    floor:{list:()=>starts.map(x=>({session:x.session,pid:x.panePid})),read:s=>s===`kadan-${role}`?'KADAN:DONE card-test ok':'idle'},
    readEntries:()=>starts,record:e=>records.push(e),now:()=>Date.parse(t)+cycle*1000,
    sendAlert:(r,m)=>{sent.push({role:r,message:m});if(sendFails&&r==='prod-감독'){const e=new Error('recipient gone');e.delivery='not-sent';throw e}},
    print:l=>lines.push(l),spawn:(cmd,args)=>{
      if(cmd==='sleep'&&++cycle===3)throw sentinel;
      if(cmd==='osascript'){notifications.push(args);return {status:notificationFails?1:0,stderr:'disabled'}}
      if(cmd==='memory_pressure')return {status:0,stdout:'System-wide memory free percentage: 80%'};
      if(cmd==='sysctl')return {status:0,stdout:'used = 0M'};
      return {status:0,stdout:''};
    }
  }),e=>e===sentinel)}finally{os.loadavg=oldLoad}
  return {sent,notifications,records,lines};
}
test('09-07 슈퍼 완료후보는 사용자 알림 한번, 자기 세션 주입 없음', async () =>{
  const x=await watchExercise();assert.equal(x.notifications.length,1);assert.equal(x.sent.length,0);
  assert.equal(x.records[0].recipient,'@user');assert.equal(x.records[0].delivered,true);
});
test('09-07 사용자 알림 실패는 실패로 기록하고 반복하지 않는다', async () =>{
  const x=await watchExercise({notificationFails:true});assert.equal(x.notifications.length,1);
  assert.equal(x.records[0].delivered,false);assert.match(x.lines.join('\n'),/사용자 알림 실패/);
});
test('09-07 직속 전달 경합 실패는 해당 슈퍼로 한 번 상신한다', async () =>{
  const x=await watchExercise({role:'other-prefix-작업자',sendFails:true});
  assert.deepEqual(x.sent.map(x=>x.role),['prod-감독','prod-슈퍼감독']);
  assert.equal(x.records.find(x=>x.alertKind==='전달실패').recipient,'prod-슈퍼감독');
});
test('09-07 미발령 계획은 직속 감독에게 귀속하고 발령된 별도 판은 가짜 감독을 찾지 않는다',()=>{
 const now=Date.parse(t)+60000;
 const unsent={kind:'plan',board:'prod',taskId:'card-next',t};
 assert.deepEqual(assessSupervisorIdle([unsent],states(),now,30000,null,parents).map(x=>x.role).sort(),['prod-감독','prod-슈퍼감독'].sort());
 const events=[{...unsent,board:'product-integration',taskId:'card-1'},pending];
 assert.equal(assessSupervisorIdle(events,states(),now,30000,null,parents).length,2);
});

test('09-07 인계 관계표를 재시작 없이 읽고 오류 때 마지막 정상 관계와 사용자 경보를 유지한다', async () =>{
 let cycle=0;const records=[],sent=[];const stop=new Error('finished');
 const original=os.loadavg;os.loadavg=()=>[0,0,0];
 const starts=['p-작업자','p-감독','p-감독-2'].map((role,i)=>({kind:'start',role,session:`kadan-${role}`,panePid:i+1,t}));
 try {await assert.rejects(()=>runWatch({completionGraceMs:0,
  floor:{list:()=>starts.map(x=>({session:x.session,pid:x.panePid})),read:s=>s==='kadan-p-작업자'?`KADAN:DONE card-${cycle} ok`:'idle'},
  readEntries:()=>starts,record:e=>records.push(e),sendAlert:(role,message)=>sent.push({role,message}),
  intervalMs:1000,stallN:100,routes:{},superRole:'legacy',now:()=>Date.parse(t)+cycle*1000,print:()=>{},
  loadHierarchy:()=>{
   if(cycle===1)throw new Error('bad JSON');
   const parent=cycle===0?'p-감독':'p-감독-2';
   return {parents:parseHierarchy({'p-작업자':parent,'p-감독':'@user','p-감독-2':'@user'}),hash:parent,path:'/fixture/parents.json'};
  },
  spawn:(cmd)=>{
   if(cmd==='sleep'&&++cycle===4)throw stop;
   if(cmd==='memory_pressure')return {status:0,stdout:'System-wide memory free percentage: 80%'};
   if(cmd==='sysctl')return {status:0,stdout:'used = 0M'};
   return {status:0,stdout:''};
  }
 }),e=>e===stop)}finally{os.loadavg=original}
 assert.deepEqual(records.filter(e=>e.kind==='hierarchy-loaded').map(e=>e.hash),['p-감독','p-감독-2']);
 assert.ok(records.filter(e=>e.kind==='hierarchy-loaded').every(e=>e.pid===process.pid));
 assert.ok(records.some(e=>e.recipient==='@user'&&e.alertKind==='모름'));
 assert.deepEqual(sent.filter(e=>e.message.includes('끝난 것 같음')&&!e.message.includes('해소')).map(e=>e.role),['p-감독','p-감독','p-감독-2','p-감독-2']);
});
