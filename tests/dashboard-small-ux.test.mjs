import test from 'node:test';
import assert from 'node:assert/strict';
import {renderDashboardWorkspace} from '../src/dashboard-workspace.mjs';
import {dashboardWorkspaceScript} from '../src/dashboard-workspace-client.mjs';

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
