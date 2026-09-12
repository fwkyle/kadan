import {executionHealth,renderExecutionHealth} from './dashboard-execution.mjs';
import {buildRallies,renderRallies} from './rallies.mjs';
import {secretaryLetters} from './secretary-mailbox.mjs';
import {renderWatchOverview} from './watch-overview-wall.mjs';
import {renderBoardProgress} from './board-progress.mjs';
import {stateText,finished,isExecution,executionUnknown,progressLabel} from './human-brief.mjs';
const e=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const when=x=>x?new Date(x).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false}):'보고 없음';
const reportTime=h=>h.reportState==='unknown'?({'author-unknown':'보고자 모름','role-unknown':'보고 담당 모름','dispatch-time':'발령 시각 모름','assignment-time':'배정 시각 모름','future-time':'보고 시각 확인 필요'}[h.reportReason]||'보고 시각 모름'):when(h.evidenceAt);
const link=(c,title)=>`<a href="?card=${encodeURIComponent(c.key)}#detail">${e(title)}</a>`;
// 비서가 아직 확인하지 않은 공식 우편 수. 원장을 못 읽으면 null(모름)이다.
export function secretaryUnread(entries=[],ledgerLines=0){
 if(ledgerLines===null||!Array.isArray(entries)||entries.some(e=>e?.broken))return null;
 return secretaryLetters(entries).filter(e=>!e.read).length;
}
const taskTableFor=(briefs)=>{
 const explain=c=>briefs?.get(c.key)||{title:c.title||c.id,workstream:'',summary:''};
 return cards=>`<div class="task-table-wrap"><table class="task-table"><thead><tr><th scope="col">작업</th><th scope="col">실행 흐름</th><th scope="col">담당</th><th scope="col">현재 상황</th><th scope="col">마지막 보고</th></tr></thead><tbody>${cards.map(c=>{const h=explain(c),reason=c.statusReason||h.summary||c.nextAction||'상세에서 확인';return `<tr><td>${link(c,h.title)}<small>${e(h.workstream==='분류할 작업'?'':h.workstream||'')}</small></td><td>${renderExecutionHealth(executionHealth(c))}</td><td aria-label="현재 담당: ${e(c.role||'미배정')}">${e(c.role||'미배정')}</td><td><span class="task-reason" title="${e(reason)}">${e(reason.length>100?reason.slice(0,100)+'…':reason)}</span></td><td><small>${e(h.evidenceAt!==undefined?reportTime(h):'')}</small></td></tr>`;}).join('')}</tbody></table></div>`;
};
// 다음으로 시작할 일: 판에 붙지 않은 발령 가능 실행 카드. 현황 화면의 접힘 구역으로 쓴다.
export function renderUpcoming(center,briefs,{fold=false}={}){
 const upcoming=(center?.cards||[]).filter(c=>!c.board&&c.displayState==='ready'&&isExecution(c));
 if(!upcoming.length)return '';
 const body=taskTableFor(briefs)(upcoming);
 return fold?`<details class="st-fold" id="status-upcoming"><summary>다음으로 시작할 일 · 발령 가능 ${upcoming.length}장</summary><p class="st-hint">맡길 준비가 된 후보이며 순서가 정해졌다는 뜻은 아닙니다.</p>${body}</details>`:`<section class="panel"><h2>다음으로 시작할 일 · 발령 가능 ${upcoming.length}장</h2>${body}</section>`;
}
// 비서에게 확인할 질문. 사용자 결정 요청이 아니다.
export function renderSecretaryQuestions(center,briefs,{fold=false}={}){
 const open=(center?.boards||[]).filter(b=>b.state!=='done');
 const activeCards=open.flatMap(b=>b.cards).filter(c=>!finished(c)&&isExecution(c));
 const hold=activeCards.filter(c=>c.displayState==='hold'),unknown=activeCards.filter(executionUnknown);
 const explain=c=>briefs?.get(c.key)||{title:c.title||c.id,workstream:''};
 const questionCards=[...hold,...unknown];
 const primaryQuestions=[];const questionGroups=new Set();
 for(const c of questionCards){const group=explain(c).workstream;if(primaryQuestions.length<3&&!questionGroups.has(group)){primaryQuestions.push(c);questionGroups.add(group);}}
 const moreQuestions=questionCards.filter(c=>!primaryQuestions.includes(c));
 const ask=c=>`${explain(c).title}: ${c.displayState==='hold'?'보류 이유와 다시 시작할 조건이 뭐야?':c.displayState==='failed'?'실패 원인과 다음 조치는 뭐야?':'마지막으로 확인된 진행과 다음 단계가 뭐야?'}`;
 const askItem=c=>`<li><strong>${e(ask(c))}</strong><p>${link(c,'관련 카드 보기')} · <button type="button" class="copy-question" data-question="${e(ask(c))}">질문 복사</button></p></li>`;
 const body=`<p class="muted">사용자 결정 요청이 아닙니다. 아래 질문을 복사해 비서에게 물어볼 수 있습니다.</p>${questionCards.length?`<ul class="question-list">${primaryQuestions.map(askItem).join('')}</ul>${moreQuestions.length?`<details><summary>나머지 ${moreQuestions.length}장 확인 질문</summary><ul class="question-list">${moreQuestions.map(askItem).join('')}</ul></details>`:''}`:'<p>현재 판에서 별도로 확인할 항목이 없습니다.</p>'}`;
 return fold?`<details class="st-fold" id="status-questions"><summary>비서에게 확인할 일 ${questionCards.length}건</summary>${body}</details>`:`<section class="panel secretary-questions"><h2>비서에게 확인할 일</h2>${body}<p class="copy-feedback" role="status" aria-live="polite"></p></section>`;
}
export function renderDashboardHome({center,decisions=[],decisionError,briefs,entries=[],ledgerLines=0}){
 const mailUnknown=ledgerLines===null||entries.some(e=>e?.broken);
 const unread=mailUnknown?null:secretaryLetters(entries).filter(e=>!e.read).length;
 const secretaryShortcut=`<a class="decision-shortcut secretary-shortcut" href="?mailRole=${encodeURIComponent('비서')}&mailUnread=1#mailbox" title="비서가 아직 확인하지 않은 공식 우편입니다. 사용자 결정 요청과 구분합니다."><span>비서 미확인 보고</span><strong>${mailUnknown?'모름':unread+'건'}</strong></a>`;
 if(!center)return `<section class="panel" data-view="dashboard">${secretaryShortcut}<h2>현재 상황을 확인할 수 없습니다</h2><p>카드 기록을 읽지 못해 진행 수와 남은 수를 계산하지 않았습니다.</p></section>`;
 const open=center.boards.filter(b=>b.state!=='done'),closed=center.boards.filter(b=>b.state==='done');
 const decisionsOpen=decisions.filter(d=>d.status==='open');
 const activeCards=open.flatMap(b=>b.cards).filter(c=>!finished(c)&&isExecution(c));
 const rallyGroups=open.flatMap(b=>buildRallies(b.cards)),unlinked=activeCards.filter(c=>!c.rallyId);
 const running=activeCards.filter(c=>c.displayState==='running');
 const hold=activeCards.filter(c=>c.displayState==='hold');
 const unknown=activeCards.filter(executionUnknown);
 const loose=center.cards.filter(c=>!c.board&&executionUnknown(c));
 const explain=c=>briefs.get(c.key);
 const questionCards=[...hold,...unknown];
 const primaryQuestions=[];const questionGroups=new Set();
 for(const c of questionCards){const group=explain(c).workstream;if(primaryQuestions.length<3&&!questionGroups.has(group)){primaryQuestions.push(c);questionGroups.add(group);}}
 const moreQuestions=questionCards.filter(c=>!primaryQuestions.includes(c));
 const upcoming=center.cards.filter(c=>!c.board&&c.displayState==='ready'&&isExecution(c));
 const ask=c=>`${explain(c).title}: ${c.displayState==='hold'?'보류 이유와 다시 시작할 조건이 뭐야?':c.displayState==='failed'?'실패 원인과 다음 조치는 뭐야?':'마지막으로 확인된 진행과 다음 단계가 뭐야?'}`;
 const askItem=c=>`<li><strong>${e(ask(c))}</strong><p>${link(c,'관련 카드 보기')} · <button type="button" class="copy-question" data-question="${e(ask(c))}">질문 복사</button></p></li>`;

 const taskTable=cards=>`<div class="task-table-wrap"><table class="task-table"><thead><tr><th scope="col">작업</th><th scope="col">실행 흐름</th><th scope="col">담당</th><th scope="col">현재 상황</th><th scope="col">마지막 보고</th></tr></thead><tbody>${cards.map(c=>{const h=explain(c),reason=c.statusReason||h.summary||c.nextAction||'상세에서 확인';return `<tr><td>${link(c,h.title)}<small>${e(h.workstream==='분류할 작업'?'':h.workstream)}</small></td><td>${renderExecutionHealth(executionHealth(c))}</td><td aria-label="현재 담당: ${e(c.role||'미배정')}">${e(c.role||'미배정')}</td><td><span class="task-reason" title="${e(reason)}">${e(reason.length>100?reason.slice(0,100)+'…':reason)}</span></td><td><small>${e(reportTime(h))}</small></td></tr>`;}).join('')}</tbody></table></div>`;
 const board=b=>{
  const allCards=b.cards, rallies=buildRallies(allCards);
  b={...b,cards:allCards.filter(c=>!c.rallyId||c.workType==='coordination')};
  const remaining=b.cards.filter(c=>!finished(c)&&isExecution(c)),management=b.cards.filter(c=>!isExecution(c)),goals=[...new Set(allCards.map(c=>explain(c).goal).filter(Boolean))];
  const groups=new Map();for(const c of remaining){const name=explain(c).workstream;if(!groups.has(name))groups.set(name,[]);groups.get(name).push(c);}
  for(const cards of groups.values())cards.sort((a,b)=>Number(['조율','통합'].includes(explain(a).stage))-Number(['조율','통합'].includes(explain(b).stage)));
  const current=allCards.filter(c=>isExecution(c)&&['running','waiting'].includes(c.displayState));

  return `<section class="panel goal-board"><header><small>작업판 · ${e(b.name)}</small><h2>${e(goals.length===1?goals[0]:[...groups.keys()].filter(x=>x!=='분류할 작업').join(' · ')||b.name)}</h2></header>
  ${renderWatchOverview(center,{...b,cards:allCards})}${b.cards.some(isExecution)?renderBoardProgress({boards:[b]}, {briefs,showCards:false,showWatch:false}):''}${rallies.length?'<h3>티키타카 미연결 카드</h3><p class="muted">이름으로 라운드를 추정하지 않습니다. 아래 카드는 묶음 수와 별도로 표시합니다.</p>':''}
  ${current.length||b.cards.some(isExecution)?`<div class="current-work"><h3>지금 하는 일</h3>${current.length?taskTable(current):'<p>현재 작업 중이거나 결과를 기다린다고 확인된 카드가 없습니다. 보류·미배정 카드는 아래에서 확인하세요.'}${remaining.some(executionUnknown)?'<p class="muted">시작 보고가 없거나 실행 확인이 필요한 카드는 아래에 구분합니다. 보고가 오래됐다는 이유로 작업 중 상태를 바꾸지 않습니다.</p>':''}</div>
  <h3>남은 실행 작업 ${remaining.length}개</h3>
  ${remaining.length?taskTable(remaining):'<p class="muted">남은 미연결 작업이 없습니다.</p>'}`:''}${renderRallies(allCards)}${management.length?`<details class="management-records"><summary>관리 기록 ${management.length}장 · 남은 실행 작업에서 제외</summary><p class="muted">감독의 조율·결과 대기 기록입니다. 독립적인 설계·판단 작업은 실행 카드로 구분합니다.</p>${taskTable(management)}</details>`:''}${!remaining.length&&!rallies.length?'<p>남은 실행 작업이 없습니다. 관리 기록의 정리 여부는 별도로 확인합니다.</p>':''}${b.runs.length?'<p class="muted">등록되지 않은 실행은 카드 수에서 제외되어 있습니다. 판 현황에서 확인하세요.</p>':''}</section>`;
 };
 return `<div data-view="dashboard" class="human-dashboard"><section class="home-lead"><div><p class="eyebrow">오늘의 작업</p><h2>${open.length?`${rallyGroups.length?open.length+'개 판 · 남은 티키타카 '+rallyGroups.filter(g=>!g.closed).length+'묶음 · 미연결 '+unlinked.length+'장':open.length+'개 판에 남은 실행 작업 '+activeCards.length+'개'}`:'현재 열린 판이 없습니다'}</h2><p>${rallyGroups.length?'카드 기준 · ':''}작업 중 ${running.length}개 · 보류 ${hold.length}개 · 보고·실행 확인 ${unknown.length}개</p></div><div class="attention-shortcuts"><a class="decision-shortcut" href="#decisions"><span>내가 결정할 일</span><strong>${decisionError?'모름':decisionsOpen.length+'건'}</strong></a>${secretaryShortcut}</div></section>
 ${decisionError?'<section class="panel"><h2>내 결정 필요</h2><p>결정 기록을 읽지 못했습니다.</p></section>':decisionsOpen.length?`<section class="panel decision-priority"><h2>내가 결정하면 진행할 수 있어요</h2><ul>${decisionsOpen.map(d=>`<li><a href="#decision-${e(d.id)}">${e(d.question)}</a><p>추천: ${e(d.recommendation)}</p></li>`).join('')}</ul></section>`:'<p class="decision-clear">지금 요청된 사용자 결정은 없습니다. 감독이 확인할 기록은 아래에 따로 모았습니다.</p>'}
 ${open.map(board).join('')}
 ${upcoming.length?`<section class="panel"><h2>다음으로 시작할 일 · 발령 가능 ${upcoming.length}장</h2>${taskTable(upcoming)}</section>`:''}
 <section class="panel secretary-questions"><h2>비서에게 확인할 일</h2><p class="muted">사용자 결정 요청이 아닙니다. 아래 질문을 복사해 비서에게 물어볼 수 있습니다.</p>${unknown.length||hold.length?`<ul class="question-list">${primaryQuestions.map(askItem).join('')}</ul>${moreQuestions.length?`<details><summary>나머지 ${moreQuestions.length}장 확인 질문</summary><ul class="question-list">${moreQuestions.map(askItem).join('')}</ul></details>`:''}`:'<p>현재 판에서 별도로 확인할 항목이 없습니다.</p>'}<p class="copy-feedback" role="status" aria-live="polite"></p></section>
 <details class="panel history-drawer"><summary>끝난 판 ${closed.length}개 · 옛 실행 기록 확인 ${loose.length}장</summary>${renderBoardProgress({...center,boards:closed},{briefs})}${loose.length?`<h3>판 미지정 · 실행 기록 확인 ${loose.length}장</h3><p>옛 발령과 저장 상태를 대조할 항목입니다. 사용자 결정 대기가 아닙니다.</p><ul class="work-list">${loose.map(c=>`<li>${link(c,explain(c).title)} · 저장 상태 ${e(c.status==='draft'?'초안':c.status)} · ${e(progressLabel(c))}</li>`).join('')}</ul>`:''}</details>
 <p class="muted home-footnote">티키타카 막대는 작업 묶음, 미연결 카드 막대는 카드 수 기준입니다. 감독 조율 카드는 제외합니다. 제품 완성률·배포 완료를 뜻하지 않습니다. <a href="?state=all#cards">전체 카드 ${center.cards.length}장 보기</a></p></div>`;
}
export const dashboardStyle=`
.task-table-wrap{overflow-x:auto}.task-table{width:100%;min-width:760px;table-layout:fixed;border-collapse:collapse}.task-table th,.task-table td{text-align:left;vertical-align:top;padding:11px 12px;border-bottom:1px solid #dfe6e0;overflow-wrap:anywhere}.task-table th{font-size:12px;color:#617166;background:#f5f8f5}.task-table th:nth-child(1){width:30%}.task-table th:nth-child(2){width:13%}.task-table th:nth-child(3){width:19%}.task-table th:nth-child(4){width:26%}.task-table th:nth-child(5){width:12%}.task-table td{font-size:13px}.task-table td:first-child{min-width:0}.task-table td:first-child a{font-weight:600}.task-table small{display:block;color:#657268;font-size:12px}.task-reason{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.rally-section{margin:28px 0}.rally-table-wrap{overflow-x:auto;margin-top:16px}.rally-table{width:100%;border-collapse:collapse;table-layout:fixed;min-width:650px}.rally-table th,.rally-table td{padding:12px 14px;text-align:left;vertical-align:top;border-bottom:1px solid #dfe6e0;overflow-wrap:anywhere}.rally-table th{font-size:12px;color:#617166;background:#f5f8f5}.rally-table th:nth-child(1){width:32%}.rally-table th:nth-child(2){width:16%}.rally-table th:nth-child(3){width:15%}.rally-table td p{margin:6px 0;font-size:13px}.rally-table small{font-size:12px;color:#647368}.rally-table summary{font-size:13px;margin-top:8px}.rally-table ol{padding-left:18px}.rally-table li{padding:6px 0}.attention-shortcuts{display:flex;gap:16px;flex-wrap:wrap}.decision-shortcut.secretary-shortcut{border-color:#477c9e}.home-lead{flex-wrap:wrap;display:flex;justify-content:space-between;align-items:center;gap:24px;padding:8px 0 20px}.home-lead h2{font-size:27px;margin:3px 0 8px;letter-spacing:-.6px}.eyebrow{font-size:12px;color:#547261;font-weight:650}.decision-shortcut{display:flex;flex-direction:column;min-width:150px;border-left:3px solid #217554;padding:4px 18px;text-decoration:none}.decision-shortcut strong{font-size:28px}.decision-clear{color:#55675b;margin:0 0 24px}.goal-board{padding:26px}.goal-board header h2{font-size:23px;margin:4px 0 0}.goal-board .board-progress{padding:15px 0 18px}.goal-board .board-heading strong{display:none}.goal-board .board-heading{margin-bottom:8px}.current-work{padding:0 0 8px}.work-groups{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.work-group{border:1px solid #dfe6e0;border-radius:7px;padding:16px;background:#fafbf9;min-width:0}.group-heading{display:flex;align-items:baseline;justify-content:space-between;gap:8px}.group-heading>span{font-size:12px;color:#647368;white-space:nowrap}.work-list,.question-list{list-style:none;margin:0;padding:0}.work-row{padding:12px 0;border-bottom:1px solid #e1e8e2}.work-row:last-child{border-bottom:0}.work-row>div{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.work-row a{font-weight:600;overflow-wrap:anywhere}.work-row p{font-size:13px}.work-row small{display:block;margin-top:5px}.question-list>li{padding:12px 0;border-bottom:1px solid #e5e9e5;overflow-wrap:anywhere}.question-list strong{font-weight:500}.history-drawer>summary{font-weight:600}.home-footnote{font-size:12px}.decision-priority{border-left:4px solid #247452}.copy-feedback{font-size:12px}.human-dashboard h3{margin-top:18px}@media(max-width:1000px){.work-groups{grid-template-columns:1fr}}@media(max-width:800px){.home-lead{display:block}.home-lead h2{font-size:23px}.decision-shortcut{margin-top:16px;flex-direction:row;gap:15px;align-items:center}.decision-shortcut strong{font-size:22px}.goal-board{padding:14px}.goal-board header h2{font-size:20px}.work-group{padding:12px}.group-heading{flex-wrap:wrap}}
`;
