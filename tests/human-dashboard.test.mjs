import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CardStore} from '../src/card-store.mjs';
import {BriefStore,Scribe,buildHumanBrief,progressLabel,currentProgressReport} from '../src/human-brief.mjs';
import {cardCommand} from '../src/card-command.mjs';
import {renderDashboardHome} from '../src/dashboard-home.mjs';
import {buildCardCenter} from '../src/card-center.mjs';
import {statusContext} from '../src/card-status-context.mjs';
const setup=()=>{const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-human-'));const store=new CardStore(home);const card=store.create({repo:'r',id:'card-a',repoPath:home,body:'# 原본',title:'card-a — 긴 제목'});return{home,store,card};};
test('서기 기록은 원본/원장을 바꾸지 않고 새 보고 후 오래된 진행 서술을 숨긴다',()=>{
 const {home,store,card}=setup(),before=fs.readFileSync(path.join(store.dir(card.key),'events.jsonl'),'utf8');
 const brief=cardCommand(['brief',card.key],{revision:1,title:'제품 분류',workstream:'제품 찾기',stage:'검수',summary:'근거를 검토했습니다'},{home,by:'서기'});
 assert.equal(fs.readFileSync(path.join(store.dir(card.key),'events.jsonl'),'utf8'),before);assert.ok(!fs.existsSync(path.join(home,'ledger.jsonl')));
 const scribe=new Scribe();const first=scribe.summarize({...card,displayState:'draft',runs:[]},brief);
 assert.equal(first.title,'제품 분류');assert.equal(first.summary,'근거를 검토했습니다');
 assert.strictEqual(scribe.summarize({...card,displayState:'draft',runs:[]},brief),first);
 const updated=store.update(card.key,{}, {revision:1,note:'새 보고',noteKind:'progress'});
 const next=scribe.summarize({...updated,displayState:'draft',runs:[]},brief);
 assert.equal(next.title,'제품 분류');assert.equal(next.summary,'');assert.equal(next.stale,true);
 assert.throws(()=>new BriefStore(home).write(card.key,{revision:1,title:'오래됨',workstream:'일'},'서기'),/변경됨/);
 const renamed=store.update(card.key,{title:'다른 작업'}, {revision:2,note:'변경'});
 assert.equal(scribe.summarize({...renamed,displayState:'draft',runs:[]},brief).title,'다른 작업');
 const absent=buildHumanBrief({cards:[{...renamed,displayState:'draft',runs:[]}]},home);assert.equal(absent.get(card.key).summary,'');
});
test('첫 화면은 현재 판의 남은 카드와 결정 요청을 분리하고 완료 판을 접는다',()=>{
 const cards=[{key:'r/a',id:'a',title:'현재 작업',status:'assigned',displayState:'running',board:'p',runs:[],history:[]},{key:'r/b',id:'b',title:'기록 확인',status:'assigned',displayState:'unconfirmed',board:'p',runs:[],history:[]},{key:'r/c',id:'c',title:'끝난 작업',status:'done',displayState:'done',board:'old',runs:[],history:[]}];
 const center={cards,boards:[{name:'p',state:'running',cards:cards.slice(0,2),runs:[]},{name:'old',state:'done',cards:[cards[2]],runs:[]}]};
 const html=renderDashboardHome({center,briefs:buildHumanBrief(center),decisions:[{id:'q1',status:'open',question:'<제품 공개?>',recommendation:'보류'}]});
 assert.match(html,/1개 판에 남은 실행 작업 2개/);assert.match(html,/남은 실행 작업 2개/);assert.match(html,/&lt;제품 공개\?&gt;/);assert.match(html,/href="#decision-q1"/);
 assert.match(html,/<details class="panel history-drawer">/);assert.ok(!html.includes('참여 역할 기록'));assert.match(html,/질문 복사/);assert.match(html,/제품 완성률/);
 const unknown=renderDashboardHome({center:null});assert.match(unknown,/확인할 수 없습니다/);assert.ok(!unknown.includes('0장'));
 const broken=renderDashboardHome({center,briefs:buildHumanBrief(center),decisionError:'broken'});assert.match(broken,/결정 기록을 읽지 못했습니다/);assert.ok(!broken.includes('사용자 결정은 없습니다'));
});
test('서기 파일 손상은 원본 상태를 유지하며 명시적으로 표시한다',()=>{
 const {home,card}=setup();fs.writeFileSync(path.join(new CardStore(home).dir(card.key),'briefs.jsonl'),'bad');
 const result=buildHumanBrief({cards:[{...card,displayState:'draft',runs:[]}]},home).get(card.key);
 assert.match(result.error,/읽을 수 없습니다/);assert.equal(result.status,'draft');
});
test('시작 미확인 카드의 과거 보고를 지금 하는 일에 끌어올리지 않는다',()=>{
 const c={key:'r/late',id:'late',title:'제품 연결',revision:2,body:'',status:'assigned',displayState:'unconfirmed',board:'p',runs:[],history:[{noteKind:'progress',at:'2026-09-07T00:00:00Z',note:'제품 연결 확인 중'}]};
 const center={cards:[c],boards:[{name:'p',state:'needs-check',cards:[c],runs:[]}]};
 const html=renderDashboardHome({center,briefs:buildHumanBrief(center)});
 assert.ok(!html.includes('마지막 작업 보고 · 현재 진행 여부는 확인 전'));const current=html.split('<div class="current-work">')[1].split('</div>')[0];assert.ok(!current.includes('href="?card='));assert.match(html,/작업 중 0개/);assert.match(html,/제품 연결/);assert.ok(!html.includes('작업 중 · 최근 보고 확인'));
});
test('발령 사실과 마지막 보고 경과 시간은 큐 여부와 분리하고 캐시되지 않는다',async()=>{
 const {progressLabel,queueLabel}=await import('../src/human-brief.mjs');
 const c={role:'worker',displayState:'unconfirmed',at:'2026-09-07T02:00:00Z',runs:[{role:'worker',sentAt:'2026-09-07T00:00:00Z'}],history:[{by:'worker',noteKind:'progress',at:'2026-09-07T00:10:00Z'}]};
 assert.equal(progressLabel(c,Date.parse('2026-09-07T00:42:00Z')),'발령됨 · 마지막 보고 32분 전');
 assert.equal(progressLabel(c,Date.parse('2026-09-07T00:43:00Z')),'발령됨 · 마지막 보고 33분 전');
 assert.equal(queueLabel(c),'순서 대기 여부: 기록 없음');assert.equal(queueLabel({displayState:'ready'}),'발령 후보 · 순서 미정');
 assert.equal(progressLabel({...c,history:[]}), '발령됨 · 진행 보고 없음');
 assert.equal(progressLabel({...c,runs:[{role:'worker',sentAt:'2026-09-07T01:00:00Z'}]}),'발령됨 · 재발령 후 보고 없음');
 assert.match(progressLabel(c,Date.parse('2026-09-07T00:05:00Z')),/시각 확인 필요/);
 assert.match(progressLabel({...c,history:[{by:'worker',noteKind:'progress',at:'invalid'}]}),/보고 시각 모름/);
});
test('작업 중과 결과 대기는 마지막 보고 시각을 함께 표시한다',async()=>{
 const {progressLabel}=await import('../src/human-brief.mjs');
 const card={role:'worker',activity:'running',displayState:'running',activityAt:'2026-09-07T00:00:00Z',activityRole:'worker',runs:[{role:'worker',sentAt:'2026-09-06T23:00:00Z'}],history:[]};
 assert.equal(progressLabel(card,Date.parse('2026-09-07T00:32:00Z')),'작업 중 · 마지막 보고 32분 전');
 assert.equal(progressLabel({...card,displayState:'waiting'},Date.parse('2026-09-08T00:00:00Z')),'결과 대기 · 마지막 보고 1일 전');
});
test('감독 조율은 막대와 남은 일에서 제외하지만 관리 기록은 보존하며 감독 독립 작업은 센다',async()=>{
 const {boardProgressCounts}=await import('../src/board-progress.mjs');
 const cards=[
  {key:'r/manage',title:'사진 검수 조율',role:'boss',workType:'coordination',displayState:'waiting',status:'assigned',board:'p',runs:[],history:[]},
  {key:'r/review',title:'사진 기능 검수',role:'reviewer',workType:'execution',displayState:'running',status:'assigned',board:'p',runs:[],history:[]},
  {key:'r/design',title:'정책 설계',role:'boss',workType:'execution',displayState:'running',status:'assigned',board:'p',runs:[],history:[]},
 ];
 const b={name:'p',state:'running',cards,runs:[]},center={cards,boards:[b],monitoring:{boards:[{name:'p',roles:[{role:'reviewer',parent:'boss'},{role:'boss',parent:'super'}]}]}};
 // 감시 UI는 이번 집계 시험 대상이 아니므로 별도 감시 스냅샷 없이 담당 관계만 검사한다.
 const briefs=buildHumanBrief(center);const snapshot={...center,monitoring:undefined};
 const html=renderDashboardHome({center:snapshot,briefs});assert.match(html,/남은 실행 작업 2개/);assert.match(html,/관리 기록 1장/);
 const current=html.slice(html.indexOf('class="current-work"'),html.indexOf('<h3>남은 실행'));
 assert.ok(!current.includes('사진 검수 조율'));assert.ok(current.includes('사진 기능 검수'));assert.ok(current.includes('정책 설계'));assert.match(current,/현재 담당: reviewer/);
 const {total,counts}=boardProgressCounts(b);assert.equal(total,2);assert.equal(counts.waiting,0);assert.equal(counts.running,2);
});
test('카드 종류 저장은 담당이나 실행 상태를 바꾸지 않고 잘못된 값은 거부한다',()=>{
 const {home,store,card}=setup();const updated=cardCommand(['update',card.key],{revision:card.revision,'work-type':'coordination',note:'감독 조율 기록 분리'},{home,by:'비서'});
 assert.equal(updated.workType,'coordination');assert.equal(updated.status,card.status);assert.equal(updated.role,card.role);
 assert.throws(()=>store.update(card.key,{workType:'manager'},{revision:updated.revision,note:'잘못된 종류'}),/카드 종류/);
});

const sentAt='2026-09-07T01:00:00Z',reportAt='2026-09-07T01:10:00Z',now=Date.parse('2026-09-07T02:00:00Z');
const reportingCard=patch=>({key:'r/report',id:'report',title:'진행 확인',body:'',revision:3,status:'assigned',displayState:'unconfirmed',role:'worker',board:'p',at:'2026-09-07T01:50:00Z',runs:[{role:'worker',sentAt,state:'unconfirmed',sessionState:'alive'}],history:[],...patch});
const report=(patch={})=>({noteKind:'progress',by:'worker',role:'worker',at:reportAt,note:'작업 근거',...patch});

test('F1: 보고가 없으면 카드 수정 시각을 마지막 보고로 쓰지 않는다',()=>{
 const c=reportingCard(),brief=new Scribe().summarize(c,null,now);
 assert.equal(brief.evidenceAt,null);assert.equal(brief.report,'');
 assert.equal(progressLabel(c,now),'발령됨 · 진행 보고 없음');
 const center={cards:[c],boards:[{name:'p',state:'needs-check',cards:[c],runs:[]}]};
 const html=renderDashboardHome({center,briefs:buildHumanBrief(center)});
 assert.match(html,/보고 없음/);assert.ok(!html.includes(new Date(c.at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false})));
});

