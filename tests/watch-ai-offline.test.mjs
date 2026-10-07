// 감시 AI가 맥북 잠자기·인터넷 없음 때문에 실패하면 사용자에게 알리지 않는다(2026-10-07 [kyle]).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const callProcess=path.join(root,'src/watch-call-process.mjs');

test('호출 중 프로세스가 멈췄다 깨어나면(잠자기) 시간 초과가 아니라 slept로 끝낸다',async()=>{
 const child=spawn(process.execPath,[callProcess,'sleep 5','4000'],{env:{...process.env,KADAN_JUDGE_SLEEP_GAP_MS:'300'},stdio:['pipe','pipe','pipe','ipc']});
 let stderr='';child.stderr.on('data',d=>{stderr+=d;});child.stdin.end();
 await new Promise(r=>setTimeout(r,200));
 process.kill(child.pid,'SIGSTOP');
 await new Promise(r=>setTimeout(r,700));
 process.kill(child.pid,'SIGCONT');
 const code=await new Promise(r=>child.on('close',r));
 assert.match(stderr,/KADAN_JUDGE_SLEPT=1/);assert.doesNotMatch(stderr,/KADAN_JUDGE_TIMEOUT=1/);assert.equal(code,143);
});

test('깨어 있는 동안의 시간 초과는 그대로 timeout이다',()=>{
 const r=spawnSync(process.execPath,[callProcess,'sleep 5','300'],{encoding:'utf8',input:''});
 assert.match(r.stderr,/KADAN_JUDGE_TIMEOUT=1/);assert.doesNotMatch(r.stderr,/KADAN_JUDGE_SLEPT=1/);assert.equal(r.status,124);
});

test('watch-judge.sh는 주소를 못 찾은 실패만 인터넷 없음으로 표시한다',()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-judge-offline-'));
 const bin=path.join(tmp,'bin'),home=path.join(tmp,'home');fs.mkdirSync(bin);fs.mkdirSync(home);
 const run=message=>{
  const dir=fs.mkdtempSync(path.join(tmp,'call-'));
  fs.writeFileSync(path.join(bin,'codex'),`#!/bin/bash\necho '${message}'\nexit 1\n`,{mode:0o755});
  return spawnSync('bash',[path.join(root,'scripts/watch-judge.sh')],{encoding:'utf8',input:'p',
   env:{...process.env,PATH:`${bin}:${process.env.PATH}`,KADAN_JUDGE_DIR:dir,KADAN_HOME:home,KADAN_JUDGE_MODEL:'m'}});
 };
 const offline=run('ERROR: unexpected status 502 Bad Gateway: Provider unreachable: getaddrinfo ENOTFOUND api.example.ai');
 assert.equal(offline.status,1);assert.match(offline.stderr,/KADAN_JUDGE_NETWORK=1/);
 const other=run('ERROR: model not found');
 assert.equal(other.status,1);assert.doesNotMatch(other.stderr,/KADAN_JUDGE_NETWORK=1/);
});

// 작업자가 멈춘 화면을 두고 감시 AI를 부르는 순회. 순회 간격 10분이고, 멈춤 확인(stall) 호출만 results 순서대로 답한다
// (다른 호출은 보고 완료). gapAt번째 멈춤 확인 뒤 한 번 1시간을 건너뛰어 잠자기를 흉내 내고, 마지막 결과를 처리한 순회에서 멈춘다.
async function watchWith(results,{gapAt=null}={}){
 const {runWatch}=await import('../src/watch-runner.mjs');
 const controller=new AbortController();let now=0,cycle=0,gapped=false,lastAt=null;
 const role='worker',session='kadan-worker',records=[],prints=[],calls=[];
 const card={id:'task',key:'repo/task',role,status:'assigned',workType:'execution',activity:'running'};
 const entries=[{kind:'start',role,session,panePid:1,t:'1970-01-01T00:00:00Z'},{kind:'send',role,taskId:'task',t:'1970-01-01T00:00:00Z'}];
 await runWatch({floor:{list:()=>[{session,pid:1,alive:true}],read:()=>'멈춘 화면'},
  readEntries:()=>entries,readCards:()=>[card],readWorks:()=>[],
  record:e=>{records.push(e);entries.push({...e,t:new Date(now).toISOString()});},
  sendAlert:()=>{},sendQueueEnter:()=>({keyDelivery:'sent'}),
  judgeCmd:'fake-judge',judgeCooldownMs:1000,
  ai:{run:async o=>{
   if(o.source!=='stall'||calls.length>=results.length)return {ok:true,reason:'reported'};
   const reason=results[calls.length];calls.push(reason);if(calls.length===results.length)lastAt=cycle;return {ok:reason==='reported',reason};
  },reports:{retire:()=>{}}},
  intervalMs:600_000,stallN:1,routes:new Map(),superRole:'boss',now:()=>now,
  spawn:()=>({status:0,stdout:String(process.pid)}),signal:controller.signal,print:m=>prints.push(String(m)),
  sleep:async()=>{cycle++;now+=calls.length===gapAt&&!gapped?(gapped=true,3_600_000):600_000;if(lastAt!=null&&cycle>lastAt+3||cycle>=200)controller.abort();}});
 assert.equal(calls.length,results.length,'멈춤 확인 호출 수');
 return {alerts:records.filter(e=>e.kind==='alert'&&e.alertKind==='감시AI오류'&&!e.resolved),prints};
}

test('인터넷 없음은 깨어 있는 동안 3번 이어질 때만 알리고, 잠자기는 세지 않는다',async()=>{
 assert.equal((await watchWith(['network','network'])).alerts.length,0);
 assert.equal((await watchWith(['network','network','reported','network'])).alerts.length,0,'성공하면 다시 센다');
 const three=await watchWith(['network','network','network']);
 assert.equal(three.alerts.length,1);
 assert.ok(three.prints.some(m=>m.includes('인터넷 연결 없음 3회 연속')),three.prints.join('\n'));
 assert.equal((await watchWith(['slept','slept','slept','slept'])).alerts.length,0);
 // 두 번 실패한 뒤 맥북이 잠들었다 깨면 세던 횟수를 버린다 — 깬 뒤 한 번 더 실패해도 알리지 않는다.
 assert.equal((await watchWith(['network','network','network'],{gapAt:2})).alerts.length,0);
 // 다른 호출 실패는 예전처럼 바로 알린다.
 assert.equal((await watchWith(['call-failed'])).alerts.length,1);
});
