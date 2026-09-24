import test from 'node:test';
import assert from 'node:assert/strict';
import {filterMail,mailMatchesCard} from '../src/dashboard-inbox.mjs';
import {filterLedgerRows,isIncident,renderLedgerTable} from '../src/ledger-table.mjs';
import {renderActivity} from '../src/decision-wall.mjs';

const url=q=>new URL('http://localhost/'+q);
const mails=[
 {kind:'send',by:'감독',role:'작업자',taskId:'card-a',mailId:'m1',preview:'card-a 발령',t:'2026-09-24T01:00:00Z'},
 {kind:'send',by:'작업자',role:'감독',completion:true,executionKey:'r/card-a',completionTaskId:'card-a',mailId:'m2',preview:'완료',t:'2026-09-24T02:00:00Z'},
 {kind:'send',by:'감독',role:'검수자',taskId:'card-b',mailId:'m3',preview:'검수 요청',digest:'d3',t:'2026-09-24T03:00:00Z'},
];

test('09-24 우편함: 카드(키·ID)와 글자(번호·미리보기·본문)로 거른다', () => {
  assert.deepEqual(filterMail(mails,url('?mailCard=card-a')).map(m=>m.mailId),['m1','m2']);
  assert.deepEqual(filterMail(mails,url('?mailCard=r/card-a')).map(m=>m.mailId),['m1','m2']);
  assert.equal(mailMatchesCard({executionKey:'q/card-a'},'r/card-a'),false);
  assert.deepEqual(filterMail(mails,url('?mailQ=검수')).map(m=>m.mailId),['m3']);
  assert.deepEqual(filterMail(mails,url('?mailQ=숨은말'),{bodyOf:m=>m.digest==='d3'?'본문에 숨은말이 있다':null}).map(m=>m.mailId),['m3']);
});

test('09-24 사건순 기록: 사고만·카드·역할·서울 날짜로 거른다', () => {
  const rows=[
    {kind:'done',role:'작업자',taskId:'card-a',result:'failed',t:'2026-09-24T14:59:00Z'},
    {kind:'done',role:'작업자',taskId:'card-a',result:'ok',t:'2026-09-24T15:01:00Z'},
    {kind:'alert',by:'watch',role:'감독',alertKind:'stall',t:'2026-09-24T01:00:00Z'},
    {kind:'alert',by:'watch',role:'감독',resolved:true,t:'2026-09-24T01:10:00Z'},
    {kind:'send',by:'감독',role:'검수자',taskId:'card-b',t:'2026-09-24T02:00:00Z'},
  ];
  assert.deepEqual(filterLedgerRows(rows,{kind:'incident'}).map(r=>r.kind+(r.result||'')),['donefailed','alert']);
  assert.equal(isIncident({kind:'watch-ai-call',reason:'call-failed'}),true);
  assert.equal(filterLedgerRows(rows,{card:'card-a'}).length,2);
  assert.equal(filterLedgerRows(rows,{role:'검수자'}).length,1);
  // 서울 기준: 14:59Z는 9/24 23:59, 15:01Z는 9/25 00:01.
  assert.deepEqual(filterLedgerRows(rows,{date:'2026-09-25'}).map(r=>r.result),['ok']);
});

test('09-24 우편·기록의 작업 ID는 카드 상세 링크, 기록 위에는 최근 사고 바로가기와 필터', () => {
  const center={cards:[{key:'r/card-a',id:'card-a',runs:[]},{key:'r/card-b',id:'card-b',runs:[]}]};
  const entries=mails.map((m,i)=>({...m,_ledgerOrder:i+1}));
  const html=renderActivity({center,entries,ledgerLines:entries.length},url(''));
  assert.match(html,/<td><a href="\?card=r%2Fcard-a#detail">card-a<\/a><span class="state">/);
  assert.match(html,/<a class="lg-incidents" href="\?ledgerKind=incident#ledger">최근 사고<\/a>/);
  assert.match(html,/<select name="ledgerKind"><option value="" selected>전체<\/option><option value="incident">사고만<\/option>/);
  assert.match(html,/<input name="mailCard" value=""/);
  assert.match(html,/<datalist id="mail-role-options">(?=[\s\S]*<option value="감독">)(?=[\s\S]*<option value="검수자">)/);
  const table=renderLedgerTable([{kind:'send',by:'감독',role:'검수자',taskId:'card-b',preview:'요청'}],{cardHref:()=>'?card=r%2Fcard-b#detail'});
  assert.match(table,/<a href="\?card=r%2Fcard-b#detail">card-b<\/a> · 요청/);
});

