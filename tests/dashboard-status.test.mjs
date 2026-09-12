import test from 'node:test';
import assert from 'node:assert/strict';
import {renderDashboardStatus} from '../src/dashboard-status.mjs';

const work=(over={})=>({key:'work:r/w1',id:'w1',repo:'r',title:'현황 업무',state:'running',stateLabel:'진행 중',purpose:'사용자에게 약속한 결과',flowLabel:'1라운드 · 구현',flowPhase:'실행 0/1건 종료 · 업무는 미완료',turnLabel:'슈퍼감독',next:'DONE 후보 수신 시 결과·마커 대조 후 독립검수 발령',summary:'구현 결과 도착 보고',reportLabel:'09. 10. 11:32',board:'b',...over});
const card=(over={})=>({key:'r/c1',id:'c1',title:'실행 카드',status:'assigned',displayState:'unconfirmed',board:'b',role:'작업자',at:'2026-09-10T02:00:00Z',runs:[],history:[],...over});
const centerWith=cards=>({cards,boards:[{name:'b',state:'needs-check',cards,runs:[]}],summary:{cards:cards.length,running:0,ready:0,attention:cards.filter(c=>['unconfirmed','orphaned','failed'].includes(c.displayState)).length,openBoards:1}});

test('현황 화면은 확인 필요·진행 업무·끝난 업무를 구분해 보여준다',()=>{
 const cards=[card(),card({key:'r/c2',id:'c2',title:'<실패 카드>',displayState:'failed'}),card({key:'r/c3',id:'c3',title:'끝난 카드',displayState:'done'})];
 const works=[work(),work({key:'work:r/w2',id:'w2',title:'끝난 업무',state:'done',stateLabel:'업무 완료'})];
 const html=renderDashboardStatus({center:centerWith(cards),works,decisions:[{id:'q1',status:'open',question:'공개?'}]});
 assert.match(html,/st-cnt-attn">2건<\/span>/);
 assert.match(html,/실행 확인 필요/);
 assert.match(html,/실패 확인 필요/);
 assert.ok(html.includes('&lt;실패 카드&gt;'),'카드 제목은 이스케이프한다');
 assert.match(html,/st-num">3<\/span><span class="st-lbl">전체 실행 카드/);
 assert.match(html,/DONE 후보 수신 시 결과·마커 대조 후 독립검수 발령/);
 assert.match(html,/지금 차례<\/dt><dd class="st-turn">슈퍼감독/);
 assert.match(html,/업무 기록 09. 10. 11:32/);
 assert.match(html,/<summary>끝난 업무 1장<\/summary>/);
 assert.match(html,/내 결정 대기/);
 assert.match(html,/data-view="status"/);
 assert.ok(!html.includes('430'),'다른 화면 수치를 끌어오지 않는다');
});

test('카드 기록을 읽지 못하면 수치를 꾸미지 않고 모름으로 표시한다',()=>{
 const html=renderDashboardStatus({center:null,works:null});
 assert.match(html,/카드 기록을 읽지 못해 확인 필요 수를 계산하지 않았습니다/);
 assert.match(html,/업무 기록을 읽을 수 없습니다/);
 assert.match(html,/>모름<\/span><span class="st-lbl">확인 필요/);
 assert.ok(!html.includes('0건'));
});

test('업무 기록만 깨져도 확인 필요 목록은 그대로 보여준다',()=>{
 const cards=[card()];
 const html=renderDashboardStatus({center:centerWith(cards),works:null,workError:'손상된 줄'});
 assert.match(html,/업무 기록을 읽을 수 없습니다: 손상된 줄/);
 assert.match(html,/실행 카드/);
 assert.match(html,/>1건<\/span>/);
});
