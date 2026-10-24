import fs from 'node:fs';
import path from 'node:path';
import {openDatabase,storageMode,storagePath} from './storage.mjs';
import {CardStore} from './card-store.mjs';
import {WorkStore} from './work-store.mjs';
import {DecisionStore} from './decisions.mjs';
import {BriefStore} from './human-brief.mjs';
import {ledgerStreams,validateDomainEvent,validateDomainStreams} from './ledger-domains.mjs';
import {verifyWatchContexts} from './watch-request-context.mjs';
function validateWorks(home,keys){
 const linked=new Set();
 for(const work of new WorkStore(home).list())for(const x of work.executions){
  if(!keys.has(x.key))throw new Error('업무가 가리키는 실행 없음: '+x.key);
  if(linked.has(x.key))throw new Error('실행이 여러 업무에 연결됨: '+x.key);
  linked.add(x.key);
 }
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
  verifyWatchContexts(db);
  if(current.size!==heads.size)throw new Error('현재 상태와 이력 수 불일치');
  for(const [stream,last] of current){const h=heads.get(stream);if(!h||h.seq!==last.seq||h.payload!==last.payload)throw new Error('현재 상태와 마지막 사건 불일치');}
  // DB 안의 수입 행만 대조한다. 동결 원본 파일은 열지 않는다(파일이 없어도 통과).
  for(const imported of db.prepare('SELECT source,rows FROM imports').all()){
   const rows=db.prepare('SELECT raw,payload FROM events WHERE source=? ORDER BY source_line').all(imported.source);
   if(rows.length!==imported.rows||rows.some(r=>JSON.stringify(JSON.parse(r.raw))!==r.payload))throw new Error('수입 행 원문 불일치');
  }
  db.exec('COMMIT');
  const cards=new CardStore(home).list();const keys=new Set(cards.map(c=>c.key));
  validateWorks(home,keys);
 for(const d of new DecisionStore(home).list())if(d.chat!==true&&!keys.has(d.card))throw new Error('결정이 가리키는 카드 없음: '+d.card);for(const c of cards)new BriefStore(home).read(c.key);
  return {backend:'sqlite',path:storagePath(home),integrity:'ok',streams:heads.size,events:events.length,cards:cards.length};
 }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e}finally{db.close()}
}
export function storageCommand(args,flags,{home}){
 const [command]=args;
 if(!command||flags.help)return 'kadan storage verify | pause | resume (SQLite 저장소). 옛 JSONL 홈 변환(import·export·activate·inspect)은 태그 jsonl-last 버전에서 합니다.';
 if(command==='verify')return verifyStorage(home);
 if(command==='pause'){
  fs.mkdirSync(home,{recursive:true,mode:0o700});const f=path.join(home,'storage-paused.json');
  if(!fs.existsSync(f))fs.writeFileSync(f,JSON.stringify({at:new Date().toISOString(),reason:'저장 전환 준비 — 기존 명령 종료/옛 작성자 확인 별도 필요'})+'\n',{flag:'wx',mode:0o600});
  return {paused:true,warning:'새 쓰기 차단만 설정됨. 진행 중 명령/옛 프로세스 종료를 증명하지 않습니다.'};
 }
 if(command==='resume'){
  const f=path.join(home,'storage-paused.json');if(fs.existsSync(f)){const dir=path.join(home,'archive');fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.renameSync(f,path.join(dir,`storage-paused-${Date.now()}.json`));}return {paused:false};
 }
 if(['import','export','activate','inspect'].includes(command))throw new Error(`알 수 없는 storage 명령: ${command}. 이 버전에는 없습니다. 옛 홈 변환은 태그 jsonl-last 버전에서 하세요(verify|pause|resume만 지원)`);
 throw new Error(`알 수 없는 storage 명령: ${command} (verify|pause|resume)`);
}
