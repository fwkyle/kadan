import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {appendLedger,readLedger,readTaskLedger,readMailLedger,readSystemLedger,readMailBody,classifyLedgerEntry} from '../src/ledger.mjs';
import {ledgerStreams} from '../src/ledger-domains.mjs';
import {createDatabase,writeStorageMarker,openDatabase,readStream,appendStream,appendRow,transaction} from '../src/storage.mjs';
import {importStorage,exportStorage,verifyStorage,inspectStorage,storageCommand} from '../src/storage-migration.mjs';

// 테스트 전용 폴더는 삭제하지 않는다. 실제 기본 KADAN_HOME을 사용하지 않는다.
function home(mode='jsonl') {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-ledger-domains-'));
  if(mode==='sqlite'){createDatabase(dir);writeStorageMarker(dir,'sqlite');}
  return dir;
}
const send={kind:'send',role:'worker',by:'lead',taskId:'a',executionKey:'r/a',mailId:'request-1'};
const done={kind:'done',role:'worker',taskId:'a',executionKey:'r/a',result:'ok'};
function legacy(h,rows) { fs.writeFileSync(path.join(h,'ledger.jsonl'),rows.map(JSON.stringify).join('\n')+'\n'); }

for(const mode of ['jsonl','sqlite']) {
  test(`${mode}: 도메인 분리, 문자열 반환/입력 불변, 우편과 dispatch 원본 구분`,()=>{
    const h=home(mode),input={...send,t:null},before=JSON.stringify(input);
    const result=appendLedger(input,h);
    assert.equal(typeof result,'string');assert.equal(JSON.stringify(input),before);
    assert.equal(JSON.parse(result).dispatchId,send.mailId);
    assert.deepEqual(readMailLedger(h),[JSON.parse(result)]);
    assert.equal(readTaskLedger(h)[0].kind,'dispatch');
    assert.equal(readTaskLedger(h)[0].mailId,send.mailId);
    assert.equal(readLedger(h).length,1);assert.equal(readStream(h,'ledger.jsonl',{optional:true}).length,0);
    appendLedger({kind:'send',role:'reader',taskId:'context',transport:'mailbox'},h);
    appendLedger({kind:'send',role:'reader',taskId:'context',completion:true},h);
    appendLedger({kind:'start',role:'worker'},h);
    assert.equal(readTaskLedger(h).length,1);assert.equal(readMailLedger(h).length,3);
    assert.equal(readSystemLedger(h).length,1);
    assert.deepEqual(classifyLedgerEntry(readLedger(h)[0]),{domains:['tasks','mail'],dispatch:'linked'});
    assert.deepEqual(classifyLedgerEntry(readLedger(h)[1]),{domains:['mail'],dispatch:null});
    assert.throws(()=>appendLedger(send,h),/중복 mailId/);
  });
  test(`${mode}: 도메인 간 순서는 같은/역전/누락 시간에 영향받지 않는다`,()=>{
    const h=home(mode),rows=[{kind:'start',t:'2099-01-01'}, {...send,t:undefined},
      {kind:'plan',t:null},{kind:'mail-cancel',mailId:send.mailId,t:'2000-01-01'},
      {kind:'stop',t:'2000-01-01'}];
    for(const row of rows)appendLedger(row,h);
    assert.deepEqual(readLedger(h).map(r=>r.kind),rows.map(r=>r.kind));
    assert.equal(Object.hasOwn(readLedger(h)[1],'t'),false);
    assert.deepEqual(readTaskLedger(h).map(r=>r.kind),['dispatch','plan']);
  });
  test(`${mode}: 완료는 linked mailbox 1통, 중복 done은 원문 유지하고 통지는 한번`,()=>{
    const h=home(mode);appendLedger({...send,originalCardPath:'/cards/a.md',expectReply:true},h);
    appendLedger({...done,resultFile:'/results/a.md'},h);
    appendLedger({...done,result:'failed'},h);
    const mailEntries=readMailLedger(h),letters=mailEntries.filter(r=>r.kind==='send'),completion=letters.find(r=>r.completion);
    assert.equal(mailEntries.filter(r=>r.kind==='done'&&r.completionMailId===completion.mailId).length,1);
    assert.equal(letters.length,2);assert.equal(completion.role,'lead');assert.equal(completion.by,'worker');
    assert.equal(completion.replyTo,send.mailId);assert.equal(completion.replyFinal,true);
    assert.equal(completion.transport,'mailbox');assert.equal(completion.mailKind,'report');
    assert.equal(completion.systemGenerated,'task-completion');assert.equal(completion.result,'ok');
    assert.equal(completion.notificationOnly,true);
    assert.equal(Object.hasOwn(completion,'taskId'),false);assert.equal(completion.completionTaskId,'a');
    assert.equal(completion.executionKey,'r/a');assert.equal(completion.resultFile,'/results/a.md');
    assert.equal(readMailBody(completion.digest,h),'ok: r/a\n/cards/a.md\n/results/a.md');
    assert.equal(readTaskLedger(h).filter(r=>r.kind==='done').length,1);
    assert.equal(readStream(h,ledgerStreams.tasks).filter(r=>r.kind==='done').length,2);
    assert.equal(readTaskLedger(h).filter(r=>r.kind==='dispatch').length,1);
    assert.equal(readLedger(h).filter(r=>r.kind==='send'&&r.taskId).length,1);
    if(mode==='sqlite')assert.equal(verifyStorage(h).integrity,'ok');else inspectStorage(h);
  });
  test(`${mode}: 완료 연결이 불명확하면 발신자/연결을 추측하지 않는다`,()=>{
    for(const request of [{...send,by:undefined},{...send,by:'모름'},{...send,executionKey:'s/a'},
      {...send,transport:'mailbox'}]) {
      const h=home(mode);appendLedger(request,h);appendLedger(done,h);
      assert.equal(readMailLedger(h).filter(r=>r.completion).length,0);
      assert.equal(readTaskLedger(h).filter(r=>r.kind==='done').length,1);
    }
    const h=home(mode);appendLedger(send,h);
    appendLedger({...send,mailId:'other-request',executionKey:'s/a'},h);
    appendLedger({...done,executionKey:undefined},h);
    assert.equal(readMailLedger(h).filter(r=>r.completion).length,0);
  });
}

