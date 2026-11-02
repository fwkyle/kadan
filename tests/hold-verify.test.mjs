import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {CardStore} from '../src/card-store.mjs';
import {cardCommand} from '../src/card-command.mjs';
import {runWatch} from '../src/watch-runner.mjs';
import {assessHoldWorking, holdOnlyRoles} from '../src/watch-hold-working.mjs';

// 가짜 바닥·가짜 시계만 쓴다. 실제 tmux·세션·알림은 건드리지 않는다. 역할 이름은 운영 이름이 아니다.
const rally={rallyId:'r1',rallyTitle:'묶음',rallyRound:'1',rallyStep:'implementation'};
const IDLE='작업을 마쳤습니다.\n❯ \n';
const clock=sec=>`${Math.floor(sec/60)}m ${String(sec%60).padStart(2,'0')}s`;
const WORKING=sec=>`✢ Grooving… (${clock(sec)} · ↓ 1.7k tokens)\n❯ \n`;

function assignedCard(role='hv-worker'){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-hold-verify-')),store=new CardStore(home);
 const c=store.create({repo:'repo',id:'card-a',repoPath:home,body:'# 카드\n\n## 읽고 시작할 것\n- /tmp/x\n',by:'감독'});
 const a=store.update(c.key,{status:'assigned',scope:'로컬',board:'b',role,...rally},{revision:c.revision,note:'배정',manual:true});
 return {home,store,card:a};
}
const fakeFloor=({alive=true,screen=IDLE,listThrows=false,readThrows=false}={})=>({
 list:()=>{if(listThrows)throw new Error('list 실패');return alive?[{session:'kadan-hv-worker',alive:true}]:[]},
 read:()=>{if(readThrows)throw new Error('read 실패');return screen},
});
const hold=(f,floor,over={})=>cardCommand(['update',f.card.key],{revision:f.card.revision,status:'hold',note:'잠시 멈춤',...over},{home:f.home,by:'감독',floor});

test('H1: hold로 바꿀 때 화면이 idle이면 `멈춤 확인`을 출력하고 메모에 남긴다',()=>{
 const f=assignedCard(),out=hold(f,fakeFloor({screen:IDLE}));
 assert.equal(out.status,'hold');
 assert.equal(out.holdCheck,'멈춤 확인');
 assert.match(out.note,/잠시 멈춤 · 화면 확인: 멈춤 확인$/);
 assert.equal(out.revision,f.card.revision+1,'확인 결과를 같은 변경에 담아 리비전이 한 번만 는다');
});
test('H2: 작업 중이면 `미확인(아직 작업 중)`이고 hold는 막지 않는다',()=>{
 const f=assignedCard(),out=hold(f,fakeFloor({screen:WORKING(75)}));
 assert.equal(out.status,'hold');
 assert.equal(out.holdCheck,'미확인(아직 작업 중)');
 assert.match(out.note,/화면 확인: 미확인\(아직 작업 중\)/);
});
test('H3: 세션이 없으면 `미확인(세션 없음)`',()=>{
 const f=assignedCard(),out=hold(f,fakeFloor({alive:false}));
 assert.equal(out.status,'hold');
 assert.equal(out.holdCheck,'미확인(세션 없음)');
});
test('H3b: 화면 읽기 실패·모르는 화면·목록 실패는 `미확인(화면 못 읽음)`이고 hold는 막지 않는다',()=>{
 for(const floor of [fakeFloor({readThrows:true}),fakeFloor({screen:'아무 표시 없는 화면'}),fakeFloor({listThrows:true})]){
  const f=assignedCard(),out=hold(f,floor);
  assert.equal(out.status,'hold');assert.equal(out.holdCheck,'미확인(화면 못 읽음)');
 }
});
test('H3c: floor가 없거나 hold가 아니거나 관리 카드면 화면을 읽지 않고 출력도 그대로다',()=>{
 let reads=0;
 const floor={list:()=>{reads++;return []},read:()=>{reads++;return IDLE}};
 const f=assignedCard();
 const noFloor=cardCommand(['update',f.card.key],{revision:f.card.revision,status:'hold',note:'floor 없음'},{home:f.home,by:'감독'});
 assert.equal('holdCheck' in noFloor,false);
 const g=assignedCard();
 const other=cardCommand(['update',g.card.key],{revision:g.card.revision,scope:'바뀐 범위',note:'범위만 변경'},{home:g.home,by:'감독',floor});
 assert.equal('holdCheck' in other,false);assert.equal(other.note,'범위만 변경');
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-hold-verify-')),store=new CardStore(home);
 const c=store.create({repo:'repo',id:'coord',repoPath:home,body:'# 조율',workType:'coordination',by:'감독'});
 const a=store.update(c.key,{status:'assigned',scope:'조율',board:'b',role:'hv-worker'},{revision:c.revision,note:'배정'});
 const coord=cardCommand(['update',a.key],{revision:a.revision,status:'hold',note:'조율 보류'},{home,by:'감독',floor});
 assert.equal('holdCheck' in coord,false);
 assert.equal(reads,0,'화면 읽기는 hold로 바꾸는 실행 카드에서만 한다');
});

