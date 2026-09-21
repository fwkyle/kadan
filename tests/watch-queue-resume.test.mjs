import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {QueueResume,queuedInputBanner,QUEUE_BANNER} from '../src/watch-queue-resume.mjs';
import {sendTmuxEnter} from '../src/floor-tmux.mjs';
import {appendLedger,readLedger} from '../src/ledger.mjs';
import {createDatabase,writeStorageMarker} from '../src/storage.mjs';
import {spawnSync} from 'node:child_process';

const bannerScreen = `이전 출력\n\n  ${QUEUE_BANNER}\n\n› \n`;
const idle = '› ';

function fixture() {
  const entries=[], sent=[], screens=[];
  let now=0;
  const seen={role:'worker',alive:true,pid:1,expectedPid:1,startedAt:'start',screen:bannerScreen};
  let tasks=[{role:'worker',taskId:'task'}], cards=[{id:'task',key:'repo/task',role:'worker',status:'assigned',activity:'running'}], fresh=()=>true;
  const opts={
    record:e=>entries.push(e),
    sendEnter:(...args)=>{sent.push(args);return {keyDelivery:'sent',inputAcceptance:'unconfirmed'};},
    readScreen:()=>screens.at(-1)??bannerScreen,
    sleep:async()=>{},
  };
  return {entries,sent,seen,screens,opts,setTasks:t=>tasks=t,setCards:c=>cards=c,setFresh:f=>fresh=f,
    tick:async()=>{const q=new QueueResume(opts);await q.tick({entries,now,tasks,cards,observations:new Map([['kadan-worker',seen]]),fresh});return q.alerts;}};
}

test('정확한 큐 배너만 감지한다 — 일반 프롬프트·진행 중·완료 마커는 아니다',()=>{
  assert.equal(queuedInputBanner(idle),null);
  assert.equal(queuedInputBanner(''),null);
  assert.equal(queuedInputBanner(null),null);
  assert.equal(queuedInputBanner(`${QUEUE_BANNER}\nThinking…`),null);
  assert.equal(queuedInputBanner(`${QUEUE_BANNER}\nWorking (2s • esc to interrupt)`),null);
  assert.equal(queuedInputBanner(`${QUEUE_BANNER}\nKADAN:DONE task ok`),null);
  assert.equal(queuedInputBanner(`queued messages now`),null); // 부분 문구는 아니다
  const hit=queuedInputBanner(bannerScreen);
  assert.ok(hit); assert.equal(hit.unsafe,null); assert.match(hit.fingerprint,/^[0-9a-f]{64}$/);
});

test('안전 조건이 맞으면 빈 Enter를 정확히 1회 보내고 전환을 별도로 기록한다',async()=>{
  const f=fixture();
  f.screens.push('이전 출력\n\n› \n Thinking…'); // Enter 뒤 배너 소거 + 진행
  await f.tick();
  assert.equal(f.sent.length,1);
  assert.deepEqual(f.sent[0],['worker',1]);
  const actions=f.entries.map(e=>e.action);
  assert.deepEqual(actions,['attempt','sent','transition']);
  const sentRecord=f.entries.find(e=>e.action==='sent');
  assert.equal(sentRecord.keyDelivery,'sent'); assert.equal(sentRecord.inputAcceptance,'unconfirmed');
  assert.equal(f.entries.find(e=>e.action==='transition').transition,'progress');
});

test('같은 지문이 여러 주기 유지돼도 Enter는 총 1회다',async()=>{
  const f=fixture(); // readScreen이 계속 배너를 돌려줌 = 전환 없음
  const a1=await f.tick(); assert.equal(f.sent.length,1);
  assert.ok(a1.some(a=>a.kind==='입력큐')); // 전환 없음 경보 1회
  const a2=await f.tick(); assert.equal(f.sent.length,1);
  assert.ok(a2.some(a=>a.kind==='입력큐')); // 같은 id — dedupAlerts가 중복 발송을 막는다
  assert.equal(a2[0].id,a1[0].id);
  assert.equal(f.entries.filter(e=>e.action==='sent').length,1);
});

test('화면 지문이 바뀌면 새 사건이다',async()=>{
  const f=fixture();
  await f.tick(); assert.equal(f.sent.length,1);
  f.seen.screen=`다른 출력\n\n  ${QUEUE_BANNER}\n\n› \n`;
  await f.tick(); assert.equal(f.sent.length,2);
});

