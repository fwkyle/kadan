import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {cardPurpose,buildCardFlows,renderRallyFlow} from '../src/dashboard-flow.mjs';
import {workspaceModel,filterWorkspaceRows,sortWorkspaceRows,renderWorkspaceDetail} from '../src/dashboard-workspace.mjs';

const card=(id,patch={})=>({key:'repo/'+id,id,repo:'repo',board:'판',title:id,body:'## Why\n고객이 사진으로 제품을 구분한다.\n## 범위\n비공개 긴 지시',rallyId:'photos',rallyTitle:'제품 사진',rallyRound:'1',rallyStep:'implementation',workType:'execution',status:'assigned',displayState:'running',role:'작업자',runs:[],history:[],...patch});
const flow=(cards,id)=>buildCardFlows(cards).get('repo/'+id);

test('라운드는 묶음 연결만 세고 본문의 r13과 전달 횟수로 만들지 않는다',()=>{
 const c=card('r13',{rallyId:'',body:'## Why\nr12와 r13 사진 배포\n',runs:Array.from({length:20},()=>({role:'작업자'}))});
 const f=flow([c],'r13');assert.equal(f.linked,false);assert.equal(f.label,'라운드 미기록');
 assert.match(renderRallyFlow(c,f),/몇 번째 주고받는 중인지는 아직 알 수 없습니다/);
});
test('구현만 끝났으면 검수 완료나 검수 중으로 표시하지 않는다',()=>{
 const c=card('work',{status:'done',displayState:'done'}),f=flow([c],'work');
 assert.equal(f.phase,'구현 완료 · 검수 미연결');assert.match(f.warnings.join(),/독립검수 카드/);assert.equal(f.group.done,false);
});
test('검수 실패 이후 수정 라운드와 이전 카드의 위치를 구분한다',()=>{
 const first=card('work1',{displayState:'done',status:'done'}),review=card('review1',{rallyStep:'review',displayState:'failed'});
 assert.match(flow([first,review],'review1').next,/검수 지적.*수정 라운드/);
 const closedReview={...review,status:'superseded',displayState:'superseded'},fix=card('fix2',{rallyRound:'2',rallyStep:'fix'}),review2=card('review2',{rallyRound:'2',rallyStep:'review',status:'ready',displayState:'ready'});
 const cards=[first,closedReview,fix,review2],f=flow(cards,'work1');
 assert.equal(f.label,'1라운드 · 구현');assert.equal(f.older,true);assert.equal(f.group.round,2);assert.equal(f.phase,'수정 · 작업 중');
 const html=renderRallyFlow(first,f);assert.match(html,/수정 · 작업 중/);assert.match(html,/독립검수 · 대체됨/);assert.match(html,/보고 있는 카드/);
 const detail=renderWorkspaceDetail(first,{center:{cards}});assert.match(detail,/보고 있는 카드는 1라운드 · 구현/);assert.match(detail,/연결 카드/);
});
test('이전 미완료와 중복 연결은 한 사람의 다음 차례로 단정하지 않는다',()=>{
 const one=card('one'),two=card('two',{rallyRound:'2',rallyStep:'fix'});
 assert.equal(flow([one,two],'two').phase,'흐름 확인 필요');assert.match(flow([one,two],'two').warnings.join(),/이전 라운드/);
 const duplicate=card('duplicate');assert.equal(flow([one,duplicate],'one').phase,'흐름 확인 필요');assert.match(flow([one,duplicate],'one').warnings.join(),/중복/);
});
test('과거 검수 실패는 남기되 다음 수정과 검수의 완료 기록을 가리지 않는다',()=>{
 const cards=[card('work1',{displayState:'done'}),card('review1',{rallyStep:'review',displayState:'failed'}),card('fix2',{rallyRound:'2',rallyStep:'fix',displayState:'done'}),card('review2',{rallyRound:'2',rallyStep:'review',displayState:'done'})];
 const f=flow(cards,'work1');assert.equal(f.phase,'구현·검수 완료 기록');assert.equal(f.older,true);assert.equal(cards[1].displayState,'failed');
 assert.match(renderRallyFlow(cards[0],f),/독립검수 · 실패 기록 있음/);
});
test('동시 진행, 보류, 완료와 관련 조사는 각각의 기록을 따른다',()=>{
 const work=card('work'),review=card('review',{rallyStep:'review',role:'검수자'});
 assert.equal(flow([work,review],'work').phase,'구현·검수 병행');assert.equal(flow([work,review],'work').actors.length,2);
 assert.equal(flow([{...work,displayState:'hold'}],'work').phase,'구현 · 보류');
 const done=[work,review].map(c=>({...c,status:'done',displayState:'done'}));assert.equal(flow(done,'work').phase,'구현·검수 완료 기록');
 const research=card('research',{rallyStep:'research',rallyRound:'15',displayState:'running'}),f=flow([...done,research],'research');
 assert.equal(f.label,'관련 조사');assert.equal(f.group.round,1);assert.equal(f.group.done,false);
 const manager=card('manager',{workType:'coordination',rallyRound:'20'});assert.equal(flow([...done,manager],'manager').linked,false);assert.equal(flow([...done,manager],'work').group.round,1);
});
test('저장소와 판이 다른 같은 이름 묶음은 연결하지 않는다',()=>{
 const c=card('work'),others=[card('elsewhere',{key:'other/review',repo:'other',rallyStep:'review'}),card('board',{board:'다른 판',rallyStep:'review'})];
 const f=flow([c,...others],'work');assert.equal(f.group.cards.length,1);assert.match(f.warnings.join(),/연결되지 않았/);
});
test('작성한 감독을 현재 차례로 추정하지 않고 실제 차례 지정 근거를 표시한다',()=>{
 const at='2020-01-01T01:00:00Z',h={revision:2,at,by:'감독',status:'assigned',role:'작업자',noteKind:'decision',note:'준비 수신',turnOwner:'검수자',turnAt:at,turnBy:'감독',turnRevision:2};
 const c=card('work',{...h,history:[h]}),rows=workspaceModel({cards:[c]});
 assert.equal(rows[0].turnLabel,'검수자');assert.equal(rows[0].owner,'작업자');
 const html=renderWorkspaceDetail(c,{center:{cards:[c]}});assert.match(html,/현재 차례<\/dt><dd class="df-turn"><strong>검수자/);assert.match(html,/기록 감독/);
 const noOwner=card('unknown',{history:[{at,revision:2,noteKind:'decision',by:'감독',note:'준비 수신'}]});assert.equal(workspaceModel({cards:[noOwner]})[0].turnLabel,'차례 확인 필요');
});
test('목적은 여러 Why를 보존하고 본문 전체를 목록에 복사하지 않는다',()=>{
 const c=card('work',{body:'# 카드\n## Why\n첫 목적\n## 범위\n숨길 긴 원문\n```md\n## Why\n예시 목적\n```\n## Why\n추가 목적\n## 기타\n끝'});
 assert.equal(cardPurpose(c).text,'첫 목적 / 추가 목적: 추가 목적');assert.equal(cardPurpose(c,{goal:'기록된 목적'}).text,'기록된 목적');
 assert.equal(cardPurpose(card('none',{body:'제목 없는 긴 원문'})).text,'');
 const rows=workspaceModel({cards:[c]});assert.doesNotMatch(JSON.stringify(rows),/숨길 긴 원문|예시 목적/);assert.equal(filterWorkspaceRows(rows,{state:'all',q:'추가 목적'}).length,1);
 const two=card('two',{rallyRound:'2',rallyStep:'fix'}),many=workspaceModel({cards:[c,two]});assert.equal(filterWorkspaceRows(many,{state:'all',q:'2라운드 수정'}).length,1);assert.equal(filterWorkspaceRows(many,{state:'all',q:'2라운드'}).length,2);
 assert.deepEqual(sortWorkspaceRows(many,'flowLabel','desc').map(x=>x.id),['two','work']);
});
