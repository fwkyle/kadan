import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createWallServer} from '../src/wall.mjs';

const snapshot=()=>({center:null,centerError:null,collectedAt:new Date().toISOString(),entries:[],ledgerLines:0,error:null,resources:null,tree:[]});
const start=async server=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+server.address().port;};

test('같은 주소는 캐시로 돌려주고 fresh와 저장 요청은 캐시를 건너뛴다',async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-cache-'));
 let loads=0;
 const server=createWallServer(()=>{loads++;return snapshot();},{home,cacheSec:10});
 const base=await start(server);
 try{
  const first=await fetch(base+'/');
  assert.equal(first.headers.get('x-kadan-cache'),'miss');assert.equal(loads,1);
  const second=await fetch(base+'/');
  assert.equal(second.headers.get('x-kadan-cache'),'hit');assert.equal(loads,1,'캐시가 맞으면 원장을 다시 읽지 않는다');
  assert.equal(await second.text(),await first.text());
  const fresh=await fetch(base+'/?fresh=1');
  assert.equal(fresh.headers.get('x-kadan-cache'),'miss');assert.equal(loads,2,'새로 읽기는 캐시를 건너뛴다');
  const after=await fetch(base+'/');
  assert.equal(after.headers.get('x-kadan-cache'),'hit');assert.equal(loads,2,'새로 읽은 결과가 캐시를 갱신한다');
  const other=await fetch(base+'/?layout=wall');
  assert.equal(other.headers.get('x-kadan-cache'),'miss');assert.equal(loads,2,'다른 화면도 유효한 공통 수집 결과를 쓴다');
  const token=(await (await fetch(base+'/')).text()).match(/name="token" value="([a-f0-9]+)"/)[1];
  const post=await fetch(base+'/cards/update',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:base},body:new URLSearchParams({token,key:'repo/none',revision:'1',note:'없는 카드'})});
  assert.ok(post.status>=400);
  const flushed=await fetch(base+'/');
  assert.equal(flushed.headers.get('x-kadan-cache'),'miss');assert.equal(loads,3,'저장 시도 뒤에는 응답·공통 수집 캐시를 비운다');
 }finally{server.close();}
});

test('cacheSec 0은 캐시를 끄고 시간이 지나면 다시 읽는다',async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-cache-off-'));
 let loads=0;
 const off=createWallServer(()=>{loads++;return snapshot();},{home,cacheSec:0});
 const offBase=await start(off);
 try{
  assert.equal((await fetch(offBase+'/')).headers.get('x-kadan-cache'),'miss');
  assert.equal((await fetch(offBase+'/')).headers.get('x-kadan-cache'),'miss');
  assert.equal(loads,2,'0이면 매번 새로 읽는다');
 }finally{off.close();}
 let loads2=0;
 const short=createWallServer(()=>{loads2++;return snapshot();},{home,cacheSec:1});
 const shortBase=await start(short);
 try{
  assert.equal((await fetch(shortBase+'/')).headers.get('x-kadan-cache'),'miss');
  assert.equal((await fetch(shortBase+'/')).headers.get('x-kadan-cache'),'hit');
  await new Promise(resolve=>setTimeout(resolve,1100));
  assert.equal((await fetch(shortBase+'/')).headers.get('x-kadan-cache'),'miss');
  assert.equal(loads2,2,'보관 시간이 지나면 다시 읽는다');
 }finally{short.close();}
});


test('다른 화면의 응답 캐시는 원본 수집 시각보다 수명을 늘리지 않는다',async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-cache-age-'));let clock=0,loads=0;
 const server=createWallServer(()=>{loads++;return snapshot();},{home,cacheSec:10,now:()=>clock});const base=await start(server);
 try{
  await fetch(base+'/');clock=9000;await fetch(base+'/?layout=wall');assert.equal(loads,1);
  clock=11000;const next=await fetch(base+'/?layout=wall');assert.equal(next.headers.get('x-kadan-cache'),'miss');assert.equal(loads,2);
 }finally{server.close();}
});
test('업무 조회 캐시는 권한 검사 뒤에만 쓰고 원문·오류는 저장하지 않는다',async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-cache-flow-'));
 const server=createWallServer(snapshot,{home,cacheSec:10});const base=await start(server);
 try{
  assert.equal((await fetch(base+'/api/operations-flow')).headers.get('x-kadan-cache'),'miss');
  assert.equal((await fetch(base+'/api/operations-flow')).headers.get('x-kadan-cache'),'hit');
  assert.equal((await fetch(base+'/api/operations-flow',{headers:{origin:'https://other.invalid'}})).status,403);
  assert.equal((await fetch(base+'/api/operations-flow',{method:'POST'})).status,405);
  for(let i=0;i<2;i++){
   const bad=await fetch(base+'/api/operations-flow?work=invalid');assert.equal(bad.status,400);assert.equal(bad.headers.get('x-kadan-cache'),'miss');
   const mail=await fetch(base+'/api/operations-flow/mail?work=invalid');assert.equal(mail.status,400);assert.equal(mail.headers.get('x-kadan-cache'),'miss');
  }
 }finally{server.close();}
});

