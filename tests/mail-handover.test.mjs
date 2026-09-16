import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Mailbox,mailboxLetters} from '../src/mailbox.mjs';
import {appendLedger,readLedger,readMailLedger,readSystemLedger} from '../src/ledger.mjs';
import {resolveWorkMail} from '../src/work-mail.mjs';
import {createDatabase,writeStorageMarker,readStream} from '../src/storage.mjs';
import {Handover} from '../src/handover.mjs';
import {ledgerStreams,validateDomainStreams} from '../src/ledger-domains.mjs';

// 임시 우편/DB와 가짜 세션만 사용하고 증거 파일은 남긴다.
function fixture(mode){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-mail-handover-'));
 if(mode==='sqlite'){createDatabase(home);writeStorageMarker(home,'sqlite');}
 return {home,box:role=>new Mailbox(home,role),record:entry=>appendLedger(entry,home)};
}
const transfer=(from,to,id=`${from}-${to}`)=>({kind:'handover',phase:'transferred',from,to,handoverId:id,taskIds:[]});

for(const mode of ['jsonl','sqlite']){
 test(`${mode}: 우편 조회만으로 확정 인계, 현재 책임 필터와 원문 보존`,()=>{
  const {home,box,record}=fixture(mode);
  const q=box('receiver').send({by:'sender',message:'원본 질문',expectReply:true});
  assert.equal(q.recipient,'receiver');assert.equal(q.currentRecipient,'receiver');
  const original=readMailLedger(home)[0];
  record({...transfer('receiver','next'),phase:'prepared'});
  record({...transfer('receiver','next'),phase:'aborted'});
  assert.equal(box('next').list().length,0);
  assert.equal(box('receiver').list().length,1);
  record(transfer('receiver','next'));
  record(transfer('sender','lead'));
  assert.deepEqual(readMailLedger(home).find(e=>e.mailId===q.mailId),original);
  assert.deepEqual(mailboxLetters(readMailLedger(home)),mailboxLetters(readLedger(home)));
  assert.equal(readStream(home,'mail/events.jsonl').filter(e=>e.kind==='handover').length,0);
  assert.equal(readSystemLedger(home).filter(e=>e.phase==='transferred').length,2);
  assert.equal(box('receiver').list({all:true}).length,0);
  assert.equal(box('sender').list({view:'waiting'}).length,0);
  assert.equal(box('lead').list({view:'waiting'}).length,1);
  const letter=box('next').read(q.mailId);
  assert.equal(letter.currentRecipient,'next');assert.equal(letter.currentSender,'lead');
  assert.equal(letter.role,'receiver');assert.equal(letter.by,'sender');assert.equal(letter.body,'원본 질문');
  assert.match(letter.receiverInstructions,/KADAN_ROLE='next' kadan inbox ack/);
  assert.match(letter.receiverInstructions,/kadan send 'lead' --reply-to/);
  assert.equal(letter.read,false);
  box('next').acknowledge(q.mailId,'next');box('next').acknowledge(q.mailId,'next');
  assert.equal(readMailLedger(home).filter(e=>e.kind==='mail-read').length,1);
  assert.equal(box('next').list({view:'to-reply'}).length,1);
  assert.throws(()=>box('lead').send({by:'receiver',message:'종료한 선임',replyTo:q.mailId,replyFinal:true}),/현재 책임자/);
  const context=resolveWorkMail(home,{replyTo:q.mailId,role:'sender',by:'next',replyFinal:true});
  assert.equal(context.currentRecipient,'lead');
  const result=box('sender').send({by:'next',message:'옛 안내 주소로 답장',replyTo:q.mailId,replyFinal:true});
  assert.equal(result.recipient,'lead');
  assert.equal(result.currentRecipient,'lead');
  assert.equal(box('lead').read(result.mailId).role,'sender');
  assert.equal(box('lead').read(result.mailId).currentRecipient,'lead');
  assert.equal(box('next').read(q.mailId).replyStatus,'answered');
  assert.equal(box('next').read(q.mailId).read,true);
 });

 test(`${mode}: 과거 읽음과 최종 답변은 당시 권한으로 유효하고 이후 선임 처리는 제외`,()=>{
  const {home,box,record}=fixture(mode);
  const answered=box('receiver').send({by:'sender',message:'먼저 답할 질문',expectReply:true});
  const read=box('receiver').send({by:'sender',message:'먼저 읽을 질문',expectReply:true});
  const waiting=box('receiver').send({by:'sender',message:'남은 질문',expectReply:true});
  box('sender').send({by:'receiver',message:'먼저 완료',replyTo:answered.mailId,replyFinal:true});
  box('receiver').acknowledge(read.mailId,'receiver');
  record(transfer('receiver','next'));record(transfer('sender','lead'));
  record({kind:'mail-read',mailId:waiting.mailId,role:'receiver',by:'receiver'});
  record({kind:'send',mailId:'stale-final',role:'lead',by:'receiver',replyTo:waiting.mailId,replyFinal:true});
  assert.equal(box('next').read(answered.mailId).replyStatus,'answered');
  assert.equal(box('next').read(answered.mailId).read,false,'답변은 읽음을 만들지 않는다');
  assert.equal(box('next').read(read.mailId).read,true);
  assert.equal(box('next').read(waiting.mailId).read,false);
  assert.equal(box('next').read(waiting.mailId).replyStatus,'waiting');
  assert.throws(()=>box('next').acknowledge(waiting.mailId,'receiver'),/읽음/);
  record(transfer('next','last'));record(transfer('receiver','next'));
  assert.equal(box('last').read(read.mailId).read,true);
  assert.equal(box('last').read(waiting.mailId).currentRecipient,'last');
  box('last').acknowledge(waiting.mailId,'사용자');
  box('lead').send({by:'@user',message:'사용자 답변',replyTo:waiting.mailId,replyFinal:true});
  assert.equal(box('last').read(waiting.mailId).replyStatus,'answered');
  assert.equal(box('last').read(waiting.mailId).read,true);
  assert.equal(mailboxLetters(readMailLedger(home)).find(e=>e.mailId==='stale-final').by,'receiver');
 });

 test(`${mode}: 취소와 승계 체인, 같은 역할명 재사용의 새 독립 우편은 분리`,()=>{
  const {home,box,record}=fixture(mode);
  const cancelled=box('receiver').send({by:'sender',message:'취소 질문',expectReply:true});
  box('sender').cancel(cancelled.mailId,'sender');
  const q=box('receiver').send({by:'sender',message:'인계 질문',expectReply:true});
  record(transfer('sender','lead'));record(transfer('lead','chief'));record(transfer('receiver','next'));
  assert.equal(box('chief').read(cancelled.mailId).replyStatus,'cancelled');
  assert.throws(()=>box('chief').send({by:'next',message:'취소 뒤',replyTo:cancelled.mailId,replyFinal:true}),/취소/);
  assert.throws(()=>box('chief').cancel(q.mailId,'sender'),/보낸 역할/);
  record({kind:'start',role:'sender',panePid:'new-generation'});
  const independent=box('sender').send({by:'receiver',message:'새 세대의 별도 우편',expectReply:true});
  assert.equal(independent.recipient,'sender');assert.equal(independent.currentRecipient,'sender');
  record(transfer('sender','lead'));
  assert.equal(box('sender').read(independent.mailId).currentRecipient,'sender');
  assert.equal(box('sender').read(independent.mailId).currentSender,'receiver');
  assert.equal(box('chief').list({view:'waiting'}).length,1);
  assert.equal(resolveWorkMail(home,{replyTo:q.mailId,role:'lead',by:'next'}).currentRecipient,'chief');
  assert.throws(()=>resolveWorkMail(home,{replyTo:q.mailId,role:'unrelated',by:'next'}),/받는 역할/);
  box('chief').cancel(q.mailId,'사람');box('chief').cancel(q.mailId,'chief');
  assert.equal(box('next').read(q.mailId).replyStatus,'cancelled');
  assert.equal(box('next').read(q.mailId).read,false);
  assert.equal(readMailLedger(home).filter(e=>e.kind==='mail-cancel'&&e.mailId===q.mailId).length,1);
 });

 test(`${mode}: 인계 후 도착한 완료와 답장은 원본 replyTo로 후임에게 연결`,()=>{
  const {home,box,record}=fixture(mode);
  record({kind:'send',role:'worker',by:'lead',mailId:'dispatch',taskId:'a',expectReply:true});
  record(transfer('lead','next'));record(transfer('next','last'));
  record({kind:'done',role:'worker',taskId:'a',result:'ok'});
  const completion=box('last').list({all:true}).find(e=>e.systemGenerated==='task-completion');
  assert.ok(completion);assert.equal(completion.role,'lead');assert.equal(completion.by,'worker');
  assert.equal(completion.currentRecipient,'last');assert.equal(completion.notificationOnly,true);
  assert.equal(box('last').read(completion.mailId).receiverInstructions.includes('inbox ack'),false);
  assert.equal(mailboxLetters(readMailLedger(home)).find(e=>e.mailId==='dispatch').replyStatus,'answered');
  record({kind:'done',role:'worker',taskId:'a',result:'ok'});
  assert.equal(box('last').list({all:true}).filter(e=>e.completion).length,1);
  assert.deepEqual(mailboxLetters(readMailLedger(home)),mailboxLetters(readLedger(home)));
 });

 test(`${mode}: 실제 Handover의 prepared와 abort는 우편 책임을 바꾸지 않고 finish만 옮긴다`,()=>{
  const {home,box,record}=fixture(mode),hierarchy=path.join(home,'hierarchy.json'),context=path.join(home,'context.md');
  fs.writeFileSync(hierarchy,JSON.stringify({lead:'@user'}));fs.writeFileSync(context,'허용된 작업');
  const q=box('lead').send({by:'asker',message:'진행 질문',expectReply:true});
  const live=new Map([['kadan-lead','10']]);
  record({kind:'start',role:'lead',panePid:'10',floor:'fake',cmd:'cat',cwd:home});
  const env={KADAN_ROLE:'사람'},h=new Handover({home,env,readEntries:()=>readLedger(home),record,watchAlive:()=>true,
   floor:{name:'fake',alive:s=>live.has(s),pid:s=>live.get(s),stop:s=>live.delete(s)},
   start:(role,cmd,cwd)=>{live.set(`kadan-${role}`,'20');record({kind:'start',role,panePid:'20',cmd,cwd});},send:()=>({})});
  const aborted=h.begin('lead',{to:'aborted',hierarchy,context,atBoundary:true});h.abort(aborted.id);
  assert.equal(box('aborted').list().length,0);
  const state=h.begin('lead',{to:'next',hierarchy,context,atBoundary:true});
  assert.equal(box('next').list().length,0);
  const receipt=path.join(home,'receipt.json');fs.writeFileSync(receipt,JSON.stringify({taskIds:[],evidencePaths:[context],nextAction:'질문 답변'}));
  env.KADAN_ROLE='next';h.accept(state.id,receipt);env.KADAN_ROLE='사람';
  assert.equal(h.finish(state.id,{timeout:0}).phase,'routes-pending');
  assert.equal(box('next').list().length,0);
  record({kind:'hierarchy-loaded',path:hierarchy,hash:createHash('sha256').update(fs.readFileSync(hierarchy)).digest('hex'),pid:1});
  assert.equal(h.finish(state.id,{timeout:0}).phase,'complete');
  assert.equal(box('next').read(q.mailId).currentRecipient,'next');
  assert.equal(box('lead').list().length,0);
  assert.deepEqual(mailboxLetters(readLedger(home)),mailboxLetters(readMailLedger(home)));
 });
}

