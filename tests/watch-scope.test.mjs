import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {buildWatchScope} from '../src/watch-scope.mjs';
import {runWatch} from './helpers/watch-runner.mjs';
const t='2026-09-08T00:00:00Z';
const parents=new Map([['p-작업자','p-감독'],['p-감독','p-슈퍼감독'],['p-슈퍼감독','@user']]);
const card={id:'c',key:'r/c',role:'p-작업자',board:'p',status:'assigned',workType:'execution',at:t};
const send={kind:'send',role:card.role,taskId:'c',t};
test('완료·보류·대체 카드는 옛 send가 있어도 감시하지 않는다',()=>{
 for(const status of ['done','hold','superseded','cancelled','draft','ready']) assert.equal(buildWatchScope([{...card,status}],[send],parents).sessions.size,0);
});
test('assigned여도 마지막 실제 실행이 done이면 담당과 상위 책임을 함께 제외한다',()=>{
 for(const result of ['ok','failed']) for(const hierarchy of [parents,new Map()]){
  const scope=buildWatchScope([card],[send,{...send,kind:'done',result}],hierarchy);
  assert.deepEqual([...scope.sessions],[]);
  assert.deepEqual(scope.entries,[]);
 }
});
test('활성 assigned 실행의 미완료 실제 send가 있는 작업자만 감시한다',()=>{
 const again={...send,t:'2026-09-08T00:01:00Z'};
 for(const entries of [[send],[send,{...send,kind:'done'},again]]){
  const scope=buildWatchScope([{...card,activity:'waiting'}],entries,parents);
  assert.deepEqual([...scope.sessions],['kadan-p-작업자']);
  assert.equal(scope.entries.length,1);
  assert.equal(scope.entries[0].t,entries.at(-1).t);
 }
 assert.equal(buildWatchScope([card],[],parents).sessions.size,0);
 assert.equal(buildWatchScope([card],[{...send,transport:'mailbox'}],parents).sessions.size,0);
 // 원장의 최초 done만 인정한다. 같은 ID 재발령 뒤 중복 done은 새 완료가 아니다.
 assert.equal(buildWatchScope([card],[send,{...send,kind:'done'},again,{...again,kind:'done'}],parents).sessions.size,1);
});
test('완료 뒤 우편은 실행을 다시 열지 않고 다른 담당·실행의 done은 종료 근거가 아니다',()=>{
 const done={...send,kind:'done'};
 assert.equal(buildWatchScope([card],[send,done,{...send,transport:'mailbox'}],parents).sessions.size,0);
 for(const unrelated of [{...done,role:'p-검수자'},{...done,taskId:'other'},{...done,transport:'mailbox'}]){
  assert(buildWatchScope([card],[send,unrelated],parents).sessions.has('kadan-p-작업자'));
 }
});
test('현재 send 이후 담당자의 유효 waiting은 화면·AI 대상에서 제외한다',()=>{
 const waiting={...card,activity:'waiting',activityRole:card.role,activityAt:t};
 assert.deepEqual(buildWatchScope([waiting],[send],parents),{sessions:new Set(),entries:[]});
 for(const invalid of [{activityRole:'다른역할'},{activityRole:null},{activityAt:'invalid'},{activityAt:null}]){
  assert(buildWatchScope([{...waiting,...invalid}],[send],parents).sessions.has('kadan-p-작업자'));
 }
});
test('waiting 뒤 실제 새 send는 감시를 복귀시키고 옛 waiting이나 우편과 구분한다',()=>{
 const waiting={...card,activity:'waiting',activityRole:card.role,activityAt:t};
 const again={...send,t:'2026-09-08T00:01:00Z'};
 const scope=buildWatchScope([waiting],[send,again],parents);
 assert.deepEqual([...scope.sessions],['kadan-p-작업자']);assert.equal(scope.entries[0].t,again.t);
 assert.equal(buildWatchScope([waiting],[send,{...again,transport:'mailbox'}],parents).sessions.size,0);
});
test('다른 미완료 assigned 실행과 실제 send가 있으면 해당 작업자 감시는 남는다',()=>{
 for(const status of ['assigned','done']) for(const role of [card.role,'p-검수자']){
  const other={...card,id:'other',key:'r/other',role};
  const scope=buildWatchScope([{...card,status},other],[send,{...send,kind:'done'},{...send,role,taskId:'other'}],parents);
  assert.deepEqual([...scope.sessions],[`kadan-${role}`]);
  assert.deepEqual(scope.entries.map(e=>e.taskId),['other']);
 }
});
test('ready 계획과 start만으로 감독·슈퍼감독을 세션 감시에 넣지 않는다',()=>{
 const entries=[send,{...send,kind:'done'}];
 const scope=buildWatchScope([{...card,status:'ready'}],entries,parents);
 assert.deepEqual([...scope.sessions],[]);
 assert.deepEqual(scope.entries,[]);
 const superStart={kind:'start',role:'p-슈퍼감독',session:'kadan-p-슈퍼감독',panePid:3,t};
 const finished=buildWatchScope([card],[...entries,superStart,{kind:'plan',board:'p',taskId:'legacy',t}],parents);
 assert.deepEqual([...finished.sessions],[]);
 assert.deepEqual(finished.entries,[]);
});
test('감독은 이름 대신 실제 관리관계와 관리 카드 구분으로 제외한다',()=>{
 const hierarchy=new Map([['leaf','boss'],['boss','top'],['top','@user']]);
 for(const role of ['boss','top']){
  const scope=buildWatchScope([{...card,role}],[{...send,role}],hierarchy);
  assert.deepEqual([...scope.sessions],[]);assert.deepEqual(scope.entries,[]);
 }
 assert.equal(buildWatchScope([{...card,role:'p-감독',workType:'coordination'}],[{...send,role:'p-감독'}],new Map()).sessions.size,0);
 const role='감독이라는이름의실행자';
 assert.deepEqual([...buildWatchScope([{...card,role}],[{...send,role}],new Map([[role,'boss'],['boss','@user']])).sessions],[`kadan-${role}`]);
});
test('재배정은 옛 담당 제외, 확정 인계는 실제 발령을 이어받고 미등록 실행은 제외한다', async () =>{
 assert(!buildWatchScope([{...card,role:'p-검수자'}],[send],parents).sessions.has('kadan-p-작업자'));
 const handover={kind:'handover',phase:'transferred',from:card.role,to:'p-후임',taskIds:['c'],t};
 assert(buildWatchScope([card],[send,handover],parents).sessions.has('kadan-p-후임'));
 assert.equal(buildWatchScope([],[send,{...send,kind:'done'}],parents).sessions.size,0);
 assert.equal(buildWatchScope([],[send],parents).sessions.size,0);
});
async function exercise(failure=null,completeExecution=false,empty=false){
 let cycle=0;const stop=new Error('end'),reads=[],messages=[],judges=[],records=[],retired=[],resources=[];
 const starts=[card.role,'p-감독','p-슈퍼감독'].map((role,i)=>({kind:'start',role,session:'kadan-'+role,panePid:i+1,t}));
 const originalLoad=os.loadavg;os.loadavg=()=>[0,0,0];
 try { await assert.rejects(()=>runWatch({floor:{list:()=>starts.map(s=>({session:s.session,pid:s.panePid})),read:session=>{reads.push([cycle,session]);return 'still';}},
 readEntries:()=>{if(failure==='ledger'&&cycle>=2)throw Error('broken');return [...starts,send,{...send,role:'p-감독'},...(completeExecution&&cycle>=2?[{...send,kind:'done'}]:[]),...(failure==='broken'&&cycle>=2?[{broken:'bad JSONL'}]:[])];},
 readCards:()=>{if(cycle>=2){if(failure==='cards')throw Error('broken');if(failure==='scope')return null;}return empty?[{...card,role:'p-감독',workType:'coordination'}]:[{...card,status:!completeExecution&&cycle>=2?'done':'assigned',activity:'running',activityRole:card.role,activityAt:t}];},
 ai:{reports:{retire:()=>retired.push(cycle)},run:candidate=>{judges.push([cycle,candidate.role]);return {ok:false,reason:'call-failed'};}},
 intervalMs:1000,stallN:1,judgeCmd:'judge',judgeCooldownMs:0,routes:{p:'p-감독'},superRole:'p-슈퍼감독',parents,idleMs:999999,
 loadHierarchy:()=>{if(failure==='hierarchy')throw Error('broken');return {parents,hash:'fixture',path:'/fixture/parents.json'};},
 now:()=>Date.parse(t)+cycle*1000,record:e=>records.push(e),sendAlert:(...a)=>messages.push([cycle,...a]),print:()=>{},spawn:cmd=>{
 if(cmd==='sleep'){if(++cycle===4)throw stop;return {};}
 if(cmd==='memory_pressure'){resources.push(cycle);return {status:0,stdout:`System-wide memory free percentage: ${failure==='resources'?10:80}%`};}
 if(cmd==='sysctl')return {status:0,stdout:'used = 0M'};
 return {status:0,stdout:''};
 }}),e=>e===stop); } finally { os.loadavg=originalLoad; }
 return {reads,messages,judges,records,retired,resources};
}
test('AI 점검 도중 완료되면 늦은 호출 실패·화면읽기·해소 깨움 없음', async () =>{
 for(const execution of [false,true]){
  const r=await exercise(null,execution);assert.deepEqual(r.judges,[[1,card.role]]);
  assert(r.reads.every(([c,session])=>c<2&&['kadan-p-작업자','kadan-p-감독'].includes(session)));
  assert(r.messages.every(([c])=>c<2));
  assert(!r.records.some(e=>e.role===card.role&&e.delivered));
  assert(r.records.some(e=>e.kind==='watch-scope'&&e.sessions.length===0));
 }
});
test('카드·원장 읽기 실패와 불명 scope는 AI호출·가짜회복 없이 기존 경보를 보존한다', async () =>{
 assert.throws(()=>buildWatchScope([card],[send,{broken:'bad JSONL'}],parents),/원장 읽기 실패/);
 for(const failure of ['cards','ledger','scope','broken']){
  const r=await exercise(failure,true);assert.deepEqual(r.judges,[[1,card.role]]);
  assert(r.reads.every(([c])=>c<2));assert.deepEqual(r.retired,[0,1]);
  assert(r.records.some(e=>e.alertKind==='모름'));
  assert(!r.records.some(e=>e.resolved));
  assert(!r.messages.some(([, ,m])=>m.includes('의심 해제')));
 }
});
test('실제 작업자가 없으면 화면·AI·자원 수집은 0이고 관계 오류 감시는 남는다', async () =>{
 for(const failure of [null,'hierarchy','resources']){
  const r=await exercise(failure,false,true);assert.deepEqual(r.reads,[]);assert.deepEqual(r.judges,[]);
  assert.deepEqual(r.resources,[]);
  if(failure==='hierarchy')assert(r.records.some(e=>e.alertKind==='모름'&&e.recipient==='@user'&&e.delivered===true));
  else assert.deepEqual(r.messages,[]);
  assert(!r.records.some(e=>e.alertKind==='자원'));
 }
});
