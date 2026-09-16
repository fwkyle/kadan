import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {readMailLedger} from '../src/ledger.mjs';
import {CardStore} from '../src/card-store.mjs';
test('09-07 실제 decision CLI 답변은 격리된 슈퍼 세션에 한번 통지한다',{skip:spawnSync('tmux',['-V']).status!==0},()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-decision-cli-'));new CardStore(home).create({repo:'qa',id:'card-a',repoPath:home,body:'# 시험'});
 const cli=new URL('../src/cli.mjs',import.meta.url).pathname,env={...process.env,KADAN_HOME:home,KADAN_SOCKET:path.basename(home),KADAN_WINDOW:'none',KADAN_FLOOR:'tmux',KADAN_ROLE:'사람'};
 const run=(args,by='사람')=>{const r=spawnSync(process.execPath,[cli,...args],{env:{...env,KADAN_ROLE:by},encoding:'utf8'});assert.equal(r.status,0,r.stderr+r.stdout);return r.stdout};
 try{
 run(['start','qa-슈퍼감독','--cmd','cat']);
 const d=JSON.parse(run(['decision','request','qa/card-a','--question','분리할까요?','--option','분리','--option','유지','--recommend','분리','--reason','확인 필요'],'qa-슈퍼감독'));
 const a=JSON.parse(run(['decision','answer',d.id,'--revision','1','--text','분리하세요','--choice','분리']));assert.equal(a.delivery.status,'sent');
 assert.match(run(['read','qa-슈퍼감독','--lines','30']),/결정 답변/);
 run(['decision','answer',d.id,'--revision','1','--text','분리하세요','--choice','분리']);
 const sends=readMailLedger(home).filter(e=>e.kind==='send');assert.equal(sends.length,1);
 assert.equal(sends[0].role,'qa-슈퍼감독');assert.equal(sends[0].session,'kadan-qa-슈퍼감독');assert.equal(sends[0].floor,'tmux');
 assert.notEqual(sends[0].transport,'mailbox');assert.equal(sends[0].taskId,undefined);
 }finally{spawnSync(process.execPath,[cli,'stop','qa-슈퍼감독'],{env,encoding:'utf8'})}
});