// ---- 감시기: 일시정지 중 작업 감지 ----
const epoch=Date.parse('2026-09-09T00:00:00Z');
const stamp=minute=>new Date(epoch+minute*60_000).toISOString();
const parents=new Map([['hvw','hvboss'],['hvw2','hvboss'],['hvboss','hvtop'],['hvtop','@user']]);
const starts=['hvw','hvboss','hvtop'].map((role,i)=>({kind:'start',role,session:'kadan-'+role,panePid:i+1,t:stamp(0)}));
const holdCard=(holdAtMin,status='hold',role='hvw')=>({id:'c1',key:'r/c1',role,status,workType:'execution',at:stamp(holdAtMin),
 listFacts:{lastHoldEntry:status==='hold'?{at:stamp(holdAtMin)}:null}});

const startOf=(role,pid)=>({kind:'start',role,session:'kadan-'+role,panePid:pid,t:stamp(0)});
async function simulate({until=14,from=0,records=[...starts],roster=starts,cardsAt,screenAt,isHeld=()=>false}) {
 const alerts=[],controller=new AbortController();
 let minute=from;
 const holdTracker={beginCycle(){},endCycle(){},isHeld,alerts:()=>[],forced:()=>false,held(){},heldIfGuard(){},delivered(){}};
 await runWatch({signal:controller.signal,intervalMs:60_000,stallN:2,stallAfterMs:300_000,
  parents,routes:new Map(),superRole:'hvtop',judgeCmd:'fake',now:()=>epoch+minute*60_000,holdTracker,
  floor:{list:()=>roster.map(s=>({session:s.session,pid:s.panePid})),
   read:session=>session==='kadan-hvw'||session==='kadan-hvw2'?screenAt(minute,session):'정당한 대기'},
  readEntries:()=>records,readCards:()=>cardsAt(minute),readWorks:()=>[],readDecisions:()=>[],
  sendAlert:(recipient,message)=>{if(/일시정지했는데 계속 일하는 중/.test(message))alerts.push({minute,recipient,message});},
  record:e=>records.push({...e,t:stamp(minute)}),print:()=>{},spawn:()=>({status:0,stdout:''}),
  ai:{reports:{retire:()=>{}},run:()=>({ok:true})},
  sleep:async()=>{await setImmediate();if(++minute>=until)controller.abort();},
 });
 return {alerts,records};
}
const movingScreen=minute=>WORKING(minute*60+5);

