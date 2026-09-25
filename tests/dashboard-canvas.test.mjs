import {unpackRows} from '../src/dashboard-workspace.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {renderCenterWall} from '../src/center-wall.mjs';
import {readActiveHierarchy} from '../src/hierarchy-register.mjs';
import {wallColumnOf,wallStatusColumns,wallStepColumns,workspaceWallHtml,workspaceMapHtml} from '../src/dashboard-canvas.mjs';

const at='2020-09-08T01:00:00Z',sent='2020-09-08T00:00:00Z';
const card=(patch={})=>({key:'repo/card-a',repo:'repo',id:'card-a',title:'제품 조건 확인',body:'# 작업',status:'assigned',displayState:'unconfirmed',role:'작업자',board:'판-a',revision:2,at,scope:'로컬 확인',runs:[{role:'작업자',state:'unconfirmed',sessionState:'alive',sentAt:sent,at:sent}],history:[],path:'/central/repo/card-a/card.md',sourcePath:'/repo/docs/task.md',repoPath:'/repo',...patch});
const center=cards=>({cards,roles:[],boards:[],unregistered:[],runtimeKnown:true});
const render=(cards,query='')=>renderCenterWall({center:center(cards),collectedAt:at,entries:[],ledgerLines:0},{token:'fixture-token',url:new URL('http://localhost/'+query)});
const readData=html=>{const data=JSON.parse(html.match(/<script type="application\/json" id="dw-data">([\s\S]*?)<\/script>/)[1]);data.rows=unpackRows(data.rows);return data;};
// 카드 월·관계도가 읽는 필드만 가진 행을 직접 만든다.
const row=(patch={})=>({key:'repo/a',id:'a',title:'카드 가',kind:'execution',owner:'작업자',rallyStep:'implementation',healthKind:'running',healthLabel:'작업 중',healthReason:'진행 보고가 있습니다.',signalAt:sent,signalLabel:'진행 보고',flowLabel:'1라운드 · 구현',flowPhase:'구현 중',turnLabel:'작업자',stateLabel:'작업 중',model:'gpt-6-astra',effort:'max',modelTitle:'codex · gpt-6-astra · 강도 max',purpose:'목적 한 줄',parentWorkKey:'',...patch});

test('카드 월 열은 상태와 티키타카 단계 두 축으로 정해진다',()=>{
 assert.deepEqual(wallStatusColumns.map(([key])=>key),['planned','running','waiting','hold','attention','closed']);
 assert.deepEqual(wallStepColumns.map(([key])=>key),['implementation','fix','review','research','']);
 for(const kind of ['planned','running','waiting','hold','closed'])assert.equal(wallColumnOf(row({healthKind:kind}),'status'),kind);
 assert.equal(wallColumnOf(row({healthKind:'unknown-kind'}),'status'),'attention');
 assert.equal(wallColumnOf(row({rallyStep:'review'}),'step'),'review');
 assert.equal(wallColumnOf(row({rallyStep:undefined}),'step'),'');
 assert.equal(wallColumnOf(row({kind:'work',rallyStep:undefined}),'step'),'');
});

test('카드 월은 열마다 장수와 타일을 보여주고 종료·미기록 문구를 반복하지 않는다',()=>{
 const rows=[
  row({key:'repo/run',id:'run',title:'돌아가는 카드',healthKind:'running',healthLabel:'작업 중'}),
  row({key:'repo/wait',id:'wait',title:'기다리는 카드',healthKind:'waiting',healthLabel:'결과 대기',turnLabel:'종료',model:'',effort:'',modelTitle:''}),
  row({key:'repo/done',id:'done',title:'끝난 카드',healthKind:'closed',healthLabel:'완료',signalAt:null,signalLabel:'실행 신호 없음',model:''})
 ];
 const html=workspaceWallHtml(rows,'repo/run','status');
 const columns=[...html.matchAll(/<section class="dw-wall-col" data-wall-column="([^"]*)"><header><h3>([^<]*)<\/h3><span>([0-9]+)<\/span>/g)].map(m=>({key:m[1],label:m[2],count:Number(m[3])}));
 assert.deepEqual(columns.map(c=>c.key),['planned','running','waiting','hold','attention','closed']);
 assert.deepEqual(columns.map(c=>c.count),[0,1,1,0,0,1]);
 assert.match(html,/돌아가는 카드/);assert.match(html,/gpt-6-astra · max/);
 assert.match(html,/data-card-key="repo\/run" href="\?card=repo%2Frun#detail" aria-current="true"/);
 const done=html.split('data-card-key="repo/done"')[1];
 assert.match(done,/실행 신호 없음/);assert.doesNotMatch(done,/현재 차례|종료/);
 assert.match(workspaceWallHtml([],'','status'),/조건에 맞는 카드가 없습니다/);
});

