import test from 'node:test';
import assert from 'node:assert/strict';
// 가짜 시계 시뮬레이션: sleep이 분을 올리고 끝에서 중단한다(helpers/watch-runner는 sleep을 덮어써 쓰지 않는다).
import {runWatch} from '../src/watch-runner.mjs';

// 점검 보고서(2026-10-05) 시뮬레이션 2: devin 큐 배너 하나에 '입력큐'(결정식)·'큐대기'(5분)·'정체'(AI)가 따로 울리고,
// 보내지 않은 '입력큐'는 다음 주기에 사라져 1분 만에 '해소됨' 우편이 헛되이 나갔다. 명시 배너는 한 경보로만 다룬다.
const epoch=Date.parse('2026-09-09T00:00:00Z');
const stamp=m=>new Date(epoch+m*60_000).toISOString();
const parents=new Map([['p-작업자','p-감독'],['p-감독','@user']]);
const starts=[['p-작업자',1],['p-감독',2]].map(([role,pid])=>({kind:'start',role,session:'kadan-'+role,panePid:pid,t:stamp(0)}));
const card={id:'t1',key:'repo/t1',role:'p-작업자',board:'p',status:'assigned',activity:'running',workType:'execution'};
const BANNER='❭ Press Enter to send queued messages now';
const unsafeScreen=['이전 출력',BANNER,'Do you want to proceed? [Y/n]'].join('\n');
const codexScreen='작업 중\n• Messages to be submitted at end of turn\n  ↳ 감독이 보낸 지시\n\n› Ask Codex to do anything';

async function simulate({minutes,screen,cards=[card],entries:extra=[{kind:'send',role:'p-작업자',taskId:'t1',t:stamp(0)}],judge=false}){
  const records=[],sent=[],enters=[],aiCalls=[];let minute=0;const controller=new AbortController();
  const entries=[...starts,...extra];
  await runWatch({signal:controller.signal,intervalMs:60_000,stallN:2,stallAfterMs:300_000,parents,routes:new Map(),superRole:'p-감독',
    now:()=>epoch+minute*60_000,
    floor:{list:()=>starts.map(s=>({session:s.session,pid:s.panePid})),read:s=>s==='kadan-p-작업자'?screen(minute):'감독 화면',alive:()=>true},
    readEntries:()=>entries,readCards:()=>cards,readWorks:()=>[],
    sendQueueEnter:(role,pid)=>{enters.push([minute,role,pid]);return {keyDelivery:'sent'};},
    sendAlert:(role,msg)=>sent.push([minute,role,msg]),record:e=>{records.push({...e,minute});entries.push({...e,t:stamp(minute)});},
    ...(judge?{judgeCmd:'fake',ai:{reports:{retire:()=>{}},run:args=>{aiCalls.push([minute,args.source]);return {ok:true};}}}:{}),
    print:()=>{},spawn:()=>({status:0,stdout:''}),sleep:async()=>{if(++minute>=minutes)controller.abort();}});
  const alerts=records.filter(e=>e.kind==='alert');
  const kinds=alerts.filter(a=>!a.resolved).map(a=>a.alertKind);
  return {alerts,kinds,sent,enters,aiCalls};
}

test('승인 질문이 겹친 큐 배너는 입력큐 경보 하나만 열고, 큐대기·정체·AI 판정을 겹치지 않으며 배너가 사라질 때 한 번 해소한다',async()=>{
  const {alerts,sent,enters,aiCalls}=await simulate({minutes:12,judge:true,screen:m=>m<8?unsafeScreen:'이전 출력\n❭ Ask Devin to build features'});
  assert.deepEqual(enters,[],'승인 질문이 보이면 Enter를 보내지 않는다');
  const queue=alerts.filter(a=>a.alertKind==='입력큐');
  assert.equal(queue.filter(a=>!a.resolved).length,1,'입력큐 경보는 한 번');
  assert.deepEqual(queue.filter(a=>a.resolved).map(a=>a.minute),[8],'해소는 배너가 실제로 사라진 8분에 한 번');
  assert.ok(!alerts.some(a=>a.alertKind==='큐대기'),'같은 배너에 큐대기를 겹치지 않는다');
  assert.ok(!alerts.some(a=>a.alertKind==='정체'),'같은 배너에 정체를 겹치지 않는다');
  assert.ok(!aiCalls.some(([,source])=>source==='stall'),'원인이 분명한 화면에 정체 AI를 부르지 않는다');
  const queueMails=sent.filter(([,,m])=>m.includes('입력 큐 대기'));
  assert.deepEqual(queueMails.map(([m,r])=>[m,r]),[[0,'p-감독'],[8,'p-감독']]);
  assert.match(queueMails[0][2],/승인 질문이 함께 표시됨/);assert.match(queueMails[1][2],/해소됨/);
  // 시작 보고 누락은 다른 사실(착수 보고 없음)이라 그대로 울린다.
  assert.ok(alerts.some(a=>a.alertKind==='시작보고누락'));
});

test('Enter를 보낸 뒤 배너가 유지돼도 입력큐 경보 하나로 끝나고 큐대기·정체는 겹치지 않는다',async()=>{
  const safe=['이전 출력',BANNER,''].join('\n');
  const {kinds,enters,aiCalls}=await simulate({minutes:9,judge:true,screen:()=>safe});
  assert.equal(enters.length,1);
  assert.deepEqual(kinds.filter(k=>['입력큐','큐대기','정체'].includes(k)),['입력큐']);
  assert.ok(!aiCalls.some(([,source])=>source==='stall'));
});

test('카드 발령이 없어 감시 대상이 아닌 세션의 배너는 그대로 큐대기로 잡는다(2026-09-15 사각 유지)',async()=>{
  const {kinds,sent}=await simulate({minutes:8,cards:[],entries:[],screen:()=>unsafeScreen});
  assert.deepEqual(kinds,['큐대기']);
  assert.ok(sent.some(([m,r,msg])=>m===5&&r==='p-감독'&&msg.includes('큐에 쌓여 대기')));
});

test('codex 큐 블록은 명시 배너가 아니므로 큐대기가 그대로 5분에 울린다',async()=>{
  const {kinds,enters}=await simulate({minutes:8,screen:()=>codexScreen});
  assert.deepEqual(enters,[]);
  assert.ok(kinds.includes('큐대기'));assert.ok(!kinds.includes('입력큐'));
});
