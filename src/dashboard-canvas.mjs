// 카드 월과 관계도는 같은 행 모델을 다르게 배치한다. 읽기 전용이며 카드·원장·세션을 바꾸지 않는다.
import {escapeHtml as e} from './card-content.mjs';
import {renderExecutionHealth} from './dashboard-execution.mjs';

// 화면과 시험이 같은 정의를 쓰도록 열/축을 한 곳에 둔다.
export const wallStatusColumns=[['planned','발령 전'],['running','작업 중'],['waiting','결과 대기'],['hold','보류'],['attention','확인 필요'],['closed','완료·종료']];
export const wallStepColumns=[['implementation','구현'],['fix','수정'],['review','독립검수'],['research','관련 조사'],['','연결 전·업무']];
export const wallAxes=[['status','상태'],['step','티키타카 단계']];
const stepKeys=wallStepColumns.map(([key])=>key);

export function wallColumnOf(row,axis){
 if(axis==='step')return stepKeys.includes(row.rallyStep)?row.rallyStep:'';
 const kind=row.healthKind||'attention';
 return wallStatusColumns.some(([key])=>key===kind)?kind:'attention';
}

// 다음 행동자가 정해지지 않은 카드는 이름을 비운다. 표와 같은 규칙을 쓴다.
const turnText=c=>{const turn=c.turnLabel||'';return turn&&!['종료','차례 확인 필요'].includes(turn)?turn:'';};

export function workspaceWallHtml(rows,selected,axis='status'){
 const modelBadge=c=>c.model?`<span class="dw-badge" title="${e(c.modelTitle||c.model)}">${e(c.model)}${c.effort?' · '+e(c.effort):''}</span>`:'';
 const stamp=at=>Number.isFinite(Date.parse(at))?new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(at)):'시각 미기록';
 const signalLine=c=>c.signalAt?`${e(c.signalLabel||'최근 실행 신호')} ${e(stamp(c.signalAt))}`:e(c.signalLabel||'실행 신호 없음');
 const tile=c=>{const turn=turnText(c);return `<a class="dw-wall-card${selected===c.key?' selected':''}" data-card-key="${e(c.key)}" href="?card=${encodeURIComponent(c.key)}#detail" aria-current="${selected===c.key}">
  <span class="dw-wall-head">${renderExecutionHealth(c)}${modelBadge(c)}</span>
  <strong>${e(c.title)}</strong>
  <span class="dw-wall-purpose">${e(c.purpose||c.id)}</span>
  <small class="dw-wall-meta">${e(c.kind==='work'?'업무 카드':(c.flowLabel||'라운드 미기록'))}${turn?' · '+e(turn):''}</small>
  <small class="dw-wall-signal">${signalLine(c)}</small>
 </a>`;};
 const list=rows||[];
 const bar=`<div class="dw-view-bar" role="group" aria-label="카드 월 기준">${wallAxes.map(([value,label])=>`<button type="button" data-axis="${value}" aria-pressed="${axis===value}">${e(label)}</button>`).join('')}<span class="dw-view-help">타일을 누르면 상세가 열립니다. 열은 지금 필터 기준입니다.</span></div>`;
 if(!list.length)return bar+'<p class="dw-view-empty">조건에 맞는 카드가 없습니다.</p>';
 const columns=axis==='step'?wallStepColumns:wallStatusColumns;
 const groups=new Map(columns.map(([key])=>[key,[]]));
 for(const row of list)groups.get(wallColumnOf(row,axis))?.push(row);
 return bar+`<div class="dw-wall">${columns.map(([key,label])=>{const cards=groups.get(key)||[];return `<section class="dw-wall-col" data-wall-column="${e(key)}"><header><h3>${e(label)}</h3><span>${cards.length}</span></header><div class="dw-wall-cards">${cards.map(tile).join('')}</div></section>`;}).join('')}</div>`;
}

