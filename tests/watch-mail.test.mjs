import {sendWatchMessage,sendWatchNudge} from '../src/commands/watch.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {guardedSend,sendWatchMailReminder} from '../src/cli.mjs';
import {MailWatch} from '../src/watch-mail.mjs';
import {runWatch} from '../src/watch-runner.mjs';
import {waitingWithoutAsking} from '../src/watch-report.mjs';
import {observationContext} from '../src/watch-supervisor-health.mjs';

const at = n => new Date(n).toISOString();
const question = (mailId, more={}) => ({kind:'send',mailId,role:'worker',by:'boss',t:at(0),expectReply:true,...more});
function fixture(mails=[question('q')]) {
  const entries=[{kind:'start',role:'worker',session:'kadan-worker',panePid:1,t:at(0)},...mails];
  const f={entries,cards:[],works:[],sent:[],records:[],now:300000,
    live:[{session:'kadan-worker',alive:true,pid:1}],hook:null};
  f.floor={list:()=>f.live,read:()=> '›'};
  f.record=e=>{f.records.push(e);f.entries.push(e);f.hook?.(e);};
  f.send=(...args)=>f.sent.push(args);
  f.create=()=>new MailWatch({record:e=>f.record(e),send:(...args)=>f.send(...args)});
  f.tick=(watch=f.create())=>watch.tick({entries:[...f.entries],cards:f.cards,works:f.works,now:f.now,
    floor:f.floor,readEntries:()=>[...f.entries],readCards:()=>f.cards,readWorks:()=>f.works});
  return f;
}

test('5분 유예 뒤 역할별 묶음 한 번, 재시작 뒤 중복 없음',()=>{
  const f=fixture([question('q'),question('other')]);
  f.now=299999;f.tick();assert.equal(f.sent.length,0);
  f.now=300000;f.tick();assert.equal(f.sent.length,1);
  assert.equal(f.sent[0][2],1);assert.match(f.sent[0][1],/2건/);
  assert(f.sent[0][1].length<300);
  assert.equal(f.records.filter(e=>e.action==='reserved').length,2);
  f.tick();assert.equal(f.sent.length,1);
});

test('ack만 미확인 제외: read-final과 질문 취소는 읽음으로 추정하지 않음',()=>{
  const f=fixture([question('ack'),question('answer'),question('cancel')]);
  f.entries.push({kind:'mail-read',mailId:'ack',role:'worker',by:'worker'},
    question('reply',{role:'boss',by:'worker',replyTo:'answer',replyFinal:true,expectReply:false,notificationOnly:true}),
    {kind:'mail-cancel',mailId:'cancel',role:'worker',by:'boss'});
  f.tick();assert.equal(f.sent.length,1);assert.match(f.sent[0][1],/2건/);
  assert.deepEqual(f.records.filter(e=>e.action==='reserved').map(e=>e.mailId),['answer','cancel']);
});

test('알림 자체와 자동 완료 우편·발령 우편 제외, 일반 최종 터미널 통지 유지',()=>{
  // 발령 우편(taskId)은 ack 안내가 없어 재알림하지 않는다 — 미착수는 시작보고누락이 잡는다(2026-10-05).
  const f=fixture([question('notification',{notificationOnly:true}),
    question('completion',{systemGenerated:'task-completion'}),
    question('reminder',{systemGenerated:'watch-mail-reminder'}),
    question('dispatch',{expectReply:false,taskId:'task'}),
    question('final',{replyFinal:true})]);
  f.tick();assert.deepEqual(f.records.filter(e=>e.action==='reserved').map(e=>e.mailId),['final']);
});

test('현재 세션 생존과 시작 PID가 맞아야 함; 사용자나 종료 역할은 깨우지 않음',()=>{
  for(const mode of ['dead','mismatch','missing-start','stopped','user']) {
    const f=fixture();
    if(mode==='dead')f.live[0].alive=false;
    if(mode==='mismatch')f.live[0].pid=2;
    if(mode==='missing-start')f.entries.shift();
    if(mode==='stopped')f.entries.push({kind:'stop',role:'worker'});
    if(mode==='user')f.entries[1].role='@user';
    f.tick();assert.equal(f.sent.length,0,mode);assert.equal(f.records.length,0,mode);
  }
});

