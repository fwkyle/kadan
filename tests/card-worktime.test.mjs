import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildLaunchIndex,modelAt,cardWorktime,buildCardWorktimes,summarizeWorktimes,periodStart} from '../src/card-worktime.mjs';
import {dashboardData} from '../src/dashboard-api.mjs';
import {dashboardFixture} from './helpers/dashboard-fixture.mjs';

const MIN=60_000;
const T0=Date.parse('2026-09-29T00:00:00.000Z');
const at=minutes=>new Date(T0+minutes*MIN).toISOString();
const opus='claude --model claude-opus-5-5 --effort high --dangerously-skip-permissions';
const sonnet='claude --model claude-sonnet-5-5 --effort xhigh --dangerously-skip-permissions';
const codex='codex -p lite --model "gpt-6-sol" -c model_reasoning_effort="high"';
const launch=(role,minutes,cmd,extra={})=>{
  const [harness]=cmd.split(' ');
  return {kind:'start',role,t:at(minutes),cmd,harness,model:cmd.match(/--model[= ]"?([^\s"]+)/)[1],panePid:'100',...extra};
};
const reuse=(role,minutes,extra={})=>({kind:'start',role,t:at(minutes),panePid:'100',...extra});
const stop=(role,minutes)=>({kind:'stop',role,t:at(minutes)});

// 카드: 배정 → 시작(activity=running) → 결과. 시각은 T0 기준 분.
function card({key='repo/card-a',role='worker-a',assigned=1,start=2,result=12,step='implementation',round='1',rally='r1',workType='execution',runs=[],extra={}}={}) {
  const history=[{status:'draft',at:at(0),revision:1}];
  if(assigned!=null)history.push({status:'assigned',role,at:at(assigned),revision:2});
  if(start!=null)history.push({status:'assigned',role,activity:'running',activityAt:at(start),activityRole:role,at:at(start),revision:3,noteKind:'progress',note:'시작: 작업'});
  return {key,id:key.split('/')[1],workType,role,history,rallyId:rally,rallyStep:step,rallyRound:round,
    ...(result!=null?{result:{at:at(result),by:role,outcome:'implemented'}}:{}),runs,...extra};
}
const index=entries=>buildLaunchIndex(entries);

test('시작이 있으면 시작→결과가 작업 시간, 배정→시작이 대기 시간이다',()=>{
  const idx=index([launch('worker-a',0,opus)]);
  const w=cardWorktime(card({assigned:1,start:3,result:15}),idx);
  assert.equal(w.basis,'start');
  assert.equal(w.workMs,12*MIN);
  assert.equal(w.waitMs,2*MIN);
});

test('시작 기록이 없으면 배정→결과로 계산하고 배정 기준이라고 표시한다',()=>{
  const idx=index([launch('worker-a',0,opus)]);
  const w=cardWorktime(card({assigned:1,start:null,result:11}),idx);
  assert.equal(w.basis,'assigned');
  assert.equal(w.workMs,10*MIN);
  assert.equal(w.waitMs,null);
});

test('메모의 "시작:" 문자열은 시작으로 세지 않고 구조화된 activity=running만 센다',()=>{
  const idx=index([launch('worker-a',0,opus)]);
  const c=card({assigned:1,start:null,result:11});
  c.history.push({status:'assigned',role:'worker-a',at:at(4),revision:3,noteKind:'progress',note:'시작: 메모만 있음'});
  assert.equal(cardWorktime(c,idx).basis,'assigned');
});

test('결과나 시작이 없거나 시간이 뒤집혀 있으면 값을 지어내지 않는다',()=>{
  const idx=index([launch('worker-a',0,opus)]);
  assert.equal(cardWorktime(card({result:null}),idx).workMs,null);
  assert.equal(cardWorktime(card({assigned:null,start:null,result:5}),idx).basis,null);
  assert.equal(cardWorktime(card({assigned:1,start:10,result:5}),idx).workMs,null,'결과가 시작보다 앞서면 빈칸');
});

