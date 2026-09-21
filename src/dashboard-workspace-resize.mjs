// 브라우저에서 실행한다. 화면 너비만 저장하며 카드·원장은 변경하지 않는다.
export function installWorkspaceResize(onActivity=()=>{},columns=[]) {
 const handles=[...document.querySelectorAll('[data-workspace-resize]')];
 if(!handles.length)return {refresh(){},resetColumns(){},active:()=>false};
 const panes=document.querySelector('#dw-panes'),master=document.querySelector('#dw-master'),table=document.querySelector('#dw-table');
 const storageKey='kadan.dashboard.widths.v1',mobile=matchMedia('(max-width:799px)');
 const sizes=new Map(columns.map(([key,,width,min])=>[key,{width,min}]));
 let widths={},drag=null;
 try{const saved=JSON.parse(localStorage.getItem(storageKey));for(const key of new Set(['title','split','table',...sizes.keys()]))if(typeof saved?.[key]==='number'&&Number.isFinite(saved[key])&&saved[key]>0)widths[key]=saved[key];}catch{}
 const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
 const layout=()=>panes.classList.contains('dw-table-layout')?'table':'split';
 function bounds(kind){
  const total=Math.max(1,panes.clientWidth-8);
  // 제목 열 기본 너비는 열 정의에서 읽는다. 모바일만 더 좁게 시작한다.
  if(kind==='title')return {key:'title',min:180,max:Math.max(180,Math.min(1000,master.clientWidth-100)),total:1,fallback:mobile.matches?190:(sizes.get('title')?.width??320)};
  if(sizes.has(kind))return {key:kind,min:sizes.get(kind).min,max:1000,total:1,fallback:sizes.get(kind).width};
  return {key:layout(),min:260,max:Math.max(260,total-320),total,fallback:layout()==='table'?.52:(innerWidth>=1700?.38:.4)};
 }
 function current(kind){const b=bounds(kind);return clamp((widths[b.key]??b.fallback)*b.total,b.min,b.max);}
 function save(){try{localStorage.setItem(storageKey,JSON.stringify(widths));}catch{}}
 function refresh(){
  if(!panes.clientWidth)return;
  const paneWidth=current('panes');panes.style.setProperty('--master-width',paneWidth+'px');
  const titleWidth=current('title');table.style.setProperty('--title-width',titleWidth+'px');
  let tableWidth=0;for(const key of sizes.keys()){const value=current(key);table.style.setProperty('--column-'+key,value+'px');tableWidth+=value;}
  if(tableWidth)table.style.setProperty('--table-width',tableWidth+'px');
  for(const handle of handles){const kind=handle.dataset.workspaceResize,b=bounds(kind),value=current(kind);
   handle.setAttribute('aria-valuemin',String(b.min));handle.setAttribute('aria-valuemax',String(b.max));handle.setAttribute('aria-valuenow',String(Math.round(value)));
   handle.setAttribute('aria-valuetext',kind!=='panes'?Math.round(value)+'픽셀':'목록 '+Math.round(value/b.total*100)+'%, 상세 '+Math.round((1-value/b.total)*100)+'%');
  }
 }
 function update(kind,value){const b=bounds(kind);widths[b.key]=clamp(value,b.min,b.max)/b.total;refresh();onActivity();}
 function finish(cancel=false){
  if(!drag)return;
  const previous=drag;drag=null;
  if(cancel){if(previous.saved===undefined)delete widths[previous.key];else widths[previous.key]=previous.saved;}
  document.body.classList.remove('dw-resizing');previous.handle.classList.remove('dw-resize-active');
  if(previous.handle.hasPointerCapture(previous.id))previous.handle.releasePointerCapture(previous.id);
  refresh();if(!cancel)save();onActivity();
 }
 for(const handle of handles){
  const kind=handle.dataset.workspaceResize;
  handle.addEventListener('pointerdown',event=>{
   if(event.button!==0||event.isPrimary===false||drag)return;
   event.preventDefault();event.stopPropagation();
   const b=bounds(kind);drag={handle,kind,key:b.key,saved:widths[b.key],id:event.pointerId,x:event.clientX,width:current(kind)};
   handle.setPointerCapture(event.pointerId);handle.focus({preventScroll:true});
   document.body.classList.add('dw-resizing');handle.classList.add('dw-resize-active');onActivity();
  });
  handle.addEventListener('pointermove',event=>{if(drag?.id!==event.pointerId)return;event.preventDefault();update(kind,drag.width+event.clientX-drag.x);});
  handle.addEventListener('pointerup',event=>{if(drag?.id===event.pointerId)finish();});
  handle.addEventListener('pointercancel',event=>{if(drag?.id===event.pointerId)finish(true);});
  handle.addEventListener('lostpointercapture',()=>finish());
  handle.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();});
  handle.addEventListener('dblclick',event=>{event.preventDefault();event.stopPropagation();delete widths[bounds(kind).key];refresh();save();onActivity();});
  handle.addEventListener('keydown',event=>{
   if(!['ArrowLeft','ArrowRight','Home','End','Escape'].includes(event.key))return;
   event.preventDefault();event.stopPropagation();
   if(event.key==='Escape'){finish(true);return;}
   const b=bounds(kind),step=event.shiftKey?48:16;
   update(kind,event.key==='Home'?b.min:event.key==='End'?b.max:current(kind)+(event.key==='ArrowLeft'?-step:step));save();
  });
 }
 window.addEventListener('blur',()=>finish());
 window.addEventListener('resize',()=>{finish();refresh();});
 new ResizeObserver(refresh).observe(panes);
 refresh();
 return {refresh,active:()=>Boolean(drag),resetColumns(){finish(true);for(const key of new Set(['title',...sizes.keys()]))delete widths[key];refresh();save();onActivity();}};
}
