import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {CardStore} from '../src/card-store.mjs';
import {readLedger,readTaskLedger} from '../src/ledger.mjs';
import {createDatabase,writeStorageMarker} from '../src/storage.mjs';
import {inspectCardSendIdentity} from '../src/ai-identity.mjs';
import {guardedSend} from '../src/cli.mjs';
const evidence=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-send-boundaries-'));
const cli=new URL('../src/cli.mjs',import.meta.url).pathname;
const realTmux=spawnSync('which',['tmux'],{encoding:'utf8'}).stdout.trim();

const pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
// 고정 시간 대신 화면 상태를 기다린다. 전체 시험 부하에서 node 기동이 3초를 넘긴 적이 있어 상한을 넉넉히 둔다.
const waitFor=(read,ok,what)=>{const end=Date.now()+10000;while(Date.now()<end){if(ok(read()))return;pause(20);}throw Error(what+' timeout');};
const out=[];const transcript=[];
test('JSONL·SQLite 실제 CLI: 세 거부 경계의 paste/Enter/send/dispatch 0과 정상 우편', {skip:spawnSync('tmux',['-V']).status!==0},()=>{
for(const backend of ['jsonl','sqlite']){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-send-boundaries-'+backend+'-'));
 if(backend==='sqlite'){createDatabase(home);writeStorageMarker(home,'sqlite');}
 const bin=path.join(home,'bin');fs.mkdirSync(bin);
 const trace=path.join(home,'tmux.jsonl');
 fs.writeFileSync(path.join(bin,'tmux'),`#!${process.execPath}\nimport fs from 'node:fs';import {spawn,spawnSync} from 'node:child_process';const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(a)+'\\n');const r=spawnSync(${JSON.stringify(realTmux)},a,{stdio:'inherit'});
const raceFile=${JSON.stringify(path.join(home,'race.json'))};
if(a.includes('load-buffer')&&fs.existsSync(raceFile)) {
 const race=JSON.parse(fs.readFileSync(raceFile,'utf8'));
 if(race.active) {
  fs.writeFileSync(raceFile,JSON.stringify({...race,active:false}));
  if(race.attach)spawn('sh',['-c',"sleep 6 | '"+${JSON.stringify(realTmux)}+"' -L '"+process.env.KADAN_SOCKET+"' -C attach -t =kadan-"+race.role],{detached:true,stdio:'ignore'}).unref();
  else spawnSync(${JSON.stringify(realTmux)},['-L',process.env.KADAN_SOCKET,'send-keys','-t','kadan-'+race.role,...race.keys]);
  const end=Date.now()+3000;let observed=false;
  while(Date.now()<end) {
   const query=race.attach?['list-clients','-t','=kadan-'+race.role,'-F','#{client_activity}']:race.dead?['display-message','-p','-t','kadan-'+race.role,'#{pane_dead}']:['capture-pane','-p','-t','kadan-'+race.role];
   const state=spawnSync(${JSON.stringify(realTmux)},['-L',process.env.KADAN_SOCKET,...query],{encoding:'utf8'}).stdout;
   if(race.attach?state.trim()!=='':race.dead?state.trim()==='1':state.includes('RACE_PENDING')){observed=true;break;}
   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
  }
  if(!observed)throw Error('race fixture readiness timeout');
 }
}
process.exit(r.status??1);\n`,{mode:0o755});
 const receiver=path.join(home,'receiver.mjs');
 fs.writeFileSync(receiver,"process.stdout.write('› ');import fs from 'node:fs';process.stdin.on('data',b=>fs.appendFileSync(process.env.KADAN_HOME+'/'+process.env.KADAN_ROLE+'.received',b));\n");
 for(const name of ['codex','devin','omo','claude'])fs.writeFileSync(path.join(bin,name),`#!${process.execPath}\nif(process.argv.includes("--version")){console.log("test receiver");process.exit(0); }\n`+fs.readFileSync(receiver,'utf8'),{mode:0o755});
 const env={...process.env,KADAN_HOME:home,KADAN_SOCKET:path.basename(home),KADAN_FLOOR:'tmux',KADAN_WINDOW:'none',KADAN_ROLE:'',PATH:bin+':'+process.env.PATH};
 const call=(args,extra={})=>{const r=spawnSync(process.execPath,[cli,...args],{env:{...env,...extra},cwd:home,encoding:'utf8',timeout:15000});transcript.push({backend,args,status:r.status,stdout:r.stdout,stderr:r.stderr});return r;};
 const tm=(...args)=>spawnSync(realTmux,['-L',env.KADAN_SOCKET,...args],{env,encoding:'utf8'});
 const must=r=>{if(r.status!==0)throw Error(r.stderr);return r;};
 const store=new CardStore(home);const started=[];
 // 프롬프트를 찍는 가짜 AI는 화면에 `›`가 뜬 뒤에 보낸다. 안 그러면 거부 경계가 아니라 '프롬프트 미확인'으로 갈린다.
 const start=(role,cmd,prompt=Boolean(cmd))=>{must(call(['start',role,'--hidden',...(cmd?['--profile','reviewer','--cmd',cmd,'--no-prompt']:[])]));started.push(role);if(prompt)waitFor(()=>tm('capture-pane','-p','-t','kadan-'+role).stdout,screen=>screen.includes('›'),'prompt '+role);const c=store.create({repo:'r',id:role,repoPath:home,body:'# synthetic review card'});store.update(c.key,{status:'assigned',role,board:'r',scope:'independent test',rallyId:'r',rallyTitle:'r',rallyRound:'1',rallyStep:'review'},{revision:1,note:'review fixture'});};
 const counts=()=>{const rows=readLedger(home);const a=fs.existsSync(trace)?fs.readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];return {paste:a.filter(x=>x.includes('paste-buffer')).length,enter:a.filter(x=>x.includes('send-keys')&&x.includes('Enter')).length,send:rows.filter(x=>x.kind==='send').length,dispatch:readTaskLedger(home).filter(x=>x.kind==='dispatch').length,start:rows.filter(x=>x.kind==='start').length};};
 const probe=(name,role,args,expected='reject')=>{const before=counts();const r=call(['send',role,...args,'REVIEW_BODY_'+name]);const after=counts();const delta=Object.fromEntries(Object.keys(before).map(k=>[k,after[k]-before[k]]));const state=tm('display-message','-p','-t','kadan-'+role,'#{pane_pid}|#{pane_current_command}|#{pane_dead}|#{pane_in_mode}').stdout.trim();const row={backend,name,expected,exit:r.status,delta,state,error:r.stderr.trim()};out.push(row);return row;};
 try{
  const before=counts();const denied=call(['start','no-cmd','--profile','reviewer']);out.push({backend,name:'profile-no-cmd',exit:denied.status,before,after:counts(),hasSession:tm('has-session','-t','kadan-no-cmd').status,error:denied.stderr});
  start('bare');probe('bare-task','bare',['--task','bare']);probe('bare-execution','bare',['--execution','r/bare']);
  must(call(['start','bare','--hidden']));probe('bare-reuse','bare',['--task','bare']);
  start('cat','cat',false);probe('cat','cat',['--task','cat']);
  start('no-model',bin+'/codex');probe('no-model','no-model',['--task','no-model']);
  start('stale',bin+'/codex --model model-a');tm('kill-session','-t','kadan-stale');must(call(['start','stale','--hidden']));probe('stale','stale',['--task','stale']);
  for(const name of ['codex','devin','omo','claude']){start(name,bin+'/'+name+' --model model-a');probe(name+'-shape',name,['--task',name],'accept fixture');}
  start('resume',bin+'/codex resume synthetic -m model-a');must(call(['start','resume','--hidden','--profile','reviewer']));probe('resume-reuse','resume',['--execution','r/resume'],'accept fixture');
  tm('copy-mode','-t','kadan-resume');probe('copy-mode','resume',['--task','resume']);tm('send-keys','-t','kadan-resume','-X','cancel');
  // 화면에 쓰다 만 글이 있어도 사람이 붙어 최근 입력하지 않았으면 막지 않는다(화면 모양 판정 제거, 2026-10-17).
  tm('send-keys','-t','kadan-resume','-l','USER_PENDING_');probe('partial-input-no-human','resume',['--execution','r/resume'],'accept fixture');
  // 사람이 붙은 창(제어 모드 client의 붙은 시각이 client_activity)은 보류한다. 본문은 붙지 않는다.
  const humanClient=spawn('sh',['-c',"sleep 8 | '"+realTmux+"' -L '"+env.KADAN_SOCKET+"' -C attach -t =kadan-resume"],{detached:true,stdio:'ignore'});humanClient.unref();
  waitFor(()=>tm('list-clients','-t','=kadan-resume','-F','#{client_activity}').stdout.trim(),v=>v!=='','사람 client');
  const humanProbe=probe('human-active','resume',['--task','resume']);
  assert.match(humanProbe.error,/사람이 이 창에서 최근 입력/);
  assert.doesNotMatch(tm('capture-pane','-p','-t','kadan-resume').stdout,/REVIEW_BODY_human-active/);
  start('dead',bin+'/codex --model model-a');tm('set-option','-t','kadan-dead','remain-on-exit','on');tm('send-keys','-t','kadan-dead','C-c');waitFor(()=>tm('display-message','-p','-t','kadan-dead','#{pane_dead}').stdout.trim(),dead=>dead==='1','dead pane');probe('dead-pane','dead',['--task','dead']);
  start('spoof',bin+'/codex --version; exec cat # --model model-a',false);probe('version-then-cat','spoof',['--execution','r/spoof']);
  const replaced=path.join(home,'replaced');fs.mkdirSync(replaced);
  fs.writeFileSync(path.join(replaced,'codex'),'#!/bin/sh\nexec cat\n',{mode:0o755});
  start('replaced',replaced+'/codex --model model-a',false);probe('replaced-process','replaced',['--task','replaced']);
  // 버퍼 준비 뒤 입력/종료가 발생해도 두 번째 검사에서 paste 전에 거부한다.
  start('race-human',bin+'/codex --model model-a');
  fs.writeFileSync(path.join(home,'race.json'),JSON.stringify({active:true,role:'race-human',attach:true}));
  probe('human-during-load','race-human',['--raw','--task','race-human']);
  start('race-dead',bin+'/codex --model model-a');tm('set-option','-t','kadan-race-dead','remain-on-exit','on');
  fs.writeFileSync(path.join(home,'race.json'),JSON.stringify({active:true,role:'race-dead',keys:['C-c'],dead:true}));
  probe('death-during-load','race-dead',['--task','race-dead']);
  // start의 모델 A와 같은 pane의 실제 프로세스 모델 B/미지정 경계.
  for(const [role,flags] of [['mismatch','--model model-b'],['unknown-model','']]) {
   const dir=path.join(home,role);fs.mkdirSync(dir);
   fs.writeFileSync(path.join(dir,'codex'),'#!/bin/sh\nexec '+bin+'/codex '+flags+'\n',{mode:0o755});
   start(role,dir+'/codex --model model-a');probe(role,role,['--task',role]);
  }
  probe('ordinary-mail','cat',[],'accept mail');
  probe('question','cat',['--execution','r/cat','--expect-reply'],'accept mail');
  const question=readLedger(home).filter(x=>x.kind==='send').at(-1);out.push({backend,name:'question-taskId',taskId:question.taskId??null,expectReply:question.expectReply});
  must(call(['send','external','--mailbox','--execution','r/cat','outbound question'],{KADAN_ROLE:'cat'}));
  const outbound=readLedger(home).filter(x=>x.kind==='send').at(-1);probe('reply','cat',['--reply-to',outbound.mailId,'--execution','r/cat'],'accept mail');
  probe('completion-other-owner','cat',['--execution','r/resume'],'accept mail');
  const beforeWatch=counts();const floor={name:'fixture',alive:()=>true,pid:()=>readLedger(home).filter(x=>x.kind==='start'&&x.role==='cat').at(-1).panePid,send:()=>({})};
  const watch=guardedSend({floor,session:'kadan-cat',role:'cat',message:'synthetic watch notice',source:'watch',env,recordedPid:floor.pid(),readEntries:()=>readLedger(home),record:e=>out.push({backend,name:'watch-record',taskId:e.taskId??null,by:e.by}),saveBody:()=>{}});out.push({backend,name:'watch-mail',taskId:watch.taskId??null,by:watch.by});
  fs.writeFileSync(path.join(evidence,backend+'-ledger.json'),JSON.stringify(readLedger(home),null,2));fs.writeFileSync(path.join(evidence,backend+'-tasks.json'),JSON.stringify(readTaskLedger(home),null,2));fs.copyFileSync(trace,path.join(evidence,backend+'-tmux.jsonl'));
  out.push({backend,home,socket:env.KADAN_SOCKET});
 }finally{for(const role of started)tm('kill-session','-t','kadan-'+role);}
}
for(const cmd of ['codex "explain --model fake"','codex --version; exec cat # --model fake','codex --model="" --help','devin --model x','omo --model x','claude --model x'])out.push({name:'parser',cmd,result:inspectCardSendIdentity({entries:[{kind:'start',session:'kadan-r',panePid:'1',cmd}],session:'kadan-r',currentPid:'1'})});
fs.writeFileSync(path.join(evidence,'independent-results.json'),JSON.stringify(out,null,2));fs.writeFileSync(path.join(evidence,'independent-transcript.json'),JSON.stringify(transcript,null,2));console.log('카드 경계 CLI 증거: '+evidence);
for(const row of out.filter(row=>row.delta)) {
 const allowed=row.expected.startsWith('accept');
 assert.equal(row.exit===0,allowed,JSON.stringify(row));
 for(const key of ['paste','enter','send','dispatch']) assert.equal(row.delta[key],allowed && (key!=='dispatch'||row.expected==='accept fixture') ? 1 : 0,JSON.stringify(row));
}
});
