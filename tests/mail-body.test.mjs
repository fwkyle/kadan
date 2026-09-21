// 편지 본문은 원장이 아니라 옆 파일에 둔다 — 2026-09-06 [kyle] 승인.
// 원장은 append-only라 줄을 못 지운다. 본문에 비밀이 섞였을 때 지울 수 있어야 한다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from 'node:child_process';
import { guardedSend, mailPreview, recentSends, sendWatchMailReminder } from "../src/cli.mjs";
import { appendLedger, readLedger, readMailLedger, mailDir, readMailBody, saveMailBody } from "../src/ledger.mjs";
import { Mailbox } from '../src/mailbox.mjs';
import { composeMailInstructions } from '../src/mail-instructions.mjs';
import { resolveWorkMail } from '../src/work-mail.mjs';

const fakeFloor = {
  name: "fake",
  alive: () => true,
  pid: () => "111",
  send: () => ({}),
};

test("보낸 본문은 지문 이름의 옆 파일로 남고 원장 줄에는 앞머리만 남는다 — 2026-09-06", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kadan-mail-"));
  const message = `작업 카드: /repo/docs/cards/card-66.md — 읽고 그대로 수행해라. ${"긴 지시 ".repeat(20)}`;
  const lines = [];

  const entry = guardedSend({
    floor: fakeFloor,
    session: "kadan-b-작업자",
    role: "b-작업자",
    message,
    taskId: "card-66",
    recordedPid: "111",
    env: {KADAN_HOME:home},
    record: line => lines.push(line),
    readEntries: () => [{kind:'start',role:'b-작업자',session:'kadan-b-작업자',panePid:'111',cmd:'codex --model test-model'}],
    saveBody: (digestValue, body) => saveMailBody(digestValue, body, home),
  });

  // 원장에는 본문이 통째로 들어가지 않는다.
  assert.equal(entry.preview.length <= 101, true);
  assert.equal(entry.preview.includes("card-66.md"), true);
  assert.equal(JSON.stringify(entry).includes(message), false);

  // 본문은 옆 파일에 그대로 있다.
  const saved = readMailBody(entry.digest, home);
  assert.ok(saved.startsWith(message+'\n\n'));
  assert.ok(saved.includes(`우편 ID: ${entry.mailId}`));
  assert.equal(saved, message+'\n\n'+composeMailInstructions({mailId:entry.mailId,recipient:'b-작업자'}));
  assert.equal(fs.existsSync(path.join(mailDir(home), `${entry.digest}.txt`)), true);

  // 본문을 보관 위치로 옮겨도 원장은 그대로다.
  fs.renameSync(path.join(mailDir(home), `${entry.digest}.txt`),path.join(mailDir(home), `${entry.digest}.saved`));
  assert.equal(readMailBody(entry.digest, home), null);
  assert.equal(lines.length, 1);
});

function mailFixture() {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-mail-ack-')),sent=[];
  const floor={...fakeFloor,send:(session,message)=>{sent.push({session,message});return {};}};
  const send=options=>guardedSend({floor,session:'kadan-recipient',role:'recipient',message:'본문',recordedPid:'111',
    env:{KADAN_HOME:home,KADAN_ROLE:'sender'},readEntries:()=>readLedger(home),
    record:e=>appendLedger(e,home),saveBody:(d,b)=>saveMailBody(d,b,home),...options});
  return {home,floor,sent,send};
}

test('모든 일반 우편은 역할 프로필 없이도 ID와 수신자 ack 안내를 받으며 raw만 본문을 보존한다',()=>{
  const f=mailFixture();
  for (const options of [{},{source:'watch'},{roleProfile:'worker'},{mailContext:{expectReply:true}}]) {
    const receipt=f.send(options),body=f.sent.at(-1).message;
    assert.ok(body.startsWith('본문\n\n'));
    assert.ok(body.includes(composeMailInstructions({mailId:receipt.mailId,recipient:'recipient'})));
    assert.equal(receipt.notificationOnly,undefined);
    assert.equal(receipt.bytes,Buffer.byteLength(body));assert.equal(readMailBody(receipt.digest,f.home),body);
    if(options.mailContext?.expectReply)assert.match(body,/질문ID: .*최종 답변: kadan send 'sender'/);
  }
  const raw='원문\n그대로\n',receipt=f.send({raw:true,message:raw});
  assert.equal(f.sent.at(-1).message,raw);assert.equal(readMailBody(receipt.digest,f.home),raw);
  assert.equal(new Mailbox(f.home,'recipient').list().some(e=>e.mailId===receipt.mailId),true);
  assert.ok(readMailLedger(f.home).every(e=>e.kind==='send'));
});

