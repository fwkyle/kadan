import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildWatchScope,buildSupervisorScope} from '../src/watch-scope.mjs';
import {SupervisorHealth,SUPERVISOR_CHECK_MS,SUPERVISOR_ERROR_MS} from '../src/watch-supervisor-health.mjs';
import {WatchReports,watchResponsibility} from '../src/watch-report.mjs';
import {runWatch} from './helpers/watch-runner.mjs';

const t='2026-09-09T00:00:00.000Z',epoch=Date.parse(t);
const parents=new Map([['worker','boss'],['boss','top'],['top','@user'],['old','@user']]);
const card={id:'task',key:'repo/task',role:'worker',status:'assigned',workType:'execution',title:'대상 생성',activity:'running',board:'p'};
const send={kind:'send',role:'worker',taskId:'task',t};
const starts=['worker','boss','top','old'].map((role,i)=>({kind:'start',role,session:`kadan-${role}`,panePid:i+1,t}));
const entries=[...starts,send];
const work={key:'repo/work',owner:'boss',status:'open',board:'p',executions:[{key:card.key}]};
const seen=screen=>new Map([['kadan-boss',{role:'boss',alive:true,pid:2,expectedPid:2,screen,digest:screen,startedAt:t}]]);
function health(){
 const h=new SupervisorHealth(),scope=buildSupervisorScope([card],entries,parents);
 return {h,scope,check:(now,screen='하위 결과를 기다리는 중',extra={})=>h.select({scope,observations:seen(screen),entries,cards:[card],now:epoch+now,enabled:true,...extra})};
}

