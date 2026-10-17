import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDatabase} from '../src/storage.mjs';
import {appendLedger,readLedger} from '../src/ledger.mjs';
import {WatchReports,watchReportCommand} from '../src/watch-report.mjs';
import {WatchAI} from '../src/watch-ai.mjs';
import {formatAlertBody} from '../src/watch-alert-body.mjs';

const parents=new Map([['p-작업자','p-감독'],['p-감독','@user']]);
function fixture() {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-report-id-'));
 createDatabase(home);fs.writeFileSync(path.join(home,'storage.json'),JSON.stringify({version:1,backend:'sqlite'}));
 const f={home,at:Date.now(),cards:[{id:'a',key:'r/a',role:'p-작업자',board:'p',status:'assigned',workType:'execution'}],sent:[]};
 for(const [i,role] of ['p-작업자','p-감독'].entries())appendLedger({kind:'start',role,session:`kadan-${role}`,panePid:i+1},home);
 appendLedger({kind:'send',role:'p-작업자',taskId:'a'},home);
 f.options={home,now:()=>f.at,readCards:()=>f.cards,
  floor:{list:()=>['p-작업자','p-감독'].map((role,i)=>({session:`kadan-${role}`,pid:i+1}))},send:(role,message)=>f.sent.push({role,message})};
 f.r=new WatchReports(f.options);
 f.request=()=>f.r.request({source:'stall',role:'p-작업자',parents});
 f.reports=()=>readLedger(home).filter(e=>e.kind==='watch-ai-report');
 return f;
}
const flags={verdict:'입력대기',reason:'정상 결과 대기'};
const run=(f,args,extra={})=>watchReportCommand(args,flags,{...f.options,env:{},cwd:os.tmpdir(),...extra});

test('ID 인자 없음 + 환경 있음: 기록되고 출처는 env',()=>{
 const f=fixture(),job=f.request();
 const out=run(f,[],{env:{KADAN_JUDGE_REQUEST:job.requestId}});
 assert.equal(out.requestIdSource,'env');assert.equal(out.requestId,job.requestId);assert.equal(f.reports().length,1);
});

test('ID 인자 없음 + 환경 없음 + 점검 폴더: 기록되고 출처는 cwd',()=>{
 const f=fixture(),job=f.request();
 const out=run(f,[],{cwd:job.evidencePath});
 assert.equal(out.requestIdSource,'cwd');assert.equal(f.reports().length,1);
});

test('상관없는 작업 폴더면 오류이고 기록은 0건',()=>{
 const f=fixture();f.request();
 assert.throws(()=>run(f,[]),/호출ID를 알 수 없습니다/);
 assert.equal(f.reports().length,0);
});

test('watch-ai/<id> 모양이어도 원장에 그 요청이 없으면 오류',()=>{
 const f=fixture(),fake=path.join(f.home,'watch-ai','11111111-2222-4333-8444-555555555555');
 fs.mkdirSync(fake,{recursive:true});
 assert.throws(()=>run(f,[],{cwd:fake}),/호출ID를 알 수 없습니다/);
 assert.equal(f.reports().length,0);
});

test('실제 사고처럼 틀린 ID 인자는 하네스 값이 이기고 불일치가 남는다',()=>{
 const f=fixture(),job=f.request();
 const typo=job.requestId.replace(/^(.{9})(.)/,(_,a,c)=>a+(c==='e'?'f':'e'));
 assert.notEqual(typo,job.requestId);
 const out=run(f,[typo],{env:{KADAN_JUDGE_REQUEST:job.requestId}});
 assert.equal(out.requestId,job.requestId);assert.equal(out.requestIdSource,'env');assert.equal(out.idMismatch,true);
 const [saved]=f.reports();assert.equal(saved.idMismatch,true);assert.equal(saved.requestId,job.requestId);
 const viaCwd=f.request();
 assert.equal(run(f,[typo],{cwd:viaCwd.evidencePath}).requestIdSource,'cwd');
});

