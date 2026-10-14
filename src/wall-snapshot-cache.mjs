// 대시보드 조회 재사용. 원장(events)은 지우거나 고치지 못하는 기록이라 마지막 사건 번호(storageVersion)가
// 같으면 원장에서 읽은 값도 같다. 카드 본문(card.md)은 파일이라 개수·최신 수정 시각·크기를 함께 본다.
// 2026-10-14 실측(원장 사본, 부하 25): 조회 한 번에 카드 상태 계산 4~6초, 원장 읽기 0.5~1.1초,
// 카드 읽기 0.4초, 업무 목록 계산 2.3초가 매번 반복됐다.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {storageMode,storageVersion} from './storage.mjs';

// 데이터가 안 바뀌어도 이 시간이 지나면 다시 계산한다(원장 밖 파일이나 시계 때문에 어긋난 값이 남지 않게 하는 안전망).
export const DERIVED_MAX_AGE_MS=10*60_000;
// 업무 후속 판정은 경과 시간처럼 지금 시각에 따라 달라지는 값이 섞여 있어 더 짧게 둔다.
export const TIME_DEPENDENT_MAX_AGE_MS=60_000;

// 카드마다 경로·크기·수정 시각·상태 변경 시각·inode를 묶어 해시한다. 합계로 보면 서로 다른 변경이 같은 값이 될 수 있고,
// 상태 변경 시각(ctime)은 내용을 쓰면 수정 시각을 되돌려도 바뀐다(cp -p·touch -r 같은 복원도 잡는다). 내용 해시는 하지 않는다:
// 카드 1,761장을 매번 읽는 비용이 들고, 일반 CLI 변경은 원장 사건으로 이미 잡힌다.
export function cardFilesFingerprint(home){
 const root=path.join(home,'cards'),hash=createHash('sha1');let count=0;
 let repos;try{repos=fs.readdirSync(root,{withFileTypes:true});}catch{return '0:none';}
 for(const repo of repos){
  if(!repo.isDirectory()||repo.name.startsWith('.'))continue;
  let cards;try{cards=fs.readdirSync(path.join(root,repo.name),{withFileTypes:true});}catch{continue;}
  for(const card of cards){
   if(!card.isDirectory())continue;
   const file=path.join(root,repo.name,card.name,'card.md');count++;
   try{const stat=fs.statSync(file);hash.update(`${repo.name}/${card.name}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}\n`);}
   catch{hash.update(`${repo.name}/${card.name}:missing\n`);}
  }
 }
 return `${count}:${hash.digest('hex')}`;
}

// 카드에 적힌 시각 중 지금보다 뒤인 가장 이른 시각. 상태 판정이 "시각이 지났는가"를 보므로(예: 진행 보고 시각이 현재보다 뒤면
// 아직 반영하지 않음), 그 시각이 지나면 같은 데이터라도 결과가 달라진다. 재사용은 이 시각까지만 한다.
export function nextTimeBoundary(cards,now){
 let next=Infinity;
 const see=value=>{const t=Date.parse(value);if(t>now&&t<next)next=t;};
 for(const card of cards??[]){see(card.at);see(card.activityAt);for(const h of card.history??[]){see(h.at);see(h.activityAt);}for(const r of card.runs??[]){see(r.sentAt);see(r.at);}}
 return next===Infinity?null:next;
}

// 저장소 전환 없이 쓰는 SQLite일 때만 데이터 버전을 만든다. JSONL이거나 읽기 실패면 null이고, null이면 재사용하지 않는다.
// 읽기 조회(storageSnapshot) 안에서 불러야 읽은 값과 같은 시점의 버전이 된다.
export function dataVersion(home){
 try{
  if(storageMode(home)!=='sqlite')return null;
  return `${path.resolve(home)}|${storageVersion(home)}|${cardFilesFingerprint(home)}`;
 }catch{return null;}
}

export function createSnapshotCache({now=()=>Date.now(),maxAgeMs=DERIVED_MAX_AGE_MS}={}){
 const slots=new Map(),stats={};
 const count=(name,kind)=>{(stats[name]??={hit:0,miss:0})[kind]++;};
 return {
  // 같은 이름에는 가장 최근 하나만 둔다. 키가 같고 너무 오래되지 않았으면 이전 값을 그대로 준다.
  // boundary: 계산 직후 부르는 함수. 숫자(ms)를 주면 그 시각이 지난 뒤에는 데이터가 같아도 다시 계산한다.
  memo(name,key,compute,{maxAge=maxAgeMs,boundary=null}={}){
   if(key==null){count(name,'miss');return compute();}
   const hit=slots.get(name),at=now();
   if(hit&&hit.key===key&&at-hit.at<maxAge&&(hit.until==null||at<hit.until)){count(name,'hit');return hit.value;}
   const value=compute();
   slots.set(name,{key,value,at:now(),until:boundary?boundary():null});count(name,'miss');return value;
  },
  clear(){slots.clear();},
  stats:()=>JSON.parse(JSON.stringify(stats)),
 };
}

export const wallCache=createSnapshotCache();