test('과거 JSONL 인계도 mail 조회에서 반영하고 원본 바이트와 옛 완료 속성을 보존한다',()=>{
 const {home}=fixture('jsonl');
 const rows=[{kind:'send',mailId:'old',taskId:'a',role:'worker',by:'lead',expectReply:true},transfer('lead','next'),
  {kind:'done',role:'worker',taskId:'a',result:'ok',completionMailId:'completion'},
  {kind:'send',mailId:'completion',role:'lead',by:'worker',replyTo:'old',replyFinal:true,completion:true,systemGenerated:'task-completion',transport:'mailbox',completionTaskId:'a',result:'ok'}];
 const raw=rows.map(JSON.stringify).join('\n')+'\n',file=path.join(home,'ledger.jsonl');fs.writeFileSync(file,raw);
 const letters=mailboxLetters(readMailLedger(home));
 assert.equal(letters[0].replyStatus,'answered');assert.equal(letters[1].currentRecipient,'next');
 assert.equal(letters[1].notificationOnly,undefined);assert.equal(fs.readFileSync(file,'utf8'),raw);
 assert.deepEqual(letters,mailboxLetters(readLedger(home)));
});

test('미래 읽음/답장은 인정하지 않고 타임스탬프 대신 저장 순서를 따른다',()=>{
 const q={kind:'send',mailId:'q',role:'a',by:'lead',expectReply:true,t:'2000'};
 const entries=[{kind:'mail-read',mailId:'q',role:'a',by:'a'},q,
  {kind:'mail-read',mailId:'q',role:'b',by:'b'}, {...transfer('a','b'),t:'1900'},
  {kind:'send',mailId:'fake',role:'lead',by:'a',replyTo:'q',replyFinal:true}];
 const raw=JSON.stringify(entries),letter=mailboxLetters(entries)[0];
 assert.equal(letter.read,false);assert.equal(letter.replyStatus,'waiting');assert.equal(letter.currentRecipient,'b');
 assert.equal(JSON.stringify(entries),raw);
});