test('연결 업무가 hold/done/cancelled면 제외, 카드 없는 질문은 포함',()=>{
  for(const status of ['hold','done','cancelled']) {
    const f=fixture([question('linked',{workKey:'r/w'}),question('execution',{executionKey:'r/e'}),question('plain')]);
    f.works=[{key:'r/w',status,executions:[{key:'r/e'}]}];
    f.tick();assert.deepEqual(f.records.filter(e=>e.action==='reserved').map(e=>e.mailId),['plain']);
  }
});

test('예약 쓰기 실패면 전송하지 않고 중단 뒤 남은 예약도 재전송하지 않음',()=>{
  const f=fixture();f.record=()=>{throw Error('record unavailable');};
  assert.throws(()=>f.tick(),/record unavailable/);assert.equal(f.sent.length,0);
  const stopped=fixture();stopped.entries.push({kind:'watch-mail-reminder',action:'reserved',role:'worker',mailId:'q'});
  stopped.tick();assert.equal(stopped.sent.length,0);
});

test('예약 중 들어온 ack와 마지막 생존 검사 중 들어온 ack 제외',()=>{
  for(const where of ['reserve','floor']) {
    const f=fixture([question('q'),question('other')]);let reads=0;
    const ack=()=>f.entries.push({kind:'mail-read',mailId:'q',role:'worker',by:'worker'});
    if(where==='reserve')f.hook=e=>{if(e.action==='reserved'&&e.mailId==='q')ack();};
    if(where==='floor')f.floor.list=()=>{if(++reads===2)ack();return f.live;};
    f.tick();assert.equal(f.sent.length,1);assert.match(f.sent[0][1],/1건/);
    assert.equal(f.records.find(e=>e.action==='result'&&e.mailId==='q').delivery,'not-sent');
  }
});

test('예약 뒤 모두 ack 또는 PID 변경이면 전송 안 함',()=>{
  for(const mode of ['ack','pid','stop']) {
    const f=fixture();f.hook=e=>{if(e.action!=='reserved')return;
      if(mode==='ack')f.entries.push({kind:'mail-read',mailId:'q',role:'worker',by:'worker'});
      if(mode==='pid')f.live[0].pid=2;
      if(mode==='stop')f.entries.push({kind:'stop',role:'worker'});
    };
    f.tick();assert.equal(f.sent.length,0);assert.equal(f.records.at(-1).delivery,'not-sent');
  }
});

test('전달 실패/불명확 결과 기록, 재시작 재전송 안 함',()=>{
  for(const delivery of ['not-sent','unknown']) {
    const f=fixture();let attempts=0;
    f.send=()=>{attempts++;throw Object.assign(Error('transport failure'),{delivery});};
    f.tick();assert.equal(f.records.at(-1).delivery,delivery);
    assert.match(f.records.at(-1).reason,/transport failure/);
    f.tick();assert.equal(attempts,1);
  }
});

test('마지막 원장 재조회 실패도 관찰 가능한 not-sent로 남김',()=>{
  const f=fixture();
  f.create().tick({entries:f.entries,cards:[],works:[],now:f.now,floor:f.floor,
    readEntries:()=>{throw Error('read failed');},readCards:()=>[],readWorks:()=>[]});
  assert.equal(f.sent.length,0);assert.equal(f.records.at(-1).delivery,'not-sent');
});

test('runWatch question-only 역할은 우편만 알리고 작업 AI 대상에 넣지 않음, callback 없으면 비활성',async()=>{
  for(const enabled of [true,false]) {
    const f=fixture();const controller=new AbortController();let cycles=0;
    await runWatch({floor:f.floor,readEntries:()=>[...f.entries],readCards:()=>[],readWorks:()=>[],
      sendMailReminder:enabled?f.send:null,record:f.record,sendAlert:()=>{},
      intervalMs:1000,stallN:100,routes:new Map(),now:()=>f.now,spawn:()=>({status:0,stdout:String(process.pid)}),
      signal:controller.signal,print:()=>{},sleep:async()=>{if(++cycles===2)controller.abort();}});
    assert.equal(f.sent.length,enabled?1:0);
    assert.deepEqual(f.records.find(e=>e.kind==='watch-scope').sessions,[]);
    assert.equal(f.records.some(e=>e.kind==='watch-ai-request'),false);
  }
});

