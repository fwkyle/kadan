import "./helpers/isolated-home.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runWatch} from '../src/watch-runner.mjs';
import {userTurnWaitList, USER_TURN_WAIT_TAG} from '../src/handover-state.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {workCommand} from '../src/work-command.mjs';
import {cycleStatus} from '../src/watch-cycle.mjs';
import {spawnSync} from 'node:child_process';
import {dashboardData} from '../src/dashboard-api.mjs';
import {dashboardFixture} from './helpers/dashboard-fixture.mjs';

// 놀고 있음 PR-1: 차례 칸의 사용자·글 값. 판정이 바뀌는 곳은 B4a(사용자 값이면서 current) 하나뿐이다.
// 가짜 시계로 감시 순회를 돌리고, 실제 알림·모델 호출·운영 홈은 쓰지 않는다.
const epoch=Date.parse('2026-10-23T00:00:00Z');
const stamp=m=>new Date(epoch+m*60_000).toISOString();
const parents=new Map([['p-작업자','p-감독'],['p-감독','p-슈퍼감독'],['p-슈퍼감독','@user']]);
const starts=[...parents.keys()].map((role,i)=>({kind:'start',role,session:'kadan-'+role,panePid:i+1,t:stamp(0)}));
// 모든 업무는 끝난 하위 실행 하나를 가진다(감시 범위에 들어가려면 실행 이력이 필요하다). 카드 at이 차례 기록(turnAt)보다 늦으면 stale이다.
const work=(extra={})=>({key:'repo/w1',repo:'repo',id:'w1',title:'t',goal:'g',status:'open',owner:'p-감독',ownedAt:stamp(0),at:stamp(0),
  revision:1,history:[],executions:[{key:'repo/e1',phase:'implementation',round:1}],...extra});
const child={key:'repo/e1',id:'e1',status:'done',activity:'done',workType:'execution',role:'p-작업자',board:'p',at:stamp(0),runs:[]};
const lateChild={...child,at:stamp(5)};
const ended=[{kind:'send',role:'p-작업자',taskId:'e1',t:stamp(0)},{kind:'done',role:'p-작업자',taskId:'e1',result:'ok',t:stamp(1)}];

async function simulate({works,cards=[child],minutes=20}){
  const records=[],nudges=[],controller=new AbortController();let minute=0;
  const entries=[...starts,...ended];
  await runWatch({signal:controller.signal,intervalMs:60_000,stallN:2,stallAfterMs:300_000,idleMs:15*60_000,
    parents,routes:new Map(),superRole:'p-슈퍼감독',now:()=>epoch+minute*60_000,
    floor:{list:()=>starts.map(s=>({session:s.session,pid:s.panePid})),read:()=>'frozen screen',alive:()=>true},
    readEntries:()=>entries,readCards:()=>cards,readWorks:()=>works,readDecisions:()=>[],
    sendAlert:()=>{},sendNudge:(role,msg)=>{nudges.push([minute,role,msg]);},
    record:e=>{records.push({...e,minute});entries.push({...e,t:stamp(minute)});},
    print:()=>{},spawn:()=>({status:0,stdout:''}),
    sleep:async()=>{if(++minute>=minutes)controller.abort();}});
  return {nudges,records,idle:records.filter(e=>e.kind==='alert'&&!e.resolved&&e.alertKind==='놀고 있음'),
    cycles:records.filter(e=>e.kind==='watch-cycle')};
}
const withEnv=async(name,value,fn)=>{
  const before=process.env[name];process.env[name]=value;
  try{return await fn();}finally{if(before===undefined)delete process.env[name];else process.env[name]=before;}
};

test('사용자 차례(@user, current): 놀고 있음 경보가 없고 주기 기록에 꼬리표가 남는다',async()=>{
  const r=await simulate({works:[work({turnOwner:'@user',turnAt:stamp(1)})]});
  assert.deepEqual(r.idle,[]);assert.deepEqual(r.nudges,[]);
  assert.deepEqual(r.cycles[0].userTurnWaits,[{work:'repo/w1',turnOwner:'@user',tag:USER_TURN_WAIT_TAG}]);
  assert.equal(USER_TURN_WAIT_TAG,'사용자 대기(차례 칸)');
  // 대시보드 status API가 읽는 주기 상태(cycleStatus)에도 같은 목록이 실린다.
  const status=cycleStatus([{...r.cycles[0],t:stamp(1),pid:7}],{pid:7,startedAt:stamp(0)},epoch+2*60_000);
  assert.equal(status.settings.userTurnWaits[0].tag,'사용자 대기(차례 칸)');
});

