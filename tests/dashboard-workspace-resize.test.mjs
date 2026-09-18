import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {installWorkspaceResize} from '../src/dashboard-workspace-resize.mjs';
import {workspaceColumns} from '../src/dashboard-workspace.mjs';

const defaults=Object.fromEntries(workspaceColumns.map(([key,,width])=>[key,width]));
const totalWidth=over=>workspaceColumns.reduce((sum,[key,,width])=>sum+(over[key]??width),0);

function harness({saved=null,blocked=false,layout='table',viewport=1440}={}) {
 const stored=new Map([['kadan.dashboard.widths.v1',saved]]),listeners=new Map();let width=viewport,observer,activities=0;
 const element=()=>{const events=new Map(),classes=new Set(),props=new Map(),attrs=new Map();let pointer=null;return {events,props,attrs,classList:{contains:k=>classes.has(k),add:k=>classes.add(k),remove:k=>classes.delete(k)},style:{setProperty:(k,v)=>props.set(k,v)},setAttribute:(k,v)=>attrs.set(k,v),addEventListener:(k,fn)=>events.set(k,fn),focus(){},setPointerCapture:id=>pointer=id,hasPointerCapture:id=>pointer===id,releasePointerCapture:()=>pointer=null};};
 const panes=element(),master=element(),table=element(),body=element();
 const handles=[...workspaceColumns.map(([key])=>key),'panes'].map(kind=>Object.assign(element(),{dataset:{workspaceResize:kind}}));
 Object.defineProperty(panes,'clientWidth',{get:()=>width-52});
 Object.defineProperty(master,'clientWidth',{get:()=>panes.classList.contains('dw-table-layout')&&!panes.classList.contains('dw-detail-open')?panes.clientWidth:parseFloat(panes.props.get('--master-width'))});
 if(layout==='table')panes.classList.add('dw-table-layout');
 const nodes={'#dw-panes':panes,'#dw-master':master,'#dw-table':table};
 const context={columns:workspaceColumns,document:{body,querySelectorAll:()=>handles,querySelector:s=>nodes[s]},window:{addEventListener:(k,fn)=>listeners.set(k,fn)},matchMedia:()=>({get matches(){return width<800}}),get innerWidth(){return width},localStorage:{getItem:key=>{if(blocked)throw Error('storage blocked');return stored.get(key)},setItem:(key,value)=>{if(blocked)throw Error('storage blocked');stored.set(key,value)}},ResizeObserver:class {constructor(fn){observer=fn}observe(){}},onActivity:()=>activities++};
 const api=runInNewContext('('+installWorkspaceResize.toString()+')(onActivity,columns)',context);
 const send=(kind,type,patch={})=>{let prevented=false,stopped=false;handles.find(h=>h.dataset.workspaceResize===kind).events.get(type)({button:0,isPrimary:true,pointerId:1,clientX:320,preventDefault(){prevented=true},stopPropagation(){stopped=true},...patch});return {prevented,stopped};};
 return {api,panes,body,table,send,stored:()=>stored.get('kadan.dashboard.widths.v1'),value:kind=>Number(handles.find(h=>h.dataset.workspaceResize===kind).attrs.get('aria-valuenow')),resize:next=>{width=next;listeners.get('resize')();observer()},activities:()=>activities};
}

