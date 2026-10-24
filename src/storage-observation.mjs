// Why: DB를 붙잡는 시간과 WAL 크기를 원본 쓰기나 checkpoint 없이 확인한다.
// 10배 이력에서도 관측 메모리는 홈 8개, 읽기/쓰기별 최근 128건으로 제한된다.
import fs from 'node:fs';
import path from 'node:path';

const homes=new Map(),LIMIT=128;
const counter=()=>({count:0,failed:0,busy:0,totalMs:0,maxMs:0,beginMaxMs:0,recent:[]});
function state(home){
  const key=path.resolve(home);
  let value=homes.get(key);
  if(!value){
    if(homes.size>=8)homes.delete(homes.keys().next().value);
    value={read:counter(),write:counter(),readSince:null};homes.set(key,value);
  }
  return value;
}
export function observeTransaction(home,readOnly){
  const value=state(home),stats=readOnly?value.read:value.write,started=performance.now();
  if(readOnly)value.readSince=started;
  let beginMs=null;
  return {
    began(){beginMs=performance.now()-started;},
    end(error){
      const elapsed=performance.now()-started;
      stats.count++;stats.failed+=Number(Boolean(error));
      stats.busy+=Number([5,6].includes(Number(error?.errcode)&255));
      stats.totalMs+=elapsed;stats.maxMs=Math.max(stats.maxMs,elapsed);
      stats.beginMaxMs=Math.max(stats.beginMaxMs,beginMs??elapsed);
      if(stats.recent.length===LIMIT)stats.recent.shift();
      stats.recent.push(elapsed);
      if(readOnly)value.readSince=null;
    },
  };
}
const bytes=file=>{
  try{return fs.statSync(file).size;}catch(error){return error.code==='ENOENT'?0:null;}
};
const summary=({recent,...rest})=>{
  const sorted=[...recent].sort((a,b)=>a-b);
  return {...rest,samples:sorted.length,p95Ms:sorted[Math.ceil(sorted.length*.95)-1]??null,
    lastMs:recent.at(-1)??null};
};
export function storageObservation(home){
  const value=state(home),file=path.join(home,'kadan.sqlite');
  return {pid:process.pid,scope:'this-process',sampleLimit:LIMIT,observedAt:new Date().toISOString(),
    read:summary(value.read),write:summary(value.write),
    oldestReadMs:value.readSince===null?null:performance.now()-value.readSince,
    databaseBytes:bytes(file),walBytes:bytes(file+'-wal'),checkpoint:'not-run'};
}
