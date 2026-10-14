import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {CardStore} from '../src/card-store.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {createDatabase,writeStorageMarker,appendStream} from '../src/storage.mjs';
import {floor} from '../src/floor.mjs';
import {buildCardCenter} from '../src/card-center.mjs';
import {createWallServer} from '../src/wall.mjs';
import {loadWallSnapshot} from '../src/commands/tree-wall.mjs';
import {createSnapshotCache,dataVersion,wallCache,cardFilesFingerprint,nextTimeBoundary} from '../src/wall-snapshot-cache.mjs';

// 시험이 실제 카단 세션(tmux)을 보지 않게 존재하지 않는 소켓을 쓴다.
process.env.KADAN_SOCKET=process.env.KADAN_LITE_SOCKET='kadan-test-none-'+process.pid;
const sqliteHome=()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-snapcache-'));
 createDatabase(home);writeStorageMarker(home,'sqlite');process.env.KADAN_HOME=home;wallCache.clear();return home;
};
const heavy=['ledger','cards','center','works'];
const misses=()=>Object.fromEntries(heavy.map(name=>[name,wallCache.stats()[name]?.miss??0]));
// 수집 시각처럼 매번 달라지는 값은 뺀다.
const same=value=>JSON.parse(JSON.stringify(value,(key,v)=>/^(at|now|generatedAt|collectedAt|checkedAt|ageMs)$/.test(key)?undefined:v));
const strip=snapshot=>same({center:snapshot.center,entries:snapshot.entries,mailbox:snapshot.mailbox,cardFiles:snapshot.cardFiles,ledgerLines:snapshot.ledgerLines,error:snapshot.error});

test('틀 재사용: 같은 키는 다시 계산하지 않고 키가 바뀌거나 오래되거나 키가 없으면 계산한다',()=>{
 let at=0,runs=0;
 const cache=createSnapshotCache({now:()=>at,maxAgeMs:100});
 const compute=()=>({n:++runs});
 const first=cache.memo('a','k1',compute);
 assert.equal(cache.memo('a','k1',compute),first);assert.equal(runs,1);
 assert.notEqual(cache.memo('a','k2',compute),first);assert.equal(runs,2);
 at=150;cache.memo('a','k2',compute);assert.equal(runs,3,'시간이 지나면 데이터가 같아도 다시 계산');
 cache.memo('a',null,compute);cache.memo('a',null,compute);assert.equal(runs,5,'키가 없으면(JSONL 등) 재사용하지 않는다');
 assert.deepEqual(cache.stats().a,{hit:1,miss:5});
});

test('데이터 버전이 같으면 원장·카드·카드 상태·업무 계산을 다시 하지 않는다',()=>{
 const home=sqliteHome(),store=new CardStore(home);
 store.create({repo:'r',id:'a',repoPath:home,body:'# a'});
 const first=loadWallSnapshot();
 assert.equal(first.centerError,null);assert.equal(first.center.cards.length,1);
 const before=misses();
 const second=loadWallSnapshot();
 assert.deepEqual(misses(),before,'바뀐 게 없으면 무거운 계산은 모두 재사용');
 assert.equal(second.entries,first.entries);assert.equal(second.center.cards,first.center.cards);
 assert.deepEqual(strip(second),strip(first));
});

test('원장에 사건이 추가되면 다음 조회에 반영된다 (놓치는 사건 0)',()=>{
 const home=sqliteHome();
 new CardStore(home).create({repo:'r',id:'a',repoPath:home,body:'# a'});
 const first=loadWallSnapshot(),version=dataVersion(home);
 for(let i=0;i<3;i++){
  appendLedger({kind:'note',t:new Date(Date.now()+i).toISOString(),role:'x',text:'추가 '+i});
  assert.notEqual(dataVersion(home),version);
  const next=loadWallSnapshot();
  assert.equal(next.entries.length,first.entries.length+i+1,'추가한 사건을 바로 읽는다');
  assert.equal(next.ledgerLines,next.entries.length);
 }
});

test('카드 변경과 카드 본문 파일 수정이 다음 조회에 반영된다',()=>{
 const home=sqliteHome(),store=new CardStore(home);
 const card=store.create({repo:'r',id:'a',repoPath:home,body:'# 처음'});
 const first=loadWallSnapshot();
 assert.equal(first.center.cards[0].revision,1);assert.match(first.center.cards[0].body,/처음/);
 store.update(card.key,{status:'hold',resolutionOwner:'감독',nextAction:'검토'},{revision:1,note:'이유'});
 const second=loadWallSnapshot();
 assert.equal(second.center.cards[0].revision,2);
 const file=path.join(home,'cards/r/a/card.md'),fingerprint=cardFilesFingerprint(home);
 fs.writeFileSync(file,'# 파일만 바꿈, 길이도 다름');
 assert.notEqual(cardFilesFingerprint(home),fingerprint);
 assert.match(loadWallSnapshot().center.cards[0].body,/파일만 바꿈/);
});