test('현재 실행의 waiting 질문만 정상 대기로 인정',()=>{
  const cards=[{id:'a',key:'r/a'},{id:'b',key:'r/b'}];
  const dispatch={kind:'send',role:'worker',by:'boss',taskId:'a',executionKey:'r/a',t:at(0)};
  const ask=question('ask',{role:'boss',by:'worker',executionKey:'r/a',t:at(100)});
  const waiting=entries=>waitingWithoutAsking(entries,{role:'worker',taskId:'a'},cards);
  assert.equal(waiting([dispatch,ask]),false);
  assert.equal(waiting([dispatch,{...ask,replyTo:'older'}]),false);
  for (const allowed of [{expectReply:true},{replyTo:'older'}]) {
    assert.equal(waiting([{...dispatch,...allowed}]),true);
    assert.equal(waiting([{...dispatch,...allowed},ask]),false);
  }
  for(const extra of [{expectReply:false},{executionKey:'r/b'},{replyFinal:true}])
    assert.equal(waiting([dispatch,{...ask,...extra}]),true);
  assert.equal(waiting([ask,dispatch]),true);
  assert.equal(waiting([dispatch,ask,{...dispatch,t:at(200)}]),true);
  assert.equal(waiting([dispatch,ask,{kind:'mail-read',mailId:'ask',role:'boss',by:'boss'}]),false);
  assert.equal(waiting([dispatch,ask,{kind:'mail-cancel',mailId:'ask',role:'boss',by:'worker'}]),true);
  assert.equal(waiting([dispatch,ask,question('answer',{role:'worker',by:'boss',executionKey:'r/a',replyTo:'ask',replyFinal:true})]),true);
});

test('과거 taskId-only 질문의 최종답장은 주소 정규화 뒤에도 answered로 보존',()=>{
  const cards=[{id:'a',key:'r/a'}];
  const entries=[{kind:'send',role:'worker',by:'boss',taskId:'a',t:at(0)},
    question('ask',{role:'boss',by:'worker',taskId:'a',t:at(100)}),
    question('answer',{role:'worker',by:'boss',expectReply:false,replyFinal:true,replyTo:'ask',t:at(200)})];
  assert.equal(waitingWithoutAsking(entries,{role:'worker',taskId:'a'},cards),true);
  const context=observationContext('worker',{alive:true},entries,cards,[]);
  assert.equal(context.recentMail.find(e=>e.mailId==='ask').replyStatus,'answered');
});

test('감시AI recentMail에 읽음·답변·전달 상태와 현재 주소 포함',()=>{
  const entries=[question('q',{transport:'mailbox'}),{kind:'mail-read',mailId:'q',role:'worker',by:'worker'},
    {kind:'done',role:'worker',taskId:'task',result:'ok'},
    question('completion',{systemGenerated:'task-completion',notificationOnly:true,completion:true})];
  const context=observationContext('worker',{alive:true,pid:1,expectedPid:1},entries,[],[]);
  const mail=context.recentMail[0];
  assert.equal(mail.transport,'mailbox');assert.equal(mail.read,true);assert.equal(mail.replyStatus,'waiting');
  assert.equal(mail.expectReply,true);assert.equal(mail.replyFinal,false);
  assert.equal(mail.currentRecipient,'worker');assert.equal(mail.currentSender,'boss');
  assert.equal(context.recentTaskEvents[0].kind,'done');assert.equal(context.recentTaskEvents[0].result,'ok');
  assert.equal(context.recentMail[1].completion,true);
  assert.equal(context.recentMail[1].notificationOnly,true);
  assert.equal(context.recentMail[1].systemGenerated,'task-completion');
});