test('F1: 재발령 이전과 다른 역할의 보고는 현재 보고에 섞이지 않는다',()=>{
 const cases=[
  {history:[report({at:'2026-09-07T00:10:00Z'})]},
  {history:[report({by:'other',role:'other'})]},
  {history:[report({by:'other',role:'worker'})]},
  {role:'successor',runs:[{role:'successor',sentAt,state:'unconfirmed'}],history:[report()]},
 ];
 for(const patch of cases){const c=reportingCard(patch),brief=new Scribe().summarize(c,null,now);assert.equal(brief.evidenceAt,null);assert.equal(brief.report,'');assert.match(progressLabel(c,now),/보고 없음/);}
 const c=reportingCard({history:[report(),report({by:'reviewer',role:'reviewer',at:'2026-09-07T01:30:00Z',note:'다른 역할의 검수'})],runs:[{role:'worker',sentAt},{role:'reviewer',sentAt:'2026-09-07T01:20:00Z'}]});
 assert.equal(new Scribe().summarize(c,null,now).evidenceAt,reportAt);assert.match(progressLabel(c,now),/마지막 보고 50분 전/);
});

test('F1: 잘못된 보고 시각과 발령 시각은 보고 없음으로 숨기지 않는다',()=>{
 for(const patch of [{history:[report({at:'invalid'})]},{history:[report({at:null})]},{history:[report({at:'2026-09-07T03:00:00Z'})]},{runs:[{role:'worker',sentAt:'invalid'}],history:[report()]}]){
  const c=reportingCard(patch),brief=new Scribe().summarize(c,null,now);
  assert.equal(brief.evidenceAt,null);assert.equal(brief.reportState,'unknown');assert.match(progressLabel(c,now),/시각 (모름|확인 필요)/);
 }
 const c=reportingCard({history:[report(),report({at:'invalid'})]});
 assert.equal(new Scribe().summarize(c,null,now).evidenceAt,null);
 assert.equal(new Scribe().summarize({...c,history:[report({at:'invalid'}),report()]},null,now).evidenceAt,reportAt);
});

