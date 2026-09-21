import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createDatabase,writeStorageMarker} from '../src/storage.mjs';
import {readLedger} from '../src/ledger.mjs';
import {CardStore} from '../src/card-store.mjs';
import {guardedSend} from '../src/cli.mjs';
import {inspectStartCmdPolicy,inspectCardSendIdentity} from '../src/ai-identity.mjs';

// 2026-09-21 사고의 경계: `start --profile <p>`를 --cmd 없이 실행하면 AI가 아닌 빈 셸
// pane이 생기고, 이후 `send --task/--execution`이 역할 지침과 카드를 그 셸 프롬프트에
// 붙여넣는다. 카드 연결 전송은 현재 세대를 시작한 명령이 등록 실행기+모델 지정으로
// 확인될 때만 허용한다. 일반 우편·질문·답장은 이 경계를 거치지 않는다.
const cli=new URL('../src/cli.mjs',import.meta.url).pathname;
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
const hasTmux=spawnSync('tmux',['-V']).status===0;
const AI_CMD='codex --model test-model';
const rally={rallyId:'rally',rallyTitle:'묶음',rallyRound:'1',rallyStep:'implementation'};

test('inspectStartCmdPolicy: --profile 세션의 새 pane 생성은 --cmd가 필요하다',()=>{
 assert.equal(inspectStartCmdPolicy({roleProfile:'reviewer',cmd:undefined,reusing:false}).ok,false);
 assert.equal(inspectStartCmdPolicy({roleProfile:'worker',cmd:'   ',reusing:false}).ok,false);
 assert.equal(inspectStartCmdPolicy({roleProfile:'reviewer',cmd:'codex --model x',reusing:false}).ok,true);
 assert.equal(inspectStartCmdPolicy({roleProfile:'reviewer',cmd:undefined,reusing:true}).ok,true,'살아있는 세대 재사용은 명령 없이 허용');
 assert.equal(inspectStartCmdPolicy({roleProfile:undefined,cmd:undefined,reusing:false}).ok,true,'프로필 없는 시작은 기존처럼 허용');
});

test('inspectCardSendIdentity: 현재 세대 pane의 AI 시작 기록만 신원으로 인정한다',()=>{
 const s='kadan-r',st=(panePid,cmd)=>({kind:'start',role:'r',session:s,panePid,...(cmd?{cmd}:{})}),stop={kind:'stop',role:'r',session:s};
 const id=entries=>inspectCardSendIdentity({entries,session:s,currentPid:'1'});
 assert.equal(id([st('1',AI_CMD)]).ok,true);
 // 시작 기록 없음·--cmd 없는 빈 셸 시작
 assert.equal(id([]).reason,'no-ai-launch');
 assert.equal(id([st('1')]).reason,'no-ai-launch');
 // 비AI 명령 — 셸·cat·node receiver 모두 실행기가 아니다
 for(const cmd of ['cat','node receiver.mjs','/bin/zsh -l']) assert.equal(id([st('1',cmd)]).reason,'not-ai',cmd);
 // 실행기는 맞지만 모델 지정이 없다
 assert.equal(id([st('1','codex')]).reason,'no-model');
 assert.equal(id([st('1','codex -p lite')]).reason,'no-model');
 // --model과 -m 두 형태, 절대경로 실행기, 앞의 VAR=값 낱말
 assert.equal(id([st('1','codex resume abc -m gpt-x')]).ok,true);
 assert.equal(id([st('1',"'/opt/bin/claude' --model fable")]).ok,true);
 assert.equal(id([st('1','KADAN_X=1 omo --model p/m --thinking max')]).ok,true);
 // 이전 세대의 AI 기록만 남은 새 pane — stop 뒤 bare 재시작·같은 세션 다른 pid
 assert.equal(id([st('1',AI_CMD),stop,st('1')]).reason,'no-ai-launch');
 assert.equal(inspectCardSendIdentity({entries:[st('1',AI_CMD),st('2')],session:s,currentPid:'2'}).ok,false);
 // 같은 pane(같은 pid)의 재사용 start 기록은 기존 세대를 지우지 않는다
 assert.equal(id([st('1',AI_CMD),st('1')]).ok,true);
});