test('후임은 원문 주소 보존한 우편 알림을 별도로 받고 선임은 더 깨우지 않음',()=>{
  const f=fixture();f.tick();assert.equal(f.sent.length,1);
  f.entries.push({kind:'handover',phase:'transferred',handoverId:'h',from:'worker',to:'next',taskIds:[],t:at(300001)},
    {kind:'start',role:'next',session:'kadan-next',panePid:2,t:at(300002)});
  f.live.push({session:'kadan-next',alive:true,pid:2});f.now=300003;
  f.tick();assert.equal(f.sent.length,2);assert.equal(f.sent[1][0],'next');assert.equal(f.sent[1][2],2);
  f.tick();assert.equal(f.sent.length,2);
  const mail=observationContext('next',{alive:true},f.entries,[],[]).recentMail[0];
  assert.equal(mail.to,'worker');assert.equal(mail.currentRecipient,'next');
});

test('인계한 실행과 미종결 질문의 현재 발신 책임으로 대기 판정',()=>{
  const cards=[{id:'a',key:'r/a'}];
  const entries=[{kind:'send',role:'worker',by:'boss',taskId:'a',t:at(0)},
    question('ask',{role:'boss',by:'worker',executionKey:'r/a',t:at(100)}),
    {kind:'handover',phase:'transferred',handoverId:'h',from:'worker',to:'next',taskIds:['a'],t:at(200)}];
  assert.equal(waitingWithoutAsking(entries,{role:'next',taskId:'a'},cards),false);
  entries.push({kind:'send',role:'next',by:'boss',taskId:'a',t:at(300)});
  assert.equal(waitingWithoutAsking(entries,{role:'next',taskId:'a'},cards),true);
});

test('runWatch 실제 알림 뒤 화면 기준선 흡수, 결과 저장 실패에도 전달된 화면 흡수',async()=>{
  for(const failResult of [false,true]) {
    const f=fixture();const controller=new AbortController(),events=[];
    f.entries.push({kind:'send',role:'worker',taskId:'a',t:at(0)});
    f.cards=[{id:'a',key:'r/a',role:'worker',status:'assigned',workType:'execution'}];
    f.floor.read=()=>{events.push(f.sent.length?'read-after':'read-before');return f.sent.length?'notice':'original';};
    await runWatch({floor:f.floor,readEntries:()=>[...f.entries],readCards:()=>f.cards,readWorks:()=>[],
      sendMailReminder:(...args)=>{events.push('send');f.send(...args);},
      record:e=>{if(failResult&&e.kind==='watch-mail-reminder'&&e.action==='result')throw Error('result unavailable');f.record(e);},
      sendAlert:()=>{},intervalMs:1000,stallN:100,routes:new Map(),now:()=>f.now,
      spawn:()=>({status:0,stdout:String(process.pid)}),signal:controller.signal,print:()=>{},sleep:async()=>controller.abort()});
    assert.deepEqual(events,['read-before','send','read-after']);
    f.tick();assert.equal(f.sent.length,1);
  }
});

test('runWatch 최종 원장 확인에서 ack된 우편은 안 보내고 기록 필터 때문에 사라진 일반 우편은 유지',async()=>{
  const f=fixture([question('ack'),question('conflicting',{taskId:'a',executionKey:'other/a'})]);
  f.cards=[{id:'a',key:'r/a',role:'worker',status:'assigned'}];
  f.hook=e=>{if(e.kind==='watch-mail-reminder'&&e.action==='reserved'&&e.mailId==='ack')
    f.entries.push({kind:'mail-read',mailId:'ack',role:'worker',by:'worker'});};
  const controller=new AbortController();
  await runWatch({floor:f.floor,readEntries:()=>[...f.entries],readCards:()=>f.cards,readWorks:()=>[],
    sendMailReminder:f.send,record:f.record,sendAlert:()=>{},intervalMs:1000,stallN:100,routes:new Map(),now:()=>f.now,
    spawn:()=>({status:0,stdout:String(process.pid)}),signal:controller.signal,print:()=>{},sleep:async()=>controller.abort()});
  assert.equal(f.sent.length,1);assert.match(f.sent[0][1],/1건/);
  assert.equal(f.records.find(e=>e.action==='result'&&e.mailId==='ack').delivery,'not-sent');
  assert.equal(f.records.find(e=>e.action==='result'&&e.mailId==='conflicting').delivery,'sent');
});