test('하네스 값이 없으면 넘긴 ID를 쓰고 출처는 arg, 맞는 ID도 불일치가 아니다',()=>{
 const f=fixture(),job=f.request();
 const out=run(f,[job.requestId]);
 assert.equal(out.requestIdSource,'arg');assert.equal(out.idMismatch,undefined);
 const second=f.request();
 assert.equal(run(f,[second.requestId],{env:{KADAN_JUDGE_REQUEST:second.requestId}}).idMismatch,undefined);
});

test('도움말과 인자 검사는 그대로다',()=>{
 const f=fixture();
 assert.match(watchReportCommand([],{},f.options),/호출ID는 생략하면/);
 assert.throws(()=>watchReportCommand(['a','b'],flags,f.options),/호출ID\(생략 가능\)/);
});

test('프롬프트에 요청 ID가 없고, 가짜 판정기 왕복은 reported',async()=>{
 const f=fixture();let prompt=null;
 const ai=new WatchAI({...f.options,spawn:(_cmd,options)=>{
  prompt=options.input;
  watchReportCommand([],flags,{...f.options,env:options.env,cwd:options.env.KADAN_JUDGE_DIR});
  return {status:0,stdout:''};
 }});
 const result=await ai.run({judgeCmd:'fake',source:'stall',role:'p-작업자',parents,input:{}});
 assert.equal(result.reason,'reported');
 assert.equal(result.verdict,'입력대기');
 assert.ok(!prompt.includes(result.requestId));
 assert.match(prompt,/요청 ID는 쓰지 마라/);
 assert.match(prompt,/watch-report'? --verdict/);
 const input=fs.readFileSync(path.join(f.home,'watch-ai',result.requestId,'input.txt'),'utf8');
 assert.ok(!input.includes(result.requestId));
});

test('감시AI오류 알림은 사유마다 다섯 가지를 쉬운 말로 보여 주고 내부어를 쓰지 않는다',()=>{
 const base={kind:'감시AI오류',role:'비서',source:'supervisor-health'};
 const expected={
  timeout:['시간 안에 답이 없었음','없음, 정해진 주기에 다시 점검함'],
  'report-missing':['결과를 기록하지 못함','없음, 정해진 주기에 다시 점검함'],
  'call-failed':['점검 AI를 부르지 못함','반복되면 점검 기록 폴더 확인'],
  network:['인터넷 연결이 3번 연속 안 돼','인터넷 연결 확인'],
  'report-incomplete':['알림 전달 기록이 끝나지 않음','반복되면 점검 기록 폴더 확인'],
  'report-error':['결과를 저장하는 중 오류','반복되면 점검 기록 폴더 확인'],
 };
 for(const [reason,[happened,todo]] of Object.entries(expected)){
  const body=formatAlertBody({...base,reason});
  for(const part of ['감시기의 점검 AI가','비서 응답 상태','점검에 실패',happened,'비서에 문제가 있는지는 모름(점검 도구 문제)',`할 일: ${todo}`])
   assert.ok(body.includes(part),`${reason}: ${part} / ${body}`);
  assert.ok(!/감독 관찰AI|작업 감시AI|작업 상태 판정과 별개|점검 필요/.test(body),body);
  assert.ok(!body.includes('점검 AI 판단'));
 }
 assert.match(formatAlertBody({...base,source:'progress',role:'worker',reason:'timeout'}),/worker 작업 진행 점검/);
});

test('report-incomplete에 판정이 있으면 점검 AI 판단이 붙는다',()=>{
 const base={kind:'감시AI오류',role:'비서',source:'supervisor-health',reason:'report-incomplete'};
 assert.match(formatAlertBody({...base,judgeVerdict:'실행완료'}),/점검 AI 판단: 실행완료\(정상으로 보임\)$/);
 assert.match(formatAlertBody({...base,judgeVerdict:'정체'}),/점검 AI 판단: 정체\(문제 판정은 따로 보고됨\)$/);
});
