// 대시보드 조회 재사용. 원장(events)은 지우거나 고치지 못하는 기록이라 마지막 사건 번호(storageVersion)가
// 같으면 원장에서 읽은 값도 같다. 카드 본문(card.md)은 파일이라 개수·최신 수정 시각·크기를 함께 본다.
// 2026-10-14 실측(원장 사본, 부하 25): 조회 한 번에 카드 상태 계산 4~6초, 원장 읽기 0.5~1.1초,
// 카드 읽기 0.4초, 업무 목록 계산 2.3초가 매번 반복됐다.
import fs from 'node:fs';
import path from 'node:path';
import {storageMode,storageVersion} from './storage.mjs';

// 데이터가 안 바뀌어도 이 시간이 지나면 다시 계산한다(원장 밖 파일이나 시계 때문에 어긋난 값이 남지 않게 하는 안전망).
export const DERIVED_MAX_AGE_MS=10*60_000;
// 업무 후속 판정은 경과 시간처럼 지금 시각에 따라 달라지는 값이 섞여 있어 더 짧게 둔다.
export const TIME_DEPENDENT_MAX_AGE_MS=60_000;

export function cardFilesFingerprint(home){
 const root=path.join(home,'cards');let count=0,newest=0,bytes=0;
 let repos;try{repos=fs.readdirSync(root,{withFileTypes:true});}catch{return '0:0:0';}
 for(const repo of repos){
  if(!repo.isDirectory()||repo.name.startsWith('.'))continue;
  let cards;try{cards=fs.readdirSync(path.join(root,repo.name),{withFileTypes:true});}catch{continue;}
  for(const card of cards){
   if(!card.isDirectory())continue;
   try{const stat=fs.statSync(path.join(root,repo.name,card.name,'card.md'));count++;newest=Math.max(newest,stat.mtimeMs);bytes+=stat.size;}catch{count++;}
  }
 }
 return `${count}:${newest}:${bytes}`;
}

// 저장소 전환 없이 쓰는 SQLite일 때만 데이터 버전을 만든다. JSONL이거나 읽기 실패면 null이고, null이면 재사용하지 않는다.
// 읽기 조회(storageSnapshot) 안에서 불러야 읽은 값과 같은 시점의 버전이 된다.
export function dataVersion(home){
 try{
  if(storageMode(home)!=='sqlite')return null;
  return `${path.resolve(home)}|${storageVersion(home)}|${cardFilesFingerprint(home)}`;
 }catch{return null;}
}

export function createSnapshotCache({now=Date.now,maxAgeMs=DERIVED_MAX_AGE_MS}={}){
 const slots=new Map(),stats={};
 const count=(name,kind)=>{(stats[name]??={hit:0,miss:0})[kind]++;};
 return {
  // 같은 이름에는 가장 최근 하나만 둔다. 키가 같고 너무 오래되지 않았으면 이전 값을 그대로 준다.
  memo(name,key,compute,{maxAge=maxAgeMs}={}){
   if(key==null){count(name,'miss');return compute();}
   const hit=slots.get(name);
   if(hit&&hit.key===key&&now()-hit.at<maxAge){count(name,'hit');return hit.value;}
   const value=compute();
   slots.set(name,{key,value,at:now()});count(name,'miss');return value;
  },
  clear(){slots.clear();},
  stats:()=>JSON.parse(JSON.stringify(stats)),
 };
}

export const wallCache=createSnapshotCache();
