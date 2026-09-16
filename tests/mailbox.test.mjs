import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {Mailbox,mailboxLetters,inboxCommand} from '../src/mailbox.mjs';
import {guardedSend,parseFlags} from '../src/cli.mjs';
import {appendLedger,readLedger,readMailLedger,readTaskLedger,saveMailBody} from '../src/ledger.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {createDatabase,writeStorageMarker,appendStream} from '../src/storage.mjs';
const fixture=(mode='jsonl')=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-mailbox-'));
 if(mode==='sqlite'){createDatabase(home);writeStorageMarker(home,'sqlite');}
 return {home,sender:new Mailbox(home,'sender'),receiver:new Mailbox(home,'receiver')};
};
for(const mode of ['jsonl','sqlite'])test(`${mode}: 읽음·일반답장·최종답장·취소와 카드완료는 독립이다`,()=>{
 const {home,sender,receiver}=fixture(mode);
 const q=receiver.send({by:'sender',message:'의견을 알려주세요',expectReply:true});
 assert.equal(sender.list({view:'waiting'}).length,1);
 assert.equal(receiver.list({view:'to-reply'}).length,1);
 const before=readMailLedger(home).length;
 receiver.read(q.mailId);receiver.list();
 assert.equal(readMailLedger(home).length,before);
 assert.throws(()=>receiver.acknowledge(q.mailId,'other'),/읽음/);
 receiver.acknowledge(q.mailId,'receiver');receiver.acknowledge(q.mailId,'receiver');
 assert.equal(receiver.list().length,0);assert.equal(receiver.list({view:'to-reply'}).length,1);
 sender.send({by:'receiver',message:'검토 중',replyTo:q.mailId});
 assert.equal(sender.list({view:'waiting'}).length,1);
 const final=sender.send({by:'receiver',message:'찬성합니다',replyTo:q.mailId,replyFinal:true});
 assert.equal(sender.list({view:'waiting'}).length,0);
 assert.equal(receiver.read(q.mailId).finalReplyId,final.mailId);
 assert.equal(receiver.read(q.mailId).replyStatus,'answered');
 assert.throws(()=>sender.send({by:'receiver',message:'다시 완료',replyTo:q.mailId,replyFinal:true}),/이미 최종/);
 assert.throws(()=>sender.cancel(q.mailId,'sender'),/최종/);
 const q2=receiver.send({by:'sender',message:'후속 질문',expectReply:true});
 assert.throws(()=>sender.cancel(q2.mailId,'other'),/보낸 역할/);
 sender.cancel(q2.mailId,'sender');sender.cancel(q2.mailId,'sender');
 assert.equal(receiver.read(q2.mailId).replyStatus,'cancelled');
 assert.throws(()=>sender.send({by:'receiver',message:'늦은 답변',replyTo:q2.mailId,replyFinal:true}),/취소/);
 assert.equal(readTaskLedger(home).length,0);
 assert.equal(readMailLedger(home).filter(e=>e.kind==='mail-read').length,1,'읽음은 ACK 메일을 보내지 않는다');
 assert.equal(readMailLedger(home).filter(e=>e.kind==='mail-cancel').length,1);
});
test('원본 참가자·받는 역할 검증과 사용자 예외',()=>{
 const {home,sender,receiver}=fixture();
 const q=receiver.send({by:'sender',message:'질문',expectReply:true});
 assert.throws(()=>sender.send({by:'intruder',message:'위조',replyTo:q.mailId,replyFinal:true}),/원본 수신자/);
 assert.throws(()=>new Mailbox(home,'wrong').send({by:'receiver',message:'오발송',replyTo:q.mailId}),/받는 역할/);
 assert.throws(()=>sender.send({by:'receiver',message:'최종',replyFinal:true}),/원본 우편/);
 assert.throws(()=>sender.send({by:'receiver',message:'재귀',replyTo:q.mailId,replyFinal:true,expectReply:true}),/다시 답변/);
 assert.throws(()=>sender.acknowledge(q.mailId,'sender'),/수신한/);
 receiver.acknowledge(q.mailId,'사용자');
 sender.send({by:'@user',message:'대신 확정',replyTo:q.mailId,replyFinal:true});
 assert.equal(receiver.read(q.mailId).replyStatus,'answered');
 const notice=receiver.send({by:'sender',message:'알림'});
 assert.equal(receiver.read(notice.mailId).expectReply,false);
 assert.throws(()=>sender.send({by:'receiver',message:'알림 최종',replyTo:notice.mailId,replyFinal:true}),/답변을 요청/);
 assert.throws(()=>receiver.send({by:'sender',message:'옵션 오타',expectReply:'yes'}),/true\/false/);
});
test('모든 역할과 네 가지 보기, 오래된 읽음 모름, 위조 읽음과 답장 제외',()=>{
 const q={kind:'send',mailId:'q',by:'sender',role:'receiver',expectReply:true};
 const entries=[{kind:'send',by:'old',role:'legacy',digest:'old'},q,
  {kind:'mail-read',mailId:'q',role:'receiver',by:'intruder'},
  {kind:'send',mailId:'fake',by:'intruder',role:'sender',replyTo:'q',replyFinal:true}];
 const rows=mailboxLetters(entries);
 assert.equal(rows.length,3);assert.equal(rows[0].read,null);assert.equal(rows[1].read,false);
 assert.equal(rows[1].replyStatus,'waiting');
 assert.equal(mailboxLetters(entries,'sender',{view:'waiting'}).length,1);
 assert.equal(mailboxLetters(entries,'receiver',{view:'to-reply'}).length,1);
 assert.equal(mailboxLetters(entries,'receiver',{unread:true}).length,1);
 assert.throws(()=>mailboxLetters([{broken:'bad'}]),/손상/);
});
test('inbox 기본 역할, 명시 역할, 보기와 boolean 옵션은 본문을 삼키지 않는다',()=>{
 const {home,receiver}=fixture();
 receiver.send({by:'sender',message:'질문',expectReply:true});
 assert.equal(inboxCommand(['waiting'],{},{home,by:'sender',env:{KADAN_ROLE:'sender'}}).length,1);
 assert.equal(inboxCommand(['list'],{role:'receiver'},{home,by:'sender',env:{}}).length,1);
 assert.equal(inboxCommand(['list'],{},{home,by:'sender',env:{}}).length,0);
 assert.equal(inboxCommand(['sent'],{},{home,by:'sender',env:{}}).length,1);
 new Mailbox(home,'사람').send({by:'receiver',message:'직접 사용자에게'});
 assert.equal(inboxCommand(['list'],{},{home,env:{}}).length,1);
 const {flags,rest}=parseFlags(['send','receiver','--expect-reply','질문','--reply-final','--all','--unread']);
 assert.deepEqual(rest,['send','receiver','질문']);
 assert.equal(flags['expect-reply'],true);assert.equal(flags['reply-final'],true);assert.equal(flags.all,true);assert.equal(flags.unread,true);
});
test('fake floor 실터미널 경로의 질문ID·원문 조회·최종 답장·잘못된 수신자 전달 차단',()=>{
 const {home,sender,receiver}=fixture('sqlite');let injections=0,body='';
 const floor={name:'fake',alive:()=>true,pid:()=> '42',send:(session,message)=>{injections++;body=message;return {};}};
 const send=(role,by,message,mailContext)=>guardedSend({floor,role,session:`kadan-${role}`,message,mailContext,
  recordedPid:'42',env:{KADAN_HOME:home,KADAN_ROLE:by},readEntries:()=>readLedger(home),record:e=>appendLedger(e,home),saveBody:(d,b)=>saveMailBody(d,b,home)});
 const q=send('receiver','sender','결과를 확인해라',{expectReply:true});
 assert.match(body,new RegExp(q.mailId));assert.match(body,/--reply-final/);assert.doesNotMatch(body,/KADAN:DONE \S+ (ok|failed)/);
 assert.equal(receiver.read(q.mailId).body,body);
 receiver.acknowledge(q.mailId,'receiver');assert.equal(receiver.read(q.mailId).read,true);
 assert.throws(()=>send('wrong','receiver','잘못된 답장',{replyTo:q.mailId,replyFinal:true}),/받는 역할/);
 assert.throws(()=>send('sender','intruder','위조 답장',{replyTo:q.mailId,replyFinal:true}),/원본 수신자/);
 assert.equal(injections,1);
 send('sender','receiver','확인 완료',{replyTo:q.mailId,replyFinal:true});
 assert.equal(sender.list({view:'waiting'}).length,0);assert.equal(readTaskLedger(home).length,0);
});
test('완료 통지는 발령 없이 저장되고 명시 질문이 있을 때만 답변 종료로 보인다',()=>{
 const {home,sender}=fixture('sqlite');
 const entry=(mailId,taskId,expectReply)=>({kind:'send',by:'sender',role:'receiver',mailId,taskId,expectReply});
 appendLedger(entry('dispatch-normal','normal',false),home);
 appendLedger({kind:'done',role:'receiver',taskId:'normal',result:'ok'},home);
 const rows=mailboxLetters(readMailLedger(home));
 assert.equal(rows.find(x=>x.mailId==='dispatch-normal').replyStatus,'not-requested');
 assert.equal(rows.find(x=>x.completion).replyFinal,true);
 appendLedger(entry('dispatch-question','question',true),home);
 appendLedger({kind:'done',role:'receiver',taskId:'question',result:'ok'},home);
 assert.equal(mailboxLetters(readMailLedger(home)).find(x=>x.mailId==='dispatch-question').replyStatus,'answered');
 assert.equal(sender.list({view:'waiting'}).length,0);
 assert.equal(readTaskLedger(home).filter(x=>x.kind==='dispatch').length,2);
});
test('도메인 손상은 정상 빈 우편함으로 숨기지 않는다',()=>{
 const {home,receiver}=fixture('sqlite');
 appendStream(home,'mail/events.jsonl',{kind:'done',_ledgerOrder:1});
 assert.throws(()=>receiver.list(),/손상/);
});
test('SQLite 동시 최종 답장과 취소는 한 쪽만 성공한다',async()=>{
 const {home,receiver}=fixture('sqlite');
 const q=receiver.send({by:'sender',message:'동시 결정',expectReply:true});
 const module=new URL('../src/mailbox.mjs',import.meta.url).href;
 const source=`import {Mailbox} from ${JSON.stringify(module)};const m=new Mailbox(process.argv[1],'sender');try{if(process.argv[3]==='final')m.send({by:'receiver',message:'답변',replyTo:process.argv[2],replyFinal:true});else m.cancel(process.argv[2],'sender');}catch(e){console.error(e.message);process.exitCode=1;}`;
 const run=action=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--input-type=module','-e',source,home,q.mailId,action],{env:{...process.env,KADAN_HOME:home},stdio:['ignore','pipe','pipe']});let stderr='';p.stderr.on('data',b=>stderr+=b);p.on('error',reject);p.on('exit',code=>resolve({code,stderr}));});
 const results=await Promise.all([run('final'),run('cancel')]);
 assert.deepEqual(results.map(x=>x.code).sort(),[0,1],JSON.stringify(results));
 const claims=readMailLedger(home).filter(e=>e.kind==='mail-cancel'||e.replyFinal);
 assert.equal(claims.length,1);assert.ok(['answered','cancelled'].includes(receiver.read(q.mailId).replyStatus));
});

