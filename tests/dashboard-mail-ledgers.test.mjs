import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {appendLedger,readLedger,readTaskLedger,readMailLedger} from '../src/ledger.mjs';
import {createDatabase,writeStorageMarker,readStream} from '../src/storage.mjs';
import {mailboxLetters} from '../src/mailbox.mjs';
import {renderActivity} from '../src/decision-wall.mjs';
import {renderInbox,filterMail} from '../src/dashboard-inbox.mjs';
import {renderDashboardHome,mailboxUnread} from '../src/dashboard-home.mjs';
import {createWallServer} from '../src/wall.mjs';
const url=query=>new URL('http://localhost/'+query);
const send=(patch={})=>({kind:'send',mailId:'q1',by:'worker',role:'boss',expectReply:true,preview:'검토 질문',t:'2026-09-16T00:00:00Z',...patch});
const section=(html,id)=>html.match(new RegExp(`<section[^>]*id="${id}"[^>]*>[\\s\\S]*?</section>`))?.[0];
const decode=s=>s.replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
const originals=html=>[...html.matchAll(/<pre>([\s\S]*?)<\/pre>/g)].map(m=>JSON.parse(decode(m[1])));

test('모든 역할의 질문은 읽음·중간 답장 뒤에도 대기하며 역할별 받은/보낸/답할 목록을 구분한다',()=>{
 const entries=[send(),{kind:'mail-read',mailId:'q1',role:'boss',by:'boss'},send({mailId:'r1',expectReply:false,by:'boss',role:'worker',replyTo:'q1',preview:'중간 답장'}),send({mailId:'q2',by:'other',role:'reviewer',preview:'다른 질문'})];
 const letters=mailboxLetters(entries);
 assert.equal(letters[0].read,true);assert.equal(letters[0].replyStatus,'waiting');
 for(const query of ['?mailRole=boss&mailView=to-reply','?mailRole=worker&mailView=waiting'])assert.deepEqual(filterMail(letters,url(query)).map(m=>m.mailId),['q1']);
 assert.deepEqual(filterMail(letters,url('?mailRole=worker&mailView=received')).map(m=>m.mailId),['r1']);
 assert.deepEqual(filterMail(letters,url('?mailRole=worker&mailView=sent')).map(m=>m.mailId),['q1']);
 const html=renderActivity({entries,ledgerLines:entries.length},url('?mailRole=boss&mailView=to-reply'));
 assert.match(section(html,'mailbox'),/검토 질문/);assert.doesNotMatch(section(html,'mailbox'),/다른 질문|비서 확인|비서 미확인/);
 assert.equal(mailboxUnread(entries,entries.length),2);
 const finished=mailboxLetters([...entries,send({mailId:'r2',expectReply:false,by:'boss',role:'worker',replyTo:'q1',replyFinal:true})]);
 assert.equal(filterMail(finished,url('?mailRole=boss&mailView=to-reply')).length,0);
 assert.deepEqual(filterMail(finished,url('?mailReply=answered')).map(m=>m.mailId),['q1']);
 const cancelled=mailboxLetters([...entries,{kind:'mail-cancel',mailId:'q2',role:'reviewer',by:'other'}]);
 assert.deepEqual(filterMail(cancelled,url('?mailReply=cancelled')).map(m=>m.mailId),['q2']);
});

test('카드 인박스는 필터 후 페이지를 나누고 HTML을 이스케이프하며 완료 통지를 발령과 구분한다',()=>{
 const letters=mailboxLetters([send({preview:'<script>질문</script>'}),send({mailId:'old',by:'x',role:'y',preview:'다른 역할',expectReply:false}),send({mailId:'done',by:'boss',role:'worker',completion:true,executionKey:'repo/c',replyFinal:true,expectReply:false})]);
 const html=renderInbox({key:'work:repo/w',letters},null,url('?mailRole=worker&mailView=sent&q=keep'));
 assert.match(html,/1통/);assert.match(html,/&lt;script&gt;질문/);assert.doesNotMatch(html,/<script>|다른 역할/);
 assert.match(html,/name="q" value="keep"/);assert.match(html,/name="card" value="work:repo\/w"/);
 const completion=renderInbox({key:'work:repo/w',letters},null,url('?mailRole=worker&mailView=received'));
 assert.match(completion,/실행 결과 통지/);assert.match(completion,/완료 대상: repo\/c/);
});

test('과거 우편 읽음 모름과 신규 미확인, 원장 오류를 구분한다',()=>{
 const entries=[send({mailId:undefined,expectReply:false}),send({mailId:'new',expectReply:false})];
 const html=renderActivity({entries,ledgerLines:2},url('?mailUnread=1'));
 assert.equal(mailboxUnread(entries,2),1);assert.match(section(html,'mailbox'),/미확인 1건/);
 assert.match(renderInbox({key:'c',letters:mailboxLetters(entries)}),/읽음 모름/);
 const broken=renderDashboardHome({center:null,entries:[{broken:true}],ledgerLines:null});
 assert.match(broken,/전체 역할 미확인 우편<\/span><strong>모름/);
 for(const query of ['', '?ledgerDomain=mail'])assert.match(renderActivity({entries:[{broken:true}],ledgerLines:1},url(query)),/모름 — 원장을 읽을 수 없습니다/);
});

test('격리 SQLite HTTP: 우편 역할·질문 필터와 작업/우편/시스템 원장 조회는 기록을 바꾸지 않는다',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-dashboard-mail-'));
 createDatabase(home);writeStorageMarker(home,'sqlite');
 appendLedger({kind:'start',role:'worker',by:'boss'},home);
 appendLedger(send({taskId:'c',expectReply:true}),home);
 appendLedger(send({mailId:'q2',taskId:undefined,by:'other',role:'reviewer',preview:'숨길 질문'}),home);
 const before=readLedger(home),raw=Object.fromEntries(['tasks/events.jsonl','mail/events.jsonl','system/events.jsonl'].map(name=>[name,readStream(home,name)]));
 const snapshot=()=>({entries:readLedger(home),ledgerLines:readLedger(home).length,tree:[],center:null,collectedAt:'2026-09-16T00:00:00Z'});
 const server=createWallServer(snapshot,{home});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 for(const legacy of ['', '&legacy=1']){
  const response=await fetch(base+'/?mailRole=boss&mailView=to-reply'+legacy);
  assert.equal(response.status,200);assert.match(section(await response.text(),'mailbox'),/검토 질문/);
 }
 const mail=section(await (await fetch(base+'/?mailRole=boss&mailView=to-reply')).text(),'mailbox');
 assert.doesNotMatch(mail,/숨길 질문/);
 for(const [domain,expected] of [['tasks',['dispatch']],['mail',['send','send']],['system',['start']]]){
  const response=await fetch(base+'/?ledgerDomain='+domain);assert.equal(response.status,200);
  const html=section(await response.text(),'ledger');assert.deepEqual(originals(html).map(e=>e.kind),expected);
  assert.match(html,/과거 이력은 수정 없이/);
 }
 assert.equal(readTaskLedger(home)[0].mailId,readMailLedger(home)[0].mailId);
 const all=section(await (await fetch(base)).text(),'ledger');assert.deepEqual(originals(all).map(e=>e.kind),['send','send','start']);
 assert.deepEqual(readLedger(home),before);
 for(const [name,rows] of Object.entries(raw))assert.deepEqual(readStream(home,name),rows);
});
