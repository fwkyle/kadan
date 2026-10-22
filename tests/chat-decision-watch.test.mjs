import test from 'node:test';
import assert from 'node:assert/strict';
// 채팅 결정(decision request --chat, card:null)이 열린 업무는 놀고 있음 대상이 아니다. 감시기 540행 한 줄만 이를 위해 넓혔다.
import {runWatch} from '../src/watch-runner.mjs';
const epoch=Date.parse('2026-09-09T00:00:00Z');
const stamp=m=>new Date(epoch+m*60_000).toISOString();
const parents=new Map([['p-작업자','p-감독'],['p-감독','p-슈퍼감독'],['p-슈퍼감독','@user']]);
const starts=[...parents.keys()].map((role,i)=>({kind:'start',role,session:'kadan-'+role,panePid:i+1,t:stamp(0)}));
const doneCard={id:'t1',key:'repo/t1',role:'p-작업자',board:'p',status:'done',activity:'done',workType:'execution'};
const work={key:'repo/w1',status:'open',owner:'p-감독',executions:[{key:'repo/t1'}],at:stamp(0)};
const entries0=[{kind:'send',role:'p-작업자',taskId:'t1',t:stamp(0)},{kind:'done',role:'p-작업자',taskId:'t1',result:'ok',t:stamp(1)}];
const chat={id:'c1',card:null,chat:true,work:'repo/w1',requestedBy:'p-슈퍼감독',status:'open',at:stamp(0)};

async function simulate({minutes,decisions,works=[work],cards=[doneCard],extraEntries=[],raw=false}){
  const nudges=[];let minute=0;const controller=new AbortController();const entries=[...starts,...entries0,...extraEntries];
  await runWatch({signal:controller.signal,intervalMs:60_000,stallN:2,stallAfterMs:300_000,idleMs:15*60_000,
    parents,routes:new Map(),superRole:'p-슈퍼감독',now:()=>epoch+minute*60_000,
    floor:{list:()=>starts.map(s=>({session:s.session,pid:s.panePid})),read:()=>'frozen screen',alive:()=>true},
    readEntries:()=>entries,readCards:()=>cards,readWorks:()=>works,readDecisions:()=>decisions,
    sendAlert:()=>{},sendNudge:(role,msg)=>{nudges.push([minute,role,msg]);},
    record:e=>{entries.push({...e,t:stamp(minute)});},print:()=>{},spawn:()=>({status:0,stdout:''}),
    sleep:async()=>{if(++minute>=minutes)controller.abort();}});
  return raw?nudges:nudges.map(([m,r])=>[m,r]);
}

test('열린 채팅 결정이 걸린 업무는 놀고 있음으로 깨우지 않고, 닫힌 뒤에는 다시 대상이다',async()=>{
  assert.deepEqual(await simulate({minutes:40,decisions:[chat]}),[],'열린 채팅 결정이 있으면 감독을 깨우지 않는다');
  assert.deepEqual(await simulate({minutes:20,decisions:[{...chat,status:'cancelled'}]}),[[15,'p-감독']],'취소로 닫히면 다시 할 일');
  assert.deepEqual(await simulate({minutes:20,decisions:[{...chat,status:'answered'}]}),[[15,'p-감독']],'답으로 닫혀도 다시 할 일');
});

test('chat이 아닌 card:null 손상 행은 지금처럼 감시 제외로 올리지 않는다',async()=>{
  const damaged={...chat};delete damaged.chat;
  assert.deepEqual(await simulate({minutes:20,decisions:[damaged]}),[[15,'p-감독']]);
  assert.deepEqual(await simulate({minutes:20,decisions:[{...chat,work:undefined}]}),[[15,'p-감독']],'work가 없는 chat 행도 제외 근거가 아니다');
});

// PR-1(사용자 차례 대기)과 PR-2(채팅 결정)가 같은 waits 목록에 함께 들어간다. 둘 다 빠지고 다른 업무는 그대로다.
test('채팅 결정 업무와 @user 차례 업무가 같은 주기에 있어도 둘 다 빠지고 다른 업무만 깨운다',async()=>{
  const mk=n=>({...work,key:'repo/w'+n,id:'w'+n,title:'t',goal:'g',revision:1,history:[],ownedAt:stamp(0),executions:[{key:'repo/t'+n,phase:'implementation',round:1}]});
  const card=n=>({...doneCard,id:'t'+n,key:'repo/t'+n,at:stamp(0)});
  const sends=[2,3].flatMap(n=>[{kind:'send',role:'p-작업자',taskId:'t'+n,t:stamp(0)},{kind:'done',role:'p-작업자',taskId:'t'+n,result:'ok',t:stamp(1)}]);
  const w1=mk(1),w2={...mk(2),turnOwner:'@user',turnAt:stamp(1)},w3=mk(3);
  const nudges=await simulate({minutes:20,decisions:[chat],works:[w1,w2,w3],cards:[card(1),card(2),card(3)],extraEntries:sends,raw:true});
  assert.equal(nudges.length,1,'다른 업무(w3) 하나만 깨운다');
  assert.match(nudges[0][2],/w3/);assert.doesNotMatch(nudges[0][2],/w1|w2/);
  const only=await simulate({minutes:20,decisions:[],works:[w1,w2,w3],cards:[card(1),card(2),card(3)],extraEntries:sends,raw:true});
  assert.match(only[0][2],/w1/,'채팅 결정이 없으면 w1은 다시 대상이다');assert.doesNotMatch(only[0][2],/w2/,'@user 차례는 결정 없이도 빠진다');
});
