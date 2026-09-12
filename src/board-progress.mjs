import {renderWatchOverview} from './watch-overview-wall.mjs';
import {cleanTitle,finished,progressLabel,isExecution} from './human-brief.mjs';
import {executionBucket} from './dashboard-execution.mjs';
const escape=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export const progressGroups=[['done','완료','#158064'],['running','작업 중','#e68a27'],['waiting','결과 대기','#397ea7'],['planned','발령 전','#cbd2cd'],['hold','보류','#88729d'],['check','확인 필요','#b68625'],['failed','실패','#bc3737'],['closed','대체·취소·보관','#e2e5e2']];
const statusHelp={done:'카드가 완료됐습니다. 제품 전체 완성이나 배포 완료와는 다릅니다.',running:'시작 보고가 확인됐습니다. 보고가 오래돼도 작업 중 상태는 유지합니다.',waiting:'담당자가 결과를 기다린다고 보고했습니다.',planned:'초안·발령 가능·배정을 묶습니다. 다음 실행 순서가 확정됐다는 뜻은 아닙니다.',hold:'작업을 보류했습니다. 재개 조건은 카드에서 확인하세요.',check:'발령 후 시작 확인 전이거나 담당 세션 등 실행 확인이 필요합니다. 사용자 결정 요청은 별도입니다.',failed:'실패 결과가 기록됐습니다. 원인과 후속 작업은 카드에서 확인하세요.',closed:'취소되거나 보관된 카드입니다. 완료 카드와 구분합니다.'};
// 현황 화면과 같은 묶음(2026-09-12). 확인 필요를 지금 막힌 것과 오래된 미정리로 나눠 요약 수치와 같은 카드 집합을 쓴다.
export const bucketGroups=[['done','완료','#158064'],['running','작업 중','#e68a27'],['waiting','결과 대기','#397ea7'],['planned','발령 전','#cbd2cd'],['hold','보류','#88729d'],['stuck','지금 막힌 것','#b68625'],['stale','오래된 미정리','#a58a5c'],['closed','대체·취소·보관','#e2e5e2']];
const bucketHelp={...statusHelp,stuck:'담당 세션이 살아 있거나 신호가 최근인데 시작 보고·실패·PID 근거를 확인할 실행입니다. 실패 기록도 여기에 포함합니다.',stale:'담당 세션이 없고 24시간 이상 신호가 없는 실행입니다. 감독이 대체·취소·보류로 정리해야 합니다.'};
const renderStatusHelp=(groups=progressGroups,help=statusHelp)=>`<details class="status-help"><summary>상태·색상 안내</summary><dl>${groups.map(([key,title,color])=>`<div><dt><i style="background:${color}" aria-hidden="true"></i>${title}</dt><dd>${help[key]}</dd></div>`).join('')}</dl><p>막대는 실행 카드 수 기준이며 조율 카드는 제외합니다. 마지막 보고 시각은 작업 상태와 별개이며, 내가 답할 질문은 ‘내 결정 필요’에서 확인합니다.</p></details>`;
export function progressGroup(state){return ['done','running','waiting','hold','failed'].includes(state)?state:['ready','assigned','draft','planned'].includes(state)?'planned':['cancelled','superseded','archived'].includes(state)?'closed':'check';}
export function bucketGroup(card,now){const b=executionBucket(card,now);if(b==='closed')return card.displayState==='done'?'done':'closed';return b;}
const stateClasses=['done','running','waiting','hold','failed','ready','assigned','draft','planned','cancelled','superseded','archived','unconfirmed','orphaned','needs-check'];
const tints={done:['#e2f2e9','#195e42'],running:['#fff0df','#814600'],waiting:['#e7f1f8','#245779'],planned:['#edf0ed','#46564b'],hold:['#eeebf6','#554278'],check:['#fff0d0','#794e00'],failed:['#ffe3e0','#8f251e'],closed:['#f0f2f0','#58615b']};
export const statusPaletteCss=stateClasses.map(state=>{const group=progressGroup(state),color=progressGroups.find(([key])=>key===group)[2],[background,text]=tints[group];return `.state.${state}{--status-color:${color};background:${background};color:${text}}`;}).join('')+'.state::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--status-color,#b68625);margin-right:5px;vertical-align:middle}';
export function boardProgressCounts(board,{buckets=false,now=Date.now()}={}){
 const groups=buckets?bucketGroups:progressGroups;
 const cards=[...new Map((board.cards??[]).filter(isExecution).map(c=>[c.key,c])).values()],counts=Object.fromEntries(groups.map(([key])=>[key,0]));
 for(const c of cards)counts[buckets?bucketGroup(c,now):progressGroup(c.displayState)]++;
 return {total:cards.length,counts};
}
export function renderBoardProgress(center,{briefs,showCards=true,showWatch=true,buckets=false,now=Date.now()}={}){
 if(!center)return '<p>판 진행 모름</p>';
 const groups=buckets?bucketGroups:progressGroups,help=buckets?bucketHelp:statusHelp;
 return center.boards.map(b=>{
 const management=b.cards.filter(c=>!isExecution(c));
 const watchedBoard=b;
 b={...b,cards:[...new Map(b.cards.filter(isExecution).map(c=>[c.key,c])).values()]};
 const {total,counts}=boardProgressCounts(b,{buckets,now}),parts=groups.filter(([key])=>counts[key]);
 const description=parts.map(([key,title])=>`${title} ${counts[key]}장`).join(' · ');
 const remaining=b.cards.filter(c=>!finished(c));
 return `${showWatch?renderWatchOverview(center,watchedBoard):''}<article class="board-progress"><div class="board-heading"><strong>${escape(b.name)}</strong><span class="muted">남은 실행 카드 ${remaining.length}장</span><span>실행 완료 ${counts.done}/${total}장</span></div>${total?`<div class="progress-track" role="img" aria-label="${escape(b.name+': '+description)}">${parts.map(([key,title,color])=>`<span style="width:${counts[key]/total*100}%;background:${color}" title="${title} ${counts[key]}장 — ${escape(help[key])}"></span>`).join('')}</div><div class="progress-legend">${parts.map(([key,title,color])=>`<span title="${escape(help[key])}"><i style="background:${color}"></i>${title} ${counts[key]}장</span>`).join('')}</div>`:'<p class="muted">실행 카드 없음 — 진행률을 계산하지 않습니다.</p>'}${renderStatusHelp(groups,help)}${showCards?`<details><summary>이 판의 실행 카드 ${b.cards.length}장 보기</summary><ul class="work-list">${b.cards.map(c=>`<li class="work-row"><a href="?card=${encodeURIComponent(c.key)}#detail">${escape(briefs?.get(c.key)?.title||cleanTitle(c))}</a> · ${escape(progressLabel(c))}</li>`).join('')}</ul></details>`:''}${showCards&&management.length?`<details class="management-records"><summary>관리 기록 ${management.length}장 · 실행 집계 제외</summary><ul>${management.map(c=>`<li><a href="?card=${encodeURIComponent(c.key)}#detail">${escape(briefs?.get(c.key)?.title||cleanTitle(c))}</a> · ${escape(progressLabel(c))}</li>`).join('')}</ul></details>`:''}${b.runs.length?`<p class="muted">중앙 카드와 연결되지 않은 실행 ${b.runs.length}건은 막대에서 제외했습니다.</p>`:''}</article>`;
 }).join('')||'<p>등록된 판이 없습니다.</p>';
}
