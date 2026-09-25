import test from 'node:test';
import assert from 'node:assert/strict';
import {renderDashboardWorkspace} from '../src/dashboard-workspace.mjs';

const at='2020-09-08T01:00:00Z';
const card=id=>({key:'repo/'+id,repo:'repo',id,title:'제목 '+id,body:'본문 '+id,status:'assigned',displayState:'unconfirmed',role:'작업자',board:'판-a',revision:1,at,runs:[{role:'작업자',state:'unconfirmed',sentAt:at}],history:[]});
const center={cards:[card('card-a'),card('card-b')],roles:[],boards:[],unregistered:[],runtimeKnown:true};
const view=query=>renderDashboardWorkspace({center,briefs:null,centerError:null,url:new URL('http://localhost/'+query),detail:c=>`<article id="detail" data-key="${c.key}">상세 ${c.key}</article>`,works:[],workError:null,workDetail:()=>''});
const data=html=>JSON.parse(html.match(/<script type="application\/json" id="dw-data">([\s\S]*?)<\/script>/)[1]);

test('자료 크기: 고르지 않은 카드의 상세는 페이지에 싣지 않고, 연 카드나 목록·상세 보기만 싣는다',()=>{
 const table=view('?collection=executions&state=all');
 assert.doesNotMatch(table,/<article id="detail"/);assert.equal(data(table).loadedKey,'');
 const opened=view('?state=all&card=repo%2Fcard-b');
 assert.match(opened,/<article id="detail" data-key="repo\/card-b">/);assert.equal(data(opened).loadedKey,'repo/card-b');
 const closed=view('?state=all&card=repo%2Fcard-b&detail=0');
 assert.doesNotMatch(closed,/<article id="detail"/);
 const split=view('?collection=executions&state=all&layout=split');
 assert.match(split,/<article id="detail" data-key="repo\/card-a">/);assert.equal(data(split).loadedKey,'repo/card-a');
});

test('자료 크기: 목록 자료는 이름표를 묶어 보내고, 풀면 JSON으로 주고받은 원래 줄과 같다',async()=>{
 const {packRows,unpackRows}=await import('../src/dashboard-workspace.mjs');
 const rows=[{key:'a',title:'가',next:'',model:null,list:[1,{x:2}],flag:false},{key:'b',title:'나',next:'다음',model:'m',list:[],flag:true},{key:'w',kind:'work',skipped:undefined}];
 const packed=packRows(rows);
 assert.equal(packed.shapes.length,2);
 assert.deepEqual(unpackRows(JSON.parse(JSON.stringify(packed))),JSON.parse(JSON.stringify(rows)));
 assert.equal(packRows(null),null);assert.deepEqual(unpackRows(rows),rows);
 const sent=data(view('?collection=executions&state=all'));
 assert.ok(Array.isArray(sent.rows.shapes));
 assert.deepEqual(unpackRows(sent.rows).map(r=>r.key),['repo/card-a','repo/card-b']);
});
