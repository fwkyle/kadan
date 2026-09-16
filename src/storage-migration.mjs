import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createDatabase,openDatabase,appendRow,storageMode,storagePath,writeStorageMarker,storageSnapshot} from './storage.mjs';
import {CardStore} from './card-store.mjs';
import {WorkStore} from './work-store.mjs';
import {DecisionStore} from './decisions.mjs';
import {BriefStore} from './human-brief.mjs';
import {ledgerStreams,validateDomainEvent,validateDomainStreams} from './ledger-domains.mjs';
const sha=data=>createHash('sha256').update(data).digest('hex');
const omitted=name=>['kadan.sqlite','kadan.sqlite-wal','kadan.sqlite-shm','storage.json','storage-paused.json','storage-import.json','.lock','.ledger-lock','.storage-gate','.storage-writers'].includes(name)||name.startsWith('.released-');
function files(root,relative=''){
 if(!fs.existsSync(path.join(root,relative)))return [];
 const result=[];
 for(const item of fs.readdirSync(path.join(root,relative),{withFileTypes:true})){
  if(omitted(item.name))continue;
  const rel=path.join(relative,item.name);
  if(item.isDirectory())result.push(...files(root,rel));
  else if(item.isFile())result.push(rel);
  else if(item.isSymbolicLink()&&(isStream(rel)||['cards','works','tasks','mail','system'].includes(rel)||/^(cards|works)\/[^/]+(?:\/[^/]+)?$/.test(rel)||/^cards\/[^/]+\/[^/]+\/card\.md$/.test(rel)))throw new Error(`중앙 기록 심볼릭 링크 확인 필요: ${rel}`);
 }
 return result.sort();
}
const isStream=p=>p==='ledger.jsonl'||Object.values(ledgerStreams).includes(p)||p==='decisions/events.jsonl'||/^cards\/[^/]+\/[^/]+\/(events|briefs)\.jsonl$/.test(p)||/^works\/[^/]+\/[^/]+\/events\.jsonl$/.test(p);
function validateWorks(home,keys){
 const linked=new Set();
 for(const work of new WorkStore(home).list())for(const x of work.executions){
  if(!keys.has(x.key))throw new Error('업무가 가리키는 실행 없음: '+x.key);
  if(linked.has(x.key))throw new Error('실행이 여러 업무에 연결됨: '+x.key);
  linked.add(x.key);
 }
}
function capture(home){return files(home).map(source=>{const bytes=fs.readFileSync(path.join(home,source));return {source,sha256:sha(bytes),bytes:bytes.length};});}
function validateJsonl(home){
 if(fs.existsSync(path.join(home,'.ledger-lock')))throw new Error('도메인 원장 저장 중 또는 미완료 잠금');
 const manifest=capture(home),streams=[];
 for(const file of manifest.filter(f=>isStream(f.source))){
  const text=fs.readFileSync(path.join(home,file.source),'utf8'),rows=[];
  for(const [i,raw] of text.split('\n').entries())if(raw.trim()){
   let value;try{value=JSON.parse(raw)}catch{throw new Error(`기록 해석 실패: ${file.source}:${i+1}`)}
   if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`사건 객체 필요: ${file.source}:${i+1}`);
   if(file.source==='ledger.jsonl'&&(typeof value.kind!=='string'||!value.kind||value.broken))throw new Error(`원장 종류 손상: ${i+1}`);
   validateDomainEvent(file.source,value);
   rows.push({value,raw,line:i+1});
  }
  streams.push({...file,rows});
 }
 validateDomainStreams(new Map(streams.filter(s=>Object.values(ledgerStreams).includes(s.source)).map(s=>[s.source,s.rows.map(r=>r.value)])),streams.find(s=>s.source==='ledger.jsonl')?.rows.map(r=>r.value) || []);
 // 기존 validator가 허용하는 역사/미등록 실행은 보존한다.
 const cards=new CardStore(home).list();const keys=new Set(cards.map(c=>c.key));
 validateWorks(home,keys);
 for(const d of new DecisionStore(home).list())if(!keys.has(d.card))throw new Error('결정이 가리키는 카드 없음: '+d.card);
 const briefs=new BriefStore(home);for(const c of cards)briefs.read(c.key);
 return {manifest,streams,cards:cards.length};
}
function requireNewTarget(source,target){
 if(!path.isAbsolute(source)||!path.isAbsolute(target))throw new Error('원본/대상은 절대경로 필요');
 const src=fs.realpathSync(source),dst=path.resolve(target);
 let ancestor=path.dirname(dst);while(!fs.existsSync(ancestor))ancestor=path.dirname(ancestor);
 const canonicalTarget=path.join(fs.realpathSync(ancestor),path.relative(ancestor,dst));
 if(canonicalTarget===src||canonicalTarget.startsWith(src+path.sep)||src.startsWith(canonicalTarget+path.sep))throw new Error('원본과 실제 대상 경로가 겹칩니다');
 if(dst===src||dst.startsWith(src+path.sep)||src.startsWith(dst+path.sep))throw new Error('원본과 겹치는 대상 금지');
 if(fs.existsSync(dst))throw new Error('대상은 아직 없는 새 폴더여야 합니다');
 return {src,dst};
}
function copyFiles(source,target){
 fs.mkdirSync(target,{recursive:true,mode:0o700});
 fs.cpSync(source,target,{recursive:true,dereference:false,verbatimSymlinks:true,filter:(src)=>{
  if(src===source)return true;
  if(omitted(path.basename(src)))return false;
  const stat=fs.lstatSync(src);return stat.isFile()||stat.isDirectory()||stat.isSymbolicLink();
 }});
 fs.chmodSync(target,0o700);
}
export function inspectStorage(home){
 if(storageMode(home)==='jsonl'){const s=validateJsonl(home);return {backend:'jsonl',cards:s.cards,streams:s.streams.length,events:s.streams.reduce((n,s)=>n+s.rows.length,0),manifest:s.manifest};}
 return verifyStorage(home);
}
export function importStorage(source,target){
 const {src,dst}=requireNewTarget(source,target);
 if(storageMode(src)!=='jsonl')throw new Error('수입 원본은 JSONL 저장소여야 합니다');
 const before=validateJsonl(src);copyFiles(src,dst);
 const copied=validateJsonl(dst);
 if(JSON.stringify(before.manifest)!==JSON.stringify(copied.manifest)||JSON.stringify(before.manifest)!==JSON.stringify(capture(src)))throw new Error('복사 중 원본 변경: 대상은 미완성으로 보존, 새 스냅샷 필요');
 createDatabase(dst);const db=openDatabase(dst);
 try{
  db.exec('BEGIN IMMEDIATE');
  for(const stream of before.streams){
   db.prepare('INSERT INTO imports(source,sha256,bytes,rows) VALUES(?,?,?,?)').run(stream.source,stream.sha256,stream.bytes,stream.rows.length);
   for(const row of stream.rows)appendRow(db,stream.source,row.value,{source:stream.source,line:row.line,raw:row.raw});
  }
  db.exec('COMMIT');
 }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e}finally{db.close()}
 const record={version:1,source:src,at:new Date().toISOString(),manifest:before.manifest};
 fs.writeFileSync(path.join(dst,'storage-import.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
 writeStorageMarker(dst,'sqlite');
 return verifyStorage(dst);
}
export function verifyStorage(home){
 if(storageMode(home)!=='sqlite')throw new Error('SQLite 저장소 필요');
 const db=openDatabase(home,{readOnly:true});
 try{
  db.exec('BEGIN');
  const integrity=db.prepare('PRAGMA integrity_check').all();
  if(integrity.length!==1||integrity[0].integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('SQLite 무결성 실패');
  const events=db.prepare('SELECT stream,seq,payload FROM events ORDER BY stream,seq').all();
  const heads=new Map(db.prepare('SELECT * FROM heads').all().map(h=>[h.stream,h]));
  const current=new Map(),domains=new Map();
  for(const row of events){if(row.seq!==(current.get(row.stream)?.seq??0)+1)throw new Error('사건 순번 손상');const value=JSON.parse(row.payload);validateDomainEvent(row.stream,value);if(Object.values(ledgerStreams).includes(row.stream)){if(!domains.has(row.stream))domains.set(row.stream,[]);domains.get(row.stream).push(value);}current.set(row.stream,row);}
  validateDomainStreams(domains,events.filter(row=>row.stream==='ledger.jsonl').map(row=>JSON.parse(row.payload)));
  if(current.size!==heads.size)throw new Error('현재 상태와 이력 수 불일치');
  for(const [stream,last] of current){const h=heads.get(stream);if(!h||h.seq!==last.seq||h.payload!==last.payload)throw new Error('현재 상태와 마지막 사건 불일치');}
  const imports=db.prepare('SELECT * FROM imports').all();
  for(const imported of imports){
   const f=path.join(home,imported.source);if(!fs.existsSync(f)||sha(fs.readFileSync(f))!==imported.sha256)throw new Error('보존한 수입 원본이 변경됨: '+imported.source);
   const original=fs.readFileSync(f,'utf8').split('\n');
   const rows=db.prepare('SELECT source_line,raw,payload FROM events WHERE source=? ORDER BY source_line').all(imported.source);
   if(rows.length!==imported.rows||rows.some(r=>r.raw!==original[r.source_line-1]||JSON.stringify(JSON.parse(r.raw))!==r.payload))throw new Error('수입 행 원문 불일치');
  }
  db.exec('COMMIT');
  const cards=new CardStore(home).list();const keys=new Set(cards.map(c=>c.key));
  validateWorks(home,keys);
 for(const d of new DecisionStore(home).list())if(!keys.has(d.card))throw new Error('결정이 가리키는 카드 없음: '+d.card);for(const c of cards)new BriefStore(home).read(c.key);
  return {backend:'sqlite',path:storagePath(home),integrity:'ok',streams:heads.size,events:events.length,cards:cards.length};
 }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e}finally{db.close()}
}
export function exportStorage(source,target){
 const {src,dst}=requireNewTarget(source,target);
 if(storageMode(src)!=='sqlite')throw new Error('내보내기 원본은 SQLite여야 합니다');
 verifyStorage(src);
 // 전환 중지 표식은 CLI 작업을 차단한다. 오프라인 복구 대상만 지원한다.
 if(!fs.existsSync(path.join(src,'storage-paused.json')))throw new Error('내보내기 전 storage pause와 작성자 종료 확인이 필요합니다');
 const before=capture(src);
 copyFiles(src,dst);
 storageSnapshot(src,db=>{
  const streams=db.prepare('SELECT stream FROM heads ORDER BY stream').all();
  for(const {stream} of streams){
   if(!isStream(stream))throw new Error('지원하지 않는 내보내기 스트림');
   const rows=db.prepare('SELECT payload,source,raw FROM events WHERE stream=? ORDER BY seq').all(stream);
   if(stream==='ledger.jsonl'&&rows.every(r=>r.source===stream)&&fs.existsSync(path.join(dst,stream)))continue;
   const f=path.join(dst,stream);fs.mkdirSync(path.dirname(f),{recursive:true,mode:0o700});fs.writeFileSync(f,rows.map(r=>r.raw??r.payload).join('\n')+'\n',{mode:0o600});
  }
 });
 if(JSON.stringify(before)!==JSON.stringify(capture(src)))throw new Error('내보내기 중 파일 변경: 복구 대상 확인 필요');
 writeStorageMarker(dst,'jsonl');
 const result=validateJsonl(dst);
 return {backend:'jsonl',home:dst,cards:result.cards,streams:result.streams.length,events:result.streams.reduce((n,s)=>n+s.rows.length,0)};
}
export function activateStorage(home,candidate,{writersStopped=false}={}){
 if(!writersStopped||!fs.existsSync(path.join(home,'storage-paused.json')))throw new Error('전환에는 pause 및 --writers-stopped 확인이 필요합니다. 옛 작성자와 진행 중 명령을 먼저 종료하세요');
 if(storageMode(home)!=='jsonl')throw new Error('전환 원본은 JSONL이어야 합니다');
 if(!path.isAbsolute(candidate)||fs.realpathSync(candidate)===fs.realpathSync(home))throw new Error('별도 SQLite 검증 복사본 필요');
 if(!fs.existsSync(path.join(candidate,'storage-paused.json')))throw new Error('SQLite 검증 복사본도 pause 필요');
 const manifest=JSON.parse(fs.readFileSync(path.join(candidate,'storage-import.json'),'utf8'));
 if(manifest.version!==1||fs.realpathSync(manifest.source)!==fs.realpathSync(home))throw new Error('다른 원본의 SQLite 복사본');
 if(JSON.stringify(manifest.manifest)!==JSON.stringify(capture(home)))throw new Error('수입 후 원본 변경: 마지막 스냅샷을 다시 수입하세요');
 verifyStorage(candidate);
 const db=openDatabase(candidate,{readOnly:true});
 const temporary=path.join(home,`.sqlite-activation-${Date.now()}.sqlite`);
 try{
  // 검증 복사본에서 시험으로 추가한 사건이 실제 원본으로 섞이지 않게 한다.
  if(db.prepare('SELECT count(*) AS n FROM events WHERE source IS NULL').get().n)throw new Error('검증 복사본에 원본 외 새 사건이 있음: 최종 수입 복사본 필요');
  db.prepare('VACUUM INTO ?').run(temporary);
 }finally{db.close()}
 fs.chmodSync(temporary,0o600);
 if(JSON.stringify(manifest.manifest)!==JSON.stringify(capture(home).filter(f=>f.source!==path.basename(temporary))))throw new Error('전환 중 원본 변경: 중단, 증거 파일 보존');
 if(fs.existsSync(storagePath(home)))throw new Error('기존 SQLite 파일을 덮어쓰지 않습니다');
 fs.renameSync(temporary,storagePath(home));
 const writable=openDatabaseForActivation(home);
 try{writable.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')}finally{writable.close()}
 fs.copyFileSync(path.join(candidate,'storage-import.json'),path.join(home,'storage-import.json'));
 writeStorageMarker(home,'sqlite');
 return {...verifyStorage(home),paused:true,next:'기반 프로세스/조회 확인 후 storage resume. 작업자 세션은 이 명령이 변경하지 않습니다.'};
}
function openDatabaseForActivation(home){
 // VACUUM INTO 출력은 DELETE journal 모드이므로 정규 연결 전 WAL만 설정한다.
 const db=openDatabase(home,{readOnly:true});db.close();
 return new (createRequire(import.meta.url)('node:sqlite').DatabaseSync)(storagePath(home));
}
export function storageCommand(args,flags,{home}){
 const [command]=args;
 if(!command||flags.help)return 'kadan storage inspect|verify | activate --candidate 검증복사본 --writers-stopped | import --source 절대경로 --target 새폴더 | export --target 새폴더 | pause | resume (현재 저장소). import는 새 복사본만 SQLite로 전환하며 실제 원본을 바꾸지 않습니다.';
 if(command==='inspect')return inspectStorage(home);
 if(command==='verify')return verifyStorage(home);
 if(command==='import')return importStorage(flags.source,flags.target);
 if(command==='export')return exportStorage(home,flags.target);
 if(command==='activate')return activateStorage(home,flags.candidate,{writersStopped:flags['writers-stopped']===true});
 if(command==='pause'){
  fs.mkdirSync(home,{recursive:true,mode:0o700});const f=path.join(home,'storage-paused.json');
  if(!fs.existsSync(f))fs.writeFileSync(f,JSON.stringify({at:new Date().toISOString(),reason:'저장 전환 준비 — 기존 명령 종료/옛 작성자 확인 별도 필요'})+'\n',{flag:'wx',mode:0o600});
  return {paused:true,warning:'새 쓰기 차단만 설정됨. 진행 중 명령/옛 프로세스 종료를 증명하지 않습니다.'};
 }
 if(command==='resume'){
  const f=path.join(home,'storage-paused.json');if(fs.existsSync(f)){const dir=path.join(home,'archive');fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.renameSync(f,path.join(dir,`storage-paused-${Date.now()}.json`));}return {paused:false};
 }
 throw new Error('알 수 없는 storage 명령');
}