test('결과는 카드당 한 번만 남으므로 마지막 결과 = 등록된 결과이고 재작업은 라운드로 센다',()=>{
  const idx=index([launch('worker-a',0,opus)]);
  assert.equal(cardWorktime(card({round:'1'}),idx).reworks,0);
  assert.equal(cardWorktime(card({round:'3'}),idx).reworks,2);
  assert.equal(cardWorktime(card({step:'research',round:'0'}),idx).reworks,null,'조사는 라운드가 없다');
  assert.equal(cardWorktime(card({rally:null,round:null}),idx).reworks,null,'묶음이 없으면 세지 않는다');
});

test('카드 종류는 rallyStep이고 2라운드 이상 구현 카드만 수정으로 나눈다',()=>{
  const idx=index([launch('worker-a',0,opus)]);
  assert.equal(cardWorktime(card({step:'implementation',round:'1'}),idx).kind,'implementation');
  assert.equal(cardWorktime(card({step:'implementation',round:'2'}),idx).kind,'fix');
  assert.equal(cardWorktime(card({step:'fix',round:'2'}),idx).kind,'fix');
  assert.equal(cardWorktime(card({step:'review',round:'2'}),idx).kind,'review');
  assert.equal(cardWorktime(card({step:'research',round:'0'}),idx).kind,'research');
});

test('마감 대기는 원장 완료 확정 시각 기준이고 확정이 없거나 다른 역할이면 빈칸이다',()=>{
  const idx=index([launch('worker-a',0,opus)]);
  const done=(role,minutes,state='done')=>({role,state,at:at(minutes),result:state==='done'?'ok':'failed'});
  assert.equal(cardWorktime(card({result:12,runs:[done('worker-a',20)]}),idx).closeMs,8*MIN);
  assert.equal(cardWorktime(card({result:12,runs:[done('worker-a',20,'failed')]}),idx).confirmResult,'failed');
  assert.equal(cardWorktime(card({result:12,runs:[]}),idx).closeMs,null);
  assert.equal(cardWorktime(card({result:12,runs:[done('other',20)]}),idx).closeMs,null);
  assert.equal(cardWorktime(card({result:12,runs:[{role:'worker-a',state:'unconfirmed',at:at(20)}]}),idx).closeMs,null);
  assert.equal(cardWorktime(card({result:12,runs:[done('worker-a',9)]}),idx).closeMs,null,'확정이 결과보다 앞서면 지어내지 않는다');
  // 카드 상태 done의 시각은 마감으로 쓰지 않는다
  const status=card({result:12,runs:[]});status.history.push({status:'done',at:at(500),revision:9});
  assert.equal(cardWorktime(status,idx).closeMs,null);
});

test('조율 카드는 계산 대상이 아니다',()=>{
  const idx=index([launch('worker-a',0,opus)]);
  const map=buildCardWorktimes([card({key:'repo/c1'}),card({key:'repo/c2',workType:'coordination'})],[launch('worker-a',0,opus)]);
  assert.deepEqual([...map.keys()],['repo/c1']);
  assert.equal(cardWorktime(card({workType:'coordination'}),idx),null);
});

test('끝난 세션도 창(start→stop) 안의 실행 명령 start로 모델을 붙인다: 같은 역할이 오퍼스→소넷으로 다시 떠도 카드마다 그때 모델이다',()=>{
  const entries=[launch('worker-a',0,opus),stop('worker-a',30),launch('worker-a',40,sonnet,{panePid:'200'}),stop('worker-a',90)];
  const idx=index(entries);
  const old=cardWorktime(card({assigned:1,start:2,result:20}),idx);
  const next=cardWorktime(card({key:'repo/card-b',assigned:41,start:42,result:60}),idx);
  assert.deepEqual([old.model.model,old.model.effort,old.model.alive],['claude-opus-5-5','high',false]);
  assert.deepEqual([next.model.model,next.model.effort,next.model.alive],['claude-sonnet-5-5','xhigh',false]);
});

test('살아 있는 세션을 다시 부른 cmd 없는 start는 새 창도 모델 근거도 아니다: 재사용 세션의 두 번째 카드도 원래 모델이다',()=>{
  const entries=[launch('worker-a',0,opus),reuse('worker-a',100)];
  const w=cardWorktime(card({assigned:101,start:102,result:120}),index(entries));
  assert.equal(w.model.state,'known');
  assert.equal(w.model.model,'claude-opus-5-5');
  assert.equal(w.model.alive,true);
});