test('ack 명령의 수신자 작은따옴표·명령 치환·세미콜론은 셸에서 그대로 보존된다',()=>{
  const f=mailFixture(),role="receiver'$(printf hacked);`printf hacked`",receipt=f.send({role});
  const command=f.sent.at(-1).message.split('\n').find(line=>line.startsWith('KADAN_ROLE='));
  const result=spawnSync('/bin/sh',['-c',`kadan() { printf '%s\\n' "$KADAN_ROLE" "$@"; }\n${command}`],{encoding:'utf8',env:{PATH:'/usr/bin:/bin'}});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout,[role,'inbox','ack',receipt.mailId,'--role',role,''].join('\n'));
});

test('본문 조회·최종 답장·DONE은 읽음이 아니며 수신자 ack 반복은 로컬 사건 1건뿐이다',()=>{
  const f=mailFixture();
  appendLedger({kind:'start',role:'recipient',session:'kadan-recipient',panePid:'111',cmd:'codex --model test-model'},f.home);
  const original=f.send({taskId:'legacy-run',mailContext:{expectReply:true}}),inbox=new Mailbox(f.home,'recipient');
  assert.equal(inbox.read(original.mailId).read,false);
  f.send({role:'sender',session:'kadan-sender',env:{KADAN_HOME:f.home,KADAN_ROLE:'recipient'},mailContext:{replyTo:original.mailId,replyFinal:true}});
  appendLedger({kind:'done',role:'recipient',taskId:'legacy-run',result:'ok'},f.home);
  const result=inbox.read(original.mailId);
  assert.equal(result.read,false);assert.equal(result.replyStatus,'answered');
  assert.equal(readMailLedger(f.home).some(e=>e.kind==='mail-read'),false);
  const before=readMailLedger(f.home).length,sent=f.sent.length;
  inbox.acknowledge(original.mailId,'recipient');inbox.acknowledge(original.mailId,'recipient');
  assert.equal(readMailLedger(f.home).length,before+1);assert.equal(f.sent.length,sent);
  assert.equal(readMailLedger(f.home).filter(e=>e.kind==='mail-read').length,1);
});

test('미확인 알림은 최신 start와 실제 PID를 검사하고 notificationOnly로 기록하여 ack 안내를 제외한다',()=>{
  const f=mailFixture(),send=options=>f.send(options);
  for (const expected of [null,undefined,'','110']) {
    assert.throws(()=>sendWatchMailReminder('recipient','inbox 확인',expected,{selectedFloor:f.floor,readStart:()=>({panePid:'111'}),send}),e=>e.delivery==='not-sent');
  }
  assert.throws(()=>sendWatchMailReminder('recipient','inbox 확인','111',{selectedFloor:{...f.floor,pid:()=> '222'},readStart:()=>({panePid:'111'}),send}),e=>e.code==='KADAN_PID_MISMATCH');
  assert.throws(()=>sendWatchMailReminder('recipient','inbox 확인','111',{selectedFloor:{...f.floor,alive:()=>false},readStart:()=>({panePid:'111'}),send}),e=>e.code==='KADAN_SESSION_MISSING');
  assert.equal(f.sent.length,0);
  const receipt=sendWatchMailReminder('recipient','inbox 확인','111',{selectedFloor:f.floor,readStart:()=>({rottiePid:'111'}),send});
  assert.equal(receipt.notificationOnly,true);assert.equal(receipt.by,'watch');
  assert.equal(f.sent.length,1);assert.doesNotMatch(f.sent[0].message,/inbox ack|우편 ID:/);
  assert.equal(readMailLedger(f.home).at(-1).notificationOnly,true);
  assert.throws(()=>f.send({notificationOnly:'true'}),/boolean/);
});