test('09-24 작업별 실행: 최근 시각 순, 상태로 거르기와 건수, 상태 색, 카드 제목 먼저', () => {
  const center={cards:[
    {key:'r/a',id:'a',title:'카드 가',board:'p',runs:[{state:'failed',role:'w',at:'2026-09-24T01:00:00Z'},{state:'done',role:'w',at:'2026-09-24T05:00:00Z'}]},
    {key:'r/b',id:'b',title:'카드 나',board:'p',runs:[{state:'unconfirmed',role:'w',at:'2026-09-24T03:00:00Z'}]}]};
  const section=q=>{const h=renderActivity({center,entries:[],ledgerLines:0},url(q));return h.slice(h.indexOf('id="runs"'),h.indexOf('</section>',h.indexOf('id="runs"')));};
  const all=section('');
  assert.deepEqual([...all.matchAll(/run-state run-([a-z]+)/g)].map(m=>m[1]),['done','unconfirmed','failed']);
  assert.match(all,/<option value="" selected>전체 3<\/option><option value="failed">실패 기록 1<\/option><option value="unconfirmed">완료 미확인 1<\/option>/);
  assert.match(all,/<a href="\?card=r%2Fa#detail">카드 가<\/a><br><small class="run-key">r\/a<\/small>/);
  assert.deepEqual([...section('?runState=failed').matchAll(/run-state run-([a-z]+)/g)].map(m=>m[1]),['failed']);
});

test('09-24 막힌 실행: 결과 파일의 한 줄 요약 → 원인 → 실패 말이 든 줄 순으로 이유를 뽑고, 감독에게 물어볼 문장 복사', async () => {
  const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
  const {failureReason,renderDashboardStatus}=await import('../src/dashboard-status.mjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-ux2-'));
  const file=name=>path.join(dir,name);
  fs.writeFileSync(file('a.md'),'# 결과\n## 1\n- 판정: exception\n- 한 줄 요약: **#311** Preview가 `404`로 실패했다.\n- 원인: 다른 것\n');
  fs.writeFileSync(file('b.md'),'# 결과\n- 진행 기록\n- 원인: 결제 한도로 job 미시작\n');
  fs.writeFileSync(file('c.md'),'# 결과\n| 단계 | **실패** | run 1 |\n');
  assert.equal(failureReason({resultPath:file('a.md')}),'#311 Preview가 404로 실패했다.');
  assert.equal(failureReason({resultPath:file('b.md')}),'결제 한도로 job 미시작');
  assert.equal(failureReason({resultPath:file('c.md')}),'단계 · 실패 · run 1');
  assert.equal(failureReason({resultPath:file('none.md'),history:[{note:'마지막 메모'}]}),'마지막 메모');
  const card={key:'r/a',id:'a',title:'카드 가',status:'assigned',role:'w',board:'p',workType:'execution',displayState:'failed',state:'failed',resultPath:file('a.md'),
    runs:[{role:'w',state:'failed',sessionState:'alive',at:new Date().toISOString()}],history:[{note:'x'}]};
  const html=renderDashboardStatus({center:{cards:[card],boards:[]},works:[],decisions:[]});
  const section=html.slice(html.indexOf('id="status-attention"'),html.indexOf('id="status-executing"'));
  assert.match(section,/<p class="st-attn-reason"><strong>이유<\/strong> #311 Preview가 404로 실패했다\.<\/p>/);
  assert.match(section,/class="copy-question" data-copy-label="확인 요청" data-question="\[대시보드 확인 요청\] 카드 r\/a 실행이/);
  assert.match(section,/작업 표에서 보기/);
});

test('09-24 작업 화면: health=stuck은 현황의 지금 막힌 것과 같은 분류(bucket)로 거른다', async () => {
  const {filterWorkspaceRows}=await import('../src/dashboard-workspace.mjs');
  const rows=[{key:'r/a',kind:'execution',state:'failed',bucket:'stuck',healthLabel:'실패 확인 필요'},{key:'r/b',kind:'execution',state:'failed',bucket:'stale',healthLabel:'실패 확인 필요'},{key:'r/c',kind:'execution',state:'running',bucket:'running',healthLabel:'작업 중'}];
  assert.deepEqual(filterWorkspaceRows(rows,{state:'all',health:'stuck'}).map(r=>r.key),['r/a']);
  assert.deepEqual(filterWorkspaceRows(rows,{state:'all',health:'실패 확인 필요'}).map(r=>r.key),['r/a','r/b']);
});