test('cmd가 있는 start가 없거나 그 시각을 품는 창이 없으면 모름과 이유를 돌려준다',()=>{
  assert.deepEqual(modelAt(index([reuse('worker-a',0)]),'worker-a',T0+MIN),{state:'unknown',reason:'no-launch'});
  const closed=index([launch('worker-a',0,opus),stop('worker-a',10)]);
  assert.equal(modelAt(closed,'worker-a',T0+10*MIN).reason,'no-launch','stop 시각 이후는 창 밖');
  assert.equal(modelAt(closed,'worker-a',T0-MIN).reason,'no-launch','start 이전은 창 밖');
  assert.equal(modelAt(closed,'other-role',T0+MIN).reason,'no-launch');
  assert.equal(modelAt(closed,'worker-a',null).reason,'no-anchor');
  const noModel=index([{kind:'start',role:'worker-a',t:at(0),cmd:'bash',panePid:'1'}]);
  assert.equal(modelAt(noModel,'worker-a',T0+MIN).reason,'no-model');
});

test('창 안에서 다른 모델로 다시 시작(중간 stop 기록 없음)되면 어느 쪽인지 단정하지 않고 모름이다',()=>{
  const dead=index([launch('worker-a',0,opus),launch('worker-a',20,sonnet,{panePid:'200'}),stop('worker-a',60)]);
  assert.equal(modelAt(dead,'worker-a',T0+30*MIN).reason,'restarted');
  // 같은 모델·강도로의 재시작은 모호하지 않다
  const same=index([launch('worker-a',0,opus),launch('worker-a',20,opus,{panePid:'200'}),stop('worker-a',60)]);
  assert.equal(modelAt(same,'worker-a',T0+30*MIN).state,'known');
});

const omoOpus='omo --model claude-opus-5-5 --effort high';
const opusMax='claude --model claude-opus-5-5 --effort max --dangerously-skip-permissions';
const sonnetHigh='claude --model claude-sonnet-5-5 --effort high --dangerously-skip-permissions';

test('실행 도구 이름만 다르고 모델·강도가 같으면 재시작이 아니라 알려진 모델이다(card-p2-tag-audit 사례)',()=>{
  const entries=[launch('worker-a',0,omoOpus,{panePid:'100'}),launch('worker-a',10,opus,{panePid:'200'}),stop('worker-a',60)];
  const m=modelAt(index(entries),'worker-a',T0+15*MIN);
  assert.deepEqual([m.state,m.model,m.effort],['known','claude-opus-5-5','high']);
  // 아직 살아 있는 창도 같다(PID가 같은 두 기록: 실행 도구만 다름)
  const live=index([launch('worker-a',0,omoOpus),launch('worker-a',10,opus)]);
  assert.deepEqual([modelAt(live,'worker-a',T0+15*MIN).state,modelAt(live,'worker-a',T0+15*MIN).alive],['known',true]);
});

test('화면에 보일 실행 도구는 카드 첫 시작 직전에 띄운 실행 명령 기록의 것이다',()=>{
  const idx=index([launch('worker-a',0,omoOpus,{panePid:'100'}),launch('worker-a',10,opus,{panePid:'200'}),stop('worker-a',60)]);
  // 두 번째 실행 명령(claude, 10분)이 카드 시작(15분) 직전 → claude
  assert.equal(modelAt(idx,'worker-a',T0+15*MIN).harness,'claude');
  // 카드 시작(5분)이 두 번째 실행 명령보다 앞서면 그때 떠 있던 첫 기록(omo)
  const early=modelAt(idx,'worker-a',T0+5*MIN);
  assert.deepEqual([early.state,early.harness,early.launchAt],['known','omo',T0]);
  // 같은 시각이면 그 시각의 기록이 직전으로 잡힌다
  assert.equal(modelAt(idx,'worker-a',T0+10*MIN).harness,'claude');
  // 카드 계산 값에도 그대로 실린다
  const w=cardWorktime(card({assigned:11,start:15,result:30}),idx);
  assert.deepEqual([w.model.state,w.model.harness],['known','claude']);
});

