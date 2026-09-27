import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {guardedSend} from '../src/cli.mjs';
import {Mailbox,mailboxLetters,inboxCommand} from '../src/mailbox.mjs';
import {appendLedger,readLedger,readMailLedger,saveMailBody} from '../src/ledger.mjs';
import {createDatabase,writeStorageMarker} from '../src/storage.mjs';
import {MailWatch} from '../src/watch-mail.mjs';
import {mailboxUnread} from '../src/dashboard-home.mjs';
import {renderActivity} from '../src/decision-wall.mjs';
import {filterMail,mailStatus} from '../src/dashboard-inbox.mjs';
import {dashboardData} from '../src/dashboard-api.mjs';

// raw 창 전달 성공은 전달 읽음, 기록용 알림은 미확인 목록·건수에서 제외 (2026-09-27 [kyle])
// 기본 원장 경로로 새지 않게 이 파일의 기본 KADAN_HOME도 임시 폴더로 둔다. 각 시험은 자기 폴더를 명시한다.
process.env.KADAN_HOME=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-delivered-read-default-'));
const home=()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-delivered-read-'));createDatabase(dir);writeStorageMarker(dir,'sqlite');return dir;};
const fakeFloor=(receipt)=>({name:'tmux',alive:()=>true,pid:()=> '42',send:()=>typeof receipt==='function'?receipt():receipt});
const deliver=(dir,{raw=true,receipt={keyDelivery:'sent',inputAcceptance:'unconfirmed'},...more}={})=>
 guardedSend({floor:fakeFloor(receipt),session:'kadan-receiver',role:'receiver',message:'감독 보고 원문',raw,recordedPid:'42',env:{KADAN_HOME:dir,KADAN_ROLE:'sender'},
  record:e=>appendLedger(e,dir),readEntries:()=>readLedger(dir),saveBody:(d,m)=>saveMailBody(d,m,dir),...more});
const url=query=>new URL('http://localhost/'+query);

test('raw 창 전달 성공은 전달 읽음으로 남고 --unread·기본 받은 목록에서 빠진다',()=>{
 const dir=home();
 const entry=deliver(dir);
 assert.equal(entry.deliveredRead,true);
 const stored=readMailLedger(dir).find(e=>e.mailId===entry.mailId);
 assert.equal(stored.deliveredRead,true);assert.equal(stored.keyDelivery,'sent');
 const [letter]=mailboxLetters(readMailLedger(dir));
 assert.equal(letter.read,true);assert.equal(letter.readKind,'delivered-read');
 assert.equal(inboxCommand([],{role:'receiver',unread:true},{home:dir,by:'receiver'}).length,0);
 assert.equal(inboxCommand([],{role:'receiver'},{home:dir,by:'receiver'}).length,0);
 assert.equal(inboxCommand([],{role:'receiver',all:true},{home:dir,by:'receiver'}).length,1);
 assert.match(mailStatus(letter),/창 전달 읽음 · 수신자 확인 아님/);
 // 이미 읽음이므로 수신자 ack는 새 기록 없이 읽음만 돌려준다.
 const before=readMailLedger(dir).length;
 assert.deepEqual(new Mailbox(dir,'receiver').acknowledge(entry.mailId,'receiver'),{mailId:entry.mailId,read:true});
 assert.equal(readMailLedger(dir).length,before);
});

test('전달 확인이 없거나 실패하면 raw여도 안 읽음으로 남는다',()=>{
 const dir=home();
 const unknown=deliver(dir,{receipt:{}});
 assert.equal(unknown.deliveredRead,undefined);
 for(const delivery of ['not-sent','unknown']){
  const error=Object.assign(new Error('전달 실패'),{delivery});
  assert.throws(()=>deliver(dir,{receipt:()=>{throw error;}}),e=>e.delivery===delivery);
 }
 const letters=mailboxLetters(readMailLedger(dir));
 assert.equal(letters.length,1);assert.equal(letters[0].read,false);assert.equal(letters[0].readKind,null);
 assert.equal(inboxCommand([],{role:'receiver',unread:true},{home:dir,by:'receiver'}).length,1);
});

test('일반 전달·기록용 알림·저장 우편은 자동 읽음이 없고 질문은 답변 대기를 유지한다',()=>{
 const dir=home();
 const normal=deliver(dir,{raw:false});
 const question=deliver(dir,{raw:false,mailContext:{expectReply:true}});
 const notice=deliver(dir,{raw:true,notificationOnly:true});
 const stored=new Mailbox(dir,'receiver').send({by:'sender',message:'저장 우편'});
 for(const entry of [normal,question,notice])assert.equal(entry.deliveredRead,undefined);
 assert.throws(()=>deliver(dir,{raw:true,mailContext:{expectReply:true}}),/--raw/);
 const byId=new Map(mailboxLetters(readMailLedger(dir)).map(e=>[e.mailId,e]));
 for(const id of [normal.mailId,question.mailId,notice.mailId,stored.mailId])assert.equal(byId.get(id).read,false);
 assert.equal(byId.get(question.mailId).replyStatus,'waiting');
 assert.deepEqual(inboxCommand([],{role:'receiver',unread:true},{home:dir,by:'receiver'}).map(e=>e.mailId).sort(),
  [normal.mailId,question.mailId,stored.mailId].sort());
});

test('기록용 알림은 원장에 남지만 미확인 목록·대시보드 건수에서 빠진다',()=>{
 const send=(mailId,more={})=>({kind:'send',mailId,by:'watch',role:'boss',t:'2026-09-27T00:00:00Z',...more});
 const entries=[send('plain',{by:'worker'}),send('notice',{notificationOnly:true}),
  send('completion',{systemGenerated:'task-completion',completion:true})];
 const letters=mailboxLetters(entries);
 assert.equal(letters.length,3);
 assert.deepEqual(mailboxLetters(entries,'boss',{unread:true}).map(e=>e.mailId),['plain']);
 assert.deepEqual(mailboxLetters(entries,'boss',{all:true}).map(e=>e.mailId),['plain','notice','completion']);
 assert.equal(mailboxUnread(entries,entries.length),1);
 assert.deepEqual(filterMail(letters,url('?mailUnread=1')).map(e=>e.mailId),['plain']);
 assert.equal(dashboardData({entries,ledgerLines:entries.length,collectedAt:'t'},url('api/dashboard/mail')).unread,1);
 assert.match(renderActivity({entries,ledgerLines:entries.length},url('')),/전체 역할 미확인 1건/);
});

test('감시기 재알림 대상은 그대로: 전달 읽음·기록용 알림 제외, 일반 미확인만',()=>{
 const t=new Date(0).toISOString();
 const mail=(mailId,more={})=>({kind:'send',mailId,role:'worker',by:'boss',t,...more});
 const entries=[{kind:'start',role:'worker',session:'kadan-worker',panePid:1,t},
  mail('delivered',{deliveredRead:true}),mail('notice',{notificationOnly:true}),mail('plain')];
 const records=[],sent=[];
 const watch=new MailWatch({record:e=>{records.push(e);entries.push(e);},send:(...args)=>sent.push(args)});
 watch.tick({entries:[...entries],cards:[],works:[],now:300000,floor:{list:()=>[{session:'kadan-worker',alive:true,pid:1}],read:()=> '›'},
  readEntries:()=>[...entries],readCards:()=>[],readWorks:()=>[]});
 assert.deepEqual(records.filter(e=>e.action==='reserved').map(e=>e.mailId),['plain']);
 assert.equal(sent.length,1);assert.match(sent[0][1],/1건/);
});
