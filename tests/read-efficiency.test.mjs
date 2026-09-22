import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CardStore} from '../src/card-store.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {createDatabase,writeStorageMarker,appendStream,transaction} from '../src/storage.mjs';
import {readLedgerState} from '../src/ledger-domains.mjs';
import {appendLedger,readLedger} from '../src/ledger.mjs';
import {guardedSend} from '../src/cli.mjs';
import {operationsFlowSummaries} from '../src/operations-flow.mjs';
import {composeRoleInstructions} from '../src/role-instructions.mjs';

function setup(mode){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-read-efficiency-'));
 if(mode==='sqlite'){createDatabase(home);writeStorageMarker(home,mode);}
 const store=new CardStore(home),card=store.create({repo:'repo',id:'task',repoPath:home,body:'# 원문'});
 return {home,store,card};
}
for(const mode of ['jsonl','sqlite']){
 test(`${mode}: 요약은 본문을 읽지 않고 최신 상태·주소·결과 경로를 보존한다`,()=>{
  const {home,store,card}=setup(mode);
  store.update(card.key,{status:'hold'},{revision:1,note:'보류'});
  const expected=store.list().map(({body,history,...metadata})=>metadata);
  const original=fs.readFileSync;let bodyReads=0;
  fs.readFileSync=function(file,...args){if(String(file).endsWith('/card.md')){bodyReads++;throw Error('목록에서 본문 조회 금지');}return original.call(this,file,...args);};
  try{
   assert.deepEqual(store.listSummaries(),expected);
   const result=composeRoleInstructions({home,role:'reader',profile:'worker',message:'일반 우편'});
   assert.equal(result.metadata.profile,'worker');assert.equal(bodyReads,0);
  }finally{fs.readFileSync=original;}
  assert.equal(store.get(card.key).body,'# 원문');assert.equal(store.get(card.key).history.length,2);
 });
 test(`${mode}: 최신 상태가 정상이더라도 과거 순번 손상을 요약에서 숨기지 않는다`,()=>{
  const {home,store,card}=setup(mode),{history,body,path:bodyPath,resultPath,evidenceDir,...entry}=card;
  appendStream(home,`cards/${card.key}/events.jsonl`,{...entry,revision:'2'});
  appendStream(home,`cards/${card.key}/events.jsonl`,{...entry,revision:3});
  assert.throws(()=>store.listSummaries(),/이력 손상/);assert.throws(()=>store.get(card.key),/이력 손상/);
 });
 test(`${mode}: 같은 발령 준비에서 원장·목록은 한 번, 실제 전송은 생존·PID 검사 뒤`,()=>{
  const {home,store,card}=setup(mode);
  store.update(card.key,{status:'assigned',scope:'시험',board:'board',role:'worker',rallyId:'r',rallyTitle:'왕복',rallyRound:'1',rallyStep:'implementation'},{revision:1,note:'배정'});
  appendLedger({kind:'start',role:'worker',session:'kadan-worker',panePid:'7',harness:'codex',model:'test',cmd:'codex --model test',aiIdentityVerified:true},home);
  const original=CardStore.prototype.listSummaries;let lists=0,reads=0;const order=[];
  CardStore.prototype.listSummaries=function(){lists++;return original.call(this);};
  try{
   const receipt=guardedSend({role:'worker',session:'kadan-worker',taskId:card.id,message:'작업',roleProfile:'worker',recordedPid:'7',env:{KADAN_HOME:home},
    readEntries:()=>{reads++;return readLedger(home);},record:()=>{},saveBody:()=>{},
    floor:{name:'fake',alive:()=>{order.push('alive');return true;},pid:()=>{order.push('pid');return '7';},send:()=>{order.push('send');return {};}}});
   assert.equal(receipt.executionKey,card.key);assert.equal(lists,1);assert.equal(reads,1);assert.deepEqual(order,['alive','pid','send']);
  }finally{CardStore.prototype.listSummaries=original;}
  fs.renameSync(card.path,card.path+'.preserved');
  assert.throws(()=>store.checkSend(card.key,'worker'),/ENOENT/);
 });
 test(`${mode}: 업무 요약의 공유 자료는 기존 판정과 같고 다음 호출로 남지 않는다`,()=>{
  const {home,store}=setup(mode),works=new WorkStore(home);
  const w=works.create({key:'repo/work',title:'시험',goal:'결과',scope:'범위',acceptance:'조건',owner:'owner',repoPath:home});
  const current=works.change(w.key,'execute',{title:'실행',body:'# 지시',phase:'implementation',round:1},{revision:1,by:'owner',note:'등록'});
  const registered=works.list(),snapshot={ledgerState:readLedgerState(home),cards:store.listSummaries(),decisions:[]};
  const shared=operationsFlowSummaries(home,registered,snapshot).get(w.key),fresh=operationsFlowSummaries(home,registered).get(w.key);
  assert.deepEqual(shared.followup,fresh.followup);
  const key=current.executions[0].key;
  store.update(key,{status:'hold'},{revision:1,note:'보류'});
  const next=operationsFlowSummaries(home,works.list()).get(w.key);
  assert.notDeepEqual(next.followup,shared.followup);
 });
}
test('SQLite: 잘못된 heads가 이력의 최신 상태를 가리지 않는다',()=>{
 const {home,store,card}=setup('sqlite');
 transaction(home,db=>db.prepare("UPDATE heads SET payload=json_set(payload,'$.status','done') WHERE stream=?").run(`cards/${card.key}/events.jsonl`));
 assert.throws(()=>store.listSummaries(),/이력 손상/);
});
