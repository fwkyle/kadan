// 저장 경계: JSONL 호환 또는 명시적으로 초기화된 SQLite. 자동 폴백 금지.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
const require=createRequire(import.meta.url);
const connections=new Map();
export const storagePath=home=>path.join(home,'kadan.sqlite');
export function storageMode(home){
 const marker=path.join(home,'storage.json');
 if(!fs.existsSync(marker)){if(fs.existsSync(storagePath(home)))throw new Error('SQLite 파일은 있으나 저장소 선택 기록 없음: 자동 JSONL 우회 금지');return 'jsonl';}
 const value=JSON.parse(fs.readFileSync(marker,'utf8'));
 if(value.version!==1||!['jsonl','sqlite'].includes(value.backend))throw new Error('잘못된 저장소 설정');
 return value.backend;
}
export function assertWritable(home){
 if(fs.existsSync(path.join(home,'storage-paused.json')))throw new Error('저장 전환 중: 쓰기와 외부 실행이 중지되었습니다');
}
function driver(){
 if(Number(process.versions.node.split('.')[0])<24)throw new Error('SQLite 저장에는 Node 24 이상이 필요합니다. JSONL은 기존 런타임을 유지할 수 있습니다');
 let sqlite;try{sqlite=require('node:sqlite')}catch{throw new Error('SQLite 저장에는 node:sqlite를 지원하는 Node가 필요합니다');}
 return sqlite.DatabaseSync;
}
const schema=`
CREATE TABLE events (stream TEXT NOT NULL, seq INTEGER NOT NULL CHECK(seq>0), payload TEXT NOT NULL CHECK(json_valid(payload)), source TEXT, source_line INTEGER, raw TEXT, PRIMARY KEY(stream,seq));
CREATE TABLE heads (stream TEXT PRIMARY KEY, seq INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), FOREIGN KEY(stream,seq) REFERENCES events(stream,seq));
CREATE TABLE imports (source TEXT PRIMARY KEY, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, rows INTEGER NOT NULL);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'이력 수정 금지'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'이력 삭제 금지'); END;
CREATE TRIGGER imports_no_update BEFORE UPDATE ON imports BEGIN SELECT RAISE(ABORT,'수입 원본 수정 금지'); END;
CREATE TRIGGER imports_no_delete BEFORE DELETE ON imports BEGIN SELECT RAISE(ABORT,'수입 원본 삭제 금지'); END;
PRAGMA application_id=1262767153;
PRAGMA user_version=1;`;
export function createDatabase(home){
 fs.mkdirSync(home,{recursive:true,mode:0o700});const file=storagePath(home);
 const DB=driver();
 const fd=fs.openSync(file,'wx',0o600);fs.closeSync(fd);
 const db=new DB(file);
 try{db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');db.exec(schema);db.exec('COMMIT');}
 catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e}finally{db.close()}
 return file;
}
export function openDatabase(home,{readOnly=false}={}){
 const file=storagePath(home);
 if(!fs.existsSync(file)||fs.lstatSync(file).isSymbolicLink())throw new Error('SQLite 원본 없음 또는 심볼릭 링크: 자동 생성하지 않습니다');
 const DB=driver(),db=new DB(file,{readOnly});
 try{
  // 쓰기 대기 한도. 부하가 높으면 짧은 쓰기도 CPU를 기다리느라 늦어진다(2026-09-24 부하 110~217에서 5초 초과 실패).
  db.exec('PRAGMA busy_timeout=15000; PRAGMA foreign_keys=ON;');
  if(db.prepare('PRAGMA application_id').get().application_id!==1262767153||db.prepare('PRAGMA user_version').get().user_version!==1)throw new Error('지원하지 않는 SQLite 원본/버전');
  if(!readOnly){db.exec('PRAGMA synchronous=FULL;');if(db.prepare('PRAGMA journal_mode').get().journal_mode!=='wal')throw new Error('SQLite WAL 설정 확인 필요');}
  return db;
 }catch(e){db.close();throw e}
}
export function transaction(home,fn,{readOnly=false}={}){
 const key=path.resolve(home),existing=connections.get(key);
 if(existing){if(existing.readOnly&&!readOnly)throw new Error('읽기 조회 안에서 쓰기 금지');return fn(existing.db)}
 if(!readOnly)assertWritable(home);
 const db=openDatabase(home,{readOnly});
 connections.set(key,{db,readOnly});
 try{db.exec(readOnly?'BEGIN':'BEGIN IMMEDIATE');const out=fn(db);if(out&&typeof out.then==='function')throw new Error('DB 트랜잭션 안에서 비동기/외부 대기 금지');db.exec('COMMIT');return out;}
 catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e}
 finally{connections.delete(key);db.close()}
}
export function storageTransaction(home,fn){return storageMode(home)==='sqlite'?transaction(home,fn):fn();}
// 원장 전체의 마지막 사건 번호. 사건은 지우지 못하므로(삭제 금지 트리거) 무엇이든 추가되면 커진다.
// 잠금 밖에서 미리 계산한 결과가 잠금 안에서도 유효한지 확인하는 데 쓴다. JSONL은 null(미리 계산하지 않음).
export function storageVersion(home){return storageMode(home)==='sqlite'?transaction(home,db=>db.prepare('SELECT max(rowid) AS v FROM events').get().v??0,{readOnly:true}):null;}
// 무거운 계산은 쓰기 잠금 밖에서 먼저 하고, 잠금 안에서는 그 사이 원장이 바뀌지 않았는지만 확인한다.
// 바뀌었거나 미리 계산이 실패했으면 잠금 안에서 다시 계산한다(예전과 같은 결과). 2026-09-24 실측: 우편 ack가
// 잠금을 2.6초, send가 1.5초 쥐어 부하가 높을 때 다른 쓰기(감시 포함)가 busy_timeout을 넘겨 실패했다.
export function prepareOutsideLock(home,compute){
 const version=storageVersion(home);
 let early=null;
 if(version!==null){try{early={value:compute()};}catch{early=null;}}
 // 잠금 안에서 부른다: 그 사이 바뀐 게 없으면 미리 계산한 값, 아니면 다시 계산.
 return ()=>early&&storageVersion(home)===version?early.value:compute();
}
export function preparedTransaction(home,compute,apply){
 const current=prepareOutsideLock(home,compute);
 return storageTransaction(home,()=>apply(current()));
}
export function storageSnapshot(home,fn){return storageMode(home)==='sqlite'?transaction(home,fn,{readOnly:true}):fn();}
export function readStream(home,stream,{optional=false}={}){
 if(storageMode(home)==='jsonl'){
  const f=path.join(home,stream);if(optional&&!fs.existsSync(f))return [];
  return fs.readFileSync(f,'utf8').split('\n').filter(x=>x.trim()).map(JSON.parse);
 }
 return transaction(home,db=>{const rows=db.prepare('SELECT payload FROM events WHERE stream=? ORDER BY seq').all(stream);if(!rows.length&&!optional)throw new Error(`기록 없음: ${stream}`);return rows.map(r=>JSON.parse(r.payload));},{readOnly:true});
}
export function appendStream(home,stream,value){
 assertWritable(home);
 if(storageMode(home)==='jsonl'){fs.mkdirSync(path.dirname(path.join(home,stream)),{recursive:true,mode:0o700});fs.appendFileSync(path.join(home,stream),JSON.stringify(value)+'\n',{mode:0o600});return value;}
 return transaction(home,db=>{appendRow(db,stream,value);return value});
}
export function appendRow(db,stream,value,provenance={}){
 const seq=(db.prepare('SELECT seq FROM heads WHERE stream=?').get(stream)?.seq??0)+1;
 const payload=JSON.stringify(value);
 db.prepare('INSERT INTO events(stream,seq,payload,source,source_line,raw) VALUES(?,?,?,?,?,?)').run(stream,seq,payload,provenance.source??null,provenance.line??null,provenance.raw??null);
 db.prepare('INSERT INTO heads(stream,seq,payload) VALUES(?,?,?) ON CONFLICT(stream) DO UPDATE SET seq=excluded.seq,payload=excluded.payload').run(stream,seq,payload);
}
export function listStreams(home,prefix=''){
 return transaction(home,db=>db.prepare('SELECT stream FROM heads ORDER BY stream').all().map(x=>x.stream).filter(x=>x.startsWith(prefix)),{readOnly:true});
}
export function writeStorageMarker(home,backend){
 const tmp=path.join(home,`.storage-${randomUUID()}.json`);
 fs.writeFileSync(tmp,JSON.stringify({version:1,backend})+'\n',{flag:'wx',mode:0o600});
 fs.renameSync(tmp,path.join(home,'storage.json'));
}
