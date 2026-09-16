import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runWatch} from './helpers/watch-runner.mjs';
import {appendLedger,readLedger} from '../src/ledger.mjs';
import {createDatabase,writeStorageMarker,readStream} from '../src/storage.mjs';
import {readWatchProfile} from '../src/watch-profile.mjs';

const role='p-worker', session=`kadan-${role}`, epoch=Date.parse('2026-09-16T00:00:00Z');
async function exercise(mode, doneCycle, graceMinutes) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-complete-grace-'));
  if(mode==='sqlite'){createDatabase(home);writeStorageMarker(home,'sqlite');}
  let cycle=0;
  const records=[],messages=[],stop=new Error('finished');
  const at=n=>new Date(epoch+n*60_000).toISOString();
  appendLedger({kind:'start',role,session,panePid:1,t:at(-2)},home);
  for(const taskId of ['a','other'])appendLedger({kind:'send',role,session,taskId,executionKey:`repo/${taskId}`,t:at(-1)},home);
  const complete=()=>appendLedger({kind:'done',role,taskId:'a',executionKey:'repo/a',result:'ok',t:at(cycle)},home);
  if(doneCycle===0)complete();
  const load=os.loadavg;os.loadavg=()=>[0,0,0];
  try {
    await assert.rejects(()=>runWatch({
      floor:{list:()=>[{session,pid:1}],read:()=>cycle===0?'KADAN:DONE repo/a ok':'working'},
      readEntries:()=>readLedger(home),
      readCards:()=>['a','other'].map(id=>({key:`repo/${id}`,id,role,status:'assigned',workType:'execution',activity:'running',activityRole:role,activityAt:at(0)})),
      ...(graceMinutes===undefined?{}:{completionGraceMs:graceMinutes*60_000}),
      record:entry=>records.push({...entry,cycle}),sendAlert:(role,message)=>messages.push({role,message,cycle}),
      intervalMs:60_000,stallN:100,routes:new Map([['p','p-boss']]),superRole:'p-boss',
      now:()=>epoch+cycle*60_000,print:()=>{},
      spawn:cmd=>{
        if(cmd==='sleep'){
          cycle++;
          if(cycle===doneCycle)complete();
          if(cycle===18)throw stop;
        }
        if(cmd==='memory_pressure')return {status:0,stdout:'System-wide memory free percentage: 80%'};
        if(cmd==='sysctl')return {status:0,stdout:'used = 0M'};
        return {status:0,stdout:''};
      },
    }),e=>e===stop);
  } finally {os.loadavg=load;}
  assert.equal(readStream(home,'ledger.jsonl',{optional:true}).length,0);
  assert.equal(readStream(home,'tasks/events.jsonl').filter(e=>e.kind==='done').length,doneCycle===null?0:1);
  return {alerts:records.filter(e=>e.alertKind==='완료후보'),messages};
}

test('유예 안 tasks done: 마커가 사라져도 완료후보와 해소 우편 없음',async()=>{
  for(const mode of ['jsonl','sqlite']){
    const result=await exercise(mode,1);
    assert.deepEqual(result.alerts,[]);assert.deepEqual(result.messages,[]);
  }
});

test('done 없이 유예 경과: 기본 15분 및 설정 시각에 경보 한 건',async()=>{
  const profile=readWatchProfile('/tmp/grace-profile.json',()=>JSON.stringify({flags:{'completion-grace':2}}));
  assert.equal(profile.flags['completion-grace'],'2');
  for(const mode of ['jsonl','sqlite'])for(const minutes of [undefined,Number(profile.flags['completion-grace'])]){
    const result=await exercise(mode,null,minutes);
    assert.equal(result.alerts.filter(e=>!e.resolved).length,1);assert.equal(result.alerts[0].cycle,minutes??15);
    assert.equal(result.alerts[0].resolved,undefined);assert.equal(result.messages.filter(e=>!e.message.includes('해소됨')).length,1);
  }
});

test('사전 tasks done: executionKey와 전체 주소 마커 대조로 경보 없음',async()=>{
  for(const mode of ['jsonl','sqlite']){
    const result=await exercise(mode,0);
    assert.deepEqual(result.alerts,[]);assert.deepEqual(result.messages,[]);
  }
});
