import test from 'node:test';
import assert from 'node:assert/strict';
import {RateLimitRetry,terminal429} from '../src/watch-rate-limit.mjs';
const failure='■ exceeded retry limit, last status: 429 Too Many Requests';
const screen=n=>`${Array(n).fill(failure).join('\n')}\n\n›\n kimi/k3[1m] max`;
function fixture() {
 const entries=[],sent=[];
 let now=0,seen={role:'worker',alive:true,pid:1,expectedPid:1,startedAt:'start',screen:screen(1)};
 let tasks=[{role:'worker',taskId:'task'}],fresh=()=>true;
 const opts={record:e=>entries.push(e),resume:(...args)=>sent.push(args)};
 return {entries,sent,seen,setTime:n=>now=n,setTasks:t=>tasks=t,setFresh:f=>fresh=f,
  tick:()=>new RateLimitRetry(opts).tick({entries,now,tasks,observations:new Map([['kadan-worker',seen]]),fresh}),opts};
}
test('1/2/3 minutes, persistent ledger, exhausted after three, no duplicate stale-screen send',()=>{
 const f=fixture(); f.tick();assert.equal(f.entries.at(-1).dueAt,60000);
 f.setTime(59999);f.tick();assert.equal(f.sent.length,0);
 f.setTime(60000);f.tick();assert.equal(f.sent.length,1);
 f.setTime(61000);f.tick();assert.equal(f.sent.length,1);
 f.seen.screen=screen(2);f.tick();assert.equal(f.entries.at(-1).dueAt,181000);
 f.setTime(181000);f.tick();assert.equal(f.sent.length,2);
 f.seen.screen=screen(3);f.tick();assert.equal(f.entries.at(-1).dueAt,361000);
 f.setTime(361000);f.tick();assert.equal(f.sent.length,3);
 f.seen.screen=screen(4);f.setTasks([{role:'worker',taskId:'new-task'}]);f.tick();
 assert.equal(f.entries.filter(e=>e.action==='scheduled').length,3);
 assert.equal(f.sent.length,3);
});
test('only final terminal 429 and empty prompt, not ordinary tool output/quote/busy/user input',()=>{
 for(const s of ['HTTP 429\n›',`› ${failure}\n›`,`${failure}\nWorking (1s • esc to interrupt)\n›`,`${failure}\n› stop`,`${failure}\nReconnecting...\n›`,`${failure}\nKADAN:DONE task ok\n›`]) assert.equal(terminal429(s,0),null,s);
 assert(terminal429(screen(1),0));
});
test('server retry after seconds and date are honored, hard quotas excluded',()=>{
 const f=fixture();f.seen.screen=`${failure}\nRetry-After: 300\n›`;f.tick();assert.equal(f.entries.at(-1).dueAt,300000);
 assert.equal(terminal429(`${failure}\nRetry-After: Thu, 01 Jan 1970 00:05:00 GMT\n›`,0).afterMs,300000);
 for(const s of ['insufficient_quota','daily quota exceeded','RPD','billing_hard_limit','credits exhausted'])
  assert.equal(terminal429(`${failure}\n${s}\n›`,0).blocked,true);
});
test('hold, done, waiting or task change cancels; different PID never resumes',()=>{
 for(const mode of ['scope','busy','task','pid','fresh','mail']) {
  const f=fixture();f.tick();f.setTime(60000);
  if(mode==='scope')f.setTasks([]);
  if(mode==='busy')f.seen.screen='Working (2s • esc to interrupt)\n›';
  if(mode==='task')f.setTasks([{role:'worker',taskId:'different'}]);
  if(mode==='pid')f.seen.pid=2;
  if(mode==='fresh')f.setFresh(()=>false);
  if(mode==='mail')f.entries.push({kind:'send',role:'worker',t:new Date(1000).toISOString()});
  f.tick();assert.equal(f.sent.length,0,mode);
 }
});
test('delivery failure consumes attempt, does not resend even on a new error',()=>{
 const f=fixture();f.opts.resume=()=>{throw Error('ambiguous send')};f.tick();f.setTime(60000);f.tick();
 assert.equal(f.entries.at(-1).action,'delivery-failed');
 f.seen.screen=screen(2);f.tick();assert.equal(f.entries.filter(e=>e.action==='attempt').length,1);
});
test('write-ahead record failure prevents sending',()=>{
 const f=fixture();f.tick();f.setTime(60000);f.opts.record=()=>{throw Error('ledger unavailable')};
 assert.throws(()=>f.tick(),/ledger unavailable/);assert.equal(f.sent.length,0);
});
test('ambiguous multiple active tasks never resume',()=>{
 const f=fixture();f.setTasks([{role:'worker',taskId:'a'},{role:'worker',taskId:'b'}]);f.tick();assert.equal(f.entries.length,0);
});

test('watch cycle schedules/resumes with fresh ownership and stops when card becomes hold',async()=>{
 const {runWatch}=await import('../src/watch-runner.mjs');
 const controller=new AbortController();let now=0,cycle=0;
 const role='worker',session='kadan-worker',records=[],resumes=[],alerts=[];
 const card={id:'task',key:'repo/task',role,status:'assigned',workType:'execution'};
 const entries=[{kind:'start',role,session,panePid:1,t:'1970-01-01T00:00:00Z'},
  {kind:'send',role,taskId:'task',t:'1970-01-01T00:00:00Z'}];
 await runWatch({floor:{list:()=>[{session,pid:1,alive:true}],read:()=>screen(cycle>=2?2:1)},
  readEntries:()=>entries,readCards:()=>[card],readWorks:()=>[],
  record:e=>{records.push(e);entries.push({...e,t:new Date(now).toISOString()});},
  resume429:(...args)=>resumes.push(args),sendAlert:(...args)=>alerts.push(args),
  intervalMs:60000,stallN:100,routes:new Map(),superRole:'boss',now:()=>now,
  spawn:()=>({status:0,stdout:String(process.pid)}),signal:controller.signal,print:()=>{},
  sleep:async()=>{cycle++;now+=60000;if(cycle===3)card.status='hold';if(cycle===4)controller.abort();}});
 assert.equal(resumes.length,1);
 assert.equal(records.filter(e=>e.kind==='rate-limit-retry'&&e.action==='scheduled').length,2);
 assert(records.some(e=>e.kind==='rate-limit-retry'&&e.action==='cancelled'));
 assert(!alerts.some(([,message])=>message.includes('한도')));
});


test('mailbox completion is stored mail, not fresh terminal input for a pending 429 resume',()=>{
 const f=fixture();f.tick();
 f.entries.push({kind:'send',role:'worker',by:'reviewer',transport:'mailbox',completion:true,
  replyFinal:true,systemGenerated:'task-completion',executionKey:'repo/review',t:new Date(1000).toISOString()});
 f.setTime(30000);f.tick();
 assert.equal(f.entries.filter(e=>e.action==='scheduled').length,1);
 assert.equal(f.entries.filter(e=>e.action==='cancelled').length,0);
 f.setTime(60000);f.tick();assert.equal(f.sent.length,1);
 assert.equal(f.entries.filter(e=>e.action==='scheduled').length,1);
});
