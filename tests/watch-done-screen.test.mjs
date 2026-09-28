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
  const entries=[start,dispatch,{...start,panePid:2,t:'2026-09-28T00:02:00Z'}];
  const seen=collectRoles({list:()=>[{session,pid:2}],read:()=>screen()},entries,null,cards).observations.get(session);
  assert.equal(seen.alive,true);assert.equal(seen.doneMarker,null);
  assert.equal(seen.completionDispatches.size,0);
});

test('같은 PID의 start 재사용은 발령과 발령 전 마커 기준·세대 시각을 유지한다',()=>{
  const reused={...start,panePid:'1',t:'2026-09-28T00:02:00Z'};
  const entries=[start,dispatch,reused];
  assert.equal(check(screen(),entries).length,1);
  const seen=collectRoles({list:()=>[{session,pid:1}],read:()=>screen()},entries,null,cards).observations.get(session);
  assert.equal(seen.startedAt,start.t);
  assert.deepEqual(check(screen(),[start,{...dispatch,baselineMarkers:[{taskId:'repo/a',result:'ok'}]},reused]),[]);
});

test('종료 뒤 같은 PID가 다시 나오거나 PID를 모르면 재사용으로 추측하지 않는다',()=>{
  assert.deepEqual(check(screen(),[start,dispatch,{kind:'stop',session,role},{...start,t:'2026-09-28T00:02:00Z'}]),[]);
  assert.deepEqual(check(screen(),[start,dispatch,{...start,panePid:null,t:'2026-09-28T00:02:00Z'}]),[]);
});

const nextRole='p-next',nextSession=`kadan-${nextRole}`;
const successor={...start,role:nextRole,session:nextSession,panePid:2,t:'2026-09-28T00:02:00Z'};
const transfer={kind:'handover',phase:'transferred',handoverId:'h1',from:role,to:nextRole,taskIds:['repo/a'],t:'2026-09-28T00:03:00Z'};
function successorObservation(entries,{text=screen(),pid=2,allCards=cards,target=nextSession}={}) {
  return collectRoles({list:()=>[{session:target,pid}],read:()=>text},entries,null,allCards).observations.get(target);
}

test('확정 인계는 짧은·정식 카드 주소와 종료된 선임의 발령을 후임에게 연결한다',()=>{
  for(const taskId of ['a','repo/a'])for(const ended of [false,true]) {
    const entries=[start,dispatch,...(ended?[{kind:'stop',session,role}]:[]),successor,{...transfer,taskIds:[taskId]}];
    const seen=successorObservation(entries);
    assert.equal(seen.doneMarker?.taskId,'a');
    assert.equal(seen.completionDispatches.get('repo/a')?.role,nextRole);
    assert.equal(collectRoles({list:()=>[],read:()=>''},entries,null,cards).observations.get(session).completionDispatches.has('repo/a'),false);
  }
});

test('미확정 인계·목록 밖 카드·시작 안 한 후임·모호한 카드 주소는 이어받지 않는다',()=>{
  for(const phase of ['prepared','accepted','routes-pending','aborted']) {
    assert.equal(successorObservation([start,dispatch,successor,{...transfer,phase}]).doneMarker,null);
  }
  assert.equal(successorObservation([start,dispatch,successor,{...transfer,taskIds:['b']}]).doneMarker,null);
  assert.equal(successorObservation([start,dispatch,transfer,successor]).doneMarker,null);
  assert.equal(successorObservation([start,dispatch,successor,{...transfer,taskIds:['a']}],{allCards:[...cards,{key:'other/a',id:'a'}]}).doneMarker,null);
});

test('후임도 기존 마커 제외·재발령 기준을 유지하고 재시작하면 이전 인계를 버린다',()=>{
  const baseline=[{taskId:'repo/a',result:'ok'}];
  assert.equal(successorObservation([start,{...dispatch,baselineMarkers:baseline},successor,transfer]).doneMarker,null);
  const entries=[start,dispatch,successor,transfer];
  assert.equal(successorObservation([...entries,{...dispatch,role:nextRole,session:nextSession,baselineMarkers:baseline,t:'2026-09-28T00:04:00Z'}]).doneMarker,null);
  assert.equal(successorObservation([...entries,{...successor,panePid:3,t:'2026-09-28T00:04:00Z'}],{pid:3}).doneMarker,null);
  const last={...successor,role:'p-last',session:'kadan-p-last',panePid:3,t:'2026-09-28T00:04:00Z'};
  const twice=[...entries,last,{...transfer,from:nextRole,to:'p-last',handoverId:'h2',t:'2026-09-28T00:05:00Z'}];
  assert.equal(successorObservation(twice,{target:last.session,pid:3}).doneMarker?.taskId,'a');
});

test('감시 루프는 재사용 중 유예를 유지하고 인계 후임의 후보를 감독에게 전달한다',async()=>{
  for(const inherited of [false,true]) {
    let cycle=0;const records=[],messages=[],end=new Error('end');
    const currentRole=inherited?nextRole:role,currentSession=`kadan-${currentRole}`;
    const reused={...start,t:'2026-09-28T00:02:00Z'};
    await assert.rejects(()=>runWatch({
      floor:{list:()=>[{session:currentSession,pid:inherited?2:1}],read:()=>cycle===0?screen():'working'},
      readEntries:()=>inherited?[start,dispatch,successor,transfer]:[start,dispatch,...(cycle?[reused]:[])],
      readCards:()=>[{...cards[0],role,status:'assigned',at:start.t,activity:'running',activityRole:role,activityAt:dispatch.t}],readWorks:()=>[],
      record:e=>records.push({...e,cycle}),sendAlert:(role,message)=>messages.push({role,message,cycle}),
      routes:new Map([['p','p-boss']]),superRole:'p-boss',intervalMs:60000,completionGraceMs:120000,stallN:100,
      now:()=>Date.parse('2026-09-28T00:04:00Z')+60000*cycle,print:()=>{},
      spawn:command=>{if(command==='sleep'&&++cycle===4)throw end;return {status:0,stdout:''};},
    }),error=>error===end);
    const alerts=records.filter(e=>e.alertKind==='완료후보'&&!e.resolved);
    assert.equal(alerts.length,1);assert.equal(alerts[0].role,currentRole);assert.equal(alerts[0].cycle,2);
    assert.equal(alerts[0].delivered,true);assert(messages.some(m=>m.role==='p-boss'&&m.cycle===2));
  }
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