test('재사용한 결과는 매번 새로 계산한 결과와 같다 (숫자 불변)',()=>{
 const home=sqliteHome(),store=new CardStore(home);
 for(const id of ['a','b','c'])store.create({repo:'r',id,repoPath:home,body:'# '+id});
 store.update('r/b',{status:'hold',resolutionOwner:'감독',nextAction:'검토'},{revision:1,note:'보류'});
 appendLedger({kind:'plan',t:new Date().toISOString(),board:'판',taskId:'r/a',title:'a'});
 loadWallSnapshot();
 const reused=strip(loadWallSnapshot());
 wallCache.clear();
 const fresh=strip(loadWallSnapshot());
 assert.deepEqual(reused,fresh);
 assert.equal(reused.center.summary.cards,3);
});

test('JSONL 저장소는 버전을 만들지 못해 재사용하지 않는다',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-snapcache-jsonl-'));process.env.KADAN_HOME=home;wallCache.clear();
 assert.equal(dataVersion(home),null);
 loadWallSnapshot();const before=misses();loadWallSnapshot();
 for(const name of ['ledger','cards'])assert.equal(misses()[name],before[name]+1,name+' 매번 새로 읽는다');
});

const snapshot=()=>({center:null,centerError:null,collectedAt:new Date().toISOString(),entries:[],ledgerLines:0,error:null,resources:null,tree:[]});
const start=async server=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+server.address().port;};

test('같은 시각에 온 요청 여러 개는 수집 한 번을 함께 쓴다',async()=>{
 const home=sqliteHome();let loads=0;
 const server=createWallServer(()=>{loads++;const end=Date.now()+150;while(Date.now()<end);return snapshot();},{home,cacheSec:10,warmAfterMs:60_000});
 const base=await start(server);
 try{
  const responses=await Promise.all(Array.from({length:6},(_,i)=>fetch(base+'/api/cards?x='+i)));
  assert.ok(responses.every(r=>r.status===200));
  assert.equal(loads,1,'6개가 동시에 와도 수집은 1번');
 }finally{server.close();}
});