test('guardedSend: 카드 연결 전송은 AI 신원 미확인 pane에 전달·send 원장 없이 실패한다',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-ai-guard-'));
 // 전체 주소는 중앙 카드가 있어야 검사 단계까지 도달한다 — 발령 카드를 등록한다.
 const store=new CardStore(home);
 const card=store.create({repo:'r',id:'card-1',repoPath:home,body:'# 지시'});
 store.update(card.key,{status:'assigned',role:'r',board:'r',scope:'시험 범위',...rally},{revision:1,note:'배정'});
 let sends=0;const records=[];
 const floor={name:'fake',alive:()=>true,pid:()=>'111',send:()=>{sends++;return {};}};
 const startEntry=cmd=>({kind:'start',role:'r',session:'kadan-r',panePid:'111',...(cmd?{cmd}:{})});
 let entries=[startEntry()];
 const call=(extra={})=>guardedSend({floor,session:'kadan-r',role:'r',message:'카드 지시',recordedPid:'111',
  env:{KADAN_HOME:home},readEntries:()=>entries,record:e=>records.push(e),saveBody:()=>{},...extra});
 // --task 발령: 빈 셸 시작 기록만 있는 pane
 assert.throws(()=>call({taskId:'card-1'}),e=>e.delivery==='not-sent');
 assert.equal(sends,0);assert.equal(records.filter(e=>e.kind==='send').length,0);
 // 실행 연결 발령도 같은 경계(중앙 카드 발령 시 taskId로 정규화된다)
 assert.throws(()=>call({taskId:'card-1',mailContext:{executionKey:card.key}}),e=>e.delivery==='not-sent');
 assert.equal(sends,0);assert.equal(records.filter(e=>e.kind==='send').length,0);
 // AI 시작 기록이 확인되면 카드 전송이 통과한다
 entries=[startEntry(AI_CMD)];
 call({taskId:'card-1'});assert.equal(sends,1);
 assert.equal(records.filter(e=>e.kind==='send').length,1);
 // 일반 우편은 빈 셸 pane에도 그대로 전달된다 — 카드 연결이 없으면 이 경계를 거치지 않는다
 entries=[startEntry()];
 call({message:'일반 우편'});assert.equal(sends,2);
 call({message:'질문',mailContext:{executionKey:card.key,expectReply:true}});assert.equal(sends,3);
});

