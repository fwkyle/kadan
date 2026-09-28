import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildReviewFlows,readReviewResult} from '../src/review-flow.mjs';
import {dashboardFixture} from './helpers/dashboard-fixture.mjs';
import {dashboardData} from '../src/dashboard-api.mjs';
import {cardCommand} from '../src/card-command.mjs';

const at='2026-01-01T00:00:00Z';
const card=(key,round,step,outcome,extra={})=>({key:'demo/'+key,repo:'demo',board:'board',title:key,role:'worker',workType:'execution',rallyId:'photos',rallyTitle:'사진 여러 장',rallyRound:String(round),rallyStep:step,displayState:'done',history:[],runs:[],...(outcome?{result:{outcome,at,by:'reviewer'}}:{}),...extra});
const three=()=>[
 card('impl',1,'implementation','implemented'),card('review',1,'review','changes'),
 card('fix1',2,'fix','implemented'),card('review2',2,'review','changes'),
 card('fix2',3,'fix','implemented'),card('review3',3,'review','pass'),
];
test('세 차례 검수와 두 수정: 결과 판정으로 집계하고 메시지·진행 기록은 제외한다',()=>{
 const cards=three();cards[0].history=Array.from({length:20},()=>({noteKind:'progress',note:'시험 재실행'}));
 const flow=buildReviewFlows(cards)[0];
 assert.equal(flow.summary,'검수 3회 · 수정 2회 · 최종 검수 통과');
 assert.deepEqual(flow.rounds.map(r=>r.review[0].outcome),['changes','changes','pass']);
 assert.deepEqual(flow.warnings,[]);
 assert.equal(buildReviewFlows([...cards,card('research',0,'research','ok')])[0].reviewCount,3);
});
test('이름이 비슷하고 같은 상위 업무여도 다른 묶음은 추측해서 합치지 않는다',()=>{
 const cards=three().map((c,i)=>({...c,rallyId:'separate-'+i}));
 const flows=buildReviewFlows(cards);
 assert.equal(flows.length,6);
 assert.equal(flows.filter(f=>f.verdict==='pass').length,0);
 assert.ok(flows.find(f=>f.cardKeys.includes('demo/review3')).warnings.length);
});
test('검수 실행 ok와 완료 상태는 품질 pass가 아니다',()=>{
 const flow=buildReviewFlows([card('impl',1,'implementation','implemented'),card('review',1,'review','ok')])[0];
 assert.equal(flow.reviewCount,0);assert.equal(flow.label,'검수 판정 미기록');assert.notEqual(flow.verdict,'pass');
 const changes=buildReviewFlows(three().slice(0,2))[0];assert.equal(changes.label,'수정 필요');
});
test('이전 PASS 뒤 새 수정·발령·보관이 있으면 이전 결과를 최종 통과로 재사용하지 않는다',()=>{
 const cards=three();cards.push(card('new-fix',4,'fix',null,{displayState:'running'}));
 assert.equal(buildReviewFlows(cards)[0].label,'수정 진행 중');
 const stale=three();stale[5].runs=[{sentAt:'2026-01-02T00:00:00Z'}];
 const flow=buildReviewFlows(stale)[0];assert.equal(flow.reviewCount,3);assert.notEqual(flow.verdict,'pass');assert.equal(flow.pendingResults,1);
 stale[5]={...three()[5],displayState:'cancelled'};assert.notEqual(buildReviewFlows(stale)[0].verdict,'pass');
 stale[5]={...three()[5],scope:'추가 수정',history:[{scope:'기존 범위',role:'worker',result:three()[5].result}]};
 assert.notEqual(buildReviewFlows(stale)[0].verdict,'pass');
 const changedWork=three();changedWork[4].runs=[{sentAt:'2026-01-02T00:00:00Z'}];
 assert.equal(buildReviewFlows(changedWork)[0].label,'구현 변경 뒤 재검수 필요');
 const archived=three();archived[5].displayState='archived';assert.equal(buildReviewFlows(archived)[0].verdict,'pass');
});
test('중간 라운드 누락·같은 단계 중복·다른 저장소/판을 구분한다',()=>{
 const missing=buildReviewFlows(three().slice(2))[0];assert.equal(missing.verdict,'unconfirmed');
 const duplicate=buildReviewFlows([...three(),card('review-extra',3,'review','pass')])[0];assert.equal(duplicate.verdict,'unconfirmed');
 assert.equal(buildReviewFlows([...three(),card('other',1,'review','pass',{board:'other'})]).length,2);
 assert.equal(buildReviewFlows([...three(),card('other',1,'review','pass',{repo:'other'})]).length,2);
});