test('사람·사용자도 같다. 기본 이름이 아닌 값은 KADAN_USER_NAMES에 넣어야 사용자 대기다',async()=>{
  for(const turnOwner of ['사람','사용자']){
    const r=await simulate({works:[work({turnOwner,turnAt:stamp(1)})]});
    assert.deepEqual(r.idle,[],turnOwner);
  }
  const plain=await simulate({works:[work({turnOwner:'kyle',turnAt:stamp(1)})]});
  assert.equal(plain.idle.length>=1,true,'kyle은 기본 이름이 아니라 경보 유지');
  await withEnv('KADAN_USER_NAMES','kyle',async()=>{
    const r=await simulate({works:[work({turnOwner:'kyle',turnAt:stamp(1)})]});
    assert.deepEqual(r.idle,[]);assert.equal(r.cycles[0].userTurnWaits[0].turnOwner,'kyle');
  });
});

test('stale @user(차례 기록 뒤 하위 실행이 움직임)는 제외되지 않고 지금처럼 owner에게 경보',async()=>{
  const w=work({turnOwner:'@user',turnAt:stamp(1)});
  assert.deepEqual(userTurnWaitList([w],[lateChild]),[]);
  const r=await simulate({works:[w],cards:[lateChild]});
  assert.equal(r.idle[0]?.role,'p-감독');
  assert.equal(r.cycles[0].userTurnWaits,undefined);
});

test('시각 없는 옛 @user(unknown)도 빼지 않는다',async()=>{
  const r=await simulate({works:[work({turnOwner:'@user'})]});
  assert.equal(r.idle[0]?.role,'p-감독');
});

test('글 차례: 판정은 owner 그대로, 본문에 안내 두 줄. 긴 값은 40자에서 잘린다',async()=>{
  const r=await simulate({works:[work({turnOwner:'외부 대기: 업체 회신',turnAt:stamp(1)})]});
  assert.equal(r.idle[0]?.role,'p-감독');
  const text=r.nudges[0][2];
  assert.match(text,/차례 칸 값 '외부 대기: 업체 회신'는 관계표에 없어 책임 감독에게 계속 갑니다\./);
  assert.match(text,/사용자 답을 기다리면 `--turn-owner @user`, 밖에서 기다리면 `kadan work update 'repo\/w1' --revision 1 --status hold --next-action '…' --note '외부 대기'`로 멈추세요\. 거절되면 `kadan work show 'repo\/w1'`로 새 revision을 보세요\./);
  const long='가'.repeat(60);
  const cut=await simulate({works:[work({turnOwner:long,turnAt:stamp(1)})]});
  assert.match(cut.nudges[0][2],new RegExp(`'${'가'.repeat(40)}…'`));
  assert.ok(!cut.nudges[0][2].includes('가'.repeat(41)));
  assert.equal(cut.idle[0].idleItems.ownWhy[0].turnValue,'가'.repeat(40)+'…');
  assert.equal(cut.cycles[0].userTurnWaits,undefined);
});

test('안내는 글 값에만 붙는다: 관계표 안 역할·빈 값·사용자 값·stale 글에는 없다',async()=>{
  for(const extra of [{turnOwner:'p-감독',turnAt:stamp(1)},{turnOwner:'',turnAt:stamp(1)},{turnOwner:'외부 대기',turnAt:undefined}]){
    const r=await simulate({works:[work(extra)]});
    assert.ok(r.nudges.length>0&&!r.nudges[0][2].includes('차례 칸 값'),JSON.stringify(extra));
  }
  const w=work({turnOwner:'외부 대기',turnAt:stamp(1)});
  const stale=await simulate({works:[w],cards:[lateChild]});
  assert.ok(stale.nudges.length>0&&!stale.nudges[0][2].includes('차례 칸 값'));
});

test('hold 업무는 글 차례여도 경보가 없다(기존 동작)',async()=>{
  const r=await simulate({works:[work({status:'hold',turnOwner:'외부 대기: 업체 회신',turnAt:stamp(1)})]});
  assert.deepEqual(r.idle,[]);
});