export function workspaceMapHtml(rows,selected,root='work',hierarchy=null,allRows=null){
 const modelBadge=c=>c.model?`<span class="dw-badge">${e(c.model)}${c.effort?' · '+e(c.effort):''}</span>`:'';
 const card=c=>{const turn=turnText(c);const sub=c.kind==='work'?(c.flowPhase||''):(c.flowLabel||c.flowPhase||c.purpose||c.id);return `<a class="dw-map-card${selected===c.key?' selected':''}" data-card-key="${e(c.key)}" href="?card=${encodeURIComponent(c.key)}#detail" aria-current="${selected===c.key}">${renderExecutionHealth(c)}<strong>${e(c.title)}</strong><small>${e(sub)}</small>${modelBadge(c)}${turn?`<small>${e(turn)}</small>`:''}</a>`;};
 const list=rows||[];
 const bar=(note)=> `<div class="dw-view-bar" role="group" aria-label="관계도 뿌리">${[['work','업무 중심'],['role','역할 중심']].map(([value,label])=>`<button type="button" data-root="${value}" aria-pressed="${root===value}">${e(label)}</button>`).join('')}<span class="dw-view-help">${e(note)}</span></div>`;
 if(!list.length)return bar('카드를 누르면 상세가 열립니다.')+'<p class="dw-view-empty">조건에 맞는 카드가 없습니다.</p>';
 if(root==='role'){
  const parents=hierarchy&&typeof hierarchy==='object'?hierarchy:null;
  const byRole=new Map();
  for(const row of list){const role=row.owner||'';if(!byRole.has(role))byRole.set(role,[]);byRole.get(role).push(row);}
  const roles=[...byRole.keys()].filter(Boolean);
  const note=parents?'역할 자리 사이 선은 등록된 직속 상위입니다. 카드를 누르면 상세가 열립니다.':'관계표를 읽지 못해 담당별로 묶었습니다. 카드를 누르면 상세가 열립니다.';
  const node=role=>{
   const cards=byRole.get(role)||[];
   const working=cards.filter(c=>c.healthKind==='running').length;
   const models=[...new Set(cards.map(c=>c.model).filter(Boolean))];
   const body=role?`<ul>${(childrenOf.get(role)||[]).map(child=>`<li>${node(child)}</li>`).join('')}${cards.map(c=>`<li>${card(c)}</li>`).join('')}</ul>`:`<ul>${cards.map(c=>`<li>${card(c)}</li>`).join('')}</ul>`;
   return `<details open><summary class="dw-map-role"><strong>${e(role||'담당 미배정')}</strong><span>카드 ${cards.length}${working?' · 작업 중 '+working:''}</span>${models.map(m=>`<span class="dw-badge">${e(m)}</span>`).join('')}</summary>${body}</details>`;
  };
  const childrenOf=new Map();
  const roots=[];
  if(parents){
   const known=new Set(roles);
   for(const role of roles){let parent=parents[role];while(parent&&parent!=='@user'&&!known.has(parent)){known.add(parent);parent=parents[parent];}}
   for(const role of known){const parent=parents[role];const key=parent&&parent!=='@user'&&known.has(parent)?parent:'';if(parent&&parent!=='@user'&&!known.has(parent)){roots.push(role);continue;}if(!childrenOf.has(key))childrenOf.set(key,[]);childrenOf.get(key).push(role);}
   for(const role of childrenOf.get('')||[])roots.push(role);
  }else{
   roots.push(...roles);
  }
  const unassigned=byRole.get('')||[];
  return bar(note)+`<ul class="dw-map-tree">${roots.map(role=>`<li>${node(role)}</li>`).join('')}${unassigned.length?`<li>${node('')}</li>`:''}</ul>`;
 }
 // 실행 모음에서는 업무 행이 필터로 빠져 있다. 업무 노드는 전체 행에서 가져와 걸린 카드만 아래에 놓는다.
 const workRows=(allRows&&allRows.length?allRows:list).filter(c=>c.kind==='work');
 const visibleWorks=new Set(list.filter(c=>c.kind==='work').map(c=>c.key));
 const cards=list.filter(c=>c.kind!=='work');
 const byWork=new Map();
 for(const c of cards){const key=c.parentWorkKey||'';if(!byWork.has(key))byWork.set(key,[]);byWork.get(key).push(c);}
 const nodes=workRows.filter(w=>byWork.get(w.workKey)?.length||visibleWorks.has(w.key));
 const grouped=new Set(workRows.map(w=>w.workKey));
 const free=cards.filter(c=>!c.parentWorkKey||!grouped.has(c.parentWorkKey));
 const note='업무 카드 아래에 연결된 실행을 놓았습니다. 카드를 누르면 상세가 열립니다.';
 const workNode=w=>{const kids=byWork.get(w.workKey)||[];return `<details open><summary class="dw-map-role"><strong>${e(w.title)}</strong><span>${e(w.flowPhase||'')}${kids.length?' · 연결 '+kids.length+'장':''}</span></summary><ul>${kids.map(c=>`<li>${card(c)}</li>`).join('')}</ul></details>`;};
 return bar(note)+`<ul class="dw-map-tree">${nodes.map(w=>`<li>${workNode(w)}</li>`).join('')}${free.length?`<li><details open><summary class="dw-map-role"><strong>연결 전 실행</strong><span>카드 ${free.length}</span></summary><ul>${free.map(c=>`<li>${card(c)}</li>`).join('')}</ul></details></li>`:''}</ul>`;
}