test('CLI watch 연결: 미확인 callback만 notificationOnly이며 기존 watch 알림은 ack 대상이다',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-watch-mail-cli-'));
  const moduleUrl=name=>JSON.stringify(new URL(`../src/${name}.mjs`,import.meta.url).href);
  const script=`
import {mock} from 'node:test';
import assert from 'node:assert/strict';
import {appendLedger,readMailLedger} from ${moduleUrl('ledger')};
const sent=[],floor={name:'fake',alive:()=>true,pid:()=> '111',send:(s,m)=>{sent.push(m);return {};}};
appendLedger({kind:'start',role:'recipient',session:'kadan-recipient',panePid:'111'});
mock.module(${moduleUrl('floor')},{namedExports:{floor}});
mock.module(${moduleUrl('watch-runner')},{namedExports:{deliverResolution:()=>{},formatAlertBody:()=>'',runWatch:async options=>{
  assert.equal(typeof options.sendMailReminder,'function');
  options.sendMailReminder('recipient','미확인 우편 확인','111');
  options.sendAlert('recipient','기존 완료후보 알림');
  const mail=readMailLedger();
  assert.equal(mail.length,2);assert.equal(mail[0].notificationOnly,true);assert.equal(mail[1].notificationOnly,undefined);
  assert.doesNotMatch(sent[0],/inbox ack/);assert.match(sent[1],/inbox ack/);
  appendLedger({kind:'start',role:'recipient',session:'kadan-recipient',panePid:'222'});
  assert.throws(()=>options.sendMailReminder('recipient','늦은 알림','111'),e=>e.delivery==='not-sent');
  assert.equal(sent.length,2);
}}});
const {main}=await import(${moduleUrl('cli')});
await main(['watch','--interval','1']);
`;
  const result=spawnSync(process.execPath,['--experimental-test-module-mocks','--input-type=module','--eval',script],
    {encoding:'utf8',env:{...process.env,KADAN_HOME:home,KADAN_FLOOR:'tmux',KADAN_ROLE:'',KADAN_WINDOW:'none'},timeout:10000});
  assert.equal(result.status,0,result.stderr+result.stdout);
});

test('공통 질문 안내는 인계된 현재 발신자 회신 주소와 사용자 mailbox 경로를 사용한다',()=>{
  const id='f04e5be7-dabf-4629-acb7-9899db76e6b2';
  const instructions=composeMailInstructions({mailId:id,recipient:'new-recipient',expectReply:true,sender:"new-sender'quoted"});
  assert.match(instructions,/KADAN_ROLE='new-recipient'/);
  assert.ok(instructions.includes("kadan send 'new-sender'\\''quoted'"));
  assert.ok(instructions.includes(`--reply-to '${id}' --reply-final`));
  assert.match(composeMailInstructions({mailId:id,recipient:'new-recipient',expectReply:true,sender:'사람'}),/--reply-final --mailbox/);
  assert.doesNotMatch(composeMailInstructions({mailId:id,recipient:'new-recipient',expectReply:false,sender:'사람'}),/reply-final/);
  assert.equal(composeMailInstructions({mailId:id,recipient:'new-recipient',notificationOnly:true,expectReply:true,sender:'사람'}),'');
});

for (const mode of ['normal','raw','pid-mismatch','missing-start']) test(`CLI 늦은 답장: 옛 발신 주소를 후임 세션/PID로 확인하고 실제 수신자를 기록 (${mode})`,()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-reply-routing-'));
  const moduleUrl=name=>JSON.stringify(new URL(`../src/${name}.mjs`,import.meta.url).href);
  const script=`
import {mock} from 'node:test';
import assert from 'node:assert/strict';
import {appendLedger,readMailLedger,readMailBody} from ${moduleUrl('ledger')};
import {Mailbox} from ${moduleUrl('mailbox')};
const mode=${JSON.stringify(mode)},home=process.env.KADAN_HOME,sent=[];
const question=new Mailbox(home,'receiver').send({by:'old-sender',message:'원본 질문',expectReply:true});
const original=readMailLedger()[0];
appendLedger({kind:'start',role:'old-sender',session:'kadan-old-sender',panePid:'111'});
if(mode!=='missing-start')appendLedger({kind:'start',role:'new-sender',session:'kadan-new-sender',panePid:'222'});
appendLedger({kind:'handover',phase:'transferred',from:'old-sender',to:'new-sender',handoverId:'old-new',taskIds:[]});
const floor={name:'fake',alive:s=>{assert.equal(s,'kadan-new-sender');return true;},pid:s=>{assert.equal(s,'kadan-new-sender');return mode==='pid-mismatch'?'999':'222';},send:(session,message)=>{sent.push({session,message});return {};}};
mock.module(${moduleUrl('floor')},{namedExports:{floor}});
const {main}=await import(${moduleUrl('cli')});
await main(['send','old-sender','--reply-to',question.mailId,'--reply-final',...(mode==='raw'?['--raw']:[]),'늦은 답장']);
assert.equal(sent.length,1);assert.equal(sent[0].session,'kadan-new-sender');
const answer=readMailLedger().filter(e=>e.kind==='send').at(-1);
assert.equal(answer.role,'new-sender');assert.equal(answer.session,'kadan-new-sender');assert.equal(answer.by,'receiver');
assert.equal(answer.replyTo,question.mailId);assert.equal(answer.replyFinal,true);
assert.deepEqual(readMailLedger().find(e=>e.mailId===question.mailId),original);
assert.equal(new Mailbox(home,'receiver').read(question.mailId).read,false);
assert.equal(new Mailbox(home,'receiver').read(question.mailId).replyStatus,'answered');
if(mode==='raw')assert.equal(readMailBody(answer.digest),'늦은 답장');
else assert.match(sent[0].message,/KADAN_ROLE='new-sender' kadan inbox ack/);
`;
  const result=spawnSync(process.execPath,['--experimental-test-module-mocks','--input-type=module','--eval',script],
    {encoding:'utf8',env:{...process.env,KADAN_HOME:home,KADAN_FLOOR:'tmux',KADAN_ROLE:'receiver',KADAN_WINDOW:'none'},timeout:10000});
  if (mode==='pid-mismatch'||mode==='missing-start') {
    assert.equal(result.status,1,result.stderr);
    assert.match(result.stderr,mode==='pid-mismatch'?/기록 222 \/ 현재 999/:/new-sender의 시작 기록\/PID가 없습니다/);
    assert.equal(readMailLedger(home).filter(e=>e.kind==='send').length,1);
  } else {
    assert.equal(result.status,0,result.stderr+result.stdout);
    assert.match(result.stdout,/전달됨: kadan-new-sender/);assert.doesNotMatch(result.stdout,/전달됨: kadan-old-sender/);
  }
});

