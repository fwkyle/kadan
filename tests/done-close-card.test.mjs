import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {CardStore} from '../src/card-store.mjs';
import {appendLedger,readLedger} from '../src/ledger.mjs';
import {buildCardCenter} from '../src/card-center.mjs';
import {renderDoneButOpen} from '../src/center-wall.mjs';

const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
const rally={rallyId:'r1',rallyTitle:'묶음',rallyRound:'1',rallyStep:'implementation'};
function fixture(status='assigned') {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-close-card-')),store=new CardStore(home);
 const created=store.create({repo:'repo',id:'card-a',repoPath:home,body:'# 카드 닫기',by:'사람'});
 let card=store.update(created.key,{status:'assigned',scope:'로컬 구현만',board:'b',role:'p-작업자',...rally},{revision:1,note:'배정'});
 if(status!=='assigned')card=store.update(card.key,{status},{revision:card.revision,note:`${status} 전환`});
 appendLedger({kind:'start',role:'p-작업자',session:'kadan-p-작업자',t:new Date().toISOString()},home);
 const run=(...args)=>spawnSync(process.execPath,[cli,'done',...args],{env:{...process.env,KADAN_HOME:home,KADAN_LITE_HOME:'',KADAN_ROLE:'p-감독'},encoding:'utf8',timeout:15000});
 const doneRows=()=>readLedger(home).filter(e=>e.kind==='done');
 return {home,store,key:card.key,run,doneRows};
}

test('done --close-card는 실행 완료 확정 뒤 같은 카드를 card update 경로로 닫는다',()=>{
 const f=fixture();
 const r=f.run('p-작업자','card-a','ok','--close-card');
 assert.equal(r.status,0,r.stderr+r.stdout);
 assert.match(r.stdout,/완료 확정: 역할=p-작업자 카드=card-a 결과=ok/);
 assert.match(r.stdout,/카드 닫기: 카드=repo\/card-a 상태=done revision=3/);
 const card=f.store.get(f.key);
 assert.equal(card.status,'done');assert.equal(card.by,'p-감독');assert.equal(card.note,'실행 완료 확정과 함께 카드 닫음');
 assert.equal(f.doneRows().length,1);
 const g=fixture();
 assert.equal(g.run('p-작업자','repo/card-a','ok','--close-card','--note','한 번 발령으로 끝').status,0);
 assert.equal(g.store.get(g.key).note,'한 번 발령으로 끝');
});

test('done --close-card는 failed와 함께 쓰면 아무것도 기록하지 않고 거부한다',()=>{
 const f=fixture();
 const r=f.run('p-작업자','card-a','failed','--close-card');
 assert.equal(r.status,2);assert.match(r.stderr,/ok 완료에만/);
 assert.equal(f.doneRows().length,0);assert.equal(f.store.get(f.key).status,'assigned');
 const note=f.run('p-작업자','card-a','ok','--note','이유만');
 assert.equal(note.status,2);assert.equal(f.doneRows().length,0);
});

test('이미 done인 카드는 중복 기록 없이 알린다',()=>{
 const f=fixture('done');const before=f.store.get(f.key).revision;
 const r=f.run('p-작업자','card-a','ok','--close-card');
 assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/이미 완료 상태라 기록하지 않음/);
 assert.equal(f.store.get(f.key).revision,before);assert.equal(f.doneRows().length,1);
});

for(const status of ['hold','cancelled']) test(`${status} 카드는 닫지 않고, 이미 저장한 실행 완료는 유지한다`,()=>{
 const f=fixture(status);const before=f.store.get(f.key).revision;
 const r=f.run('p-작업자','card-a','ok','--close-card');
 assert.equal(r.status,1);
 assert.match(r.stdout,/완료 확정: 역할=p-작업자/);
 assert.match(r.stderr,new RegExp(`카드 닫기 실패: ${status} 상태 카드는 닫지 않는다.*실행 완료 확정은 그대로 저장됨`));
 const card=f.store.get(f.key);assert.equal(card.status,status);assert.equal(card.revision,before);
 assert.equal(f.doneRows().length,1);assert.equal(f.doneRows()[0].result,'ok');
 assert.match(f.run('p-작업자','card-a','ok').stderr,/이미 완료 확정됨/);
});

test('중앙 카드가 없는 실행은 완료만 저장하고 카드 닫기 실패를 따로 알린다',()=>{
 const f=fixture();
 const r=f.run('p-작업자','legacy-card','ok','--close-card');
 assert.equal(r.status,1);assert.match(r.stdout,/완료 확정/);assert.match(r.stderr,/닫을 카드가 없다/);
 assert.equal(f.doneRows().length,1);
});

test('대시보드 실행 끝·카드 열림: 가장 최근 실행이 ok일 때만, 열린 카드만 보인다',()=>{
 const f=fixture();const card=f.store.get(f.key);
 const t=m=>`2099-01-01T00:0${m}:00Z`;
 const send=(role,m)=>({kind:'send',role,taskId:'card-a',by:'p-감독',t:t(m)});
 const done=(role,m,result='ok')=>({kind:'done',role,taskId:'card-a',result,by:'p-감독',t:t(m)});
 const list=(entries,cards=[card])=>buildCardCenter({cards,entries,tree:[]}).doneButOpen;
 // 최근 실행 ok → 포함
 const included=list([send('p-작업자',1),done('p-작업자',2)]);
 assert.deepEqual(included.map(x=>[x.key,x.role,x.doneAt,x.doneBy,x.revision]),[[f.key,'p-작업자',t(2),'p-감독',card.revision]]);
 // 이전 실행만 ok, 다음 실행(검수)은 아직 → 제외
 assert.deepEqual(list([send('p-작업자',1),done('p-작업자',2),send('p-검수자',3)]),[]);
 // 이전 실행 ok 뒤 다음 실행도 ok → 포함(최근 실행 기준)
 assert.deepEqual(list([send('p-작업자',1),done('p-작업자',2),send('p-검수자',3),done('p-검수자',4)]).map(x=>x.role),['p-검수자']);
 // 최근 실행 failed → 제외
 assert.deepEqual(list([send('p-작업자',1),done('p-작업자',2,'failed')]),[]);
 // 카드가 이미 done → 제외
 const closed=f.store.update(f.key,{status:'done'},{revision:card.revision,note:'닫음'});
 assert.deepEqual(list([send('p-작업자',1),done('p-작업자',2)],[closed]),[]);
 // 완료 확정 뒤 감독이 담당을 바꿔 다시 연 카드 → 제외
 const g=fixture(),doneAt=new Date().toISOString();while(new Date().toISOString()===doneAt);
 const gRuns=[{...send('p-작업자',1),t:doneAt},{...done('p-작업자',2),t:doneAt}];
 assert.equal(list(gRuns,[g.store.get(g.key)]).length,1);
 const reopened=g.store.update(g.key,{role:'p-수정자'},{revision:2,note:'2라운드'});
 assert.deepEqual(list(gRuns,[reopened]),[]);
 const html=renderDoneButOpen({doneButOpen:included});
 assert.match(html,/실행 끝·카드 열림 1장/);
 assert.ok(html.includes(`kadan card update repo/card-a --revision ${card.revision} --status done --note &quot;실행 완료 확정 뒤 카드 닫음&quot;`));
 assert.doesNotMatch(html,/<form|method="post"/);
 assert.match(renderDoneButOpen(null),/모름/);
});
