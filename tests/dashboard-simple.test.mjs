import test from 'node:test';
import assert from 'node:assert/strict';
import {renderCardInbox,renderInbox} from '../src/dashboard-inbox.mjs';
import {workspaceColumns,workspaceRowsHtml,renderWorkspaceDetail} from '../src/dashboard-workspace.mjs';
import {renderWorkDetail,workDashboardModel} from '../src/work-dashboard.mjs';
const card={key:'repo/c',id:'c',repo:'repo',title:'제품 사진 연결',body:'## Why\n사진 확인',role:'작업자',status:'assigned',displayState:'assigned',history:[],runs:[],revision:1};
const send=(patch={})=>({kind:'send',t:'2026-09-09T01:00:00Z',by:'감독',role:'작업자',preview:'연결한 편지',mailId:'m1',taskId:'c',...patch});
test('실행 인박스는 주소와 고유 카드 ID 및 답장만 연결하며 다른 업무 편지를 섞지 않는다',()=>{
 const entries=[send(),send({mailId:'m2',taskId:null,replyTo:'m1',by:'작업자',role:'감독',preview:'답장 본문'}),send({mailId:'m3',taskId:'other',preview:'다른 카드 제외'}),send({mailId:'m4',taskId:'c',workKey:'other/work',preview:'다른 업무 제외'})];
 const html=renderCardInbox(card,{entries});
 assert.match(html,/2통/);assert.match(html,/답장 본문/);assert.doesNotMatch(html,/다른 카드 제외|다른 업무 제외/);
 assert.match(html,/보낸 사람 → 받는 사람/);assert.equal((html.match(/id="bw-mail-/g)||[]).length,2);
 const duplicate={...card,key:'another/c'};
 assert.doesNotMatch(renderCardInbox(card,{entries,cards:[card,duplicate]}),/연결한 편지|답장 본문/);
 assert.match(renderCardInbox(card,{entries:[send({executionKey:card.key})],cards:[card,duplicate]}),/연결한 편지/);
 assert.match(renderCardInbox(card,{entries:[{broken:true}]}),/인박스 확인 불가/);
});
test('인박스 페이지는 카드·검색 조건을 보존하고 표시용 본문은 HTML로 실행하지 않는다',()=>{
 const letters=Array.from({length:101},(_,i)=>send({preview:i===100?'<script>끝 편지</script>':'앞 편지'}));
 const url=new URL('http://localhost/?q=사진&layout=table&mailPage=2&tab=mail');
 const html=renderInbox({key:'work:repo/w',letters},null,url);
 assert.match(html,/2\/2쪽/);assert.match(html,/&lt;script&gt;끝 편지/);assert.doesNotMatch(html,/<script>|앞 편지/);
 assert.match(html,/tab=summary/);assert.match(html,/layout=table/);assert.match(html,/card=work%3Arepo%2Fw/);
});
test('목록은 현재 차례를 남기고 고정 실행 담당 열과 반복 담당 줄을 제거한다',()=>{
 assert.equal(workspaceColumns.length,11);assert.ok(!workspaceColumns.some(([key])=>key==='owner'));
 const row={...card,owner:'고정담당이름',turnLabel:'현재차례이름'};
 for(const view of ['table','split']){const html=workspaceRowsHtml([row],view,'');assert.match(html,/현재차례이름/);assert.doesNotMatch(html,/고정담당이름|data-column="owner"|실행 담당/);}
});
test('예전 실행 카드도 인박스를 기본 표시하고 원본·기록·폼은 접어 보존한다',()=>{
 const html=renderWorkspaceDetail(card,{entries:[send()],form:'<form>보존할 편집 폼</form>'});
 const summary=html.match(/id="dw-panel-summary"[\s\S]*?<\/section>/)[0];
 assert.match(summary,/인박스 <span>1통/);assert.doesNotMatch(summary,/최근 기록|세션 상태/);
 assert.doesNotMatch(html,/실행 담당|role="tablist"/);assert.match(html,/<details class="dw-detail-fold" data-detail-section="technical">/);
 assert.match(html,/세션 상태/);assert.equal((html.match(/보존할 편집 폼/g)||[]).length,1);
});
test('업무 상세는 목표·현재 차례·인박스가 먼저 보이고 실행 명세와 책임자는 기술 정보에 남는다',()=>{
 const base={key:'repo/w',id:'w',repo:'repo',title:'업무 제목',goal:'약속한 결과',scope:'전체 대상',acceptance:'완료 조건',owner:'책임감독이름',status:'open',executions:[],mailRefs:[],history:[],revision:1};
 const w=workDashboardModel([base],{cards:[]},[])[0];
 const html=renderWorkDetail(w,{token:'t',center:{cards:[]},models:[w],url:new URL('http://localhost')});
 const summary=html.match(/id="dw-panel-summary"[\s\S]*?<\/section>/)[0];
 assert.match(summary,/약속한 결과/);assert.match(summary,/현재 차례/);assert.match(summary,/인박스/);
 assert.doesNotMatch(html,/실행 담당|role="tablist"/);assert.doesNotMatch(summary,/이 업무의 실행|name="revision"|완료 구분/);
 assert.match(html,/<details class="dw-detail-fold" data-detail-section="technical">/);
 assert.match(html,/action="\/works\/execute"/);assert.match(html,/action="\/works\/update"/);
});