test('F1: activityAt은 복사된 수정 시각이 아닌 현재 담당의 원래 활동 보고다',()=>{
 const c=reportingCard({activity:'running',displayState:'running',activityAt:reportAt,activityRole:'worker',history:[report({activity:'running',activityAt:reportAt,activityRole:'worker'}),{noteKind:'question',by:'boss',at:'2026-09-07T01:40:00Z',activity:'running',activityAt:reportAt,activityRole:'worker',note:'질문'}]});
 assert.equal(new Scribe().summarize(c,null,now).evidenceAt,reportAt);assert.match(progressLabel(c,now),/마지막 보고 50분 전/);
 const snapshot={...c,history:[]};
 assert.equal(new Scribe().summarize(snapshot,null,now).evidenceAt,reportAt);assert.equal(new Scribe().summarize(snapshot,null,now).report,'');
 for(const patch of [{activityRole:'other'},{activityAt:'2026-09-07T00:10:00Z'},{role:'other'},{runs:[]},{role:null}])assert.equal(new Scribe().summarize({...snapshot,...patch},null,now).evidenceAt,null);
 const updated={...c,history:[...c.history,report({at:'2026-09-07T01:30:00Z',activityAt:reportAt,note:'작업 추가 보고'})]};
 assert.equal(new Scribe().summarize(updated,null,now).evidenceAt,'2026-09-07T01:30:00Z');
});

