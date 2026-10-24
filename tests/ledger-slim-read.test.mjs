import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {appendLedger,readLedger,readSystemLedger,readTaskLedger,readMailboxLedger,readWatchRequest} from '../src/ledger.mjs';
import {createDatabase,writeStorageMarker,readStream,appendStream} from '../src/storage.mjs';
import {cycleReads} from '../src/watch-reads.mjs';
// Why: 감시AI 호출 기록의 관계표(parents·routes)가 시스템 영역의 2/3를 차지해 상태 읽기마다 힙을 채웠다.
const setup=()=>{const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-slim-'));createDatabase(home);writeStorageMarker(home,'sqlite');return home;};
const parents=Array.from({length:50},(_,i)=>[`c${i}`,`p${i%3}`]);
const request={kind:'watch-ai-request',by:'watch',requestId:'req-1',role:'w',taskId:'r/a',parents,routes:parents,hierarchyPath:null};

test('상태 읽기는 감시 호출 기록의 큰 필드를 빼고, 단건 조회와 원장 원본은 그대로다',()=>{
  const home=setup();
  appendLedger({kind:'plan',role:'w',taskId:'r/a'},home);
  appendStream(home,'system/events.jsonl',{...request,_ledgerOrder:2}); // 과거 본문 포함 원본
  appendLedger({kind:'watch-cycle',by:'watch',timing:{x:'y'.repeat(100)}},home);
  const slim=readLedger(home).find(e=>e.kind==='watch-ai-request');
  assert.equal(slim.requestId,'req-1');assert.ok(!('parents' in slim)&&!('routes' in slim));
  assert.equal(readSystemLedger(home).find(e=>e.kind==='watch-ai-request').parents,undefined);
  assert.deepEqual(readWatchRequest(home,'req-1').parents,parents,'단건 조회는 원본을 준다');
  assert.equal(readWatchRequest(home,'없음'),null);
  assert.deepEqual(readStream(home,'system/events.jsonl').find(e=>e.kind==='watch-ai-request').routes,parents,'저장 원본은 그대로');
  assert.deepEqual(readTaskLedger(home).map(e=>e.kind),['plan']);
  assert.ok(readMailboxLedger(home).every(e=>e.kind!=='watch-cycle'),'우편 조회에는 감시 사건이 나오지 않는다');
});

test('주기가 끝나면 재사용 자료를 놓아 다음 주기 시작까지 사본을 쥐지 않는다',()=>{
  let raw=0;const reads=cycleReads({readEntries:()=>[++raw],version:()=>1});
  reads.readEntries();reads.end();assert.deepEqual(reads.readEntries(),[2]);
});
