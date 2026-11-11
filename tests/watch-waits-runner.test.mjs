import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {runWatch} from '../src/watch-runner.mjs';
import {watchResponsibility} from '../src/watch-report.mjs';

// 러너 순회를 지나는 시험: 가짜 시계·가짜 세션·가짜 AI만 쓴다. 역할 이름은 운영 이름이 아닌 가짜다.
const lt=n=>[...String(n)].map(d=>'ghijklmnop'[d]).join('');
const epoch=Date.parse('2026-09-09T00:00:00Z');
const stamp=minute=>new Date(epoch+minute*60_000).toISOString();
const parents=new Map([['w1','boss'],['w2','boss'],['boss','top'],['top','@user']]);
const starts=['w1','w2','boss','top'].map((role,i)=>({kind:'start',role,session:'kadan-'+role,panePid:i+1,t:stamp(0)}));
const card=role=>({id:role,key:'r/'+role,role,status:'assigned',activity:'running',workType:'execution'});
const decision=(over={})=>({id:'d-'+(over.card??over.work??'x'),status:'open',requestedBy:'top',question:'감독을 다시 띄울지',options:['예','아니오'],recommendation:'예',at:stamp(0),...over});

async function simulate({until=40,decisions=()=>[],hold=()=>false,releaseAt=null,alive=()=>true,readAutopilotWingman}={}) {
 const records=[...starts,...['w1','w2'].map(role=>({kind:'send',role,taskId:role,t:stamp(0)}))];
 const cards=['w1','w2'].map(card),calls=[],controller=new AbortController();
 let minute=0,finish=null;
 await runWatch({signal:controller.signal,intervalMs:60_000,stallN:2,stallAfterMs:300_000,
  parents,routes:new Map(),superRole:'top',judgeCmd:'fake',now:()=>epoch+minute*60_000,
  floor:{list:()=>starts.filter(s=>alive(s.session,minute)).map(s=>({session:s.session,pid:s.panePid})),
   read:session=>session==='kadan-w1'||session==='kadan-w2'?'출력 '+lt(minute):'정당한 대기'},
  readEntries:()=>records,readCards:()=>cards,readWorks:()=>[],readDecisions:()=>decisions(minute),...(readAutopilotWingman?{readAutopilotWingman}:{}),
  sendAlert:()=>{},record:e=>records.push({...e,t:stamp(minute)}),print:()=>{},spawn:()=>({status:0,stdout:''}),
  ai:{reports:{retire:()=>{}},run:args=>{
   calls.push({minute,role:args.role,source:args.source,input:args.input});
   records.push({kind:'watch-ai-request',role:args.role,session:args.session,source:args.source,
    evidenceDigest:args.evidenceDigest,responsibility:watchResponsibility(args.role,cards,records,parents,args.source),t:stamp(minute)});
   if(!hold(args,minute))return {ok:true};
   return new Promise(resolve=>{let done=false;finish=()=>{if(done)return;done=true;resolve({ok:true});};args.signal.addEventListener('abort',finish,{once:true});});
  }},
  sleep:async()=>{if(minute===releaseAt)finish?.();await setImmediate();if(++minute>=until)controller.abort();},
 });
 return {calls,records};
}

test('F3: 대기열에 들어간 progress 작업도 실행 직전에 답 대기가 걸려 있으면 AI를 부르지 않는다',async()=>{
 // 30분에 w1 호출이 길게 이어져 w2 작업이 대기열에 머문다. 32분에 w2의 카드에 열린 결정이 생기고 33분에 풀린다.
 const decisions=minute=>minute>=32?[decision({card:'r/w2'})]:[];
 const {calls}=await simulate({until:40,decisions,hold:(args,minute)=>args.source==='progress'&&args.role==='w1'&&minute===30,releaseAt:33});
 const progress=calls.filter(c=>c.source==='progress');
 assert.deepEqual(progress.map(c=>[c.minute,c.role]),[[30,'w1']],'w2는 답 대기 중이라 부르지 않는다');
});
test('F3 대조: 답 대기가 없으면 같은 대기열의 w2 작업은 풀린 뒤 그대로 호출된다',async()=>{
 const {calls}=await simulate({until:40,hold:(args,minute)=>args.source==='progress'&&args.role==='w1'&&minute===30,releaseAt:33});
 assert.deepEqual(calls.filter(c=>c.source==='progress').map(c=>[c.role]),[['w1'],['w2']]);
});
test('F2: 직속 감독 세션이 꺼져 있으면 실제 전달 경로가 고른 상위 감독의 열린 결정을 입력에 싣는다',async()=>{
 const decisions=()=>[decision({id:'d-top',work:'r/other-work',chat:true,card:null,requestedBy:'top'}),decision({work:'r/boss-work',chat:true,card:null,requestedBy:'boss',id:'d-boss'})];
 const {calls}=await simulate({until:32,decisions,alive:(session)=>session!=='kadan-boss'});
 const first=calls.find(c=>c.source==='progress');
 assert.ok(first,'progress 호출이 있어야 한다');
 assert.deepEqual(first.input.openDecisions.map(d=>d.id),['d-top']);
});

