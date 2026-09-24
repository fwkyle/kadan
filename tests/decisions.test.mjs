import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CardStore} from '../src/card-store.mjs';
import {DecisionStore,decisionCommand} from '../src/decisions.mjs';
import {createWallServer} from '../src/wall.mjs';
import {renderCenterWall} from '../src/center-wall.mjs';
const input={question:'서비스를 제품과 분리할까요?',options:['분리','유지'],recommendation:'분리',reason:'기존 결정으로 해결할 수 없는 표시 정책\n- 결과 파일: /repo/card-a/result.md'};
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
  assert.equal((await post('1','bad')).status,403);assert.equal((await post('99')).status,409);
  // 답한 결정은 접힌 '이전 결정' 안으로 옮겨진다. 그 조각 주소로 돌아가면 브라우저가 접힘을 펼치므로 결정 영역 맨 위로 보낸다.
  const answered=await post('1');assert.equal(answered.status,303);
  const location=answered.headers.get('location');assert.equal(location,'/?decisionAnswered='+encodeURIComponent(a.id)+'#decisions');
  assert.doesNotMatch(location,/#decision-/);
  const after=await(await fetch(base+location.split('#')[0])).text();
  assert.match(after,/class="decision-toast"><span>답변을 전달했습니다 — /);
  assert.match(after,/\.decision-toast\{position:fixed;right:24px;top:72px;/);
  // 성공은 15초 뒤 사라지고(마우스를 올리면 멈춤), 실패는 남는다. 토스트에서 바로 내역 드로어를 연다.
  assert.match(after,/animation:decision-toast-out \.3s ease 15s forwards/);
  assert.match(after,/\.decision-toast:hover\{animation-play-state:paused\}/);
  // 색은 다크 모드용 변수로 바뀌어 나간다(원래 색 #8a1f1f).
  assert.match(after,/\.decision-toast-failed\{background:var\(--kc-8a1f1f\);animation:none\}/);
  assert.match(after,/class="decision-toast-link" data-decision-history-open>내역 보기</);
  assert.match(after,/<dialog id="decision-history" class="decision-drawer"/);
  assert.match(after,/document\.getElementById\('decision-history'\)/);
  // 토스트는 한 번만: 화면 스크립트가 주소에서 decisionAnswered를 지운다.
  assert.match(after,/searchParams\.delete\('decisionAnswered'\)/);
  assert.doesNotMatch(await(await fetch(base)).text(),/class="decision-toast/);
  // 답변은 페이지를 다시 불러오지 않고 보내며, 결정 영역·드로어·상단 숫자만 바꾸고 스크롤을 되돌린다.
  assert.match(after,/form\.matches\('form\[action="\/decisions\/answer"\]'\)\)return;\n  event\.preventDefault\(\);\n  if\(form\.dataset\.sending\)return;/);
  assert.match(after,/document\.getElementById\('decisions'\)\.replaceWith/);
  assert.match(after,/if\(main\)main\.scrollTop=top;/);
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
  // "- 이름: 내용" 줄은 이름표 표로 보인다(2026-09-24 선택판 모양).
  assert.match(html, /<dl class="dc-fields"><dt>노션<\/dt><dd><a href="https:\/\/app\.notion\.com\/p\/abc" target="_blank" rel="noopener noreferrer">[^<]+<\/a><\/dd><dt>PR<\/dt>/);
  assert.match(html, /<a href="https:\/\/github\.com\/o\/r\/pull\/1" [^>]+>https:\/\/github\.com\/o\/r\/pull\/1<\/a>\./);
  assert.match(html, /&lt;b&gt;근거&lt;\/b&gt; <a href="https:\/\/x\.y\/z"/);
  assert.doesNotMatch(html, /<b>근거/);
});
test('09-24 새 결정 요청은 확인 주소·절대경로·확인 경로 없음 이유 중 하나가 있어야 저장한다',()=>{
 const f=fixture(),ask=(question,reason)=>f.store.request('repo/card-a',{...input,question,reason},'p-슈퍼감독');
 assert.equal(ask('PR을 합칠까요?\n- PR: https://github.com/o/r/pull/1','검토 끝').status,'open');
 assert.equal(ask('결과를 받을까요?','- 결과 파일: /home/me/.kadan/cards/r/c/result.md').status,'open');
 assert.equal(ask('이름 규칙을 바꿀까요?','- 확인 경로 없음: 열어 볼 대상이 없는 순수 방침 질문').status,'open');
 const before=f.store.list().length;
 for(const [q,r,message] of [
  ['Preview를 볼까요?\n- 확인 경로 없음:','이유 없음',/이유가 비어/],
  ['Preview-1에 올라가 있음. 합칠까요?','확인 부탁',/확인 경로 필요.*PR.*Preview.*노션.*결과 파일.*확인 경로 없음: <이유>/],
  ['상대 경로만 있나요?','docs/result.md 와 a/b',/확인 경로 필요/],
 ])assert.throws(()=>ask(q,r),message);
 assert.equal(f.store.list().length,before);assert.equal(f.sent.length,0);
});
test('09-24 확인 경로 검사 전에 저장된 요청도 조회·답변·취소할 수 있다',()=>{
 const f=fixture(),old={revision:1,card:'repo/card-a',to:'@user',requestedBy:'p-슈퍼감독',options:['분리','유지'],recommendation:'분리',reason:'옛 요청',status:'open',at:new Date().toISOString()};
 const a=f.store.write({...old,id:'old-a',question:'옛 질문 A?'}),b=f.store.write({...old,id:'old-b',question:'옛 질문 B?'});
 assert.equal(f.store.get(a.id).status,'open');
 assert.equal(f.store.answer(a.id,{revision:1,choice:'분리'},'사람').status,'answered');
 assert.equal(f.store.cancel(b.id,{revision:1,reason:'주소 확인 뒤 다시 요청'},'p-슈퍼감독').status,'cancelled');
});
test('09-24 방금 답한 결정은 저장된 전달 결과대로 맨 위에 알리고, 열린 결정이나 모르는 ID에는 알리지 않는다', async () => {
  const {renderDecisions} = await import('../src/decision-wall.mjs');
  const base = {card:'r/c', requestedBy:'슈퍼', recommendation:'승인', options:['승인'], question:'합칠까요?', reason:'r', answer:{by:'사람', text:'네', at:'2026-09-24T00:00:00Z'}};
  const toast = (d, id='d1') => renderDecisions([{id:'d1', ...base, ...d}], null, 't', id).match(/class="(decision-toast[^"]*)"><span>([^<]*)/);
  const notice = (d, id) => toast(d, id)?.[2];
  assert.equal(notice({status:'answered', delivery:{status:'sent', role:'슈퍼'}}), '답변을 전달했습니다 — 슈퍼에게 알렸습니다: 합칠까요?');
  assert.equal(notice({status:'answered', delivery:{status:'failed', error:'세션 없음'}}), '답변은 저장했지만 알림 전달에 실패했습니다(세션 없음): 합칠까요?');
  assert.equal(notice({status:'answered', delivery:{status:'pending'}}), '답변을 저장했습니다. 알림 전달은 확인 중입니다: 합칠까요?');
  // 알림 실패만 따로 표시한다(실패는 저절로 사라지지 않는 스타일).
  assert.equal(toast({status:'answered', delivery:{status:'sent', role:'슈퍼'}})[1], 'decision-toast');
  assert.equal(toast({status:'answered', delivery:{status:'failed', error:'x'}})[1], 'decision-toast decision-toast-failed');
  assert.equal(notice({status:'open', revision:1}), undefined);
  assert.equal(notice({status:'answered', delivery:{status:'sent', role:'슈퍼'}}, 'other'), undefined);
});

