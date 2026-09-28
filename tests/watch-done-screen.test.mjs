import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {collectRoles} from '../src/watch-runner.mjs';
import {assessRoles} from '../src/watch.mjs';
import {runWatch} from './helpers/watch-runner.mjs';

const role='p-worker',session=`kadan-${role}`;
const start={kind:'start',role,session,panePid:1,t:'2026-09-28T00:00:00Z'};
const dispatch={kind:'send',role,session,taskId:'a',executionKey:'repo/a',baselineMarkers:[],t:'2026-09-28T00:01:00Z'};
const cards=['a','b'].map(id=>({id,key:`repo/${id}`}));
// 실제 완료 화면처럼 마커 아래에 소요 시간·입력창·모델·권한 상태줄이 남는다.
const footer='\n\n✻ Finished in 2s\n\n────────\n❯\n────────\nworkspace\nModel | context:38%\npermissions on';
const screen=(marker='⏺ KADAN:DONE a ok')=>marker+footer;
function check(text=screen(),entries=[start,dispatch],allCards=cards) {
  const observations=collectRoles({list:()=>[{session,pid:1}],read:()=>text},entries,null,allCards).observations;
  return assessRoles(new Map(),observations,60000,60000,20).alerts.filter(a=>a.kind==='완료후보');
}

test('완료 마커가 상태줄 위 10번째 줄이어도 현재 실행의 후보를 찾는다',()=>{
  for(const marker of ['KADAN:DONE a ok','• KADAN:DONE repo/a ok','⏺ KADAN:DONE a failed']) {
    const alerts=check(screen(marker));assert.equal(alerts.length,1,marker);
    assert.equal(alerts[0].taskId,marker.includes('repo/a')?'repo/a':'a');
    assert.equal(alerts[0].result,marker.endsWith('failed')?'failed':'ok');
  }
});

test('발령 전 마커는 별칭으로 바뀌어 보여도 제외하고 새로 추가된 마커만 인정한다',()=>{
  const entries=[start,{...dispatch,baselineMarkers:[{taskId:'repo/a',result:'ok'}]}];
  assert.deepEqual(check(screen(),entries),[]);
  assert.equal(check(screen('KADAN:DONE a ok\n⏺ KADAN:DONE repo/a ok'),entries).length,1);
});

test('다른 카드·다른 저장소·모호한 주소·입력 되풀이는 완료후보로 쓰지 않는다',()=>{
  for(const marker of ['KADAN:DONE b ok','KADAN:DONE other/a ok','› KADAN:DONE a ok','❯ KADAN:DONE a ok','완료: KADAN:DONE a ok'])assert.deepEqual(check(screen(marker)),[],marker);
  assert.deepEqual(check(screen(),[start,dispatch],[...cards,{key:'other/a',id:'a'}]),[]);
  assert.deepEqual(check(screen('KADAN:DONE repo/a ok'),[start,{...dispatch,role:'p-other',session:'kadan-p-other'}]),[]);
});

test('세션 재시작 이전의 발령은 새 세대의 완료 근거가 아니다',()=>{
  assert.deepEqual(check(screen(),[start,dispatch,{...start,t:'2026-09-28T00:02:00Z'}]),[]);
});

test('카드 목록 없는 기존 호출만 발령 없는 후보를 유지하고 빈 등록 목록은 추측하지 않는다',()=>{
  assert.equal(check(screen(),[start],null).length,1);
  assert.deepEqual(check(screen(),[start],[]),[]);
});

test('재발령은 최신 기준 화면을 쓰고 단순 우편은 그 기준을 바꾸지 않는다',()=>{
  const repeated={...dispatch,t:'2026-09-28T00:02:00Z',baselineMarkers:[{taskId:'a',result:'ok'}]};
  assert.deepEqual(check(screen(),[start,dispatch,repeated]),[]);
  assert.equal(check(screen(),[start,dispatch,{kind:'send',role,session,preview:'완료 확인 중'}]).length,1);
  assert.deepEqual(check(screen(),[start,{...dispatch,transport:'mailbox'}]),[]);
});

test('여러 실행이 있어도 화면에서 마지막으로 나온 유효 마커를 쓴다',()=>{
  const entries=[start,dispatch,{...dispatch,taskId:'b',executionKey:'repo/b'}];
  const alerts=check(screen('KADAN:DONE a ok\nKADAN:DONE b failed'),entries);
  assert.deepEqual(alerts.map(a=>[a.taskId,a.result]),[['b','failed']]);
});

test('유예 중 재발령되면 이전 마커로 저장해 둔 완료후보도 폐기한다',async()=>{
  let cycle=0;const records=[],end=new Error('end');
  const repeated={...dispatch,t:'2026-09-28T00:03:00Z',baselineMarkers:[{taskId:'a',result:'ok'}]};
  await assert.rejects(()=>runWatch({
    floor:{list:()=>[{session,pid:1}],read:()=>screen()},
    readEntries:()=>cycle===0?[start,dispatch]:[start,dispatch,repeated],
    readCards:()=>cards.map(c=>({...c,role,status:'assigned',activity:'running',activityRole:role,activityAt:dispatch.t})),readWorks:()=>[],
    record:e=>records.push(e),sendAlert:()=>assert.fail('unexpected alert'),
    intervalMs:60000,completionGraceMs:120000,stallN:100,
    now:()=>Date.parse(dispatch.t)+60000*(cycle+1),print:()=>{},
    spawn:command=>{if(command==='sleep'&&++cycle===4)throw end;return {status:0,stdout:''};},
  }),error=>error===end);
  assert.equal(records.filter(e=>e.alertKind==='완료후보').length,0);
});