for(const mode of ['jsonl','sqlite']){
 test(`${mode}: 실행 인계 뒤 후임 완료는 원발령에 연결되고 별칭 결과도 질문을 종료`,()=>{
  for(const [requestTask,requestKey,transferred,doneTask,doneKey] of [
   ['r/a',undefined,'a','a','r/a'],['a','r/a','r/a','r/a',undefined],['a',undefined,'a','a',undefined],
  ]){
   const {home,record,box}=fixture(mode);
   record({kind:'send',role:'old',by:'lead',mailId:'dispatch',taskId:requestTask,executionKey:requestKey,expectReply:true});
   const event={...transfer('old','next'),taskIds:[transferred]};record(event);
   record({...transfer('next','last'),taskIds:[transferred]});
   record(transfer('lead','new-lead'));
   record({kind:'done',role:'last',taskId:doneTask,executionKey:doneKey,result:'ok'});
   const entries=readMailLedger(home),letters=mailboxLetters(entries),completion=letters.find(e=>e.completion);
   assert.ok(completion,JSON.stringify({requestTask,requestKey,transferred,doneTask,doneKey}));
   assert.equal(completion.role,'lead');assert.equal(completion.by,'last');assert.equal(completion.currentRecipient,'new-lead');
   assert.equal(letters.find(e=>e.mailId==='dispatch').role,'old');
   assert.equal(letters.find(e=>e.mailId==='dispatch').replyStatus,'answered');
   assert.equal(letters.find(e=>e.mailId==='dispatch').read,false);
   assert.equal(box('new-lead').list({view:'waiting'}).length,0);
   assert.deepEqual(letters,mailboxLetters(readLedger(home)));
   record({kind:'done',role:'last',taskId:doneTask,executionKey:doneKey,result:'ok'});
   assert.equal(readMailLedger(home).filter(e=>e.completion).length,1);
  }
 });

 test(`${mode}: 이미 완료한 실행의 인계 뒤 done은 두 번째 우편을 만들지 않는다`,()=>{
  const {home,record}=fixture(mode);
  record({kind:'send',role:'old',by:'lead',mailId:'dispatch',taskId:'r/a',expectReply:true});
  record({kind:'done',role:'old',taskId:'a',executionKey:'r/a',result:'ok'});
  record({...transfer('old','next'),taskIds:['r/a']});
  record({kind:'done',role:'next',taskId:'a',executionKey:'r/a',result:'ok'});
  const letters=mailboxLetters(readMailLedger(home));
  assert.equal(letters.filter(e=>e.completion).length,1);
  assert.equal(letters.find(e=>e.mailId==='dispatch').replyStatus,'answered');
 });

 test(`${mode}: taskIds에 없는 실행과 prepared/abort는 후임 완료 우편을 만들지 않는다`,()=>{
  for(const event of [
   {...transfer('old','next'),taskIds:['r/other']},
   {...transfer('old','next'),phase:'prepared',taskIds:['r/a']},
   {...transfer('old','next'),phase:'aborted',taskIds:['r/a']},
  ]){
   const {home,record}=fixture(mode);
   record({kind:'send',role:'old',by:'lead',mailId:'dispatch',taskId:'r/a',expectReply:true});record(event);
   record({kind:'done',role:'next',taskId:'a',executionKey:'r/a',result:'ok'});
   assert.equal(readMailLedger(home).filter(e=>e.completion).length,0);
  }
 });

 test(`${mode}: 모호한 실행 별칭 인계는 추측하지 않고 명시한 한 실행만 이전`,()=>{
  for(const transferred of ['a','r/a']){
   const {home,record}=fixture(mode);
   record({kind:'send',role:'old',by:'lead',mailId:'r-dispatch',taskId:'r/a',expectReply:true});
   record({kind:'send',role:'old',by:'lead',mailId:'s-dispatch',taskId:'s/a',expectReply:true});
   record({...transfer('old','next'),taskIds:[transferred]});
   record({kind:'done',role:'next',taskId:'a',executionKey:'r/a',result:'ok'});
   const letters=mailboxLetters(readMailLedger(home));
   assert.equal(letters.filter(e=>e.completion).length,transferred==='r/a'?1:0);
   assert.equal(letters.find(e=>e.mailId==='s-dispatch').replyStatus,'waiting');
  }
 });
}

