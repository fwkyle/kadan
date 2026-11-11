import "./helpers/isolated-home.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {runWatch} from '../src/watch-runner.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {activeWaitUntil, parseWaitUntil, waitUntilLabel, showCycleWaits, WAIT_UNTIL_TAG} from '../src/wait-until.mjs';
import {dashboardData} from '../src/dashboard-api.mjs';
import {dashboardFixture} from './helpers/dashboard-fixture.mjs';

// 업무 대기 시각(--wait-until): 쓰기는 실제 CLI(자식 프로세스)로, 읽기는 감시기가 쓰는 WorkStore.listWatch로,
// 판정은 실제 감시 주기(runWatch, 가짜 시계)로 한다. 업무 기록을 손으로 만들지 않는 길이 이 파일의 중심이다.
const cli=new URL('../src/cli.mjs',import.meta.url).pathname;
const parents=new Map([['p-작업자','p-감독'],['p-감독','p-슈퍼감독'],['p-슈퍼감독','@user']]);
const MIN=60_000;

function setup(keys=['repo/w1']){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-wait-until-'));
  const store=new WorkStore(home);
  for(const key of keys)store.create({key,title:'t '+key,goal:'g',scope:'s',acceptance:'a',owner:'p-감독',repoPath:home});
  const cliRun=(...args)=>spawnSync(process.execPath,[cli,'work',...args],
    {encoding:'utf8',env:{...process.env,KADAN_HOME:home,KADAN_ROLE:'p-감독',KADAN_NOTIFY:'off',KADAN_WINDOW:'none'}});
  const update=(key,...flags)=>cliRun('update',key,'--revision',String(store.get(key).revision),'--note','시험',...flags);
  return {home,store,cliRun,update,done:()=>fs.rmSync(home,{recursive:true,force:true})};
}
const iso=ms=>new Date(ms).toISOString();

// 가짜 시계 감시 순회. 업무는 매 주기 실제 저장소(listWatch)에서 읽고, onMinute로 중간에 실제 CLI를 칠 수 있다.
async function simulate({home,minutes,base,cards=[],onMinute=()=>{},works}){
  const starts=[...parents.keys()].map((role,i)=>({kind:'start',role,session:'kadan-'+role,panePid:i+1,t:iso(base)}));
  const records=[],nudges=[],controller=new AbortController();let minute=0;
  // 감시 범위에 들어가려면 끝난 하위 실행 하나가 필요하다(idle-turn-values 시험과 같은 틀). 업무 기록 자체는 실제 저장소에서 읽는다.
  const entries=[...starts,{kind:'send',role:'p-작업자',taskId:'e1',t:iso(base)},{kind:'done',role:'p-작업자',taskId:'e1',result:'ok',t:iso(base)}];
  if(!cards.length)cards=[{key:'repo/e1',id:'e1',status:'done',activity:'done',workType:'execution',role:'p-작업자',board:'p',at:iso(base),runs:[]}];
  const readWorks=works??(()=>new WorkStore(home).listWatch().map(w=>({...w,executions:[{key:'repo/e1',phase:'implementation',round:1}]})));
  await runWatch({signal:controller.signal,intervalMs:MIN,stallN:2,stallAfterMs:300_000,idleMs:15*MIN,
    parents,routes:new Map(),superRole:'p-슈퍼감독',now:()=>base+minute*MIN,
    floor:{list:()=>starts.map(s=>({session:s.session,pid:s.panePid})),read:()=>'frozen screen',alive:()=>true},
    readEntries:()=>entries,readCards:()=>cards,readWorks,readDecisions:()=>[],
    sendAlert:()=>{},sendNudge:(role,msg)=>{nudges.push({minute,role,msg});},
    record:e=>{records.push({...e,minute});entries.push({...e,t:iso(base+minute*MIN)});},
    print:()=>{},spawn:()=>({status:0,stdout:''}),
    sleep:async()=>{onMinute(minute);if(++minute>=minutes)controller.abort();}});
  const idle=records.filter(e=>e.kind==='alert'&&!e.resolved&&e.alertKind==='놀고 있음');
  return {records,nudges,idle,idleMinutes:[...new Set(idle.map(e=>e.minute))],
    cycles:records.filter(e=>e.kind==='watch-cycle')};
}

