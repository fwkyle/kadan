import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {cardTurn} from '../src/card-turn.mjs';
import {CardStore} from '../src/card-store.mjs';
import {cardCommand} from '../src/card-command.mjs';
import {buildCardCenter} from '../src/card-center.mjs';
import {createWallServer} from '../src/wall.mjs';
import {workspaceModel,filterWorkspaceRows,sortWorkspaceRows,renderWorkspaceDetail,workspaceRowsHtml} from '../src/dashboard-workspace.mjs';

const at=n=>new Date(Date.UTC(2020,0,1,0,n)).toISOString();
function card(patch={}){
 const assigned={revision:1,status:'assigned',role:'worker',at:at(0),by:'supervisor'};
 const report={...assigned,revision:2,at:at(2),by:'worker',noteKind:'progress',activity:'running',activityRole:'worker',activityAt:at(2),note:'구현 중'};
 return {key:'repo/card-a',id:'card-a',repo:'repo',title:'카드',...report,displayState:'running',history:[assigned,report],runs:[{role:'worker',by:'sender',sentAt:at(1),at:at(1),state:'unconfirmed',sessionState:'alive'}],...patch};
}
function handoff(c,owner='reviewer',minute=3){
 const note={...c,history:undefined,runs:undefined,revision:c.revision+1,at:at(minute),noteKind:'decision',note:'이어서 확인해주세요',by:'supervisor',turnOwner:owner,turnAt:at(minute),turnBy:'supervisor',turnRevision:c.revision+1};
 return {...c,...note,history:[...c.history,note],runs:c.runs};
}
function fixture(){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-card-turn-')),store=new CardStore(home);
 const first=store.create({repo:'repo',id:'card-a',repoPath:home,body:'# 카드',by:'supervisor'});
 const c=store.update(first.key,{status:'assigned',scope:'로컬',role:'worker',board:'board',rallyId:'r1',rallyTitle:'묶음',rallyRound:'1',rallyStep:'implementation'},{revision:first.revision,note:'배정'});
 return {home,store,c};
}