test('실제 CLI+격리 tmux: profile+no-cmd 시작 차단과 카드 전송 AI 신원 경계',{skip:!hasTmux},()=>{
 for(const backend of ['jsonl','sqlite']){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-ai-guard-cli-'));
  if(backend==='sqlite'){createDatabase(home);writeStorageMarker(home,'sqlite');}
  const socket=path.basename(home),env={...process.env,KADAN_HOME:home,KADAN_SOCKET:socket,KADAN_WINDOW:'none',KADAN_FLOOR:'tmux',KADAN_ROLE:''};
  const call=(...args)=>spawnSync(process.execPath,[cli,...args],{env,cwd:home,encoding:'utf8',timeout:15000});
  const run=(...args)=>{const r=call(...args);assert.equal(r.status,0,`${backend} ${args}: ${r.stderr}`);return r;};
  const tmux=(...args)=>spawnSync('tmux',['-L',socket,...args],{env,encoding:'utf8'});
  const starts=()=>readLedger(home).filter(e=>e.kind==='start');
  const sends=()=>readLedger(home).filter(e=>e.kind==='send'&&e.transport!=='mailbox');
  const paneText=s=>tmux('capture-pane','-p','-S','-200','-t',s).stdout||'';
  // 등록 실행기 이름의 수신기 — pane에 붙여넣은 본문을 <역할>.received에 쓴다
  const receiver=path.join(home,'receiver.mjs');
  fs.writeFileSync(receiver,"import fs from 'node:fs';import path from 'node:path';process.stdin.on('data',b=>fs.appendFileSync(path.join(process.env.KADAN_HOME,process.env.KADAN_ROLE+'.received'),b));\n");
  const harness=path.join(home,'codex');
  fs.writeFileSync(harness,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(receiver)} "$@"\n`);fs.chmodSync(harness,0o755);
  const store=new CardStore(home);
  const assign=(id,role)=>{const c=store.create({repo:'r',id,repoPath:home,body:'# 지시'});store.update(c.key,{status:'assigned',role,board:'r',scope:'시험 범위',...rally},{revision:1,note:'배정'});return c;};
  const started=[];
  try{
   // (1) --profile만 있는 start는 세션·창·start 원장 없이 실패한다
   const denied=call('start','guard-p','--profile','reviewer');
   assert.notEqual(denied.status,0,`${backend}: --profile 단독 start가 성공했다`);
   assert.match(denied.stderr,/--cmd/);
   assert.notEqual(tmux('has-session','-t','kadan-guard-p').status,0,`${backend}: 세션이 만들어졌다`);
   assert.equal(starts().length,0,`${backend}: start 원장이 남았다`);
   // 프로필+AI 명령은 정상 시작되고 harness·model이 기록된다
   run('start','guard-p','--hidden','--profile','reviewer','--cmd',`${harness} --model test-model`);
   started.push('kadan-guard-p');
   assert.equal(starts().at(-1).harness,'codex');assert.equal(starts().at(-1).model,'test-model');
   const cardA=assign('card-a','guard-p');
   // (2) 프로필 없는 빈 셸 시작은 허용되지만 카드 전송은 거부된다 — 전달·send 원장 없음
   run('start','bare-shell','--hidden');started.push('kadan-bare-shell');
   const cardB=assign('card-b','bare-shell');
   const bare=call('send','bare-shell','--task','card-b','카드 지시 본문');
   assert.notEqual(bare.status,0);assert.match(bare.stderr,/AI로 시작한 기록|AI 실행기/);
   assert.equal(sends().length,0);
   pause(300);assert.doesNotMatch(paneText('kadan-bare-shell'),/카드 지시 본문/,`${backend}: 빈 셸 pane에 카드가 붙여넣어졌다`);
   // (3) 비AI 명령으로 시작한 pane도 거부된다
   run('start','cat-pane','--hidden','--cmd','cat');started.push('kadan-cat-pane');
   assign('card-c','cat-pane');
   assert.notEqual(call('send','cat-pane','--task','card-c','카드 지시').status,0);
   // (4) 실행기인데 모델이 없으면 거부된다
   run('start','no-model','--hidden','--cmd',harness);started.push('kadan-no-model');
   assign('card-d','no-model');
   const nm=call('send','no-model','--task','card-d','카드 지시');
   assert.notEqual(nm.status,0);assert.match(nm.stderr,/모델/);
   assert.equal(sends().length,0,`${backend}: 거부된 전송의 send 원장이 남았다`);
   // (5) AI로 시작한 세션이 죽고 --cmd 없이 다시 시작된 pane — 이전 세대 신원 소급 금지
   run('start','stale-pane','--hidden','--cmd',`${harness} --model test-model`);
   assert.equal(tmux('kill-session','-t','kadan-stale-pane').status,0);
   run('start','stale-pane','--hidden');started.push('kadan-stale-pane');
   assign('card-e','stale-pane');
   const stale=call('send','stale-pane','--task','card-e','카드 지시');
   assert.notEqual(stale.status,0);assert.match(stale.stderr,/AI로 시작한 기록|AI 실행기/);
   assert.equal(sends().length,0);
   // (6) --execution만 쓴 발령 추론도 같은 경계를 거친다 — 발령 카드의 담당 역할 기준
   const inferred=call('send','bare-shell','--execution',cardB.key,'실행 연결 발령');
   assert.notEqual(inferred.status,0);assert.match(inferred.stderr,/AI로 시작한 기록|AI 실행기/);
   assert.equal(sends().length,0,`${backend}: 추론 발령이 원장에 기록됐다`);
   // (7) 명시 AI 명령 pane은 카드를 수신한다 — 전달·send 원장·실제 본문
   const ok=call('send','guard-p','--task','card-a','카드 지시를 수행하라');
   assert.equal(ok.status,0,ok.stderr);
   assert.equal(sends().length,1);
   const received=()=>fs.existsSync(path.join(home,'guard-p.received'))?fs.readFileSync(path.join(home,'guard-p.received'),'utf8'):'';
   const end=Date.now()+3000;while(Date.now()<end&&!received().includes('카드 지시를 수행하라'))pause(50);
   assert.ok(received().includes('카드 지시를 수행하라'),`${backend}: AI pane이 카드 본문을 받지 못했다`);
   // (8) 일반 우편·질문은 비AI pane에도 그대로 전달된다 — 이 경계는 카드 연결에만 적용된다
   run('send','bare-shell','일반 우편 도착');
   run('send','bare-shell','--execution',cardB.key,'--expect-reply','진행 상황을 알려달라');
   assert.equal(sends().length,3);
   pause(300);assert.match(paneText('kadan-bare-shell'),/일반 우편|우편 ID/,`${backend}: 일반 우편이 빈 셸 pane에 전달되지 않았다`);
  }finally{
   for(const s of [...started,'kadan-stale-pane'])tmux('kill-session','-t',s);
  }
 }
});