test('실제 CLI로 적은 대기 시각: 그 전에는 놀고 있음이 없고, 지난 뒤에는 평소대로 난다',async()=>{
  const t=setup();
  try{
    const base=Date.now();
    const ok=t.update('repo/w1','--wait-until',iso(base+30*MIN));
    assert.equal(ok.status,0,ok.stderr);
    const saved=t.store.get('repo/w1');
    assert.equal(saved.status,'open');
    assert.equal(saved.waitUntil,iso(base+30*MIN));
    assert.ok(Number.isFinite(Date.parse(saved.waitUntilSetAt)));
    // 감시기가 쓰는 읽기에도 칸이 그대로 올라온다.
    assert.equal(t.store.listWatch()[0].waitUntil,saved.waitUntil);
    const r=await simulate({home:t.home,base,minutes:60});
    assert.ok(r.idle.length>0,'시각이 지나면 놀고 있음이 난다');
    // 대기한 30분은 멈춘 시간이 아니다: 만료(30분)부터 15분 뒤에야 1단이 난다.
    assert.ok(Math.min(...r.idleMinutes)>=45,`대기 중과 만료 직후에는 경보 없음: ${r.idleMinutes}`);
    assert.match(r.nudges[0].msg,/대기 시각\(\d\d:\d\d\)이 지나/,'본인 창 안내에 대기 시각이 지났다는 구절');
    // 대기 중인 동안 주기 기록(대시보드 자료)에는 항목이 실린다. 지난 뒤에는 빠진다.
    const during=r.cycles.find(c=>c.minute===5);
    assert.deepEqual(during.userTurnWaits,[{work:'repo/w1',waitUntil:saved.waitUntil,tag:WAIT_UNTIL_TAG}]);
    assert.equal(r.cycles.find(c=>c.minute===40)?.userTurnWaits,undefined);
  }finally{t.done();}
});

test('이미 떠 있는 경보: 대기를 적으면 풀리고, 시각이 지나 다시 들어오면 다시 알린다',async()=>{
  const t=setup();
  try{
    const base=Date.now();
    const r=await simulate({home:t.home,base,minutes:60,onMinute:m=>{
      if(m===18){const x=t.update('repo/w1','--wait-until',iso(base+40*MIN));assert.equal(x.status,0,x.stderr);}
    }});
    const before=r.idle.filter(e=>e.minute<18);
    assert.ok(before.length>0,'대기 전에는 경보가 떠 있다');
    const resolved=r.records.filter(e=>e.kind==='alert'&&e.resolved&&e.alertKind==='놀고 있음'&&e.minute>=18&&e.minute<40);
    assert.ok(resolved.length>0,'대기를 적으면 경보가 풀린다');
    const after=r.idle.filter(e=>e.minute>=40);
    assert.ok(after.length>0,'시각이 지나면 다시 알린다(묻히지 않는다)');
    assert.equal(r.idle.filter(e=>e.minute>=19&&e.minute<40).length,0,'대기 중에는 새 경보가 없다');
  }finally{t.done();}
});

test('범위: 같은 감독의 다른 업무로는 놀고 있음이 그대로 난다',async()=>{
  const t=setup(['repo/w1','repo/w2']);
  try{
    const base=Date.now();
    assert.equal(t.update('repo/w1','--wait-until',iso(base+30*MIN)).status,0);
    const r=await simulate({home:t.home,base,minutes:25});
    assert.ok(r.idle.length>0,'w2는 대기가 아니라 경보가 난다');
    const own=r.idle.flatMap(e=>e.idleItems?.own??e.items?.own??[]);
    const text=JSON.stringify(r.idle);
    assert.ok(text.includes('work:repo/w2'),text.slice(0,400));
    assert.ok(!text.includes('work:repo/w1'),'대기 중인 w1은 할 일에 없다');
    assert.ok(own.length===0||own.every(id=>id!=='work:repo/w1'));
  }finally{t.done();}
});