test('안전 조건 불충족은 이유별 경보 1회이고 Enter는 0회다',async()=>{
  // PID 불일치
  {const f=fixture(); f.seen.expectedPid=2; const a=await f.tick();
   assert.equal(f.sent.length,0); assert.ok(a.some(x=>x.line.includes('PID 불일치')));
   assert.equal(f.entries.at(-1).action,'not-sent');}
  // 죽은 pane
  {const f=fixture(); f.seen.alive=false; const a=await f.tick();
   assert.equal(f.sent.length,0); assert.ok(a.some(x=>x.line.includes('pane')));}
  // 완료 카드(담당 실행 없음)
  {const f=fixture(); f.setTasks([]); const a=await f.tick();
   assert.equal(f.sent.length,0); assert.ok(a.some(x=>x.line.includes('미완료 발령 카드가 없음')));}
  // 승인 질문 동시 표시
  {const f=fixture(); f.seen.screen=`${QUEUE_BANNER}\nAllow? [Y/n]`; const a=await f.tick();
   assert.equal(f.sent.length,0); assert.ok(a.some(x=>x.line.includes('승인')));}
  // 입력창 미완성 텍스트
  {const f=fixture(); f.seen.screen=`${QUEUE_BANNER}\n› 절반만 쓴 명령`; const a=await f.tick();
   assert.equal(f.sent.length,0); assert.ok(a.some(x=>x.line.includes('미완성')));}
  // copy mode — 전송 시점 floor 오류로 구분된다
  {const f=fixture(); f.opts.sendEnter=()=>{const e=new Error('복사모드');e.code='KADAN_PANE_IN_MODE';throw e;};
   const a=await f.tick(); assert.equal(f.sent.length,0); assert.ok(a.some(x=>x.line.includes('copy mode')));
   assert.equal(f.entries.at(-1).action,'delivery-failed');}
  // 카드가 running이 아니면 조용히 둔다(경보도 없음)
  {const f=fixture(); f.setCards([{id:'task',key:'repo/task',role:'worker',status:'assigned',activity:'waiting'}]);
   const a=await f.tick(); assert.equal(f.sent.length,0); assert.equal(a.length,0);}
  // 담당 실행이 둘이면 보내지 않는다
  {const f=fixture(); f.setTasks([{role:'worker',taskId:'a'},{role:'worker',taskId:'b'}]); const a=await f.tick();
   assert.equal(f.sent.length,0); assert.ok(a.some(x=>x.line.includes('여러 개')));}
  // 전송 직전 상태 변경
  {const f=fixture(); f.setFresh(()=>false); const a=await f.tick();
   assert.equal(f.sent.length,0); assert.ok(a.some(x=>x.line.includes('전송 직전')));}
  // 전달 실패는 재시도하지 않는다
  {const f=fixture(); f.opts.sendEnter=()=>{throw new Error('ambiguous')}; const a=await f.tick();
   assert.equal(f.entries.at(-1).action,'delivery-failed'); await f.tick();
   assert.equal(f.entries.filter(e=>e.action==='attempt').length,1);}
});

test('watch 순회에서 큐 배너는 AI 판정 없이 Enter를 보내고 timeout 문구는 분리된다',async()=>{
  const {runWatch}=await import('../src/watch-runner.mjs');
  const controller=new AbortController(); let now=0,cycle=0;
  const role='worker',session='kadan-worker',records=[],enters=[],alerts=[],aiCalls=[];
  let screen=bannerScreen;
  const card={id:'task',key:'repo/task',role,status:'assigned',workType:'execution',activity:'running'};
  const entries=[{kind:'start',role,session,panePid:1,t:'1970-01-01T00:00:00Z'},
   {kind:'send',role,taskId:'task',t:'1970-01-01T00:00:00Z'}];
  await runWatch({floor:{list:()=>[{session,pid:1,alive:true}],read:()=>screen},
   readEntries:()=>entries,readCards:()=>[card],readWorks:()=>[],
   record:e=>{records.push(e);entries.push({...e,t:new Date(now).toISOString()});},
   sendQueueEnter:(r,pid)=>{enters.push([r,pid]);screen='›\n Thinking…';return {keyDelivery:'sent',inputAcceptance:'unconfirmed'};},
   sendAlert:(...args)=>alerts.push(args),
   judgeCmd:'fake-judge',ai:{run:async(...a)=>{aiCalls.push(a);return {ok:false,reason:'timeout'};},reports:{retire:()=>{}}},
   intervalMs:1000,stallN:1,routes:new Map(),superRole:'boss',now:()=>now,
   spawn:()=>({status:0,stdout:String(process.pid)}),signal:controller.signal,print:()=>{},
   sleep:async()=>{cycle++;now+=1000;if(cycle>=8)controller.abort();}});
  assert.equal(enters.length,1);
  assert.ok(records.some(e=>e.kind==='queue-resume'&&e.action==='sent'&&e.keyDelivery==='sent'&&e.inputAcceptance==='unconfirmed'));
  assert.ok(records.some(e=>e.kind==='queue-resume'&&e.action==='transition'));
  // 판정 AI timeout은 작업자 응답 장애가 아니라 감시AI 오류로 분리된다
  const timeoutAlerts=alerts.filter(([,m])=>typeof m==='string'&&m.includes('시간 초과'));
  assert.ok(timeoutAlerts.some(([,m])=>m.includes('감시 판정 AI 시간 초과 — 작업 상태 미판정')),alerts.map(a=>a[1]).join('\n'));
  assert.ok(!alerts.some(([,m])=>typeof m==='string'&&m.includes('대답을 못 함')));
});

