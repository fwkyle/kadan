import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {inferCardPhaseProfile,inferDispatchProfile} from '../src/role-instructions.mjs';
import {CardStore} from '../src/card-store.mjs';

// 지침 조립이 "이 카드가 지금 담당의 미완료 발령인가"(active)를 정하는 규칙을 옛 식(카드마다 원장을 다시 훑기)과
// 같은 결과로 지키는지, 카드 수가 늘어도 원장 훑기 횟수가 늘지 않는지 본다.
const fixtureHome=()=>fs.mkdtempSync(path.join(os.tmpdir(),'kadan-active-map-'));
function addCard(home,{repo='test',id,role,phase='review',status='assigned'}) {
  const store=new CardStore(home);
  const c=store.create({repo,id,repoPath:home,body:'# 시험 카드'});
  return store.update(c.key,{status,role,board:'test',scope:'격리 시험',rallyId:'round',rallyTitle:'왕복',rallyRound:'1',rallyStep:phase},{revision:c.revision,note:'시험 배정'});
}
const send=(role,taskId,extra={})=>({kind:'send',role,taskId,...extra});
const done=(role,taskId,extra={})=>({kind:'done',role,taskId,...extra});
// 검수 단계 카드 하나만 있는 역할: active면 reviewer, 아니면 판정 근거가 없어 unknown-role이다.
const phaseOf=(home,role,entries,taskId)=>({
  dispatch:inferDispatchProfile({home,role,entries}),
  card:taskId?inferCardPhaseProfile({home,role,taskId,entries}):undefined,
});
const ACTIVE={profile:'reviewer',source:'execution-phase'},INACTIVE={profile:null,source:'unknown-role'};

test('active 판정 보존: send 뒤 done은 끝, done 뒤 재발령 send는 다시 진행, 기록 없음은 진행',()=>{
  const home=fixtureHome();
  addCard(home,{id:'sd',role:'r-sd'});addCard(home,{id:'sds',role:'r-sds'});addCard(home,{id:'none',role:'r-none'});
  addCard(home,{id:'sent',role:'r-sent'});
  const entries=[send('r-sd','sd'),done('r-sd','sd'),send('r-sds','sds'),done('r-sds','sds'),send('r-sds','sds'),send('r-sent','sent')];
  assert.deepEqual(phaseOf(home,'r-sd',entries,'sd'),{dispatch:INACTIVE,card:null});
  assert.deepEqual(phaseOf(home,'r-sds',entries,'sds'),{dispatch:ACTIVE,card:ACTIVE});
  assert.deepEqual(phaseOf(home,'r-none',entries,'none'),{dispatch:ACTIVE,card:ACTIVE});
  assert.deepEqual(phaseOf(home,'r-sent',entries,'sent'),{dispatch:ACTIVE,card:ACTIVE});
});

test('active 판정 보존: 다른 역할이 같은 ID로 남긴 done은 이 담당의 완료가 아니다',()=>{
  const home=fixtureHome();
  addCard(home,{id:'shared',role:'r-own'});
  const entries=[send('r-own','shared'),done('r-other','shared')];
  assert.deepEqual(phaseOf(home,'r-own',entries,'shared'),{dispatch:ACTIVE,card:ACTIVE});
});

test('active 판정 보존: 연결 실패(모호한 ID) 줄은 완료로 세지 않는다',()=>{
  const home=fixtureHome();
  addCard(home,{id:'dup',role:'r-conn'});addCard(home,{repo:'test2',id:'dup',role:'r-else'});
  const entries=[send('r-conn','dup',{executionKey:'test/dup'}),done('r-conn','dup')];
  assert.deepEqual(phaseOf(home,'r-conn',entries,'test/dup'),{dispatch:ACTIVE,card:ACTIVE});
  // 실행 키를 붙인 done은 연결되어 완료로 센다
  assert.deepEqual(phaseOf(home,'r-conn',[...entries,done('r-conn','dup',{executionKey:'test/dup'})],'test/dup'),{dispatch:INACTIVE,card:null});
});

