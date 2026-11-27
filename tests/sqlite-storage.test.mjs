import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {CardStore} from '../src/card-store.mjs';
import {DecisionStore} from '../src/decisions.mjs';
import {BriefStore} from '../src/human-brief.mjs';
import {appendLedger,readLedger} from '../src/ledger.mjs';
import {createDatabase,writeStorageMarker,transaction,openDatabase,appendRow} from '../src/storage.mjs';
import {verifyStorage,storageCommand} from '../src/storage-migration.mjs';
const root=()=>fs.mkdtempSync(path.join(os.tmpdir(),'kadan-sqlite-'));
function setup(){const home=root();createDatabase(home);writeStorageMarker(home,'sqlite');return home;}
const child=(code,args=[],options={})=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--input-type=module','-e',code,...args],{cwd:process.cwd(),stdio:['ignore','pipe','pipe'],...options});let stdout='',stderr='';p.stdout.on('data',x=>stdout+=x);p.stderr.on('data',x=>stderr+=x);p.on('error',reject);p.on('close',status=>resolve({status,stdout,stderr}));});
test('SQLite: 카드 revision/이력과 설명, 다른 단계 조치는 원자적으로 저장된다',()=>{
 const home=setup(),s=new CardStore(home);let c=s.create({repo:'r',id:'a',repoPath:home,body:'# a'});
 assert.equal(s.list()[0].key,'r/a');assert.ok(!fs.existsSync(path.join(home,'cards/r/a/events.jsonl')));
 c=s.update(c.key,{status:'hold',resolutionOwner:'감독',nextAction:'검토'},{revision:1,note:'이유'});
 assert.throws(()=>s.update(c.key,{status:'done'},{revision:1,note:'늦음'}),/변경됨/);
 assert.throws(()=>transaction(home,()=>{s.update(c.key,{status:'done'},{revision:2,note:'실패할 트랜잭션'});throw Error('중단')}),/중단/);
 assert.equal(s.get(c.key).status,'hold');assert.equal(s.get(c.key).history.length,2);
 new BriefStore(home).write(c.key,{revision:2,title:'작업',workstream:'묶음'},'감독');assert.equal(new BriefStore(home).read(c.key).title,'작업');
 assert.equal(verifyStorage(home).integrity,'ok');
 const db=openDatabase(home);try{assert.throws(()=>db.exec("DELETE FROM events"),/삭제 금지/);}finally{db.close()}
});
test('SQLite: 결정 통지는 트랜잭션 밖이며 같은 답변은 다시 알리지 않는다',()=>{
 const home=setup();new CardStore(home).create({repo:'r',id:'a',repoPath:home,body:'# a'});let count=0;
 const d=new DecisionStore(home,{notify:()=>{count++;const db=openDatabase(home);try{db.exec('BEGIN IMMEDIATE; ROLLBACK')}finally{db.close()}}});
 const q=d.request('r/a',{question:'질문',options:['a','b'],recommendation:'a',reason:'이유 https://example.com/pr/1'},'p-슈퍼감독');
 const answer=d.answer(q.id,{revision:1,choice:'b'},'사람');assert.equal(answer.delivery.status,'sent');
 d.answer(q.id,{revision:1,choice:'b'},'사람');assert.equal(count,1);
 // 통지 직전 중단된 pending을 재호출해도 자동 재전송하지 않는다.
 const q2=d.request('r/a',{question:'질문2',options:['a','b'],recommendation:'a',reason:'이유 https://example.com/pr/1'},'p-슈퍼감독');
 d.locked(()=>d.write({...q2,revision:2,status:'answered',answer:{by:'사람',text:'a',choice:'a'},delivery:{status:'pending'}}));
 assert.equal(d.answer(q2.id,{revision:1,choice:'a'},'사람').delivery.status,'pending');assert.equal(count,1);
});
test('SQLite: 같은 카드에 동시에 쓰면 하나만 성공하고 다른 카드/원장 쓰기는 유실 없다',async()=>{
 const home=setup();new CardStore(home).create({repo:'r',id:'a',repoPath:home,body:'# a'});
 const code=`import {CardStore} from './src/card-store.mjs';try{new CardStore(process.argv[1]).update('r/a',{status:'hold'},{revision:1,note:'동시 변경'});console.log('ok')}catch(e){console.log(e.message);process.exitCode=2}`;
 const results=await Promise.all(Array.from({length:8},()=>child(code,[home])));
 assert.equal(results.filter(r=>r.status===0).length,1,JSON.stringify(results));assert.equal(new CardStore(home).get('r/a').revision,2);
 const writes=await Promise.all(Array.from({length:8},(_,n)=>child(`import {appendLedger} from './src/ledger.mjs';for(let i=0;i<10;i++)appendLedger({kind:'test',id:process.argv[2]+':'+i},process.argv[1]);`,[home,String(n)])));
 assert.ok(writes.every(r=>r.status===0),JSON.stringify(writes));assert.equal(readLedger(home).length,80);assert.equal(new Set(readLedger(home).map(r=>r.id)).size,80);
});
test('SQLite: 손상/기록 없음/미래 버전/중지 표식을 정상으로 숨기지 않는다',()=>{
 const home=setup();storageCommand(['pause'],{},{home});assert.throws(()=>appendLedger({kind:'test'},home),/중지/);
 storageCommand(['resume'],{},{home});appendLedger({kind:'test'},home);
 const db=openDatabase(home);db.exec('PRAGMA user_version=99');db.close();assert.throws(()=>readLedger(home),/버전/);
 const missing=root();writeStorageMarker(missing,'sqlite');assert.throws(()=>readLedger(missing),/없음/);assert.ok(!fs.existsSync(path.join(missing,'kadan.sqlite')));
});
test('SQLite: 프로세스가 트랜잭션 도중 죽으면 상태·이력이 모두 복구된다',async()=>{
 const home=setup();new CardStore(home).create({repo:'r',id:'a',repoPath:home,body:'# a'});
 const result=await child(`import {transaction} from './src/storage.mjs';import {CardStore} from './src/card-store.mjs';transaction(process.argv[1],()=>{new CardStore(process.argv[1]).update('r/a',{status:'hold'},{revision:1,note:'강제 중단'});process.kill(process.pid,'SIGKILL')})`,[home]);
 assert.notEqual(result.status,0);assert.equal(new CardStore(home).get('r/a').revision,1);assert.equal(verifyStorage(home).integrity,'ok');
});
test('SQLite: 다른 프로세스의 긴 잠금은 제한 시간 뒤 실패하며 새 이벤트가 생기지 않는다',{timeout:60000},async()=>{
 const home=setup(),db=openDatabase(home);db.exec('BEGIN IMMEDIATE');
 let result;
 try{
  assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout,15000);
  // Measure inside the child after imports, excluding process startup and module loading.
  result=await child(`import {appendLedger} from './src/ledger.mjs';const start=performance.now();try{appendLedger({kind:'blocked'},process.argv[1])}catch(e){console.log(JSON.stringify({message:e.message,elapsedMs:performance.now()-start}));process.exitCode=2}`,[home],{timeout:45000,killSignal:'SIGKILL'});
 }finally{db.exec('ROLLBACK');db.close()}
 assert.equal(result.status,2,result.stderr);
 const {message,elapsedMs}=JSON.parse(result.stdout);
 assert.match(message,/locked|busy/i);
 assert.ok(elapsedMs>=14000,`잠금 대기 없이 너무 빨리 실패함: ${elapsedMs}ms`);
 assert.ok(elapsedMs<30000,`잠금 작업이 제한 시간을 넘김: ${elapsedMs}ms`);
 assert.equal(readLedger(home).length,0);
});
test('SQLite: 전환 중 send는 실제 터미널 전송 전에 거절한다',async()=>{
 const {guardedSend}=await import('../src/cli.mjs');const home=setup();storageCommand(['pause'],{},{home});let sent=0;
 assert.throws(()=>guardedSend({floor:{alive:()=>true,pid:()=>1,send:()=>sent++},session:'kadan-r',role:'r',message:'x',env:{KADAN_HOME:home}}),/중지/);assert.equal(sent,0);
});
test('SQLite: 웹 저장은 같은 revision의 중복 제출을 거절하고 재조회에 반영한다',async()=>{
 const {createWallServer}=await import('../src/wall.mjs');const {buildCardCenter}=await import('../src/card-center.mjs');
 const home=setup(),store=new CardStore(home);store.create({repo:'r',id:'a',repoPath:home,body:'# 웹 저장'});
 const server=createWallServer(()=>({center:buildCardCenter({cards:store.list(),entries:[],tree:[]}),entries:[],ledgerLines:0,collectedAt:new Date()}),{home,notify:()=>{throw Error('통지하면 안 됨')}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const base='http://127.0.0.1:'+server.address().port,html=await(await fetch(base+'/?card=r/a')).text();const token=html.match(/name="token" value="([^"]+)"/)[1];
  const body=new URLSearchParams({token,key:'r/a',revision:'1',title:'웹 저장',status:'hold',scope:'',note:'화면에서 보류',resolutionOwner:'감독',nextAction:'검토'});
  const requests=await Promise.all([1,2].map(()=>fetch(base+'/cards/update',{method:'POST',body,redirect:'manual'})));
  assert.deepEqual(requests.map(r=>r.status).sort(),[303,409]);
  assert.equal(store.get('r/a').revision,2);assert.equal(store.get('r/a').nextAction,'검토');assert.equal(verifyStorage(home).integrity,'ok');
 }finally{await new Promise(resolve=>server.close(resolve))}
});
test('SQLite: 비서 우편과 읽음도 같은 원장에 저장되고 감시 세션을 만들지 않는다',async()=>{
 const {SecretaryMailbox}=await import('../src/secretary-mailbox.mjs');const {buildTree}=await import('../src/cli.mjs');
 const h=setup(),m=new SecretaryMailbox(h),r=m.send({by:'p-슈퍼감독',message:'전환 준비 완료'});
 assert.equal(m.list().length,1);m.acknowledge(r.mailId,'비서');assert.equal(m.list().length,0);assert.equal(readLedger(h).length,2);assert.equal(buildTree(readLedger(h)).length,0);assert.equal(verifyStorage(h).integrity,'ok');
});

