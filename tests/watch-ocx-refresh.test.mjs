// codex 한도 경보가 처음 생길 때 감시기가 ocx 사용량을 새로 받고 결과를 경보에 붙인다(가짜 ocx 명령만 쓴다, 실제 ocx는 부르지 않는다).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runWatch} from '../src/watch-runner.mjs';
import {createOcxRefresher, ocxAlertLine, parseUsage} from '../src/ocx-refresh.mjs';

const epoch=Date.parse('2026-10-18T00:00:00Z');
const stamp=m=>new Date(epoch+m*60_000).toISOString();
// 2026-10-18 실제 화면(codex 0.163, 14시간 멈춤)의 꼬리. Reconnecting이 남아 있어 terminal429는 null이다.
// 끊김 낱말을 훑는 범위가 마지막 6줄인 main에서는 429 줄이 범위 밖이라 경보가 나지 않는다(#187이 12줄로 넓힌다). 합친 뒤에는 realScreen으로 바꿔 돌린다.
const realScreen=`
• Reconnecting... 1/5 (14h 04m 30s • esc to interrupt)
  └ Exceeded retry limit, last status: 429 Too Many Requests
  └ Tip: Use /skills to list available skills or ask Codex to use one.


› Ask Codex to do anything

  GPT-6.1-Sol high · ~/Dev/kadan · main · Context 0% used · weekly 97% left
  ? for shortcuts`;
const limitScreen=n=>`• Reconnecting... ${n}/5\n  └ Exceeded retry limit, last status: 429 Too Many Requests\n\n› Ask Codex to do anything`;
const SECRET='sk-proj-AbCdEf0123456789AbCdEf0123456789';

function fakeOcx(body){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-ocx-'));
 const log=path.join(dir,'calls.log'),bin=path.join(dir,'ocx');
 fs.writeFileSync(bin,`#!/bin/sh\necho "$@" >> '${log}'\n${body}\n`,{mode:0o755});
 return {bin,calls:()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean):[]};
}
const okOcx=()=>fakeOcx(`echo "5h window: 12%"\necho "weekly: 3% token ${SECRET}"\necho "${SECRET}" >&2`);

// roles: [{role, harness, screenAt(minute)}]
async function run({roles,ocxBin,stopAt=6,seed=[]}){
 const prev=process.env.KADAN_OCX_BIN;
 if(ocxBin===undefined)delete process.env.KADAN_OCX_BIN;else process.env.KADAN_OCX_BIN=ocxBin;
 try{
  const parents=new Map([...roles.map(r=>[r.role,'p-감독']),['p-감독','@user']]);
  const starts=[...roles.map((r,i)=>({kind:'start',role:r.role,session:'kadan-'+r.role,harness:r.harness,...(r.start??{}),panePid:i+1,t:stamp(0)})),
   {kind:'start',role:'p-감독',session:'kadan-p-감독',panePid:99,t:stamp(0)}];
  const cards=roles.map((r,i)=>({id:'t'+i,key:'repo/t'+i,role:r.role,board:'p',status:'assigned',activity:'running',workType:'execution'}));
  const records=[],sent=[],prints=[],resumes=[];let minute=0;const controller=new AbortController();
  const entries=[...seed,...starts,...roles.map((r,i)=>({kind:'send',role:r.role,taskId:'t'+i,t:stamp(0)}))];
  await runWatch({signal:controller.signal,intervalMs:60_000,stallN:2,stallAfterMs:300_000,parents,routes:new Map(),superRole:'p-감독',
   now:()=>epoch+minute*60_000,
   floor:{list:()=>starts.map(s=>({session:s.session,pid:s.panePid})),
    read:s=>roles.find(r=>'kadan-'+r.role===s)?.screenAt(minute)??'감독 화면',alive:()=>true},
   readEntries:()=>entries,resume429:(role,msg)=>resumes.push([minute,role]),readCards:()=>cards,readWorks:()=>[],
   sendAlert:(role,msg)=>sent.push([minute,role,msg]),record:e=>{records.push(e);entries.push({...e,t:stamp(minute)});},
   print:l=>prints.push(l),notifyLog:null,spawn:()=>({status:0,stdout:''}),
   sleep:async()=>{if(++minute>=stopAt)controller.abort();}});
  return {records,sent,prints,resumes};
 }finally{if(prev===undefined)delete process.env.KADAN_OCX_BIN;else process.env.KADAN_OCX_BIN=prev;}
}
const working=m=>'Working... 출력 '+m;
const limitFrom=(at,screen)=>m=>m>=at?screen:working(m);
const limitMsgs=sent=>sent.filter(([,,m])=>/한도/.test(m)&&!/해소/.test(m));
const everything=r=>JSON.stringify([r.records,r.sent,r.prints]);

