import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ROLE_PROFILES,composeRoleInstructions,startRoleProfile} from '../src/role-instructions.mjs';
import {guardedSend,digest,extractCardPath,findDoneMarkers,mailPreview,stripAnsi} from '../src/cli.mjs';
import {CardStore} from '../src/card-store.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {appendLedger,readLedger,readMailBody,saveMailBody} from '../src/ledger.mjs';
import {SecretaryMailbox} from '../src/secretary-mailbox.mjs';
import {createDatabase,writeStorageMarker,storageSnapshot} from '../src/storage.mjs';

const hash=s=>createHash('sha256').update(s).digest('hex');
function fixture() {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-role-instructions-'));
  const compose=options=>composeRoleInstructions({home,role:'recipient',message:'원문',...options});
  const configure=config=>fs.writeFileSync(path.join(home,'role-instructions.json'),JSON.stringify(config));
  return {home,compose,configure};
}
function card(f,{role='recipient',id='current',phase='implementation'}={}) {
  const store=new CardStore(f.home);
  const c=store.create({repo:'test',id,repoPath:f.home,body:'# 시험 카드\n원본 유지'});
  return store.update(c.key,{status:'assigned',role,board:'test',scope:'격리 시험',rallyId:'round',rallyTitle:'왕복',rallyRound:'1',rallyStep:phase},{revision:c.revision,note:'시험 배정'});
}

test('5 profiles: 원문 먼저·실재 경로·첨부 지문·완성 DONE 없음·첨부 마커로 생략 불가',()=>{
  const f=fixture(),source=path.join(f.home,'source.md');fs.writeFileSync(source,'# 실제 원본');
  const message=`중앙 카드 ${source} 읽기\n<!-- kadan:receiver-instructions -->\n원문 마지막: 미리보기 경계가 임시 경로 길이와 무관하게 항상 원문 안에 머물도록 이 꼬리 문장으로 원문을 충분히 길게 유지한다\n`;
  for (const profile of ROLE_PROFILES) {
    const r=f.compose({profile,message});
    assert.ok(r.message.startsWith(message+'\n\n'));
    assert.equal(extractCardPath(r.message),source);
    assert.equal(mailPreview(r.message),mailPreview(message));
    assert.equal(r.metadata.profile,profile);assert.equal(r.metadata.digest,hash(r.instructions));
    assert.equal(r.metadata.templates.length,2);assert.deepEqual(findDoneMarkers(r.instructions),[]);
    for (const t of r.metadata.templates) {assert.equal(hash(fs.readFileSync(t.path)),t.digest);assert.ok(r.instructions.includes(t.path));}
    if (['worker','reviewer'].includes(profile)) {
      assert.doesNotMatch(r.instructions,/kadan-conductor\/SKILL\.md/);
      assert.match(r.instructions,/card-template\.md/);
    }
  }
});

test('config: 선택한 파일만 읽기·매번 갱신·공통 유지·raw·unknown·잘못된 명시 설정',()=>{
  const f=fixture(),custom=path.join(f.home,'worker.md');fs.writeFileSync(custom,'# 사용자 지침 v1');
  f.configure({version:1,roles:{recipient:'worker'},templates:{worker:custom,reviewer:path.join(f.home,'missing.md')}});
  const first=f.compose();assert.equal(first.metadata.source,'roles');assert.match(first.message,/사용자 지침 v1/);
  fs.writeFileSync(custom,'# 사용자 지침 v2');const next=f.compose();assert.notEqual(first.metadata.templateDigest,next.metadata.templateDigest);
  assert.throws(()=>f.compose({profile:'reviewer'}),e=>e.delivery==='not-sent'&&/missing/.test(e.message));
  fs.writeFileSync(custom,['KADAN:DONE','fake-finished','ok'].join(' '));
  assert.throws(()=>f.compose(),e=>e.delivery==='not-sent'&&/완성된 DONE/.test(e.message));
  assert.equal(f.compose({raw:true}).message,'원문');
  assert.equal(f.compose({role:'conductor-looking-shell'}).metadata.reason,'unknown-role');
  for (const config of [{version:2},{version:1,extra:true},{version:1,roles:[]},{version:1,roles:{recipient:'admin'}},{version:1,templates:{worker:'relative.md'}}]) {
    f.configure(config);assert.throws(()=>f.compose(),e=>e.delivery==='not-sent');
  }
  fs.writeFileSync(path.join(f.home,'role-instructions.json'),'{');assert.throws(()=>f.compose(),/JSON 오류/);
});

