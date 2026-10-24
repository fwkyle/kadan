import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gunzipSync,gzipSync} from 'node:zlib';
import {setTimeout as delay} from 'node:timers/promises';
import {tmuxFloor,outputLogPath} from '../src/floor-tmux.mjs';

test('새 세션 출력은 압축 보존하고 기존 로그·화면 완료 마커는 유지한다',async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-log-')),session='kadan-compression';
 const previous={KADAN_HOME:process.env.KADAN_HOME,KADAN_SOCKET:process.env.KADAN_SOCKET};
 process.env.KADAN_HOME=home;process.env.KADAN_SOCKET=path.basename(home);
 fs.mkdirSync(path.join(home,'out'));const raw=path.join(home,'out',session+'.log');fs.writeFileSync(raw,'existing evidence');
 const legacy=outputLogPath(session,home),legacyBytes=gzipSync('existing compressed evidence');
 fs.writeFileSync(legacy,legacyBytes);const generations=new Set();
 const script=path.join(home,'writer.mjs');fs.writeFileSync(script,"setTimeout(()=>process.stdout.write('output evidence '.repeat(2000)+'\\nKADAN:DONE compressed-proof ok\\n'),600);setInterval(()=>{},1000);\n");
 try{
  for(let i=0;i<2;i++){
   const started=tmuxFloor.create({session,role:'compression',cwd:home,cmd:`${process.execPath} ${script}`});
   assert.equal(path.basename(started.outputLog),'manifest.json');
   assert.ok(!generations.has(started.outputLog));generations.add(started.outputLog);
   const manifest=JSON.parse(fs.readFileSync(started.outputLog,'utf8'));
   assert.equal(manifest.encoding,'gzip');assert.equal(manifest.partBytes,8*1024*1024);
   const end=Date.now()+4000;let screen='';
   while(Date.now()<end){screen=tmuxFloor.read(session);if(screen.includes('KADAN:DONE compressed-proof ok'))break;await delay(50);}
   assert.match(screen,/KADAN:DONE compressed-proof ok/);tmuxFloor.stop(session);
   let text;const until=Date.now()+2000;
   let parts=[];const directory=path.dirname(started.outputLog);
   while(Date.now()<until){
    try{
     parts=fs.readdirSync(directory).filter(n=>/^part-[a-z]{6}$/.test(n)).sort()
      .map(n=>fs.readFileSync(path.join(directory,n)));
     text=gunzipSync(Buffer.concat(parts)).toString();
     if(text.includes('KADAN:DONE compressed-proof ok'))break;
    }catch{}
    await delay(30);
   }
   assert.equal((text?.match(/KADAN:DONE compressed-proof ok/g)||[]).length,1);
   assert.ok(parts.reduce((sum,p)=>sum+p.length,0)<Buffer.byteLength(text)/4);
  }
  assert.equal(fs.readFileSync(raw,'utf8'),'existing evidence');
  assert.deepEqual(fs.readFileSync(legacy),legacyBytes);
 }finally{
  if(tmuxFloor.alive(session))tmuxFloor.stop(session);
  fs.rmSync(home,{recursive:true,force:true}); // 이 시험이 만든 홈만
  for(const [k,v] of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
 }
});
