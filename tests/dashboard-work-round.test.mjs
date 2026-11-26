import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {workRoundNow} from '../src/dashboard/work-round.mjs';
import {buildReviewFlows} from '../src/review-flow.mjs';
import {dashboardData} from '../src/dashboard-api.mjs';
import {cardCommand} from '../src/card-command.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {dashboardFixture} from './helpers/dashboard-fixture.mjs';

const card=(key,rallyId,round,step,extra={})=>({key:'demo/'+key,repo:'demo',board:'board',title:key,role:'worker',workType:'execution',
 rallyId,rallyTitle:rallyId,rallyRound:String(round),rallyStep:step,displayState:'running',history:[],runs:[],...extra});
const byCard=cards=>new Map(buildReviewFlows(cards).flatMap(flow=>flow.cardKeys.map(key=>[key,flow])));
const work=(keys,extra={})=>({status:'open',timing:{openedAt:'2026-01-01T00:00:00.000Z'},
 executions:keys.map(key=>({key:'demo/'+key})),...extra});

test('여러 flow면 가장 최근에 연결한 실행의 flow를 쓰고, flow 없는 실행은 건너뛴다',()=>{
 const map=byCard([
  card('a1','first',1,'implementation'),
  card('b1','second',1,'implementation',{displayState:'done'}),card('b2','second',2,'fix'),
 ]);
 const value=workRoundNow(work(['b1','b2','a1']),map);
 assert.deepEqual(value,{round:1,label:'구현 진행 중',openedAt:'2026-01-01T00:00:00.000Z'});
 assert.equal(Object.isFrozen(value),true);
 assert.equal(workRoundNow(work(['a1','b1','b2']),map).round,2,'연결 순서가 바뀌면 마지막에 연결한 쪽');
 assert.equal(workRoundNow(work(['a1','b2','no-rally']),map).round,2,'묶음 없는 최근 실행은 건너뛴다');
});

test('라운드 번호와 단계 문구는 상세 라운드 표의 flow 값 그대로다',()=>{
 const cards=[card('x','dup',1,'implementation'),card('y','dup',1,'fix')];
 const [flow]=buildReviewFlows(cards),value=workRoundNow(work(['x','y']),byCard(cards));
 assert.equal(value.round,flow.rounds.at(-1).number);
 assert.equal(value.label,flow.label);
 assert.equal(value.label,'연결 확인 필요');
});

test('실행 없음·flow 없음·조사만 있는 묶음·끝난 업무는 줄이 없다',()=>{
 const map=byCard([card('r','study',0,'research'),card('a1','first',1,'implementation')]);
 assert.equal(workRoundNow(work([]),map),null);
 assert.equal(workRoundNow(work(['no-rally']),map),null);
 assert.equal(workRoundNow(work(['r']),map),null,'0라운드를 만들지 않는다');
 assert.equal(workRoundNow(work(['a1','r']),map),null,'최근 실행의 flow에 라운드가 없으면 다른 flow로 넘어가지 않는다');
 for(const status of ['done','cancelled'])assert.equal(workRoundNow(work(['a1'],{status}),map),null);
 assert.equal(workRoundNow(work(['a1'],{status:'hold'}),map).round,1,'일시정지는 끝난 업무가 아니다');
 assert.equal(workRoundNow(work(['a1'],{timing:undefined}),map).openedAt,null);
});

test('workspace·status·?super= 응답의 업무 행에 상세와 같은 값이 실린다',()=>{
 const f=dashboardFixture({count:3});
 try{
  const get=route=>dashboardData(f.snapshot(),new URL('http://localhost/api/dashboard/'+route));
  const workRow=rows=>rows.find(row=>row.key==='work:demo/dashboard');
  const hierarchy=path.join(f.home,'hierarchy.json');
  fs.writeFileSync(hierarchy,JSON.stringify({'감독':'qa-슈퍼감독','qa-슈퍼감독':'@user'}));
  appendLedger({kind:'hierarchy-loaded',path:hierarchy,by:'watch',t:new Date().toISOString()},f.home);
  const routes=()=>({
   list:workRow(get('workspace?collection=work&state=all').rows),
   map:workRow(get('workspace?collection=work&state=all&layout=map').workRows),
   status:workRow(get('status').works),
   super:workRow(get('status?super=qa-'+encodeURIComponent('슈퍼감독')).works),
  });
  for(const [name,row] of Object.entries(routes())){
   assert.ok(row,name+' 업무 행');
   assert.equal('roundNow' in row,false,name+': 묶음 없는 업무는 칸이 없다');
  }
  const first=f.cards.get('demo/card-1');
  cardCommand(['update',first.key],{revision:first.revision,note:'묶음 연결','rally-id':'round-line','rally-title':'라운드 줄',
   board:'검증판','rally-round':'1','rally-step':'implementation'},{home:f.home,by:'사람'});
  const detail=get('detail?card=work:demo/dashboard'),[flow]=detail.reviewFlows;
  const openedAt=f.works.get('demo/dashboard').history.find(row=>row.action==='create').at;
  const expected={round:flow.rounds.at(-1).number,label:flow.label,openedAt};
  for(const [name,row] of Object.entries(routes()))assert.deepEqual(row.roundNow,expected,name);
  const executions=get('workspace?collection=executions&state=all').rows;
  assert.ok(executions.length&&executions.every(row=>!('roundNow' in row)),'실행 줄은 그대로다');
 }finally{f.server.close();}
});
