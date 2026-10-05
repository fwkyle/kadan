// 진행 보고·결과 등록의 revision 잠금은 "발령 조건이 바뀌었는가"로 판단한다(2026-10-05 점검 보고서 1-M5, 독립 검수 1).
// 메모만 바뀐 뒤의 옛 revision 보고는 통과, 범위·담당·상태·묶음이 바뀐 뒤의 옛 revision 보고는 거절.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CardStore} from '../src/card-store.mjs';

function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-lock-'));
 const home=path.join(root,'state'),repoPath=path.join(root,'repo');fs.mkdirSync(home);fs.mkdirSync(repoPath);
 const store=new CardStore(home);
 const c=store.create({repo:'repo',id:'card-a',repoPath,body:'# 검색 수정\n\n## 읽고 시작할 것\n- /abs/AGENTS.md — 규칙\n'});
 const ready=store.update(c.key,{status:'ready',scope:'로컬 구현만'},{revision:c.revision,note:'승인'});
 const assigned=store.update(c.key,{status:'assigned',role:'작업자',board:'b',rallyId:'r1',rallyTitle:'묶음',rallyRound:'1',rallyStep:'implementation'},{revision:ready.revision,note:'배정'});
 return {store,key:c.key,assigned};
}

test('감독이 메모만 남긴 뒤에도 작업자의 옛 revision 진행 보고는 통과한다',()=>{
 const {store,key,assigned}=fixture();
 const seen=assigned.revision;
 const noted=store.update(key,{},{revision:seen,note:'감독 메모: 참고 링크 추가',by:'감독'});
 assert.equal(noted.revision,seen+1);
 const active=store.update(key,{activity:'running'},{revision:seen,by:'작업자',note:'시작: 구현'});
 assert.equal(active.activity,'running');
 assert.equal(active.revision,seen+2);
});

test('범위·담당·상태가 바뀐 뒤의 옛 revision 진행 보고·결과 등록은 거절한다 — 옛 범위의 결과가 붙지 않게',()=>{
 const {store,key,assigned}=fixture();
 const seen=assigned.revision;
 store.update(key,{scope:'로컬 구현 + 시험'},{revision:seen,note:'범위 확장',by:'감독'});
 assert.throws(()=>store.update(key,{activity:'running'},{revision:seen,by:'작업자',note:'시작'}),/범위·담당·상태·묶음이 바뀌었다/);
 const card=store.get(key);
 fs.writeFileSync(card.resultPath,'# 결과\n');
 assert.throws(()=>store.report(key,{revision:seen,outcome:'implemented',by:'작업자'}),/범위·담당·상태·묶음이 바뀌었다/);
 // 최신 revision으로는 등록된다.
 const saved=store.report(key,{revision:card.revision,outcome:'implemented',by:'작업자'});
 assert.equal(saved.result.outcome,'implemented');
});

test('메모만 바뀐 뒤의 옛 revision 결과 등록은 통과하고, 그 밖의 수정(제목·범위 변경)은 여전히 최신 revision을 요구한다',()=>{
 const {store,key,assigned}=fixture();
 const seen=assigned.revision;
 store.update(key,{},{revision:seen,note:'메모',by:'감독'});
 const card=store.get(key);
 fs.writeFileSync(card.resultPath,'# 결과\n');
 const saved=store.report(key,{revision:seen,outcome:'implemented',by:'작업자'});
 assert.equal(saved.result.outcome,'implemented');
 assert.throws(()=>store.update(key,{title:'다른 제목'},{revision:seen,note:'충돌',by:'감독'}),/카드가 변경됨: 새로 읽고/);
 assert.throws(()=>store.update(key,{activity:'waiting'},{revision:seen-5,by:'작업자',note:'없는 버전'}),/카드가 변경됨: 새로 읽고/);
});