test('H4: hold + 유예 뒤 2순회 움직이는 작업 화면 → 직속 상위에게 경보 1회, 5순회 계속돼도 1회',async()=>{
 const {alerts,records}=await simulate({until:14,cardsAt:()=>[holdCard(0)],screenAt:movingScreen});
 assert.equal(alerts.length,1);
 assert.equal(alerts[0].recipient,'hvboss');
 assert.equal(alerts[0].minute,4,'유예 3분 뒤 첫 순회가 한 번, 다음 순회가 두 번째');
 assert.match(alerts[0].message,/일시정지/);
 assert.equal(records.filter(r=>r.kind==='alert'&&r.alertKind==='일시정지중작업'&&!r.resolved).length,1,'원장에도 알림 한 줄');
 assert.equal(records.some(r=>r.kind==='alert'&&r.alertKind==='감시제외'&&r.role==='hvw'),false,'hold 역할 경보를 감시제외로 퇴역시키지 않는다');
});
test('H5: hold + 화면이 idle이면 0회',async()=>{
 const {alerts}=await simulate({cardsAt:()=>[holdCard(0)],screenAt:()=>IDLE});
 assert.equal(alerts.length,0);
});
test('H5b: hold + 시계가 멈춘 채 같은 일하는 줄이면 0회(얼어붙은 화면은 일하는 중이 아니다)',async()=>{
 const {alerts}=await simulate({cardsAt:()=>[holdCard(0)],screenAt:()=>WORKING(75)});
 assert.equal(alerts.length,0);
});
test('H6: hold + 사람 입력 보호(알림 보류) 중이면 0회',async()=>{
 const {alerts}=await simulate({cardsAt:()=>[holdCard(0)],screenAt:movingScreen,isHeld:role=>role==='hvw'});
 assert.equal(alerts.length,0);
});
test('H6b: hold로 바꾼 직후 유예 3분 안에는 보지 않는다',async()=>{
 const {alerts}=await simulate({until:5,cardsAt:minute=>[holdCard(minute)],screenAt:movingScreen});
 assert.equal(alerts.length,0,'매 순회 방금 hold가 된 카드라면 유예가 끝나지 않는다');
});
test('H7: hold → done이 되면 0회',async()=>{
 const {alerts}=await simulate({cardsAt:minute=>[minute>=3?holdCard(0,'done'):holdCard(0)],screenAt:movingScreen});
 assert.equal(alerts.length,0);
});
test('H8: hold → 열림(assigned) → 다시 hold + 작업 중이면 다시 1회, 그 사이엔 울리지 않는다',async()=>{
 // 0~5분 hold(4분에 울림) → 6~7분 assigned → 8분에 다시 hold, 유예 뒤 12·13분에 두 번째 경보.
 const cardsAt=minute=>[minute<6?holdCard(0):minute<8?holdCard(0,'assigned'):holdCard(8)];
 const {alerts}=await simulate({until:16,cardsAt,screenAt:movingScreen});
 assert.deepEqual(alerts.map(a=>a.minute),[4,12]);
});
test('H11(F1): 4분 첫 경보 → 같은 원장으로 7분에 감시기 재시작 → 해소 0, 두 번째 경보 0',async()=>{
 const records=[...starts];
 const first=await simulate({until:5,records,cardsAt:()=>[holdCard(0)],screenAt:movingScreen});
 assert.equal(first.alerts.length,1);
 const second=await simulate({from:7,until:12,records,cardsAt:()=>[holdCard(0)],screenAt:movingScreen});
 assert.equal(second.alerts.length,0,'재시작 뒤 같은 hold에 새 알림이 가지 않는다');
 const mine=records.filter(r=>r.kind==='alert'&&r.alertKind==='일시정지중작업');
 assert.equal(mine.filter(r=>r.resolved).length,0,'열린 경보가 해소되지 않는다');
 assert.equal(new Set(mine.map(r=>r.id)).size,1,'경보 id는 카드와 hold 진입 시각으로 같다');
 assert.match(mine[0].id,/^hold-working:r\/c1@hvw@/,'경보 id에 카드·배정 역할·hold 진입 시각이 들어간다');
});
test('H12(F2): 4분 첫 경보 → 7분 화면 읽기 1회 실패 → 8분 회복 → 해소 0, 두 번째 경보 0',async()=>{
 const screenAt=minute=>{if(minute===7)throw new Error('read 실패');return movingScreen(minute);};
 const {alerts,records}=await simulate({until:12,cardsAt:()=>[holdCard(0)],screenAt});
 assert.equal(alerts.length,1);
 assert.equal(records.filter(r=>r.kind==='alert'&&r.alertKind==='일시정지중작업'&&r.resolved).length,0);
});
test('H13: hold가 실제로 끝나면(저장 상태 done) 경보가 닫힌다',async()=>{
 const {alerts,records}=await simulate({until:10,cardsAt:minute=>[minute>=6?holdCard(0,'done'):holdCard(0)],screenAt:movingScreen});
 assert.equal(alerts.length,1);
 assert.equal(records.filter(r=>r.kind==='alert'&&r.alertKind==='일시정지중작업'&&r.resolved).length,1);
});
test('H9: 배정된(assigned) 카드가 하나라도 있는 역할은 감지 대상이 아니다',()=>{
 const other={...holdCard(0,'assigned'),id:'c2',key:'r/c2'};
 assert.equal(holdOnlyRoles([holdCard(0),other]).size,0);
 assert.equal(holdOnlyRoles([holdCard(0)]).size,1);
 assert.equal(holdOnlyRoles([{...holdCard(0),workType:'coordination'}]).size,0);
});
test('H10: 카드 이력(history)에서 hold로 들어간 시각을 읽고, 이후 메모(리비전)가 유예·1회 기준을 흔들지 않는다',()=>{
 const base={key:'r/c1',role:'hvw',workType:'execution',scope:'s',board:'b'};
 const history=[{...base,revision:1,status:'assigned',at:stamp(0)},{...base,revision:2,status:'hold',at:stamp(2)},{...base,revision:3,status:'hold',at:stamp(9)}];
 const card={...base,id:'c1',status:'hold',at:stamp(9),revision:3,history};
 const target=holdOnlyRoles([card]).get('hvw');
 assert.equal(target.holdAt,epoch+2*60_000,'hold로 들어간 시각이지 마지막 메모 시각이 아니다');
 const alerted=new Set();let states=new Map();const fired=[];
 for(const minute of [10,11,12,13]){
  const observations=new Map([['kadan-hvw',{role:'hvw',alive:true,screen:movingScreen(minute)}]]);
  const out=assessHoldWorking(states,observations,[card],{now:epoch+minute*60_000,alerted});
  states=out.states;fired.push(out.alerts.length);
 }
 assert.deepEqual(fired,[0,0,1,1],'처음 본 순회는 근거가 아니고, 두 번째·세 번째 순회에서 streak 2가 된다. 같은 id라 감시기가 한 번만 알린다');
 assert.equal(alerted.size,1);
});

