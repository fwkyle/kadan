// 저장 경계: SQLite 하나. 저장소가 아직 없는 홈은 'none'(읽기는 빈 결과, 첫 쓰기에서 만든다). 자동 폴백 금지.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {assertTestHome,underTest} from './test-home-guard.mjs';
const require=createRequire(import.meta.url);
const connections=new Map();
export const storagePath=home=>path.join(home,'kadan.sqlite');
const APP_ID=1262767153; // PRAGMA application_id: 카단 저장소 표식
const BUSY_MS=()=>Number(process.env.KADAN_BUSY_TIMEOUT_MS)||15000;
// 시험 전용 중단 고리: 시험 중이고 환경 변수가 이 지점을 가리킬 때만 자기 프로세스를 SIGKILL한다. 운영에서는 꺼져 있다.
const testKillPoint=point=>{if(process.env.KADAN_TEST_INIT_KILL===point&&underTest())process.kill(process.pid,'SIGKILL')};
const DB_FILES=['kadan.sqlite','kadan.sqlite-wal','kadan.sqlite-shm'];
// 표시 파일이 없는데 이 중 하나라도 있으면 새 홈이 아니다. -wal/-shm은 DB 파일 쪽(DB만 있음)에서 따로 본다.
const TRACE_FILES=['ledger.jsonl','decisions/events.jsonl','tasks/events.jsonl','mail/events.jsonl','system/events.jsonl','explain-ai.jsonl','storage-import.json','storage-paused.json'];
const TRACE_IN_CARD=['events.jsonl','briefs.jsonl','card.md'];
const lexists=file=>{try{fs.lstatSync(file);return true}catch{return false}};
const subdirs=dir=>{try{return fs.readdirSync(dir,{withFileTypes:true}).filter(d=>d.isDirectory()||d.isSymbolicLink()).map(d=>d.name).sort()}catch{return []}};
// 첫 흔적 경로(없으면 null). 끊어진 링크도 흔적이다: 있는 척하는 파일을 새 홈으로 덮지 않는다.
function legacyTrace(home){
 const hit=rel=>{const f=path.join(home,rel);return lexists(f)?f:null};
 for(const rel of TRACE_FILES){const f=hit(rel);if(f)return f}
 for(const rel of ['cards','works'])for(const a of subdirs(path.join(home,rel)))for(const b of subdirs(path.join(home,rel,a)))
  for(const name of rel==='cards'?TRACE_IN_CARD:['events.jsonl']){const f=hit(path.join(rel,a,b,name));if(f)return f}
 return null;
}
const dbTrace=home=>{for(const name of DB_FILES){const f=path.join(home,name);if(lexists(f))return f}return null};
const dbError=(file,cause)=>new Error(`SQLite 파일은 있으나 저장소 선택 기록 없음: 자동 JSONL 우회 금지 (${file})${cause?`: ${cause.message}`:''}`,{cause});
// application_id와 테이블 수를 한 문장으로 읽는다. 두 문장으로 나누면 그 사이에 다른 프로세스가 스키마를 커밋해
// '표식 없음 + 테이블 있음'(=남의 DB)으로 잘못 보인다(동시 첫 쓰기 시험에서 실제로 재현됨).
const dbMark=db=>db.prepare('SELECT (SELECT application_id FROM pragma_application_id) AS id, (SELECT user_version FROM pragma_user_version) AS v, (SELECT count(*) FROM sqlite_master) AS n').get();
// 카단 DB = 표식과 버전이 모두 맞다. 표식만 같고 버전이 다르면 남의 DB와 같게 다룬다(WAL 전환도 표시 파일 쓰기도 하지 않는다).
const isKadan=m=>m.id===APP_ID&&m.v===1;
const isEmpty=m=>m.id===0&&m.v===0&&m.n===0;
// SQLite가 '데이터베이스 파일이 아님'(깨진 파일)이라고 한 오류만 찾는다. 잠김(BUSY) 같은 다른 오류는 그대로 올린다.
const notDatabase=e=>e?.errcode===26||/not a database|malformed/i.test(String(e?.message));
// 표시 파일이 없는 홈의 DB가 어떤 상태인지 읽기 전용으로 본다(파일을 쓰거나 옮기지 않는다).
// kadan: 카단 application_id 표식 / empty: 표식도 테이블도 없는 빈 DB(초기화 전) / foreign: 그 밖(다른 DB, 깨진 파일, 링크, -wal만 남음).
function unmarkedDb(home){
 const file=storagePath(home);
 try{if(fs.lstatSync(file).isSymbolicLink())return 'foreign'}catch{return 'foreign'}
 const DB=driver();let db;
 try{
  db=new DB(file,{readOnly:true,timeout:2000});
  const mark=dbMark(db);
  if(isKadan(mark))return 'kadan';
  return isEmpty(mark)?'empty':'foreign';
 }catch(e){if(notDatabase(e))return 'foreign';throw e}
 finally{db?.close()}
}
// 'sqlite' | 'none'. 'none' = 표시 파일도 카단 DB도 없는 새 홈: 읽는 쪽은 DB를 열지 않고 빈 결과를 돌려주고, 첫 쓰기가 SQLite를 만든다.
// 표시 파일이 없는 홈: 카단 표식이 찍힌 DB는 sqlite로 연다(읽기는 아무것도 쓰지 않는다).
// 빈 DB는 초기화 전과 같아 새 홈('none')으로 본다(옛 흔적이 함께 있으면 오류). 그 밖의 DB는 기존 오류.
// 오류는 표시 파일이 backend:'jsonl'인 옛 저장소 하나뿐이다: JSONL로 몰래 내려가지 않고 변환 방법을 안내한다.
export function storageMode(home){
 const marker=path.join(home,'storage.json');
 if(!fs.existsSync(marker)){
  if(!dbTrace(home))return 'none';
  const state=unmarkedDb(home);
  if(state==='kadan')return 'sqlite';
  if(state==='empty'&&!legacyTrace(home))return 'none';
  throw dbError(storagePath(home));
 }
 const value=JSON.parse(fs.readFileSync(marker,'utf8'));
 if(value.version!==1||!['jsonl','sqlite'].includes(value.backend))throw new Error('잘못된 저장소 설정');
 if(value.backend==='jsonl')throw new Error(`옛 JSONL 저장소입니다(${marker}). 이 버전은 JSONL 저장을 지원하지 않습니다. 옛 JSONL 홈은 태그 jsonl-last의 kadan storage import로 변환하세요.`);
 return 'sqlite';
}
function guardWritable(home){
 assertTestHome(home);
 if(fs.existsSync(path.join(home,'storage-paused.json')))throw new Error('저장 전환 중: 쓰기와 외부 실행이 중지되었습니다');
}
// 새 홈만 SQLite로 시작한다. 표시 파일이 있으면 건드리지 않고 storageMode로 검증만 한다(옛 JSONL 표시면 오류).
// 표시 파일이 없을 때: 옛 JSONL 흔적이 있으면 오류(빈 결과나 재생성으로 숨기지 않는다). 아니면 SQLite 자체 잠금으로 DB를 만든다.
// 폴더 잠금·주인 기록·회수는 없다: 프로세스가 죽으면 OS가 SQLite 파일 잠금을 풀어 주므로 남는 잠금이 없다.
// 코드는 어떤 경우에도 kadan.sqlite*를 옮기거나 지우지 않는다.
export function ensureStorage(home){
 guardWritable(home);
 if(fs.existsSync(path.join(home,'storage.json'))){storageMode(home);return}
 fs.mkdirSync(home,{recursive:true,mode:0o700});
 const trace=legacyTrace(home);
 if(trace)throw new Error(`옛 저장소 흔적이 있습니다(${trace}). 이 버전은 새 홈만 자동으로 SQLite로 시작합니다. 옛 JSONL 홈은 태그 jsonl-last의 kadan storage import로 변환하세요.`);
 initDatabase(home);
 testKillPoint('commit');
 writeStorageMarker(home,'sqlite'); // 커밋 뒤에 쓴다. 내용이 같고 임시 파일+rename이라 여럿이 동시에 써도 해가 없다
}
// 새 DB를 WAL로 바꾸는 순간 다른 연결이 잠그고 있으면 busy 대기가 적용되지 않고 곧바로 SQLITE_BUSY(5)·LOCKED(6)가 난다.
// 동시에 몰린 첫 쓰기가 실제로 이 오류로 실패했다(시험 경쟁 (a), 10회 중 1회). 한도 안에서 짧게 다시 시도한다.
function enableWal(db){
 const end=Date.now()+BUSY_MS();
 for(;;){
  try{db.exec('PRAGMA journal_mode=WAL');return}
  catch(e){if((e?.errcode!==5&&e?.errcode!==6)||Date.now()>=end)throw e;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}
 }
}
// 파일을 열거나 만들고 BEGIN IMMEDIATE 안에서 스키마를 마저 만든다. 동시에 들어온 쪽은 SQLite 잠금에서 줄을 서고,
// 앞 쪽이 끝낸 뒤 들어오면 이미 카단 표식이 있어 아무것도 하지 않는다. 스키마 도중 죽으면 롤백되어 다음 IMMEDIATE가 마저 만든다.
function initDatabase(home){
 const file=storagePath(home);
 // 본 파일 없이 -wal/-shm만 남은 홈은 다른 DB의 잔해일 수 있다. -wal을 먼저 보고 본 파일을 나중에 본다: 다른 프로세스가
 // 막 만드는 중이면 본 파일이 -wal보다 먼저 생기므로, 이 순서면 만드는 중인 정상 DB를 잔해로 오판하지 않는다.
 const leftover=lexists(`${file}-wal`)||lexists(`${file}-shm`),exists=lexists(file);
 if(exists&&fs.lstatSync(file).isSymbolicLink())throw dbError(file);
 if(leftover&&!exists)throw dbError(file);
 const DB=driver();let db;
 try{
  db=new DB(file);
  db.exec(`PRAGMA busy_timeout=${BUSY_MS()}; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;`);
  // 남의 DB는 WAL 전환(헤더 쓰기)조차 하지 않도록, 아무것도 쓰기 전에 읽기만으로 먼저 거른다.
  const foreign=()=>{const mark=dbMark(db);return !isKadan(mark)&&!isEmpty(mark)};
  if(foreign())throw dbError(file);
  enableWal(db);
  db.exec('BEGIN IMMEDIATE');
  // 잠금을 얻은 뒤 다시 판정한다(그 사이 다른 프로세스가 끝냈으면 이미 카단 표식이 있어 아무것도 하지 않는다).
  if(foreign())throw dbError(file);
  if(!isKadan(dbMark(db))){
   testKillPoint('schema');
   db.exec(schema);
  }
  db.exec('COMMIT');
 }catch(e){
  if(db?.isTransaction)db.exec('ROLLBACK');
  throw notDatabase(e)?dbError(file,e):e;
 }finally{db?.close()}
}
export function assertWritable(home){
 guardWritable(home);
 ensureStorage(home);
}
function driver(){
 if(Number(process.versions.node.split('.')[0])<24)throw new Error('SQLite 저장에는 Node 24 이상이 필요합니다');
 let sqlite;try{sqlite=require('node:sqlite')}catch{throw new Error('SQLite 저장에는 node:sqlite를 지원하는 Node가 필요합니다');}
 return sqlite.DatabaseSync;
}
const schema=`
CREATE TABLE IF NOT EXISTS events (stream TEXT NOT NULL, seq INTEGER NOT NULL CHECK(seq>0), payload TEXT NOT NULL CHECK(json_valid(payload)), source TEXT, source_line INTEGER, raw TEXT, PRIMARY KEY(stream,seq));
CREATE TABLE IF NOT EXISTS heads (stream TEXT PRIMARY KEY, seq INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), FOREIGN KEY(stream,seq) REFERENCES events(stream,seq));
CREATE TABLE IF NOT EXISTS imports (source TEXT PRIMARY KEY, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, rows INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'이력 수정 금지'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'이력 삭제 금지'); END;
CREATE TRIGGER IF NOT EXISTS imports_no_update BEFORE UPDATE ON imports BEGIN SELECT RAISE(ABORT,'수입 원본 수정 금지'); END;
CREATE TRIGGER IF NOT EXISTS imports_no_delete BEFORE DELETE ON imports BEGIN SELECT RAISE(ABORT,'수입 원본 삭제 금지'); END;
PRAGMA application_id=${APP_ID};
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
  db.exec(`PRAGMA busy_timeout=${Number(process.env.KADAN_BUSY_TIMEOUT_MS)||15000}; PRAGMA foreign_keys=ON;`); // Stop 훅은 환경값으로 짧게 줄인다
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
export function storageTransaction(home,fn){return transaction(home,fn);}
// 원장 전체의 마지막 사건 번호. 사건은 지우지 못하므로(삭제 금지 트리거) 무엇이든 추가되면 커진다.
// 잠금 밖에서 미리 계산한 결과가 잠금 안에서도 유효한지 확인하는 데 쓴다. 'none'(저장소 없음)은 null이라 미리 계산하지 않는다.
export function storageVersion(home){return storageMode(home)==='none'?null:transaction(home,db=>db.prepare('SELECT max(rowid) AS v FROM events').get().v??0,{readOnly:true});}
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
// 'none'(저장소 없음)이면 DB를 열지 않고 fn()만 부른다(db 인자 없음): 읽는 쪽은 빈 결과를 만든다.
export function storageSnapshot(home,fn){return storageMode(home)==='none'?fn():transaction(home,fn,{readOnly:true});}
// slim: 사건 종류별로 큰 필드를 뺀 채 읽는 규칙 목록 [{kind 또는 prefix, drop:[필드]}]. 원본 JSON에서 지정 필드만 빼므로
// 나머지 필드의 값과 JSON 자료형(true·문자열 등)은 그대로다. SQLite는 SQL 안에서 빼서 큰 문자열이 JS 힙에 오르지 않는다.
function slimSql(rules){
 const args=[],kind="json_extract(payload,'$.kind')";
 const when=rules.map(rule=>{
  args.push(rule.kind??rule.prefix);for(const k of rule.drop)args.push(`$.${k}`);
  const test=rule.kind?`${kind}=?`:`substr(${kind},1,${rule.prefix.length})=?`;
  return `WHEN ${test} THEN json_remove(payload,${rule.drop.map(()=>'?').join(',')})`;
 });
 return {expr:`CASE ${when.join(' ')} ELSE payload END`,args};
}
export function readStream(home,stream,{optional=false,slim=null,after=null}={}){
 if(storageMode(home)==='none'){if(!optional&&after===null)throw new Error(`기록 없음: ${stream}`);return [];}
 return transaction(home,db=>{
  const q=slim?slimSql(slim):null;
  // 한 줄씩 해석한다: .all()은 원문 문자열 배열과 해석한 객체를 한꺼번에 쥐어 정점이 약 30% 컸다(2026-10-22 실측 586→408MB).
  const rows=[];
  // after: 이 순번보다 큰 행만 읽는다(증분 읽기). 나눠 읽기·LIMIT은 두지 않는다 — 묶음 경계를 자르지 않으려는 것이다.
  const tail=after===null?'':' AND seq>?',more=after===null?[]:[after];
  for(const r of db.prepare(`SELECT ${q?q.expr:'payload'} AS payload FROM events WHERE stream=?${tail} ORDER BY seq`).iterate(...(q?q.args:[]),stream,...more))rows.push(JSON.parse(r.payload));
  if(!rows.length&&!optional&&after===null)throw new Error(`기록 없음: ${stream}`);return rows;
 },{readOnly:true});
}
export function appendStream(home,stream,value){
 assertWritable(home);
 return transaction(home,db=>{appendRow(db,stream,value);return value});
}
export function appendRow(db,stream,value,provenance={}){
 const seq=(db.prepare('SELECT seq FROM heads WHERE stream=?').get(stream)?.seq??0)+1;
 const payload=JSON.stringify(value);
 db.prepare('INSERT INTO events(stream,seq,payload,source,source_line,raw) VALUES(?,?,?,?,?,?)').run(stream,seq,payload,provenance.source??null,provenance.line??null,provenance.raw??null);
 db.prepare('INSERT INTO heads(stream,seq,payload) VALUES(?,?,?) ON CONFLICT(stream) DO UPDATE SET seq=excluded.seq,payload=excluded.payload').run(stream,seq,payload);
}
export function listStreams(home,prefix=''){
 if(storageMode(home)==='none')return [];
 return transaction(home,db=>db.prepare('SELECT stream FROM heads ORDER BY stream').all().map(x=>x.stream).filter(x=>x.startsWith(prefix)),{readOnly:true});
}
export function writeStorageMarker(home,backend){
 const tmp=path.join(home,`.storage-${randomUUID()}.json`);
 fs.writeFileSync(tmp,JSON.stringify({version:1,backend})+'\n',{flag:'wx',mode:0o600});
 fs.renameSync(tmp,path.join(home,'storage.json'));
}
// 증분 읽기용 도우미. 모두 storageSnapshot 안에서 불러 같은 읽기 스냅샷을 쓴다(트랜잭션이 이미 열려 있으면 그 연결을 재사용한다).
// 영역별 끝 행: {seq,payload}. 행이 없는 영역은 빠진다.
export function streamHeads(home,streams){
 if(storageMode(home)==='none')return new Map();
 return transaction(home,db=>new Map(db.prepare(`SELECT stream,seq,payload FROM heads WHERE stream IN (${streams.map(()=>'?').join(',')})`).all(...streams).map(r=>[r.stream,{seq:r.seq,payload:r.payload}])),{readOnly:true});
}
export function streamRowPayload(home,stream,seq){
 if(storageMode(home)==='none')return null;
 return transaction(home,db=>db.prepare('SELECT payload FROM events WHERE stream=? AND seq=?').get(stream,seq)?.payload??null,{readOnly:true});
}
// 열린 DB 파일의 식별값. 파일이 통째로 바뀌면(복원·교체) inode나 생성 시각이 달라진다. 쓰기만으로는 바뀌지 않는다.
export function databaseIdentity(home){
 const st=fs.statSync(storagePath(home));
 return `${st.dev}:${st.ino}:${Math.round(st.birthtimeMs)}`;
}
