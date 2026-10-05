import test from 'node:test';
import assert from 'node:assert/strict';
// 가짜 시계 시뮬레이션: sleep이 분을 올리고 끝에서 중단한다(helpers/watch-runner는 sleep을 덮어써 쓰지 않는다).
import {runWatch} from '../src/watch-runner.mjs';

// 점검 보고서(2026-10-05) 시뮬레이션에서 셋 다 0회였다: 최상위 감독의 죽음, 등록된 감독의 놀고 있음,
// --wake 자가점검. 최상위는 어느 감시 범위에도 없었고, 유휴·깨우기는 작업 감시 범위로만 걸렀다.
const epoch=Date.parse('2026-09-09T00:00:00Z');
const stamp=m=>new Date(epoch+m*60_000).toISOString();
const parents=new Map([['p-작업자','p-감독'],['p-감독','p-슈퍼감독'],['p-슈퍼감독','@user']]);
const starts=[...parents.keys()].map((role,i)=>({kind:'start',role,session:'kadan-'+role,panePid:i+1,t:stamp(0)}));
const card={id:'t1',key:'repo/t1',role:'p-작업자',board:'p',status:'assigned',activity:'running',workType:'execution'};

async function simulate({minutes,alive=()=>true,list=()=>starts.map(s=>({session:s.session,pid:s.panePid})),wake=false,sendWake=null}){
  const records=[],sent=[],printed=[],wakes=[];let minute=0;const controller=new AbortController();
  const entries=[...starts,{kind:'send',role:'p-작업자',taskId:'t1',t:stamp(0)},{kind:'plan',board:'p',taskId:'t1',t:stamp(0)}];
  await runWatch({signal:controller.signal,intervalMs:60_000,stallN:2,stallAfterMs:300_000,idleMs:30*60_000,
    wakeRole:wake?'p-슈퍼감독':null,wakeEveryMs:30*60_000,parents,routes:new Map(),superRole:'p-슈퍼감독',
    now:()=>epoch+minute*60_000,
    floor:{list,read:()=>'frozen screen',alive},
    readEntries:()=>entries,readCards:()=>[card],readWorks:()=>[],
    sendAlert:(role,msg)=>sent.push([minute,role,msg]),
    sendWake:sendWake?(role,msg)=>{wakes.push([minute,role]);return sendWake(role,msg);}:null,
    record:e=>{records.push(e);entries.push({...e,t:stamp(minute)});},
    print:l=>printed.push(l),spawn:()=>({status:0,stdout:''}),
    sleep:async()=>{if(++minute>=minutes)controller.abort();}});
  const alerts=records.filter(e=>e.kind==='alert'&&!e.resolved);
  return {alerts,sent,printed,wakes,records};
}

test('최상위 감독의 세션이 없으면 죽음 경보가 @user에게 간다',async()=>{
  const {alerts}=await simulate({minutes:3,list:()=>starts.filter(s=>s.role!=='p-슈퍼감독').map(s=>({session:s.session,pid:s.panePid})),
    alive:s=>s!=='kadan-p-슈퍼감독'});
  const death=alerts.filter(a=>a.role==='p-슈퍼감독');
  assert.ok(death.length>=1,'최상위 감독 경보 없음');
  assert.equal(death[0].alertKind,'죽음');assert.equal(death[0].level,'RED');assert.equal(death[0].recipient,'@user');
});

test('모든 화면이 30분 멈추면 등록된 감독과 최상위 감독에게도 놀고 있음이 가고 작업자 정체도 그대로 울린다',async()=>{
  const {alerts}=await simulate({minutes:40});
  const idle=alerts.filter(a=>a.alertKind==='놀고 있음');
  assert.deepEqual([...new Set(idle.map(a=>`${a.role}→${a.recipient}`))].sort(),['p-감독→p-슈퍼감독','p-슈퍼감독→@user']);
  assert.ok(alerts.some(a=>a.alertKind==='정체'&&a.role==='p-작업자'),'작업자 정체 경보가 사라짐');
  assert.ok(!alerts.some(a=>a.alertKind==='죽음'),'살아 있는 감독에게 죽음 경보가 나가면 안 된다');
});

test('--wake 자가점검은 등록된 슈퍼감독에게 가고, 사람이 입력 중이면 미뤘다가 다음 주기에 다시 보낸다',async()=>{
  let holds=1;
  const {wakes,printed}=await simulate({minutes:35,wake:true,sendWake:()=>{
    if(holds-->0){const e=new Error('알림 보류: 사람이 이 창에서 최근 입력함');e.code='KADAN_HUMAN_ACTIVE';throw e;}
  }});
  assert.deepEqual(wakes.map(([m,r])=>[m,r]),[[0,'p-슈퍼감독'],[1,'p-슈퍼감독'],[31,'p-슈퍼감독']]);
  assert.ok(printed.some(l=>l.includes('자가점검 깨우기')&&l.includes('보류')));
});