test('요청 뒤 한 번 미리 수집해 다음 요청이 수집을 기다리지 않고, 요청이 끊기면 더 수집하지 않는다',async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-cache-warm-'));
 let loads=0,clock=Date.now();
 const server=createWallServer(()=>{loads++;return snapshot();},{home,cacheSec:10,now:()=>clock,warmAfterMs:200});
 const base=await start(server);
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 try{
  await fetch(base+'/');assert.equal(loads,1);
  clock+=12_000;
  for(let i=0;i<50&&loads<2;i++)await wait(50);assert.equal(loads,2,'요청 뒤 정한 시간에 한 번 미리 수집한다');
  clock+=3_000;
  const next=await fetch(base+'/?layout=wall');
  assert.equal(next.status,200);assert.equal(loads,2,'다음 요청은 미리 만든 수집을 쓴다');
  for(let i=0;i<50&&loads<3;i++)await wait(50);assert.equal(loads,3,'요청마다 다음 수집을 한 번 예약한다');
  await wait(400);assert.equal(loads,3,'새 요청이 없으면 더 수집하지 않는다');
 }finally{server.close();}
});

test('같은 공통 수집으로 여러 번 그려도 업무 목록은 한 번만 계산하고, 새 수집이면 다시 계산한다',async()=>{
 const {renderCenterWall,prepareCenterWall}=await import('../src/center-wall.mjs');
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-works-once-'));
 let reads=0;
 const make=()=>{const value={...snapshot(),center:{cards:[],roles:[],boards:[],unregistered:[],runtimeKnown:true},home};Object.defineProperty(value,'registeredWorks',{get(){reads++;return [];},enumerable:true});return value;};
 const first=make();
 prepareCenterWall(first);renderCenterWall(first,{url:new URL('http://localhost/')});renderCenterWall(first,{url:new URL('http://localhost/?layout=wall')});
 assert.equal(reads,1,'미리 계산한 업무 목록을 그리기에서 다시 쓴다');
 renderCenterWall(make(),{url:new URL('http://localhost/')});
 assert.equal(reads,2,'새 수집은 새로 계산한다');
});

// ── 조회(GET)는 응답 캐시·공유 수집을 비우지 않는다 / /api/autopilot/repos 응답을 cacheSec 동안 기억한다 ──
const withServer=async(fn,{cacheSec=10,now,center=null}={})=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-cache-get-'));let loads=0;
 const server=createWallServer(()=>{loads++;return {...snapshot(),center};},{home,cacheSec,...(now?{now}:{})});const base=await start(server);
 try{await fn({base,home,loads:()=>loads});}finally{server.close();}
};
const tokenOf=async base=>(await (await fetch(base+'/')).text()).match(/name="token" value="([a-f0-9]+)"/)[1];
const post=(base,path_,fields)=>fetch(base+path_,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:base},body:new URLSearchParams(fields)});

test('조회(GET) 갈래 셋은 공통 수집을 비우지 않는다',async()=>{
 for(const p of ['/api/autopilot/repos','/runners/compare','/runners/compare-report'])await withServer(async({base,loads})=>{
  await fetch(base+'/');assert.equal(loads(),1);
  const r=await fetch(base+p);assert.equal(r.status,200,p);await r.text();
  const next=await fetch(base+'/?layout=wall');
  assert.equal(next.headers.get('x-kadan-cache'),'miss');
  assert.equal(loads(),1,p+' 조회 뒤에도 방금 한 수집을 다시 쓴다');
 });
});

