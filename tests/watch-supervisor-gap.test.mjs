import test from 'node:test';
import assert from 'node:assert/strict';
// 가짜 시계 시뮬레이션: sleep이 분을 올리고 끝에서 중단한다(helpers/watch-runner는 sleep을 덮어써 쓰지 않는다).
import {runWatch} from '../src/watch-runner.mjs';
import {assessHierarchyIdle} from '../src/watch-supervisor.mjs';
const lt=n=>[...String(n)].map(d=>'ghijklmnop'[d]).join(''); // 숫자만 바뀐 화면은 변화로 치지 않으므로 글자로 바꾼다

// 점검 보고서(2026-10-05) 시뮬레이션에서 둘 다 0회였다: 최상위 감독의 죽음, 등록된 감독의 놀고 있음.
// 같은 날 결정: 감독 멈춤은 2단이다 — 15분이면 본인에게, 15분 더면 상위에게. 움직이면 둘 다 닫히고 해소 우편은 없다.
// --wake(30분 타이머 고정 점검)는 없앴다.
const epoch=Date.parse('2026-09-09T00:00:00Z');
const stamp=m=>new Date(epoch+m*60_000).toISOString();
const parents=new Map([['p-작업자','p-감독'],['p-감독','p-슈퍼감독'],['p-슈퍼감독','@user']]);
const starts=[...parents.keys()].map((role,i)=>({kind:'start',role,session:'kadan-'+role,panePid:i+1,t:stamp(0)}));
const card={id:'t1',key:'repo/t1',role:'p-작업자',board:'p',status:'assigned',activity:'running',workType:'execution'};

