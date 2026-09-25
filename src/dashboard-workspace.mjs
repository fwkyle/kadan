import {executionHealth,renderExecutionHealth,executionBucket} from './dashboard-execution.mjs';
import {cardTurn} from './card-turn.mjs';
import {renderCardInbox} from './dashboard-inbox.mjs';
import {approvedDetailGuide} from './dashboard-detail-guides.mjs';
import {escapeHtml as e,renderCardDocument} from './card-content.mjs';
import {stateText,progressLabel,currentProgressReport} from './human-brief.mjs';
import {renderDetailSummary,renderInstructionTable,renderDetailHistory,detailEvents,renderDetailSections} from './dashboard-detail.mjs';
import {buildCardFlows,cardPurpose,renderCardFlow,renderRallyFlow} from './dashboard-flow.mjs';
import {workspaceWallHtml,workspaceMapHtml} from './dashboard-canvas.mjs';

// 열 키 · 화면 이름 · 기본 너비 · 최소 너비. 저장된 배치는 키로 연결한다.
export const workspaceColumns=[['title','카드 · 목적',290,180],['healthLabel','실행 흐름',145,130],['signalAt','최근 실행 신호',135,120],['flowLabel','티키타카',170,110],['turnLabel','현재 차례',140,110],['model','실행 모델',110,90],['stateLabel','카드 상태',105,90],['next','다음 행동',200,100],['board','판',110,80],['reportAt','마지막 보고',110,100],['at','카드 수정',110,100]];
// 기본 표는 여섯 열만 그린다(실행 990px · 업무 960px). 다음 행동·판·마지막 보고·카드 수정은 상세에서 확인한다(2026-09-18).
// 화면이 열 너비 합보다 넓으면 표를 화면 폭까지 늘리고 남는 폭은 열 비율대로 나눈다(2026-09-25 UX: 넓은 화면에서 2/3만 썼다).
// 실행 표에는 카드 상태를 두지 않는다. 실행 흐름이 같은 값을 근거와 함께 보여준다.
const columnByKey=new Map(workspaceColumns.map(column=>[column[0],column]));
const pickColumns=keys=>keys.map(key=>columnByKey.get(key));
export const workspaceColumnSets={
 work:pickColumns(['title','stateLabel','healthLabel','flowLabel','turnLabel','model']),
 execution:pickColumns(['title','healthLabel','signalAt','flowLabel','turnLabel','model'])
};
export function workspaceColumnsFor(collection){return collection==='work'?workspaceColumnSets.work:workspaceColumnSets.execution;}
// 값이 하나도 없는 열은 표 머리글까지 남기지 않는다. 실행 모델은 대부분의 카드에서 빈 칸이다.
export function workspaceVisibleColumns(collection,rows){return workspaceColumnsFor(collection).filter(([key])=>key!=='model'||(rows||[]).some(row=>row.model));}
export const timeLabel=value=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false}):'모름';
const clip=(value,n=220)=>String(value??'').slice(0,n);
// 진행 중인 카드만 현재 모델을 말한다. 종료 카드의 최신 시작 기록은 지금 돌고 있는 모델이 아닐 수 있어 빈 칸으로 둔다.
const terminalState=new Set(['done','cancelled','superseded','archived']);
const roleModel=(center,role,state)=>{
 if(!role||terminalState.has(state))return {short:'',effort:'',title:''};
 const m=center?.models?.[role];
 if(!m?.model)return {short:'',effort:'',title:''};
 // 원장에 적힌 --model 문자열을 그대로 옮긴다. 띄울 때 명령에 남은 인용부호만 걷어낸다.
 const short=String(m.model).split('/').at(-1).replace(/^["']+|["']+$/g,'').trim();
 return {short,effort:m.effort||'',title:[m.harness,m.model,m.effort?'강도 '+m.effort:'',m.at?'시작 '+shortTimeLabel(m.at):''].filter(Boolean).join(' · ')};
};
export function workspaceModel(center,briefs) {
 if(!center)return null;
 const flows=buildCardFlows(center.cards);
 return center.cards.map(c=>{
  const brief=briefs?.get(c.key),report=currentProgressReport(c),turn=cardTurn(c),flow=flows.get(c.key),purpose=cardPurpose(c,brief);
  const reportState=brief?.reportState||report.state;
  const reportAt=brief?.reportState?brief.evidenceAt:report.at;
  const running=roleModel(center,c.role,c.displayState);
  return {...executionHealth(c),key:c.key,id:c.id,repo:c.repo,title:brief?.title||c.title||c.id,originalTitle:c.title||c.id,state:c.displayState,stateLabel:stateText[c.displayState]||'모름',
  stored:c.status,board:c.board||'',owner:c.role||'',at:c.at||null,reportAt,
   model:running.short,effort:running.effort,modelTitle:running.title,
   purpose:clip(purpose.text),flowLabel:flow.linked?flow.label:(c.workType==='coordination'?'관리·조율':''),flowPhase:flow.linked?(flow.older?`최신 ${flow.group.round}라운드 · ${flow.phase}`:flow.phase):'',flowTitle:flow.group?.title||'',
   rallyStep:c.rallyStep||'',turnLabel:turn.label,turnOwner:turn.owner,turnReason:turn.reason,turnSource:turn.source,turnAt:turn.at,turnBy:turn.by,
   reportState,reportLabel:reportState==='unknown'?'보고 확인 불가':reportState==='none'?'보고 없음':timeLabel(reportAt),
   next:clip(c.nextAction||brief?.next||''),nextOwner:c.resolutionOwner||'',
   summary:clip(brief?.summary||''),scope:clip(c.scope),workType:c.workType||'execution',revision:c.revision};
 });
}
export function workspaceSelectedStates(value='') {
 const keys=Object.keys(stateText);
 if(value==='all')return keys;
 if(!value)return keys.filter(key=>!['done','cancelled','superseded','archived'].includes(key));
 return [...new Set(String(value).split(','))].filter(key=>keys.includes(key));
}
export function workspaceStateLabel(value='') {
 if(!value)return '미완료';
 if(value==='all')return '전체';
 const all=Object.keys(stateText),selected=workspaceSelectedStates(value);
 if(!selected.length)return '선택 없음';
 if(selected.length===all.length)return '전체';
 // 고른 이름이 많으면 뺀 이름으로 말한다. '상태 12개'처럼 세는 표시는 무엇을 보는지 알려주지 않는다.
 const excluded=all.filter(key=>!selected.includes(key));
 if(excluded.length<=2)return excluded.map(key=>stateText[key]).join('·')+' 제외';
 if(selected.length<=2)return selected.map(key=>stateText[key]).join('·');
 return `상태 ${selected.length}개`;
}
// 상태 빠른 선택. 자주 쓰는 묶음을 한 번에 고르며 값 형식은 상태 필터와 같다.
export const workspaceStatePresets=[['','미완료'],['running,waiting','진행 중·대기'],['draft,ready','발령 전'],['assigned,unconfirmed,orphaned,failed','확인 필요'],['done','완료'],['all','전체']];
export function workspacePresetCounts(rows,state){
 const counts={};
 for(const [value] of workspaceStatePresets)counts[value]=filterWorkspaceRows(rows,{...state,state:value}).length;
 return counts;
}
export function filterWorkspaceRows(rows,state) {
 const words=String(state.q||'').trim().toLocaleLowerCase('ko').split(/\s+/).filter(Boolean);
 const terminal=['done','cancelled','superseded','archived'];
 return (rows||[]).filter(c=>(!state.collection||(state.collection==='work'?c.kind==='work':c.kind!=='work'&&(state.collection!=='unlinked'||!c.parentWorkKey)))&&(!state.repo||c.repo===state.repo)&&(!state.board||c.board===state.board)&&(!state.health||(state.health==='stuck'?c.bucket==='stuck':c.healthLabel===state.health))&&(!state.rally||c.flowTitle===state.rally)&&
  (!state.state?!terminal.includes(c.state):state.state==='all'||(state.state!=='none'&&String(state.state).split(',').includes(c.state)))&&
  words.every(word=>[c.title,c.purpose,c.key,c.board,c.owner,c.model,c.turnLabel,c.turnReason,c.flowLabel,c.flowPhase,c.flowTitle,c.summary,c.scope,c.next,c.nextOwner].join(' ').toLocaleLowerCase('ko').includes(word)));
}
export function sortWorkspaceRows(rows,key='at',direction='desc') {
 if(key==='attention')return [...rows].sort((a,b)=>{
  const rank=c=>c.healthKind?({attention:0,running:1,waiting:2,planned:3,hold:4,closed:5})[c.healthKind]??0:({unconfirmed:0,orphaned:1,failed:2})[c.state]??3;
  const d=rank(a)-rank(b);if(d)return d;
  const at=Date.parse(a.signalAt||a.at)||0,bt=Date.parse(b.signalAt||b.at)||0;if(at!==bt)return bt-at;
  return a.key.localeCompare(b.key);
 });
 const field=workspaceColumns.some(([name])=>name===key)?key:'at';
 return [...rows].sort((a,b)=>{
  const av=a[field],bv=b[field];if(av==null||av===''||bv==null||bv==='')return (av==null||av==='')?(bv==null||bv===''?a.key.localeCompare(b.key):1):-1;
  return (String(av).localeCompare(String(bv),'ko',{numeric:true})*(direction==='asc'?1:-1))||a.key.localeCompare(b.key);
 });
}
const statePill=c=>`<span class="state ${e(c.state||c.displayState)}">${e(c.stateLabel||stateText[c.displayState]||'모름')}</span>`;
export function shortTimeLabel(value) {
 if(!Number.isFinite(Date.parse(value)))return '모름';
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value)).map(p=>[p.type,p.value]));
 return `${parts.month}.${parts.day} ${parts.hour}:${parts.minute}`;
}
// 표는 넘겨받은 열 순서대로 셀을 조립한다. 실행 표에는 카드 상태 열이 없고, 값이 없는 실행 모델 열도 빠진다.
export function workspaceRowsHtml(rows,layout,selected,columns=workspaceColumns) {
 if(layout==='table')return rows.map(c=>{

  // 끝난 실행과 아직 시작하지 않은 초안은 라벨만으로 충분하다. 같은 설명을 모든 줄에 반복하지 않는다.
  const showReason=!['closed','planned'].includes(c.healthKind);
  const signal=c.signalAt?shortTimeLabel(c.signalAt):'';
  // 종료·미기록은 다음 행동자가 정해지지 않은 상태다. '차례 확인 필요'를 기본값으로 깔지 않는다.
  const turn=c.turnLabel||'',showTurn=Boolean(turn)&&!['종료','차례 확인 필요'].includes(turn);
  const cells={
   title:`<td data-column="title"><a class="dw-card-title" data-card-key="${e(c.key)}" href="?card=${encodeURIComponent(c.key)}#detail" aria-current="${selected===c.key}" title="${e(c.originalTitle||c.title)}"><span>${e(c.title)}</span><small class="${c.purpose?'dw-card-purpose':''}" title="${e(c.purpose||c.id)}">${e(c.purpose||c.id)}</small></a></td>`,
   healthLabel:`<td data-column="healthLabel" class="dw-health-cell" title="${e(c.healthReason)}">${renderExecutionHealth(c)}${showReason?`<small>${e(c.healthReason)}</small>`:''}</td>`,
   signalAt:`<td data-column="signalAt" class="dw-health-cell" title="${e(c.signalAt?timeLabel(c.signalAt):c.signalLabel)}"><strong>${e(signal||'신호 없음')}</strong>${signal?`<small>${e(c.signalLabel)}</small>`:''}</td>`,
   flowLabel:`<td data-column="flowLabel" class="dw-flow-cell" title="${e([c.flowTitle,c.flowLabel,c.flowPhase].filter(Boolean).join(' · '))}"><strong>${e(c.flowLabel)}</strong><small>${e(c.flowPhase)}</small></td>`,
   turnLabel:`<td data-column="turnLabel" class="dw-turn-cell" title="${e(c.turnReason)}">${showTurn?`<strong>${e(turn)}</strong>${c.turnSource?`<small>${e(c.turnSource)}</small>`:''}`:''}</td>`,
   model:`<td data-column="model" class="dw-model-cell" title="${e(c.modelTitle)}"><strong>${e(c.model||'')}</strong>${c.effort?`<small>강도 ${e(c.effort)}</small>`:''}</td>`,
   stateLabel:`<td data-column="stateLabel" title="${e(c.stateLabel)}">${statePill(c)}</td>`,
   next:`<td data-column="next" title="${e(c.next)}">${e(c.next||'기록 없음')}</td>`,
   board:`<td data-column="board" title="${e(c.board)}">${e(c.board||'판 미지정')}</td>`,
   reportAt:`<td data-column="reportAt" title="${e(c.reportLabel)}">${e(c.reportAt?shortTimeLabel(c.reportAt):c.reportLabel)}</td>`,
   at:`<td data-column="at" title="${e(timeLabel(c.at))}">${e(shortTimeLabel(c.at))}</td>`
  };
  return `<tr data-card-row="${e(c.key)}" class="${selected===c.key?'selected':''}">${columns.map(([key])=>cells[key]||'').join('')}</tr>`;
 }).join('');
 return rows.map(c=>{
  const turn=c.turnLabel||'',showTurn=Boolean(turn)&&!['종료','차례 확인 필요'].includes(turn);
  return `<li><a class="dw-card-row" data-card-key="${e(c.key)}" href="?card=${encodeURIComponent(c.key)}#detail" aria-current="${selected===c.key}"><span class="dw-row-meta">${renderExecutionHealth(c)} ${statePill(c)} <small>${e(c.id)} · ${c.kind==='work'?'업무 카드':c.workType==='coordination'?'관리·조율':'실행 작업'}</small></span><strong>${e(c.title)}</strong><span>${e(c.purpose||c.summary||c.next||'상세에서 작업 지시를 확인하세요.')}</span>${[c.flowLabel,c.flowPhase].filter(Boolean).join(' · ')?`<small class="dw-flow-line">${e([c.flowLabel,c.flowPhase].filter(Boolean).join(' · '))}</small>`:''}${showTurn?`<small class="dw-turn-line" title="${e(c.turnReason)}">현재 차례 <b>${e(turn)}</b>${c.turnSource?' · '+e(c.turnSource):''}</small>`:''}${c.model?`<small class="dw-model-line" title="${e(c.modelTitle)}">모델 ${e(c.model)}${c.effort?' · 강도 '+e(c.effort):''}</small>`:''}<small>${e(c.board||'판 미지정')}</small><small>${e(c.signalLabel)} ${e(c.signalAt?shortTimeLabel(c.signalAt):'')}</small><small>보고 ${e(c.reportLabel)} · 카드 수정 ${e(timeLabel(c.at))}</small></a></li>`;
 }).join('');
}
const json=value=>JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
// 목록 자료는 줄마다 같은 이름표("purpose": 등)가 되풀이돼 이름표만 약 470KB였다(2026-09-25 실측, 1,053줄 1.6MB).
// 같은 이름 묶음을 쓰는 줄끼리 이름표를 한 번만 적는다. 풀면 JSON으로 주고받은 원래 객체와 같다.
export function packRows(rows){
 if(!Array.isArray(rows))return rows;
 const shapes=[],index=new Map();
 return {shapes,rows:rows.map(row=>{const keys=Object.keys(row).filter(key=>row[key]!==undefined),id=keys.join('\u0000');let n=index.get(id);if(n===undefined){n=shapes.length;index.set(id,n);shapes.push(keys);}return [n,...keys.map(key=>row[key])];})};
}
export function unpackRows(packed){
 if(!packed||!Array.isArray(packed.shapes))return packed;
 return packed.rows.map(([n,...values])=>Object.fromEntries(packed.shapes[n].map((key,i)=>[key,values[i]])));
}
export function renderDashboardWorkspace({center,briefs,centerError,url,detail,works=null,workError=null,workDetail,hierarchy=null}) {
 const params=url.searchParams,baseRows=workspaceModel(center,briefs);
 // 현황의 '지금 막힌 것'과 같은 분류(executionBucket)를 실행 줄에 싣는다. health=stuck 필터와 칩이 쓴다(2026-09-24 UX 2차).
 const centerByKey=new Map((center?.cards||[]).map(c=>[c.key,c]));
 if(baseRows)for(const r of baseRows)if(r.kind!=='work'){const card=centerByKey.get(r.key);if(card)r.bucket=executionBucket({...card,...r});}
 const parent=new Map((works||[]).flatMap(w=>w.executions.map(x=>[x.key,w.workKey])));
 const fields=['rallyStep','healthKind','healthLabel','healthReason','signalAt','signalLabel','key','workKey','id','repo','title','kind','workType','originalTitle','state','stateLabel','stored','purpose','flowLabel','flowPhase','flowTitle','turnLabel','turnReason','turnSource','next','summary','scope','board','owner','model','modelTitle','reportAt','reportLabel','at','revision'];
 const rows=baseRows===null?null:works===null?baseRows:[...works.map(w=>{const row=Object.fromEntries(fields.map(k=>[k,['purpose','summary','scope','next'].includes(k)?String(w[k]||'').slice(0,220):w[k]]));const running=roleModel(center,w.owner,w.state);row.model=running.short;row.effort=running.effort;row.modelTitle=running.title;return row;}),...baseRows.map(c=>({...c,kind:'execution',parentWorkKey:parent.get(c.key)||''}))];
 const collection=works===null?'':(['work','executions','unlinked'].includes(params.get('collection'))?params.get('collection'):params.get('card')&&!params.get('card').startsWith('work:')?'executions':'work');
 // 열 구성은 컬렉션과 실제 값으로 정한다. 실행 표에는 카드 상태가 없고, 빈 실행 모델 열은 머리글도 두지 않는다.
 const columns=workspaceVisibleColumns(collection,rows);
 const state={collection,q:params.get('q')||'',repo:params.get('repo')||'',board:params.get('board')||'',health:params.get('health')||'',rally:params.get('rally')||'',state:params.get('state')||'',layout:['table','split','wall','map'].includes(params.get('layout'))?params.get('layout'):'table',axis:params.get('axis')==='step'?'step':'status',root:params.get('root')==='role'?'role':'work',sort:params.get('sort')||'attention',dir:params.get('dir')==='asc'?'asc':'desc'};
 const filtered=sortWorkspaceRows(filterWorkspaceRows(rows,state),state.sort,state.dir);
 const totalInCollection=(rows||[]).filter(c=>collection==='work'?c.kind==='work':c.kind!=='work'&&(collection!=='unlinked'||!c.parentWorkKey)).length;
 const filterName=workspaceStateLabel(state.state);
 const countLabel=rows===null||(collection==='work'&&workError)?'모름':filtered.length===totalInCollection?('전체 '+totalInCollection+'장'):((state.q||state.repo||state.board||state.health||state.rally)?'조건':filterName)+' '+filtered.length+'장 · 전체 '+totalInCollection+'장';
 const explicit=params.get('card'),selected=explicit||filtered[0]?.key||'',card=center?.cards.find(c=>c.key===selected),work=works?.find(w=>w.key===selected);
 const opened=Boolean(explicit)&&params.get('detail')!=='0';
 // 상세는 열었거나(목록·상세 보기처럼) 옆에 보일 때만 그린다. 고르지 않은 첫 줄의 상세가 페이지에 약 200KB씩 실렸다(2026-09-25 실측).
 const shown=opened||state.layout==='split',shownWork=shown?work:null,shownCard=shown?card:null;
 const options=(values,current)=>values.map(([value,label])=>`<option value="${e(value)}"${value===current?' selected':''}>${e(label)}</option>`).join('');
 const healthCounts=new Map();
 for(const c of rows||[])if(c.healthLabel)healthCounts.set(c.healthLabel,(healthCounts.get(c.healthLabel)||0)+1);
 const stuckCount=(rows||[]).filter(c=>c.bucket==='stuck').length;
 const healthValues=[['stuck',`지금 막힌 것 (${stuckCount})`],...[...healthCounts.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'ko')).map(([value,count])=>[value,`${value} (${count})`])];
 const rallyCounts=new Map();
 for(const c of rows||[])if(c.flowTitle)rallyCounts.set(c.flowTitle,(rallyCounts.get(c.flowTitle)||0)+1);
 const rallyValues=[...rallyCounts.entries()].sort((a,b)=>a[0].localeCompare(b[0],'ko')).map(([value,count])=>[value,`${value} (${count})`]);
 const presetCounts=rows===null?null:workspacePresetCounts(rows,state);
 // 자주 쓰는 상태 묶음은 칩으로 바로 고른다. 값은 상태 필터와 같아 같은 주소로 이어진다.
 const presetRow=presetCounts===null?'':`<div class="dw-presets" id="dw-presets" role="group" aria-label="상태 빠른 선택">${workspaceStatePresets.map(([value,label])=>`<button type="button" data-state-preset="${e(value)}" aria-pressed="${state.state===value}" title="${e(label)} 상태만 보기"><span>${e(label)}</span><span class="dw-preset-count" data-preset-count="${e(value)}">${presetCounts[value]}</span></button>`).join('')}<a class="dw-stuck-chip" href="?collection=executions&amp;state=all&amp;health=stuck#dashboard" aria-current="${state.health==='stuck'}" title="현황의 '지금 막힌 것'과 같은 실행"><span>지금 막힌 것</span><span class="dw-preset-count">${stuckCount}</span></a></div>`;
 return `<section class="dw-workspace" id="dashboard-workspace" data-view="dashboard">
 ${works!==null?`<div class="bw-collections" role="group" aria-label="업무와 실행 전환">${[['work','업무 카드'],['executions','모든 실행'],['unlinked','연결 전 실행']].map(([k,label])=>`<button type="button" data-collection="${k}" aria-pressed="${collection===k}">${label} <span>${k==='work'?(workError?'모름':works.length):k==='executions'?(baseRows?.length??'모름'):(baseRows?.filter(c=>!parent.has(c.key)).length??'모름')}</span></button>`).join('')}<small>업무 하나 안에 실행·검수·인박스가 이어집니다.</small></div>${workError?`<p role="alert" class="error">업무 상태 모름: ${e(workError)}</p>`:''}<p id="dw-work-help" class="bw-empty-help"${collection==='work'?'':' hidden'}>업무는 약속한 결과를 확인한 뒤 완료합니다. 기존 카드는 ‘연결 전 실행’에서 찾을 수 있습니다.</p>`:''}
 <div class="dw-controls"><label>판<select id="dw-board" aria-label="작업판">${options([['','모든 판'],...[...new Set((rows||[]).map(c=>c.board).filter(Boolean))].sort().map(b=>[b,b])],state.board)}</select></label><label>저장소<select id="dw-repo">${options([['','전체'],...[...new Set((rows||[]).map(c=>c.repo))].sort().map(r=>[r,r])],state.repo)}</select></label><label>실행 흐름<select id="dw-health" aria-label="실행 흐름">${options([['','모든 실행 흐름'],...healthValues],state.health)}</select></label><label>묶음<select id="dw-rally" aria-label="티키타카 묶음">${options([['','모든 묶음'],...rallyValues],state.rally)}</select></label><label class="dw-search">검색<input id="dw-search" value="${e(state.q)}" placeholder="제목 · 카드 ID · 현재 차례 · 담당"></label><div class="dw-state-filter"><span id="dw-state-label">상태</span><details id="dw-state"><summary aria-labelledby="dw-state-label dw-state-summary"><span id="dw-state-summary">${e(filterName)}</span></summary><div class="dw-state-menu"><div class="dw-state-actions"><button type="button" data-state-preset="all">모두 선택</button><button type="button" data-state-preset="none">모두 제외</button><button type="button" data-state-preset="">미완료만</button></div><div class="dw-state-options" role="group" aria-label="표시할 상태">${Object.entries(stateText).map(([key,label])=>`<label><input type="checkbox" data-state-option value="${key}"${workspaceSelectedStates(state.state).includes(key)?' checked':''}>${e(label)}</label>`).join('')}</div></div></details></div><div class="dw-layout" role="group" aria-label="보기 전환"><button type="button" data-layout="table" aria-pressed="${state.layout==='table'}">표 보기</button><button type="button" data-layout="split" aria-pressed="${state.layout==='split'}">목록·상세</button><button type="button" data-layout="wall" aria-pressed="${state.layout==='wall'}">카드 월</button><button type="button" data-layout="map" aria-pressed="${state.layout==='map'}">관계도</button><a class="dw-layout-link" href="#operations-flow" title="업무별로 누가 어디까지 했는지 보는 화면">업무 흐름</a></div></div>
 ${presetRow}
 <details class="dw-evidence-help"><summary>상태 이름이 여러 개인 이유</summary><ul><li><b>상태</b>: 카드에 적힌 값입니다. 담당이나 감독이 바꿉니다.</li><li><b>실행 흐름</b>: 발령·진행 보고·결과·담당 창을 보고 다시 판단한 값입니다. 카드에 적힌 상태와 다를 수 있습니다.</li><li><b>업무 상태</b>: 업무 카드 한 장의 진행입니다. 업무 표에서만 보입니다.</li></ul><p>카드 내용을 고친 시각은 일이 움직였다는 신호가 아닙니다.</p></details><div class="dw-heading"><h1 id="dw-collection-title">${collection==='work'?'업무 카드':collection==='unlinked'?'연결 전 실행':collection==='executions'?'실행':'카드'}</h1><span id="dw-count" role="status">${e(countLabel)}</span><span>실행 흐름 → 최근 실행 신호 → 현재 차례</span><div class="dw-heading-actions"><div id="dw-column-tools" class="dw-column-tools"${state.layout!=='table'?' hidden':''}><span class="dw-column-hint">제목 드래그: 순서 · 경계 드래그: 너비</span><button type="button" class="ds-button--quiet" data-columns-reset title="열 순서와 너비를 기본값으로 되돌리기">열 초기화</button></div>${works!==null?'<a href="#work-create">새 업무 만들기</a>':'<a href="#create">새 카드 만들기</a>'}</div><span class="dw-sr" id="dw-column-help">열 제목을 클릭하면 정렬합니다. 제목을 좌우로 드래그하거나 Alt와 방향키를 함께 누르면 열 순서가 바뀝니다. 첫 열은 가로 스크롤해도 고정됩니다. 열 경계를 드래그하거나 경계에서 방향키를 누르면 너비가 바뀝니다. 경계를 두 번 클릭하면 그 열의 기본 너비로 돌아갑니다.</span><span class="dw-sr" id="dw-column-status" role="status"></span></div>
 <div class="dw-panes ${state.layout==='split'?'':'dw-table-layout'} ${opened?'dw-detail-open':''}" id="dw-panes"><section class="dw-master" id="dw-master" aria-label="작업 목록"><div class="dw-scroll" id="dw-scroll" tabindex="0" aria-label="카드 목록 · 표는 좌우로 스크롤 가능"><ul id="dw-list"${state.layout==='table'?' hidden':''}>${state.layout==='split'?workspaceRowsHtml(filtered,'split',selected,columns):''}</ul><table class="dw-table" id="dw-table"${state.layout!=='table'?' hidden':''}><caption class="dw-sr">열 제목을 클릭하면 정렬, 드래그하면 순서 변경. 열 경계로 너비 조절. 카드 제목으로 상세를 엽니다.</caption><colgroup>${columns.map(([key,,width])=>`<col data-column="${key}" style="width:var(--column-${key},${width}px)">`).join('')}</colgroup><thead><tr>${columns.map(([key,label])=>`<th scope="col" data-column="${key}" data-sort-column="${key}" aria-sort="${state.sort===key?(state.dir==='asc'?'ascending':'descending'):'none'}"><button type="button" data-sort="${key}" aria-describedby="dw-column-help" aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+Home Alt+End" title="클릭: 정렬 · 드래그: 열 순서 이동 · Alt+방향키: 순서 이동">${`<span data-column-label>${collection==='work'?({stateLabel:'업무 상태',reportAt:'업무 기록',at:'관련 기록 갱신'})[key]||label:label}</span>`}<span data-sort-arrow aria-hidden="true">${state.sort===key?(state.dir==='asc'?' ↑':' ↓'):' ↕'}</span></button><span class="dw-column-resize" data-workspace-resize="${key}" role="separator" aria-orientation="vertical" aria-label="${label} 열 너비" aria-controls="dw-table" aria-describedby="dw-column-help" tabindex="0" title="드래그로 ${label} 너비 조절 · 두 번 클릭하면 기본 너비"></span></th>`).join('')}</tr></thead><tbody id="dw-table-body">${state.layout==='table'?workspaceRowsHtml(filtered,'table',explicit||'',columns):''}</tbody></table><div id="dw-wall"${state.layout==='wall'?'':' hidden'}>${state.layout==='wall'?workspaceWallHtml(filtered,explicit||'',state.axis):''}</div><div id="dw-map"${state.layout==='map'?'':' hidden'}>${state.layout==='map'?workspaceMapHtml(filtered,explicit||'',state.root,hierarchy,rows):''}</div><div id="dw-empty"${rows!==null&&filtered.length?' hidden':''}>${rows===null?`<h2>카드 상태 모름</h2><p>${e(centerError||'카드 기록을 읽지 못했습니다.')}</p>`:`<h2 id="dw-empty-title">${collection==='work'&&workError?'업무 상태 모름':works!==null&&collection==='work'&&!works.length?'아직 업무 카드가 없습니다.':'조건에 맞는 카드가 없습니다.'}</h2>${works!==null?'<p><a href="#work-create">새 업무 만들기</a> · <button type="button" data-collection="unlinked">기존 실행 확인</button></p>':''}<button type="button" data-workspace-reset>검색·필터 초기화</button>`}</div></div></section>
 <div class="dw-pane-resize" data-workspace-resize="panes" role="separator" aria-orientation="vertical" aria-label="목록과 상세 너비" aria-controls="dw-master dw-detail" tabindex="0" title="드래그로 목록과 상세 너비 조절 · 두 번 클릭하면 기본 너비"></div>
 <section id="dw-detail" class="dw-detail" aria-label="선택한 카드 상세"><div class="dw-detail-tools"><button type="button" data-detail-close>목록으로</button><span id="dw-detail-status" role="status"></span><button type="button" data-detail-expand>상세 확대</button></div><div id="dw-detail-content">${shownWork?workDetail(shownWork):shownCard?detail(shownCard):`<h2>카드 ${explicit?'확인 필요':'선택'}</h2><p>${explicit?'요청한 카드를 읽을 수 없습니다.':'카드를 선택하면 여기에서 내용을 읽을 수 있습니다.'}</p>`}</div></section></div>
 <script type="application/json" id="dw-data">${json({rows:packRows(rows),selected,opened,loadedKey:shownWork?.key||shownCard?.key||'',state,workError,columns,hierarchy})}</script></section>`;
}
export function renderWorkspaceDetail(c,{brief,center,decisions=[],decisionError=false,form='',collectedAt,entries=[],home,url}={}) {
 const report=currentProgressReport(c);
 const model=workspaceModel({cards:[c]},new Map([[c.key,brief]]))[0];
 const runs=c.runs||[],events=detailEvents(c),guide=approvedDetailGuide(c),turn=cardTurn(c);
 const flow=buildCardFlows([...(center?.cards||[]).filter(x=>x.key!==c.key),c]).get(c.key),purpose=cardPurpose(c,brief);
 const life=center?.roles?.find(r=>r.role===c.role)?.life;
 const sessions=!c.role?'담당 미배정':center?.runtimeKnown!==true?'모름':life?.state==='alive'?(life.pidState==='match'?'열림':'PID 변경 · 확인 필요'):'세션 없음';
 const links=decisions.filter(d=>d.card===c.key);
 const sameGroup=c.rallyId?(center?.cards||[]).filter(x=>x.repo===c.repo&&x.board===c.board&&x.rallyId===c.rallyId):[];
 const reviews=sameGroup.filter(x=>x.rallyStep==='review'&&String(x.rallyRound)===String(c.rallyRound));
 const cardLinks=items=>items.map(x=>`<li><a data-card-key="${e(x.key)}" href="?card=${encodeURIComponent(x.key)}#detail">${e(x.title||x.id)}</a> · ${e(stateText[x.displayState]||'모름')} · ${e(x.role||'미배정')}</li>`).join('');
 const runHtml=runs.length?`<table><thead><tr><th>담당</th><th>실행 기록</th><th>시각</th></tr></thead><tbody>${runs.map(r=>`<tr><td>${e(r.role)}</td><td>${e(({done:'완료 기록',failed:'실패 기록',unconfirmed:'완료 미확인',orphaned:'세션 없음·미완료'})[r.state]||r.state||'모름')}</td><td>${e(timeLabel(r.at))}</td></tr>`).join('')}</tbody></table>`:'<p>연결된 실행 기록이 없습니다.</p>';
 const panels={
  summary:`<div class="execution-evidence">${renderExecutionHealth(model)}<p>${e(model.healthReason)}</p><small>${e(model.signalLabel)} · ${e(model.signalAt?timeLabel(model.signalAt):'기록 없음')} · 카드 수정 ${e(timeLabel(c.at))}</small></div>`+renderDetailSummary(c,{brief,report,reviews,reviewLinks:cardLinks(reviews),decisions:links,decisionError,events,compact:true,showRecent:false}),
  technical:`<dl><dt>카드 상태</dt><dd>${e(stateText[c.status]||c.status||'모름')}</dd><dt>실행 상태</dt><dd>${e(progressLabel(c))}</dd><dt>세션 상태</dt><dd>${e(sessions)}</dd><dt>마지막 보고</dt><dd>${e(model.reportLabel)}</dd><dt>상세 수집</dt><dd>${e(timeLabel(collectedAt))}</dd><dt>카드 ID</dt><dd>${e(c.id)}</dd><dt>원본 제목</dt><dd>${e(c.title||c.id)}</dd></dl>${brief?.stale?'<p>이전 설명의 진행 서술은 사용하지 않습니다.</p>':''}${brief?.error?`<p>${e(brief.error)}</p>`:''}`, 
  work:renderInstructionTable(c),
  evidence:`<h3>역할별 실행 결과</h3>${runHtml}<h3>작업자가 남긴 보고</h3>${report.state==='reported'?`<p class="muted">${e(report.by||'모름')} · ${e(timeLabel(report.at))}</p><div class="dw-prose">${renderCardDocument(report.note||'',c)}</div>`:`<p>${report.state==='unknown'?'보고 확인 불가':'보고 없음'} · ${report.state==='unknown'?'현재 담당과 보고 시각의 근거를 확인하세요.':'현재 배정·발령 이후의 유효한 보고가 없습니다.'}</p>`}<h3>명시적으로 연결된 검수 카드</h3>${reviews.length?`<ul>${cardLinks(reviews)}</ul>`:'<p>현재 라운드에 연결된 검수 카드가 없습니다.</p>'}<p class="muted">실행 완료 기록은 검수 통과나 배포 완료를 뜻하지 않습니다. 결과 문서와 검수 범위는 각 카드의 작업 내용과 기록에서 확인하세요.</p>`,
  group:renderRallyFlow(c,flow),
  history:renderDetailHistory(events)
 };
 return `<article class="card-detail dw-reader" id="detail" data-detail-view="table" data-key="${e(c.key)}" data-revision="${e(c.revision)}"><header><div class="dd-reader-top"><p class="dd-eyebrow">${e(c.board||c.repo)} <span>${c.workType==='coordination'?'관리·조율':'실행 작업'}</span> ${statePill(model)}</p><div class="dd-layout" role="group" aria-label="상세 보기 방식"><button type="button" data-detail-view="table" aria-pressed="true">표형</button><button type="button" data-detail-view="document" aria-pressed="false">문서형</button></div></div><h2 tabindex="-1" id="dw-card-heading">${e(guide?.summary?.title||brief?.title||c.title||c.id)}</h2><p class="dd-jump"><a href="?mailCard=${encodeURIComponent(c.key)}#mailbox">이 카드의 우편</a><a href="?ledgerCard=${encodeURIComponent(c.key)}&amp;ledgerRoutine=1#ledger">이 카드의 사건</a></p>${renderCardFlow(c,flow,{purpose,turn,brief,running:roleModel(center,c.role,c.displayState)})}</header>${renderDetailSections(renderCardInbox(c,{entries,cards:center?.cards||[c],home,url})+panels.summary,[
 ['work','작업 지시',panels.work],['evidence','결과·검수',panels.evidence,c.healthKind==='attention'||['failed','unconfirmed','orphaned'].includes(c.state)],['manage','기록 남기기',form],
 ['technical','기술 정보',panels.technical+renderDetailSections('',[['group','티키타카 연결 기록',panels.group],['history','전체 변경 기록',panels.history]])+`<details class="dw-management"><summary>저장 위치·원본</summary><dl><dt>작업 폴더</dt><dd>${e(c.repoPath)}</dd><dt>카드 원본</dt><dd>${e(c.path)}</dd><dt>이전 경로 · 상대 문서 기준</dt><dd>${e(c.sourcePath||c.path||'모름')}</dd></dl><details><summary>작업 지시문 원문</summary><pre>${e(c.body)}</pre></details></details>`]
 ])}</article>`;
}
