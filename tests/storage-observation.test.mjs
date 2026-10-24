import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createDatabase,writeStorageMarker,storagePath,storageSnapshot,transaction} from '../src/storage.mjs';
import {storageObservation} from '../src/storage-observation.mjs';

test('관측은 중첩 조회를 중복 집계하지 않고 실패·busy·FULL과 WAL 경계를 보존한다',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-storage-observation-'));
  createDatabase(home);writeStorageMarker(home,'sqlite');
  for(let i=0;i<140;i++)storageSnapshot(home,db=>{
    db.prepare('SELECT count(*) FROM heads').get();
    storageSnapshot(home,()=>assert.ok(storageObservation(home).oldestReadMs>=0));
  });
  assert.throws(()=>storageSnapshot(home,()=>{throw new Error('읽기 실패');}),/읽기 실패/);
  let measured=storageObservation(home);
  assert.equal(measured.read.count,141);assert.equal(measured.read.failed,1);
  assert.equal(measured.read.samples,128);assert.equal(measured.oldestReadMs,null);
  assert.ok(measured.read.maxMs>=measured.read.p95Ms);assert.ok(measured.databaseBytes>0);
  transaction(home,db=>assert.equal(db.prepare('PRAGMA synchronous').get().synchronous,2));
  const writer=new DatabaseSync(storagePath(home)),timeout=process.env.KADAN_BUSY_TIMEOUT_MS;
  try{
    writer.exec('BEGIN IMMEDIATE');process.env.KADAN_BUSY_TIMEOUT_MS='10';
    assert.throws(()=>transaction(home,()=>assert.fail('쓰기 잠금을 얻으면 안 된다')),/locked/);
    measured=storageObservation(home);
    assert.equal(measured.write.failed,1);assert.equal(measured.write.busy,1);
    assert.ok(measured.write.beginMaxMs>=5);
  }finally{
    writer.exec('ROLLBACK');writer.close();
    if(timeout===undefined)delete process.env.KADAN_BUSY_TIMEOUT_MS;
    else process.env.KADAN_BUSY_TIMEOUT_MS=timeout;
  }
  assert.equal(storageObservation(home).checkpoint,'not-run');
});

test('관측만 하면 빈 홈에 DB·설정·WAL을 만들지 않는다',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-observation-empty-'));
  const value=storageObservation(home);
  assert.equal(value.databaseBytes,0);assert.equal(value.walBytes,0);
  assert.equal(value.read.count,0);assert.deepEqual(fs.readdirSync(home),[]);
});
