import test from 'node:test';
import assert from 'node:assert/strict';
import {cycleReads} from '../src/watch-reads.mjs';
import {QUEUE_BANNER} from '../src/watch-queue-resume.mjs';

const bannerScreen = `이전 출력\n\n  ${QUEUE_BANNER}\n\n› \n`;

test('원장 번호가 같으면 한 주기 안에서 재사용하고, 바뀌거나 비교할 수 없으면 다시 읽는다',()=>{
  let version=1,raw=0;
  const reads=cycleReads({readEntries:()=>[++raw],version:()=>version});
  assert.equal(reads.readEntries(),reads.readEntries());
  assert.deepEqual(reads.stats(),{entries:1,cards:0,works:0,reused:1});
  version=2;assert.deepEqual(reads.readEntries(),[2]);
  reads.begin();assert.deepEqual(reads.stats(),{entries:0,cards:0,works:0,reused:0});
  assert.deepEqual(reads.readEntries(),[3],'주기 시작에는 같은 번호라도 다시 읽는다');
  const jsonl=cycleReads({readEntries:()=>[++raw]});
  jsonl.readEntries();jsonl.readEntries();assert.equal(jsonl.stats().entries,2,'JSONL(번호 없음)은 매번 읽는다');
  assert.equal(cycleReads({readEntries:()=>[]}).readCards,null,'카드 읽기가 없으면 없음으로 남긴다');
});

test('읽기 실패는 저장하지 않고, 번호를 먼저 읽어 사이에 끼인 쓰기를 놓치지 않는다',()=>{
  let fail=true,version=1,raw=0;
  const reads=cycleReads({readEntries:()=>{if(fail)throw new Error('busy');return [++raw];},version:()=>version});
  assert.throws(()=>reads.readEntries(),/busy/);fail=false;
  assert.deepEqual(reads.readEntries(),[1]);
  // 읽는 도중 쓰기가 끼어 번호가 올라가도, 저장된 번호는 읽기 전 값이라 다음 호출이 다시 읽는다.
  const racing=cycleReads({readEntries:()=>{version++;return [++raw];},version:()=>version});
  racing.readEntries();racing.readEntries();assert.equal(racing.stats().entries,2);
});

async function runQueueCycles({cached,screenFor}) {
  const {runWatch}=await import('../src/watch-runner.mjs');
  const controller=new AbortController();let now=0,cycle=0,rawEntries=0,screenReads=0,readsThisCycle=0;
  const role='worker',session='kadan-worker',enters=[];
  const card={id:'task',key:'repo/task',role,status:'assigned',workType:'execution',activity:'running'};
  const entries=[{kind:'start',role,session,panePid:1,t:'1970-01-01T00:00:00Z'},{kind:'send',role,taskId:'task',t:'1970-01-01T00:00:00Z'}];
  const raw={readEntries:()=>{rawEntries++;return entries;},readCards:()=>[card],readWorks:()=>[]};
  const reads=cached?cycleReads({...raw,version:()=>entries.length}):null;
  await runWatch({floor:{list:()=>[{session,pid:1,alive:true}],read:()=>{screenReads++;return screenFor(cycle,readsThisCycle++);}},
    ...(reads?{readEntries:reads.readEntries,readCards:reads.readCards,readWorks:reads.readWorks,reads}:raw),
    record:e=>entries.push({...e,t:new Date(now).toISOString()}),
    sendQueueEnter:(r,pid)=>{enters.push([r,pid]);return {keyDelivery:'sent',inputAcceptance:'unconfirmed'};},
    sendAlert:()=>{},intervalMs:1000,stallN:1,routes:new Map(),superRole:'boss',now:()=>now,
    spawn:()=>({status:0,stdout:String(process.pid)}),signal:controller.signal,print:()=>{},
    // 큐 재개의 전송 후 확인 대기(800ms)는 주기가 아니다.
    sleep:async ms=>{if(ms!==1000)return;cycle++;now+=1000;readsThisCycle=0;if(cycle>=4)controller.abort();}});
  return {enters,rawEntries,screenReads,cycle};
}

test('재사용해도 큐 재개 재확인은 화면을 새로 읽고, 원장 전체 읽기만 줄어든다',async()=>{
  // 첫 주기는 감시 범위 기록이 원장을 바꾸므로, 배너는 둘째 주기부터 띄운다.
  const screenFor=cycle=>cycle>=1?bannerScreen:'› ';
  const plain=await runQueueCycles({cached:false,screenFor});
  const cached=await runQueueCycles({cached:true,screenFor});
  assert.equal(plain.enters.length,1);assert.equal(cached.enters.length,1);
  assert.equal(cached.screenReads,plain.screenReads,'화면 읽기 횟수는 줄이지 않는다');
  assert.ok(cached.rawEntries<plain.rawEntries,`원장 읽기 ${plain.rawEntries} → ${cached.rawEntries}`);
});

test('관측 뒤 사용자가 입력을 시작하면 재사용 중에도 Enter를 보내지 않는다',async()=>{
  // 주기의 첫 화면(관측)은 큐 배너, 재확인 화면은 사용자가 입력 중인 최신 화면이다.
  const run=await runQueueCycles({cached:true,screenFor:(cycle,n)=>cycle<1?'› ':n===0?bannerScreen:'› 사용자가 입력 중'});
  assert.equal(run.enters.length,0);
});

test('주기가 끝나 대기하는 동안에는 재사용 자료를 붙잡아 두지 않는다',async()=>{
  const {runWatch}=await import('../src/watch-runner.mjs');
  let raw=0,cachedDuringSleep=null;const stop=new Error('stop');
  const reads=cycleReads({readEntries:()=>{raw++;return [];},readCards:()=>[],readWorks:()=>[],version:()=>1});
  await assert.rejects(()=>runWatch({floor:{list:()=>[],read:()=>''},readEntries:reads.readEntries,readCards:reads.readCards,readWorks:reads.readWorks,reads,
    record:()=>{},sendAlert:()=>{},intervalMs:1000,stallN:1,routes:new Map(),superRole:null,print:()=>{},spawn:()=>({status:0,stdout:''}),
    sleep:async()=>{const before=raw;reads.readEntries();cachedDuringSleep=raw===before;throw stop;}}),e=>e===stop);
  assert.equal(cachedDuringSleep,false,'대기 중 읽기는 원장을 다시 읽어야 한다');
});
