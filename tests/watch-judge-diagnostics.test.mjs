import test from 'node:test';
import assert from 'node:assert/strict';
import {executeJudgeResult, judgeStallAlerts} from '../src/watch-judge.mjs';
import {formatAlertBody, deliverResolution} from '../src/watch-runner.mjs';
import {dedupAlerts} from '../src/watch.mjs';

const alert={id:'stall:kadan-p-감독',session:'kadan-p-감독',role:'p-감독',kind:'정체',level:'AMBER'};
const fake = result => executeJudgeResult('fake','input screen',()=>result);

test('16:05 실제 호칭 출력은 AI 모름이 아니라 응답 형식 오류로 구분한다',()=>{
 const r=fake({status:0,stdout:'[감시] 입력대기'});
 assert.equal(r.verdict,'모름');assert.equal(r.reason,'invalid-output');assert.equal(r.response,'[감시] 입력대기');
 assert.equal(fake({status:0,stdout:'입력대기'}).verdict,'입력대기');
 assert.equal(fake({status:0,stdout:'모름'}).reason,'ai-unknown');
});
test('호출 실패·시간초과·잘못된 응답을 구분하며 자유 응답과 오류 원문은 기록하지 않는다',()=>{
 assert.equal(fake({status:1,stdout:'입력대기',stderr:'private error'}).reason,'call-failed');
 assert.equal(fake({error:{code:'ETIMEDOUT'},status:null}).reason,'timeout');
 assert.equal(executeJudgeResult('fake','input',()=>{throw Error('private error');}).reason,'call-failed');
 const r=fake({status:0,stdout:'private answer',stderr:'private error'});
 assert.equal(r.response,null);assert.match(r.outputDigest,/^[a-f0-9]{64}$/);
 assert(!JSON.stringify(r).includes('private'));
});
test('실제 호출마다 역할·종료코드·모델·증거경로를 기록하고 냉각시간에는 중복기록하지 않는다',()=>{
 const records=[],judgeStates=new Map();
 const args={alerts:[alert],observations:new Map([[alert.session,{screen:'waiting'}]]),judgeStates,judgeCmd:'fake',cooldownMs:300000,record:r=>records.push(r),spawn:()=>({status:0,stdout:'[감시] 입력대기',stderr:'KADAN_JUDGE_LOG_DIR=/tmp/kadan-judge.test\nKADAN_JUDGE_MODEL=example/judge-model\n'})};
 const a=judgeStallAlerts({...args,now:1});judgeStallAlerts({...args,now:2});
 assert.equal(records.length,1);assert.equal(records[0].role,'p-감독');assert.equal(records[0].reason,'invalid-output');
 assert.equal(records[0].exitCode,0);assert.equal(records[0].model,'example/judge-model');assert.equal(records[0].evidencePath,'/tmp/kadan-judge.test');
 assert.match(formatAlertBody(a[0]),/감시AI 응답 형식 오류/);
 // 원장 실패가 감시 판단 자체를 삼키지 않는다.
 const old=console.error;console.error=()=>{};
 try{assert.equal(judgeStallAlerts({...args,judgeStates:new Map(),now:3,record:()=>{throw Error('write');}})[0].judgeReason,'invalid-output');}finally{console.error=old;}
});
test('경보 해제는 정상 또는 완료로 단정하지 않는 쉬운 문구로 감시 출력에만 남기고 우편은 보내지 않는다(2026-10-05)',()=>{
 const sent=[],records=[],printed=[];
 deliverResolution({alert:{...alert,kind:'모름'},recipients:new Map([[alert.id,'상위']]),cycleAt:0,sendAlert:(role,text)=>sent.push({role,text}),record:e=>records.push(e),print:l=>printed.push(l)});
 assert.deepEqual(sent,[]);assert.match(printed[0],/상태 확인 필요 - 해소됨/);assert.match(printed[0],/작업 완료를 뜻하지 않음/);assert(!printed[0].includes('해소 모름'));
 assert.equal(records[0].resolved,true);assert.equal(records[0].recipient,'상위');assert.equal(records[0].delivered,false);
});
test('모름 원인이 바뀐 경우만 새 설명을 알린다',()=>{
 const a={...alert,kind:'모름',judgeVerdict:'모름',judgeReason:'invalid-output'};
 assert.equal(dedupAlerts([a],[a]).notify.length,0);
 assert.equal(dedupAlerts([a],[{...a,judgeReason:'timeout'}]).notify.length,1);
});
