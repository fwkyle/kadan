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
  assert.equal(other.headers.get('x-kadan-cache'),'miss');assert.equal(loads,3,'주소가 다르면 따로 센다');
  const token=(await (await fetch(base+'/')).text()).match(/name="token" value="([a-f0-9]+)"/)[1];
  const post=await fetch(base+'/cards/update',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:base},body:new URLSearchParams({token,key:'repo/none',revision:'1',note:'없는 카드'})});
  assert.ok(post.status>=400);
  const flushed=await fetch(base+'/');
  assert.equal(flushed.headers.get('x-kadan-cache'),'miss');assert.equal(loads,4,'저장 시도 뒤에는 캐시를 비운다');
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