test('우편 예약/결과 저장·전달 실패는 주기 ok=false와 시스템 근거에 반영',async()=>{
  for(const failure of ['reserved','result','delivery']) {
    const f=fixture(),controller=new AbortController();
    await runWatch({floor:f.floor,readEntries:()=>[...f.entries],readCards:()=>[],readWorks:()=>[],
      sendMailReminder:(...args)=>{if(failure==='delivery')throw Error('ambiguous transport');f.send(...args);},
      record:e=>{if(e.kind==='watch-mail-reminder'&&e.action===failure)throw Error('store unavailable');f.record(e);},
      sendAlert:()=>{},intervalMs:1000,stallN:100,routes:new Map(),now:()=>f.now,
      spawn:()=>({status:0,stdout:String(process.pid)}),signal:controller.signal,print:()=>{},sleep:async()=>controller.abort()});
    assert.equal(f.records.find(e=>e.kind==='watch-cycle').ok,false,failure);
    assert(f.records.some(e=>e.kind==='watch-mail-reminder'&&(failure==='delivery'?e.delivery==='unknown':e.action==='error')));
  }
});

test('실제 guardedSend 알림 전달 뒤 저장 실패: sent·실패사유·화면 흡수 보존, 재전송 없음',async()=>{
  for (const mode of ['direct','runner','runner-result-failure']) {
    const f=fixture(),events=[];
    const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-watch-mail-sent-'));
    const floor={...f.floor,name:'fake',alive:()=>true,pid:()=> '1',
      send:(...args)=>{events.push('send');f.sent.push(args);return {};},
      read:()=>{events.push(f.sent.length?'read-after':'read-before');return f.sent.length?'notice':'original';}};
    const send=(role,message,pid)=>sendWatchMailReminder(role,message,pid,{
      selectedFloor:floor,readStart:()=>({panePid:1}),
      send:options=>guardedSend({...options,env:{KADAN_HOME:home},readEntries:()=>f.entries,
        saveBody:()=>{},record:()=>{throw Error('send ledger unavailable');}}),
    });
    if(mode==='direct') {
      const watch=new MailWatch({record:f.record,send});
      assert.deepEqual([...f.tick(watch)],['worker']);
      assert.equal(watch.failed,true);
    } else {
      f.entries.push({kind:'send',role:'worker',taskId:'a',t:at(0)});
      f.cards=[{id:'a',key:'r/a',role:'worker',status:'assigned',workType:'execution'}];
      const controller=new AbortController();
      await runWatch({floor,readEntries:()=>[...f.entries],readCards:()=>f.cards,readWorks:()=>[],
        sendMailReminder:send,record:e=>{
          if(mode==='runner-result-failure'&&e.kind==='watch-mail-reminder'&&e.action==='result')throw Error('result ledger unavailable');
          f.record(e);
        },sendAlert:()=>{},intervalMs:1000,stallN:100,routes:new Map(),now:()=>f.now,
        spawn:()=>({status:0,stdout:String(process.pid)}),signal:controller.signal,print:()=>{},sleep:async()=>controller.abort()});
      assert.deepEqual(events,['read-before','send','read-after']);
      assert.equal(f.records.find(e=>e.kind==='watch-cycle').ok,false);
    }
    if(mode!=='runner-result-failure') {
      const result=f.records.find(e=>e.kind==='watch-mail-reminder'&&e.action==='result');
      assert.equal(result.delivery,'sent');assert.equal(result.reason,'send ledger unavailable');
    }
    f.tick();assert.equal(f.sent.length,1,mode);
  }
});

test('사람 입력·대화 중이면 예약 전에 보류하고, 같은 보류는 한 번만 기록한 뒤 풀리면 한 번 보낸다',()=>{
  const f=fixture();let hold={code:'KADAN_HUMAN_ACTIVE',message:'알림 보류: 사람이 이 창에서 최근 입력함'};
  const watch=new MailWatch({record:e=>f.record(e),send:(...args)=>f.send(...args),hold:()=>hold});
  f.tick(watch);f.tick(watch);
  assert.equal(f.sent.length,0);
  assert.equal(f.records.filter(e=>e.kind==='watch-mail-held').length,1);
  assert.equal(f.records.filter(e=>e.kind==='watch-mail-reminder').length,0);
  hold=null;f.tick(watch);f.tick(watch);
  assert.equal(f.sent.length,1);
});

