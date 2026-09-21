import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createDatabase,writeStorageMarker} from '../src/storage.mjs';
import {readLedger,readMailBody} from '../src/ledger.mjs';
import {sendTmux} from '../src/floor-tmux.mjs';

const cli=new URL('../src/cli.mjs',import.meta.url).pathname;
test('격리 실제 tmux: 정상 CLI·복사모드·사용자 미제출 입력·paste 뒤 경합',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'scm-test-cli-'));
 createDatabase(home);writeStorageMarker(home,'sqlite');
 const role='scm-test-receiver',target=`=kadan-${role}:`,socket=`scm-test-${process.pid}-${Date.now()}`;
 const env={...process.env,KADAN_HOME:home,KADAN_SOCKET:socket,KADAN_FLOOR:'tmux',KADAN_WINDOW:'none'};
 const transcript=[],received=path.join(home,'received');
 const call=(bin,args,input)=>{const p=spawnSync(bin,args,{env,input,encoding:'utf8',timeout:10000});transcript.push({args,input,exit:p.status,stdout:p.stdout,stderr:p.stderr});return p;};
 const command=(...a)=>call(process.execPath,[cli,...a]);
 const tmux=(args,input)=>{const p=call('tmux',['-L',socket,...args],input);assert.equal(p.status,0,p.stderr);return p.stdout;};
 const mode=()=>tmux(['display-message','-p','-t',target,'#{pane_in_mode}']).trim();
 const contents=()=>fs.existsSync(received)?fs.readFileSync(received,'utf8'):'';
 const receiver=path.join(home,'receiver.mjs');
 fs.writeFileSync(receiver,`import fs from 'node:fs';import readline from 'node:readline';readline.createInterface({input:process.stdin}).on('line',l=>fs.appendFileSync(${JSON.stringify(received)},l+'\\n'));`);
 let started=false;
 try{
  const p=command('start',role,'--cmd',`'${process.execPath}' '${receiver}'`);assert.equal(p.status,0,p.stderr);started=true;
  let sent=command('send',role,'NORMAL');assert.equal(sent.status,0,sent.stderr);assert.match(sent.stdout,/키 전송됨.*입력 접수·AI 실행 미확인/);
  const receipt=readLedger(home).filter(e=>e.kind==='send').at(-1);assert.equal(receipt.keyDelivery,'sent');assert.equal(receipt.inputAcceptance,'unconfirmed');
  const expectedBody=`NORMAL\n\n우편 ID: ${receipt.mailId}. 내용을 확인한 수신자가 직접 읽음 확인을 기록하라.\n`+
   `KADAN_ROLE='${role}' kadan inbox ack '${receipt.mailId}' --role '${role}'\n`+
   '조회·답장·DONE은 자동 읽음 처리가 아니다. ack는 로컬 읽음 사건만 기록하며 회신 우편이나 추가 알림을 보내지 않는다. 읽음은 승인·착수·답변 완료·작업 완료를 뜻하지 않는다.';
  const expectedReceived=expectedBody+'\n';
  assert.equal(readMailBody(receipt.digest,home),expectedBody);
  assert.equal(receipt.digest,createHash('sha256').update(expectedBody).digest('hex').slice(0,12));
  assert.equal(receipt.bytes,Buffer.byteLength(expectedBody));assert.ok(sent.stdout.includes(`우편ID ${receipt.mailId}`));
  const end=Date.now()+3000;
  while(Date.now()<end&&contents()!==expectedReceived)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
  assert.equal(contents(),expectedReceived);
  tmux(['send-keys','-t',target,'-l','USER_PENDING_']);
  for(const keys of ['emacs','vi']){
   tmux(['set-window-option','-t',target,'mode-keys',keys]);tmux(['copy-mode','-t',target]);assert.equal(mode(),'1');
   tmux(['send-keys','-t',target,'-X','begin-selection']);
   const selection=()=>tmux(['display-message','-p','-t',target,'#{selection_present}|#{scroll_position}|#{copy_cursor_x}|#{copy_cursor_y}']);
   const beforeSelection=selection();
   const count=readLedger(home).filter(e=>e.kind==='send').length;
   sent=command('send',role,'BLOCKED');assert.notEqual(sent.status,0);assert.match(sent.stderr,/전송 보류: 기록보기/);
   assert.equal(mode(),'1');assert.equal(contents(),expectedReceived);assert.equal(readLedger(home).filter(e=>e.kind==='send').length,count);
   assert.equal(selection(),beforeSelection,'선택·스크롤 위치 보존');
   tmux(['send-keys','-t',target,'-X','cancel']); // 시험자가 설정한 모드만 시험자가 해제. 제품 send는 해제하지 않는다.
  }
  // 기록보기를 벗어난 것만으로 미제출 입력에 Enter를 보내지 않는다.
  assert.equal(contents(),expectedReceived);assert.match(tmux(['capture-pane','-p','-t',target]),/USER_PENDING_/);
  // 실제 paste 뒤 사용자 기록보기 진입을 sleep 접점에서 결정적으로 재현한다.
  assert.throws(()=>sendTmux(`kadan-${role}`,'RACE_BODY',{run:tmux,spawn:()=>{tmux(['copy-mode','-t',target]);}}),e=>e.delivery==='unknown'&&e.sendStage==='body-pasted');
  assert.equal(mode(),'1');assert.equal(contents(),expectedReceived);
  tmux(['send-keys','-t',target,'-X','cancel']);
  assert.match(tmux(['capture-pane','-p','-t',target]),/USER_PENDING_RACE_BODY/);
  // 마지막 모드 조회 뒤의 경합은 막았다고 주장하지 않는다. 반환도 접수 미확인이다.
  let checks=0;
  const late=sendTmux(`kadan-${role}`,'LATE_RACE',{run:(args,input)=>{const out=tmux(args,input);if(args[0]==='display-message'&&++checks===3)tmux(['copy-mode','-t',target]);return out;},spawn:()=>{}});
  assert.equal(late.inputAcceptance,'unconfirmed');
  transcript.push({received:contents(),pending:tmux(['capture-pane','-p','-t',target]),mode:mode()});
 }finally{
  if(started)assert.equal(command('stop',role).status,0);
  fs.writeFileSync(path.join(home,'transcript.json'),JSON.stringify(transcript,null,2)+'\n');
  console.log(`복사모드 CLI 증거: ${home}/transcript.json / socket=${socket}`);
 }
});
