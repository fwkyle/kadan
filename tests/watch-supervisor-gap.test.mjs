import test from 'node:test';
import assert from 'node:assert/strict';
// 가짜 시계 시뮬레이션: sleep이 분을 올리고 끝에서 중단한다(helpers/watch-runner는 sleep을 덮어써 쓰지 않는다).
import {runWatch} from '../src/watch-runner.mjs';

// 점검 보고서(2026-10-05) 시뮬레이션에서 둘 다 0회였다: 최상위 감독의 죽음, 등록된 감독의 놀고 있음.
// 같은 날 결정: 감독 멈춤은 2단이다 — 15분이면 본인에게, 15분 더면 상위에게. 움직이면 둘 다 닫히고 해소 우편은 없다.
// --wake(30분 타이머 고정 점검)는 없앴다.
const epoch=Date.parse('2026-09-09T00:00:00Z');
const stamp=m=>new Date(epoch+m*60_000).toISOString();
const parents=new Map([['p-작업자','p-감독'],['p-감독','p-슈퍼감독'],['p-슈퍼감독','@user']]);
const starts=[...parents.keys()].map((role,i)=>({kind:'start',role,session:'kadan-'+role,panePid:i+1,t:stamp(0)}));
const card={id:'t1',key:'repo/t1',role:'p-작업자',board:'p',status:'assigned',activity:'running',workType:'execution'};

async function simulate({minutes,alive=()=>true,list=()=>starts.map(s=>({session:s.session,pid:s.panePid})),sendNudge=null,read=()=>'frozen screen',
  cards=[card],works=[],decisions=[],entries:extra=[{kind:'send',role:'p-작업자',taskId:'t1',t:stamp(0)},{kind:'plan',board:'p',taskId:'t1',t:stamp(0)}]}){
  const records=[],sent=[],printed=[],nudges=[];let minute=0;const controller=new AbortController();
  const entries=[...starts,...extra];
  await runWatch({signal:controller.signal,intervalMs:60_000,stallN:2,stallAfterMs:300_000,idleMs:15*60_000,
    parents,routes:new Map(),superRole:'p-슈퍼감독',
    now:()=>epoch+minute*60_000,
    floor:{list,read:s=>read(s,minute),alive},
    readEntries:()=>entries,readCards:()=>cards,readWorks:()=>works,readDecisions:()=>decisions,
    sendAlert:(role,msg)=>sent.push([minute,role,msg]),
    sendNudge:(role,msg)=>{nudges.push([minute,role,msg]);return sendNudge?.(role,msg);},
    record:e=>{records.push({...e,minute});entries.push({...e,t:stamp(minute)});},
    print:l=>printed.push(l),spawn:()=>({status:0,stdout:''}),
    sleep:async()=>{if(++minute>=minutes)controller.abort();}});
  const alerts=records.filter(e=>e.kind==='alert'&&!e.resolved);
  return {alerts,sent,printed,nudges,records};
}

test('최상위 감독의 세션이 없으면 죽음 경보가 @user에게 간다',async()=>{
  const {alerts}=await simulate({minutes:3,list:()=>starts.filter(s=>s.role!=='p-슈퍼감독').map(s=>({session:s.session,pid:s.panePid})),
    alive:s=>s!=='kadan-p-슈퍼감독'});
  const death=alerts.filter(a=>a.role==='p-슈퍼감독');
  assert.ok(death.length>=1,'최상위 감독 경보 없음');
  assert.equal(death[0].alertKind,'죽음');assert.equal(death[0].level,'RED');assert.equal(death[0].recipient,'@user');
});

