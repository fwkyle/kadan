import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {appendLedger,readLedger,readTaskLedger,readMailLedger,readMailboxLedger,readSystemLedger} from '../src/ledger.mjs';
import {createDatabase,writeStorageMarker,appendStream,readStream} from '../src/storage.mjs';
import {validateDomainStreams,projectLedger,ledgerStreams,SLIM_DROPPABLE} from '../src/ledger-domains.mjs';
import {WatchReports} from '../src/watch-report.mjs';
// Why: 읽기에서 큰 본문을 빼도 손상 거절·판정·알림 경로는 줄이기 전과 같아야 한다(PR #171 독립검수 R1~R3).
const mk=mode=>{const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-slim-guard-'));if(mode==='sqlite')createDatabase(home);writeStorageMarker(home,mode);return home;};
const fns={readLedger:[readLedger,undefined],readTaskLedger:[readTaskLedger,'tasks'],readMailLedger:[readMailLedger,'mail'],readMailboxLedger:[readMailboxLedger,'mailbox'],readSystemLedger:[readSystemLedger,'system']};
const cases={
 valid:[{kind:'watch-cycle',_ledgerOrder:1}],
 broken:[{kind:'watch-cycle',_ledgerOrder:1,broken:'corrupt'}],
 orphanCompletion:[{kind:'watch-cycle',_ledgerOrder:1,systemGenerated:'task-completion'}],
 orderZero:[{kind:'watch-cycle',_ledgerOrder:0}],
 orderTrue:[{kind:'watch-cycle',_ledgerOrder:true}],
 orderString:[{kind:'watch-cycle',_ledgerOrder:'1'}],
 orderGap:[{kind:'watch-cycle',_ledgerOrder:2}],
 duplicate:[{kind:'watch-cycle',_ledgerOrder:1},{kind:'watch-cycle',_ledgerOrder:1}],
 reversed:[{kind:'watch-cycle',_ledgerOrder:2},{kind:'watch-cycle',_ledgerOrder:1}],
 bigBody:[{kind:'watch-cycle',_ledgerOrder:1,timing:{a:'x'.repeat(50)},parents:[['a','b']]},{kind:'watch-ai-request',_ledgerOrder:2,requestId:'q',parents:[['a','b']],routes:[['a','b']]}],
 linkMismatch:[{kind:'send',_ledgerOrder:1,role:'qa-worker',taskId:'r/a',mailId:'m',dispatchId:'m'},
  {kind:'dispatch',_ledgerOrder:1,role:'qa-wrong',taskId:'r/a',mailId:'m',dispatchId:'m'}],
 duplicateMail:[{kind:'send',_ledgerOrder:1,mailId:'m'},{kind:'send',_ledgerOrder:2,mailId:'m'}],
};
const stripBig=rows=>rows.map(r=>{if(r?.kind!=='watch-ai-request')return r;const {parents,routes,...rest}=r;return rest;});
for(const mode of ['sqlite'])for(const [name,events] of Object.entries(cases))
test(`손상·순서 사례 ${name} (${mode}): 줄여 읽어도 기준과 같은 결과·같은 오류 메시지`,()=>{
  const home=mk(mode);
  for(const e of events)appendStream(home,e.kind==='dispatch'?'tasks/events.jsonl':e.kind==='send'?'mail/events.jsonl':'system/events.jsonl',e);
  // 기준: 줄이지 않은 원본 스트림을 같은 검증기에 넣는다.
  const full=new Map(Object.values(ledgerStreams).map(s=>[s,readStream(home,s,{optional:true})]));
  let ref;try{ref={ordered:validateDomainStreams(full,[])};}catch(e){ref={error:e.message};}
  for(const [fn,[read,domain]] of Object.entries(fns)){
    let got;try{got=read(home);}catch(e){got={error:e.message};}
    if(ref.error){assert.equal(got.error,ref.error,`${fn}: 기준은 거절`);continue;}
    assert.ok(Array.isArray(got),`${fn}: 기준은 허용`);
    const want=projectLedger({legacy:[],ordered:ref.ordered},domain);
    const norm=domain&&domain!=='system'?x=>x:stripBig;
    assert.deepEqual(got,norm(want),`${fn}: 결과 동일`);
  }
});

test('빼도 되는 필드 허용 목록은 검증기가 읽는 필드와 겹치지 않는다',()=>{
  const src=fs.readFileSync(new URL('../src/ledger-domains.mjs',import.meta.url),'utf8');
  const read=new Set();
  for(const m of src.matchAll(/\b(?:value|row|rows|entry|mail|done|request|send|dispatch|item|history|e|x)\??\.([A-Za-z_]\w*)/g))read.add(m[1]);
  for(const m of src.matchAll(/own\(\s*\w+\s*,\s*'(\w+)'\s*\)/g))read.add(m[1]);
  for(const m of src.matchAll(/\$\.(\w+)/g))read.add(m[1]);
  for(const m of src.matchAll(/taskFields\s*=\s*\[([^\]]*)\]/g))for(const f of m[1].matchAll(/'(\w+)'/g))read.add(f[1]);
  for(const must of ['broken','systemGenerated','_ledgerOrder','kind','mailId','taskId','executionKey'])assert.ok(read.has(must),`추출기가 ${must}를 찾아야 한다`);
  assert.deepEqual(SLIM_DROPPABLE.filter(f=>read.has(f)),[],'검증기가 읽는 필드는 허용 목록에 둘 수 없다');
});

for(const mode of ['sqlite'])
test(`보류 알림 재전송: 실제 감시기처럼 readEntries를 주입해도 원래 수신자에게 간다 (${mode})`,()=>{
  const home=mk(mode),role='qa-worker',boss='qa-routeboss',parents=new Map(),routes=new Map([['qa',boss]]),sent=[];
  const cards=[{id:'a',key:'r/a',role,board:'qa',status:'assigned',workType:'execution'}];
  for(const [i,r] of [role,boss].entries())appendLedger({kind:'start',role:r,session:`kadan-${r}`,panePid:i+1},home);
  appendLedger({kind:'send',role,taskId:'a',board:'qa'},home);
  const options={home,readCards:()=>cards,readWorks:()=>[],floor:{list:()=>[role,boss].map((r,i)=>({session:`kadan-${r}`,pid:i+1}))},
    send:()=>{throw Object.assign(new Error('input hold'),{code:'KADAN_PANE_INPUT_PENDING',delivery:'not-sent'});}};
  const report=new WatchReports(options),req=report.request({source:'stall',role,parents,routes});
  report.submit(req.requestId,'정체','입력 보류');
  const watch=new WatchReports({...options,readEntries:()=>readLedger(home),send:to=>sent.push(to)});
  watch.retryHeld(readLedger(home),parents);
  assert.deepEqual(sent,[boss]);
  assert.equal(readLedger(home).findLast(e=>e.kind==='watch-ai-delivery').delivery,'sent');
});