test('active 판정 보존: taskId와 executionKey가 서로 다른 카드를 가리키는 충돌 done은 완료로 세지 않는다',()=>{
  const home=fixtureHome();
  addCard(home,{id:'target',role:'r-owner'});addCard(home,{id:'other',role:'r-other'});
  const entries=[send('r-owner','target'),done('r-owner','other',{executionKey:'test/target'})];
  assert.deepEqual(phaseOf(home,'r-owner',entries,'test/target'),{dispatch:ACTIVE,card:ACTIVE});
});

test('active 판정 보존: 확정 인계는 담당과 완료를 새 담당에게 투영한다',()=>{
  const home=fixtureHome();
  addCard(home,{id:'h1',role:'old-a'});addCard(home,{id:'h2',role:'old-b'});
  const hand=(from,to,id)=>({kind:'handover',phase:'transferred',from,to,taskIds:[id]});
  const entries=[send('old-a','h1'),hand('old-a','new-a','h1'),send('old-b','h2'),done('old-b','h2'),hand('old-b','new-b','h2')];
  assert.deepEqual(phaseOf(home,'new-a',entries,'h1'),{dispatch:ACTIVE,card:ACTIVE});
  // 완료된 발령이 인계되면 새 담당 몫으로도 완료이고, 이전 담당은 더 이상 담당이 아니다
  assert.deepEqual(phaseOf(home,'new-b',entries,'h2'),{dispatch:INACTIVE,card:null});
  assert.deepEqual(phaseOf(home,'old-b',entries,'h2'),{dispatch:INACTIVE,card:null});
});

test('active 판정 보존: 원장 손상(broken) 줄이 있거나 status가 assigned가 아니면 진행 아님',()=>{
  const home=fixtureHome();
  addCard(home,{id:'b1',role:'r-broken'});addCard(home,{id:'b2',role:'r-closed',status:'done'});
  assert.deepEqual(phaseOf(home,'r-broken',[send('r-broken','b1'),{broken:true}],'b1').dispatch,INACTIVE);
  assert.deepEqual(phaseOf(home,'r-broken',[send('r-broken','b1')],'b1').dispatch,ACTIVE);
  assert.deepEqual(phaseOf(home,'r-closed',[send('r-closed','b2')],'b2').dispatch,INACTIVE);
});

// 지침 조립이 부른 코드 중 원장 길이 이상의 배열을 훑는 호출 수를 센다(role-instructions.mjs가 부른 것만).
function countLedgerScans(ledgerLength,fn) {
  const names=['some','filter','map','find','findLast','findIndex','forEach','reduce','indexOf','includes','every','flatMap'];
  const originals=new Map(names.map(name=>[name,Array.prototype[name]]));
  const iterator=Array.prototype[Symbol.iterator],limit=Error.stackTraceLimit;
  let count=0;
  const note=(self)=>{if(self.length>=ledgerLength&&new Error().stack.includes('role-instructions.mjs'))count++;};
  Error.stackTraceLimit=30;
  for (const [name,original] of originals) Array.prototype[name]=function(...args){note(this);return original.apply(this,args);};
  Array.prototype[Symbol.iterator]=function(){note(this);return iterator.call(this);};
  try {fn();} finally {
    for (const [name,original] of originals) Array.prototype[name]=original;
    Array.prototype[Symbol.iterator]=iterator;Error.stackTraceLimit=limit;
  }
  return count;
}

test('원장 훑기 횟수는 카드 수와 무관하다 (roleProfile 없는 수신자, 카드 연결 없는 우편)',()=>{
  const LEDGER=300,counts={};
  for (const cardsCount of [1,10,50]) {
    const home=fixtureHome(),role='recipient';
    for (let i=0;i<cardsCount;i++) addCard(home,{id:`c${i}`,role,phase:'implementation'});
    const entries=Array.from({length:LEDGER},(_,i)=>({kind:'start',role:`filler-${i}`,session:`kadan-filler-${i}`}));
    entries.push(send(role,'c0'));
    let selected;
    counts[cardsCount]=countLedgerScans(LEDGER,()=>{selected=inferDispatchProfile({home,role,entries});});
    assert.deepEqual(selected,{profile:'worker',source:'execution-phase'});
  }
  assert.equal(counts[10],counts[1],`카드 10장 ${counts[10]}회 ≠ 1장 ${counts[1]}회`);
  assert.equal(counts[50],counts[1],`카드 50장 ${counts[50]}회 ≠ 1장 ${counts[1]}회`);
});