test('작업자 정체 판정은 그대로: 대기 업무에 걸린 진행 중 실행의 정체 경보가 같다',async()=>{
  const t=setup();
  try{
    const base=Date.now();
    const card={key:'repo/e1',id:'e1',status:'assigned',workType:'execution',role:'p-작업자',board:'p',at:iso(base),runs:[]};
    const linked=()=>{const w=new WorkStore(t.home).listWatch();return w.map(x=>({...x,executions:[{key:'repo/e1',phase:'implementation',round:1}]}));};
    const plain=await simulate({home:t.home,base,minutes:25,cards:[card],works:linked});
    assert.equal(t.update('repo/w1','--wait-until',iso(base+60*MIN)).status,0);
    const waiting=await simulate({home:t.home,base,minutes:25,cards:[card],works:linked});
    const kinds=r=>r.records.filter(e=>e.kind==='alert'&&!e.resolved&&e.alertKind!=='놀고 있음').map(e=>e.alertKind).sort();
    assert.deepEqual(kinds(waiting),kinds(plain),'놀고 있음 밖의 경보(작업자 정체 등)는 대기 칸과 무관');
  }finally{t.done();}
});

test('틀리는 방향은 조용함이 아니다: 대기 중이 아닌 모든 기록에서 놀고 있음이 난다',async()=>{
  const base=Date.now(),at=iso(base);
  const open={status:'open',waitUntil:iso(base+30*MIN),waitUntilSetAt:at};
  const cases={
    '값 없음':{status:'open'},
    '문자열 아님':{...open,waitUntil:12345},
    '해석 불가':{...open,waitUntil:'내일 아침'},
    '이미 지난 시각':{...open,waitUntil:iso(base-MIN)},
    '24시간 초과':{...open,waitUntil:iso(base+25*60*MIN),waitUntilSetAt:iso(base+25*60*MIN-MIN)},
    '적은 시각 없음':{status:'open',waitUntil:iso(base+30*MIN)},
    '적은 시각 해석 불가':{...open,waitUntilSetAt:'어제'},
    '적은 시각부터 24시간 초과':{...open,waitUntilSetAt:iso(base-24*60*MIN)},
    '보류 업무':{...open,status:'hold'},
  };
  const store=new WorkStore(fs.mkdtempSync(path.join(os.tmpdir(),'kadan-wait-until-x-')));
  try{
    for(const [name,extra] of Object.entries(cases)){
      const work={key:'repo/w1',repo:'repo',id:'w1',title:'t',goal:'g',owner:'p-감독',ownedAt:at,at,revision:1,history:[],executions:[{key:'repo/e1',phase:'implementation',round:1}],...extra};
      if(extra.status==='hold')continue;// hold는 원래 할 일이 아니다. 아래에서 값 판정만 본다.
      const r=await simulate({home:store.home,base,minutes:25,works:()=>[work]});
      assert.ok(r.idle.length>0,`${name}: 놀고 있음이 나야 한다`);
    }
    assert.equal(activeWaitUntil({...open,status:'hold'},base),null);
    assert.equal(activeWaitUntil(open,base)!==null,true);
    // 업무 목록을 못 읽으면(예외) 아무것도 빼지 않는다.
    const r=await simulate({home:store.home,base,minutes:3,works:()=>{throw new Error('읽기 실패');}});
    assert.equal(r.cycles.every(c=>c.userTurnWaits===undefined),true);
  }finally{fs.rmSync(store.home,{recursive:true,force:true});}
});

