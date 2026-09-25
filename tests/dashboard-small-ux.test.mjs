import test from 'node:test';
import assert from 'node:assert/strict';
import {renderDashboardWorkspace} from '../src/dashboard-workspace.mjs';
import {dashboardWorkspaceScript} from '../src/dashboard-workspace-client.mjs';
import {renderDashboardStatus} from '../src/dashboard-status.mjs';
import {renderActivity} from '../src/decision-wall.mjs';
import {mailboxAwaitingReply} from '../src/dashboard-home.mjs';

const at='2020-09-08T01:00:00Z';
const card=(id)=>({key:'repo/'+id,repo:'repo',id,title:'제목 '+id,body:'본문',status:'assigned',displayState:'unconfirmed',role:'작업자',board:'판-a',revision:1,at,runs:[{role:'작업자',state:'unconfirmed',sentAt:at}],history:[]});
const center=cards=>({cards,roles:[],boards:[],unregistered:[],runtimeKnown:true});
const view=query=>renderDashboardWorkspace({center:center([card('card-a'),card('card-b')]),briefs:null,centerError:null,url:new URL('http://localhost/'+query),detail:()=>'',works:[],workError:null,workDetail:()=>''});
const tableBody=html=>html.match(/<tbody id="dw-table-body">([\s\S]*?)<\/tbody>/)[1];

test('작은 UX: 고르지 않은 첫 줄을 표에서 선택된 것처럼 칠하지 않고, 연 카드만 칠한다',()=>{
 assert.doesNotMatch(tableBody(view('?state=all')),/class="selected"/);
 const opened=tableBody(view('?state=all&card=repo%2Fcard-b'));
 assert.match(opened,/data-card-row="repo\/card-b" class="selected"/);
 assert.doesNotMatch(opened,/data-card-row="repo\/card-a" class="selected"/);
});

test('작은 UX: 초기화는 처음 화면과 같은 미완료로 돌아가고, 조건 없는 개수 표시는 상태 이름을 쓴다',()=>{
 const script=String(dashboardWorkspaceScript);
 assert.match(script,/data-workspace-reset'\)\)change\(\{q:'',repo:'',board:'',health:'',rally:'',state:''\}/);
 assert.doesNotMatch(script,/data-workspace-reset'\)\)change\(\{[^}]*state:'all'/);
 assert.match(script,/\(state\.q\|\|state\.repo\|\|state\.board\|\|state\.health\|\|state\.rally\)\?'조건':filterName/);
});

test('작은 UX: 현황과 우편함은 미확인 수 대신 답을 기다리는 질문 수를 먼저 보이고 그 목록으로 보낸다',()=>{
 const mail=(mailId,patch={})=>({kind:'send',mailId,by:'worker',role:'boss',preview:'질문 '+mailId,t:'2026-09-16T00:00:00Z',...patch});
 const entries=[mail('q1',{expectReply:true}),mail('q2',{expectReply:true}),mail('n1')];
 assert.equal(mailboxAwaitingReply(entries,entries.length),2);
 assert.equal(mailboxAwaitingReply([{broken:true}],null),null);
 const status=renderDashboardStatus({center:{cards:[],boards:[]},works:[],decisions:[],entries,ledgerLines:entries.length});
 assert.match(status,/href="\?mailView=to-reply#mailbox"><span class="st-num">2<\/span><span class="st-lbl">답을 기다리는 질문/);
 assert.doesNotMatch(status,/전체 역할 미확인 우편/);
 const box=renderActivity({entries,ledgerLines:entries.length},new URL('http://localhost/'));
 assert.match(box,/<a href="\?mailView=to-reply#mailbox">답을 기다리는 질문 2건<\/a>/);
 assert.match(box,/전체 역할 미확인 3건/);
});

test('작은 UX: 현황 설명은 PID·세션 같은 내부 말을 앞세우지 않는다',()=>{
 const status=renderDashboardStatus({center:{cards:[],boards:[]},works:[],decisions:[]});
 assert.match(status,/맡긴 일이 어디까지 왔는지/);
 for(const word of ['PID 근거','실행 신호가 아닙니다','실시간 작업 감지','같은 카드 집합'])assert.ok(!status.includes(word),word);
});
