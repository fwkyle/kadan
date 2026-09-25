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