test('autopilot/repos GET은 cacheSec 안에서 기억하고 fresh는 건너뛰며 시간이 지나면 다시 읽는다',async()=>{
 let clock=0;
 await withServer(async({base,home})=>{
  const a=await fetch(base+'/api/autopilot/repos');assert.equal(a.headers.get('x-kadan-cache'),null);
  const bodyA=await a.text();
  const b=await fetch(base+'/api/autopilot/repos');assert.equal(b.headers.get('x-kadan-cache'),'hit');
  assert.equal(await b.text(),bodyA,'기억한 응답은 같은 본문');
  // 서버 밖에서 바뀐 정책 파일은 cacheSec 동안 안 보이지만 fresh는 새 값이다.
  const {setRepoPolicy}=await import('../src/autopilot-repo-policy.mjs');
  setRepoPolicy(home,{repo:'acme/outside',deployBranch:'main',by:'사람'});
  assert.equal(JSON.parse(await (await fetch(base+'/api/autopilot/repos')).text()).repos.length,0,'cacheSec 안에는 옛 값');
  const fresh=await fetch(base+'/api/autopilot/repos?fresh=1');assert.equal(fresh.headers.get('x-kadan-cache'),null);
  assert.equal(JSON.parse(await fresh.text()).repos.length,1,'?fresh는 새 값');
  clock=11_000;
  const late=await fetch(base+'/api/autopilot/repos');assert.equal(late.headers.get('x-kadan-cache'),null,'cacheSec가 지나면 다시 읽는다');
 },{now:()=>clock});
});

test('POST는 성공이든 실패(403)든 비우고, 저장 뒤 GET은 새 값이다',async()=>{
 await withServer(async({base,loads})=>{
  const token=await tokenOf(base);
  assert.equal(loads(),1);
  const before=JSON.parse(await (await fetch(base+'/api/autopilot/repos')).text());
  assert.equal(before.repos.length,0);
  assert.equal((await post(base,'/api/autopilot/repos',{token:'bad',repo:'acme/app',deployBranch:'main'})).status,403);
  assert.equal((await fetch(base+'/')).headers.get('x-kadan-cache'),'miss');assert.equal(loads(),2,'실패한 저장도 수집을 비운다');
  assert.equal((await fetch(base+'/api/autopilot/repos')).headers.get('x-kadan-cache'),null,'실패한 저장 뒤 조회도 기억을 비운다');
  const ok=await post(base,'/api/autopilot/repos',{token,repo:'acme/app',deployBranch:'main'});
  assert.ok(ok.status<400,'저장 성공 '+ok.status);
  const after=JSON.parse(await (await fetch(base+'/api/autopilot/repos')).text());
  assert.deepEqual(after.repos.map(r=>r.github),['acme/app'],'저장 직후 조회는 새 값');
  await fetch(base+'/');assert.equal(loads(),3,'성공한 저장도 수집을 비운다');
 });
});

test('autopilot/repos 오류 응답(409)은 기억하지 않는다',async()=>{
 const {createCenterHandler}=await import('../src/center-wall.mjs');
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-cache-409-'));
 fs.writeFileSync(path.join(home,'storage.json'),'garbage'); // 저장소 표식이 깨지면 업무 목록 읽기가 실패한다
 const remembered=[],out={};
 await createCenterHandler(home).handle({method:'GET',headers:{}},{writeHead(s){out.status=s;},end(){}},
  new URL('http://x/api/autopilot/repos'),{remember:(...a)=>remembered.push(a)});
 assert.equal(out.status,409);assert.equal(remembered.length,0,'오류는 기억하지 않는다');
});

test('autopilot/repos GET 뒤 같은 loader를 쓰는 다른 주소의 현황 요청도 공통 수집을 다시 부르지 않는다',async()=>{
 await withServer(async({base,loads})=>{
  const a=await fetch(base+'/api/dashboard/status');assert.equal(a.status,200);await a.text();assert.equal(loads(),1);
  await (await fetch(base+'/api/autopilot/repos')).text();
  const other=await fetch(base+'/api/dashboard/status?probe=1');
  assert.equal(other.status,200);await other.text();
  assert.notEqual(other.headers.get('x-kadan-cache'),'hit','다른 주소라 응답 캐시는 적중하지 않는다');
  assert.equal(loads(),1,'공통 수집(sharedSnapshot)을 재사용해 수집 함수를 다시 부르지 않는다');
 },{center:{cards:[],roles:[],boards:[],unregistered:[],runtimeKnown:true}});
});
