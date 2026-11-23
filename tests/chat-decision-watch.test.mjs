import './helpers/isolated-home.mjs'; // 날것 실행이 운영 홈·알림에 닿지 않게(2026-11-23 사고)
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

async function simulate({minutes,decisions,works=[work],cards=[doneCard],extraEntries=[],raw=false,table=parents}){
  const nudges=[];let minute=0;const controller=new AbortController();
  const roleStarts=[...table.keys()].map((role,i)=>({kind:'start',role,session:'kadan-'+role,panePid:i+1,t:stamp(0)}));
  const entries=[...roleStarts,...entries0,...extraEntries];
  await runWatch({signal:controller.signal,intervalMs:60_000,stallN:2,stallAfterMs:300_000,idleMs:15*60_000,
    parents:table,routes:new Map(),superRole:'p-슈퍼감독',now:()=>epoch+minute*60_000,
    floor:{list:()=>roleStarts.map(s=>({session:s.session,pid:s.panePid})),read:()=>'frozen screen',alive:()=>true},
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

// ---- 업무·카드 없는 채팅 결정(2026-11-23): 업무가 없는 슈퍼감독의 할 일은 다른 슈퍼감독이 보낸 답 대기 우편(mail:<우편ID>)뿐이다.
// 결정을 등록할 곳이 없으면 kyle에게 채팅으로 묻는 동안에도 15분 뒤 '놀고 있음'이 난다. 요청 역할만 사용자 답 대기로 본다.
const twoSupers=new Map([...parents,['q-슈퍼감독','@user']]);
const peerQuestion={kind:'send',mailId:'q1',by:'q-슈퍼감독',role:'p-슈퍼감독',t:stamp(0),expectReply:true,transport:'mailbox'};
const noWork={id:'n1',card:null,chat:true,work:'',requestedBy:'p-슈퍼감독',status:'open',at:stamp(0)};
const noWorkRun=(decisions,minutes=40)=>simulate({minutes,decisions,works:[],cards:[],extraEntries:[peerQuestion],table:twoSupers});

test('재현: 업무·카드 없는 슈퍼감독은 받은 질문 우편 하나로 15분 뒤 놀고 있음이 난다(결정 없음)',async()=>{
  const nudges=await noWorkRun([],20);
  assert.deepEqual(nudges,[[15,'p-슈퍼감독']]);
});

test('표 1·4·5: 열린 무업무 채팅 결정이 있으면 요청 역할을 깨우지 않고, 닫히면 다시 대상이다',async()=>{
  assert.deepEqual(await noWorkRun([noWork]),[],'열린 동안 깨우지 않는다');
  assert.deepEqual(await noWorkRun([{...noWork,work:undefined}],20),[[15,'p-슈퍼감독']],'work 칸이 없는 chat 행은 저장소가 손상으로 거절하는 꼴이라 근거가 아니다');
  assert.deepEqual(await noWorkRun([{...noWork,status:'cancelled'}],20),[[15,'p-슈퍼감독']],'취소 뒤 평소 판정');
  assert.deepEqual(await noWorkRun([{...noWork,status:'answered'}],20),[[15,'p-슈퍼감독']],'답변 뒤 평소 판정');
});

// 검수 재현 세 꼴(PR #470): 보낼 때 업무·실행 주소를 직접 붙인 질문 우편은 결정이 열려 있어도 15분에 mail:q1로 깨운다.
for(const [name,attach,extra] of [
  ['--work를 붙인 우편',{workKey:'repo/w1'},{}],
  ['업무 소속 실행을 --execution으로 붙인 우편',{executionKey:'repo/t1'},{}],
  ['업무에 소속되지 않은 카드만 --execution으로 붙인 우편',{executionKey:'repo/card-x'},{works:[],cards:[]}],
]){
  test(`회귀: ${name}은 무업무 채팅 결정이 열려 있어도 가리지 않는다`,async()=>{
    const nudges=await simulate({minutes:20,decisions:[noWork],extraEntries:[{...peerQuestion,...attach}],table:twoSupers,raw:true,...extra});
    const mine=nudges.filter(([,role])=>role==='p-슈퍼감독');
    assert.deepEqual(mine.map(([m])=>m),[15]);assert.match(mine[0][2],/mail:q1/);
  });
}
test('대조: 업무·실행 주소가 전혀 안 붙은 질문 우편은 지금처럼 가린다',async()=>{
  assert.deepEqual(await noWorkRun([noWork]),[]);
});

test('표 4: 요청 역할의 업무에 안 이어진 질문 우편만 가린다. 다른 역할·업무·카드에 걸린 항목은 가리지 않는다',async()=>{
  assert.deepEqual(await noWorkRun([{...noWork,requestedBy:'q-슈퍼감독'}],20),[[15,'p-슈퍼감독']],'다른 역할의 결정은 가리지 않는다');
  // 다른 역할(p-감독)의 업무(w1)는 요청 역할이 결정을 열어도 그대로 깨운다.
  const other=await simulate({minutes:20,decisions:[noWork],extraEntries:[peerQuestion],table:twoSupers,raw:true});
  assert.deepEqual(other.map(([m,r])=>[m,r]),[[15,'p-감독']]);
  assert.match(other[0][2],/w1/);
  // 같은 요청 역할이 자기 차례인 열린 업무(w2)도 가지면: 질문 우편(mail:q1)은 가려지고 업무는 그대로 깨운다.
  const w2={...work,key:'repo/w2',id:'w2',title:'t',goal:'g',revision:1,history:[],owner:'p-슈퍼감독',ownedAt:stamp(0),executions:[],at:stamp(0)};
  const own=await simulate({minutes:20,decisions:[noWork],works:[w2],cards:[],extraEntries:[peerQuestion],table:twoSupers,raw:true});
  assert.deepEqual(own.map(([m,r])=>[m,r]),[[15,'p-슈퍼감독']],'업무에 걸린 일은 결정이 열려 있어도 깨운다');
  assert.match(own[0][2],/w2/);assert.doesNotMatch(own[0][2],/mail:q1/,'질문 우편은 답 대기로 빠진다');
  const noDecision=await simulate({minutes:20,decisions:[],works:[w2],cards:[],extraEntries:[peerQuestion],table:twoSupers,raw:true});
  assert.match(noDecision[0][2],/mail:q1/,'결정이 없으면 질문 우편도 할 일이다');
});