test('감독 멈춤 2단: 15분에 본인, 30분에 상위(감독→슈퍼감독, 슈퍼감독→@user). 작업자 정체는 그대로, 작업자에게 본인 알림은 없다',async()=>{
  const {alerts,sent,nudges,records,printed}=await simulate({minutes:40});
  assert.deepEqual(nudges.map(([m,r])=>[m,r]),[[15,'p-감독'],[15,'p-슈퍼감독']]);
  // 2단으로 올라가는 순간 1단은 '해소됨'이 아니다(PR #99 검수 1): 출력에 해소가 없고, 원장에는 escalatedTo를 단 닫힘만 남는다.
  assert.ok(!printed.some(l=>l.includes('놀고 있음 - 해소됨')),'승격을 해소로 찍으면 안 된다');
  assert.deepEqual(records.filter(e=>e.kind==='alert'&&e.resolved&&e.alertKind==='놀고 있음').map(e=>[e.minute,e.id,e.escalatedTo]),
    [[30,'idle:hierarchy:p-감독','idle:hierarchy:p-감독:상위'],[30,'idle:hierarchy:p-슈퍼감독','idle:hierarchy:p-슈퍼감독:상위']]);
  assert.match(nudges[0][2],/놀고 있음 kadan-p-감독 \(할 일 1건, 15분간 화면 변화 없음\) — 판을 확인하고 다음 행동을 정하라\. 이대로 15분 더 멈추면 상위에게 알린다\./);
  const idle=alerts.filter(a=>a.alertKind==='놀고 있음');
  assert.deepEqual(idle.map(a=>[a.minute,a.role,a.recipient]),[[15,'p-감독','p-감독'],[15,'p-슈퍼감독','p-슈퍼감독'],[30,'p-감독','p-슈퍼감독'],[30,'p-슈퍼감독','@user']]);
  const escalated=sent.filter(([,,m])=>m.includes('놀고 있음'));
  assert.deepEqual(escalated.map(([m,r])=>[m,r]),[[30,'p-슈퍼감독']]);
  assert.match(escalated[0][2],/30분간 화면 변화 없음; 15분 전에 본인에게 알렸으나 그대로/);
  assert.ok(alerts.some(a=>a.alertKind==='정체'&&a.role==='p-작업자'),'작업자 정체 경보가 사라짐');
  assert.ok(!nudges.some(([,r])=>r==='p-작업자'));
  assert.ok(!alerts.some(a=>a.alertKind==='죽음'));
});

test('본인에게 넣은 알림 글은 화면 변화로 세지 않는다 — 알림이 경보를 닫고 15분마다 다시 울리는 타이머가 되면 안 된다',async()=>{
  const delivered=new Map();
  const {nudges,records}=await simulate({minutes:70,
    sendNudge:(role,msg)=>{delivered.set('kadan-'+role,(delivered.get('kadan-'+role)??'')+'\n'+msg);},
    read:s=>'frozen screen'+(delivered.get(s)??'')});
  assert.deepEqual(nudges.map(([m,r])=>[m,r]),[[15,'p-감독'],[15,'p-슈퍼감독']],'70분 동안 본인 알림은 역할마다 한 번');
  assert.ok(!records.some(e=>e.kind==='alert'&&e.alertKind==='놀고 있음'&&e.resolved&&e.minute<30),'알림 글 때문에 닫힌 경보가 없다');
});

test('사람이 그 창에서 입력 중이면 본인 알림을 미루고 다음 주기에 다시 보낸다. 움직이면 아무도 깨우지 않는다',async()=>{
  let holds=1;
  const {nudges,printed}=await simulate({minutes:20,sendNudge:(role)=>{
    if(role==='p-슈퍼감독'&&holds-->0){const e=new Error('알림 보류: 사람이 이 창에서 최근 입력함');e.code='KADAN_HUMAN_ACTIVE';throw e;}
  }});
  assert.deepEqual(nudges.map(([m,r])=>[m,r]),[[15,'p-감독'],[15,'p-슈퍼감독'],[16,'p-슈퍼감독']]);
  assert.ok(printed.some(l=>l.includes('놀고 있음 kadan-p-슈퍼감독')&&l.includes('보류')));
  const moving=await simulate({minutes:40,read:(s,m)=>`screen ${m}`});
  assert.deepEqual(moving.nudges,[]);assert.ok(!moving.sent.some(([,,m])=>m.includes('놀고 있음')));
});