test('같은 실행 도구여도 모델만 다르면 모름(restarted)이다',()=>{
  const idx=index([launch('worker-a',0,sonnetHigh,{panePid:'100'}),launch('worker-a',10,opus,{panePid:'200'}),stop('worker-a',60)]);
  assert.deepEqual(modelAt(idx,'worker-a',T0+15*MIN),{state:'unknown',reason:'restarted'});
});

test('같은 실행 도구·모델이어도 강도만 다르면 모름(restarted)이다',()=>{
  const idx=index([launch('worker-a',0,opus,{panePid:'100'}),launch('worker-a',10,opusMax,{panePid:'200'}),stop('worker-a',60)]);
  assert.deepEqual(modelAt(idx,'worker-a',T0+15*MIN),{state:'unknown',reason:'restarted'});
  // 실행 도구도 함께 다르면 당연히 모름이다
  const both=index([launch('worker-a',0,omoOpus,{panePid:'100'}),launch('worker-a',10,sonnetHigh,{panePid:'200'}),stop('worker-a',60)]);
  assert.equal(modelAt(both,'worker-a',T0+15*MIN).reason,'restarted');
});

test('아직 살아 있는 창은 지금 PID(가장 나중 실행 명령 기록의 PID)와 같은 start만 본다',()=>{
  const live=index([launch('worker-a',0,opus,{panePid:'100'}),launch('worker-a',20,sonnet,{panePid:'200'})]);
  const m=modelAt(live,'worker-a',T0+30*MIN);
  assert.deepEqual([m.state,m.model,m.alive],['known','claude-sonnet-5-5',true]);
});

test('실행기마다 다른 강도 표기와 인용부호를 읽는다(codex 겹따옴표 · claude --effort)',()=>{
  const idx=index([launch('rv',0,codex,{roleProfile:'reviewer'})]);
  const m=modelAt(idx,'rv',T0+MIN);
  assert.deepEqual([m.model,m.effort,m.harness],['gpt-6-sol','high','codex']);
});

test('작업자·검수자는 시작 기록의 roleProfile이 기준이고 없으면 카드 단계로 추론한다',()=>{
  const idx=index([launch('rv',0,codex,{roleProfile:'reviewer'}),launch('old',0,opus)]);
  const viaLaunch=cardWorktime(card({role:'rv',step:'implementation'}),idx);
  assert.deepEqual([viaLaunch.profile,viaLaunch.profileFrom],['reviewer','launch']);
  const viaStep=cardWorktime(card({role:'old',step:'review'}),idx);
  assert.deepEqual([viaStep.profile,viaStep.profileFrom],['reviewer','step']);
  assert.equal(cardWorktime(card({role:'old',step:'fix'}),idx).profile,'worker');
  assert.equal(cardWorktime(card({role:'none',step:'research',round:'0'}),idx).profile,'worker','모델을 몰라도 프로필은 단계로 정한다');
});

test('작업 역할은 running을 보고한 역할이고, 카드 담당이 바뀌어도 그 세션의 모델을 쓴다',()=>{
  const idx=index([launch('first',0,opus),launch('second',0,sonnet)]);
  const c=card({role:'first'});c.role='second';   // 나중에 담당이 바뀐 카드
  assert.equal(cardWorktime(c,idx).model.model,'claude-opus-5-5');
});

test('기간 필터는 결과 등록 시각 기준이고 오늘은 한국 시간 0시부터다',()=>{
  const now=Date.parse('2026-09-29T06:00:00.000Z');   // KST 15:00
  assert.equal(new Date(periodStart('today',now)).toISOString(),'2026-09-28T15:00:00.000Z');
  assert.equal(new Date(periodStart('7d',now)).toISOString(),'2026-09-22T06:00:00.000Z');
  assert.equal(periodStart('all',now),null);
  const w=(resultAt,workMs=MIN)=>({resultAt,workMs,profile:'worker',kind:'implementation',basis:'start',reworks:0,model:{state:'known',model:'m',effort:'high'}});
  const list=[w(Date.parse('2026-09-28T15:00:00.000Z')),w(Date.parse('2026-09-28T14:59:59.000Z')),w(Date.parse('2026-09-23T06:00:00.000Z'))];
  assert.equal(summarizeWorktimes(list,{period:'today',now}).count,1,'한국 시간 9/29 0시 이후만');
  assert.equal(summarizeWorktimes(list,{period:'7d',now}).count,3);
  assert.equal(summarizeWorktimes(list,{period:'all',now}).count,3);
});