test('실제 활성 실행의 감독 사슬(최상위 포함)을 점검하고 옛 슈퍼감독·관리 카드만 남은 판은 제외한다',()=>{
 const scope=buildSupervisorScope([card],entries,parents);
 // 최상위(top, 상위 @user)도 들어간다. 사슬 밖의 old(상위 @user)는 활성 실행이 없어 들어가지 않는다(2026-10-05).
 assert.deepEqual([...scope.sessions],['kadan-boss','kadan-top']);
 assert.deepEqual(scope.entries.map(e=>[e.role,e.subject]),[['boss','worker'],['top','worker']]);
 for(const status of ['done','hold','ready','cancelled'])assert.equal(buildSupervisorScope([{...card,status}],entries,parents).sessions.size,0);
 assert.equal(buildSupervisorScope([{...card,role:'boss',workType:'coordination'}],[...entries,{...send,role:'boss'}],parents).sessions.size,0);
});
test('작업자 결과 대기와 실행 종료 후 업무 최종 확인은 감독 점검을 유지한다',()=>{
 const waiting={...card,activity:'waiting',activityRole:'worker',activityAt:t};
 assert.equal(buildWatchScope([waiting],entries,parents).sessions.size,0);
 assert.equal(buildSupervisorScope([waiting],entries,parents).sessions.size,2);
 const done=[...entries,{...send,kind:'done'}];
 assert.equal(buildSupervisorScope([{...card,status:'done'}],done,parents,[work]).sessions.size,2);
 for(const status of ['hold','done','cancelled']){
  assert.equal(buildSupervisorScope([card],entries,parents,[{...work,status}]).sessions.size,0);
  assert.equal(buildWatchScope([card],entries,parents,[{...work,status}]).sessions.size,0);
 }
 assert.equal(buildSupervisorScope([],starts,parents,[work]).sessions.size,0);
});
test('정상 대기는 1시간 경계에서만 AI 호출 후보가 되고 같은 주기에 다시 부르지 않는다',()=>{
 const f=health();assert.equal(f.check(0).candidate,undefined);
 assert.equal(f.check(SUPERVISOR_CHECK_MS-1).candidate,undefined);
 const result=f.check(SUPERVISOR_CHECK_MS);
 assert.equal(result.candidate.source,'supervisor-health');assert.equal(result.candidate.input.check,'hourly');
 assert.equal(result.candidate.input.responsibilities[0].taskId,'task');
 f.h.started(result.candidate.session,result.candidate.input.current,epoch+SUPERVISOR_CHECK_MS);
 assert.equal(f.check(SUPERVISOR_CHECK_MS+1).candidate,undefined);
 assert.equal(f.check(2*SUPERVISOR_CHECK_MS).candidate.role,'boss');
});
test('연결·압축 오류는 5분 지속 뒤 1회 먼저 확인하고 옛 오류·짧은 실패만으로 호출하지 않는다',()=>{
 const error='Error running remote compact task: stream disconnected before completion: idle timeout waiting for SSE\nReconnecting... 1/2';
 const f=health();f.check(0,error);assert.equal(f.check(SUPERVISOR_ERROR_MS-1,error).candidate,undefined);
 const first=f.check(SUPERVISOR_ERROR_MS,error).candidate;
 assert.equal(first.input.check,'persistent-error');f.h.started(first.session,error,epoch+SUPERVISOR_ERROR_MS);
 assert.equal(f.check(2*SUPERVISOR_ERROR_MS,error).candidate,undefined);
 f.check(3*SUPERVISOR_ERROR_MS,'정상 도구 실행');
 f.check(4*SUPERVISOR_ERROR_MS,error);
 assert.equal(f.check(5*SUPERVISOR_ERROR_MS,error).candidate.role,'boss');
 const brief=health();brief.check(0,error);brief.check(SUPERVISOR_ERROR_MS-1,'정상 실행');
 assert.equal(brief.check(SUPERVISOR_ERROR_MS+1,'정상 실행').candidate,undefined);
});
test('감독 부재·PID 불일치·화면 읽기 실패는 정상 대기나 AI 성공으로 만들지 않는다',()=>{
 for(const observation of [{alive:false},{alive:true,pid:99,expectedPid:2,screen:'x'},{alive:true,pid:2,expectedPid:2,screen:null,screenError:'read failed'}]){
  // 최상위 top도 점검 대상이라 정상 관측을 함께 준다. boss의 이상만 경보여야 한다.
  const top={role:'top',alive:true,pid:3,expectedPid:3,screen:'대기',digest:'대기',startedAt:t};
  const f=health(),r=f.check(0,'',{observations:new Map([['kadan-boss',observation],['kadan-top',top]])});
  assert.equal(r.alerts.length,1);assert.equal(r.alerts[0].role,'boss');assert.equal(r.candidate,undefined);
 }
});
test('감독 AI는 정상 무발송·동일 장애 1회·비활성 전환 뒤 늦은 보고 거절',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-supervisor-report-')),rows=[...entries],sent=[];
 let cards=[card];const works=[];
 const r=new WatchReports({home,floor:{list:()=>starts.map(s=>({session:s.session,pid:s.panePid}))},send:(...x)=>sent.push(x),
  now:()=>epoch,readEntries:()=>rows,readCards:()=>cards,readWorks:()=>works,record:e=>rows.push(e)});
 const request=()=>r.request({source:'supervisor-health',role:'boss',parents});
 r.submit(request().requestId,'입력대기','정당한 결과 대기');assert.equal(sent.length,0);
 r.submit(request().requestId,'응답장애','연결 재시도가 지속됨');
 r.submit(request().requestId,'응답장애','같은 장애');assert.equal(sent.length,1);assert.equal(sent[0][0],'top');
 const later=request();cards=[];
 assert.equal(r.submit(later.requestId,'응답장애','늦은 보고').accepted,false);r.retire(rows,cards,parents,works);
 assert.equal(sent.length,1);assert.equal(request(),null);
});
test('새 보고는 완료 대기를 죽음으로 접수하지 않고 실행완료로 기록한다',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-completion-report-')),rows=[...entries],sent=[];
 const r=new WatchReports({home,floor:{list:()=>[]},send:(...x)=>sent.push(x),now:()=>epoch,readEntries:()=>rows,readCards:()=>[card],readWorks:()=>[],record:e=>rows.push(e)});
 const request=r.request({source:'stall',role:'worker',parents});
 assert.throws(()=>r.submit(request.requestId,'죽음','DONE 후 입력 프롬프트'),/실행완료/);
 assert.equal(rows.filter(e=>e.kind==='watch-ai-report').length,0);
 assert.equal(r.submit(request.requestId,'실행완료','현재 실행을 마치고 새 입력을 기다림').notify,false);
 assert.deepEqual(sent,[]);
});