async function simulate({minutes,hier=parents,starts:sts=starts,alive=()=>true,list=()=>sts.map(s=>({session:s.session,pid:s.panePid})),
  sendNudge=null,sendAlert=null,read=()=>'frozen screen',
  cards=[card],works=[],decisions=[],entries:extra=[{kind:'send',role:'p-작업자',taskId:'t1',t:stamp(0)},{kind:'plan',board:'p',taskId:'t1',t:stamp(0)}]}){
  const records=[],sent=[],printed=[],nudges=[];let minute=0;const controller=new AbortController();
  const entries=[...sts,...extra];
  await runWatch({signal:controller.signal,intervalMs:60_000,stallN:2,stallAfterMs:300_000,idleMs:15*60_000,
    parents:hier,routes:new Map(),superRole:'p-슈퍼감독',
    now:()=>epoch+minute*60_000,
    floor:{list,read:s=>read(s,minute),alive},
    readEntries:()=>entries,readCards:()=>cards,readWorks:()=>works,readDecisions:()=>decisions,
    sendAlert:(role,msg)=>{sent.push([minute,role,msg]);return sendAlert?.(role,msg,minute);},
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

test('감독 멈춤 2단: 15분에 본인, 30분에 상위(감독→슈퍼감독). 작업자 일은 그 직속 감독의 본인 차례다. 작업자 정체는 그대로, 작업자에게 본인 알림은 없다',async()=>{
  const {alerts,sent,nudges,records,printed}=await simulate({minutes:40});
  assert.deepEqual(nudges.map(([m,r])=>[m,r]),[[15,'p-감독']]);
  // 2단으로 올라가는 순간 1단은 '해소됨'이 아니다(PR #99 검수 1): 출력에 해소가 없고, 원장에는 escalatedTo를 단 닫힘만 남는다.
  assert.ok(!printed.some(l=>l.includes('놀고 있음 - 해소됨')),'승격을 해소로 찍으면 안 된다');
  assert.deepEqual(records.filter(e=>e.kind==='alert'&&e.resolved&&e.alertKind==='놀고 있음').map(e=>[e.minute,e.id,e.escalatedTo]),
    [[30,'idle:hierarchy:p-감독','idle:hierarchy:p-감독:상위']]);
  assert.match(nudges[0][2],/놀고 있음 kadan-p-감독 \(본인 차례 1건, 15분간 화면 변화 없음\) — 판을 확인하고 다음 행동을 정하라\. 이대로 15분 더 멈추면 상위에게 알린다\./);
  const idle=alerts.filter(a=>a.alertKind==='놀고 있음');
  assert.deepEqual(idle.map(a=>[a.minute,a.role,a.recipient]),[[15,'p-감독','p-감독'],[30,'p-감독','p-슈퍼감독']]);
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
  assert.deepEqual(nudges.map(([m,r])=>[m,r]),[[15,'p-감독']],'70분 동안 본인 알림은 역할마다 한 번');
  assert.ok(!records.some(e=>e.kind==='alert'&&e.alertKind==='놀고 있음'&&e.resolved&&e.minute<30),'알림 글 때문에 닫힌 경보가 없다');
});

test('사람이 그 창에서 입력 중이면 본인 알림을 미루고 다음 주기에 다시 보낸다. 움직이면 아무도 깨우지 않는다',async()=>{
  let holds=1;
  const {nudges,printed}=await simulate({minutes:20,sendNudge:(role)=>{
    if(role==='p-감독'&&holds-->0){const e=new Error('알림 보류: 사람이 이 창에서 최근 입력함');e.code='KADAN_HUMAN_ACTIVE';e.delivery='not-sent';throw e;}
  }});
  assert.deepEqual(nudges.map(([m,r])=>[m,r]),[[15,'p-감독'],[16,'p-감독']]);
  assert.ok(printed.some(l=>l.includes('놀고 있음 kadan-p-감독')&&l.includes('보류')));
  const moving=await simulate({minutes:40,read:(s,m)=>`screen ${lt(m)}`});
  assert.deepEqual(moving.nudges,[]);assert.ok(!moving.sent.some(([,,m])=>m.includes('놀고 있음')));
});

test('작업자가 다 끝냈는데 감독이 다음 발령을 안 하면 열린 워크가 할 일이다: 15분에 본인, 30분에 슈퍼감독',async()=>{
  const doneCard={...card,status:'done',activity:'done'};
  const work={key:'repo/w1',status:'open',owner:'p-감독',executions:[{key:'repo/t1'}],at:stamp(0)};
  const base={cards:[doneCard],works:[work],entries:[{kind:'send',role:'p-작업자',taskId:'t1',t:stamp(0)},{kind:'done',role:'p-작업자',taskId:'t1',result:'ok',t:stamp(1)}]};
  const {nudges,sent}=await simulate({minutes:40,...base});
  // 이 워크의 차례는 감독이다. 슈퍼감독은 본인 차례가 아니라 1단을 받지 않고, 감독의 2단으로만 올라온다(2026-10-16 [kyle]).
  assert.deepEqual(nudges.map(([m,r])=>[m,r]),[[15,'p-감독']]);
  assert.match(nudges[0][2],/본인 차례 1건/);
  assert.deepEqual(sent.filter(([,,m])=>m.includes('놀고 있음')).map(([m,r])=>[m,r]),[[30,'p-슈퍼감독']]);
  // 진행 중 실행(assigned)이 있으면 그 워크는 할 일이 아니다. 감독이 10분에 움직이면 아무것도 없다.
  const busy=await simulate({minutes:40,...base,cards:[card]});
  assert.deepEqual(busy.nudges,[],'실행이 진행 중이면 워크는 할 일이 아니다');
  const moved=await simulate({minutes:40,...base,read:(s,m)=>s==='kadan-p-감독'&&m>=10?'moved '+lt(Math.floor(m/10)):'frozen screen'});
  assert.deepEqual(moved.nudges.filter(([,r])=>r==='p-감독'),[]);
});

test('워크 owner가 인계된 옛 감독 이름이면 확정 인계를 따라 지금 책임 감독이 할 일 알림을 받는다(PR #99 검수 2)',async()=>{
  const doneCard={...card,status:'done',activity:'done'};
  const work={key:'repo/w1',status:'open',owner:'p-옛감독',executions:[{key:'repo/t1'}],at:stamp(0),history:[{owner:'p-옛감독',at:stamp(0)}]};
  const handover={kind:'handover',phase:'transferred',handoverId:'h1',from:'p-옛감독',to:'p-감독',taskIds:[],t:stamp(0)};
  const {nudges}=await simulate({minutes:20,cards:[doneCard],works:[work],
    entries:[{kind:'send',role:'p-작업자',taskId:'t1',t:stamp(0)},{kind:'done',role:'p-작업자',taskId:'t1',result:'ok',t:stamp(1)},handover]});
  assert.deepEqual(nudges.map(([m,r])=>[m,r]),[[15,'p-감독']]);
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
  assert.deepEqual(other.nudges.map(([m,r,msg])=>[m,r,/본인 차례 1건/.test(msg)]),[[15,'p-감독',true]],'남은 할 일 1건으로 판정');
  // C. 감독이 슈퍼감독에게 t1을 물었다(답 대기): 묻는 감독에게는 할 일이 아니고, 답할 슈퍼감독에게는 할 일이다.
  const question={kind:'send',mailId:'q1',by:'p-감독',role:'p-슈퍼감독',session:'kadan-p-슈퍼감독',expectReply:true,executionKey:'repo/t1',t:stamp(0)};
  const asked=await simulate({minutes:20,entries:[send,plan,question]});
  assert.deepEqual(asked.nudges.map(([m,r])=>[m,r]),[[15,'p-슈퍼감독']],'답할 슈퍼감독만 깨운다');
  // D. 결정이 닫혔거나 목록을 못 읽으면 평소대로.
  const answered=await simulate({minutes:20,decisions:[{...decision,status:'answered'}]});
  assert.deepEqual(answered.nudges.map(([m,r])=>[m,r]),[[15,'p-감독']]);
  const broken=await simulate({minutes:20,decisions:null});
  assert.deepEqual(broken.nudges.map(([m,r])=>[m,r]),[[15,'p-감독']],'결정 목록을 못 읽으면 아무것도 빼지 않는다');
});

test('사용자 결정이 업무 밖 카드에 걸려 있어도 결정의 work로 그 업무를 할 일에서 뺀다(2026-10-07 운영 감독 반복 깨움)',async()=>{
  const doneCard={...card,status:'done',activity:'done'};
  const work={key:'repo/w1',status:'open',owner:'p-감독',executions:[{key:'repo/t1'}],at:stamp(0)};
  const entries=[{kind:'send',role:'p-작업자',taskId:'t1',t:stamp(0)},{kind:'done',role:'p-작업자',taskId:'t1',result:'ok',t:stamp(1)}];
  const decision={id:'d1',card:'repo/study',requestedBy:'p-슈퍼감독',status:'open',at:stamp(0)};
  // 실제 사고 모양: 결정 카드(repo/study)가 업무의 실행이 아니고 업무 연결도 없으면 업무는 계속 할 일로 남는다.
  const unlinked=await simulate({minutes:20,cards:[doneCard],works:[work],entries,decisions:[decision]});
  assert.deepEqual(unlinked.nudges.map(([m,r])=>[m,r]),[[15,'p-감독']]);
  const linked=await simulate({minutes:40,cards:[doneCard],works:[work],entries,decisions:[{...decision,work:'repo/w1'}]});
  assert.deepEqual(linked.nudges,[]);
  assert.ok(!linked.alerts.some(a=>a.alertKind==='놀고 있음'));
  const cancelled=await simulate({minutes:20,cards:[doneCard],works:[work],entries,decisions:[{...decision,work:'repo/w1',status:'cancelled'}]});
  assert.deepEqual(cancelled.nudges.map(([m,r])=>[m,r]),[[15,'p-감독']],'결정이 닫히면 다시 할 일');
});


test('상위 경보도 입력 보호 중에는 상신 없이 보류하고 풀린 뒤 한 번 보낸다',async()=>{
 const delivered=[];
 const f=await simulate({minutes:35,sendAlert:(role,msg,minute)=>{
  if(role==='p-슈퍼감독'&&minute<32)throw Object.assign(new Error('입력 중'),{
   code:'KADAN_HERDR_NOT_READY',delivery:'not-sent'});
  delivered.push([minute,role,msg]);
 }});
 assert.equal(delivered.filter(([,role,msg])=>role==='p-슈퍼감독'&&msg.includes('놀고 있음')).length,1);
 assert.ok(f.records.some(e=>e.kind==='alert'&&e.held===true));
 assert.ok(!f.records.some(e=>e.alertKind==='전달실패'));
});

const finished={cards:[{...card,status:'done',activity:'done'}],
  entries:[{kind:'send',role:'p-작업자',taskId:'t1',t:stamp(0)},{kind:'done',role:'p-작업자',taskId:'t1',result:'ok',t:stamp(1)}]};
// 2026-10-16 [kyle] 오경보: 하위 감독 차례인 업무가 상위(슈퍼감독)의 할 일로 세어졌다.
// 할 일은 지금 차례(turnOwner)인 역할의 것이고, 감독의 1단 재촉은 본인 차례 일로만 판정한다.
test('차례가 하위 감독인 업무는 하위 감독의 할 일이다 — 슈퍼감독의 사용자 결정 대기 중에 슈퍼감독을 재촉하지 않는다',async()=>{
  const owned=(n,turnOwner)=>({key:`repo/w${n}`,status:'open',owner:'p-감독',turnOwner,executions:[{key:'repo/t1'}],at:stamp(0)});
  // 제보 모양: 슈퍼 차례 업무 2개는 모두 열린 사용자 결정에 묶였고, 감독 차례 업무가 3개 있다.
  const works=[owned(1,'p-슈퍼감독'),owned(2,'p-슈퍼감독'),owned(3,'p-감독'),owned(4,'p-감독'),owned(5,'p-감독')];
  const decisions=[1,2].map(n=>({id:`d${n}`,card:`repo/c${n}`,work:`repo/w${n}`,requestedBy:'p-슈퍼감독',status:'open',at:stamp(0)}));
  const r=await simulate({minutes:20,...finished,works,decisions});
  assert.ok(!r.nudges.some(([,role])=>role==='p-슈퍼감독'),'슈퍼감독은 본인 차례가 없어 재촉받지 않는다');
  // 하위 감독 차례 업무는 하위 감독에게 1단으로 간다. 슈퍼감독 차례 업무는 사용자 답 대기라 센 수에서 빠진다.
  assert.deepEqual(r.nudges.map(([m,role])=>[m,role]),[[15,'p-감독']]);
  assert.match(r.nudges[0][2],/\(본인 차례 3건, 15분간 화면 변화 없음\)/);
  assert.ok(!r.alerts.some(a=>a.role==='p-슈퍼감독'&&a.alertKind==='놀고 있음'));
});

test('본인 차례 업무가 멈춰 있으면 그대로 재촉하고, 문구는 본인 차례·하위 차례·사용자 답 대기로 가른다. 센 항목은 경보 원장에 남는다',async()=>{
  const owned=(n,turnOwner)=>({key:`repo/w${n}`,status:'open',owner:'p-감독',turnOwner,executions:[{key:'repo/t1'}],at:stamp(0)});
  // 슈퍼 차례 업무 3개(1개는 사용자 결정 대기) + 감독 차례 업무 2개.
  const works=[owned(1,'p-슈퍼감독'),owned(2,'p-슈퍼감독'),owned(3,'p-슈퍼감독'),owned(4,'p-감독'),owned(5,'p-감독')];
  const decisions=[{id:'d1',card:'repo/c1',work:'repo/w1',requestedBy:'p-슈퍼감독',status:'open',at:stamp(0)}];
  const r=await simulate({minutes:20,...finished,works,decisions});
  const toSuper=r.nudges.filter(([,role])=>role==='p-슈퍼감독');
  assert.equal(toSuper.length,1);
  assert.match(toSuper[0][2],/\(본인 차례 2건 \/ 하위 p-감독 차례 2건 \/ 사용자 답 대기 1건, 15분간 화면 변화 없음\)/);
  const rec=r.records.find(e=>e.kind==='alert'&&e.id==='idle:hierarchy:p-슈퍼감독'&&!e.resolved);
  assert.deepEqual(rec.idleItems,{own:['work:repo/w2','work:repo/w3'],lower:['work:repo/w4','work:repo/w5'],userWait:['work:repo/w1'],
    ownWhy:[{id:'work:repo/w2',reason:'내 차례'},{id:'work:repo/w3',reason:'내 차례'}]});
  // 본인 차례 일이 있으면 30분에 사용자(@user)에게 올라간다.
  const up=await simulate({minutes:40,...finished,works,decisions});
  assert.ok(up.records.some(e=>e.kind==='alert'&&e.id==='idle:hierarchy:p-슈퍼감독:상위'&&e.recipient==='@user'));
});

test('경보 원장에 남기는 항목 목록은 20개로 자른다',async()=>{
  const works=Array.from({length:25},(_,i)=>({key:`repo/w${i}`,status:'open',owner:'p-감독',turnOwner:'p-감독',executions:[{key:'repo/t1'}],at:stamp(0)}));
  const r=await simulate({minutes:16,...finished,works});
  const rec=r.records.find(e=>e.kind==='alert'&&e.id==='idle:hierarchy:p-감독'&&!e.resolved);
  assert.equal(rec.idleItems.own.length,20);
  assert.match(r.nudges[0][2],/본인 차례 25건/);
});

test('owner는 이전 세대, 차례는 현재 다른 감독인 업무도 65주기 동안 15분에 1단·30분에 2단이 간다(관찰 범위가 비지 않는다)',async()=>{
  const hier=new Map([...parents,['p-다른감독','p-슈퍼감독'],['p-다른작업자','p-다른감독']]);
  const sts=[...hier.keys()].map((role,i)=>({kind:'start',role,session:'kadan-'+role,panePid:i+1,t:stamp(0),cmd:'claude --model sonnet'}));
  const turnAt=stamp(25);
  const work={key:'repo/w1',status:'open',owner:'p-감독',turnOwner:'p-다른감독',turnAt,executions:[{key:'repo/t1'}],at:turnAt,
    history:[{owner:'p-감독',at:stamp(1)}]};
  // p-감독이 20분에 새 세대로 다시 떴다 → owner의 책임 시각(1분)은 이전 세대다. 차례는 25분에 p-다른감독에게 넘어갔다.
  const entries=[...finished.entries,{kind:'start',role:'p-감독',session:'kadan-p-감독',panePid:99,t:stamp(20),cmd:'claude --model sonnet'}];
  const r=await simulate({minutes:65,hier,starts:sts,cards:finished.cards,works:[work],entries});
  assert.deepEqual(r.nudges.filter(([,role])=>role==='p-다른감독').map(([m])=>m),[40],'차례 시각(25분)부터 15분 뒤 1단');
  assert.ok(r.records.some(e=>e.kind==='alert'&&e.id==='idle:hierarchy:p-다른감독:상위'&&e.minute===55&&!e.resolved),'15분 더 멈추면 2단');
});

// 2026-10-21 외부 제보: 놀고 있음 알림이 건수만 말해 무엇을 왜 하라는지 몰랐다. 본문에 항목 키·이유·질문 우편 ID·닫는 법을 적는다.
// 판정은 그대로다: 감독이 상위에게 보낸 답 필요 우편이 최종 답 없이 걸린 업무는 답할 상위의 본인 차례다.
const MAIL_ID='49edd535-0000-4000-8000-000000000001';
const question=(patch={})=>({kind:'send',transport:'mailbox',mailId:MAIL_ID,by:'p-감독',role:'p-슈퍼감독',expectReply:true,
  workKey:'repo/w1',preview:'답 필요',t:stamp(0),...patch});
const ownedBySub=n=>({key:`repo/w${n}`,status:'open',owner:'p-감독',turnOwner:'p-감독',executions:[{key:'repo/t1'}],at:stamp(0)});
const idleBase=[{kind:'send',role:'p-작업자',taskId:'t1',t:stamp(0)},{kind:'plan',board:'p',taskId:'t1',t:stamp(0)}];
const finishedEntries=[{kind:'send',role:'p-작업자',taskId:'t1',t:stamp(0)},{kind:'done',role:'p-작업자',taskId:'t1',result:'ok',t:stamp(1)}];
const doneCard={...card,status:'done',activity:'done'};

test('답 필요 우편이 최종 답 없이 걸린 업무: 슈퍼감독 알림 본문에 업무 키·답할 질문·우편 ID 앞 8자·닫는 법이 있다. 2단에도 같다',async()=>{
  const r=await simulate({minutes:40,cards:[doneCard],works:[ownedBySub(1)],entries:[...finishedEntries,question()]});
  const toSuper=r.nudges.filter(([,role])=>role==='p-슈퍼감독');
  assert.equal(toSuper.length,1);
  assert.match(toSuper[0][2],/본인 차례: work:repo\/w1 \(답할 질문 49edd535-0000-4000-8000-000000000001 ← p-감독\)\./);
  assert.match(toSuper[0][2],/kadan send p-감독 --reply-to 49edd535-0000-4000-8000-000000000001 --reply-final '답'/);
  const rec=r.records.find(e=>e.kind==='alert'&&e.id==='idle:hierarchy:p-슈퍼감독'&&!e.resolved);
  assert.deepEqual(rec.idleItems.ownWhy,[{id:'work:repo/w1',reason:'답할 질문',questions:[{mailId:MAIL_ID,asker:'p-감독'}]}]);
  assert.deepEqual(rec.idleItems.own,['work:repo/w1']);
  // 같은 슈퍼감독이 다시 멈추면 사용자에게 올라가는 2단 본문에도 같은 항목이 있다.
  assert.ok(r.printed.some(l=>/30분간 화면 변화 없음.*본인 차례: work:repo\/w1 \(답할 질문 49edd535-0000-4000-8000-000000000001 ← p-감독\).*→ @user/.test(l)));
});

test('동료 슈퍼감독의 질문(peerRequest)은 내 차례가 아니라 답할 질문이고 전체 우편 ID·질문자가 보인다',async()=>{
  const hier=new Map([...parents,['q-슈퍼감독','@user']]);
  const sts=[...hier.keys()].map((role,i)=>({kind:'start',role,session:'kadan-'+role,panePid:i+1,t:stamp(0)}));
  const id='abcdef01-0000-4000-8000-000000000001';
  const peer={kind:'send',transport:'mailbox',mailId:id,by:'q-슈퍼감독',role:'p-슈퍼감독',expectReply:true,preview:'답 필요',t:stamp(0)};
  const r=await simulate({minutes:20,hier,starts:sts,cards:[doneCard],works:[],entries:[...finishedEntries,peer]});
  const toSuper=r.nudges.filter(([,role])=>role==='p-슈퍼감독');
  assert.equal(toSuper.length,1);
  assert.match(toSuper[0][2],new RegExp(`본인 차례: mail:${id} \\(답할 질문 ${id} ← q-슈퍼감독\\)`));
  assert.ok(toSuper[0][2].includes(`kadan send q-슈퍼감독 --reply-to ${id} --reply-final '답'`));
  assert.ok(!/내 차례/.test(toSuper[0][2]));
  const rec=r.records.find(e=>e.kind==='alert'&&e.id==='idle:hierarchy:p-슈퍼감독'&&!e.resolved);
  assert.deepEqual(rec.idleItems.ownWhy,[{id:`mail:${id}`,reason:'답할 질문',questions:[{mailId:id,asker:'q-슈퍼감독'}]}]);
});

test('한 업무에 질문자가 둘이면 우편 ID마다 질문자 짝과 닫는 명령이 따로 나온다(앞 8자가 같아도 구분된다)',async()=>{
  const hier=new Map([...parents,['p-다른감독','p-슈퍼감독']]);
  const sts=[...hier.keys()].map((role,i)=>({kind:'start',role,session:'kadan-'+role,panePid:i+1,t:stamp(0)}));
  const id1='12345678-0000-4000-8000-000000000001',id2='12345678-0000-4000-8000-000000000002';
  const qs=[question({mailId:id1}),question({mailId:id2,by:'p-다른감독'})];
  const r=await simulate({minutes:20,hier,starts:sts,cards:[doneCard],works:[ownedBySub(1)],entries:[...finishedEntries,...qs]});
  const body=r.nudges.find(([,role])=>role==='p-슈퍼감독')[2];
  assert.ok(body.includes(`${id1} ← p-감독`)&&body.includes(`${id2} ← p-다른감독`));
  assert.ok(body.includes(`kadan send p-감독 --reply-to ${id1} --reply-final '답'`));
  assert.ok(body.includes(`kadan send p-다른감독 --reply-to ${id2} --reply-final '답'`));
  const rec=r.records.find(e=>e.kind==='alert'&&e.id==='idle:hierarchy:p-슈퍼감독'&&!e.resolved);
  assert.deepEqual(rec.idleItems.ownWhy[0].questions,[{mailId:id1,asker:'p-감독'},{mailId:id2,asker:'p-다른감독'}]);
});

test('같은 상황에서 --reply-final 답장이 있으면 슈퍼감독 알림이 없다',async()=>{
  const reply={kind:'send',transport:'mailbox',mailId:'r1',by:'p-슈퍼감독',role:'p-감독',replyTo:MAIL_ID,replyFinal:true,workKey:'repo/w1',t:stamp(2)};
  const r=await simulate({minutes:40,cards:[doneCard],works:[ownedBySub(1)],entries:[...finishedEntries,question(),reply]});
  assert.ok(!r.nudges.some(([,role])=>role==='p-슈퍼감독'));
  assert.ok(!r.records.some(e=>e.kind==='alert'&&e.role==='p-슈퍼감독'&&e.alertKind==='놀고 있음'));
});

test('이유는 내 차례·미발령 계획으로도 가른다. 판정은 그대로다',async()=>{
  const plan=assessHierarchyIdle([{kind:'plan',board:'p',taskId:'t9',t:stamp(0)}],
    new Map(['p-작업자','p-감독','p-슈퍼감독'].map(r=>[`kadan-${r}`,{alive:true,digest:'x',unchangedMs:3600e3}])),epoch+3600e3,60e3,parents);
  assert.deepEqual(plan[0].idleItems.ownWhy,[{id:'t9',reason:'미발령 계획'}]);
  const mine={...ownedBySub(9)};
  const r=await simulate({minutes:16,cards:[doneCard],works:[mine],entries:finishedEntries});
  const rec=r.records.find(e=>e.kind==='alert'&&e.id==='idle:hierarchy:p-감독'&&!e.resolved);
  assert.deepEqual(rec.idleItems.ownWhy.map(w=>[w.id,w.reason]),[['work:repo/w9','내 차례']]);
  assert.match(r.nudges[0][2],/본인 차례: .*\(내 차례\)/);
});

test('사용자 결정만 걸린 업무와 하위 감독 차례 업무뿐이면 슈퍼감독에게 본인 차례 알림이 없다',async()=>{
  const w1={...ownedBySub(1),turnOwner:'p-슈퍼감독'};
  const decisions=[{id:'d1',card:'repo/c1',work:'repo/w1',requestedBy:'p-슈퍼감독',status:'open',at:stamp(0)}];
  const r=await simulate({minutes:40,cards:[doneCard],works:[w1,ownedBySub(2)],decisions,entries:finishedEntries});
  assert.ok(!r.nudges.some(([,role])=>role==='p-슈퍼감독'));
  assert.ok(!r.records.some(e=>e.kind==='alert'&&e.role==='p-슈퍼감독'&&e.alertKind==='놀고 있음'));
});

test('본문 항목은 5개까지, 넘으면 외 N건',async()=>{
  const works=Array.from({length:7},(_,i)=>ownedBySub(i));
  const r=await simulate({minutes:16,cards:[doneCard],works,entries:finishedEntries});
  assert.match(r.nudges[0][2],/본인 차례: (work:repo\/w\d \(내 차례\), ){4}work:repo\/w\d \(내 차례\) 외 2건\./);
});