for (const phase of ['before-guard','before-send','after-send']) test(`답장 인계 경합은 대상/PID를 바꾸지 않고 닫히며 실제 전달 사실은 보존 (${phase})`,()=>{
  const f=mailFixture(),question=f.send({mailContext:{expectReply:true}});
  const transfer=(from,to)=>appendLedger({kind:'handover',phase:'transferred',from,to,handoverId:`${from}-${to}`,taskIds:[]},f.home);
  transfer('sender','next');
  const context=resolveWorkMail(f.home,{role:'sender',by:'recipient',replyTo:question.mailId,replyFinal:true});
  assert.equal(context.currentRecipient,'next');
  if(phase==='before-guard')transfer('next','last');
  const floor={...f.floor,pid:()=>{if(phase==='before-send')transfer('next','last');return '111';},send:(session,message)=>{
    const result=f.floor.send(session,message);if(phase==='after-send')transfer('next','last');return result;
  }};
  assert.throws(()=>f.send({floor,role:'next',session:'kadan-next',env:{KADAN_HOME:f.home,KADAN_ROLE:'recipient'},mailContext:context}),
    e=>e.code==='KADAN_MAIL_RECIPIENT_CHANGED'&&e.delivery===(phase==='after-send'?'sent':'not-sent'));
  const sends=readMailLedger(f.home).filter(e=>e.kind==='send');
  if(phase==='after-send'){
    assert.equal(f.sent.length,2);assert.equal(sends.length,2);
    assert.equal(sends[1].role,'next');assert.equal(sends[1].session,'kadan-next');
    assert.equal(sends[1].replyFinal,false);assert.equal(sends[1].replyFinalRejected,true);
  }else{assert.equal(f.sent.length,1);assert.equal(sends.length,1);}
  assert.equal(new Mailbox(f.home,'recipient').read(question.mailId).replyStatus,'waiting');
});

test("미리보기는 줄바꿈을 눕히고 한 줄로 자른다", () => {
  assert.equal(mailPreview("짧은 지시"), "짧은 지시");
  assert.equal(mailPreview("여러\n줄\t지시"), "여러 줄 지시");
  const long = mailPreview("가".repeat(200));
  assert.equal(long.length, 101);
  assert.equal(long.endsWith("…"), true);
  assert.equal(mailPreview(undefined), "");
});

test("우편함은 미리보기를 함께 넘긴다 — 본문이 없으면 본문 칸도 없다", () => {
  const entries = [
    { t: "2026-09-06T02:10:00.000Z", kind: "send", role: "b-작업자", taskId: "card-66", bytes: 30, digest: "없는지문", preview: "작업 카드: …", by: "슈퍼감독" },
  ];
  const mail = recentSends(entries);

  assert.equal(mail[0].preview, "작업 카드: …");
  assert.equal("body" in mail[0], false);
});
