import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CardStore} from '../src/card-store.mjs';
import {statusChanges,statusContext,renderStatusContext,renderStatusHistory} from '../src/card-status-context.mjs';
import {buildCardCenter} from '../src/card-center.mjs';
test('상태 이유는 일반 메모로 덮이지 않고 다음 전환에서 후속 담당을 초기화한다',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-state-')),store=new CardStore(home);
 let c=store.create({repo:'test',id:'a',repoPath:home,body:'# test'});
 c=store.update(c.key,{status:'hold',resolutionOwner:'감독',nextAction:'자료 인계 후 종료'},{revision:c.revision,note:'방향 변경'});
 const before=fs.readFileSync(path.join(store.dir(c.key),'events.jsonl'),'utf8');
 c=store.update(c.key,{}, {revision:c.revision,note:'무관한 질문',noteKind:'question'});
 assert.equal(statusContext(c).reason,'방향 변경');
 assert.equal(statusContext(c).nextAction,'자료 인계 후 종료');
 assert.ok(fs.readFileSync(path.join(store.dir(c.key),'events.jsonl'),'utf8').startsWith(before));
 assert.throws(()=>store.update(c.key,{status:'cancelled'},{revision:c.revision,note:' '}));
 c=store.update(c.key,{status:'cancelled'},{revision:c.revision,note:'새 카드로 인계 완료'});
 assert.equal(c.nextAction,null);assert.equal(c.resolutionOwner,null);
 assert.deepEqual(statusChanges(c).map(x=>x.to),['draft','hold','cancelled']);
 assert.match(renderStatusHistory(c),/일시정지 → 취소/);
});
test('일시정지 이유 누락은 감독 확인이며 실제 열린 결정만 사용자 답변 대상으로 표시한다',()=>{
 const c={key:'test/a',status:'hold',history:[]};
 assert.match(renderStatusContext(c),/일시정지 이유 미기록 · 감독 확인 필요/);
 assert.match(renderStatusContext(c),/요청된 사용자 결정 없음/);
 assert.match(renderStatusContext(c,{decisions:[{card:c.key,status:'open'}]}),/사용자 결정 필요/);
 assert.match(renderStatusContext(c,{decisionError:true}),/확인 불가/);
 assert.doesNotMatch(renderStatusContext({...c,nextAction:'<script>'}),/<script>/);
});
test('작업 중과 결과 대기는 실제 진행 보고만 이력에 남긴다',()=>{
 const c={history:[{revision:1,status:'assigned',at:'a',note:'발령'},{revision:2,status:'assigned',noteKind:'progress',activity:'running',activityAt:'b',at:'b',note:'시작'},{revision:3,status:'assigned',noteKind:'decision',activity:'running',activityAt:'b',at:'c',note:'메모'},{revision:4,status:'assigned',noteKind:'progress',activity:'waiting',activityAt:'d',at:'d',note:'검수 대기'}]};
 assert.deepEqual(statusChanges(c).map(x=>[x.from,x.to]),[[undefined,'assigned'],['assigned','running'],['running','waiting']]);
 assert.equal(statusContext(c).reason,'검수 대기');
});

const assignedAt='2026-09-07T00:00:00Z',sentAt='2026-09-07T00:01:00Z',activityAt='2026-09-07T00:02:00Z',failedAt='2026-09-07T00:03:00Z';
const assigned={key:'r/a',repo:'r',id:'a',title:'작업',status:'assigned',statusReason:'작업 배정',role:'worker',board:'p',revision:1,at:assignedAt,by:'boss',noteKind:'decision',note:'작업 배정'};
const source=()=>({...assigned,history:[{...assigned}]});
const send={kind:'send',role:'worker',taskId:'a',by:'dispatcher',t:sentAt};
const tree=[{roles:[{role:'worker',life:{state:'alive',pidState:'match'}}]}];

test('F2: 실행 실패 근거와 사람이 남긴 배정 이유는 출처·시각을 분리한다',()=>{
 const card=buildCardCenter({cards:[source()],entries:[send,{kind:'done',role:'worker',taskId:'a',result:'failed',by:'reviewer',t:failedAt}],tree}).cards[0];
 const context=statusContext(card);
 assert.equal(context.reason,'작업 배정');assert.equal(context.reasonEvidence.at,assignedAt);assert.equal(context.reasonEvidence.by,'boss');
 assert.equal(context.displayEvidence.source,'ledger');assert.equal(context.displayEvidence.at,failedAt);assert.match(context.displayEvidence.text,/실패/);
 // runs.by는 발령한 사람이다. 완료 확인자로 바꿔 표시하지 않는다.
 assert.equal(context.displayEvidence.by,null);
 const html=renderStatusContext(card);
 assert.match(html,/현재 표시 근거/);assert.match(html,/사람이 남긴 상태 이유/);assert.match(html,/작업 배정/);
 assert.ok(!html.includes('실패 원인: 작업 배정'));assert.ok(!renderStatusHistory(card).includes('실패'));
});