test('실제 감시 루프가 감독을 1시간마다 호출하고 자원 경고·해제 우편을 보내지 않는다', async () =>{
 let minute=0;const stop=Error('fixture end'),calls=[],messages=[],records=[];
 const oldLoad=os.loadavg;os.loadavg=()=>[0,0,0];
 try {await assert.rejects(()=>runWatch({floor:{list:()=>starts.map(s=>({session:s.session,pid:s.panePid})),read:session=>`${session} 정상 대기`},
  readEntries:()=>entries,readCards:()=>minute<62?[{...card,activity:'waiting',activityRole:'worker',activityAt:t}]:[],
  parents,superRole:'old',routes:new Map(),readWorks:()=>[],intervalMs:60000,stallN:2,now:()=>epoch+minute*60000,
  judgeCmd:'fake',ai:{reports:{retire:()=>{}},run:c=>{calls.push([minute,c]);return {ok:true};}},sendAlert:(...x)=>messages.push(x),record:e=>records.push(e),print:()=>{},
  spawn:cmd=>{if(cmd==='sleep'){if(++minute===64)throw stop;return {status:0,stdout:''};}
   if(cmd==='memory_pressure')return {status:0,stdout:`System-wide memory free percentage: ${minute<63?10:80}%`};
   if(cmd==='sysctl')return {status:0,stdout:'used = 0M'};return {status:0,stdout:''};},
 }),e=>e===stop);}finally{os.loadavg=oldLoad;}
 // 최상위 top도 1시간 점검을 받는다(2026-10-05). 한 주기에 한 명씩이라 boss 다음 주기에 온다.
 assert.deepEqual(calls.map(([m,c])=>[m,c.role,c.source]),[[60,'boss','supervisor-health'],[61,'top','supervisor-health']]);
 assert.deepEqual(messages,[]);
 assert(!records.some(e=>e.alertKind==='자원'));
});

test('같은 실행 완료 화면은 AI 재호출을 생략하지만 다른 미완료 실행과 화면 변화는 다시 확인한다', async () =>{
 for(const mode of ['complete','other-execution','changed-screen','wrong-marker']){
  let cycle=0;const stop=Error('end'),calls=[],rows=[...entries];
  const cards=[card,...(mode==='other-execution'?[{...card,id:'second',key:'repo/second'}]:[])];
  if(mode==='other-execution')rows.push({...send,taskId:'second'});
  const load=os.loadavg;os.loadavg=()=>[0,0,0];
  try{await assert.rejects(()=>runWatch({floor:{list:()=>starts.map(s=>({session:s.session,pid:s.panePid})),read:()=>`KADAN:DONE ${mode==='wrong-marker'?'old-task':'task'} ok\n${'이전 실행의 정상 출력\n'.repeat(8)}Ask Codex to do anything${mode==='changed-screen'&&cycle>=3?'\n새 결과':''}`},
   readEntries:()=>rows,readCards:()=>cards,parents,routes:new Map(),superRole:'old',intervalMs:60000,stallN:1,now:()=>epoch+cycle*60000,
   judgeCmd:'fake',judgeCooldownMs:0,sendAlert:()=>{},record:e=>rows.push(e),print:()=>{},
   ai:{reports:{retire:()=>{}},run:c=>{calls.push(cycle);rows.push({kind:'watch-ai-report',key:'fixture',accepted:true,source:'stall',role:'worker',session:'kadan-worker',taskId:null,verdict:'실행완료',responsibility:watchResponsibility('worker',cards,rows,parents),observationDigest:c.observationDigest});return {ok:true};}},
   spawn:cmd=>{if(cmd==='sleep'&&++cycle===40)throw stop;return {status:0,stdout:cmd==='memory_pressure'?'System-wide memory free percentage: 80%':cmd==='sysctl'?'used = 0M':''};},
  }),e=>e===stop);}finally{os.loadavg=load;}
  assert.deepEqual(calls,mode==='changed-screen'?[1,4]:mode==='complete'?[1]:[1,31]);
 }
});