for(const mode of ['jsonl','sqlite'])test(`${mode}: 연결 이어받기 → API 왕복 표·목록 요약·등록 결과 원문`,()=>{
 const f=dashboardFixture({mode,count:6});
 const outcomes=['implemented','changes','implemented','changes','implemented','pass'];
 for(let i=1;i<=6;i++){
  let c=f.cards.get('demo/card-'+i);
  const round=String(Math.ceil(i/2)),step=i%2?(i===1?'implementation':'fix'):'review';
  c=cardCommand(['update',c.key],{revision:c.revision,note:'같은 작업의 다음 단계',...(i===1?{'rally-id':'photos','rally-title':'사진 여러 장',board:'board'}:{'rally-from':'demo/card-1'}),'rally-round':round,'rally-step':step},{home:f.home,by:'사람'});
  fs.writeFileSync(c.resultPath,'# 결과\n\n## 판정\n'+outcomes[i-1]+'\n\n<script>unsafe()</script>');
  f.cards.report(c.key,{revision:c.revision,outcome:outcomes[i-1]});
 }
 const query=route=>dashboardData(f.snapshot(),new URL('http://localhost/api/dashboard/'+route));
 const detail=query('detail?card=demo/card-1');
 assert.equal(detail.reviewFlow.summary,'검수 3회 · 수정 2회 · 최종 검수 통과');
 assert.equal(detail.related.length,6);
 const review=query('detail?card=demo/card-6');assert.deepEqual(review.reviewFlow,detail.reviewFlow);
 assert.match(query('workspace?collection=executions&state=all').rows[0].reviewLabel,/검수 3회/);
 assert.equal(query('workspace?collection=executions&state=all&q='+encodeURIComponent('검수 3회')).total,6);
 assert.equal(query('detail?card=work:demo/dashboard').reviewFlows.length,1);
 const result=query('review-result?card=demo/card-6');assert.match(result.body,/pass/);assert.doesNotMatch(result.html,/<script>/);assert.equal(result.outcome,'pass');
 fs.appendFileSync(f.cards.get('demo/card-6').resultPath,'\n바뀐 파일');
 assert.match(query('review-result?card=demo/card-6').error,/등록 뒤 결과 파일이 바뀌/);
 assert.equal(query('review-result?card=demo/card-6').html,null);
 assert.equal(f.delivered.length,0,'조회·연결 변경은 발령이나 알림을 보내지 않는다');
 const before=f.cards.get('demo/card-6');
 assert.throws(()=>cardCommand(['update',before.key],{revision:before.revision-1,note:'stale','rally-from':'demo/card-1','rally-round':'3','rally-step':'review'},{home:f.home,by:'사람'}),/카드가 변경됨/);
 assert.deepEqual(f.cards.get(before.key).history,before.history);
 assert.throws(()=>cardCommand(['update',before.key],{revision:before.revision,note:'누락','rally-from':'demo/card-1'},{home:f.home,by:'사람'}),/이번 --rally-round/);
 assert.throws(()=>cardCommand(['update',before.key],{revision:before.revision,note:'판 혼합',board:'other','rally-from':'demo/card-1','rally-round':'3','rally-step':'review'},{home:f.home,by:'사람'}),/같은 저장소·판/);
 assert.equal(f.cards.get(before.key).result.sha256,before.result.sha256,'메타데이터 수정은 검수 원본을 바꾸지 않는다');
});
test('결과 누락은 원문 없이 원인을 표시한다',()=>{
 assert.match(readReviewResult({}).error,/등록된 결과/);
 assert.match(readReviewResult({result:{path:'/nonexistent/kadan-result'}}).error,/읽을 수 없습니다/);
});