test('역사 JSONL 바이트/행 순서 보존, legacy dispatch 해석과 중복 done 최초 우선',()=>{
  const source=home(),raw=' {"kind":"start","t":"2099"}\n\n'+JSON.stringify({...send,t:null})+'\n'+JSON.stringify(done)+'\n'+JSON.stringify({...done,result:'failed'});
  fs.writeFileSync(path.join(source,'ledger.jsonl'),raw);
  appendLedger({kind:'stop',t:'1900'},source);appendLedger(done,source);
  assert.equal(readMailLedger(source).filter(r=>r.completion).length,0);
  assert.equal(readTaskLedger(source)[0].kind,'dispatch');
  assert.deepEqual(classifyLedgerEntry(readLedger(source)[1]),{domains:['tasks','mail'],dispatch:'legacy'});
  assert.deepEqual(readLedger(source).map(r=>r.kind),['start','send','done','stop']);
  assert.equal(fs.readFileSync(path.join(source,'ledger.jsonl'),'utf8'),raw);
  const target=source+'-sqlite',output=source+'-export',again=source+'-again';
  importStorage(source,target);
  appendLedger({kind:'mail-read',mailId:send.mailId,role:'worker'},target);
  storageCommand(['pause'],{},{home:target});exportStorage(target,output);
  assert.equal(fs.readFileSync(path.join(output,'ledger.jsonl'),'utf8'),raw);
  assert.equal(fs.readFileSync(path.join(source,'ledger.jsonl'),'utf8'),raw);
  assert.deepEqual(readLedger(output),readLedger(target));
  importStorage(output,again);assert.deepEqual(readLedger(again),readLedger(target));
});

test('세 신규 stream과 완료 우편 본문 export/import 왕복',()=>{
  const source=home();appendLedger(send,source);appendLedger(done,source);appendLedger({kind:'stop'},source);
  const target=source+'-sqlite',output=source+'-jsonl';importStorage(source,target);
  const before=readLedger(target);storageCommand(['pause'],{},{home:target});exportStorage(target,output);
  assert.deepEqual(readLedger(output),before);assert.equal(inspectStorage(output).streams,3);
  assert.equal(readMailBody(before.find(r=>r.completion).digest,output),'ok: r/a');
});

test('SQLite 실제 트랜잭션: dispatch 실패 시 mail도 없고 완료 우편 실패 시 done도 없다',()=>{
  const h=home('sqlite'),db=openDatabase(h);
  db.exec("CREATE TRIGGER reject_dispatch BEFORE INSERT ON events WHEN NEW.stream='tasks/events.jsonl' BEGIN SELECT RAISE(ABORT,'reject dispatch'); END");db.close();
  assert.throws(()=>appendLedger(send,h),/reject dispatch/);assert.deepEqual(readLedger(h),[]);
  const edit=openDatabase(h);edit.exec('DROP TRIGGER reject_dispatch');edit.close();appendLedger(send,h);
  const fail=openDatabase(h);fail.exec("CREATE TRIGGER reject_completion BEFORE INSERT ON events WHEN json_extract(NEW.payload,'$.completion')=1 BEGIN SELECT RAISE(ABORT,'reject completion'); END");fail.close();
  assert.throws(()=>appendLedger(done,h),/reject completion/);
  assert.deepEqual(readLedger(h).map(r=>r.kind),['send']);assert.equal(readTaskLedger(h).length,1);
});