test('카드 월 단계 축은 구현·수정·독립검수·조사와 연결 전 업무로 나눈다',()=>{
 const rows=[
  row({key:'repo/i',rallyStep:'implementation'}),row({key:'repo/f',rallyStep:'fix'}),row({key:'repo/r',rallyStep:'review'}),row({key:'repo/s',rallyStep:'research'}),
  row({key:'repo/none',rallyStep:undefined,flowLabel:''}),row({key:'work:repo/w',kind:'work',rallyStep:undefined,title:'업무 카드'})
 ];
 const html=workspaceWallHtml(rows,'','step');
 const columns=[...html.matchAll(/data-wall-column="([^"]*)"><header><h3>[^<]*<\/h3><span>([0-9]+)</g)].map(m=>[m[1],Number(m[2])]);
 assert.deepEqual(columns,[['implementation',1],['fix',1],['review',1],['research',1],['',2]]);
 assert.match(html,/data-axis="step" aria-pressed="true"/);
});

test('업무 중심 관계도는 업무 아래에 연결 실행을 놓고 연결 전 실행을 따로 모은다',()=>{
 const work=row({key:'work:repo/w',kind:'work',workKey:'repo/w',title:'업무 제목',flowPhase:'실행 1/3건 종료 · 남은 실행 2건',parentWorkKey:''});
 const rows=[work,row({key:'repo/a',parentWorkKey:'repo/w'}),row({key:'repo/b',parentWorkKey:'repo/w'}),row({key:'repo/free',parentWorkKey:''})];
 const html=workspaceMapHtml(rows,'repo/a','work',null);
 assert.match(html,/업무 제목/);assert.match(html,/연결 2장/);
 assert.match(html,/data-root="work" aria-pressed="true"/);
 const workBlock=html.split('업무 제목')[1].split('연결 전 실행')[0];
 assert.match(workBlock,/data-card-key="repo\/a"/);assert.match(workBlock,/data-card-key="repo\/b"/);
 assert.match(html,/연결 전 실행/);assert.match(html.split('연결 전 실행')[1],/data-card-key="repo\/free"/);
 assert.match(html,/aria-current="true"/);
 // 실행 모음처럼 업무 행이 필터로 빠진 화면에서도 전체 행의 업무 노드에 카드가 붙는다.
 const hidden=workspaceMapHtml([row({key:'repo/a',parentWorkKey:'repo/w'})],'','work',null,[work,row({key:'repo/a',parentWorkKey:'repo/w'})]);
 assert.match(hidden,/업무 제목/);assert.match(hidden.split('업무 제목')[1].split('연결 전 실행')[0],/data-card-key="repo\/a"/);
 assert.doesNotMatch(hidden,/연결 전 실행/);
});

test('역할 중심 관계도는 등록된 직속 상위로 이어지고 작업 중 수와 담당 미배정을 구분한다',()=>{
 const rows=[
  row({key:'repo/a',owner:'작업자-1',healthKind:'running'}),
  row({key:'repo/b',owner:'작업자-2',healthKind:'waiting'}),
  row({key:'repo/c',owner:'',healthKind:'planned',healthLabel:'초안'})
 ];
 const hierarchy={'작업자-1':'감독-1','작업자-2':'감독-1','감독-1':'슈퍼감독','슈퍼감독':'@user'};
 const html=workspaceMapHtml(rows,'','role',hierarchy);
 assert.match(html,/슈퍼감독/);assert.match(html,/감독-1/);assert.match(html,/작업자-1/);
 assert.match(html,/카드 1 · 작업 중 1/);assert.match(html,/담당 미배정/);
 const flat=workspaceMapHtml(rows,'','role',null);
 assert.match(flat,/관계표를 읽지 못해 담당별로 묶었습니다/);
 assert.match(flat,/작업자-1/);
});

test('관계표 읽기는 실패를 모름으로 두고 화면 상태에 축·뿌리를 남긴다',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kadan-canvas-'));
 const file=path.join(dir,'hierarchy.json');
 fs.writeFileSync(file,JSON.stringify({'작업자':'감독','감독':'@user'}));
 assert.deepEqual(readActiveHierarchy([{kind:'hierarchy-loaded',path:file}]),{'작업자':'감독','감독':'@user'});
 assert.equal(readActiveHierarchy([]),null);
 fs.writeFileSync(file,'{broken');
 assert.equal(readActiveHierarchy([{kind:'hierarchy-loaded',path:file}]),null);
 const cards=[card()];
 const wall=render(cards,'?layout=wall&axis=step');
 assert.match(wall,/id="dw-wall"/);assert.match(wall,/data-axis="step" aria-pressed="true"/);
 assert.deepEqual([readData(wall).state.layout,readData(wall).state.axis],['wall','step']);
 const map=render(cards,'?layout=map&root=role');
 assert.match(map,/id="dw-map"/);assert.match(map,/data-root="role" aria-pressed="true"/);
 assert.equal(readData(map).state.root,'role');
 assert.equal(readData(map).hierarchy,null);
 const table=render(cards,'');
 assert.equal(readData(table).state.layout,'table');
 assert.match(table,/id="dw-wall" hidden/);
});