test('현재 차례는 현재 작업 보고나 지시의 받는 사람이며 메모 작성자로 바뀌지 않는다',()=>{
 const c=card();assert.equal(cardTurn(c).owner,'worker');assert.equal(cardTurn(c).source,'진행 보고');
 c.history.push({...c.history.at(-1),revision:3,at:at(4),noteKind:'decision',by:'supervisor',note:'준비수신'});
 assert.equal(cardTurn(c).owner,'worker');assert.equal(cardTurn(c).at,at(2));
 const sent=card({activity:null,activityAt:null,displayState:'unconfirmed',history:[]});
 assert.equal(cardTurn(sent).owner,'worker');assert.equal(cardTurn(sent).by,'sender');
});
test('명시 차례 기록은 실행 담당과 분리되며 질문·답변에서도 지정할 수 있다',()=>{
 const c=handoff(card());assert.equal(cardTurn(c).owner,'reviewer');assert.equal(c.role,'worker');
 c.history.push({...c.history.at(-1),revision:4,at:at(4),by:'worker',noteKind:'decision'});
 assert.equal(cardTurn(c).owner,'reviewer');assert.equal(cardTurn(c).at,at(3));
 const q=card();q.history.push({...q.history.at(-1),revision:3,at:at(3),noteKind:'question',by:'worker'});
 assert.equal(cardTurn(q).owner,null);assert.match(cardTurn(q).reason,/답변/);
 assert.equal(cardTurn(handoff({...q,revision:3},'supervisor',4)).owner,'supervisor');
 const answered={...c,history:[...c.history,{...c.history.at(-1),revision:5,at:at(5),noteKind:'answer'}]};
 assert.equal(cardTurn(answered).owner,null);
 assert.equal(cardTurn({...answered,displayState:'unconfirmed',runs:[{...c.runs[0],at:at(6),sentAt:at(6)}]}).owner,'worker');
});
test('대기·완료·실패·보류 기록만으로 감독이나 다른 작업자를 현재 차례로 추측하지 않는다',()=>{
 const waiting=card({activity:'waiting',displayState:'waiting'});
 assert.equal(cardTurn(waiting).owner,null);assert.match(cardTurn(waiting).reason,/대기/);
 assert.equal(cardTurn(handoff(waiting,'photo-worker')).owner,'photo-worker');
 for(const state of ['done','failed']){
  const c=card({displayState:state,runs:[{role:'worker',by:'supervisor',sentAt:at(1),at:at(3),state}]});
  assert.equal(cardTurn(c).owner,null);assert.match(cardTurn(c).reason,/이어받을/);
  assert.equal(cardTurn(handoff(c,'supervisor',4)).owner,'supervisor');
 }
 assert.equal(cardTurn(card({status:'hold',displayState:'hold',resolutionOwner:'supervisor'})).owner,null);
 assert.equal(cardTurn(handoff(card({status:'done',displayState:'done'}))).label,'종료');
});
test('새 전달·활동 전환·질문·재배정·완료 뒤에는 오래된 차례를 유지하지 않는다',()=>{
 const c=handoff(card());
 const resent={...c,displayState:'unconfirmed',runs:[{...c.runs[0],sentAt:at(4),at:at(4)}]};
 assert.equal(cardTurn(resent).owner,'worker');assert.equal(cardTurn(resent).source,'지시 전달');
 assert.notEqual(cardTurn({...c,activityAt:at(4)}).owner,'reviewer');
 const question={...c,history:[...c.history,{...c.history.at(-1),revision:4,at:at(4),noteKind:'question'}]};
 assert.equal(cardTurn(question).owner,null);
 assert.equal(cardTurn({...c,role:'successor'}).owner,null);
 assert.equal(cardTurn({...c,displayState:'done',runs:[{...c.runs[0],state:'done',at:at(4)}]}).owner,null);
});
test('동명이인 카드·동시 전달·세션 이상·잘못된 시각을 한 사람의 차례로 표시하지 않는다',()=>{
 const c=card();
 for(const patch of [{ambiguous:true},{runs:[...c.runs,{...c.runs[0],role:'other'}]},{runs:[{...c.runs[0],sessionState:'unknown'}]},{runs:[{...c.runs[0],state:'orphaned'}]},{runs:[{...c.runs[0],at:'bad'}]},{activityAt:'bad'},{activityAt:'2099-01-01'}])assert.equal(cardTurn({...c,...patch}).owner,null);
 assert.equal(cardTurn({...c,history:[...c.history,{...c.history.at(-1),at:'bad'}]}).owner,null);
});
test('차례 변경은 뒤에 추가하고 메모에서는 유지하며 재배정·활동 보고에서 다시 정한다',()=>{
 const {store,c}=fixture();
 let x=store.update(c.key,{turnOwner:'reviewer'},{revision:c.revision,by:'worker',note:'검수 부탁'});
 const before=JSON.stringify(x.history);
 assert.equal(x.role,'worker');assert.equal(x.turnOwner,'reviewer');assert.equal(x.turnBy,'worker');assert.equal(x.turnAt,x.at);
 x=store.update(c.key,{}, {revision:x.revision,by:'supervisor',note:'상황 확인'});
 assert.equal(JSON.stringify(x.history.slice(0,-1)),before);assert.equal(x.turnOwner,'reviewer');
 assert.throws(()=>store.update(c.key,{turnOwner:'other'},{revision:c.revision,note:'오래된 저장'}),/변경됨/);
 assert.throws(()=>store.update(c.key,{turnOwner:'<script>'},{revision:x.revision,note:'잘못된 역할'}),/현재 차례/);
 x=store.update(c.key,{activity:'running'},{revision:x.revision,by:'worker',noteKind:'progress',note:'다시 시작'});
 assert.equal(x.turnOwner,null);
 x=store.update(c.key,{activity:'waiting',turnOwner:'photo-worker'},{revision:x.revision,by:'worker',noteKind:'progress',note:'사진 기다림'});
 assert.equal(x.turnOwner,'photo-worker');
 x=store.update(c.key,{role:'successor'},{revision:x.revision,note:'새 담당에게 배정'});assert.equal(x.turnOwner,null);
});
test('CLI note에서 현재 차례를 기록하고 빈 값으로 명시 기록을 해제할 수 있다',()=>{
 const {home,c}=fixture();
 const x=cardCommand(['note',c.key],{revision:c.revision,kind:'question',note:'감독 답변 요청','turn-owner':'supervisor'},{home,by:'worker'});
 assert.equal(x.turnOwner,'supervisor');assert.equal(cardTurn({...x,runs:[]}).owner,'supervisor');
 const cleared=cardCommand(['note',c.key],{revision:x.revision,note:'차례 미확정','turn-owner':''},{home,by:'supervisor'});
 assert.equal(cleared.turnOwner,null);
});
test('표·목록·상세에 현재 차례를 표시하고 차례 이름으로 검색·정렬한다',()=>{
 const c=handoff(card()),rows=workspaceModel({cards:[c,card({key:'repo/b'})]});
 assert.equal(rows[0].turnLabel,'reviewer');assert.equal(rows[0].owner,'worker');
 assert.equal(filterWorkspaceRows(rows,{state:'all',q:'reviewer'}).length,1);
 assert.equal(sortWorkspaceRows(rows,'turnLabel','asc')[0].turnLabel,'reviewer');
 for(const mode of ['table','split'])assert.match(workspaceRowsHtml(rows,mode,c.key),/reviewer/);
 const html=renderWorkspaceDetail(c);assert.match(html,/현재 차례<\/dt><dd class="df-turn"><strong>reviewer/);assert.doesNotMatch(html,/실행 담당 <strong>worker/);
 assert.match(html,/차례 지정/);assert.match(html,/현재 차례 → reviewer/);
 const unsafe=workspaceRowsHtml([{...rows[0],turnLabel:'<img onerror=x>',turnReason:'" onmouseover=x'}],'table','');assert.doesNotMatch(unsafe,/<img/);assert.match(unsafe,/&lt;img/);
});
test('웹 폼 차례 저장은 토큰·버전 검사를 유지하며 빈 입력으로 기존 차례를 지우지 않는다',async()=>{
 const {store,c,home}=fixture();
 const snapshot=()=>({center:buildCardCenter({cards:store.list(),entries:[],tree:[]}),tree:[],entries:[],ledgerLines:0,collectedAt:new Date().toISOString()});
 const server=createWallServer(snapshot,{home});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const base=`http://127.0.0.1:${server.address().port}`;
  const html=await(await fetch(base+'/?card='+encodeURIComponent(c.key))).text();
  assert.match(html,/name="turnOwner"/);
  const token=html.match(/name="token" value="([a-f0-9]+)"/)[1];
  const data={token,key:c.key,revision:c.revision,title:c.title,status:c.status,scope:c.scope,role:c.role,board:c.board,note:'검수 요청',turnOwner:'reviewer'};
  const post=fields=>fetch(base+'/cards/update',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:base},body:new URLSearchParams(fields),redirect:'manual'});
  assert.equal((await post({...data,token:'bad'})).status,403);assert.equal((await post(data)).status,303);assert.equal((await post(data)).status,409);
  let x=store.get(c.key);assert.equal(x.turnOwner,'reviewer');assert.equal(x.role,'worker');
  assert.equal((await post({...data,revision:x.revision,note:'상황 메모',turnOwner:''})).status,303);
  x=store.get(c.key);assert.equal(x.turnOwner,'reviewer');assert.equal(x.history.length,c.history.length+2);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