test('SQLite 원장은 UPDATE/DELETE 금지, 외부 rollback은 두 신규 stream 모두 보존',()=>{
  const h=home('sqlite');appendLedger(send,h);
  const db=openDatabase(h);try {
    assert.throws(()=>db.exec("UPDATE events SET payload='{}'"),/이력 수정 금지/);
    assert.throws(()=>db.exec('DELETE FROM events'),/이력 삭제 금지/);
  }finally{db.close()}
  assert.throws(()=>transaction(h,()=>{appendLedger({...send,mailId:'second'},h);throw Error('rollback')}),/rollback/);
  assert.equal(readLedger(h).length,1);assert.equal(verifyStorage(h).integrity,'ok');
});

test('domain 문법/종류/순번/dispatch/완료 연결 손상은 읽기와 import 모두 실패',()=>{
  for(const corrupt of [h=>fs.appendFileSync(path.join(h,ledgerStreams.mail),'not-json\n'),
    h=>fs.writeFileSync(path.join(h,ledgerStreams.tasks),''),
    h=>fs.appendFileSync(path.join(h,ledgerStreams.system),JSON.stringify({kind:'send',mailId:'wrong',_ledgerOrder:2})+'\n'),
    h=>fs.appendFileSync(path.join(h,ledgerStreams.system),JSON.stringify({kind:'stop',_ledgerOrder:3})+'\n')]) {
    const h=home();appendLedger(send,h);fs.mkdirSync(path.join(h,'system'),{recursive:true});corrupt(h);
    for(const read of [readLedger,readTaskLedger,readMailLedger,readSystemLedger])assert.throws(()=>read(h));
    assert.throws(()=>importStorage(h,h+'-import'));
  }
  const h=home();appendLedger(send,h);appendLedger(done,h);
  const mail=readStream(h,ledgerStreams.mail)[0];fs.writeFileSync(path.join(h,ledgerStreams.mail),JSON.stringify(mail)+'\n');
  assert.throws(()=>readLedger(h),/완료 우편 연결 손상/);
});

test('SQLite verify도 잘못된 domain 기록을 거절',()=>{
  const h=home('sqlite');appendStream(h,ledgerStreams.mail,{kind:'send',mailId:'orphan',taskId:'a',dispatchId:'orphan',_ledgerOrder:1});
  assert.throws(()=>verifyStorage(h),/연결 손상/);assert.throws(()=>readLedger(h),/연결 손상/);
});

test('legacy 손상은 도메인 조회에서 숨기지 않고 readLedger broken 호환은 유지',()=>{
  const h=home();fs.writeFileSync(path.join(h,'ledger.jsonl'),'broken\n');
  assert.equal(readLedger(h)[0].broken,'broken');
  for(const read of [readTaskLedger,readMailLedger,readSystemLedger])assert.throws(()=>read(h),/과거 원장 손상/);
});

test('JSONL 미완료 잠금은 읽기/추가/import 거절, 임시 폴더와 원문 보존',()=>{
  const h=home();fs.mkdirSync(path.join(h,'.ledger-lock'));
  assert.throws(()=>appendLedger(send,h),/잠금/);assert.throws(()=>readLedger(h),/잠금/);
  assert.throws(()=>importStorage(h,h+'-import'),/잠금/);assert.ok(fs.existsSync(path.join(h,'.ledger-lock')));
});

