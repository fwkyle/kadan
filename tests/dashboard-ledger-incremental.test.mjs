import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {CardStore} from '../src/card-store.mjs';
import {appendLedger,readLedger} from '../src/ledger.mjs';
import {readLedgerState} from '../src/ledger-domains.mjs';
import {createDatabase,writeStorageMarker} from '../src/storage.mjs';
import {loadWallSnapshot} from '../src/commands/tree-wall.mjs';
import {wallCache} from '../src/wall-snapshot-cache.mjs';
import {dashboardData} from '../src/dashboard-api.mjs';
import {createWallServer} from '../src/wall.mjs';
import {incrementalCounts,resetIncremental} from '../src/ledger-incremental.mjs';

// Why: 대시보드가 원장을 커서 뒤 새 사건만 읽어도 화면 재료는 전체 읽기와 바이트까지 같아야 한다. 합성 원장만 쓴다.
process.env.KADAN_SOCKET=process.env.KADAN_LITE_SOCKET='kadan-test-none-'+process.pid;
const sqliteHome=()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-dash-incremental-'));
 createDatabase(home);writeStorageMarker(home,'sqlite');process.env.KADAN_HOME=home;wallCache.clear();resetIncremental();return home;
};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// 수집 시각처럼 매번 달라지는 값은 뺀다. status는 옛 코드끼리도 달라서 비교하지 않는다(설계 7-4).
const same=value=>JSON.stringify(value,(key,v)=>/^(at|now|generatedAt|collectedAt|checkedAt|ageMs)$/.test(key)?undefined:v);
const ROUTES=['workspace','kanban','summary','mail','ledger'];
const respond=snapshot=>Object.fromEntries(ROUTES.map(route=>{
 try{return [route,same(dashboardData(snapshot,new URL('http://x/api/dashboard/'+route)))];}
 catch(error){return [route,'오류:'+error.message];}
}));
const batches=[
 key=>appendLedger({kind:'send',role:'worker',by:'lead',taskId:key,executionKey:'r/'+key,mailId:'m-'+key}),
 key=>appendLedger({kind:'done',role:'worker',taskId:key,executionKey:'r/'+key,result:'ok'}),
 key=>appendLedger({kind:'start',role:'worker-'+key,session:'kadan-worker-'+key,panePid:1}),
 key=>appendLedger({kind:'note',t:new Date().toISOString(),role:'x',text:'메모 '+key}),
];

test('(a) 투영 같음: 묶음을 덧붙일 때마다 loadWallSnapshot의 entries·ledgerState가 전체 읽기와 같다',()=>{
 const home=sqliteHome();
 new CardStore(home).create({repo:'r',id:'a',repoPath:home,body:'# a'});
 for(let round=0;round<4;round++){
  for(const [i,batch] of batches.entries()){
   batch('k'+round+i);
   const snapshot=loadWallSnapshot();
   assert.equal(digest(snapshot.entries),digest(readLedger(home)),`entries ${round}/${i}`);
   assert.equal(digest(snapshot.ledgerState),digest(readLedgerState(home)),`ledgerState ${round}/${i}`);
   assert.equal(snapshot.ledgerLines,snapshot.entries.length);
  }
 }
 const counts=incrementalCounts();
 assert.equal(counts.full,1,'덧붙이는 동안 전체 읽기는 처음 한 번뿐');
 assert.ok(counts.incremental>=10,`증분 갱신 ${counts.incremental}`);
});

test('ledgerState는 readLedgerState와 같은 모양이다 (operations-flow eventReader가 읽는 필드)',()=>{
 const home=sqliteHome();
 batches[0]('shape');
 const state=loadWallSnapshot().ledgerState,full=readLedgerState(home);
 assert.deepEqual(Object.keys(state).sort(),Object.keys(full).sort());
 assert.ok(Array.isArray(state.legacy)&&Array.isArray(state.ordered)&&state.streams instanceof Map);
 assert.ok(state.ordered.every(entry=>Number.isInteger(entry._ledgerOrder)));
});

test('배열 정체: 같은 버전은 같은 배열, 버전이 바뀌면 새 배열이고 이전 배열은 늘어나지 않는다',()=>{
 const home=sqliteHome();
 batches[0]('id');
 const first=loadWallSnapshot(),length=first.entries.length,ordered=first.ledgerState.ordered.length;
 assert.equal(loadWallSnapshot().entries,first.entries);
 batches[3]('id2');
 const second=loadWallSnapshot();
 assert.notEqual(second.entries,first.entries);
 assert.equal(first.entries.length,length);assert.equal(second.entries.length,length+1);
 assert.equal(first.ledgerState.ordered.length,ordered);
 assert.notEqual(second.ledgerState.ordered,first.ledgerState.ordered);
});

test('(b) 화면 응답 같음: 옛 전체 읽기로 만든 스냅샷과 새 스냅샷의 works·kanban 등 응답이 바이트까지 같다',()=>{
 const home=sqliteHome(),store=new CardStore(home);
 for(const id of ['a','b','c'])store.create({repo:'r',id,repoPath:home,body:'# '+id});
 store.update('r/b',{status:'hold',resolutionOwner:'감독',nextAction:'검토'},{revision:1,note:'보류'});
 for(let round=0;round<3;round++)for(const [i,batch] of batches.entries())batch('b'+round+i);
 appendLedger({kind:'plan',t:new Date().toISOString(),board:'판',taskId:'r/a',title:'a'});
 const fresh=loadWallSnapshot();
 const old={...fresh,entries:readLedger(home),ledgerState:readLedgerState(home)};
 const [now,before]=[respond(fresh),respond(old)];
 assert.deepEqual(now,before);
 assert.ok(ROUTES.some(route=>!now[route].startsWith('오류:')),'적어도 한 화면은 실제로 답한다');
});

test('요청 경로(center-wall) /roles/restart: 새로 덧붙은 start 사건을 바로 보고, 전체 읽기는 처음 한 번뿐이다',async()=>{
 const home=sqliteHome();
 appendLedger({kind:'start',floor:'tmux',role:'w',session:'kadan-w',panePid:'100',cwd:home,cmd:'codex --model m',by:'test'});
 let calls=0;
 const server=createWallServer(()=>({center:null,entries:[],tree:[],ledgerLines:0,collectedAt:new Date()}),
  {home,cacheSec:0,restart:()=>{calls++;return Promise.resolve({output:'x'});}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 const post=token=>fetch(base+'/roles/restart',{method:'POST',redirect:'manual',
  headers:{'content-type':'application/x-www-form-urlencoded',accept:'application/json',origin:base},
  body:new URLSearchParams({token,role:'w',reason:'r',expectPid:'100'})});
 try{
  const token=(await(await fetch(base)).text()).match(/name="token" value="([a-f0-9]+)"/)[1];
  assert.notEqual((await post(token)).status,409,'최근 start가 w이면 통과');assert.equal(calls,1);
  // 같은 세션의 더 새로운 start가 다른 역할 이름으로 덧붙으면 거절해야 한다. 옛 상태를 보면 여기서 갈린다.
  appendLedger({kind:'start',floor:'tmux',role:'w2',session:'kadan-w',panePid:'101',cwd:home,cmd:'codex',by:'test'});
  assert.equal((await post(token)).status,409,'새로 덧붙은 start를 본다');assert.equal(calls,1);
  assert.equal(incrementalCounts().full,1,'전체 읽기는 처음 한 번뿐');
 }finally{server.close();}
});
