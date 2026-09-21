import test from 'node:test';
import assert from 'node:assert/strict';
import {executionHealth,workHealth} from '../src/dashboard-execution.mjs';
import {renderDashboardStatus} from '../src/dashboard-status.mjs';
const sent='2020-01-01T00:00:00Z',reported='2020-01-01T01:00:00Z',edited='2020-01-03T00:00:00Z',now=Date.parse('2020-01-04T00:00:00Z');
const card=(patch={})=>({key:'r/c',id:'c',title:'예제 실행',role:'worker',status:'assigned',displayState:'running',at:edited,history:[{by:'worker',role:'worker',noteKind:'progress',note:'검증을 진행합니다',at:reported}],runs:[{role:'worker',state:'unconfirmed',sessionState:'alive',sentAt:sent,at:sent}],...patch});
test('카드 수정은 실행 신호를 갱신하지 않으며 보고 시각만 오래됐다고 정체로 만들지 않는다',()=>{
 const before=executionHealth(card(),now),after=executionHealth(card({at:new Date(now).toISOString()}),now);
 assert.equal(before.healthKind,'running');assert.equal(before.signalAt,reported);assert.equal(before.signalLabel,'진행 보고');assert.deepEqual(after,before);
});
test('현재 보고와 세션이 있어야 작업 중이며 PID 변경·세션 조회 오류·보고 없음은 확인 필요다',()=>{
 for(const sessionState of ['changed','unknown','absent'])assert.equal(executionHealth(card({runs:[{role:'worker',state:'unconfirmed',sessionState,sentAt:sent,at:sent}]}),now).healthKind,'attention');
 assert.equal(executionHealth(card({history:[]}),now).healthKind,'attention');
 assert.equal(executionHealth(card({history:[{by:'supervisor',noteKind:'progress',at:edited}]}),now).healthKind,'attention');
 assert.equal(executionHealth(card({runs:[{role:'worker',state:'unconfirmed',sessionState:'alive',sentAt:edited,at:edited}]}),now).healthKind,'attention');
});
test('결과 대기·보류·실행 전·종료는 작업 중과 구분되고 종료는 세션 부재로 오류가 되지 않는다',()=>{
 for(const [displayState,kind] of [['waiting','waiting'],['hold','hold'],['ready','planned'],['draft','planned'],['done','closed'],['cancelled','closed']])assert.equal(executionHealth(card({displayState}),now).healthKind,kind);
 assert.equal(executionHealth(card({displayState:'done',runs:[]}),now).healthKind,'closed');
 const done=executionHealth(card({displayState:'done',runs:[{role:'worker',state:'done',sessionState:'absent',sentAt:sent,at:edited}]}),now);
 assert.equal(done.signalAt,edited);assert.equal(done.signalLabel,'실행 완료');
});
test('열린 업무는 실제 실행 기준으로 준비·대기·확인·최종 확인을 구분한다',()=>{
 const w={status:'open'},link=c=>({round:1,card:c});
 assert.equal(workHealth(w,[],now).healthKind,'planned');
 assert.equal(workHealth(w,[link(card({displayState:'waiting'}))],now).healthKind,'waiting');
 assert.equal(workHealth(w,[link(card()),link(card({displayState:'failed'}))],now).healthKind,'attention');
 assert.equal(workHealth(w,[link(null)],now).healthKind,'attention');
 assert.equal(workHealth(w,[link(card({displayState:'done'}))],now).healthLabel,'감독 확인 차례');
 assert.equal(workHealth(w,[{round:1,card:card({displayState:'failed'})},{round:2,card:card()}],now).healthKind,'running');
 assert.equal(workHealth({status:'done'},[link(card())],now).healthKind,'attention');
});
test('첫 화면은 업무 연결 없는 실행과 결과 대기를 표시하고 관리 카드는 실행 집계에서 제외한다',()=>{
 const html=renderDashboardStatus({center:{cards:[card(),card({key:'r/w',title:'대기 예제',displayState:'waiting'}),card({key:'r/m',title:'관리 예제',workType:'coordination'})],boards:[]},works:[],collectedAt:edited});
 assert.match(html,/st-num">1<\/span><span class="st-lbl">작업 중/);
 assert.match(html,/st-num">1<\/span><span class="st-lbl">결과 대기/);
 assert.match(html,/st-num">2<\/span><span class="st-lbl">전체 실행 카드/);
 assert.match(html,/예제 실행/);assert.match(html,/대기 예제/);assert.ok(!html.includes('관리 예제'));
 assert.match(html,/열린 업무가 없습니다/);assert.match(html,/감시 정보 미수집/);
});