test('쓰기 거절(종료 코드 2·형식 안내), 지우기, 완료·취소·차례 변경 뒤의 칸',()=>{
  const t=setup(['repo/w1','repo/w2']);
  try{
    const base=Date.now();
    const rev=()=>t.store.get('repo/w1').revision;
    for(const [bad,why] of [[iso(base-5*MIN),'지난'],[iso(base+25*60*MIN),'24시간'],['내일 아침','형식'],['2026-13-45T99:99Z','']]){
      const r=t.update('repo/w1','--wait-until',bad);
      assert.equal(r.status,2,`${bad}: ${r.stderr}`);
      assert.match(r.stderr,/형식:/);
      if(why)assert.match(r.stderr,new RegExp(why));
    }
    assert.equal(t.store.get('repo/w1').waitUntil,undefined,'거절하면 쓰지 않는다');
    assert.equal(t.update('repo/w1','--wait-until').status,2,'값 없는 --wait-until도 거절');
    // 보류 업무에는 적을 수 없다.
    assert.equal(t.update('repo/w1','--status','hold','--wait-until',iso(base+MIN*30)).status,2);
    // 적고, 그 밖의 수정(진행 기록)은 그대로 둔다.
    assert.equal(t.update('repo/w1','--wait-until',iso(base+30*MIN)).status,0);
    assert.equal(t.update('repo/w1','--progress','표본 대기').status,0);
    assert.equal(t.store.get('repo/w1').waitUntil,iso(base+30*MIN),'진행 기록은 대기를 지우지 않는다');
    // 같은 차례 값으로 다시 적는 것은 차례 변경이 아니다. 실제로 다른 값으로 넘기면 대기는 끝난다.
    assert.equal(t.update('repo/w1','--turn-owner','p-감독').status,0);
    assert.equal(t.update('repo/w1','--wait-until',iso(base+30*MIN)).status,0);
    assert.equal(t.update('repo/w1','--turn-owner','p-감독').status,0);
    assert.equal(t.store.get('repo/w1').waitUntil,iso(base+30*MIN),'같은 값 재저장은 차례 변경이 아니다');
    assert.equal(t.update('repo/w1','--turn-owner','p-작업자').status,0);
    assert.equal(t.store.get('repo/w1').waitUntil,undefined,'차례를 넘기면 대기는 끝난다');
    // 지우기(none).
    assert.equal(t.update('repo/w1','--wait-until',iso(base+30*MIN)).status,0);
    assert.equal(t.update('repo/w1','--wait-until','none').status,0);
    assert.equal(t.store.get('repo/w1').waitUntil,undefined);
    assert.equal(t.store.get('repo/w1').waitUntilSetAt,undefined);
    // 완료·취소는 칸을 비운다.
    for(const [key,action] of [['repo/w1','complete'],['repo/w2','cancel']]){
      assert.equal(t.update(key,'--wait-until',iso(base+30*MIN)).status,0);
      const r=t.cliRun(action,key,'--revision',String(t.store.get(key).revision),'--result','끝','--note','시험');
      assert.equal(r.status,0,r.stderr);
      const stored=t.store.get(key);
      assert.equal(stored.waitUntil,undefined,action);assert.equal(stored.waitUntilSetAt,undefined,action);
    }
    assert.equal(rev()>1,true);
  }finally{t.done();}
});

test('Autopilot 가드는 work update를 막지 않는다',async()=>{
  const {guardedReason}=await import('../src/autopilot-guard.mjs');
  assert.equal(guardedReason('work',['update','repo/w1'],{'wait-until':'2026-11-11T09:00Z'}),null);
});

test('해석 규칙과 화면 글',()=>{
  const now=Date.parse('2026-11-11T00:00:00Z');
  assert.equal(parseWaitUntil('2026-11-11T09:00+09:00',now).ok,false,'00:00Z와 같은 시각이라 지난 시각');
  assert.equal(parseWaitUntil('2026-11-11T09:30+09:00',now).iso,'2026-11-11T00:30:00.000Z');
  assert.equal(parseWaitUntil('2026-11-11',now).ok,false);
  const work={status:'open',waitUntil:'2026-11-11T05:00:00.000Z',waitUntilSetAt:'2026-11-10T23:00:00.000Z'};
  assert.match(waitUntilLabel(work,now),/^\d\d:\d\d까지 대기$/);
  assert.equal(waitUntilLabel(work,Date.parse('2026-11-11T05:00:01Z')),'');
  const shown=showCycleWaits([{work:'a',turnOwner:'@user'},{work:'b',waitUntil:work.waitUntil},{work:'c',waitUntil:'2026-11-10T00:00:00Z'}],now);
  assert.deepEqual(shown.map(x=>x.work),['a','b']);
  assert.match(shown[1].waitLabel,/까지 대기$/);
});

