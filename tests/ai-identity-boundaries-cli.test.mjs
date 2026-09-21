import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {CardStore} from '../src/card-store.mjs';
import {readLedger,readTaskLedger} from '../src/ledger.mjs';
import {createDatabase,writeStorageMarker} from '../src/storage.mjs';
import {inspectCardSendIdentity} from '../src/ai-identity.mjs';
import {guardedSend} from '../src/cli.mjs';
const evidence=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-send-boundaries-'));
const cli=new URL('../src/cli.mjs',import.meta.url).pathname;
const realTmux=spawnSync('which',['tmux'],{encoding:'utf8'}).stdout.trim();

const pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
const out=[];const transcript=[];
test('JSONL·SQLite 실제 CLI: 세 거부 경계의 paste/Enter/send/dispatch 0과 정상 우편', {skip:spawnSync('tmux',['-V']).status!==0},()=>{
for(const backend of ['jsonl','sqlite']){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-send-boundaries-'+backend+'-'));
 if(backend==='sqlite'){createDatabase(home);writeStorageMarker(home,'sqlite');}
 const bin=path.join(home,'bin');fs.mkdirSync(bin);
 const trace=path.join(home,'tmux.jsonl');
 fs.writeFileSync(path.join(bin,'tmux'),`#!${process.execPath}\nimport fs from 'node:fs';import {spawnSync} from 'node:child_process';const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(a)+'\\n');const r=spawnSync(${JSON.stringify(realTmux)},a,{stdio:'inherit'});
const raceFile=${JSON.stringify(path.join(home,'race.json'))};
if(a.includes('load-buffer')&&fs.existsSync(raceFile)) {
 const race=JSON.parse(fs.readFileSync(raceFile,'utf8'));
 if(race.active) {
  fs.writeFileSync(raceFile,JSON.stringify({...race,active:false}));
  spawnSync(${JSON.stringify(realTmux)},['-L',process.env.KADAN_SOCKET,'send-keys','-t','kadan-'+race.role,...race.keys]);
  const end=Date.now()+3000;let observed=false;
  while(Date.now()<end) {
   const query=race.dead?['display-message','-p','-t','kadan-'+race.role,'#{pane_dead}']:['capture-pane','-p','-t','kadan-'+race.role];
   const state=spawnSync(${JSON.stringify(realTmux)},['-L',process.env.KADAN_SOCKET,...query],{encoding:'utf8'}).stdout;
   if(race.dead?state.trim()==='1':state.includes('RACE_PENDING')){observed=true;break;}
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
 const start=(role,cmd)=>{must(call(['start',role,'--hidden',...(cmd?['--profile','reviewer','--cmd',cmd]:[])]));started.push(role);const c=store.create({repo:'r',id:role,repoPath:home,body:'# synthetic review card'});store.update(c.key,{status:'assigned',role,board:'r',scope:'independent test',rallyId:'r',rallyTitle:'r',rallyRound:'1',rallyStep:'review'},{revision:1,note:'review fixture'});};
 const counts=()=>{const rows=readLedger(home);const a=fs.existsSync(trace)?fs.readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];return {paste:a.filter(x=>x.includes('paste-buffer')).length,enter:a.filter(x=>x.includes('send-keys')&&x.includes('Enter')).length,send:rows.filter(x=>x.kind==='send').length,dispatch:readTaskLedger(home).filter(x=>x.kind==='dispatch').length,start:rows.filter(x=>x.kind==='start').length};};
 const probe=(name,role,args,expected='reject')=>{const before=counts();const r=call(['send',role,...args,'REVIEW_BODY_'+name]);const after=counts();const delta=Object.fromEntries(Object.keys(before).map(k=>[k,after[k]-before[k]]));const state=tm('display-message','-p','-t','kadan-'+role,'#{pane_pid}|#{pane_current_command}|#{pane_dead}|#{pane_in_mode}').stdout.trim();const row={backend,name,expected,exit:r.status,delta,state,error:r.stderr.trim()};out.push(row);return row;};
 try{
  const before=counts();const denied=call(['start','no-cmd','--profile','reviewer']);out.push({backend,name:'profile-no-cmd',exit:denied.status,before,after:counts(),hasSession:tm('has-session','-t','kadan-no-cmd').status,error:denied.stderr});
  start('bare');probe('bare-task','bare',['--task','bare']);probe('bare-execution','bare',['--execution','r/bare']);
  must(call(['start','bare','--hidden']));probe('bare-reuse','bare',['--task','bare']);
  start('cat','cat');probe('cat','cat',['--task','cat']);
  start('no-model',bin+'/codex');probe('no-model','no-model',['--task','no-model']);
  start('stale',bin+'/codex --model model-a');tm('kill-session','-t','kadan-stale');must(call(['start','stale','--hidden']));probe('stale','stale',['--task','stale']);
  for(const name of ['codex','devin','omo','claude']){start(name,bin+'/'+name+' --model model-a');probe(name+'-shape',name,['--task',name],'accept fixture');}
  start('resume',bin+'/codex resume synthetic -m model-a');must(call(['start','resume','--hidden','--profile','reviewer']));probe('resume-reuse','resume',['--execution','r/resume'],'accept fixture');
  tm('copy-mode','-t','kadan-resume');probe('copy-mode','resume',['--task','resume']);tm('send-keys','-t','kadan-resume','-X','cancel');
  tm('send-keys','-t','kadan-resume','-l','USER_PENDING_');probe('partial-input','resume',['--task','resume']);
  assert.match(tm('capture-pane','-p','-t','kadan-resume').stdout,/USER_PENDING_/);
  assert.doesNotMatch(tm('capture-pane','-p','-t','kadan-resume').stdout,/REVIEW_BODY_partial-input/);
  start('dead',bin+'/codex --model model-a');tm('set-option','-t','kadan-dead','remain-on-exit','on');tm('send-keys','-t','kadan-dead','C-c');pause(150);probe('dead-pane','dead',['--task','dead']);
  start('spoof',bin+'/codex --version; exec cat # --model model-a');probe('version-then-cat','spoof',['--execution','r/spoof']);
  const replaced=path.join(home,'replaced');fs.mkdirSync(replaced);
  fs.writeFileSync(path.join(replaced,'codex'),'#!/bin/sh\nexec cat\n',{mode:0o755});
  start('replaced',replaced+'/codex --model model-a');probe('replaced-process','replaced',['--task','replaced']);
  // 실제 입력 버퍼를 두 줄로 편집하고 커서를 위쪽 빈 줄로 옮긴다.
  const editorDir=path.join(home,'editor');fs.mkdirSync(editorDir);
  fs.writeFileSync(path.join(editorDir,'codex'),`#!${process.execPath}
import fs from 'node:fs';
const file=process.env.KADAN_HOME+'/editor-state.json';
let lines=[''],row=0;
const paint=()=>{process.stdout.write('\\x1b[2J\\x1b[H› '+lines.join('\\r\\n')+'\\x1b['+(row+1)+';'+(row===0?3:1)+'H');fs.writeFileSync(file,JSON.stringify({lines,row}));};
process.stdin.setRawMode(true);process.stdin.resume();
process.stdin.on('data',b=>{const data=b.toString();if(data==='\\x1b[A')row=Math.max(0,row-1);else for(const c of data){if(c==='\\n'){lines.splice(row+1,0,'');row++;}else if(c==='\\r'){fs.appendFileSync(file+'.submitted',JSON.stringify(lines)+'\\n');lines=[''];row=0;}else if(c==='\\u0003'){lines=[''];row=0;}else lines[row]+=c;}paint();});paint();
`,{mode:0o755});
  const waitState=expected=>{const end=Date.now()+3000;while(Date.now()<end){try{if(fs.readFileSync(path.join(home,'editor-state.json'),'utf8')===JSON.stringify(expected))return;}catch{}pause(20);}assert.fail('editor state timeout '+JSON.stringify(expected));};
  start('editor',editorDir+'/codex --model model-a');waitState({lines:[''],row:0});
  tm('send-keys','-t','kadan-editor','C-j');waitState({lines:['',''],row:1});
  tm('send-keys','-t','kadan-editor','-l','SECOND_PENDING');waitState({lines:['','SECOND_PENDING'],row:1});
  tm('send-keys','-t','kadan-editor','-l','\x1b[A');waitState({lines:['','SECOND_PENDING'],row:0});
  probe('pending-below-cursor','editor',['--raw','--task','editor']);
  assert.equal(fs.existsSync(path.join(home,'editor-state.json.submitted')),false);
  waitState({lines:['','SECOND_PENDING'],row:0});
  tm('send-keys','-t','kadan-editor','C-c');waitState({lines:[''],row:0});
  // 실제 편집 버퍼의 경계처럼 보이는 본문도 raw/일반 전송 모두 보존한다.
  for(const raw of [true,false])for(const [name,lines,up] of [
   ...['›','>','❯'].map((prompt,i)=>['fake-prompt-'+i,['USER_UNSUBMITTED',prompt+' '],0]),
   ['fake-border',['','──────','USER_BELOW_BORDER'],2],
   ...['│','┃','│ │','┃ ┃','│┃',' │ ',' ┃ '].flatMap((text,i)=>[
    ['vertical-first-'+i,[text],0],
    ['vertical-below-'+i,['',text],1],
   ]),
  ]) {
   for(let i=0;i<lines.length;i++) {
    if(i){tm('send-keys','-t','kadan-editor','C-j');waitState({lines:[...lines.slice(0,i),''],row:i});}
    if(lines[i]){tm('send-keys','-t','kadan-editor','-l',lines[i]);waitState({lines:lines.slice(0,i+1),row:i});}
   }
   for(let i=0;i<up;i++){tm('send-keys','-t','kadan-editor','-l','\x1b[A');waitState({lines,row:lines.length-2-i});}
   const result=probe(name+(raw?'-raw':'-plain'),'editor',raw?['--raw','--task','editor']:['--execution','r/editor']);
   result.inputBefore={lines,row:lines.length-1-up};
   result.inputAfter=JSON.parse(fs.readFileSync(path.join(home,'editor-state.json'),'utf8'));
   result.submitted=fs.existsSync(path.join(home,'editor-state.json.submitted'));
   assert.notEqual(result.exit,0,JSON.stringify(result));
   assert.match(result.error,/입력 경계 미확인|미제출 입력/);
   for(const key of ['paste','enter','send','dispatch'])assert.equal(result.delta[key],0,JSON.stringify(result));
   waitState({lines,row:lines.length-1-up});
   assert.equal(fs.existsSync(path.join(home,'editor-state.json.submitted')),false);
   tm('send-keys','-t','kadan-editor','C-c');waitState({lines:[''],row:0});
  }
  probe('cleared-editor','editor',['--raw','--task','editor'],'accept fixture');
  // 버퍼 준비 뒤 입력/종료가 발생해도 두 번째 검사에서 paste 전에 거부한다.
  waitState({lines:[''],row:0});
  fs.writeFileSync(path.join(home,'race.json'),JSON.stringify({active:true,role:'editor',keys:['-l','RACE_PENDING']}));
  probe('input-during-load','editor',['--raw','--task','editor']);
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
