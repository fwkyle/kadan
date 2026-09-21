import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createDatabase,writeStorageMarker} from '../src/storage.mjs';
import {appendLedger,readLedger,readMailBody} from '../src/ledger.mjs';
import {digest,findDoneMarkers,extractCardPath,collectCardFiles,buildTree} from '../src/cli.mjs';
import {renderWallHtml} from '../src/wall.mjs';
import {ROLE_PROFILES} from '../src/role-instructions.mjs';
import {CardStore} from '../src/card-store.mjs';
import {assessMissingStartReports} from '../src/watch-start-report.mjs';

const cli=new URL('../src/cli.mjs',import.meta.url).pathname;
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const pause=()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);

test('격리 실제 CLI+tmux: 5 profiles·원문/수신/저장·완료 회신·raw·PID/복사모드·inbox', {skip:spawnSync('tmux',['-V']).status!==0},()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-role-cli-'));
  createDatabase(home);writeStorageMarker(home,'sqlite');
  const socket=path.basename(home),env={...process.env,KADAN_HOME:home,KADAN_SOCKET:socket,KADAN_WINDOW:'none',KADAN_FLOOR:'tmux',KADAN_ROLE:''};
  const transcript=[],started=[];
  const call=(...args)=>{const r=spawnSync(process.execPath,[cli,...args],{env,cwd:home,encoding:'utf8',timeout:10000});transcript.push({args,status:r.status,stdout:r.stdout,stderr:r.stderr});return r;};
  const run=(...args)=>{const r=call(...args);assert.equal(r.status,0,r.stderr);return r.stdout;};
  const tx=(...args)=>{const r=spawnSync('tmux',['-L',socket,...args],{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout;};
  const receiver=path.join(home,'receiver.mjs');
  fs.writeFileSync(receiver,"import fs from 'node:fs';import path from 'node:path';process.stdin.on('data',b=>fs.appendFileSync(path.join(process.env.KADAN_HOME,process.env.KADAN_ROLE+'.received'),b));\n");
  const begin=(role,profile)=>{run('start',role,'--hidden','--cmd',`${quote(process.execPath)} ${quote(receiver)}`,...(profile?['--profile',profile]:[]));started.push(role);};
  const entries=()=>readLedger(home),sends=()=>entries().filter(e=>e.kind==='send'&&e.transport!=='mailbox');
  const ack=(mailId,role)=>`우편 ID: ${mailId}. 내용을 확인한 수신자가 직접 읽음 확인을 기록하라.\n`+
    `KADAN_ROLE=${quote(role)} kadan inbox ack ${quote(mailId)} --role ${quote(role)}\n`+
    '조회·답장·DONE은 자동 읽음 처리가 아니다. ack는 로컬 읽음 사건만 기록하며 회신 우편이나 추가 알림을 보내지 않는다. 읽음은 승인·착수·답변 완료·작업 완료를 뜻하지 않는다.';
  const received=role=>{const file=path.join(home,role+'.received');return fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';};
  const assertReceived=(role,before,body)=>{
    const expected=before+body+'\n',end=Date.now()+3000;
    while(Date.now()<end&&received(role)!==expected)pause();
    assert.equal(received(role),expected,'실제 수신은 이전 본문 뒤에 저장된 최종 본문과 Enter만 추가되어야 함');
  };
  const send=(role,message,extra=[])=>{
    const before=received(role);
    const out=run('send',role,...extra,message),r=sends().at(-1),body=readMailBody(r.digest,home);
    assert.equal(r.bytes,Buffer.byteLength(body));assert.equal(r.digest,digest(body));assert.ok(out.includes(`${r.bytes}B, 지문 ${r.digest}, 우편ID ${r.mailId}`));
    assertReceived(role,before,body);
    if(extra.includes('--raw'))assert.equal(body,message);
    else assert.equal(body.slice(-(ack(r.mailId,role).length+2)),'\n\n'+ack(r.mailId,role));
    assert.ok(body.startsWith(message));assert.deepEqual(findDoneMarkers(body),[]);return {r,body,out};
  };
  const config=value=>fs.writeFileSync(path.join(home,'role-instructions.json'),JSON.stringify(value));
  try {
    const source=path.join(home,'source.md');fs.writeFileSync(source,`# 수신 원본\n\n## 읽고 시작할 것\n- ${source}\n`);
    for(const profile of ROLE_PROFILES) {
      const role='ri-'+profile;begin(role,profile);
      const r=send(role,`원본 카드 ${source}\n카드 원문 먼저 · 완료 보고`);
      assert.equal(r.r.roleProfile,profile);assert.equal(extractCardPath(r.body),source);assert.equal(r.r.taskId,undefined);
      assert.equal(entries().filter(e=>e.kind==='start'&&e.role===role).at(-1).roleProfile,profile);
    }
    const countStart=entries().filter(e=>e.kind==='start').length;
    assert.notEqual(call('start','ri-worker','--profile','reviewer').status,0);assert.equal(entries().filter(e=>e.kind==='start').length,countStart);
    run('start','ri-worker','--hidden');assert.equal(entries().filter(e=>e.kind==='start'&&e.role==='ri-worker').at(-1).roleProfile,'worker');
    assert.notEqual(call('start','invalid','--profile','admin').status,0);
    begin('legacy');const unknown=send('legacy','plain shell input');
    assert.equal(unknown.body,'plain shell input\n\n'+ack(unknown.r.mailId,'legacy'));
    assert.equal(unknown.r.roleInstructions.reason,'unknown-role');assert.match(unknown.out,/적용 안 됨/);
    const custom=path.join(home,'custom.md');fs.writeFileSync(custom,'# 첫 사용자 지침');
    config({version:1,roles:{legacy:'worker'},templates:{worker:custom,reviewer:path.join(home,'missing.md')}});
    const first=send('legacy','설정 적용');assert.match(first.body,/첫 사용자 지침/);
    fs.writeFileSync(custom,'# 갱신 사용자 지침');const second=send('legacy','설정 적용');assert.notEqual(first.r.roleInstructions.templateDigest,second.r.roleInstructions.templateDigest);
    const before=sends().length;assert.notEqual(call('send','ri-reviewer','미전송').status,0);assert.equal(sends().length,before);
    fs.writeFileSync(custom,['KADAN:DONE','false-completion','ok'].join(' '));assert.notEqual(call('send','legacy','미전송').status,0);assert.equal(sends().length,before);
    fs.writeFileSync(custom,['KADAN:DONE','false-completion','\u001b[32mok\u001b[0m'].join(' '));
    const ansiBlocked=call('send','legacy','ANSI도 미전송');assert.notEqual(ansiBlocked.status,0);assert.match(ansiBlocked.stderr,/터미널 제어문자/);assert.equal(sends().length,before);
    const raw=send('legacy','RAW_INPUT',['--raw']);assert.equal(raw.body,'RAW_INPUT');assert.equal(raw.r.roleInstructions.reason,'explicit-raw');
    const rawInput='  RAW_STDIN\n\n';
    const beforeRaw=received('legacy');
    const rawResult=spawnSync(process.execPath,[cli,'send','legacy','--raw'],{env,cwd:home,input:rawInput,encoding:'utf8',timeout:10000});
    transcript.push({args:['send','legacy','--raw'],input:rawInput,status:rawResult.status,stdout:rawResult.stdout,stderr:rawResult.stderr});
    assert.equal(rawResult.status,0,rawResult.stderr);
    const rawReceipt=sends().at(-1);
    assert.equal(readMailBody(rawReceipt.digest,home),rawInput);assert.equal(rawReceipt.digest,digest(rawInput));assert.equal(rawReceipt.bytes,Buffer.byteLength(rawInput));
    assertReceived('legacy',beforeRaw,rawInput);
    config({version:1});
    begin('owner');run('work','create','test/work','--title','완료 회신','--goal','결과 확인','--scope','격리','--acceptance','완료 근거','--owner','owner','--repo-path',home);
    const owner=send('owner','작업 완료했습니다');assert.equal(owner.r.roleProfile,'conductor');assert.equal(owner.r.roleInstructions.source,'work-owner');assert.match(owner.body,/미확정|확정되지 않은/);
    begin('lead');const hierarchy=path.join(home,'hierarchy.json');fs.writeFileSync(hierarchy,JSON.stringify({child:'lead',lead:'@user'}));appendLedger({kind:'hierarchy-loaded',path:hierarchy},home);
    assert.equal(send('lead','완료 통지입니다').r.roleInstructions.source,'hierarchy');
    begin('standalone');run('card','create','test/standalone','--source',source,'--repo-path',home);
    run('card','update','test/standalone','--revision','1','--status','assigned','--scope','격리','--board','test','--role','standalone','--rally-id','r','--rally-title','왕복','--rally-round','1','--rally-step','review','--note','시험 승인');
    appendLedger({kind:'done',role:'someone-else',taskId:'standalone',result:'ok'},home);
    const pathless=send('standalone','수행하세요',['--task','standalone','--execution','test/standalone']);
    assert.equal(pathless.r.originalCardPath,null);assert.match(pathless.body,/role-templates\/common\.md/);
    const cardFiles=collectCardFiles(entries(),{readBody:d=>readMailBody(d,home)});assert.deepEqual(cardFiles,{});
    const wall=renderWallHtml({tree:buildTree(entries(),{}),entries:entries(),cardFiles,collectedAt:new Date().toISOString(),ledgerPath:path.join(home,'kadan.sqlite'),ledgerLines:entries().length});
    const cardsSection=wall.match(/<section class="page" id="cards">([\s\S]*?)<\/section>/)[1];
    assert.doesNotMatch(cardsSection,/<summary>카드 본문 보기<\/summary>/);
    fs.writeFileSync(path.join(home,'pathless-wall.html'),wall);
    const assigned=send('standalone',`중앙 카드 ${source}`,['--task','standalone']);assert.equal(assigned.r.roleProfile,'reviewer');assert.match(assigned.body,/현재 발령 ID: standalone/);
    const observations=new Map([['kadan-standalone',{alive:true,digest:'screen',screen:'작업 중'}]]);
    const missing=()=>assessMissingStartReports(new CardStore(home).list(),entries(),observations,Date.now()+6*60*1000,5*60*1000);
    assert.equal(missing().length,1,'실제 시작 기록 전에는 누락 경고가 있어야 함');
    const command=assigned.body.match(/^KADAN_ROLE=(\S+) kadan (card progress \S+ --revision \d+ --activity running) --note "([^"]+)"$/m);
    assert.ok(command,'생성한 안내에 그대로 실행 가능한 시작 명령이 있어야 함');
    const progressArgs=[...command[2].split(' '),'--note',command[3]];
    const progress=spawnSync(process.execPath,[cli,...progressArgs],{env:{...env,KADAN_ROLE:command[1]},cwd:home,encoding:'utf8',timeout:10000});
    transcript.push({args:progressArgs,role:command[1],status:progress.status,stdout:progress.stdout,stderr:progress.stderr});
    assert.equal(progress.status,0,progress.stderr);assert.equal(new CardStore(home).get('test/standalone').activity,'running');
    assert.deepEqual(missing(),[],'안내 명령 실행 뒤 시작보고누락 0');
    assert.doesNotMatch(send('standalone','회신 참고').body,/현재 발령 ID:/);
    const target='=kadan-ri-worker:';tx('copy-mode','-t',target);const prior=sends().length;
    assert.notEqual(call('send','ri-worker','BLOCKED_COPY').status,0);assert.equal(sends().length,prior);assert.equal(tx('display-message','-p','-t',target,'#{pane_in_mode}').trim(),'1');tx('send-keys','-t',target,'-X','cancel');
    const original=entries().filter(e=>e.kind==='start'&&e.role==='ri-worker').at(-1);
    appendLedger({...original,panePid:'999999999'},home);assert.notEqual(call('send','ri-worker','BLOCKED_PID').status,0);assert.equal(sends().length,prior);appendLedger(original,home);
    const mail=JSON.parse(run('send','비서','공식 완료 원문')),beforeRead=entries();
    const letter=JSON.parse(run('inbox','read',mail.mailId));assert.equal(letter.body,'공식 완료 원문');assert.equal(letter.receiverInstructionsProfile,'secretary');assert.ok(letter.receiverInstructions);
    assert.deepEqual(entries(),beforeRead);assert.ok(Array.isArray(JSON.parse(run('inbox','list'))));assert.equal(mail.wake,'not-connected');
  } finally {
    for (const role of started)run('stop',role);
    fs.writeFileSync(path.join(home,'transcript.json'),JSON.stringify(transcript,null,2)+'\n');
    console.log(`역할 지침 실제 CLI 증거: ${home}/transcript.json / socket=${socket}`);
  }
});