test('요약은 역할 프로필 × 모델(강도) × 종류로 건수·중간값·평균을 묶고 모름은 따로 세며 섞지 않는다',()=>{
  const now=Date.parse('2026-09-29T06:00:00.000Z'),r=Date.parse('2026-09-29T05:00:00.000Z');
  const known=(model,effort)=>({state:'known',model,effort});
  const w=(profile,kind,workMs,model,extra={})=>({resultAt:r,workMs,profile,kind,basis:'start',reworks:0,model,...extra});
  const s=summarizeWorktimes([
    w('worker','implementation',10*MIN,known('opus','high')),
    w('worker','implementation',30*MIN,known('opus','high')),
    w('worker','implementation',20*MIN,known('opus','high')),
    w('worker','fix',6*MIN,known('opus','high'),{reworks:1}),
    w('worker','research',4*MIN,known('sonnet','xhigh')),
    w('worker','research',8*MIN,known('sonnet','xhigh'),{basis:'assigned'}),
    w('reviewer','review',12*MIN,known('gpt','high')),
    w('worker','implementation',5*MIN,{state:'unknown',reason:'no-launch'}),
    {resultAt:r,workMs:null,profile:'worker',kind:'implementation',model:known('opus','high')},
    null,
  ],{period:'today',now});
  const pick=(profile,model,step)=>s.rows.find(x=>x.profile===profile&&x.model===model&&x.step===step);
  assert.equal(s.count,8);
  assert.equal(s.noDuration,1);
  assert.deepEqual(s.unknownReasons,{'no-launch':1});
  assert.deepEqual(s.rows.map(x=>`${x.profile}/${x.model}/${x.step}`),[
    'worker/opus/all','worker/opus/implementation','worker/opus/fix',
    'worker/sonnet/all','worker/sonnet/research',
    'worker/null/all','worker/null/implementation',
    'reviewer/gpt/all','reviewer/gpt/review',
  ]);
  assert.deepEqual(s.rows.map(x=>x.profile),['worker','worker','worker','worker','worker','worker','worker','reviewer','reviewer'],'작업자가 먼저, 검수자는 섞이지 않는다');
  assert.deepEqual(s.rows.filter(x=>x.step==='all').map(x=>x.model),['opus','sonnet',null,'gpt'],'모름 묶음은 작업자 안에서 맨 뒤');
  assert.deepEqual([pick('worker','opus','implementation').count,pick('worker','opus','implementation').medianMs,pick('worker','opus','implementation').meanMs],[3,20*MIN,20*MIN]);
  assert.equal(pick('worker','opus','all').count,4);
  assert.equal(pick('worker','opus','fix').reworkCards,1);
  assert.equal(pick('worker','sonnet','research').medianMs,6*MIN,'짝수 건은 가운데 두 값의 평균');
  assert.equal(pick('worker','sonnet','research').assignedBasis,1,'배정 기준으로 계산한 건수를 밝힌다');
  assert.equal(pick('worker',null,'all').count,1);
});

test('대시보드: 카드 행에 작업 시간·모델(강도)이 실리고 끝난 카드도 모델을 말한다',()=>{
  const f=dashboardFixture({count:2}),snapshot=f.snapshot();
  const [a,b]=snapshot.center.cards;
  Object.assign(a,card({key:a.key,role:'worker-a',assigned:1,start:2,result:32,round:'2',extra:{rallyTitle:'검증 묶음',board:'검증판'}}),{displayState:'done',runs:[{role:'worker-a',state:'done',result:'ok',at:at(40)}]});
  a.status='done';
  snapshot.entries=[launch('worker-a',0,opus,{roleProfile:'worker'}),...snapshot.entries];
  const rows=dashboardData(snapshot,new URL('http://local/api/dashboard/workspace?collection=executions&state=all')).rows;
  const row=rows.find(r=>r.key===a.key);
  assert.deepEqual([row.model,row.effort,row.modelState,row.profile],['claude-opus-5-5','high','known','worker']);
  assert.deepEqual([row.workMs,row.waitMs,row.closeMs,row.reworks,row.workBasis],[30*MIN,1*MIN,8*MIN,1,'start']);
  assert.match(row.modelTitle,/claude-opus-5-5/);
  const other=rows.find(r=>r.key===b.key);
  assert.equal(other.workMs,null,'아직 결과 없는 카드는 시간을 만들지 않는다');
});

