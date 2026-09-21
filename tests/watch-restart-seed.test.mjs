import test from 'node:test';import assert from 'node:assert/strict';
import {seedAlertState} from '../src/watch-runner.mjs';

const at='2026-09-07T00:00:00Z',now=Date.parse(at)+6*60000,grace=5*60000;
const c={id:'c',key:'r/c',status:'assigned',role:'worker'},send={kind:'send',role:'worker',taskId:'c',t:at};
const alertId=`start-report:r/c:worker:${at}`;

test('시드는 배달됐지만 해소되지 않은 경보와 수신자를 복원하고 해소·옛 기록은 걸러낸다',()=>{
 const entries=[
  {kind:'alert',id:'a1',alertKind:'시작보고누락',level:'AMBER',role:'w',session:'kadan-w',taskId:'card-1',recipient:'boss',delivered:true,by:'watch'},
  {kind:'alert',id:'a1',alertKind:'시작보고누락',level:'AMBER',role:'w',session:'kadan-w',taskId:'card-1',recipient:'boss',delivered:true,by:'watch',resolved:true},
  {kind:'alert',id:'a2',alertKind:'죽음',level:'RED',role:'w2',session:'kadan-w2',recipient:'boss2',delivered:true,by:'watch'},
  {kind:'alert',alertKind:'죽음',level:'RED',recipient:'boss2',delivered:true,by:'watch'},
  {kind:'alert',id:'a3',alertKind:'모름',level:'AMBER',session:'kadan-w3',recipient:'boss',delivered:false,by:'watch'},
  {kind:'send',role:'w',taskId:'card-1'},
 ];
 const s=seedAlertState(entries);
 assert.equal(s.active.length,2);
 assert.deepEqual(s.active[0],{id:'a2',kind:'죽음',level:'RED',role:'w2',session:'kadan-w2',taskId:undefined,verdict:undefined,reason:undefined,judgeVerdict:undefined,judgeReason:undefined});
 assert.deepEqual(s.active[1],{id:'a3',kind:'모름',level:'AMBER',role:undefined,session:'kadan-w3',taskId:undefined,verdict:undefined,reason:undefined,judgeVerdict:undefined,judgeReason:undefined});
 assert.deepEqual([...s.recipients],[['a2','boss2']]);
});

async function fixture(entries,cards){
 const {runWatch}=await import('./helpers/watch-runner.mjs');
 const starts=['worker','boss'].map((role,i)=>({kind:'start',role,session:'kadan-'+role,panePid:String(i+1),t:at}));
 let cycle=0;const messages=[],records=[],end=new Error('end');
 await assert.rejects(()=>runWatch({floor:{list:()=>starts.map(s=>({session:s.session,pid:s.panePid})),read:()=> 'working'},readEntries:()=>[...starts,send,...entries],readCards:()=>typeof cards==='function'?cards(cycle):cards,startReportGraceMs:grace,intervalMs:grace,stallN:100,parents:new Map([['worker','boss'],['boss','@user']]),routes:new Map(),superRole:'boss',now:()=>now+cycle*grace,record:r=>records.push(r),sendAlert:(role,text)=>messages.push({role,text}),print:()=>{},spawn:cmd=>{if(cmd==='sleep'&&++cycle===3)throw end;if(cmd==='memory_pressure')return{status:0,stdout:'System-wide memory free percentage: 80%'};if(cmd==='sysctl')return{status:0,stdout:'used = 0M'};return{status:0,stdout:''};}}),e=>e===end);
 return {messages,records};
}

test('재시작이라도 이미 배달된 같은 경보는 다시 보내지 않는다 — 재전송 묶음 원인(2026-09-12 실측)',async()=>{
 const seeded={kind:'alert',id:alertId,alertKind:'시작보고누락',level:'AMBER',role:'worker',session:'kadan-worker',taskId:'c',recipient:'boss',delivered:true,by:'watch'};
 const {messages,records}=await fixture([seeded],[c]);
 assert.equal(messages.filter(m=>m.text.includes('시작 보고 누락')).length,0);
 assert.equal(records.filter(r=>r.alertKind==='시작보고누락').length,0);
});

test('복원된 경보의 조건이 풀렸으면 기억한 수신자에게 해소를 한 번 보낸다',async()=>{
 const seeded={kind:'alert',id:alertId,alertKind:'시작보고누락',level:'AMBER',role:'worker',session:'kadan-worker',taskId:'c',recipient:'boss',delivered:true,by:'watch'};
 const cards=cycle=>[{...c,...(cycle>=2?{activity:'running',activityRole:'worker',activityAt:new Date(now).toISOString()}:{})}];
 const {messages,records}=await fixture([seeded],cards);
 assert.equal(messages.filter(m=>m.text.includes('시작 보고 누락')&&!m.text.includes('해소됨')).length,0);
 assert.equal(messages.filter(m=>m.text.includes('시작 보고 누락 - 해소됨')).length,1);
 assert.equal(messages.find(m=>m.text.includes('해소됨'))?.role,'boss');
 assert.equal(records.filter(r=>r.resolved===true&&r.alertKind==='시작보고누락').length,1);
});

test('시드가 없는 새 경보는 정상으로 울리고 기록에는 복원용 id가 남는다',async()=>{
 const {messages,records}=await fixture([],[c]);
 assert.equal(messages.filter(m=>m.text.includes('시작 보고 누락')&&!m.text.includes('해소됨')).length,1);
 assert.equal(records.find(r=>r.alertKind==='시작보고누락')?.id,alertId);
});