test('/api/dashboard/status: 대기 시각 항목은 HH:MM까지 대기 글과 함께 실리고, 지난 항목은 빠진다',()=>{
  const f=dashboardFixture({count:2});
  const snapshot=f.snapshot();
  const future=iso(Date.now()+30*MIN),past=iso(Date.now()-MIN);
  const items=[{work:'demo/dashboard',waitUntil:future,tag:WAIT_UNTIL_TAG},{work:'demo/dashboard',waitUntil:past,tag:WAIT_UNTIL_TAG}];
  snapshot.center.monitoring={process:{instances:[]},configuration:{},boards:[],cycle:{settings:{userTurnWaits:items}}};
  const status=dashboardData(snapshot,new URL('http://local/api/dashboard/status'));
  assert.equal(status.userTurnWaits.length,1);
  assert.match(status.userTurnWaits[0].waitLabel,/^\d\d:\d\d까지 대기$/);
  assert.equal(status.userTurnWaits[0].waitUntil,future);
});

const stageOf=e=>String(e.id??e.alertId??'').endsWith(':상위')||e.stage===2?2:1;
const stages=r=>r.idle.map(e=>({minute:e.minute,stage:e.stage??stageOf(e)}));

// R1: 정상 명령만으로, 대기한 시간이 멈춘 시간으로 세어지지 않는다. 만료 → 평소 유예 뒤 1단(본인) → 계속 멈추면 2단(상위).
test('R1: 40분 대기 만료 뒤 대기 종료 시각부터 센다 — 1단(본인, 대기 시각 구절)이 먼저, 2단(상위)이 그 뒤',async()=>{
  const t=setup();
  try{
    const base=Date.now();
    assert.equal(t.update('repo/w1','--wait-until',iso(base+40*MIN)).status,0);
    const r=await simulate({home:t.home,base,minutes:100});
    const s=stages(r),first1=s.find(x=>x.stage===1),first2=s.find(x=>x.stage===2);
    assert.ok(first1&&first2,JSON.stringify(s));
    assert.ok(first1.minute>=55,`1단은 만료(40)+유예(15) 뒤: ${first1.minute}`);
    assert.ok(first2.minute>first1.minute&&first2.minute>=70,`2단은 1단 뒤(만료+30분 이후): ${first2.minute}`);
    assert.equal(r.nudges[0].role,'p-감독','1단은 본인(감독)에게');
    assert.ok(r.nudges[0].minute>=55&&r.nudges[0].minute<first2.minute);
    assert.match(r.nudges[0].msg,/대기 시각\(\d\d:\d\d\)이 지나/);
    assert.equal(r.nudges.filter(n=>n.minute<55).length,0,'만료 전·직후에 안내 없음');
  }finally{t.done();}
});

test('R1: 대기 전에 이미 경보가 떠 있던 업무도 같은 순서(풀림 → 만료 뒤 1단 → 2단)',async()=>{
  const t=setup();
  try{
    const base=Date.now();
    const r=await simulate({home:t.home,base,minutes:110,onMinute:m=>{
      if(m===18){const x=t.update('repo/w1','--wait-until',iso(base+40*MIN));assert.equal(x.status,0,x.stderr);}
    }});
    const s=stages(r);
    assert.ok(s.some(x=>x.minute<18&&x.stage===1),'대기 전 1단');
    assert.equal(s.filter(x=>x.minute>=19&&x.minute<55).length,0,'대기 중·만료 직후 경보 없음');
    const after=s.filter(x=>x.minute>=55);
    assert.equal(after[0].stage,1,'만료 뒤 첫 경보는 1단');
    assert.ok(after.some(x=>x.stage===2),'계속 멈추면 2단');
  }finally{t.done();}
});