test('작업자가 다 끝냈는데 감독이 다음 발령을 안 하면 열린 워크가 할 일이다: 15분에 본인, 30분에 슈퍼감독',async()=>{
  const doneCard={...card,status:'done',activity:'done'};
  const work={key:'repo/w1',status:'open',owner:'p-감독',executions:[{key:'repo/t1'}],at:stamp(0)};
  const base={cards:[doneCard],works:[work],entries:[{kind:'send',role:'p-작업자',taskId:'t1',t:stamp(0)},{kind:'done',role:'p-작업자',taskId:'t1',result:'ok',t:stamp(1)}]};
  const {nudges,sent}=await simulate({minutes:40,...base});
  // 슈퍼감독도 그 아래 전부가 멈춘 것이라 같이 받는다(기존 규칙: 하위가 움직이면 상위의 조용한 대기는 이상이 아니다).
  assert.deepEqual(nudges.map(([m,r])=>[m,r]),[[15,'p-감독'],[15,'p-슈퍼감독']]);
  assert.match(nudges[0][2],/할 일 1건/);
  assert.deepEqual(sent.filter(([,,m])=>m.includes('놀고 있음')).map(([m,r])=>[m,r]),[[30,'p-슈퍼감독']]);
  // 진행 중 실행(assigned)이 있으면 그 워크는 할 일이 아니다. 감독이 10분에 움직이면 아무것도 없다.
  const busy=await simulate({minutes:40,...base,cards:[card]});
  assert.deepEqual(busy.nudges,[],'실행이 진행 중이면 워크는 할 일이 아니다');
  const moved=await simulate({minutes:40,...base,read:(s,m)=>s==='kadan-p-감독'&&m>=10?'moved '+Math.floor(m/10):'frozen screen'});
  assert.deepEqual(moved.nudges.filter(([,r])=>r==='p-감독'),[]);
});

test('워크 owner가 인계된 옛 감독 이름이면 확정 인계를 따라 지금 책임 감독이 할 일 알림을 받는다(PR #99 검수 2)',async()=>{
  const doneCard={...card,status:'done',activity:'done'};
  const work={key:'repo/w1',status:'open',owner:'p-옛감독',executions:[{key:'repo/t1'}],at:stamp(0),history:[{owner:'p-옛감독',at:stamp(0)}]};
  const handover={kind:'handover',phase:'transferred',handoverId:'h1',from:'p-옛감독',to:'p-감독',taskIds:[],t:stamp(0)};
  const {nudges}=await simulate({minutes:20,cards:[doneCard],works:[work],
    entries:[{kind:'send',role:'p-작업자',taskId:'t1',t:stamp(0)},{kind:'done',role:'p-작업자',taskId:'t1',result:'ok',t:stamp(1)},handover]});
  assert.deepEqual(nudges.map(([m,r])=>[m,r]),[[15,'p-감독'],[15,'p-슈퍼감독']]);
  const none=await simulate({minutes:20,cards:[doneCard],works:[work],
    entries:[{kind:'send',role:'p-작업자',taskId:'t1',t:stamp(0)},{kind:'done',role:'p-작업자',taskId:'t1',result:'ok',t:stamp(1)}]});
  assert.deepEqual(none.nudges,[],'인계 기록이 없고 관계표에 없는 owner면 할 일로 세지 않는다');
});

