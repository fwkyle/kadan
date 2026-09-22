import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {setTimeout as delay} from 'node:timers/promises';
import {tmuxFloor,outputLogPath} from '../src/floor-tmux.mjs';

test('새 세션 출력은 압축 보존하고 기존 로그·화면 완료 마커는 유지한다',async()=>{
 const home=fs.mkdtempSync('/tmp/kadan-log-'),session='kadan-compression';
 const previous={KADAN_HOME:process.env.KADAN_HOME,KADAN_SOCKET:process.env.KADAN_SOCKET};
 process.env.KADAN_HOME=home;process.env.KADAN_SOCKET=path.basename(home);
 fs.mkdirSync(path.join(home,'out'));const raw=path.join(home,'out',session+'.log');fs.writeFileSync(raw,'existing evidence');
 const script=path.join(home,'writer.mjs');fs.writeFileSync(script,"setTimeout(()=>process.stdout.write('output evidence '.repeat(2000)+'\\nKADAN:DONE compressed-proof ok\\n'),600);setInterval(()=>{},1000);\n");
 try{
  for(let i=0;i<2;i++){
   const started=tmuxFloor.create({session,role:'compression',cwd:home,cmd:`${process.execPath} ${script}`});
   assert.equal(started.outputLog,outputLogPath(session,home));assert.match(started.outputLog,/\.log\.gz$/);
   const end=Date.now()+4000;let screen='';
   while(Date.now()<end){screen=tmuxFloor.read(session);if(screen.includes('KADAN:DONE compressed-proof ok'))break;await delay(50);}
   assert.match(screen,/KADAN:DONE compressed-proof ok/);tmuxFloor.stop(session);
   let text;const until=Date.now()+2000;
   while(Date.now()<until){try{text=gunzipSync(fs.readFileSync(started.outputLog)).toString();if((text.match(/KADAN:DONE compressed-proof ok/g)||[]).length===i+1)break;}catch{}await delay(30);}
   assert.equal((text?.match(/KADAN:DONE compressed-proof ok/g)||[]).length,i+1);
   assert.ok(fs.statSync(started.outputLog).size<Buffer.byteLength(text)/4);
  }
  assert.equal(fs.readFileSync(raw,'utf8'),'existing evidence');
 }finally{
  if(tmuxFloor.alive(session))tmuxFloor.stop(session);
  for(const [k,v] of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
 }
});