test('SQLite 동시 완료 두 호출: 원문 done 둘, 결과 우편 한 통',async()=>{
  const h=home('sqlite');appendLedger(send,h);
  const code=`import {appendLedger} from './src/ledger.mjs';appendLedger(${JSON.stringify(done)},process.argv[1]);`;
  const results=await Promise.all([1,2].map(()=>new Promise(resolve=>{
    const child=spawn(process.execPath,['--input-type=module','-e',code,h],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
    let stderr='';child.stderr.on('data',x=>stderr+=x);child.on('close',status=>resolve({status,stderr}));
  })));
  assert.ok(results.every(r=>r.status===0),JSON.stringify(results));
  assert.equal(readStream(h,ledgerStreams.tasks).filter(r=>r.kind==='done').length,2);
  assert.equal(readMailLedger(h).filter(r=>r.completion).length,1);
});

for(const mode of ['jsonl','sqlite'])test(`${mode}: 옛 short 주소와 명시 executionKey는 같은 발령, 모호한 short는 통지 금지`,()=>{
  const source=home();legacy(source,[{...send,executionKey:undefined,mailId:'legacy-request'}]);
  const h=mode==='sqlite'?source+'-sqlite':source;if(mode==='sqlite')importStorage(source,h);
  appendLedger({...send,mailId:'current-request'},h);appendLedger(done,h);
  const completion=readMailLedger(h).find(r=>r.completion);
  assert.equal(completion.replyTo,'current-request');assert.equal(completion.executionKey,'r/a');
  appendLedger({...done,taskId:'r/a',executionKey:undefined},h);
  assert.equal(readMailLedger(h).filter(r=>r.completion).length,1);
  const other=home(mode);appendLedger(send,other);appendLedger({...send,executionKey:'s/a',mailId:'s-request'},other);
  appendLedger({...done,executionKey:undefined},other);
  assert.equal(readMailLedger(other).filter(r=>r.completion).length,0);
});


test('SQLite 일반 append는 원장 크기와 무관하게 heads만 JSON 해석한다',()=>{
  const h=home('sqlite');
  transaction(h,db=>{for(let i=0;i<2000;i++)appendRow(db,'ledger.jsonl',{kind:'watch-history',id:i});});
  const parse=JSON.parse;let count=0;
  try {
    JSON.parse=(...args)=>{count++;return parse(...args);};
    appendLedger({kind:'watch-observation'},h);
  }finally{JSON.parse=parse;}
  assert.ok(count<30,`전체 원장 JSON 해석 회귀: ${count}`);
  assert.equal(readLedger(h).length,2001);
});

test('domain 디렉터리 심볼릭 링크를 import에서 조용히 누락하지 않는다',()=>{
  const h=home(),outside=home();fs.mkdirSync(path.join(outside,'tasks'));
  fs.symlinkSync(path.join(outside,'tasks'),path.join(h,'tasks'));
  assert.throws(()=>importStorage(h,h+'-import'),/심볼릭 링크/);
});

test('legacy/new mailId 충돌은 원본을 덮어 해석하지 않는다',()=>{
  const h=home();legacy(h,[send]);
  fs.mkdirSync(path.join(h,'mail'));
  fs.writeFileSync(path.join(h,ledgerStreams.mail),JSON.stringify({kind:'send',transport:'mailbox',mailId:send.mailId,_ledgerOrder:1})+'\n');
  assert.throws(()=>readMailLedger(h),/중복 mailId/);
  assert.throws(()=>importStorage(h,h+'-import'),/중복 mailId/);
});

for(const mode of ['jsonl','sqlite'])test(`${mode}: 정식 taskId 발령과 짧은 완료 주소의 통지가 같다`,()=>{
  for(const historical of [false,true]) {
    const request={...send,taskId:'r/a',executionKey:undefined};
    const source=home();if(historical)legacy(source,[request]);
    const h=mode==='sqlite'?source+'-sqlite':source;if(mode==='sqlite')importStorage(source,h);
    if(!historical)appendLedger(request,h);
    appendLedger({...send,mailId:'unrelated',taskId:'s/other',executionKey:undefined,by:'other-lead'},h);
    appendLedger({...done,executionKey:undefined},h);
    const letters=readMailLedger(h).filter(row=>row.completion);
    assert.equal(letters.length,1,`historical=${historical}`);
    assert.equal(letters[0].role,'lead');assert.equal(letters[0].replyTo,request.mailId);
    assert.equal(letters[0].completionTaskId,'a');assert.equal(letters[0].result,'ok');
    appendLedger({...done,taskId:'r/a',executionKey:undefined},h);
    assert.equal(readMailLedger(h).filter(row=>row.completion).length,1);
  }
});

for(const mode of ['jsonl','sqlite'])test(`${mode}: r/a와 s/a 발령의 짧은 완료는 거절하고 명시 주소는 올바른 요청자에게만 통지`,()=>{
  for(const taskId of ['a','r/a','s/a']) {
    const source=home();legacy(source,[{...send,taskId:'r/a',executionKey:undefined}]);
    const h=mode==='sqlite'?source+'-sqlite':source;if(mode==='sqlite')importStorage(source,h);
    appendLedger({...send,mailId:'s-request',taskId:'s/a',executionKey:undefined,by:'s-lead'},h);
    appendLedger({...done,taskId,executionKey:undefined},h);
    const letters=readMailLedger(h).filter(row=>row.completion);
    assert.equal(letters.length,taskId==='a'?0:1,taskId);
    if(taskId!=='a') {
      assert.equal(letters[0].role,taskId==='r/a'?'lead':'s-lead');
      assert.equal(letters[0].replyTo,taskId==='r/a'?send.mailId:'s-request');
    }
  }
});