test('JSONL·SQLite 저장 방식에서 사건과 중복 방지가 동일하다',async()=>{
  const runs=[];
  for(const backend of ['jsonl','sqlite']){
    const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-queue-'));
    if(backend==='sqlite'){createDatabase(home);writeStorageMarker(home,'sqlite');}
    const sent=[];
    const seen={role:'worker',alive:true,pid:1,expectedPid:1,startedAt:'start',screen:bannerScreen};
    const tasks=[{role:'worker',taskId:'task'}],cards=[{id:'task',key:'repo/task',role:'worker',status:'assigned',activity:'running'}];
    for(let i=0;i<3;i++){
      const q=new QueueResume({record:e=>appendLedger(e,home),sleep:async()=>{},
        sendEnter:(...a)=>{sent.push(a);return {keyDelivery:'sent',inputAcceptance:'unconfirmed'};},readScreen:()=>bannerScreen});
      await q.tick({entries:readLedger(home),now:i,tasks,cards,observations:new Map([['kadan-worker',seen]]),fresh:()=>true});
    }
    runs.push({sentCount:sent.length,actions:readLedger(home).filter(e=>e.kind==='queue-resume').map(e=>e.action)});
  }
  assert.equal(runs[0].sentCount,1);assert.equal(runs[1].sentCount,1);
  assert.deepEqual(runs[0].actions,runs[1].actions);
  assert.deepEqual(runs[0].actions,['attempt','sent','transition']);
});

test('격리 실제 tmux: 빈 Enter는 빈 줄만 제출하고 copy mode에서는 막힌다',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-queue-tmux-'));
  const session=`queue-test-${process.pid}`,socket=`queue-test-${process.pid}-${Date.now()}`;
  const received=path.join(home,'received');
  const transcript=[];
  const call=(bin,args,input)=>{const p=spawnSync(bin,args,{input,encoding:'utf8',timeout:10000});transcript.push({args,input,exit:p.status,stdout:p.stdout,stderr:p.stderr});return p;};
  const tmux=(args,input)=>{const p=call('tmux',['-L',socket,...args],input);assert.equal(p.status,0,p.stderr);return p.stdout;};
  const run=(args,input)=>{const p=call('tmux',['-L',socket,...args],input);if(p.status!==0)throw new Error(p.stderr);return p.stdout;};
  const receiver=path.join(home,'receiver.mjs');
  fs.writeFileSync(receiver,`import fs from 'node:fs';import readline from 'node:readline';readline.createInterface({input:process.stdin}).on('line',l=>fs.appendFileSync(${JSON.stringify(received)},l+'\\n'));`);
  const contents=()=>fs.existsSync(received)?fs.readFileSync(received,'utf8'):'';
  let started=false;
  try{
    tmux(['new-session','-d','-s',session,'-x','80','-y','24',`'${process.execPath}' '${receiver}'`]);started=true;
    spawnSync('sleep',['0.5']);
    const receipt=sendTmuxEnter(session,{run});
    assert.deepEqual(receipt,{keyDelivery:'sent',inputAcceptance:'unconfirmed'});
    spawnSync('sleep',['0.3']);
    assert.equal(contents(),'\n','본문 없이 빈 줄 하나만 제출된다');
    assert.doesNotMatch(tmux(['capture-pane','-p','-t',session]),/queued|Enter/,'아무 텍스트도 입력창에 남기지 않는다');
    tmux(['copy-mode','-t',session]);
    assert.throws(()=>sendTmuxEnter(session,{run}),e=>e.code==='KADAN_PANE_IN_MODE');
    spawnSync('sleep',['0.2']);assert.equal(contents(),'\n');
    tmux(['send-keys','-t',session,'-X','cancel']);
  }finally{
    if(started)call('tmux',['-L',socket,'kill-session','-t',session]);
    fs.writeFileSync(path.join(home,'transcript.json'),JSON.stringify(transcript,null,2)+'\n');
    console.log(`입력 큐 Enter 증거: ${home}/transcript.json / socket=${socket}`);
  }
});