test('전달 중 취소 경쟁은 외부전달 완료와 최종 반영 실패를 구분한다',()=>{
 const {home,sender,receiver}=fixture('sqlite');
 const q=receiver.send({by:'sender',message:'경쟁 질문',expectReply:true});
 let delivered=0;
 const module=new URL('../src/mailbox.mjs',import.meta.url).href;
 const floor={name:'fake',alive:()=>true,pid:()=> '42',send:()=>{
  delivered++;
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {Mailbox} from ${JSON.stringify(module)};new Mailbox(process.argv[1],'sender').cancel(process.argv[2],'sender');`,home,q.mailId],{env:{...process.env,KADAN_HOME:home},encoding:'utf8',timeout:2000});
  assert.equal(child.status,0,child.stderr);
  return {};
 }};
 const options={floor,role:'sender',session:'kadan-sender',message:'답변',mailContext:{replyTo:q.mailId,replyFinal:true},recordedPid:'42',env:{KADAN_HOME:home,KADAN_ROLE:'receiver'},readEntries:()=>readLedger(home),record:e=>appendLedger(e,home),saveBody:(d,b)=>saveMailBody(d,b,home)};
 assert.throws(()=>guardedSend(options),e=>e.delivery==='sent'&&/취소/.test(e.message));
 assert.equal(delivered,1);assert.equal(sender.list({view:'waiting'}).length,0);
 const rejected=readMailLedger(home).find(e=>e.replyFinalRejected);
 assert.equal(rejected.replyFinal,false);assert.equal(rejected.replyTo,q.mailId);
 assert.equal(receiver.read(q.mailId).replyStatus,'cancelled');
});
test('raw 질문은 전송 전 거절하고 저장-only CLI는 모든 역할과 사용자 답장을 지원한다',()=>{
 const {home}=fixture('sqlite');let delivered=0;
 const floor={name:'fake',alive:()=>true,pid:()=> '42',send:()=>{delivered++;}};
 assert.throws(()=>guardedSend({floor,role:'receiver',session:'kadan-receiver',message:'원문',raw:true,mailContext:{expectReply:true},env:{KADAN_HOME:home}}),/--raw/);
 assert.equal(delivered,0);
 const cli=new URL('../src/cli.mjs',import.meta.url).pathname;
 const call=(by,...args)=>spawnSync(process.execPath,[cli,...args],{env:{...process.env,KADAN_HOME:home,KADAN_ROLE:by,KADAN_SOCKET:path.basename(home),KADAN_WINDOW:'none'},encoding:'utf8',timeout:3000});
 const question=call('사람','send','receiver','--mailbox','--expect-reply','질문');
 assert.equal(question.status,0,question.stderr);const q=JSON.parse(question.stdout);
 const wrong=call('receiver','send','other','--mailbox','--reply-to',q.mailId,'--reply-final','답변');assert.notEqual(wrong.status,0);assert.match(wrong.stderr,/받는 역할/);
 const answer=call('receiver','send','사람','--mailbox','--reply-to',q.mailId,'--reply-final','답변');assert.equal(answer.status,0,answer.stderr);
 const received=call('사람','inbox','received','--all');assert.equal(received.status,0,received.stderr);assert.equal(JSON.parse(received.stdout).length,1);
 assert.equal(readTaskLedger(home).length,0);
});

test('답장은 원본 업무와 실행 연결을 바꿀 수 없으며 잘못된 원본 참가자는 거절한다',()=>{
 const {home,sender,receiver}=fixture('sqlite'),store=new WorkStore(home);
 const work=store.create({key:'repo/work',title:'우편 연결',goal:'답장 연결 보존',scope:'두 실행',acceptance:'원본 유지',owner:'sender',repoPath:home,board:'mail'});
 for(const title of ['first','second'])store.change(work.key,'execute',{title,body:'연결 검증',phase:'implementation',round:1},{revision:store.get(work.key).revision,by:'sender',note:'실행 연결'});
 const [first,second]=store.get(work.key).executions;
 const q=receiver.send({by:'sender',message:'실행에 대한 질문',workKey:work.key,executionKey:first.key,expectReply:true});
 assert.throws(()=>sender.send({by:'receiver',message:'실행 바꾸기',replyTo:q.mailId,executionKey:second.key,replyFinal:true}),/실행이 다릅니다/);
 assert.throws(()=>sender.send({by:'receiver',message:'업무 바꾸기',replyTo:q.mailId,workKey:'repo/other',replyFinal:true}),/업무가 다릅니다/);
 const final=sender.send({by:'receiver',message:'원문 그대로',replyTo:q.mailId,replyFinal:true});
 const row=sender.read(final.mailId);assert.equal(row.workKey,work.key);assert.equal(row.executionKey,first.key);assert.equal(row.taskId,undefined);
 appendLedger({kind:'send',mailId:'broken-parent',role:'receiver',expectReply:true},home);
 assert.throws(()=>sender.send({by:'receiver',message:'잘못된 부모',replyTo:'broken-parent',replyFinal:true}),/참가자 정보 손상/);
});