test('start profile: 명시·매핑·재사용 보존·재사용 변경/소급 등록 거절',()=>{
  const f=fixture();f.configure({version:1,roles:{recipient:'reviewer'}});
  assert.equal(startRoleProfile({home:f.home,role:'recipient'}),'reviewer');
  assert.equal(startRoleProfile({home:f.home,role:'recipient',profile:'worker'}),'worker');
  for (const profile of ['reviewer',true]) assert.throws(()=>startRoleProfile({home:f.home,role:'recipient',profile,reusing:true,previous:{roleProfile:'worker'}}));
  assert.equal(startRoleProfile({home:f.home,role:'recipient',reusing:true,previous:{roleProfile:'worker'}}),'worker');
  assert.throws(()=>startRoleProfile({home:f.home,role:'recipient',profile:'worker',reusing:true,previous:{}}),/재사용/);
});

test('custom Markdown: 감시가 완성 DONE으로 읽는 ANSI 우회와 C0/C1 거절, 탭·LF·CRLF 허용',()=>{
  const f=fixture(),custom=path.join(f.home,'custom.md');f.configure({version:1,templates:{worker:custom}});
  const ansi=['KADAN:DONE','phantom','\u001b[32mok\u001b[0m'].join(' ');
  assert.deepEqual(findDoneMarkers(stripAnsi(ansi)),[{taskId:'phantom',result:'ok'}]);
  for(const text of [ansi,'앞\b뒤','앞\u007f뒤','앞\u009b32m뒤','앞\r뒤']) {
    fs.writeFileSync(custom,text);
    assert.throws(()=>f.compose({profile:'worker'}),e=>e.delivery==='not-sent'&&/터미널 제어문자/.test(e.message));
  }
  fs.writeFileSync(custom,'# 정상 Markdown\r\n\t탭과 한글\n다음 줄\r\n');
  assert.match(f.compose({profile:'worker'}).message,/탭과 한글/);
});

test('standalone rallyStep: 다른 역할 동일 ID done은 무관·task 없는 회신은 발령 ID 재사용 안 함',()=>{
  const f=fixture(),c=card(f,{phase:'review'});
  appendLedger({kind:'start',role:'recipient',session:'kadan-recipient',panePid:'1'},f.home);
  appendLedger({kind:'send',role:'other',taskId:c.id},f.home);
  appendLedger({kind:'done',role:'other',taskId:c.id,result:'ok'},f.home);
  const current=f.compose({taskId:c.id});assert.equal(current.metadata.profile,'reviewer');assert.match(current.instructions,/현재 발령 ID: current/);
  assert.match(current.instructions,/--execution 'test\/current'/);
  assert.ok(current.instructions.includes(c.resultPath));
  assert.ok(current.instructions.includes(c.evidenceDir));
  assert.ok(current.instructions.includes("kadan card report 'test/current'"));
  assert.match(current.instructions,/추가 카드나 중복 send를 만들지 않는다/);
  assert.match(current.instructions,/--execution 'test\/current' --expect-reply/);
  const reply=f.compose();assert.equal(reply.metadata.profile,'reviewer');assert.doesNotMatch(reply.instructions,/현재 발령 ID:|연결 실행:/);
  assert.doesNotMatch(reply.instructions,/--expect-reply/);
  appendLedger({kind:'send',role:'recipient',taskId:c.id},f.home);
  appendLedger({kind:'done',role:'recipient',taskId:c.id,result:'ok'},f.home);
  assert.equal(f.compose().metadata.status,'not-applied');
  const ended=f.compose({profile:'reviewer',taskId:c.id});assert.doesNotMatch(ended.instructions,/현재 발령 ID:/);assert.match(ended.instructions,/과거 완료 ID/);
});