test('제목 드래그는 열을 늘리고 손을 놓을 때 저장하며 정렬 클릭으로 전달하지 않는다',()=>{
 const h=harness();assert.equal(h.value('title'),defaults.title);
 assert.deepEqual(h.send('title','pointerdown'),{prevented:true,stopped:true});assert.equal(h.api.active(),true);
 h.send('title','pointermove',{clientX:600});assert.equal(h.value('title'),defaults.title+280);assert.equal(h.stored(),null);
 h.send('title','pointerup');assert.equal(h.api.active(),false);assert.equal(JSON.parse(h.stored()).title,defaults.title+280);
 assert.deepEqual(h.send('title','click'),{prevented:true,stopped:true});assert.ok(h.activities()>0);
 assert.equal(harness({saved:h.stored()}).value('title'),defaults.title+280);
});
test('작은 화면에서 저장한 제목 너비를 제한하고 다시 넓히면 원래 값으로 돌아간다',()=>{
 const h=harness({saved:JSON.stringify({title:600})});h.resize(390);
 assert.ok(h.value('title')<=238);assert.equal(JSON.parse(h.stored()).title,600);
 h.resize(1440);assert.equal(h.value('title'),600);
 h.send('title','keydown',{key:'Home'});assert.equal(h.value('title'),180);
 h.send('title','keydown',{key:'End'});assert.equal(h.value('title'),1000);
});
test('목록·상세 비율은 표·상세 비율과 별도로 기억하며 양쪽 최소 너비를 지킨다',()=>{
 const h=harness({layout:'split'});h.send('panes','pointerdown');h.send('panes','pointermove',{clientX:500});h.send('panes','pointerup');
 const split=JSON.parse(h.stored()).split,splitWidth=h.value('panes');
 h.panes.classList.add('dw-table-layout');h.panes.classList.add('dw-detail-open');h.api.refresh();assert.notEqual(h.value('panes'),splitWidth);
 h.send('panes','keydown',{key:'End'});assert.equal(h.value('panes'),h.panes.clientWidth-8-320);
 assert.equal(JSON.parse(h.stored()).split,split);assert.ok(JSON.parse(h.stored()).table);
 h.panes.classList.remove('dw-table-layout');h.api.refresh();assert.equal(h.value('panes'),splitWidth);
 h.resize(800);assert.ok(h.value('panes')>=260);assert.ok(h.panes.clientWidth-8-h.value('panes')>=320);
});
test('취소·Escape는 드래그 전 너비를 복원하고 잘못된 포인터를 무시한다',()=>{
 const h=harness();h.send('title','pointerdown',{button:2});assert.equal(h.api.active(),false);
 for(const type of ['pointercancel','keydown']){
  h.send('title','pointerdown');h.send('title','pointermove',{clientX:500});h.send('title',type,{key:'Escape'});
  assert.equal(h.api.active(),false);assert.equal(h.value('title'),defaults.title);assert.equal(h.stored(),null);assert.equal(h.body.classList.contains('dw-resizing'),false);
 }
});
test('저장소 오류나 잘못된 저장값이 화면을 막지 않고 키보드·기본 너비 복원이 동작한다',()=>{
 for(const options of [{blocked:true},{saved:'broken'},{saved:JSON.stringify({title:'600px',split:-1})}]){
  const h=harness(options);assert.equal(h.value('title'),defaults.title);
  assert.deepEqual(h.send('title','keydown',{key:'ArrowRight'}),{prevented:true,stopped:true});assert.equal(h.value('title'),defaults.title+16);
  h.send('title','dblclick');assert.equal(h.value('title'),defaults.title);
 }
});

test('각 열 너비는 키로 독립 저장하고 전체 초기화는 목록·상세 비율을 보존한다',()=>{
 const h=harness({saved:JSON.stringify({title:400,split:.45,table:.6,owner:180})});
 h.send('next','pointerdown');h.send('next','pointermove',{clientX:480});h.send('next','pointerup');
 assert.equal(h.value('next'),360);assert.equal(h.table.props.has('--column-owner'),false);assert.equal(h.value('title'),400);
 assert.equal(h.table.props.get('--table-width'),totalWidth({title:400,next:360})+'px');
 const restored=harness({saved:h.stored()});assert.equal(restored.value('next'),360);assert.equal(restored.table.props.has('--column-owner'),false);
 h.send('board','keydown',{key:'Home'});assert.equal(h.value('board'),80);
 h.api.resetColumns();assert.equal(h.value('next'),defaults.next);assert.equal(h.value('title'),defaults.title);
 assert.deepEqual(JSON.parse(h.stored()),{split:.45,table:.6});
});