test('F1: 같은 역할 재배정 이전 보고는 제외하고 새 배정 이후 보고를 인정한다',()=>{
 const c=reportingCard({history:[{status:'assigned',role:'worker',at:'2026-09-07T00:00:00Z'},report(),{status:'assigned',role:'other',at:'2026-09-07T01:20:00Z'},{status:'assigned',role:'worker',at:'2026-09-07T01:30:00Z'}]});
 assert.equal(new Scribe().summarize(c,null,now).evidenceAt,null);
 const sentAgain={...c,runs:[{role:'worker',sentAt:'2026-09-07T01:35:00Z'}],history:[...c.history,report({at:'2026-09-07T01:40:00Z'})]};
 assert.equal(new Scribe().summarize(sentAgain,null,now).evidenceAt,'2026-09-07T01:40:00Z');
 const reportedAfterAssignment={...c,history:[...c.history,report({at:'2026-09-07T01:40:00Z'})]};
 assert.equal(new Scribe().summarize(reportedAfterAssignment,null,now).evidenceAt,'2026-09-07T01:40:00Z');
});

test('F1: 원본 버전이 같아도 유효 담당·보고가 바뀌면 서기 캐시를 갱신한다',()=>{
 const scribe=new Scribe(),c=reportingCard({history:[report()]});
 const first=scribe.summarize(c,null,now);assert.strictEqual(scribe.summarize(c,null,now),first);
 assert.equal(scribe.summarize({...c,role:'other'},null,now).evidenceAt,null);
 assert.equal(scribe.summarize({...c,history:[]},null,now).evidenceAt,null);
 const future=reportingCard({history:[report({at:'2026-09-07T03:00:00Z'})]});
 assert.equal(scribe.summarize(future,null,now).evidenceAt,null);
 assert.equal(scribe.summarize(future,null,Date.parse('2026-09-07T04:00:00Z')).evidenceAt,'2026-09-07T03:00:00Z');
});

