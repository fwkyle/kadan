import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDatabase} from '../src/storage.mjs';
import {appendLedger,readLedger} from '../src/ledger.mjs';
import {WatchReports} from '../src/watch-report.mjs';

// 11/20 점검 AI 보고가 부하 때 사라졌다. 보고 명령(watch-report --verdict) 한 번이 원장 전체를 읽는 횟수를 시험으로 고정한다.
// main은 제출 1회 + 완료 확인(receipt) 1회로 2번 읽었다. 목표는 1번이다.
const parents=new Map([['p-작업자','p-감독'],['p-감독','p-슈퍼감독'],['p-슈퍼감독','@user']]);
function fixture() {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-watch-read-count-'));
  createDatabase(home);
  fs.writeFileSync(path.join(home,'storage.json'),JSON.stringify({version:1,backend:'sqlite'}));
  const live=['p-작업자','p-감독','p-슈퍼감독'];
  for(const [i,role] of live.entries())appendLedger({kind:'start',role,session:`kadan-${role}`,panePid:i+1},home);
  appendLedger({kind:'send',role:'p-작업자',taskId:'a'},home);
  const f={home,reads:0,sent:[]};
  f.r=new WatchReports({home,now:()=>Date.now(),
    readCards:()=>[{id:'a',key:'r/a',role:'p-작업자',board:'p',status:'assigned',workType:'execution'}],
    floor:{list:()=>live.map((role,i)=>({session:`kadan-${role}`,pid:i+1}))},
    send:(role,message)=>f.sent.push({role,message}),
    readEntries:()=>{f.reads++;return readLedger(home);}});
  // 호출 기록 만들기(request)의 읽기는 보고 명령 밖이다. 보고 명령 한 번의 읽기만 센다.
  f.submit=(verdict,reason,id=f.r.request({source:'stall',role:'p-작업자',parents}).requestId)=>{
    f.reads=0;const result=f.r.submit(id,verdict,reason);return {id,result,reads:f.reads};
  };
  f.signal=id=>fs.existsSync(path.join(home,'watch-ai',id,'report-complete'));
  return f;
}

test('보고 1건·알림 없음: 원장 전체 읽기는 1회이고 완료 신호 파일이 남는다',()=>{
  const f=fixture();
  const {id,result,reads}=f.submit('입력대기','정상적인 결과 대기');
  assert.equal(reads,1);
  assert.equal(result.accepted,true);assert.equal(result.notify,false);assert.equal(result.duplicate,false);
  assert.equal(f.sent.length,0);
  assert.equal(f.signal(id),true);
  assert.equal(f.r.receipt(id).complete,true);
});

test('알림 있음: 판정·전달 결과는 그대로이고 원장 전체 읽기는 1회, 완료 신호 파일이 남는다',()=>{
  const f=fixture();
  const {id,result,reads}=f.submit('정체','입력 대기에서 다음 작업을 시작하지 않음');
  assert.equal(reads,1);
  assert.equal(result.notify,true);assert.equal(result.recipient,'p-감독');assert.equal(result.delivery,'sent');
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].role,'p-감독');
  assert.equal(f.signal(id),true);
  const receipt=f.r.receipt(id);
  assert.equal(receipt.complete,true);assert.equal(receipt.delivery.delivery,'sent');
});

test('이미 보고된 요청에 다시 보고: 같은 결과(duplicate)이고 읽기는 1회, 전달을 다시 하지 않는다',()=>{
  const f=fixture();
  const first=f.submit('정체','처음 보고');
  const again=f.submit('정체','같은 요청',first.id);
  assert.equal(again.reads,1);
  assert.equal(again.result.duplicate,true);assert.equal(again.result.verdict,'정체');
  assert.equal(f.sent.length,1);
  assert.equal(f.r.receipt(first.id).complete,true);
  // 알림 없는 보고의 중복도 같다.
  const quiet=f.submit('입력대기','정상 대기');
  const quietAgain=f.submit('입력대기','같은 요청',quiet.id);
  assert.equal(quietAgain.reads,1);assert.equal(quietAgain.result.duplicate,true);
  assert.equal(f.signal(quiet.id),true);
});