// 완전자율: 대기 시간이 지나 진행할 자격이 생겼거나 진행 기록이 붙은 결정은 답 대기에서 빠진다(그 일이 다시 감독의 할 일이다).
// 값을 읽지 못하거나 자격이 없으면 계속 답 대기다. 감시기는 결정·원장을 쓰지 않는다(records에 결정 사건이 없다).
const ap=(over={})=>({on:true,level:'full',startedAt:stamp(0),decideAfterMs:30*60_000,...over});
const hold30=(args,minute)=>args.source==='progress'&&args.role==='w1'&&minute===30;
const progressCalls=async(extra,decisionOver)=>{
 const decisions=minute=>minute>=32?[decision({card:'r/w2',reversible:'브랜치를 지운다',notProhibited:{by:'top',at:stamp(0)},...decisionOver})]:[];
 const {calls,records}=await simulate({until:40,decisions,hold:hold30,releaseAt:33,...extra});
 return {progress:calls.filter(c=>c.source==='progress').map(c=>[c.minute,c.role]),records};
};
test('완전자율 W1: 대기 시간(30분)이 지난 --reversible 결정은 사용자 답 대기에서 빠져 요청한 역할의 할 일이 된다(진행 기록 전까지 그 카드의 정체 판정은 계속 쉰다)',async()=>{
 const {progress,records}=await progressCalls({readAutopilotWingman:()=>ap()});
 assert.deepEqual(progress.map(c=>c[1]),['w1']);
 assert.equal(records.some(e=>e.kind==='decision'||e.kind==='autopilot-note'),false,'감시기는 결정·원장 기록을 쓰지 않는다');
});
test('완전자율 W2: 대기 시간 전(60분 설정)·낮은 단계·꺼짐·--reversible 없음·읽기 실패는 계속 답 대기',async()=>{
 for(const [name,extra,over] of [
  ['시간 전',{readAutopilotWingman:()=>ap({decideAfterMs:60*60_000})},{}],
  ['autopilot 단계',{readAutopilotWingman:()=>ap({level:'autopilot'})},{}],
  ['꺼짐',{readAutopilotWingman:()=>ap({on:false})},{}],
  ['--reversible 없음',{readAutopilotWingman:()=>ap()},{reversible:undefined}],
  ['스냅샷 읽기 실패',{readAutopilotWingman:()=>{throw new Error('읽기 실패');}},{}],
  ['대기 시간 값 깨짐',{readAutopilotWingman:()=>ap({decideAfterMs:null})},{}],
  ['스냅샷 주입 없음',{},{}],
 ]){
  const {progress}=await progressCalls(extra,over);
  assert.deepEqual(progress.map(c=>c[1]),['w1'],name+': w2는 답 대기라 부르지 않는다');
 }
});
test('완전자율 W3: 진행 기록이 붙은 결정은 스냅샷 없이도 더 세지 않는다',async()=>{
 const {progress}=await progressCalls({},{proceeded:{by:'top',at:stamp(31),recommendation:'예',reversible:'브랜치를 지운다'}});
 assert.deepEqual(progress.map(c=>c[1]),['w1','w2']);
});
test('완전자율 W4: 주기마다 스냅샷은 한 번만 읽는다(결정이 여럿이어도 새 읽기는 결정 수에 비례하지 않는다)',async()=>{
 let reads=0;
 const decisions=minute=>minute>=32?Array.from({length:50},(_,i)=>decision({card:'r/w2',work:'w'+i,reversible:'x',notProhibited:{by:'top',at:stamp(0)}})).map((d,i)=>({...d,id:'d'+i,card:'r/w2'})):[];
 await simulate({until:40,decisions,hold:hold30,releaseAt:33,readAutopilotWingman:()=>{reads++;return ap();}});
 // 8개 주기(32~39분)에서 결정 50개를 판정해도 읽기는 주기당 최대 1번(경보 경로의 Wingman 읽기를 합쳐도 주기 수 이하)
 assert.ok(reads<=8*2,'읽기 '+reads+'번');
});
