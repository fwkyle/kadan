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

async function simulate({until=40,decisions=()=>[],hold=()=>false,releaseAt=null,alive=()=>true}={}) {
 const records=[...starts,...['w1','w2'].map(role=>({kind:'send',role,taskId:role,t:stamp(0)}))];
 const cards=['w1','w2'].map(card),calls=[],controller=new AbortController();
 let minute=0,finish=null;
 await runWatch({signal:controller.signal,intervalMs:60_000,stallN:2,stallAfterMs:300_000,
  parents,routes:new Map(),superRole:'top',judgeCmd:'fake',now:()=>epoch+minute*60_000,
  floor:{list:()=>starts.filter(s=>alive(s.session,minute)).map(s=>({session:s.session,pid:s.panePid})),
   read:session=>session==='kadan-w1'||session==='kadan-w2'?'출력 '+lt(minute):'정당한 대기'},
  readEntries:()=>records,readCards:()=>cards,readWorks:()=>[],readDecisions:()=>decisions(minute),
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