test('F1: 보고자가 없는 새 진행 보고는 보고 없음이 아니라 보고자 모름이다',()=>{
 for(const by of [undefined,null,'','모름']){
  const c=reportingCard({activity:'running',activityAt:'2026-09-07T00:10:00Z',activityRole:'worker',history:[report({at:'2026-09-07T00:10:00Z'}),report({by})]});
  assert.deepEqual(currentProgressReport(c,now),{state:'unknown',at:null,by:null,note:'',source:null,reason:'author-unknown'});
  const brief=new Scribe().summarize(c,null,now);assert.equal(brief.evidenceAt,null);assert.equal(brief.reportState,'unknown');
  assert.equal(progressLabel(c,now),'발령됨 · 보고자 모름');
  const center={cards:[c],boards:[{name:'p',state:'needs-check',cards:[c],runs:[]}]};
  assert.match(renderDashboardHome({center,briefs:buildHumanBrief(center)}),/보고자 모름/);
 }
 const old=reportingCard({history:[report({by:null,at:'2026-09-07T00:10:00Z'})]});
 assert.equal(currentProgressReport(old,now).state,'none');assert.match(progressLabel(old,now),/보고 없음/);
 assert.equal(currentProgressReport(reportingCard({history:[report({by:null,role:'other'})]}),now).state,'none');
});

test('F1: 첫 화면에서도 보고 없음과 보고 시각 모름을 구분한다',()=>{
 const c=reportingCard({history:[report({at:'invalid'})]});
 const center={cards:[c],boards:[{name:'p',state:'needs-check',cards:[c],runs:[]}]};
 assert.match(renderDashboardHome({center,briefs:buildHumanBrief(center)}),/보고 시각 모름/);
});

test('F1: 발령 후 중앙 이관·배정된 카드의 유효한 결과 대기 보고를 보존한다',()=>{
 const sent='2026-09-06T15:55:25.489Z',assignedAt='2026-09-06T16:45:12.011Z',reportedAt='2026-09-07T02:12:22.779Z';
 const now=Date.parse('2026-09-07T03:12:22.779Z');
 const assigned={status:'assigned',role:'worker',revision:1,at:assignedAt,noteKind:'decision',by:'boss',note:'중앙 이관'};
 const progress={...assigned,revision:2,at:reportedAt,noteKind:'progress',by:'worker',activity:'waiting',activityRole:'worker',activityAt:reportedAt,note:'결과 대기 보고'};
 const source=reportingCard({...progress,history:[assigned,progress]});
 const card=buildCardCenter({cards:[source],entries:[{kind:'send',role:'worker',taskId:source.id,t:sent}],tree:[{roles:[{role:'worker',life:{state:'alive',pidState:'match'}}]}],now}).cards[0];
 assert.equal(card.displayState,'waiting');assert.equal(currentProgressReport(card,now).at,reportedAt);
 assert.equal(new Scribe().summarize(card,null,now).evidenceAt,reportedAt);assert.equal(statusContext(card).displayEvidence.at,reportedAt);
 assert.equal(progressLabel(card,now),'결과 대기 · 마지막 보고 1시간 0분 전');
 const beforeAssignment={...card,activityAt:'2026-09-06T16:00:00Z',history:[assigned,report({at:'2026-09-06T16:00:00Z'})]};
 assert.equal(currentProgressReport(beforeAssignment,now).at,null);assert.equal(currentProgressReport(beforeAssignment,now).reason,'before-assignment');
 const atAssignment={...card,activityAt:assignedAt,history:[assigned,report({at:assignedAt})]};
 assert.equal(currentProgressReport(atAssignment,now).at,assignedAt);
 const beforeResend={...card,runs:[{role:'worker',sentAt:'2026-09-07T03:00:00Z'}]};
 assert.equal(currentProgressReport(beforeResend,now).at,null);assert.equal(currentProgressReport(beforeResend,now).reason,'before-dispatch');
});