test('09-24 잠금 밖 미리 계산: 그 사이 바뀐 게 없으면 한 번만, 사건이 추가됐으면 잠금 안에서 다시 계산한다',async()=>{
 const {prepareOutsideLock,preparedTransaction,storageVersion,appendStream}=await import('../src/storage.mjs');
 const home=setup();let calls=0;const compute=()=>++calls;
 const v0=storageVersion(home);assert.equal(typeof v0,'number');
 assert.equal(preparedTransaction(home,compute,value=>value),1);assert.equal(calls,1);
 calls=0;const current=prepareOutsideLock(home,compute);appendStream(home,'probe/events.jsonl',{kind:'probe'});
 assert.ok(storageVersion(home)>v0);
 assert.equal(current(),2);assert.equal(calls,2);
 // 미리 계산이 실패하면 잠금 안에서 다시 계산한다(예전과 같은 결과·오류).
 let first=true;assert.equal(preparedTransaction(home,()=>{if(first){first=false;throw new Error('일시 실패');}return 'ok';},value=>value),'ok');
});
test('SQLite: 지워진 import·export·activate·inspect는 알 수 없는 명령으로 거절하고 jsonl-last를 안내한다',()=>{
 const home=setup();
 for(const name of ['import','export','activate','inspect'])assert.throws(()=>storageCommand([name],{},{home}),/알 수 없는 storage 명령.*jsonl-last/);
 assert.throws(()=>storageCommand(['nope'],{},{home}),/알 수 없는 storage 명령/);
 const help=storageCommand([],{},{home});assert.match(help,/verify \| pause \| resume/);assert.doesNotMatch(help,/--source|--candidate/);
 assert.deepEqual(fs.readdirSync(home).sort(),['kadan.sqlite','kadan.sqlite-shm','kadan.sqlite-wal','storage.json'].filter(n=>fs.existsSync(path.join(home,n))).sort());
});
// verify는 DB 안의 수입 행만 대조한다. 동결 원본 파일(imports.source)이 없어도 통과해야 한다.
function importedHome({rows=1,raw='{"kind":"x"}',value={kind:'x'}}={}){
 const home=setup(),db=openDatabase(home);
 try{
  db.prepare('INSERT INTO imports(source,sha256,bytes,rows) VALUES(?,?,?,?)').run('ledger.jsonl','0'.repeat(64),raw.length,rows);
  appendRow(db,'ledger.jsonl',value,{source:'ledger.jsonl',line:1,raw});
 }finally{db.close()}
 return home;
}
test('SQLite verify: imports 행이 있고 원본 파일이 없어도 통과한다',()=>{
 const home=importedHome();assert.equal(fs.existsSync(path.join(home,'ledger.jsonl')),false);
 assert.equal(verifyStorage(home).integrity,'ok');
 assert.equal(storageCommand(['verify'],{},{home}).events,1);
});
test('SQLite verify: raw와 payload가 다르면 여전히 수입 행 원문 불일치로 실패한다',()=>{
 assert.throws(()=>verifyStorage(importedHome({raw:'{"kind":"x"}',value:{kind:'y'}})),/수입 행 원문 불일치/);
});
test('SQLite verify: imports 행 수와 DB 안 수입 행 수가 다르면 여전히 실패한다',()=>{
 assert.throws(()=>verifyStorage(importedHome({rows:2})),/수입 행 원문 불일치/);
});