test('답을 기다리는 일은 할 일에서 뺀다 — 감독을 통째로 빼지 않고 그 일만. 사용자 결정은 모두에게서, 감독→슈퍼감독 질문은 묻는 감독에게서만',async()=>{
  const send={kind:'send',role:'p-작업자',taskId:'t1',t:stamp(0)},plan={kind:'plan',board:'p',taskId:'t1',t:stamp(0)};
  const decision={id:'d1',card:'repo/t1',requestedBy:'p-슈퍼감독',status:'open',at:stamp(0)};
  // A. 유일한 할 일이 사용자 결정을 기다린다: 감독·슈퍼감독 모두 놀고 있음이 아니다.
  const onlyWaiting=await simulate({minutes:40,decisions:[decision]});
  assert.deepEqual(onlyWaiting.nudges,[]);
  assert.ok(!onlyWaiting.alerts.some(a=>a.alertKind==='놀고 있음'));
  // B. 다른 할 일(t2)이 있으면 그대로 판정한다 — 결정이 열려 있다고 감독이 빠지지 않는다.
  const card2={...card,id:'t2',key:'repo/t2'};
  const other=await simulate({minutes:20,decisions:[decision],cards:[card,card2],
    entries:[send,plan,{kind:'send',role:'p-작업자',taskId:'t2',t:stamp(0)},{kind:'plan',board:'p',taskId:'t2',t:stamp(0)}]});
  assert.deepEqual(other.nudges.map(([m,r,msg])=>[m,r,/할 일 1건/.test(msg)]),[[15,'p-감독',true],[15,'p-슈퍼감독',true]],'남은 할 일 1건으로 판정');
  // C. 감독이 슈퍼감독에게 t1을 물었다(답 대기): 묻는 감독에게는 할 일이 아니고, 답할 슈퍼감독에게는 할 일이다.
  const question={kind:'send',mailId:'q1',by:'p-감독',role:'p-슈퍼감독',session:'kadan-p-슈퍼감독',expectReply:true,executionKey:'repo/t1',t:stamp(0)};
  const asked=await simulate({minutes:20,entries:[send,plan,question]});
  assert.deepEqual(asked.nudges.map(([m,r])=>[m,r]),[[15,'p-슈퍼감독']],'답할 슈퍼감독만 깨운다');
  // D. 결정이 닫혔거나 목록을 못 읽으면 평소대로.
  const answered=await simulate({minutes:20,decisions:[{...decision,status:'answered'}]});
  assert.deepEqual(answered.nudges.map(([m,r])=>[m,r]),[[15,'p-감독'],[15,'p-슈퍼감독']]);
  const broken=await simulate({minutes:20,decisions:null});
  assert.deepEqual(broken.nudges.map(([m,r])=>[m,r]),[[15,'p-감독'],[15,'p-슈퍼감독']],'결정 목록을 못 읽으면 아무것도 빼지 않는다');
});

test('사용자 결정이 업무 밖 카드에 걸려 있어도 결정의 work로 그 업무를 할 일에서 뺀다(2026-10-07 운영 감독 반복 깨움)',async()=>{
  const doneCard={...card,status:'done',activity:'done'};
  const work={key:'repo/w1',status:'open',owner:'p-감독',executions:[{key:'repo/t1'}],at:stamp(0)};
  const entries=[{kind:'send',role:'p-작업자',taskId:'t1',t:stamp(0)},{kind:'done',role:'p-작업자',taskId:'t1',result:'ok',t:stamp(1)}];
  const decision={id:'d1',card:'repo/study',requestedBy:'p-슈퍼감독',status:'open',at:stamp(0)};
  // 실제 사고 모양: 결정 카드(repo/study)가 업무의 실행이 아니고 업무 연결도 없으면 업무는 계속 할 일로 남는다.
  const unlinked=await simulate({minutes:20,cards:[doneCard],works:[work],entries,decisions:[decision]});
  assert.deepEqual(unlinked.nudges.map(([m,r])=>[m,r]),[[15,'p-감독'],[15,'p-슈퍼감독']]);
  const linked=await simulate({minutes:40,cards:[doneCard],works:[work],entries,decisions:[{...decision,work:'repo/w1'}]});
  assert.deepEqual(linked.nudges,[]);
  assert.ok(!linked.alerts.some(a=>a.alertKind==='놀고 있음'));
  const cancelled=await simulate({minutes:20,cards:[doneCard],works:[work],entries,decisions:[{...decision,work:'repo/w1',status:'cancelled'}]});
  assert.deepEqual(cancelled.nudges.map(([m,r])=>[m,r]),[[15,'p-감독'],[15,'p-슈퍼감독']],'결정이 닫히면 다시 할 일');
});