// ---- F4: 배정 역할이 바뀌면 다른 hold다 ----
const alertsOf=records=>records.filter(r=>r.kind==='alert'&&r.alertKind==='일시정지중작업');
const roster2=[...starts,startOf('hvw2',9)];
test('H14(F4): 4분 첫 경보 → 7분에 같은 hold 진입 그대로 담당만 hvw2로 변경 → 옛 경보 해소 1, 새 역할은 유예 없이 처음부터 2순회 다시 센다',async()=>{
 const cardsAt=minute=>[holdCard(0,'hold',minute>=7?'hvw2':'hvw')];
 const {alerts,records}=await simulate({until:14,roster:roster2,records:[...roster2],cardsAt,screenAt:movingScreen});
 const mine=alertsOf(records);
 assert.equal(mine.filter(r=>r.resolved).length,1,'옛 역할의 경보가 닫힌다');
 assert.match(mine.find(r=>r.resolved).id,/^hold-working:r\/c1@hvw@/);
 const fresh=mine.filter(r=>!r.resolved&&/@hvw2@/.test(r.id));
 assert.equal(fresh.length,1,'새 역할 id로 새 경보가 한 번');
 assert.deepEqual(alerts.map(a=>a.minute),[4,9],'새 역할은 7분에 처음 보고(근거 아님) 8·9분 움직임 2번을 봐야 울린다');
});
test('H15(F4): 담당이 바뀐 상태로 감시기를 재시작해도 옛 역할의 경보는 첫 순회에 닫히고 이어 붙지 않는다',async()=>{
 const records=[...roster2];
 await simulate({until:5,roster:roster2,records,cardsAt:()=>[holdCard(0)],screenAt:movingScreen});
 const second=await simulate({from:7,until:8,roster:roster2,records,cardsAt:()=>[holdCard(0,'hold','hvw2')],screenAt:()=>IDLE});
 assert.equal(second.alerts.length,0,'새 역할 화면이 idle이면 경보가 없다');
 assert.equal(alertsOf(records).filter(r=>r.resolved).length,1,'옛 역할 경보가 닫힌다');
});
test('H16(F4): 역할 없는 옛 형식 id가 원장에 열려 있으면 이어 붙이지 않고, 그 hold를 처음 보는 것처럼 다시 센다',async()=>{
 const old={kind:'alert',alertKind:'일시정지중작업',id:'hold-working:r/c1@'+epoch,role:'hvw',level:'AMBER',t:stamp(4)};
 const records=[...starts,old];
 const {alerts,records:out}=await simulate({from:7,until:14,records,cardsAt:()=>[holdCard(0)],screenAt:movingScreen});
 assert.equal(out.filter(r=>r.resolved&&r.id===old.id).length,1,'옛 형식 경보는 닫힌다');
 assert.deepEqual(alerts.map(a=>a.minute),[9],'처음 보는 hold처럼 7분은 근거가 아니고 8·9분 2순회를 다시 센다');
});
test('H17(F4): holdOnlyRoles의 holdKey에 역할이 들어가고, 역할만 바뀐 같은 hold는 다른 키다',()=>{
 const a=holdOnlyRoles([holdCard(0)]).get('hvw').holdKey;
 const b=holdOnlyRoles([holdCard(0,'hold','hvw2')]).get('hvw2').holdKey;
 assert.equal(a,`r/c1@hvw@${epoch}`);
 assert.notEqual(a,b);
 const out=assessHoldWorking(new Map(),new Map([['kadan-hvw2',{role:'hvw2',alive:true,screen:IDLE}]]),
  [holdCard(0,'hold','hvw2')],{now:epoch+600_000,alerted:new Set([a])});
 assert.equal(out.alerts.length,0,'옛 역할의 열린 경보를 새 역할이 물려받지 않는다');
});
