import test from 'node:test';
import assert from 'node:assert/strict';
import {STATUS_LABELS,statusLabel,statusBucket,isEnded,exactStatusLabel} from '../src/status-labels.mjs';
import {stateText,finished,waitingText,progressLabel} from '../src/human-brief.mjs';
import {progressGroup} from '../src/board-progress.mjs';
import {executionHealth,executionBucket} from '../src/dashboard-execution.mjs';
import {buildCardCenter} from '../src/card-center.mjs';

// 세 묶음과 이름은 2026-10-05 [kyle] 결정. 저장 코드는 그대로 두고 화면 낱말만 바꾼다.
test('저장 상태마다 이름이 하나이고 세 묶음(진행 전·진행 중·끝)으로 나뉜다',()=>{
 const expected={draft:['초안','before'],ready:['설계완료','before'],archived:['보류','before'],
  assigned:['작업대기','active'],running:['작업중','active'],waiting:['작업중','active'],hold:['일시정지','active'],
  done:['완료','end'],cancelled:['취소','end'],superseded:['대체','end']};
 for(const [state,[label,bucket]] of Object.entries(expected)){
  assert.equal(statusLabel(state),label,state);assert.equal(statusBucket(state),bucket,state);
 }
 assert.deepEqual(Object.keys(expected).filter(isEnded),['done','cancelled','superseded']);
});

test('실행 기록으로 계산한 상태는 확인 필요 신호로 남고 모르는 상태는 끝으로 숨기지 않는다',()=>{
 for(const state of ['unconfirmed','orphaned','failed','needs-check','unknown','처음 보는 값'])assert.equal(statusBucket(state),'check',state);
 assert.equal(statusLabel('unconfirmed'),'발령됨');assert.equal(statusLabel('orphaned'),'세션 확인 필요');
 assert.equal(statusLabel('failed'),'실패');assert.equal(statusLabel('needs-check'),'확인 필요');
 assert.equal(statusLabel('처음 보는 값'),'처음 보는 값');
});

test('기존 stateText는 같은 열쇠를 유지하며 이름은 한 곳에서 가져온다',()=>{
 assert.deepEqual(Object.keys(stateText).sort(),['archived','assigned','cancelled','done','draft','failed','hold','orphaned','ready','running','superseded','unconfirmed','waiting']);
 for(const [key,label] of Object.entries(stateText))assert.equal(label,STATUS_LABELS[key]);
 // 필터·이력처럼 칸을 구분할 곳에서만 결과 대기에 기다림을 붙인다.
 assert.equal(exactStatusLabel('waiting'),'작업중 · 기다림');assert.equal(exactStatusLabel('running'),'작업중');
});

test('진행 막대: 보류는 진행 전, 결과 대기는 작업중, 작업대기는 따로 센다',()=>{
 assert.equal(progressGroup('archived'),'planned');
 assert.equal(progressGroup('waiting'),'running');
 assert.equal(progressGroup('assigned'),'assigned');
 assert.equal(progressGroup('hold'),'hold');
 assert.equal(progressGroup('superseded'),'closed');
 assert.equal(progressGroup('failed'),'failed');
 assert.equal(progressGroup('orphaned'),'check');
});

test('보류 카드는 남은 일로 세고 막힘·오래된 미정리 경보에 넣지 않는다',()=>{
 const old={key:'r/a',displayState:'archived',status:'archived',role:null,runs:[],history:[]};
 assert.equal(finished(old),false);
 const health=executionHealth(old,Date.parse('2030-01-01T00:00:00Z'));
 assert.equal(health.healthKind,'planned');assert.equal(health.healthLabel,'보류');
 assert.equal(executionBucket(old,Date.parse('2030-01-01T00:00:00Z')),'planned');
});

const card=(id,status,board='판')=>({key:'repo/'+id,id,repo:'repo',title:id,status,board,at:'2026-10-01T00:00:00Z',history:[{status,at:'2026-10-01T00:00:00Z'}]});
const center=cards=>buildCardCenter({cards,entries:[],tree:[]});

test('판 묶음: 완료·취소·대체만이면 끝, 보류가 섞이면 끝이 아니다',()=>{
 assert.equal(center([card('a','done'),card('b','cancelled'),card('c','superseded')]).boards[0].state,'done');
 const parked=center([card('a','done'),card('b','archived')]);
 assert.equal(parked.boards[0].state,'planned');
 assert.equal(parked.summary.openBoards,1);
 assert.equal(parked.executionSummary.remaining,1);
});

test('결과 대기: 요약 묶음은 작업중, 멈춤 판정용 종류는 waiting, 상세에만 이유를 붙인다',()=>{
 const reportAt='2026-10-05T01:00:00Z',now=Date.parse('2026-10-05T01:30:00Z');
 const waitingReport={status:'assigned',noteKind:'progress',by:'worker',role:'worker',activity:'waiting',activityAt:reportAt,at:reportAt,note:'검수 결과'};
 const c={key:'r/w',status:'assigned',displayState:'waiting',role:'worker',activity:'waiting',activityAt:reportAt,activityRole:'worker',
  runs:[{role:'worker',sentAt:'2026-10-05T00:00:00Z',state:'unconfirmed',sessionState:'alive'}],history:[waitingReport]};
 const health=executionHealth(c,now);
 assert.equal(health.healthKind,'waiting');assert.equal(health.healthLabel,'작업중');
 assert.equal(executionBucket(c,now),'running');
 assert.equal(progressLabel(c,now),'작업중 · 마지막 보고 30분 전');
 assert.equal(waitingText(c),'작업중 · 검수 결과 기다림');
 // 뒤에 붙은 일반 메모는 기다리는 이유로 쓰지 않는다.
 const later={...c,history:[waitingReport,{...waitingReport,at:'2026-10-05T01:10:00Z',note:'중간 메모'}]};
 assert.equal(waitingText(later),'작업중 · 검수 결과 기다림');
 // 이유가 없으면 작업중만 적는다.
 assert.equal(waitingText({...c,history:[{...waitingReport,note:''}]}),'작업중');
});
