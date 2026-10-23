// 새 홈 초기화 잠금(.storage-init.lock). 주인(owner.json: pid·시작 시각·host)을 적어, 초기화 도중 강제 종료된
// 프로세스가 남긴 잠금을 원인을 알고 회수한다. 원인을 모르는 잠금은 지우지 않는다(dir-lock.mjs와 같은 원칙).
// dir-lock.mjs의 공용 동작(JSONL 잠금)은 바꾸지 않고, 이 잠금만 주인을 적는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pidAlive} from './pid-alive.mjs';
import {underTest} from './test-home-guard.mjs';

export const INIT_LOCK='.storage-init.lock';
const WAIT_MS=5000,POLL_MS=25;
const lexists=file=>{try{fs.lstatSync(file);return true}catch{return false}};
const sleep=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
const stamp=()=>new Date().toISOString().replace(/[-:.]/g,'');
export const unknownOwnerError=lock=>new Error(`초기화 잠금이 남아 있고 주인을 알 수 없습니다: ${lock}. 초기화 중인 kadan 프로세스가 없으면 이 폴더를 ${path.join(path.dirname(lock),'.trash')}/로 옮긴 뒤 다시 실행하세요.`);

// 시험 전용 중단 고리: 시험 중이고 환경 변수가 이 지점을 가리킬 때만 자기 프로세스를 SIGKILL한다. 운영에서는 꺼져 있다.
export function testKillPoint(point){
 if(process.env.KADAN_TEST_INIT_KILL===point&&underTest())process.kill(process.pid,'SIGKILL');
}

// 잠금 상태: none(없음) / alive(주인 살아 있음) / dead(주인 죽음) / unknown(owner.json 없음·깨짐).
// host는 기록만 하고 판정에 쓰지 않는다: 홈과 PID는 이 기계 안의 것이고, 기계 이름이 바뀌면 영구 수동 복구가 된다.
export function inspectInitLock(home){
 const lock=path.join(home,INIT_LOCK);
 if(!lexists(lock))return {state:'none',lock};
 let owner;
 try{owner=JSON.parse(fs.readFileSync(path.join(lock,'owner.json'),'utf8'))}catch{return {state:'unknown',lock}}
 if(!owner||!Number.isInteger(owner.pid)||owner.pid<=0)return {state:'unknown',lock};
 return {state:pidAlive(owner.pid)?'alive':'dead',lock,owner};
}

// 주인을 적은 임시 폴더를 만들어 rename으로 한 번에 잠금을 얻는다. 얻으면 true, 남이 먼저면 false.
// POSIX rename은 대상이 '빈' 폴더이면 성공해서 덮어쓴다(내용이 있을 때만 ENOTEMPTY/EEXIST). 그래서 rename 전에
// 'owner.json 없는 잠금'을 먼저 막는다(unknown). 검사와 rename 사이의 틈(TOCTOU)은 받아들인다: 이 코드가 머지되면
// 빈 초기화 잠금을 만드는 코드는 없어지므로 빈 잠금은 옛 버전이 남긴 것뿐이다.
function create(lock){
 const tmp=`${lock}.tmp-${process.pid}-${randomUUID().slice(0,8)}`;
 fs.mkdirSync(tmp,{mode:0o700});
 try{
  fs.writeFileSync(path.join(tmp,'owner.json'),JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),host:os.hostname()})+'\n');
  if(lexists(lock)){
   if(!lexists(path.join(lock,'owner.json')))throw unknownOwnerError(lock);
   fs.rmSync(tmp,{recursive:true,force:true});return false;
  }
  fs.renameSync(tmp,lock);return true;
 }catch(e){
  fs.rmSync(tmp,{recursive:true,force:true});
  if(e.code==='ENOTEMPTY'||e.code==='EEXIST')return false;
  throw e;
 }
}

// 죽은 주인의 잠금을 지우지 않고 <home>/.trash/storage-init-<시각>-<pid>/로 옮겨 원문을 보존한다.
// 두 쪽이 동시에 회수하면 늦은 쪽은 ENOENT: 남이 이미 회수한 것이므로 오류가 아니다. 옮긴 폴더의 주인이 우리가 본
// 죽은 주인이 아니면(그 사이 남이 새 잠금을 만들었다) 되돌려 놓고 다시 판정한다.
function reclaim(home,seen){
 const trash=path.join(home,'.trash');fs.mkdirSync(trash,{recursive:true,mode:0o700});
 const base=`storage-init-${stamp()}-${seen.owner.pid}`;
 let dest=path.join(trash,base);
 for(let i=0;;i++){
  try{fs.renameSync(seen.lock,dest);break}
  catch(e){
   if(e.code==='ENOENT')return null;
   if((e.code==='ENOTEMPTY'||e.code==='EEXIST')&&i<5){dest=path.join(trash,`${base}-${process.pid}-${i}`);continue}
   throw e;
  }
 }
 let moved=null;try{moved=JSON.parse(fs.readFileSync(path.join(dest,'owner.json'),'utf8')).pid}catch{}
 if(moved!==seen.owner.pid){try{fs.renameSync(dest,seen.lock)}catch{}return null}
 return dest;
}

// 잠금을 얻는다. 반환: {reclaimed} — 죽은 주인의 잠금을 이번 호출이 회수했으면 옮겨 둔 폴더 경로, 아니면 null.
// 주인이 살아 있으면 기다리고(최대 waitMs), 주인을 모르면 기다리지 않고 즉시 오류를 낸다.
export function acquireInitLock(home,{waitMs=WAIT_MS}={}){
 const lock=path.join(home,INIT_LOCK),deadline=Date.now()+waitMs;
 let reclaimed=null;
 for(;;){
  const seen=inspectInitLock(home);
  if(seen.state==='unknown')throw unknownOwnerError(lock);
  if(seen.state==='dead'){reclaimed=reclaim(home,seen)??reclaimed;continue}
  if(seen.state==='none'){if(create(lock))return {reclaimed};continue}
  if(Date.now()>=deadline)throw new Error(`저장소 초기화 중: 다른 kadan 프로세스(pid ${seen.owner.pid})가 초기화하고 있습니다. 잠시 뒤 다시 시도하세요 (${lock})`);
  sleep(POLL_MS);
 }
}

// 반납: 잠금을 먼저 이름을 바꿔 치워 잠금이 한 번에 사라지게 한 뒤 지운다. owner.json을 먼저 지우면 빈 잠금이
// 잠깐 보여 다른 쪽이 '주인 모름'으로 오판한다.
export function releaseInitLock(home){
 const lock=path.join(home,INIT_LOCK),gone=`${lock}.done-${process.pid}-${randomUUID().slice(0,8)}`;
 try{fs.renameSync(lock,gone)}catch(e){if(e.code==='ENOENT')return;throw e}
 fs.rmSync(gone,{recursive:true,force:true});
}

// 읽기 쪽 대기: 주인이 살아 있을 때만 잠깐 기다린다. 잠금이 없거나 주인이 죽었거나 모르면 기다리지 않는다.
export function waitForLiveInit(home,waitMs){
 const deadline=Date.now()+waitMs;
 while(inspectInitLock(home).state==='alive'){
  if(Date.now()>=deadline)return false;
  sleep(POLL_MS);
 }
 return true;
}