test('대시보드: 시작·결과가 있는데 모델을 알 수 없는 카드는 모름과 이유를 보이고 시작 전 카드는 기존 값을 건드리지 않는다',()=>{
  const f=dashboardFixture({count:2}),snapshot=f.snapshot();
  const [a,b]=snapshot.center.cards;
  Object.assign(a,card({key:a.key,role:'ghost',assigned:1,start:2,result:12}));
  const before=dashboardData(snapshot,new URL('http://local/api/dashboard/workspace?collection=executions&state=all')).rows.find(r=>r.key===b.key);
  const row=dashboardData(snapshot,new URL('http://local/api/dashboard/workspace?collection=executions&state=all')).rows.find(r=>r.key===a.key);
  assert.deepEqual([row.model,row.modelState],['','unknown']);
  assert.match(row.modelTitle,/모델 모름/);
  assert.equal(before.modelState,null,'시작·결과가 없으면 판정하지 않는다');
});

test('대시보드 worktime 경로: 기간 검사·요약을 돌려주고 수집당 원장 색인은 한 번만 만든다',()=>{
  const f=dashboardFixture({count:2}),snapshot=f.snapshot();
  const [a]=snapshot.center.cards;
  const now=Date.now(),recent=new Date(now-60_000).toISOString();
  Object.assign(a,card({key:a.key,role:'worker-a',assigned:1,start:2,result:3}));
  a.history=a.history.map(h=>({...h,at:recent,...(h.activityAt?{activityAt:new Date(now-600_000).toISOString()}:{})}));
  a.result={at:recent,by:'worker-a',outcome:'implemented'};
  let visits=0;
  const entries=[launch('worker-a',0,opus,{t:new Date(now-3_600_000).toISOString()}),...snapshot.entries];
  snapshot.entries=new Proxy(entries,{get(target,key,receiver){if(key==='length')visits++;return Reflect.get(target,key,receiver);}});
  const read=route=>dashboardData(snapshot,new URL('http://local/api/dashboard/'+route));
  read('workspace?collection=executions&state=all');   // 카드 목록이 원장 색인을 만든다
  const built=visits;
  assert.ok(built>0);
  const today=read('worktime?period=today');
  assert.equal(today.period,'today');
  assert.equal(today.count,1);
  assert.equal(today.rows[0].model,'claude-opus-5-5');
  read('worktime?period=7d');read('worktime?period=all');read('worktime');
  assert.equal(visits,built,'같은 수집에서는 요청마다 원장을 다시 훑지 않는다');
  assert.throws(()=>read('worktime?period=year'),error=>error.status===400&&/today·7d·all/.test(error.message));
  assert.throws(()=>dashboardData({...snapshot,centerError:'카드 읽기 실패'},new URL('http://local/api/dashboard/worktime')),/카드 읽기 실패/);
});

test('대시보드: 작업 시간 열로 숫자 순서 정렬하고 시간이 없는 카드는 어느 방향이든 뒤에 둔다',()=>{
  const f=dashboardFixture({count:3}),snapshot=f.snapshot();
  const [a,b]=snapshot.center.cards;
  Object.assign(a,card({key:a.key,role:'worker-a',assigned:1,start:2,result:12,rally:null,round:null}));   // 10분
  Object.assign(b,card({key:b.key,role:'worker-a',assigned:1,start:2,result:122,rally:null,round:null}));  // 120분
  snapshot.entries=[launch('worker-a',0,opus),...snapshot.entries];
  const order=dir=>dashboardData(snapshot,new URL(`http://local/api/dashboard/workspace?collection=executions&state=all&sort=workMs&dir=${dir}`)).rows.map(r=>r.workMs);
  assert.deepEqual(order('asc'),[10*MIN,120*MIN,null],'문자열 순서였다면 120분이 10분보다 앞선다');
  assert.deepEqual(order('desc'),[120*MIN,10*MIN,null]);
});
