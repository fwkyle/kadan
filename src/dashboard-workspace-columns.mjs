// 열 배치는 브라우저에만 저장한다. 카드 목록을 다시 그려도 같은 키의 셀을 함께 옮긴다.
export function installWorkspaceColumns(onActivity=()=>{},resetWidths=()=>{}) {
 const buttons=[...document.querySelectorAll('#dw-table [data-sort]')];
 if(!buttons.length)return {refresh(){},active:()=>false};
 const table=document.querySelector('#dw-table'),scroll=document.querySelector('#dw-scroll');
 const status=document.querySelector('#dw-column-status'),storageKey='kadan.dashboard.columns.v1';
 const defaults=buttons.map(button=>button.dataset.sort),headers=new Map(buttons.map(button=>[button.dataset.sort,button.closest('th')]));
 let order=[...defaults],drag=null,suppressClick=null,frame=0;
 try{const saved=JSON.parse(localStorage.getItem(storageKey));if(Array.isArray(saved?.order)){order=[...new Set([...saved.order.filter(key=>defaults.includes(key)),...defaults])];const added=['healthLabel','signalAt'].filter(key=>defaults.includes(key)&&!saved.order.includes(key));if(added.length&&order.includes('title')){order=order.filter(key=>!added.includes(key));order.splice(order.indexOf('title')+1,0,...added);}}}catch{}
 function save(){try{localStorage.setItem(storageKey,JSON.stringify({order}));}catch{}}
 function refresh(){
  for(const row of table.querySelectorAll('colgroup,thead tr,tbody tr')){
   const cells=[...row.children];if(cells.every((cell,i)=>cell.dataset.column===order[i]))continue;
   const byKey=new Map(cells.map(cell=>[cell.dataset.column,cell]));
   for(const key of order)if(byKey.has(key))row.appendChild(byKey.get(key));
  }
 }
 function announce(key){if(status)status.textContent=headers.get(key).querySelector('button').textContent.replace(/[↑↓↕]/g,'').trim()+' 열을 '+(order.indexOf(key)+1)+'번째로 옮겼습니다.';}
 function clearMarker(){for(const header of headers.values())header.classList.remove('dw-column-drop-before','dw-column-drop-after');}
 function targetAt(x){
  clearMarker();drag.target=null;
  const area=scroll.getBoundingClientRect(),point=Math.max(area.left+1,Math.min(area.right-1,x));
  // 화면 가장자리의 스크롤바가 포인터 아래에 있어도 머리글 위치로 목적지를 찾는다.
  // 첫 열을 먼저 확인해서 그 뒤로 가려진 열을 선택하지 않는다.
  const hit=order.map(key=>headers.get(key)).find(header=>{const box=header.getBoundingClientRect();return point>=box.left&&point<box.left+box.width;})||headers.get(order.at(-1));
  if(hit.dataset.sortColumn===drag.key)return;
  const box=hit.getBoundingClientRect(),after=x>box.left+box.width/2;
  drag.target={key:hit.dataset.sortColumn,after};hit.classList.add(after?'dw-column-drop-after':'dw-column-drop-before');
 }
 function autoScroll(){
  frame=0;if(!drag?.moved)return;
  const area=scroll.getBoundingClientRect(),x=drag.x;
  const step=x>area.right-36?Math.min(18,(x-area.right+36)/2):x<area.left+36?-Math.min(18,(area.left+36-x)/2):0;
  if(step){const before=scroll.scrollLeft;scroll.scrollLeft+=step;if(scroll.scrollLeft!==before)targetAt(x);}
  frame=requestAnimationFrame(autoScroll);
 }
 function move(key,target,after){
  const next=order.filter(item=>item!==key),index=next.indexOf(target);if(index<0)return;
  next.splice(index+(after?1:0),0,key);order=next;refresh();save();announce(key);onActivity();
 }
 function finish(cancel=false){
  if(!drag)return;
  const previous=drag;drag=null;cancelAnimationFrame(frame);frame=0;clearMarker();
  document.body.classList.remove('dw-column-dragging');previous.button.closest('th').classList.remove('dw-column-moving');
  if(previous.button.hasPointerCapture(previous.id))previous.button.releasePointerCapture(previous.id);
  if(previous.moved){suppressClick=previous.button;if(!cancel&&previous.target)move(previous.key,previous.target.key,previous.target.after);previous.button.focus({preventScroll:true});}
  onActivity();
 }
 for(const button of buttons){
  button.addEventListener('pointerdown',event=>{
   if(event.button!==0||event.isPrimary===false||drag)return;
   suppressClick=null;drag={button,key:button.dataset.sort,id:event.pointerId,startX:event.clientX,x:event.clientX,moved:false,target:null};
   button.setPointerCapture(event.pointerId);onActivity();
  });
  button.addEventListener('pointermove',event=>{
   if(drag?.id!==event.pointerId)return;
   drag.x=event.clientX;if(!drag.moved&&Math.abs(drag.x-drag.startX)<6)return;
   event.preventDefault();drag.moved=true;
   document.body.classList.add('dw-column-dragging');button.closest('th').classList.add('dw-column-moving');
   targetAt(drag.x);if(!frame)frame=requestAnimationFrame(autoScroll);
  });
  button.addEventListener('pointerup',event=>{if(drag?.id===event.pointerId)finish();});
  button.addEventListener('pointercancel',event=>{if(drag?.id===event.pointerId)finish(true);});
  button.addEventListener('lostpointercapture',()=>finish(true));
  button.addEventListener('click',event=>{if(suppressClick===button&&event.detail!==0){event.preventDefault();event.stopPropagation();suppressClick=null;}});
  button.addEventListener('keydown',event=>{
   if(event.key==='Escape'&&drag){event.preventDefault();event.stopPropagation();finish(true);return;}
   if(!event.altKey||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
   event.preventDefault();event.stopPropagation();finish(true);
   const key=button.dataset.sort,index=order.indexOf(key),next=event.key==='Home'?0:event.key==='End'?order.length-1:Math.max(0,Math.min(order.length-1,index+(event.key==='ArrowLeft'?-1:1)));
   if(index!==next)move(key,order[next],next>index);
   button.focus({preventScroll:true});button.scrollIntoView({block:'nearest',inline:'nearest'});
  });
 }
 document.querySelector('[data-columns-reset]')?.addEventListener('click',()=>{
  finish(true);order=[...defaults];refresh();save();resetWidths();scroll.scrollLeft=0;
  if(status)status.textContent='열 순서와 너비를 기본값으로 되돌렸습니다.';onActivity();
 });
 window.addEventListener('blur',()=>finish(true));window.addEventListener('resize',()=>finish(true));
 refresh();return {refresh,active:()=>Boolean(drag)};
}