test('F2: 세션 없음의 조회 시각을 마지막 발령 시각으로 꾸미지 않는다',()=>{
 const card=buildCardCenter({cards:[source()],entries:[send],tree:[]}).cards[0];
 const context=statusContext(card);
 assert.equal(card.displayState,'orphaned');assert.equal(context.displayEvidence.source,'session');
 assert.equal(context.displayEvidence.at,null);assert.equal(context.displayEvidence.by,null);assert.match(context.displayEvidence.text,/세션/);
 assert.equal(context.reasonEvidence.at,assignedAt);assert.match(renderStatusContext(card),/조회 시각 미기록/);
});

test('F2: 작업 중 근거는 activityAt이며 이후 추가 보고와 일반 메모로 바뀌지 않는다',()=>{
 const progress={...assigned,revision:2,at:activityAt,by:'worker',noteKind:'progress',activity:'running',activityAt,activityRole:'worker',note:'실제 착수',statusReason:'실제 착수'};
 const later={...progress,revision:3,at:failedAt,note:'확인 항목 추가 보고'};
 const memo={...later,revision:4,at:'2026-09-07T00:04:00Z',by:'boss',noteKind:'question',note:'무관한 질문'};
 const card=buildCardCenter({cards:[{...memo,history:[assigned,progress,later,memo]}],entries:[send],tree,now:Date.parse('2026-09-07T00:05:00Z')}).cards[0];
 const context=statusContext(card);
 assert.equal(card.displayState,'running');assert.equal(context.displayEvidence.source,'progress');assert.equal(context.displayEvidence.at,activityAt);assert.equal(context.displayEvidence.by,'worker');
 assert.equal(context.reasonEvidence.at,activityAt);assert.equal(context.reasonEvidence.by,'worker');assert.equal(context.reason,'실제 착수');
 assert.deepEqual(statusChanges(card).map(h=>h.to),['assigned','running']);
});

test('F2: 상태 이유 보완의 시각은 무관한 메모 시각과 구분한다',()=>{
 const correction={...assigned,revision:2,at:activityAt,by:'supervisor',note:'설명 보완',statusReason:'범위 확인 후 배정'};
 const memo={...correction,revision:3,at:failedAt,by:'worker',noteKind:'question',note:'질문'};
 const c={...memo,displayState:'assigned',history:[assigned,correction,memo],runs:[]};
 assert.equal(statusContext(c).reasonEvidence.at,activityAt);assert.equal(statusContext(c).reasonEvidence.by,'supervisor');
 assert.equal(statusContext({...c,history:[]}).reasonEvidence.at,null);
});

test('F2: 공식 사용자 결정과 조회 실패, 이력 원문은 표시 보완 뒤에도 보존한다',()=>{
 const c={...source(),status:'hold',displayState:'hold',nextAction:'<script>금지</script>'};
 const before=JSON.stringify(c);
 assert.match(renderStatusContext(c,{decisions:[{card:'other/a',status:'open'}]}),/요청된 사용자 결정 없음/);
 assert.match(renderStatusContext(c,{decisions:[{card:c.key,status:'open'}]}),/사용자 결정 필요/);
 assert.match(renderStatusContext(c,{decisions:[{card:c.key,status:'open'}],decisionError:true}),/사용자 결정 요청 확인 불가/);
 assert.doesNotMatch(renderStatusContext(c),/<script>/);assert.equal(JSON.stringify(c),before);
});

test('F2: 결과 대기와 완료도 실행 근거를 구분하며 누락된 활동 보고를 만들어내지 않는다',()=>{
 const progress={...assigned,revision:2,at:activityAt,by:'worker',noteKind:'progress',activity:'waiting',activityAt,activityRole:'worker',note:'외부 결과 대기',statusReason:'외부 결과 대기'};
 const card=buildCardCenter({cards:[{...progress,history:[assigned,progress]}],entries:[send],tree,now:Date.parse(failedAt)}).cards[0];
 assert.equal(card.displayState,'waiting');assert.match(statusContext(card).displayEvidence.text,/결과 대기 보고/);assert.equal(statusContext(card).displayEvidence.at,activityAt);
 const missing=statusContext({...card,activityRole:'other',history:[assigned]});
 assert.equal(missing.displayEvidence.at,null);assert.match(missing.displayEvidence.text,/근거 확인 불가/);
 const done=buildCardCenter({cards:[source()],entries:[send,{kind:'done',role:'worker',taskId:'a',result:'ok',t:failedAt}],tree}).cards[0];
 assert.equal(statusContext(done).displayEvidence.source,'ledger');assert.equal(statusContext(done).displayEvidence.at,failedAt);assert.equal(statusContext(done).displayEvidence.by,null);
});
