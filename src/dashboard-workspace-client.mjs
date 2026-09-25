import {renderExecutionHealth} from './dashboard-execution.mjs';
import {installLedgerTable} from './ledger-table.mjs';
import {workspaceColumnSets,workspaceColumns,workspaceColumnsFor,workspaceVisibleColumns,workspaceStatePresets,workspacePresetCounts,workspaceSelectedStates,workspaceStateLabel,workspaceRowsHtml,filterWorkspaceRows,sortWorkspaceRows,timeLabel,shortTimeLabel} from './dashboard-workspace.mjs';
import {workspaceWallHtml,workspaceMapHtml,canvasScriptHelpers} from './dashboard-canvas.mjs';
import {escapeHtml,stateText} from './dashboard-workspace-client-support.mjs';
import {installWorkspaceDetail} from './dashboard-detail-client.mjs';
import {installWorkspaceResize} from './dashboard-workspace-resize.mjs';
import {installWorkspaceColumns} from './dashboard-workspace-columns.mjs';

// 아래 함수는 직렬화되어 같은 페이지에서 실행된다. 카드와 업무 폼은 같은 저장·충돌 처리 경로를 쓴다.
function workspaceClient() {
 const $=selector=>document.querySelector(selector),$$=selector=>[...document.querySelectorAll(selector)];
 const data=JSON.parse($('#dw-data').textContent);let rows=data.rows;
 let state={...data.state,card:data.selected,opened:data.opened,tab:'summary',detailView:'table',expanded:false};
 let loadedKey=data.loadedKey,request=null,dirty=false,pending=false,saving=false,lastActivity=Date.now();
 let loadedAt=Date.now(),refreshing=false,refreshError='';
 let scroll={table:{top:0,left:0},split:{top:0,left:0}},navigation=0;
 const mobile=matchMedia('(max-width:799px)');
 const detailView=installWorkspaceDetail();
 const ledgerView=installLedgerTable(()=>{lastActivity=Date.now();refreshStatus();});
 // 너비 계산은 이 화면에 실제로 그려진 열만 쓴다. 컬렉션이 바뀌면 새로 읽어 열 구성을 맞춘다.
 const resizing=installWorkspaceResize(()=>{lastActivity=Date.now();},data.columns);
 const columns=installWorkspaceColumns(()=>{lastActivity=Date.now();},()=>resizing.resetColumns());
 // 옛 관제 요약(#overview)·판 현황(#boards)은 현황 안의 접힘 구역이 됐다(2026-09-12). 옛 주소는 현황으로 보낸다.
 const views={status:'현황',dashboard:'작업',cards:'작업',detail:'작업','card-list':'작업',decisions:'내 결정',overview:'현황','operations-flow':'업무 흐름','runner-settings':'실행 모델',boards:'현황',sessions:'담당자 세션',mailbox:'우편함',runs:'기록',ledger:'기록',create:'별도 실행 등록','work-create':'새 업무 만들기'};
 const activeView=()=>{const hash=location.hash.slice(1);return hash.startsWith('decision-')?'decisions':views[hash]?(hash==='cards'||hash==='detail'||hash==='card-list'?'dashboard':hash==='overview'||hash==='boards'?'status':hash):'status';};
 const filtered=()=>sortWorkspaceRows(filterWorkspaceRows(rows,state),state.sort,state.dir);
 function remember(){const el=$('#dw-scroll');if(el.getClientRects().length)scroll[state.layout]={top:el.scrollTop,left:el.scrollLeft};}
 function restore(){const el=$('#dw-scroll');if(el.getClientRects().length){el.scrollTop=scroll[state.layout].top;el.scrollLeft=scroll[state.layout].left;}}
 function entry(){return {scroll:structuredClone(scroll),card:state.card,detailTop:$('#dw-detail').scrollTop};}
 function saveCurrent(){remember();try{history.replaceState(entry(),'');}catch{status('이 창에서는 방문 위치를 저장할 수 없습니다.');}}
 function write(replace=false){
  const url=new URL(location.href);
  for(const key of ['collection','q','repo','board','health','rally','state','layout','axis','root','sort','dir']){if(state[key])url.searchParams.set(key,state[key]);else url.searchParams.delete(key);}
  if(state.card)url.searchParams.set('card',state.card);else url.searchParams.delete('card');
  url.searchParams.set('detail',state.opened?'1':'0');url.searchParams.set('tab',state.tab);url.searchParams.set('detailView',state.detailView);
  if(state.expanded)url.searchParams.set('expanded','1');else url.searchParams.delete('expanded');
  if(activeView()==='dashboard')url.hash=state.opened?'detail':'dashboard';
  try{history[replace?'replaceState':'pushState'](entry(),'',url);}catch{status('방문 기록을 저장하지 못했습니다. 화면에서 계속 읽을 수 있습니다.');}
 }
 function status(text){$('#dw-detail-status').textContent=text;const creation=$('#bw-create-status');if(creation)creation.textContent=text;}
 function focusCard(){
  const links=$$(state.layout==='table'?'.dw-card-title':'.dw-card-row');
  const el=links.find(a=>a.dataset.cardKey===state.card);
  if(el?.getClientRects().length)el.focus({preventScroll:true});else $('#dw-search').focus({preventScroll:true});
 }
 function showTab(tab,focus=false){
  const folds=$$('[data-detail-section]');
  if(folds.length){
   const target=folds.find(el=>el.dataset.detailSection===tab),article=$('article#detail');
   state.tab=target?tab:'summary';detailView.apply(state.detailView);
   if(target&&(focus||article.dataset.sectionShown!==state.tab)){
    for(let fold=target;fold;fold=fold.parentElement.closest('details'))fold.open=true;
    if(focus){target.querySelector('summary').focus({preventScroll:true});target.scrollIntoView({block:'nearest'});}
   }
   article.dataset.sectionShown=state.tab;return;
  }
  if(!$$('[data-tab]').some(el=>el.dataset.tab===tab))tab='summary';
  state.tab=tab;detailView.apply(state.detailView);
  $$('[data-tab]').forEach(el=>{const active=el.dataset.tab===tab;el.setAttribute('aria-selected',String(active));el.tabIndex=active?0:-1;$('#dw-panel-'+el.dataset.tab).hidden=!active;});
  if(focus)$('#dw-tab-'+tab)?.focus({preventScroll:true});
 }
 function render(){
  const visible=filtered(),table=state.layout==='table',split=state.layout==='split',wall=state.layout==='wall',map=state.layout==='map',cols=workspaceVisibleColumns(state.collection,rows);
  $('#dw-panes').classList.toggle('dw-table-layout',!split);$('#dw-panes').classList.toggle('dw-detail-open',state.opened);$('#dw-panes').classList.toggle('dw-expanded',state.expanded);
  const totalInCollection=(rows||[]).filter(c=>state.collection==='work'?c.kind==='work':c.kind!=='work'&&(state.collection!=='unlinked'||!c.parentWorkKey)).length;
  const filterName=workspaceStateLabel(state.state);
  $('#dw-count').textContent=rows===null||state.collection==='work'&&data.workError?'모름':visible.length===totalInCollection?('전체 '+totalInCollection+'장'):((state.q||state.repo||state.board||state.health||state.rally)?'조건':filterName)+' '+visible.length+'장 · 전체 '+totalInCollection+'장';
  $$('[data-collection]').forEach(el=>{
   el.setAttribute('aria-pressed',String(el.dataset.collection===state.collection));
   const count=el.querySelector('span');if(count)count.textContent=rows===null||data.workError?'모름':(rows||[]).filter(c=>el.dataset.collection==='work'?c.kind==='work':c.kind!=='work'&&(el.dataset.collection!=='unlinked'||!c.parentWorkKey)).length;
  });
  const heading=$('#dw-collection-title');if(heading)heading.textContent=({work:'업무 카드',executions:'실행',unlinked:'연결 전 실행'})[state.collection]||'카드';
  const help=$('#dw-work-help');if(help)help.hidden=state.collection!=='work';
  $('#dw-column-tools').hidden=!table;
  $('#dw-list').hidden=!split||rows===null;$('#dw-table').hidden=!table||rows===null;$('#dw-wall').hidden=!wall||rows===null;$('#dw-map').hidden=!map||rows===null;
  $('#dw-list').innerHTML=split&&rows!==null?workspaceRowsHtml(visible,'split',state.card,cols):'';
  // 사용자가 연 카드만 칠한다. 고르지 않은 첫 줄을 선택된 것처럼 보이지 않게(2026-09-25 UX). 목록·상세는 오른쪽에 보이는 카드를 칠한다.
  const marked=state.opened?state.card:'';
  $('#dw-table-body').innerHTML=table&&rows!==null?workspaceRowsHtml(visible,'table',marked,cols):'';if(wall&&rows!==null)$('#dw-wall').innerHTML=workspaceWallHtml(visible,marked,state.axis);if(map&&rows!==null)$('#dw-map').innerHTML=workspaceMapHtml(visible,marked,state.root,data.hierarchy||null,rows);
  $('#dw-empty').hidden=rows!==null&&visible.length>0;
  const emptyTitle=$('#dw-empty-title');if(emptyTitle)emptyTitle.textContent=state.collection==='work'&&data.workError?'업무 상태 모름':state.collection==='work'&&!(rows||[]).some(c=>c.kind==='work')?'아직 업무 카드가 없습니다.':'조건에 맞는 카드가 없습니다.';
  $$('[data-layout]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.layout===state.layout)));
  for(const [id,key] of [['dw-search','q'],['dw-board','board'],['dw-repo','repo'],['dw-health','health'],['dw-rally','rally']])$('#'+id).value=state[key];
  $('#dw-state-summary').textContent=filterName;
 const presetCounts=rows===null?null:workspacePresetCounts(rows,state);
 if(presetCounts)for(const el of $$('[data-preset-count]'))el.textContent=presetCounts[el.dataset.presetCount]??'';
 $$('#dw-presets [data-state-preset]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.statePreset===state.state)));
  $$('[data-state-option]').forEach(el=>{el.checked=workspaceSelectedStates(state.state).includes(el.value);});
  $$('[data-sort-column]').forEach(el=>{const active=el.dataset.sortColumn===state.sort;el.setAttribute('aria-sort',active?(state.dir==='asc'?'ascending':'descending'):'none');const button=el.querySelector('button');const title=button.querySelector('[data-column-label]');if(title)title.textContent=(state.collection==='work'?({stateLabel:'업무 상태',reportAt:'업무 기록',at:'관련 기록 갱신'})[el.dataset.sortColumn]:null)||cols.find(([key])=>key===el.dataset.sortColumn)?.[1]||'';(button.querySelector('[data-sort-arrow]')||button.querySelector('span')).textContent=active?(state.dir==='asc'?' ↑':' ↓'):' ↕';button.setAttribute('aria-label',button.textContent.replace(/[↑↓↕]/g,'')+' · '+(active&&state.dir==='asc'?'내림차순':'오름차순')+' 정렬');});
  const close=$('[data-detail-close]'),expand=$('[data-detail-expand]');close.textContent=table?'표로 돌아가기':'목록으로';expand.textContent=state.expanded?'나란히 보기':'상세 확대';expand.setAttribute('aria-expanded',String(state.expanded));
  columns.refresh();resizing.refresh();showTab(state.tab);refreshStatus();
 }
 function mayReplaceDetail(){if(saving){status('저장 중입니다. 완료 뒤 다른 카드를 열어주세요.');return false;}return !dirty||confirm('작성 중인 기록이 있습니다. 저장하지 않고 다른 카드로 이동할까요?');}
 function cancelLoad(){request?.abort();request=null;pending=false;}
 async function loadCard(key,{focus=true}={}) {
  if(saving){status('저장 중입니다. 완료 뒤 다른 카드를 열어주세요.');return;}
  cancelLoad();
  if(!key)return;
  if(loadedKey===key){if(focus)$('#dw-card-heading')?.focus({preventScroll:true});return;}
  const controller=new AbortController();request=controller;pending=true;loadedKey='';
  $('#dw-detail-content').innerHTML='<h2>카드를 읽는 중입니다.</h2><p>조회가 끝나면 선택한 카드의 내용과 관리 폼을 표시합니다.</p>';status('카드를 읽는 중입니다.');
  const current=()=>request===controller&&!controller.signal.aborted&&state.card===key;
  const url=new URL(location.href);url.searchParams.set('card',key);url.searchParams.set('detail','1');url.searchParams.set('partial','detail');url.hash='detail';
  try {
   const response=await fetch(url,{signal:controller.signal,credentials:'same-origin'});
   if(!response.ok)throw new Error('카드를 읽지 못했습니다. HTTP '+response.status);
   const html=await response.text();if(!current())return;
   const parsed=new DOMParser().parseFromString(html,'text/html'),article=parsed.querySelector('article#detail');
   if(!article||article.dataset.key!==key)throw new Error('요청한 카드의 상세를 확인할 수 없습니다.');
   $('#dw-detail-content').replaceChildren(document.importNode(article,true));loadedKey=key;dirty=false;showTab(state.tab);$('#dw-detail').scrollTop=0;status('상세를 새로 읽었습니다. 목록은 이전 수집 시점입니다.');
   if(focus)$('#dw-card-heading')?.focus({preventScroll:true});
  }catch(error){if(current()&&error.name!=='AbortError'){loadedKey='';$('#dw-detail-content').innerHTML='<h2>상세 상태 모름</h2><p>'+escapeHtml(error.message)+'</p><button type="button" data-detail-retry>다시 읽기</button>';status('조회 실패 · 자동 재시도하지 않습니다.');}}
  finally{if(request===controller){request=null;pending=false;refreshStatus();}}
 }
 function change(patch,{replace=false,focus='',reset=false}={}){
  const generation=++navigation;
  saveCurrent();Object.assign(state,patch);if(reset)scroll={table:{top:0,left:0},split:{top:0,left:0}};render();write(replace);
  requestAnimationFrame(()=>{if(generation!==navigation)return;restore();if(focus==='card')focusCard();else if(focus)$(focus)?.focus({preventScroll:true});});
 }
 function closeDetail(){if(saving){status('저장 중입니다. 완료 뒤 닫아주세요.');return;}cancelLoad();change({opened:false,expanded:false},{focus:'card'});}
 function openCard(key){
  if(!(rows||[]).some(c=>c.key===key))return;
  if(loadedKey!==key&&!mayReplaceDetail())return;
  if(loadedKey!==key)dirty=false;
  if(!state.opened){state.card=key;write(true);}
  const row=(rows||[]).find(c=>c.key===key);
  const collection=state.collection?(row?.kind==='work'?'work':state.collection==='unlinked'&&!row?.parentWorkKey?'unlinked':'executions'):'';
  // 업무 카드와 실행 카드는 열 구성이 다르다. 그 전환은 서버가 표 머리글을 다시 그리도록 새로 읽는다.
  if((collection==='work')!==(state.collection==='work')){saveCurrent();Object.assign(state,{card:key,collection,opened:true,expanded:false});write(true);location.reload();return;}
  change({card:key,collection,opened:true,expanded:false});loadCard(key);
 }
 function route(){
  const view=activeView();$$('[data-view]').forEach(el=>el.hidden=el.dataset.view!==view);
  // 기록의 작업별 보기는 '기록', 업무 흐름은 작업 화면의 보기 하나라 '작업'에 위치를 표시한다.
  $$('[data-route]').forEach(el=>{const selected=el.dataset.route===(view==='runs'?'ledger':view==='operations-flow'?'dashboard':view);if(selected)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
  // 운영 메뉴 안 화면이면 접힌 '운영 메뉴' 글자에도 현재 위치를 표시한다(2026-09-24 UX 검토).
  $('.dw-more')?.classList.toggle('dw-more-current',['sessions','runner-settings','work-create','create'].includes(view));
  $('#page-title').textContent=views[view]||'작업';
  if(location.hash.startsWith('#decision-')){const target=document.getElementById(decodeURIComponent(location.hash.slice(1)));target?.closest('details')?.setAttribute('open','');target?.scrollIntoView({block:'start'});}
  refreshStatus();
 }
 function readLocation(){
  const q=new URLSearchParams(location.search);
  state={...state,collection:data.state.collection?(['work','executions','unlinked'].includes(q.get('collection'))?q.get('collection'):q.get('card')&&!q.get('card').startsWith('work:')?'executions':'work'):'',q:q.get('q')||'',repo:q.get('repo')||'',board:q.get('board')||'',health:q.get('health')||'',rally:q.get('rally')||'',state:q.get('state')||'',layout:['table','split','wall','map'].includes(q.get('layout'))?q.get('layout'):'table',axis:q.get('axis')==='step'?'step':'status',root:q.get('root')==='role'?'role':'work',sort:data.columns.some(([k])=>k===q.get('sort'))?q.get('sort'):'attention',dir:q.get('dir')==='asc'?'asc':'desc',tab:q.get('tab')||'summary',detailView:q.get('detailView')==='document'?'document':'table',card:q.get('card')||data.selected,opened:q.has('card')&&q.get('detail')!=='0',expanded:q.get('expanded')==='1'};
  if(!state.opened)state.expanded=false;
  // 새로 읽기 표시는 한 번만 쓴다. 주소를 깨끗이 해야 다음 자동 갱신이 캐시를 쓴다.
  if(location.search.includes('fresh=')){const clean=new URL(location.href);clean.searchParams.delete('fresh');try{history.replaceState(history.state,'',clean);}catch{}}
  // 결정 답변 토스트도 한 번만 보인다. 새로 읽기·자동 갱신에서 다시 뜨지 않게 주소에서 뺀다.
  if(location.search.includes('decisionAnswered=')){const clean=new URL(location.href);clean.searchParams.delete('decisionAnswered');try{history.replaceState(history.state,'',clean);}catch{}}
 }
 async function restoreHistory(){
  const generation=++navigation;
  const previous={...state};readLocation();
  if((saving||state.card!==loadedKey)&&!mayReplaceDetail()){state=previous;write(true);route();return;}
  const saved=history.state;if(saved?.scroll)scroll=structuredClone(saved.scroll);
  render();route();
  const needs=activeView()==='dashboard'&&(state.opened||state.layout==='split');
  if(needs)await loadCard(state.card,{focus:false});else cancelLoad();
  if(generation!==navigation)return;
  requestAnimationFrame(()=>{if(generation!==navigation)return;restore();if(saved?.detailTop!=null)$('#dw-detail').scrollTop=saved.detailTop;if(activeView()==='dashboard'){if(state.opened)$('#dw-card-heading')?.focus({preventScroll:true});else focusCard();}});
 }
 const refreshOff=new URLSearchParams(location.search).get('refresh')==='0';
 function paused(){return activeView()==='operations-flow'||resizing.active()||columns.active()||ledgerView.paused()||dirty||pending||saving||document.hidden||Boolean(document.querySelector('details[open]'))||state.opened||Boolean(document.querySelector('.dw-management[open]'))||Boolean(document.activeElement?.matches('input,textarea,select,[contenteditable="true"]'))||Boolean(window.getSelection()?.toString())||activeView()==='decisions'||(activeView()==='dashboard'&&state.layout==='split'&&Boolean(loadedKey))||$('main').scrollTop>0||$('#dw-detail').scrollTop>0||$('#dw-scroll').scrollTop>0||$('#dw-scroll').scrollLeft>0||Date.now()-lastActivity<15000;}
 // 작업 화면은 페이지를 다시 불러오지 않고 받은 자료로 목록만 다시 그린다. 스크롤·연 카드·펼친 칸이 남으므로 입력·저장·끌기 중에만 기다린다(2026-09-25).
 function blocked(){return resizing.active()||columns.active()||dirty||pending||saving||document.hidden||Boolean(document.activeElement?.matches('input,textarea,select,[contenteditable="true"]'))||Boolean(window.getSelection()?.toString());}
 async function refreshData(){
  refreshing=true;
  try{
   const response=await fetch(location.href,{credentials:'same-origin',cache:'no-store'});
   if(!response.ok)throw new Error('HTTP '+response.status);
   const parsed=new DOMParser().parseFromString(await response.text(),'text/html'),next=JSON.parse(parsed.querySelector('#dw-data')?.textContent||'null');
   if(!next)throw new Error('목록 자료 없음');
   if(blocked()||activeView()!=='dashboard')return;
   // 표 머리글은 서버가 그린다. 보이는 열이 바뀌면 페이지를 다시 불러온다. 입력·저장 중이 아님은 위에서 확인했고 스크롤·연 카드는 방문 기록으로 되살린다.
   if((next.columns||[]).map(c=>c[0]).join()!==(data.columns||[]).map(c=>c[0]).join()){saveCurrent();location.reload();return;}
   const focusedKey=document.activeElement?.dataset?.cardKey||'';
   remember();rows=data.rows=next.rows;data.workError=next.workError;data.hierarchy=next.hierarchy;
   for(const id of ['dw-board','dw-repo','dw-health','dw-rally']){const fresh=parsed.querySelector('#'+id);if(fresh&&$('#'+id))$('#'+id).innerHTML=fresh.innerHTML;}
   render();restore();
   if(focusedKey)$$('[data-card-key]').find(a=>a.dataset.cardKey===focusedKey&&a.getClientRects().length)?.focus({preventScroll:true});
   for(const selector of ['[data-route="decisions"] .dw-decision-count','[data-route="mailbox"] .dw-decision-count','#dw-collected']){const fresh=parsed.querySelector(selector),el=$(selector);if(fresh&&el){el.textContent=fresh.textContent;const label=fresh.getAttribute('aria-label');if(label)el.setAttribute('aria-label',label);}}
   // 보이지 않는 현황은 통째로 바꾸되 펼쳐 둔 칸은 다시 펼친다.
   const view=$('[data-view="status"]'),freshView=parsed.querySelector('[data-view="status"]');
   if(view&&freshView&&view.hidden){const open=$$('[data-view="status"] details[open][id]').map(el=>el.id);view.innerHTML=freshView.innerHTML;for(const id of open){const el=document.getElementById(id);if(el)el.open=true;}}
   const loaded=(rows||[]).find(c=>c.key===loadedKey),article=$('article#detail');
   if(loaded&&article&&loaded.revision!=null&&String(loaded.revision)!==article.dataset.revision)status('이 카드 내용이 바뀌었습니다. 카드를 다시 열면 새 내용을 봅니다.');
   loadedAt=Date.now();refreshError='';
  }catch(error){refreshError=error.message||'알 수 없음';}
  finally{refreshing=false;refreshStatus();}
 }
 function refreshStatus(){const el=$('#dw-refresh-status');if(!el)return;const dash=activeView()==='dashboard',hold=dash?blocked():paused();el.textContent=activeView()==='operations-flow'?'업무 흐름은 새로 읽기로 갱신합니다.':refreshOff?'자동 갱신 꺼짐':refreshError?'목록을 받지 못했습니다 · 다음 주기에 다시 받습니다.':hold?(dash?'갱신 보류 · 입력·저장이 끝나면 이어서 받습니다.':'갱신 보류 · 읽기·작성 위치를 유지합니다.'):dash?'목록을 15초마다 이어서 받습니다.':'목록을 15초마다 갱신합니다.';el.classList.toggle('dw-refresh-warning',!refreshOff&&(hold||Boolean(refreshError)));
  // 자료가 1분 넘게 새로 오지 않으면 상태줄 앞쪽에 자료 나이를 눈에 띄게 적는다(2026-09-25 UX). 화면 위에 띄우면 좁은 화면에서 메뉴를 가렸다.
  const stale=$('#dw-stale');if(stale){const age=Math.floor((Date.now()-loadedAt)/60000),show=!refreshOff&&activeView()!=='operations-flow'&&age>=1;stale.hidden=!show;el.hidden=show;if(show)stale.textContent=age+'분 전 자료 · 자동 갱신 멈춤';}}
 document.addEventListener('click',event=>{
  lastActivity=Date.now();
  const toastClose=event.target.closest?.('[data-toast-close]');if(toastClose){toastClose.closest('.decision-toast')?.remove();return;}
  if(detailView.click(event))return;
  const link=event.target.closest('a');
  const href=link?.getAttribute('href')?.trim()||'';
  if(link&&link.getAttribute('data-work-page')===null&&href&&!href.startsWith('#')&&!(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)&&event.button===0){
   const url=new URL(link.href,location.href);
   const key=link.getAttribute('data-card-key')||(url.hash==='#detail'&&href.split('#')[0].includes('?')?url.searchParams.get('card'):null);
   if(url.origin===location.origin&&url.pathname===location.pathname&&key&&(rows||[]).some(c=>c.key===key)){event.preventDefault();if(activeView()!=='dashboard'){location.hash='dashboard';route();}openCard(key);return;}
  }
  const button=event.target.closest('button');
  if(!button){const row=event.target.closest('[data-card-row]');if(row&&!window.getSelection()?.toString())openCard(row.dataset.cardRow);return;}
  if(button.classList.contains('copy-question')){const feedback=button.closest('[data-view]')?.querySelector('.copy-feedback')||$('.copy-feedback');const what=button.dataset.copyLabel||'질문';navigator.clipboard.writeText(button.dataset.question).then(()=>{if(feedback)feedback.textContent=what+'을(를) 복사했습니다.';},()=>{if(feedback)feedback.textContent='복사하지 못했습니다. '+what+'을(를) 직접 선택해 복사하세요.';});}
  else if(button.dataset.collection){
   if(!mayReplaceDetail())return;dirty=false;cancelLoad();
   const collection=button.dataset.collection;
   const target=sortWorkspaceRows(filterWorkspaceRows(rows,{...state,collection,q:'',board:'',repo:'',state:state.state}),state.sort,state.dir)[0]?.key||'';
   const patch={collection,card:target,q:'',board:'',repo:'',opened:false,expanded:false};
   // 업무 표와 실행 표는 열 구성이 다르다. 그 전환은 서버가 머리글을 다시 그리도록 새로 읽는다.
   if((collection==='work')!==(state.collection==='work')){saveCurrent();Object.assign(state,patch);write();location.reload();return;}
   change(patch,{reset:true});
   if(state.layout==='split')loadCard(target,{focus:false});
  }
  else if(button.hasAttribute('data-state-preset'))change({state:button.dataset.statePreset,opened:false,expanded:false},{reset:true});
  else if(button.dataset.detailView){state.detailView=button.dataset.detailView;detailView.apply(state.detailView);$('#dw-detail').scrollTop=0;write(true);}
  else if(button.dataset.layout){change({layout:button.dataset.layout,opened:false,expanded:false});if(state.layout==='split')loadCard(state.card,{focus:false});}
  else if(button.dataset.axis)change({axis:button.dataset.axis,opened:false,expanded:false});
  else if(button.dataset.root)change({root:button.dataset.root,opened:false,expanded:false});
  else if(button.dataset.sort){const sort=button.dataset.sort;change({sort,dir:state.sort===sort&&state.dir==='asc'?'desc':'asc'},{focus:'[data-sort="'+sort+'"]',reset:true});}
  else if(button.hasAttribute('data-detail-close'))closeDetail();
  else if(button.hasAttribute('data-detail-expand'))change({expanded:!state.expanded,opened:true},{focus:'[data-detail-expand]'});
  else if(button.hasAttribute('data-detail-retry'))loadCard(state.card);
  else if(button.dataset.tab||button.dataset.readTab){showTab(button.dataset.tab||button.dataset.readTab,true);write(true);}
  // 초기화는 처음 화면과 같은 '미완료'로 돌아간다('전체'가 아니라).
  else if(button.hasAttribute('data-workspace-reset'))change({q:'',repo:'',board:'',health:'',rally:'',state:''},{reset:true,focus:'#dw-search'});
  else if(button.hasAttribute('data-refresh')){if(activeView()==='operations-flow'){window.dispatchEvent(new CustomEvent('operations-flow-refresh'));return;}if(!saving&&(!dirty||confirm('작성 중인 기록을 저장하지 않고 새로 읽을까요?'))){dirty=false;saveCurrent();const fresh=new URL(location.href);fresh.searchParams.set('fresh',String(Date.now()));location.replace(fresh);}}
 });
 for(const [id,key,event] of [['dw-search','q','input'],['dw-board','board','change'],['dw-repo','repo','change'],['dw-health','health','change'],['dw-rally','rally','change']])$('#'+id).addEventListener(event,e=>{lastActivity=Date.now();change({[key]:e.target.value,opened:false,expanded:false},{replace:event==='input',reset:true});});
 $('#dw-state').addEventListener('change',event=>{
  if(!event.target.matches('[data-state-option]'))return;
  lastActivity=Date.now();
  const selected=$$('[data-state-option]').filter(el=>el.checked).map(el=>el.value);
  change({state:selected.length===Object.keys(stateText).length?'all':selected.join(',')||'none',opened:false,expanded:false},{reset:true});
 });
 document.addEventListener('pointerdown',event=>{if(!event.target.closest('#dw-state'))$('#dw-state').open=false;});
 $('#dw-state').addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();$('#dw-state').open=false;$('#dw-state summary').focus({preventScroll:true});}});
 document.addEventListener('input',e=>{detailView.input(e);if(e.target.closest('form[method="post"]')){dirty=true;refreshStatus();}});
 document.addEventListener('change',e=>{if(e.target.closest('form[method="post"]')){dirty=true;refreshStatus();}});
 document.addEventListener('submit',async event=>{
  const form=event.target;
  if(!form.matches('form[method="post"]'))return;
  const action=new URL(form.action,location.href).pathname;
  if(action!=='/cards/update'&&!action.startsWith('/works/')){dirty=false;return;}
  event.preventDefault();if(saving)return;
  const fields=new FormData(form),creating=action==='/works/create',key=(creating?'work:':'')+String(fields.get('key')),revision=creating?0:Number(fields.get('revision'));
  if(!creating&&(pending||!loadedKey||key!==loadedKey||key!==state.card)){status('선택한 카드의 조회가 끝난 뒤 해당 폼에서 저장해주세요.');return;}
  const controls=[...form.querySelectorAll('button,input,select,textarea')].map(el=>({el,disabled:el.disabled}));saving=true;dirty=true;controls.forEach(({el})=>el.disabled=true);status('기록을 저장하는 중입니다.');refreshStatus();
  try {
   const response=await fetch(form.action,{method:'POST',credentials:'same-origin',body:new URLSearchParams(fields)});
   const html=await response.text();
   if(!response.ok)throw new Error(html||'저장 실패. HTTP '+response.status);
   const parsed=new DOMParser().parseFromString(html,'text/html'),article=parsed.querySelector('article#detail');
   const updatedData=parsed.querySelector('#dw-data');
   const freshRows=updatedData?JSON.parse(updatedData.textContent).rows:null;
   const updated=freshRows?.find(c=>c.key===key);
   if(!article||article.dataset.key!==key||Number(article.dataset.revision)!==revision+1||!updated||updated.revision!==revision+1)throw new Error('저장 응답을 확인할 수 없습니다. 작성 내용은 유지했습니다. 다시 저장하기 전에 최신 기록을 확인하세요.');
   if(action.startsWith('/works/'))rows.splice(0,rows.length,...freshRows);
   else {const rowIndex=rows.findIndex(c=>c.key===key);if(rowIndex>=0)rows[rowIndex]=updated;for(const work of freshRows.filter(c=>c.kind==='work')){const index=rows.findIndex(c=>c.key===work.key);if(index>=0)rows[index]=work;}}
   const top=$('#dw-detail').scrollTop,openSections=$$('[data-detail-section][open]').map(el=>el.dataset.detailSection);
   $('#dw-detail-content').replaceChildren(document.importNode(article,true));loadedKey=key;dirty=false;
   if(creating){Object.assign(state,{card:key,collection:'work',opened:true,tab:'summary',q:'',board:'',repo:'',state:'all'});location.hash='detail';route();write(true);form.reset();}
   render();showTab(state.tab);if(!creating)$$('[data-detail-section]').forEach(el=>{if(openSections.includes(el.dataset.detailSection))el.open=true;});$('#dw-detail').scrollTop=creating?0:top;
   status('저장했습니다. 선택한 카드와 목록의 해당 행을 갱신했습니다.');
  }catch(error){dirty=true;status(error.message);}
  finally{saving=false;controls.forEach(({el,disabled})=>el.disabled=disabled);refreshStatus();}
 });
 window.addEventListener('beforeunload',e=>{if(dirty||saving){e.preventDefault();e.returnValue='';}});
 document.addEventListener('keydown',event=>{
  lastActivity=Date.now();
  if(event.key==='Escape'&&activeView()==='dashboard'){if(state.expanded){event.preventDefault();change({expanded:false});}else if(state.opened){event.preventDefault();closeDetail();}}
  const tab=event.target.closest('[data-tab]');if(!tab||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  event.preventDefault();const list=$$('[data-tab]'),index=list.indexOf(tab),next=event.key==='Home'?0:event.key==='End'?list.length-1:(index+(event.key==='ArrowLeft'?-1:1)+list.length)%list.length;showTab(list[next].dataset.tab,true);write(true);
 });
 for(const el of [$('#dw-scroll'),$('#dw-detail'),$('main')])el.addEventListener('scroll',()=>{lastActivity=Date.now();refreshStatus();},{passive:true});
 window.addEventListener('popstate',restoreHistory);window.addEventListener('hashchange',()=>{route();});
 readLocation();render();route();
 if(history.state?.scroll)scroll=structuredClone(history.state.scroll);
 requestAnimationFrame(restore);
 if(!refreshOff)setInterval(()=>{refreshStatus();if(activeView()==='dashboard'){if(!refreshing&&!blocked())refreshData();}else if(!paused()){saveCurrent();location.reload();}},15000);
}
export const dashboardWorkspaceScript=`const renderExecutionHealth=${renderExecutionHealth.toString()};const installLedgerTable=${installLedgerTable.toString()};const installWorkspaceDetail=${installWorkspaceDetail.toString()};const installWorkspaceResize=${installWorkspaceResize.toString()};const installWorkspaceColumns=${installWorkspaceColumns.toString()};const e=${escapeHtml.toString()};const escapeHtml=e;const stateText=${JSON.stringify(stateText)};const statePill=c=>\`<span class="state \${e(c.state||c.displayState)}">\${e(c.stateLabel||stateText[c.displayState]||'모름')}</span>\`;const timeLabel=${timeLabel.toString()};const shortTimeLabel=${shortTimeLabel.toString()};const workspaceColumnSets=${JSON.stringify(workspaceColumnSets)};const workspaceColumns=${JSON.stringify(workspaceColumns)};const workspaceColumnsFor=${workspaceColumnsFor.toString()};const workspaceVisibleColumns=${workspaceVisibleColumns.toString()};const workspaceStatePresets=${JSON.stringify(workspaceStatePresets)};const workspacePresetCounts=${workspacePresetCounts.toString()};const workspaceSelectedStates=${workspaceSelectedStates.toString()};const workspaceStateLabel=${workspaceStateLabel.toString()};const workspaceRowsHtml=${workspaceRowsHtml.toString()};${canvasScriptHelpers}const workspaceWallHtml=${workspaceWallHtml.toString()};const workspaceMapHtml=${workspaceMapHtml.toString()};const filterWorkspaceRows=${filterWorkspaceRows.toString()};const sortWorkspaceRows=${sortWorkspaceRows.toString()};(${workspaceClient.toString()})();`;