test('codex 세션의 첫 한도: 호출 1번, 원장 1줄, 경보에 결과 줄과 감독 할 일',async()=>{
 const ocx=okOcx();
 const r=await run({ocxBin:ocx.bin,roles:[{role:'p-작업자',harness:'codex',screenAt:limitFrom(2,limitScreen(1))}]});
 assert.deepEqual(ocx.calls(),['account refresh openai']);
 const lines=r.records.filter(e=>e.kind==='ocx-refresh');
 assert.equal(lines.length,1);
 assert.deepEqual({by:lines[0].by,provider:lines[0].provider,outcome:lines[0].outcome,exitCode:lines[0].exitCode,usage:lines[0].usage,trigger:lines[0].trigger},
  {by:'watch',provider:'openai',outcome:'ok',exitCode:0,usage:{fiveHour:12,weekly:3},trigger:{role:'p-작업자',session:'kadan-p-작업자'}});
 const msgs=limitMsgs(r.sent);
 assert.equal(msgs.length,1);
 assert.match(msgs[0][2],/사용량 새로 받음: 5시간 12% 주간 3% — 가짜 한도였을 가능성, 이 창은 esc 뒤 재개 필요\(자동 재개 안 함\)/);
});

test('ocx 원래 출력(토큰처럼 생긴 글자)은 원장·경보·감시 출력 어디에도 남지 않는다',async()=>{
 const ocx=okOcx();
 const r=await run({ocxBin:ocx.bin,roles:[{role:'p-작업자',harness:'codex',screenAt:limitFrom(2,limitScreen(1))}]});
 assert.equal(ocx.calls().length,1);
 assert.ok(!everything(r).includes(SECRET));
 assert.ok(!/sk-proj|token/i.test(JSON.stringify(r.records.filter(e=>e.kind==='ocx-refresh'))));
});

test('30분 안에 다른 역할의 두 번째 한도: 호출 0번, 원장 0줄, 마지막 결과를 경보에 다시 붙인다. 30분이 지나면 다시 부른다',async()=>{
 const ocx=okOcx();
 const r=await run({ocxBin:ocx.bin,stopAt:40,roles:[
  {role:'p-작업자',harness:'codex',screenAt:m=>m>=2&&m<10?limitScreen(1):working(m)},
  {role:'p-작업자2',harness:'codex',screenAt:m=>m>=5&&m<10?limitScreen(2):m>=36?limitScreen(3):working(m)}]});
 const refreshAt=r.records.filter(e=>e.kind==='ocx-refresh').map(e=>(e.at-epoch)/60_000);
 assert.equal(refreshAt.length,2,'처음 1번과 30분 뒤 1번: '+refreshAt);
 assert.ok(refreshAt[1]-refreshAt[0]>=30);
 assert.equal(ocx.calls().length,2);
 const msgs=limitMsgs(r.sent);
 assert.equal(msgs.length,3);
 assert.match(msgs[1][2],/ocx 사용량은 \d+분 전 새로 받음: 5시간 12% 주간 3%/);
});

test('claude 세션의 한도에는 부르지 않는다',async()=>{
 const ocx=okOcx();
 const r=await run({ocxBin:ocx.bin,roles:[{role:'p-작업자',harness:'claude',screenAt:limitFrom(2,limitScreen(1))}]});
 assert.equal(ocx.calls().length,0);
 assert.equal(r.records.filter(e=>e.kind==='ocx-refresh').length,0);
 assert.equal(limitMsgs(r.sent).length,1);
 assert.ok(!/ocx/.test(limitMsgs(r.sent)[0][2]));
});