test('확인 뒤 붙여넣기 전에 사람 입력이 생기면 예약을 풀고 재시작 뒤에도 다시 시도한다',()=>{
  const f=fixture();
  f.send=()=>{const error=new Error('알림 보류: 미제출 입력이 있음');error.code='KADAN_PANE_INPUT_PENDING';error.delivery='not-sent';throw error;};
  f.tick();
  assert.equal(f.records.filter(e=>e.action==='result'&&e.held===true).length,1);
  f.send=(...args)=>f.sent.push(args);
  f.tick();
  assert.equal(f.sent.length,1);
  f.tick();assert.equal(f.sent.length,1);
});

test('살아 있지 않은 수신자가 많아도 세션 목록은 주기당 한 번만 읽는다',()=>{
  const f=fixture(['a','b','c'].map(r=>question(`q-${r}`,{role:r})));
  let lists=0;const list=f.floor.list;f.floor.list=()=>{lists++;return list();};
  f.tick();
  assert.equal(lists,1);assert.equal(f.sent.length,0);assert.equal(f.records.length,0);
});

test('대상은 한 번 읽은 목록으로 고르고, 전송 직전에는 목록을 새로 읽어 세션이 사라졌으면 보내지 않는다',()=>{
  {const f=fixture();let lists=0;const list=f.floor.list;f.floor.list=()=>{lists++;return list();};
   f.tick();assert.equal(lists,2);assert.equal(f.sent.length,1);}
  {const f=fixture();let lists=0;f.floor.list=()=>++lists===1?f.live:[];
   f.tick();assert.equal(f.sent.length,0);
   assert.deepEqual(f.records.filter(e=>e.action==='result').map(e=>[e.delivery,e.reason]),[['not-sent','state-changed']]);}
});


test('일반 경보·감시 보고·유휴 알림·우편 깨움 모두 같은 입력 보호를 요청한다',()=>{
 const calls=[];
 const options={selectedFloor:{name:'herdr'},readStart:()=>({panePid:7}),send:e=>calls.push(e)};
 sendWatchMessage('super','경보',options);
 sendWatchNudge('super','유휴',options);
 sendWatchMailReminder('super','우편',7,options);
 assert.equal(calls.length,3);
 for(const call of calls){
  assert.equal(call.notificationOnly,true);
  assert.deepEqual(call.notificationGuard,{humanIdleMs:30_000});
 }
});

const stored = (mailId, more={}) => question(mailId, {transport:'mailbox',...more});

test('저장 전용 우편(키 전달 기록 없음)은 유예 없이 다음 주기에 한 번만 알린다',()=>{
  const f=fixture([stored('s')]);
  f.now=60000;f.tick();
  assert.equal(f.sent.length,1);assert.match(f.sent[0][1],/1건/);
  f.now=120000;f.tick();assert.equal(f.sent.length,1);
});

test('키로 전달된 일반 우편은 5분 유예 유지',()=>{
  const f=fixture([question('k',{keyDelivery:'sent'})]);
  f.now=299999;f.tick();assert.equal(f.sent.length,0);
  f.now=300000;f.tick();assert.equal(f.sent.length,1);
});

test('저장 전용이어도 keyDelivery가 남은 우편은 5분 유예로 돌아간다',()=>{
  const f=fixture([stored('sk',{keyDelivery:'sent'})]);
  f.now=60000;f.tick();assert.equal(f.sent.length,0);
  f.now=300000;f.tick();assert.equal(f.sent.length,1);
});

test('저장 전용 우편도 비서·사람 수신은 유예 0으로 보지 않는다',()=>{
  for(const role of ['비서','@user']) {
    const f=fixture([stored('s',{role})]);
    f.entries.push({kind:'start',role,session:`kadan-${role}`,panePid:2,t:at(0)});
    f.live.push({session:`kadan-${role}`,alive:true,pid:2});
    f.now=60000;f.tick();assert.equal(f.sent.length,0,role);
  }
});