test('일반 답장의 실행 교차와 done 없는 위조 완료는 질문을 종료하지 않는다',()=>{
 const request={kind:'send',mailId:'q',role:'worker',by:'lead',taskId:'r/a',expectReply:true};
 const ordinary={kind:'send',mailId:'answer',role:'lead',by:'worker',replyTo:'q',replyFinal:true,executionKey:'r/a'};
 const forged={...ordinary,completion:true,systemGenerated:'task-completion',transport:'mailbox',completionTaskId:'a',result:'ok'};
 for(const reply of [ordinary,forged])assert.equal(mailboxLetters([request,reply])[0].replyStatus,'waiting');
 const wrongDone={kind:'done',role:'worker',taskId:'b',executionKey:'r/b',result:'ok',completionMailId:'answer'};
 assert.equal(mailboxLetters([request,wrongDone,forged])[0].replyStatus,'waiting');
});

test('완료 원장 검증도 실제 이전한 실행과 사건 당시 인계만 인정한다',()=>{
 const {home,record}=fixture('jsonl');
 record({kind:'send',role:'old',by:'lead',mailId:'dispatch',taskId:'r/a',expectReply:true});
 record({...transfer('old','next'),taskIds:['r/a']});
 record({kind:'done',role:'next',taskId:'a',executionKey:'r/a',result:'ok'});
 const streams=new Map(Object.values(ledgerStreams).map(stream=>[stream,readStream(home,stream)]));
 assert.doesNotThrow(()=>validateDomainStreams(streams));
 for(const change of ['wrong-task','prepared','future']){
  const copy=structuredClone(streams),handover=copy.get(ledgerStreams.system)[0];
  if(change==='wrong-task')handover.taskIds=['r/other'];
  if(change==='prepared')handover.phase='prepared';
  if(change==='future'){
   handover._ledgerOrder=4;
   copy.get(ledgerStreams.tasks).find(e=>e.kind==='done')._ledgerOrder=2;
   copy.get(ledgerStreams.mail).find(e=>e.completion)._ledgerOrder=3;
  }
  assert.throws(()=>validateDomainStreams(copy),/완료 우편 연결 손상/);
 }
});