test('09-24 지난 결정은 접힘 목록 대신 오른쪽 드로어 — 최근 순으로 상태·내 답변·알림 결과를 먼저 보인다', async () => {
  const {renderDecisions} = await import('../src/decision-wall.mjs');
  const base = {card:'r/c', requestedBy:'슈퍼', recommendation:'승인', options:['승인','보류'], reason:'근거 https://x.y/z'};
  const html = renderDecisions([
    {id:'open1', status:'open', revision:1, question:'열린 결정?', at:'2026-09-24T09:00:00Z', ...base},
    {id:'old', status:'answered', question:'예전 결정?\n- 본문', at:'2026-09-23T01:00:00Z', answer:{by:'사람', text:'승인', choice:'승인', at:'2026-09-23T02:00:00Z'}, delivery:{status:'sent', role:'슈퍼'}, ...base},
    {id:'new', status:'answered', question:'최근 결정?', at:'2026-09-24T01:00:00Z', answer:{by:'사람', text:'조건부로 진행', choice:'보류', at:'2026-09-24T02:00:00Z'}, delivery:{status:'failed', error:'세션 없음'}, ...base},
    {id:'gone', status:'cancelled', question:'취소된 결정?', at:'2026-09-23T05:00:00Z', cancelReason:'중복 요청', cancelledBy:'슈퍼', ...base},
  ], null, 't');
  assert.doesNotMatch(html, /<details><summary>이전 결정/);
  assert.match(html, /<button type="button" class="decision-history-open" data-decision-history-open>이전 결정 3건 보기<\/button><\/section><dialog id="decision-history"/);
  const drawer = html.slice(html.indexOf('<dialog id="decision-history"'));
  assert.match(drawer, /<h2 id="decision-history-title">이전 결정 3건<\/h2><form method="dialog">/);
  // 최근 답변·요청 순: 최근(9/24 02시) → 취소(9/23 05시) → 예전(9/23 02시). 열린 결정은 드로어에 없다.
  const order = [...drawer.matchAll(/<article class="dh-item" id="decision-([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(order, ['new', 'gone', 'old']);
  assert.match(drawer, /dh-failed">알림 실패<\/span>.*<h3>최근 결정\?<\/h3><p><strong>내 답변<\/strong> 선택 보류 · 조건부로 진행<\/p><p>알림 실패: 세션 없음<\/p>/s);
  assert.match(drawer, /dh-answered">답변함<\/span>.*<h3>예전 결정\?<\/h3><p><strong>내 답변<\/strong> 선택 승인<\/p><p>알림 전달함 → 슈퍼<\/p>/s);
  assert.match(drawer, /dh-cancelled">취소됨<\/span>.*<p>취소 이유: 중복 요청 \(슈퍼\)<\/p>/s);
  // 취소에는 시각이 저장되지 않으므로 배지 옆에 요청 시각을 취소 시각처럼 보이지 않는다.
  assert.match(drawer, /<div class="dh-meta"><span class="dh-badge dh-cancelled">취소됨<\/span><\/div>/);
  assert.match(drawer, /<details><summary>원문 보기<\/summary><p style="white-space:pre-line">- 본문<\/p>/);
  const empty = renderDecisions([{id:'open1', status:'open', revision:1, question:'열린 결정?', ...base}], null, 't');
  assert.match(empty, /이전 결정 0건 보기/);assert.match(empty, /<p class="dh-empty">지난 결정이 없습니다\.<\/p>/);
});
test('09-24 위 메뉴: 우편함을 올리고 답을 기다리는 질문 수를 배지로, 실행 모델은 운영 메뉴로(작업별 실행 중복 제거)',()=>{
 const entries=[
  {kind:'send',by:'작업자',role:'감독',mailId:'q1',digest:'dq1',expectReply:true,t:'2026-09-24T00:00:00Z'},
  {kind:'send',by:'감독',role:'작업자',mailId:'m2',digest:'dm2',t:'2026-09-24T00:01:00Z'},
 ];
 const html=renderCenterWall({center:null,entries,ledgerLines:entries.length});
 const top=html.slice(html.indexOf('<nav aria-label="주 메뉴">'),html.indexOf('</nav>',html.indexOf('<nav aria-label="주 메뉴">')));
 assert.deepEqual([...top.matchAll(/data-route="([^"]+)"/g)].map(m=>m[1]),['status','dashboard','decisions','mailbox','ledger','operations-flow']);
 assert.match(top,/<a href="#mailbox" data-route="mailbox">우편함 <span class="dw-decision-count" aria-label="답을 기다리는 질문 1건" title="답을 기다리는 질문">1<\/span><\/a>/);
 const more=html.slice(html.indexOf('<nav aria-label="운영 메뉴">'),html.indexOf('</nav>',html.indexOf('<nav aria-label="운영 메뉴">')));
 assert.deepEqual([...more.matchAll(/data-route="([^"]+)"/g)].map(m=>m[1]),['sessions','runner-settings','work-create','create']);
 assert.match(html,/classList\.toggle\('dw-more-current',\['sessions','runner-settings','work-create','create'\]\.includes\(view\)\)/);
 // 원장을 못 읽으면 0이 아니라 모름.
 const unknown=renderCenterWall({center:null,entries:[],ledgerLines:null});
 assert.match(unknown,/data-route="mailbox">우편함 <span class="dw-decision-count" aria-label="답을 기다리는 질문 모름"[^>]*>모름</);
});
test('09-24 요약 없는 공식 우편은 본문 앞 120자를 한 줄 미리보기로 보인다',()=>{
 const f=fixture();fs.mkdirSync(path.join(f.home,'mail'),{recursive:true});
 const long='완료 통지: card-a ok\n\n결과 파일 /x/result.md 에 판정과 근거를 적었다. '+'가'.repeat(200);
 fs.writeFileSync(path.join(f.home,'mail/d1.txt'),long);
 const html=renderCenterWall({center:null,home:f.home,entries:[{kind:'send',by:'작업자',role:'감독',digest:'d1',mailId:'m1',transport:'mailbox',mailKind:'report'}],ledgerLines:1});
 const row=html.slice(html.indexOf('<td>작업자</td>'));
 assert.match(row,/<p>완료 통지: card-a ok 결과 파일 \/x\/result\.md 에 판정과 근거를 적었다\. 가+…<\/p>/);
 assert.doesNotMatch(row.slice(0,row.indexOf('</tr>')),/본문을 펼쳐 확인/);
 const shown=row.match(/<p>([^<]*)…<\/p>/)[1];assert.equal(shown.length,120);
});

test('09-24 결정 카드: 선택지는 카드 모양 단추로 모두 보이고 추천 배지, 기본은 선택지 없음, 누를 때만 보내는 버튼과 진행 막대', async () => {
  const {renderDecisions} = await import('../src/decision-wall.mjs');
  const now = new Date().toISOString();
  const html = renderDecisions([
    {id:'d1', status:'open', revision:3, card:'r/c', requestedBy:'p-슈퍼감독', recommendation:'보류', options:['승인','보류'], question:'합칠까요?', reason:'이유', at:now},
    {id:'d0', status:'answered', card:'r/c', requestedBy:'p-슈퍼감독', recommendation:'승인', options:['승인'], question:'예전?', reason:'r', answer:{by:'사람', text:'승인', choice:'승인', at:now}, delivery:{status:'sent', role:'p-슈퍼감독'}},
  ], null, 'tok');
  const card = html.slice(html.indexOf('<article class="dc-card" id="decision-d1">'), html.indexOf('</article>', html.indexOf('id="decision-d1"')));
  assert.match(card, /<div class="dc-top"><span class="dc-chip">요청 p-슈퍼감독<\/span><a class="dc-key" href="\?card=r%2Fc#detail">r\/c<\/a>/);
  assert.match(card, /<dl class="dc-fields"><dt>추천 이유<\/dt><dd class="dc-pre">이유<\/dd><\/dl>/);
  const opts = [...card.matchAll(/<label class="dc-opt[^"]*"><input type="radio" name="choice" value="([^"]*)"( checked)?>/g)].map(m => [m[1], Boolean(m[2])]);
  assert.deepEqual(opts, [['승인', false], ['보류', false], ['', true]]);
  assert.match(card, /value="보류"><span class="dc-dot" aria-hidden="true"><\/span><span class="dc-opt-text">보류<span class="dc-rec">추천<\/span>/);
  assert.doesNotMatch(card, /value="승인">[^]*?승인<span class="dc-rec">/);
  assert.match(card, /<input type="hidden" name="revision" value="3">/);
  assert.match(card, /<textarea name="text"[^>]*placeholder="메모 \(선택\)/);
  assert.match(card, /<button>답변 전달<\/button><small>누를 때만 보냅니다/);
  assert.doesNotMatch(card, /<select/);
  assert.match(html, /<div class="dc-meter"><span>대기 1건 · 오늘 답함 1건<\/span><div class="dc-bar" aria-hidden="true"><i style="width:50%"><\/i>/);
});
