import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {SecretaryMailbox,secretaryLetters} from '../src/secretary-mailbox.mjs';import {readLedger} from '../src/ledger.mjs';import {buildTree} from '../src/cli.mjs';import {collectRoles} from '../src/watch-runner.mjs';import {renderActivity} from '../src/decision-wall.mjs';
const home=()=>fs.mkdtempSync(path.join(os.tmpdir(),'kadan-secretary-'));
test('비서 공식 보고는 세션 없이 저장되고 별도 확인 전까지 미확인이다',()=>{
 const h=home(),m=new SecretaryMailbox(h),r=m.send({by:'p-슈퍼감독',message:'중지 준비 완료',category:'report'});
 assert.equal(r.status,'stored');assert.equal(r.wake,'not-connected');assert.equal(m.list().length,1);assert.equal(m.read(r.mailId).body,'중지 준비 완료');assert.equal(m.list().length,1);
 assert.throws(()=>m.acknowledge(r.mailId,'p-작업자'),/비서/);m.acknowledge(r.mailId,'비서');m.acknowledge(r.mailId,'비서');assert.equal(m.list().length,0);assert.equal(readLedger(h).filter(e=>e.kind==='mail-read').length,1);
 const raw=fs.readFileSync(path.join(h,'mail/events.jsonl'),'utf8');assert.ok(!raw.includes('중지 준비 완료'));assert.equal(buildTree(readLedger(h)).length,0);
 assert.deepEqual([...collectRoles({list:()=>[]},readLedger(h)).observations.values()],[]);
});
test('새 CLI 수신 경로는 실제 tmux를 만들거나 발령 기록을 만들지 않는다',()=>{
 const h=home(),r=spawnSync(process.execPath,['src/cli.mjs','send','비서','--mail-kind','decision','결정 내용'],{cwd:process.cwd(),env:{...process.env,KADAN_HOME:h,KADAN_ROLE:'p-슈퍼감독',KADAN_WINDOW:'none'},encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).status,'stored');assert.equal(readLedger(h).some(e=>e.kind==='start'||e.taskId),false);
 const html=renderActivity({entries:readLedger(h),ledgerLines:1,home:h},new URL('http://localhost'));assert.match(html,/미확인/);assert.match(html,/미확인 1건/);
});
test('잘못된 종류·참조·손상·없는 본문은 실패하고 읽음을 만들지 않는다',()=>{
 const h=home(),m=new SecretaryMailbox(h);assert.throws(()=>m.send({by:'x',message:'x',category:'chat'}),/공식/);assert.throws(()=>m.send({by:'x',message:'x',replyTo:'missing'}),/원본/);
 const r=m.send({by:'x',message:'x'}),l=m.list()[0];fs.renameSync(path.join(h,'mail',l.digest+'.txt'),path.join(h,'mail',l.digest+'.saved'));
 assert.throws(()=>m.acknowledge(r.mailId,'비서'),/본문/);assert.equal(m.list().length,1);assert.throws(()=>secretaryLetters([{broken:'bad'}]),/손상/);
});
test('대시보드 비서 보고 수는 결정 수와 분리되고 읽음/손상을 반영한다',async()=>{
 const {renderDashboardHome}=await import('../src/dashboard-home.mjs');const h=home(),m=new SecretaryMailbox(h);
 const a=m.send({by:'p-슈퍼감독',message:'one'}),b=m.send({by:'p-슈퍼감독',message:'two'});m.acknowledge(a.mailId,'비서');
 const center={cards:[],boards:[]},entries=readLedger(h);
 const html=renderDashboardHome({center,entries,briefs:new Map()});assert.match(html,/전체 역할 미확인 우편<\/span><strong>1건/);assert.match(html,/내가 결정할 일<\/span><strong>0건/);
 const mails=renderActivity({center,entries,ledgerLines:entries.length,home:h},new URL('http://localhost/?mailRole=비서&mailUnread=1'));
 assert.ok(mails.includes('two'));assert.ok(!mails.includes('<pre>one</pre>'));
 const broken=renderDashboardHome({center,entries:[{broken:'bad'}],ledgerLines:null,briefs:new Map()});assert.match(broken,/전체 역할 미확인 우편<\/span><strong>모름/);
 m.acknowledge(b.mailId,'비서');assert.match(renderDashboardHome({center,entries:readLedger(h),briefs:new Map()}),/전체 역할 미확인 우편<\/span><strong>0건/);
});