test('저장 전용 우편도 사람 입력 중이면 보류하고 받는 세션이 없으면 보내지 않는다',()=>{
  const f=fixture([stored('s')]);f.now=60000;
  const watch=new MailWatch({record:e=>f.record(e),send:(...args)=>f.send(...args),hold:()=>({code:'KADAN_HUMAN_ACTIVE',message:'보류'})});
  f.tick(watch);assert.equal(f.sent.length,0);
  assert.equal(f.records.filter(e=>e.kind==='watch-mail-held').length,1);
  const g=fixture([stored('s')]);g.now=60000;g.live.length=0;
  g.tick();assert.equal(g.sent.length,0);assert.equal(g.records.length,0);
});

test('저장 전용 우편은 보낸 직후 연결 업무가 done/cancelled로 닫혀도 한 번 알린다 (retire_ooo 246c6a15·fefff233)',()=>{
  for(const status of ['done','cancelled']) {
    const f=fixture([stored('s',{workKey:'r/w'}),stored('e',{executionKey:'r/e'})]);
    f.works=[{key:'r/w',status,executions:[{key:'r/e'}]}];
    f.now=60000;f.tick();
    assert.equal(f.sent.length,1,status);assert.match(f.sent[0][1],/2건/);
    f.now=120000;f.tick();assert.equal(f.sent.length,1,status);
  }
});

test('저장 전용 우편도 일시정지(hold) 업무·읽음·이전 세대는 계속 제외하고 키로 전달된 우편은 닫힌 업무에서 제외',()=>{
  const hold=fixture([stored('h',{workKey:'r/w'})]);
  hold.works=[{key:'r/w',status:'hold',executions:[]}];
  hold.now=60000;hold.tick();assert.equal(hold.sent.length,0);
  const read=fixture([stored('r',{workKey:'r/w'})]);
  read.works=[{key:'r/w',status:'done',executions:[]}];
  read.entries.push({kind:'mail-read',mailId:'r',role:'worker',by:'worker'});
  read.now=60000;read.tick();assert.equal(read.sent.length,0);
  const old=fixture([stored('o',{workKey:'r/w'})]);
  old.works=[{key:'r/w',status:'done',executions:[]}];
  old.entries.push({kind:'stop',role:'worker',t:at(10)},{kind:'start',role:'worker',session:'kadan-worker',panePid:2,t:at(20)});
  old.live[0].pid=2;
  old.now=60000;old.tick();assert.equal(old.sent.length,0);
  const keyed=fixture([stored('k',{workKey:'r/w',keyDelivery:'sent'})]);
  keyed.works=[{key:'r/w',status:'done',executions:[]}];
  keyed.now=300000;keyed.tick();assert.equal(keyed.sent.length,0);
});

test('저장 전용 우편이 닫힌 업무에 걸려도 보류 뒤 재시도한다',()=>{
  const f=fixture([stored('s',{workKey:'r/w'})]);
  f.works=[{key:'r/w',status:'done',executions:[]}];f.now=60000;
  let held=true;
  const watch=new MailWatch({record:e=>f.record(e),send:(...args)=>f.send(...args),
    hold:()=>held?{code:'KADAN_HUMAN_ACTIVE',message:'보류'}:null});
  f.tick(watch);assert.equal(f.sent.length,0);
  held=false;f.tick(watch);assert.equal(f.sent.length,1);
});

test('닫힌 업무에 걸린 슈퍼끼리 peer 저장 우편은 계속 제외한다 (main 동작 유지)',()=>{
  const parents=new Map([['worker','@user'],['boss','@user']]);
  for(const status of ['done','cancelled']) {
    const f=fixture([stored('p',{workKey:'r/w'})]);
    f.works=[{key:'r/w',status,executions:[]}];f.now=60000;
    f.create().tick({entries:[...f.entries],cards:f.cards,works:f.works,now:f.now,floor:f.floor,
      readEntries:()=>[...f.entries],readCards:()=>f.cards,readWorks:()=>f.works,parents});
    assert.equal(f.sent.length,0,status);
  }
});