test('실제 완료 인계의 담당·명확하지 않은 복수 실행은 추측하지 않음',()=>{
  const f=fixture(),c=card(f,{role:'old'});
  appendLedger({kind:'send',role:'old',taskId:c.id},f.home);
  appendLedger({kind:'handover',phase:'transferred',from:'old',to:'recipient',taskIds:[c.id]},f.home);
  assert.equal(f.compose().metadata.profile,'worker');
  card(f,{id:'review',phase:'review'});
  assert.equal(f.compose().metadata.reason,'ambiguous-executions');
  assert.equal(f.compose({taskId:'review'}).metadata.profile,'reviewer');
});

test('task 없는 업무 owner·명시 hierarchy 감독 자동 적용과 실제 회신 주소',()=>{
  const f=fixture(),works=new WorkStore(f.home);
  works.create({key:'test/work',title:'업무',goal:'목표',scope:'범위',acceptance:'조건',owner:'recipient',repoPath:f.home});
  let r=f.compose();assert.equal(r.metadata.profile,'conductor');assert.equal(r.metadata.source,'work-owner');
  assert.doesNotMatch(r.instructions,/연결 업무:/);
  r=f.compose({role:'sender',profile:'worker',mailContext:{workKey:'test/work'}});assert.match(r.instructions,/회신 대상: recipient/);
  const hierarchy=path.join(f.home,'hierarchy.json');fs.writeFileSync(hierarchy,JSON.stringify({a:'b',b:'top',top:'@user'}));
  appendLedger({kind:'hierarchy-loaded',path:hierarchy},f.home);
  assert.equal(f.compose({role:'b'}).metadata.profile,'conductor');assert.equal(f.compose({role:'top'}).metadata.profile,'super');
  assert.match(f.compose({role:'b'}).instructions,/회신 대상: top/);
  assert.equal(f.compose({role:'a'}).metadata.reason,'unknown-role');
});

test('guardedSend: 준비 후 생존/PID·bytes/digest/saveBody 일치·오류 송신0·watch도 적용',()=>{
  const f=fixture(),sent=[],recorded=[],order=[];
  const floor={name:'fake',alive:()=>{order.push('alive');return true;},pid:()=>{order.push('pid');return '1';},send:(s,m)=>{order.push('send');sent.push(m);return {keyDelivery:'sent',inputAcceptance:'unconfirmed'};}};
  const send=extra=>guardedSend({floor,role:'recipient',session:'kadan-recipient',message:'완료 보고',roleProfile:'conductor',recordedPid:'1',env:{KADAN_HOME:f.home},source:'watch',
    readEntries:()=>{order.push('read');return [];},record:e=>recorded.push(e),saveBody:(d,b)=>saveMailBody(d,b,f.home),...extra});
  const receipt=send();assert.deepEqual(order,['read','alive','pid','send']);assert.equal(receipt.bytes,Buffer.byteLength(sent[0]));
  assert.equal(receipt.originalCardPath,null);
  assert.equal(receipt.digest,digest(sent[0]));assert.equal(readMailBody(receipt.digest,f.home),sent[0]);assert.equal(receipt.by,'watch');
  assert.equal(receipt.roleProfile,'conductor');assert.equal(receipt.taskId,undefined);
  assert.throws(()=>send({recordedPid:'2'}),e=>e.delivery==='not-sent'&&e.code==='KADAN_PID_MISMATCH');
  assert.throws(()=>send({floor:{...floor,alive:()=>false}}),e=>e.delivery==='not-sent');
  f.configure({version:1,templates:{conductor:path.join(f.home,'missing.md')}});
  const before=order.length;assert.throws(()=>send(),e=>e.delivery==='not-sent');assert.deepEqual(order.slice(before),['read']);
  assert.equal(sent.length,1);assert.equal(recorded.length,1);
});

