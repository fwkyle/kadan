import test from 'node:test';
import assert from 'node:assert/strict';
import {renderActivity} from '../src/decision-wall.mjs';
import {renderLedgerTable} from '../src/ledger-table.mjs';
import {renderLogEntry} from '../src/cli.mjs';

const decode=s=>s.replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
const ledger=(entries,query='',extra={})=>renderActivity({entries,ledgerLines:entries.length,...extra},new URL('http://localhost/'+query)).match(/<section class="panel lg-panel" id="ledger"[\s\S]*?<\/section>/)?.[0];
const originals=html=>[...html.matchAll(/<pre>([\s\S]*?)<\/pre>/g)].map(m=>JSON.parse(decode(m[1])));

test('감시 기록은 두 AI의 이름과 보고 완료·시간 초과를 구분하고 옛 기록의 종류를 추측하지 않는다',()=>{
 const entries=[{kind:'watch-ai-call',source:'stall',role:'worker',reason:'reported',outputBytes:0},
  {kind:'watch-ai-call',source:'supervisor-health',role:'boss',reason:'timeout'},
  {kind:'watch-ai-delivery',role:'old'}];
 const html=renderLedgerTable(entries);
 assert.match(html,/작업 감시AI/);assert.match(html,/감독 관찰AI/);assert.match(html,/호출 종료 · 보고 완료/);assert.match(html,/호출 종료 · 시간 초과/);
 assert.deepEqual(originals(html),entries);
 assert.match(renderLogEntry(entries[0]),/작업 감시AI reported/);
 assert.match(renderLogEntry(entries[1]),/감독 관찰AI timeout/);
 assert.doesNotMatch(renderLogEntry(entries[2]),/작업 감시AI|감독 관찰AI/);
});

test('원문 값과 배열 순서를 보존하고 최신 기록부터 50개씩 표시한다',()=>{
 const entries=Array.from({length:53},(_,i)=>Object.freeze({kind:'send',t:'2020-09-08T06:00:01Z',by:'sender',role:'recipient',taskId:'card-'+i,preview:'줄 '+i,extra:{keep:[i,null,false]}}));
 const before=JSON.stringify(entries),first=ledger(entries),last=ledger(entries,'?logPage=2');
 assert.equal((first.match(/data-ledger-row=/g)||[]).length,50);
 assert.deepEqual(originals(first),entries.slice(-50).reverse());assert.deepEqual(originals(last),entries.slice(0,3).reverse());assert.equal(JSON.stringify(entries),before);
 assert.match(first,/53건 · 최신순/);assert.match(first,/09\.08 15:00:01/);assert.match(first,/기록 안내/);
 assert.doesNotMatch(first,/<details open/);
});
test('발령자·기록자와 대상을 분리하고 없는 by를 대상이나 감독으로 채우지 않는다',()=>{
 const html=renderLedgerTable([{kind:'send',by:'발령자',role:'받는작업자',preview:'준비 보고'},{kind:'done',role:'완료작업자',result:'ok'},{kind:'plan',by:'계획작성자',board:'판'},{kind:'handover',by:'인계기록자',from:'옛담당',to:'새담당',phase:'transferred'}]);
 assert.match(html,/>메시지 전달<\/td><td title="발령자">발령자<\/td><td title="받는작업자">받는작업자/);
 assert.match(html,/>실행 완료<\/td><td title="모름">모름<\/td><td title="완료작업자">완료작업자/);
 assert.match(html,/>카드 계획<\/td><td title="계획작성자">계획작성자<\/td><td title="판">판/);
 assert.match(html,/>새담당<\/td>/);assert.match(html,/옛담당 → 새담당/);
});
test('위험한 HTML과 알 수 없는 종류·시각도 원문을 잃지 않고 표시한다',()=>{
 const entry={t:'bad',kind:'<img onerror=x>',by:'</td><script>x</script>',role:'" onclick=x',preview:'a & b\n<script>evil</script>',data:['<',false,0]};
 const html=renderLedgerTable([entry]);assert.deepEqual(originals(html),[entry]);assert.match(html,/시각 모름/);assert.doesNotMatch(html,/<script>|<img/);assert.match(html,/&lt;img/);
 assert.match(renderLedgerTable([{kind:'done',result:'failed'}]),/실행 실패/);
});
test('페이지 이동은 카드 선택·기존 조건을 보존하고 빈 기록과 조회 실패를 구분한다',()=>{
 const entries=Array.from({length:51},(_,i)=>({kind:'start',t:'2020-01-01',role:'worker-'+i}));
 const html=ledger(entries,'?card=repo%2Fcard-a&layout=table&logPage=1');
 const next=decode(html.match(/href="([^"]+logPage=2[^"]*)"/)[1]),url=new URL(next,'http://localhost');
 assert.equal(url.searchParams.get('card'),'repo/card-a');assert.equal(url.searchParams.get('layout'),'table');assert.equal(url.hash,'#ledger');
 assert.match(ledger([]),/아직 기록된 사건이 없습니다/);
 for(const data of [{entries:[],ledgerLines:null},{entries:[{broken:'error'}],ledgerLines:1}]){
  const failed=renderActivity(data,new URL('http://localhost'));
  assert.match(failed,/모름 — 원장을 읽을 수 없습니다/);assert.doesNotMatch(failed,/lg-table|0건/);
 }
});

test('09-24 감시 일상 기록은 기본으로 숨기고 체크로 다시 보며, 이름 없던 종류는 한국어로·감시 대상은 감시 전체로', () => {
  const entries = [
    {kind:'watch-cycle', by:'watch', t:'2026-09-24T00:00:00Z'},
    {kind:'watch-scope', by:'watch', t:'2026-09-24T00:00:01Z'},
    {kind:'alert', by:'watch', role:'감독', alertKind:'stall', level:'warn', t:'2026-09-24T00:00:02Z'},
    {kind:'rate-limit-retry', by:'watch', t:'2026-09-24T00:00:03Z'},
    {kind:'runner-settings', by:'슈퍼감독', t:'2026-09-24T00:00:04Z'},
  ];
  const hidden = ledger(entries);
  assert.match(hidden, /3건 · 최신순 · 감시 일상 기록 2건 숨김/);
  assert.doesNotMatch(hidden, /감시 순회|감시 대상 설정/);
  assert.match(hidden, /감시 알림/);
  assert.match(hidden, /<td title="rate-limit-retry">한도 재시도<\/td>/);
  assert.match(hidden, /<td title="runner-settings">실행 모델 변경<\/td>/);
  // 대상이 없는 감시 기록은 '모름'이 아니라 '감시 전체'.
  assert.match(hidden, /<td title="watch">watch<\/td><td title="감시 전체">감시 전체<\/td>/);
  assert.match(hidden, /<input type="checkbox" name="ledgerRoutine" value="1"> 감시 일상 기록 보기/);
  const shown = ledger(entries, '?ledgerRoutine=1');
  assert.match(shown, /5건 · 최신순<\/span>/);
  assert.match(shown, /<td title="watch-cycle">감시 순회<\/td>/);
  assert.match(shown, /name="ledgerRoutine" value="1" checked/);
});