for(const [name,ocxFor,outcome,exitCode,text] of [
 ['종료 코드 1',()=>fakeOcx('exit 1').bin,'failed',1,/ocx 새로고침 실패\(종료 코드 1\)/],
 ['실행 파일 없음',()=>'/nonexistent/ocx-for-test','missing',null,/ocx 없음/],
 ['숫자 없는 성공',()=>fakeOcx('echo done').bin,'ok',0,/사용량 새로 받음\(숫자 미확인\) — 창 확인/],
 ['새로 받아도 높음',()=>fakeOcx('echo "weekly: 98%"').bin,'ok',0,/새로 받아도 한도\(주간 98%\) — 대체 실행기 고려/],
]){
 test(`ocx ${name}: 기록되고 경보는 그대로 전달된다`,async()=>{
  const r=await run({ocxBin:ocxFor(),roles:[{role:'p-작업자',harness:'codex',screenAt:limitFrom(2,limitScreen(1))}]});
  const lines=r.records.filter(e=>e.kind==='ocx-refresh');
  assert.equal(lines.length,1);
  assert.equal(lines[0].outcome,outcome);
  assert.equal(lines[0].exitCode,exitCode);
  const msgs=limitMsgs(r.sent);
  assert.equal(msgs.length,1);
  assert.match(msgs[0][2],text);
  assert.match(msgs[0][2],/한도 kadan-p-작업자 \(└ Exceeded/,'기존 본문 앞부분은 그대로');
 });
}

test('ocx 시간 초과는 timeout으로 기록하고 끊는다',()=>{
 const ocx=fakeOcx('sleep 30');
 const records=[];
 const refresh=createOcxRefresher({record:e=>records.push(e),env:{KADAN_OCX_BIN:ocx.bin},timeoutMs:3000});
 const result=refresh({entries:[],now:epoch,trigger:{role:'r',session:'s'}});
 assert.equal(result.outcome,'timeout');
 assert.equal(records[0].outcome,'timeout');
 assert.match(ocxAlertLine(result),/ocx 새로고침 시간 초과/);
 // 같은 시각 안의 다음 호출은 부르지 않고 기록한 결과를 쓴다.
 const again=refresh({entries:[],now:epoch+60_000,trigger:{role:'r2',session:'s2'}});
 assert.equal(again.cached,true);
 assert.equal(ocx.calls().length,1);
});

test('출력 숫자 읽기와 경보 문구',()=>{
 assert.deepEqual(parseUsage('hello'),{});
 assert.deepEqual(parseUsage('5-hour limit: 40%\nWeekly limit: 91.4%'),{fiveHour:40,weekly:91});
 assert.match(ocxAlertLine({outcome:'ok',usage:{weekly:3},cached:true,ageMs:7*60_000}),/^ocx 사용량은 7분 전 새로 받음: 주간 3% — 가짜 한도였을 가능성/);
 assert.match(ocxAlertLine({outcome:'ok',usage:{weekly:98}}),/^새로 받아도 한도\(주간 98%\) — 대체 실행기 고려$/);
});

// 검수 1라운드(PR #188) 수정 ------------------------------------------------------------------
const final429=`■ exceeded retry limit, last status: 429 Too Many Requests\n\n›\n gpt-6.1-sol high`;
const refreshes=r=>r.records.filter(e=>e.kind==='ocx-refresh');

test('R1: 최종 429 + 빈 입력창이면 예약 1건과 새로고침 1건, 한도 경보는 그대로 보내지 않는다',async()=>{
 const ocx=okOcx();
 const r=await run({ocxBin:ocx.bin,stopAt:3,roles:[{role:'p-작업자',harness:'codex',screenAt:limitFrom(1,final429)}]});
 assert.equal(r.records.filter(e=>e.kind==='rate-limit-retry'&&e.action==='scheduled').length,1);
 assert.equal(refreshes(r).length,1);
 assert.equal(ocx.calls().length,1);
 assert.equal(limitMsgs(r.sent).length,0,'예약 중인 세션의 한도 경보 억제는 그대로');
 assert.ok(r.prints.some(l=>/ocx 사용량 새로고침: 사용량 새로 받음/.test(l)),'감시 출력에 결과가 남는다');
 assert.ok(r.resumes.length>=1,'재개는 그대로 보낸다');
});

test('R1: Retry-After: 3600 대기 중에도 새로고침 1건',async()=>{
 const ocx=okOcx();
 const r=await run({ocxBin:ocx.bin,stopAt:8,roles:[{role:'p-작업자',harness:'codex',screenAt:limitFrom(1,final429.replace('\n\n›','\nRetry-After: 3600\n\n›'))}]});
 assert.equal(refreshes(r).length,1);
 assert.equal(r.resumes.length,0,'대기 시각 전에는 재개하지 않는다');
});

test('R1: 최종 429에서 claude·kimi 대체 세션은 부르지 않는다',async()=>{
 const ocx=okOcx();
 await run({ocxBin:ocx.bin,roles:[{role:'p-작업자',harness:'claude',screenAt:limitFrom(1,final429)}]});
 assert.equal(ocx.calls().length,0);
});

const restoredAlert=(role,t=0)=>({kind:'alert',id:`disconnect:kadan-${role}:exceeded retry limit|└ Exceeded retry limit, last status: 429 Too Many Requests`,
 alertKind:'한도',level:'AMBER',role,session:'kadan-'+role,delivered:true,recipient:'p-감독',by:'watch',t:stamp(t)});

test('R2: 재시작으로 복원한 한도 경보에 새로고침 기록이 없으면 한 번 부르고, 이후 30분 안에는 0번(경보는 다시 알리지 않는다)',async()=>{
 const ocx=okOcx();
 const r=await run({ocxBin:ocx.bin,stopAt:20,seed:[restoredAlert('p-작업자')],
  roles:[{role:'p-작업자',harness:'codex',screenAt:m=>limitScreen(1)}]});
 assert.equal(refreshes(r).length,1);
 assert.equal(ocx.calls().length,1);
 assert.equal(limitMsgs(r.sent).length,0,'복원된 경보를 다시 알리지 않는다');
});

test('R2: 이미 그 경보 뒤 새로고침 기록이 있으면 0번',async()=>{
 const ocx=okOcx();
 const seed=[restoredAlert('p-작업자'),{kind:'ocx-refresh',by:'watch',provider:'openai',at:epoch+10_000,outcome:'ok',exitCode:0,usage:{weekly:3},t:stamp(0.5)}];
 await run({ocxBin:ocx.bin,stopAt:10,seed,roles:[{role:'p-작업자',harness:'codex',screenAt:m=>limitScreen(1)}]});
 assert.equal(ocx.calls().length,0);
});

test('R4: kimi 대체·다른 model_provider 세션은 0번, 기본 gpt 세션은 1번',async()=>{
 for(const [start,expected] of [
  [{model:'kimi/k3[1m]',cmd:'codex --model kimi/k3[1m]'},0],
  [{model:'kimi-k2.5',cmd:'codex --model kimi-k2.5 -c model_provider="kimi"'},0],
  [{model:'gpt-6.1-sol',cmd:'codex --model gpt-6.1-sol -c model_reasoning_effort=high'},1],
  [{model:'gpt-6.1-sol',cmd:'codex -c model_provider=openai --model gpt-6.1-sol'},1],
  [{},1],
 ]){
  const ocx=okOcx();
  await run({ocxBin:ocx.bin,roles:[{role:'p-작업자',harness:'codex',start,screenAt:limitFrom(2,limitScreen(1))}]});
  assert.equal(ocx.calls().length,expected,JSON.stringify(start));
 }
});

test('R3: 시간 초과 뒤 자식 프로세스까지 끝나고 시험이 띄운 것만 끝난다',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-ocx-kid-'));
 const pidFile=path.join(dir,'kid.pid');
 const ocx=fakeOcx(`sleep 60 &\necho $! > '${pidFile}'\nwait`);
 const refresh=createOcxRefresher({record:()=>{},env:{KADAN_OCX_BIN:ocx.bin},timeoutMs:3000});
 const started=Date.now();
 const result=refresh({entries:[],now:epoch,trigger:{role:'r',session:'s'}});
 const kid=Number(fs.readFileSync(pidFile,'utf8').trim());
 const alive=()=>{try{process.kill(kid,0);return true;}catch{return false;}};
 try{
  assert.equal(result.outcome,'timeout');
  assert.ok(Date.now()-started<10_000);
  assert.ok(kid>1);
  // SIGKILL 직후 종료 반영까지 짧게 기다린다.
  for(let i=0;i<20&&alive();i++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);
  assert.equal(alive(),false,'자식 sleep이 남아 있으면 안 된다');
 }finally{if(alive())process.kill(kid,'SIGKILL');}
});