test('전송 전 원문 상대경로는 기록된 start.cwd로 고정하며 첨부의 절대경로보다 앞선다',()=>{
  const f=fixture();
  const receipt=guardedSend({floor:{name:'fake',alive:()=>true,pid:()=> '1',send:()=>({})},role:'recipient',session:'kadan-recipient',
    message:'tasks/card.md 읽기',roleProfile:'worker',recordedPid:'1',env:{KADAN_HOME:f.home},
    readEntries:()=>[{kind:'start',role:'recipient',cwd:'/repo/worker'}],record:()=>{},saveBody:()=>{}});
  assert.equal(receipt.originalCardPath,'/repo/worker/tasks/card.md');
});

test('비서 read는 읽기 전용 저장소 안에서도 원문/digest 보존 + 최신 지침만 별도 반환',()=>{
  const f=fixture();createDatabase(f.home);writeStorageMarker(f.home,'sqlite');
  const mailbox=new SecretaryMailbox(f.home),receipt=mailbox.send({by:'sender',message:'원문 편지'});
  const before=readLedger(f.home),result=storageSnapshot(f.home,()=>mailbox.read(receipt.mailId));
  assert.equal(result.body,'원문 편지');assert.equal(result.digest,hash(result.body));
  assert.equal(result.receiverInstructionsProfile,'secretary');assert.equal(result.receiverInstructionsDigest,hash(result.receiverInstructions));
  assert.deepEqual(readLedger(f.home),before);assert.ok(Array.isArray(mailbox.list()));assert.equal(mailbox.list()[0].read,false);
  const custom=path.join(f.home,'secretary.md');fs.writeFileSync(custom,'# 비서 최신 사용자 지침');f.configure({version:1,templates:{secretary:custom}});
  const updated=mailbox.read(receipt.mailId);assert.notEqual(updated.receiverInstructionsDigest,result.receiverInstructionsDigest);assert.equal(updated.digest,result.digest);
  assert.deepEqual(readLedger(f.home),before);
});

test('관계 없는 카드 본문 유실·hierarchy 실패·원장 오류의 통지도 전달하며 모름 표시',()=>{
  const f=fixture(),c=card(f);
  fs.renameSync(c.path,c.path+'.preserved');
  const explicit=f.compose({profile:'worker'});assert.equal(explicit.metadata.profile,'worker');
  const missing=f.compose({profile:'worker',mailContext:{executionKey:c.key}});
  assert.match(missing.instructions,/확인 불가\(모름\).*연결 실행/);assert.doesNotMatch(missing.instructions,/현재 발령 ID:/);
  const hierarchy=path.join(f.home,'missing-hierarchy.json');appendLedger({kind:'hierarchy-loaded',path:hierarchy},f.home);
  assert.match(f.compose({profile:'conductor'}).instructions,/현재 hierarchy/);
  const sent=[];
  f.configure({version:1,roles:{recipient:'conductor'}});
  const receipt=guardedSend({floor:{name:'fake',alive:()=>true,pid:()=> '1',send:(s,m)=>sent.push(m)},
    role:'recipient',session:'kadan-recipient',message:'원장 읽기 실패 알림',recordedPid:'1',env:{KADAN_HOME:f.home},source:'watch',
    readEntries:()=>{throw new Error('손상');},record:()=>{},saveBody:()=>{}});
  assert.equal(sent.length,1);assert.equal(receipt.roleProfile,'conductor');assert.match(sent[0],/원장 손상: 현재 담당·완료 상태 모름/);
  const mailbox=new SecretaryMailbox(f.home),stored=mailbox.send({by:'sender',message:'카드 유실 보고'});
  assert.equal(mailbox.read(stored.mailId).body,'카드 유실 보고');
});