// 대조: 같은 감독의 다른 업무로 이미 2단까지 가 있었다면, 대기 업무가 만료돼 들어와도 그 경보의 시간·수신자는 그대로다.
test('R1 대조: 다른 업무의 기존 2단 경보 시간은 대기 업무가 만료돼 들어와도 그대로다',async()=>{
  const t=setup(['repo/w1','repo/w2']);
  try{
    const base=Date.now();
    const plain=await simulate({home:t.home,base,minutes:70});
    assert.equal(t.update('repo/w1','--wait-until',iso(base+40*MIN)).status,0);
    const mixed=await simulate({home:t.home,base,minutes:70});
    // w2는 처음부터 할 일이라 경보 시작·2단 시점이 w1이 없을 때와 같다.
    const only2=await (async()=>{const x=setup(['repo/w2']);try{return await simulate({home:x.home,base,minutes:70});}finally{x.done();}})();
    // 업무를 만든 실제 시각이 몇 ms 달라 주기(1분) 경계에서 최대 1분 어긋날 수 있다. 단계·수신자는 같아야 한다.
    const early=r=>stages(r).filter(x=>x.minute<40),at2=r=>stages(r).find(x=>x.stage===2);
    assert.deepEqual(early(mixed).map(x=>x.stage),early(only2).map(x=>x.stage));
    assert.ok(early(mixed).every((x,i)=>Math.abs(x.minute-early(only2)[i].minute)<=1));
    assert.ok(Math.abs(at2(mixed).minute-at2(only2).minute)<=1&&at2(mixed).minute<40,'2단은 w1 만료(40분) 전에 이미 간다');
    const recipients=r=>[...new Set(r.idle.map(e=>e.recipient??e.role??e.session))];
    assert.deepEqual(recipients(mixed),recipients(only2));
    assert.ok(plain.idle.length>0);
  }finally{t.done();}
});

// R2: 모순되거나 지금보다 미래인 적은 시각의 기록은 대기 중이 아니다(알리는 쪽). 화면 표시도 같은 함수라 대기로 보이지 않는다.
test('R2: 적은 시각이 미래·대기 시각보다 뒤·같음·시계 역행이면 평소 경보, 화면에도 대기가 안 보인다',async()=>{
  const base=Date.now(),at=iso(base);
  const mk=(waitUntil,waitUntilSetAt)=>({status:'open',waitUntil:iso(waitUntil),waitUntilSetAt:iso(waitUntilSetAt)});
  const cases={
    '적은 시각이 지금보다 미래(실행 내내)':mk(base+23*60*MIN,base+22*60*MIN),
    '적은 시각이 대기 시각보다 뒤':mk(base+40*MIN,base+45*MIN),
    '적은 시각이 대기 시각과 같음':mk(base+40*MIN,base+40*MIN),
  };
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-wait-until-r2-'));
  try{
    for(const [name,extra] of Object.entries(cases)){
      const work={key:'repo/w1',repo:'repo',id:'w1',title:'t',goal:'g',owner:'p-감독',ownedAt:at,at,revision:1,history:[],
        executions:[{key:'repo/e1',phase:'implementation',round:1}],...extra};
      assert.equal(activeWaitUntil(work,base),null,name);
      assert.equal(waitUntilLabel(work,base),'',`${name}: 화면 표시`);
      const r=await simulate({home,base,minutes:25,works:()=>[work]});
      assert.ok(r.idle.length>0,`${name}: 놀고 있음이 난다`);
    }
    assert.equal(activeWaitUntil(mk(base+40*MIN,base+5*MIN),base),null,'적은 시각이 5분 뒤(지금보다 미래)');
    // 시계 역행: 정상으로 적은 기록이, 시계가 적은 시각보다 뒤로 가면 대기가 아니다.
    const ok=mk(base+40*MIN,base+10*MIN);
    assert.notEqual(activeWaitUntil({...ok},base+10*MIN),null);
    assert.equal(activeWaitUntil({...ok},base+9*MIN),null,'시계 역행');
    assert.equal(waitUntilLabel({...ok},base+9*MIN),'');
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});
