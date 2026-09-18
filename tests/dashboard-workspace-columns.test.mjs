import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {installWorkspaceColumns} from '../src/dashboard-workspace-columns.mjs';

function harness({saved=null,blocked=false,overlay=false}={}) {
 const keys=['title','next','owner'],stored=new Map([['kadan.dashboard.columns.v2',saved]]),windowEvents=new Map();let resets=0;
 const element=dataset=>{const events=new Map(),classes=new Set();let pointer;return {dataset,events,children:[],textContent:'',classList:{add:(...names)=>names.forEach(n=>classes.add(n)),remove:(...names)=>names.forEach(n=>classes.delete(n)),contains:n=>classes.has(n)},addEventListener:(type,fn)=>events.set(type,fn),appendChild(el){this.children=this.children.filter(c=>c!==el);this.children.push(el)},focus(){},scrollIntoView(){},setPointerCapture:id=>pointer=id,hasPointerCapture:id=>pointer===id,releasePointerCapture(){pointer=null}};};
 const group=element({}),head=element({}),body=element({}),reset=element({}),status=element({});
 group.children=keys.map(key=>element({column:key}));
 const buttons=keys.map(key=>element({sort:key}));
 head.children=keys.map((key,i)=>{const th=element({column:key,sortColumn:key});th.querySelector=()=>buttons[i];buttons[i].textContent=key+' ↕';buttons[i].closest=()=>th;th.closest=()=>th;th.getBoundingClientRect=()=>({left:head.children.indexOf(th)*200,top:0,width:200,height:38});return th;});
 const makeRow=()=>({children:keys.map(key=>({...element({column:key}),textContent:key+'-card-value'})),appendChild:group.appendChild});
 let row=makeRow();
 const scroll={scrollLeft:0,getBoundingClientRect:()=>({left:0,right:600})};
 const table={querySelectorAll:()=>[group,head,row],contains:el=>head.children.includes(el)};
 const nodes={'#dw-table':table,'#dw-scroll':scroll,'#dw-column-status':status,'[data-columns-reset]':reset};
 const context={document:{body,querySelectorAll:()=>buttons,querySelector:s=>nodes[s],elementFromPoint:x=>overlay?null:head.children[Math.floor(x/200)]},window:{addEventListener:(type,fn)=>windowEvents.set(type,fn)},localStorage:{getItem:key=>{if(blocked)throw Error('blocked');return stored.get(key)},setItem:(key,value)=>{if(blocked)throw Error('blocked');stored.set(key,value)}},requestAnimationFrame:()=>1,cancelAnimationFrame(){},onReset:()=>resets++};
 const api=runInNewContext('('+installWorkspaceColumns.toString()+')(()=>{},onReset)',context);
 const send=(key,type,patch={})=>{let prevented=false,stopped=false;buttons.find(b=>b.dataset.sort===key).events.get(type)({button:0,detail:1,isPrimary:true,pointerId:1,clientX:100,preventDefault(){prevented=true},stopPropagation(){stopped=true},...patch});return {prevented,stopped};};
 return {api,send,stored:()=>stored.get('kadan.dashboard.columns.v2'),order:()=>head.children.map(el=>el.dataset.column),allOrders:()=>[group,head,row].map(r=>r.children.map(el=>el.dataset.column)),values:()=>row.children.map(el=>el.textContent),replaceRows(){row=makeRow();api.refresh()},reset(){reset.events.get('click')()},resets:()=>resets,status,windowEvents};
}
test('열 드래그는 머리글·너비·카드 값을 함께 이동하고 정렬 클릭을 막는다',()=>{
 const h=harness();h.send('owner','pointerdown',{clientX:500});h.send('owner','pointermove',{clientX:20});
 assert.equal(h.api.active(),true);assert.equal(h.stored(),null);
 h.send('owner','pointerup');assert.equal(h.api.active(),false);
 assert.deepEqual(h.allOrders(),Array(3).fill(['owner','title','next']));
 assert.deepEqual(h.values(),['owner-card-value','title-card-value','next-card-value']);
 assert.deepEqual(h.send('owner','click'),{prevented:true,stopped:true});
 h.replaceRows();assert.deepEqual(h.values(),['owner-card-value','title-card-value','next-card-value']);
 assert.deepEqual(harness({saved:h.stored()}).order(),['owner','title','next']);
});
test('단순 클릭과 작은 손떨림은 기존 정렬을 유지하고 취소는 배치를 저장하지 않는다',()=>{
 const h=harness();h.send('title','pointerdown');h.send('title','pointermove',{clientX:104});h.send('title','pointerup');
 assert.deepEqual(h.send('title','click'),{prevented:false,stopped:false});assert.equal(h.stored(),null);
 for(const ending of ['pointercancel','lostpointercapture','keydown']){
  h.send('title','pointerdown');h.send('title','pointermove',{clientX:580});h.send('title',ending,{key:'Escape'});
  assert.deepEqual(h.order(),['title','next','owner']);assert.equal(h.api.active(),false);assert.equal(h.stored(),null);
 }
});
test('저장된 순서는 유효한 열만 중복 없이 복원하고 새 열은 빠지지 않는다',()=>{
 const h=harness({saved:JSON.stringify({order:['owner','deleted','owner',3]})});
 assert.deepEqual(h.order(),['owner','title','next']);
 for(const saved of ['broken',JSON.stringify({order:'title'}),JSON.stringify({order:[null,{},'unknown']})])assert.deepEqual(harness({saved}).order(),['title','next','owner']);
});
test('키보드로 처음·끝·인접 열에 이동하고 초기화는 너비 초기화와 연결된다',()=>{
 const h=harness();h.send('next','keydown',{altKey:true,key:'ArrowLeft'});assert.deepEqual(h.order(),['next','title','owner']);
 h.send('next','keydown',{altKey:true,key:'End'});assert.deepEqual(h.order(),['title','owner','next']);
 h.send('owner','keydown',{altKey:true,key:'Home'});assert.deepEqual(h.order(),['owner','title','next']);
 assert.match(h.status.textContent,/1번째/);
 h.reset();assert.deepEqual(h.order(),['title','next','owner']);assert.equal(h.resets(),1);
});
test('브라우저 저장소가 차단되어도 순서 변경과 초기화는 사용할 수 있다',()=>{
 const h=harness({blocked:true});h.send('title','keydown',{altKey:true,key:'ArrowRight'});assert.deepEqual(h.order(),['next','title','owner']);h.reset();assert.deepEqual(h.order(),['title','next','owner']);
});

test('스크롤바가 덮인 가장자리에서도 마지막 열과 첫 열로 옮길 수 있다',()=>{
 const h=harness({overlay:true});h.send('title','pointerdown');h.send('title','pointermove',{clientX:650});h.send('title','pointerup');
 assert.deepEqual(h.order(),['next','owner','title']);
 h.send('title','pointerdown',{clientX:500});h.send('title','pointermove',{clientX:-10});h.send('title','pointerup');
 assert.deepEqual(h.order(),['title','next','owner']);
});