test('--turn-owner @user·사람 진입: 받아들여지고 원장에 남는다. 임의 글도 지금처럼 받아들인다',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-turn-values-'));
  try{
    const store=new WorkStore(home),key='test/turn';
    store.create({key,title:'t',goal:'g',scope:'s',acceptance:'a',owner:'p-감독',repoPath:home});
    for(const value of ['@user','사람','외부 대기: 업체 회신']){
      const revision=store.get(key).revision;
      const updated=workCommand(['update',key],{revision,note:'차례 값 시험','turn-owner':value},{home,by:'p-감독'});
      assert.equal(updated.turnOwner,value);
      assert.equal(store.get(key).turnOwner,value);
      assert.ok(Number.isFinite(Date.parse(store.get(key).turnAt)));
    }
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

// F1: 경보가 안내한 명령 문자열을 격리 홈의 실제 CLI로 그대로 실행한다.
test('안내한 hold 명령은 실제 CLI에서 종료 0으로 hold를 저장하고, 오래된 revision은 거절한다',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-hold-hint-'));
  const cli=new URL('../src/cli.mjs',import.meta.url).pathname;
  const run=cmd=>spawnSync('sh',['-c',cmd.replace(/^kadan /,`${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} `)],
    {encoding:'utf8',env:{...process.env,KADAN_HOME:home,KADAN_ROLE:'p-감독',KADAN_NOTIFY:'off',KADAN_WINDOW:'none'}});
  try{
    const store=new WorkStore(home);
    store.create({key:'repo/w1',title:'t',goal:'g',scope:'s',acceptance:'a',owner:'p-감독',repoPath:home});
    // 차례 값을 글로 바꿔 revision을 올린 뒤, 그 업무 객체로 경보 본문을 만든다.
    workCommand(['update','repo/w1'],{revision:store.get('repo/w1').revision,note:'글 차례','turn-owner':'외부 대기: 업체 회신'},{home,by:'p-감독'});
    const stored=store.get('repo/w1');
    const r=await simulate({works:[work({turnOwner:stored.turnOwner,turnAt:stamp(1),revision:stored.revision})]});
    const command=r.nudges[0][2].match(/`(kadan work update [^`]+)`/)[1];
    assert.match(command,new RegExp(`--revision ${stored.revision} `));
    const stale=run(command.replace(`--revision ${stored.revision} `,`--revision ${stored.revision-1} `));
    assert.notEqual(stale.status,0);
    assert.equal(store.get('repo/w1').status,'open');
    const ok=run(command);
    assert.equal(ok.status,0,ok.stderr);
    assert.equal(new WorkStore(home).get('repo/w1').status,'hold');
    assert.equal(new WorkStore(home).get('repo/w1').nextAction,'…');
    const show=run(r.nudges[0][2].match(/`(kadan work show [^`]+)`/)[1]);
    assert.equal(show.status,0,show.stderr);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

// F3: 기록·응답용 차례 값만 80자에서 자른다. 판정은 원문을 쓴다.
test('주기 기록의 userTurnWaits 차례 값은 80자 상한을 둔다',async()=>{
  const long='@user'.padEnd(200,'가');
  const r=await withEnv('KADAN_USER_NAMES',long,()=>simulate({works:[work({turnOwner:long,turnAt:stamp(1)})]}));
  assert.deepEqual(r.idle,[],'판정에는 원문을 써서 사용자 대기로 뺀다');
  assert.equal(r.cycles[0].userTurnWaits[0].turnOwner,long.slice(0,80)+'…');
});

// F2: status API에 새 키 userTurnWaits만 더한다.
test('/api/dashboard/status 응답에 userTurnWaits가 실린다(없으면 빈 목록)',()=>{
  const f=dashboardFixture({count:2});
  const none=dashboardData(f.snapshot(),new URL('http://local/api/dashboard/status'));
  assert.deepEqual(none.userTurnWaits,[]);
  const snapshot=f.snapshot();
  const waits=[{work:'repo/w1',turnOwner:'@user',tag:USER_TURN_WAIT_TAG}];
  snapshot.center.monitoring={process:{instances:[]},configuration:{},boards:[],cycle:{settings:{userTurnWaits:waits}}};
  const status=dashboardData(snapshot,new URL('http://local/api/dashboard/status'));
  assert.deepEqual(status.userTurnWaits,waits);
  assert.ok('executionCount' in status&&'works' in status&&'rows' in status,'기존 키는 그대로');
});