export const dashboardCanvasStyle=`
.dw-view-bar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:0 0 10px}
.dw-view-bar button{font-size:11px;padding:4px 9px;border-radius:999px}
.dw-view-bar button[aria-pressed=true]{background:#e6f1ea;color:#155e43;border-color:#9fbfac}
.dw-view-help{font-size:11px;color:#606b65}
.dw-view-empty{padding:22px 4px;color:#606b65;font-size:13px}
.dw-wall{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(228px,1fr);gap:10px;overflow-x:auto;padding-bottom:8px;align-items:start}
.dw-wall-col{background:#f7f9f7;border:1px solid #dce3de;border-radius:10px;padding:10px;min-width:0;display:flex;flex-direction:column;gap:8px;max-height:64dvh;overflow:auto}
.dw-wall-col>header{display:flex;align-items:baseline;justify-content:space-between;gap:8px;position:sticky;top:0;background:#f7f9f7;padding-bottom:4px}
.dw-wall-col>header h3{margin:0;font-size:12px;color:#40594a}
.dw-wall-col>header span{font-size:11px;color:#606b65}
.dw-wall-cards{display:flex;flex-direction:column;gap:7px}
.dw-wall-card{display:flex;flex-direction:column;gap:3px;padding:9px 10px;border:1px solid #dce3de;border-radius:8px;background:#fff;text-decoration:none;color:#202724}
.dw-wall-card:hover{border-color:#9bb5a6}
.dw-wall-card.selected{border-color:#21684e;box-shadow:0 0 0 2px #e3efe8}
.dw-wall-card strong{font-size:12.5px;line-height:1.35;overflow-wrap:anywhere}
.dw-wall-head{display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap}
.dw-wall-purpose{font-size:11px;color:#606b65;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dw-wall-meta,.dw-wall-signal{font-size:10.5px;color:#606b65;overflow-wrap:anywhere}
.dw-badge{font:10px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;background:#eef3f0;border:1px solid #dbe5df;border-radius:5px;padding:0 5px;color:#3d5348;white-space:nowrap}
.dw-map-tree,.dw-map-tree ul{list-style:none;margin:0;padding:0}
.dw-map-tree ul{margin-left:14px;border-left:1px solid #d5dfd8;padding-left:14px}
.dw-map-tree>li{margin:6px 0}
.dw-map-tree li{position:relative}
.dw-map-tree ul>li::before{content:"";position:absolute;left:-14px;top:17px;width:12px;border-top:1px solid #d5dfd8}
.dw-map-tree details>summary{cursor:pointer;list-style:none;display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 10px;border:1px solid #dce3de;border-radius:8px;background:#fff}
.dw-map-tree details>summary::-webkit-details-marker{display:none}
.dw-map-tree details>summary::before{content:"▸";color:#606b65;font-size:11px}
.dw-map-tree details[open]>summary::before{content:"▾"}
.dw-map-role strong{font-size:13px;overflow-wrap:anywhere}
.dw-map-role span{font-size:11px;color:#606b65}
.dw-map-card{display:inline-flex;gap:7px;align-items:center;max-width:100%;margin:3px 0;padding:5px 10px;border:1px solid #e3e9e5;border-radius:999px;background:#fff;text-decoration:none;color:#202724}
.dw-map-card.selected{border-color:#21684e;background:#eef5f1}
.dw-map-card strong{font-size:12px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:320px}
.dw-map-card small{font-size:10.5px;color:#606b65;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
@media(max-width:799px){.dw-wall{grid-auto-columns:minmax(200px,1fr)}.dw-map-card strong{max-width:180px}}
`;