test('이미 연결을 끊은 요청은 새 수집을 시작하지 않는다',async()=>{
 const home=sqliteHome();let loads=0;
 const server=createWallServer(()=>{loads++;const end=Date.now()+400;while(Date.now()<end);return snapshot();},{home,cacheSec:0,warmAfterMs:60_000});
 const base=await start(server),port=server.address().port;
 try{
  const first=fetch(base+'/api/cards?first=1');
  await new Promise(resolve=>setTimeout(resolve,100));
  // 첫 수집이 도는 동안 두 번째 요청을 보내고 곧바로 연결을 끊는다(RST). FIN만 보내는 닫기는 반쯤 닫힌 연결과 구별되지 않는다.
  const socket=net.connect(port,'127.0.0.1');
  await new Promise(resolve=>socket.once('connect',resolve));
  socket.write('GET /api/cards?second=1 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
  socket.resetAndDestroy();
  await first;
  await new Promise(resolve=>setTimeout(resolve,200));
  assert.equal(loads,1,'끊긴 요청 몫의 수집은 하지 않는다');
 }finally{server.close();}
});

// --- 2라운드: 검수에서 재현된 결함의 회귀 시험 ---
const withClock=(fn)=>{
 const real=Date.now,origin=real();let offset=0;
 Date.now=()=>origin+offset;
 try{return fn(ms=>{offset+=ms;});}finally{Date.now=real;}
};
test('진행 보고 시각이 지나면 같은 데이터여도 상태가 새 계산과 같아진다 (시각 경계)',()=>withClock(tick=>{
 const home=sqliteHome(),store=new CardStore(home),now=Date.now();
 const initial=store.create({repo:'r',id:'future',repoPath:home,body:'# future'});
 const sent=new Date(now-1000).toISOString(),future=new Date(now+1000).toISOString();
 const h={...initial,status:'assigned',role:'worker',board:'r',scope:'review',revision:2,at:sent,note:'assigned',noteKind:'decision'};
 appendStream(home,'cards/r/future/events.jsonl',h);
 appendStream(home,'cards/r/future/events.jsonl',{...h,revision:3,at:future,activity:'running',activityAt:future,activityRole:'worker',by:'worker',noteKind:'progress',note:'running'});
 const list=floor.list;floor.list=()=>[{session:'kadan-worker',pid:111,alive:true}];
 try{
  appendLedger({kind:'start',role:'worker',t:sent,panePid:111,pid:111,by:'boss'});
  appendLedger({kind:'send',role:'worker',taskId:initial.key,t:sent,by:'boss'});
  const boundary=nextTimeBoundary(store.list(),Date.now());
  assert.ok(boundary!==null&&boundary<=Date.parse(future),'다음 시각 경계가 보고 시각 이전에 잡힌다');
  assert.equal(loadWallSnapshot().center.cards[0].displayState,'unconfirmed','보고 시각 전');
  tick(500);assert.equal(loadWallSnapshot().center.cards[0].displayState,'unconfirmed');
  tick(1500);
  const later=loadWallSnapshot();
  const fresh=buildCardCenter({cards:new CardStore(home).list(),entries:later.entries,tree:later.tree});
  assert.equal(fresh.cards[0].displayState,'running');
  assert.equal(later.center.cards[0].displayState,'running','시각이 지나면 다시 계산');
 }finally{floor.list=list;}
}));

test('틀 재사용: 시각 경계가 지나면 무효화한다',()=>{
 let at=1000,runs=0;
 const cache=createSnapshotCache({now:()=>at,maxAgeMs:1e9});
 const compute=()=>++runs;
 cache.memo('a','k',compute,{boundary:()=>2000});
 at=1999;cache.memo('a','k',compute,{boundary:()=>2000});assert.equal(runs,1);
 at=2000;cache.memo('a','k',compute,{boundary:()=>5000});assert.equal(runs,2,'경계 시각이 되면 다시 계산');
});

test('카드 지문은 카드마다 달라서 다른 카드의 최신 시각 뒤에 숨은 내용 변경도 잡는다',()=>{
 const home=sqliteHome(),store=new CardStore(home);
 store.create({repo:'r',id:'old',repoPath:home,body:'# AAAA'});store.create({repo:'r',id:'new',repoPath:home,body:'# NEW1'});
 const oldFile=path.join(home,'cards/r/old/card.md'),newFile=path.join(home,'cards/r/new/card.md');
 const t1=new Date(Date.now()-60_000),t2=new Date(Date.now()-30_000);
 fs.utimesSync(oldFile,t1,t1);fs.utimesSync(newFile,t2,t2);
 const before=cardFilesFingerprint(home);
 assert.match(loadWallSnapshot().center.cards.find(c=>c.key==='r/old').body,/AAAA/);
 const keep=fs.statSync(oldFile);
 fs.writeFileSync(oldFile,'# CCCC');fs.utimesSync(oldFile,keep.atime,keep.mtime);
 assert.notEqual(cardFilesFingerprint(home),before,'크기·수정 시각이 같아도 상태 변경 시각이 다르다');
 assert.match(loadWallSnapshot().center.cards.find(c=>c.key==='r/old').body,/CCCC/);
});

test('대기 출력 파일이 바뀌면 역할의 waitSnapshot 꼬리도 새 값이다',()=>{
 const home=sqliteHome();
 const list=floor.list;floor.list=()=>[{session:'kadan-worker',pid:111,alive:true}];
 try{
  appendLedger({kind:'start',role:'worker',t:new Date().toISOString(),panePid:111,pid:111,by:'boss'});
  fs.mkdirSync(path.join(home,'out'),{recursive:true});
  fs.writeFileSync(path.join(home,'out/kadan-worker.wait-1.txt'),'old output\n');
  const tail=()=>loadWallSnapshot().center.roles.find(r=>r.role==='worker')?.waitSnapshot?.tail;
  assert.equal(tail(),'old output');
  fs.writeFileSync(path.join(home,'out/kadan-worker.wait-2.txt'),'new output\n');
  assert.equal(tail(),'new output');
 }finally{floor.list=list;}
});

test('요청을 다 보내고 쓰기 쪽만 닫은 정상 클라이언트도 응답을 받는다',async()=>{
 const home=sqliteHome();let loads=0;
 const server=createWallServer(()=>{loads++;return snapshot();},{home,cacheSec:0,warmAfterMs:60_000});
 await start(server);const port=server.address().port;
 try{
  const body=await new Promise(resolve=>{
   const socket=net.connect(port,'127.0.0.1');let text='';
   socket.on('data',chunk=>{text+=chunk;if(text.includes('"center"')){socket.destroy();resolve(text);}});
   socket.on('close',()=>resolve(text));socket.on('error',()=>resolve(text));
   socket.on('connect',()=>socket.end('GET /api/cards HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'));
   setTimeout(()=>resolve(text),2000);
  });
  assert.match(body,/^HTTP\/1\.1 200/);assert.equal(loads,1);
 }finally{server.close();}
});
