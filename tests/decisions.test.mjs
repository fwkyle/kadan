import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CardStore} from '../src/card-store.mjs';
import {DecisionStore,decisionCommand} from '../src/decisions.mjs';
import {createWallServer} from '../src/wall.mjs';
import {renderCenterWall} from '../src/center-wall.mjs';
const input={question:'서비스를 제품과 분리할까요?',options:['분리','유지'],recommendation:'분리',reason:'기존 결정으로 해결할 수 없는 표시 정책'};
function fixture(){const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-decision-'));const cards=new CardStore(home);cards.create({repo:'repo',id:'card-a',repoPath:home,body:'# 테스트'});const sent=[];const notify=(...x)=>sent.push(x);const store=new DecisionStore(home,{notify});return{home,cards,store,sent,notify};}
test('09-07 슈퍼의 명시 결정만 생성, 질문 단위로 답변, 같은 답변은 중복 통지 없음',()=>{
 const f=fixture();assert.throws(()=>f.store.request('repo/card-a',input,'작업자'),/슈퍼감독/);
 assert.throws(()=>f.store.request('repo/card-a',{...input,recommendation:'아무거나'},'슈퍼감독'),/추천/);
 const a=f.store.request('repo/card-a',input,'p-슈퍼감독');assert.equal(f.store.request('repo/card-a',input,'p-슈퍼감독').id,a.id);
 const b=f.store.request('repo/card-a',{...input,question:'별칭을 연결할까요?'},'p-슈퍼감독');
 assert.throws(()=>f.store.answer(a.id,{revision:1,text:'분리'},'p-감독'),/사람/);
 const answer=f.store.answer(a.id,{revision:1,text:'분리하세요',choice:'분리'},'사람');assert.equal(answer.delivery.status,'sent');assert.equal(f.sent.length,1);
 f.store.answer(a.id,{revision:1,text:'분리하세요',choice:'분리'},'사람');assert.equal(f.sent.length,1);assert.equal(f.store.get(b.id).status,'open');
 const chosen=f.store.answer(b.id,{revision:1,choice:'유지'},'사람');assert.equal(chosen.answer.text,'유지');
 assert.throws(()=>f.store.answer(a.id,{revision:1,text:'다른 결정'},'사람'),/버전/);
 assert.equal(f.cards.get('repo/card-a').status,'draft');
});
test('09-07 통지 실패에도 답변 보존, 손상 이력은 성공처럼 읽지 않는다',()=>{
 const f=fixture();const a=f.store.request('repo/card-a',input,'슈퍼감독');const failing=new DecisionStore(f.home,{notify:()=>{throw Error('gone')}});
 assert.equal(failing.answer(a.id,{revision:1,text:'분리'},'사람').delivery.status,'failed');
 assert.equal(failing.get(a.id).status,'answered');
 fs.appendFileSync(path.join(f.home,'decisions/events.jsonl'),'bad\n');assert.throws(()=>failing.list());assert.throws(()=>failing.request('repo/card-a',input,'슈퍼감독'));
});
test('09-07 내부 question은 사용자 결정함에 안 뜨고 웹 답변은 CLI 공통 경로를 사용한다',async()=>{
 const f=fixture();f.cards.update('repo/card-a',{}, {revision:1,by:'작업자',noteKind:'question',note:'내부 오류 보고'});
 const a=decisionCommand(['request','repo/card-a'],{question:input.question,option:input.options,recommend:input.recommendation,reason:input.reason},{home:f.home,by:'슈퍼감독',notify:f.notify});
 const server=createWallServer(()=>({center:null,entries:[],tree:[],ledgerLines:0,collectedAt:new Date()}),{home:f.home,notify:f.notify});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{
  const html=await(await fetch(base)).text();assert.match(html,/내 결정 필요 1건/);assert.ok(!html.includes('답변을 기다리는 카드'));assert.ok(!html.includes('href="?legacy=1"'));
  for(const id of ['mailbox','runs','ledger'])assert.ok(html.includes(`id="${id}"`));
  const token=html.match(/name="token" value="([a-f0-9]+)"/)[1];
  const post=(revision,tokenValue=token)=>fetch(base+'/decisions/answer',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:base},body:new URLSearchParams({token:tokenValue,id:a.id,revision,text:'분리합니다',choice:'분리'}),redirect:'manual'});
  assert.equal((await post('1','bad')).status,403);assert.equal((await post('99')).status,409);assert.equal((await post('1')).status,303);
  assert.equal(decisionCommand(['show',a.id],{},{home:f.home,by:'사람'}).answer.text,'분리합니다');assert.equal(f.sent.length,1);
  assert.match(await(await fetch(base)).text(),/내 결정 필요 0건/);
  const legacy=await(await fetch(base+'/?legacy=1')).text();assert.match(legacy,/참고용 옛 화면/);
 }finally{await new Promise(r=>server.close(r))}
});
test('09-07 새 우편은 실제 보낸이/받는이와 본문을 표시, 원장 손상은 모름',()=>{
 const f=fixture();fs.mkdirSync(path.join(f.home,'mail'));fs.writeFileSync(path.join(f.home,'mail/abc.txt'),'본문 <script>');
 const html=renderCenterWall({center:null,home:f.home,entries:[{kind:'send',by:'감독',role:'작업자',digest:'abc',preview:'요약'}],ledgerLines:1});
 assert.match(html,/본문 &lt;script&gt;/);assert.ok(html.indexOf('<td>감독</td>')<html.indexOf('<td>작업자</td>'));
 const bad=renderCenterWall({center:null,entries:[],ledgerLines:null});assert.match(bad,/모름 — 원장을 읽을 수 없습니다/);
});
test('09-07 진행 막대는 역할 수 대신 중앙 카드 고유키와 실제 상태를 센다',async()=>{
 const {boardProgressCounts,renderBoardProgress}=await import('../src/board-progress.mjs');
 const b={name:'p',runs:[],cards:[{key:'r/a',displayState:'done',runs:[]},{key:'r/a',displayState:'done',runs:[]},{key:'r/b',displayState:'unconfirmed',runs:[]},{key:'r/c',displayState:'running',runs:[]},{key:'r/d',displayState:'hold',runs:[]}]};
 const {counts,total}=boardProgressCounts(b);assert.equal(total,4);assert.equal(counts.done,1);assert.equal(counts.check,1);assert.equal(counts.running,1);assert.equal(counts.hold,1);
 const html=renderBoardProgress({boards:[b]});assert.match(html,/완료 1\/4장/);assert.match(html,/확인 필요 1장/);assert.match(html,/role="img"/);
 assert.match(renderBoardProgress(null),/모름/);
});
test('판 미지정 옛 실행 기록은 현황의 오래된 미정리에 저장 상태와 함께 놓이고 새 초안은 섞이지 않는다',()=>{
 const cards=[
  {key:'r/in',id:'in',repo:'r',title:'판 안',status:'assigned',board:'p',displayState:'unconfirmed',runs:[]},
  {key:'r/old',id:'old',repo:'r',title:'옛 <카드>',status:'draft',board:null,displayState:'orphaned',runs:[]},
  {key:'r/new',id:'new',repo:'r',title:'새 초안',status:'draft',board:null,displayState:'draft',runs:[]},
 ];
 const html=renderCenterWall({center:{cards,boards:[{name:'p',cards:[cards[0]],runs:[]}],summary:{attention:2},roles:[],unregistered:[]},entries:[]});
 const panel=html.match(/<details id="status-stale"[\s\S]*?<\/details>/)[0];
 assert.match(panel,/오래된 미정리 2장/);
 assert.match(panel,/옛 &lt;카드&gt;/);assert.match(panel,/판 미지정 · 세션 확인 필요 · 마지막 신호 없음 · 저장 상태 draft/);
 assert.ok(!panel.includes('새 초안'));assert.match(panel,/card=r%2Fold/);
 assert.ok(!html.includes('unassigned-attention'));
});

test('결정 화면: 첫 질문만 제목으로, 나머지는 줄바꿈을 살리고 주소는 누를 수 있는 링크로 보인다', async () => {
  const {renderDecisions} = await import('../src/decision-wall.mjs');
  const html = renderDecisions([{id:'d1', status:'open', card:'r/c', requestedBy:'슈퍼', recommendation:'승인', options:['승인','보류'],
    question:'PR #1을 합류할까요?\n- 노션: https://app.notion.com/p/abc\n- PR: https://github.com/o/r/pull/1.',
    reason:'<b>근거</b> https://x.y/z'}], null, 't');
  assert.match(html, /<h3>PR #1을 합류할까요\?<\/h3>/);
  assert.match(html, /white-space:pre-line">- 노션: <a href="https:\/\/app\.notion\.com\/p\/abc" target="_blank" rel="noopener noreferrer">/);
  assert.match(html, /<a href="https:\/\/github\.com\/o\/r\/pull\/1" [^>]+>https:\/\/github\.com\/o\/r\/pull\/1<\/a>\./);
  assert.match(html, /&lt;b&gt;근거&lt;\/b&gt; <a href="https:\/\/x\.y\/z"/);
  assert.doesNotMatch(html, /<b>근거/);
});
