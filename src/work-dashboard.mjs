import {workHealth,executionHealth,renderExecutionHealth} from './dashboard-execution.mjs';
import {escapeHtml as e} from './card-content.mjs';
import {cardTurn} from './card-turn.mjs';
import {stateText} from './human-brief.mjs';
import {renderDetailHistory,renderDetailSections} from './dashboard-detail.mjs';
import {renderInbox} from './dashboard-inbox.mjs';
import {workPhases,endedExecution} from './work-store.mjs';
import {workLetters} from './work-mail.mjs';

const short=at=>at?new Date(at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'모름';
const workState={open:'진행 중',hold:'보류',done:'업무 완료',cancelled:'취소'};
const anchor=(key,title)=>`<a data-card-key="${e(key)}" href="?card=${encodeURIComponent(key)}#detail">${e(title)}</a>`;
const option=(value,title,selected)=>`<option value="${e(value)}"${value===selected?' selected':''}>${e(title)}</option>`;
const actionNames={create:'업무 등록',update:'업무 보고',link:'실행 연결',execute:'실행 등록',unlink:'연결 정정',mail:'우편 연결',complete:'업무 최종 완료',cancel:'업무 취소',reopen:'업무 다시 열기'};

export function workDashboardModel(works,center,entries){
 const cards=center?.cards||[];
 return works.map(w=>{
  const executions=w.executions.map(link=>({...link,card:cards.find(c=>c.key===link.key)}));
  const ended=executions.filter(x=>x.card&&endedExecution(x.card));
  const active=executions.filter(x=>!x.card||!endedExecution(x.card));
  const round=Math.max(0,...w.executions.map(x=>x.round));
  const closed=['done','cancelled'].includes(w.status);
  const lastChild=Math.max(0,...executions.flatMap(x=>[Date.parse(x.card?.at)||0,...(x.card?.runs||[]).map(r=>Date.parse(r.at)||0)]));
  const explicit=w.turnOwner&&Number.isFinite(Date.parse(w.turnAt))&&Date.parse(w.turnAt)>=lastChild;
  const turns=active.map(x=>x.card?cardTurn(x.card):{owner:null,label:'차례 확인 필요'});
  const owners=[...new Set(turns.map(x=>x.owner).filter(Boolean))];
  const unknown=turns.filter(x=>!x.owner).length;
  const turn=closed?'종료':explicit?w.turnOwner:active.length?(owners.join(' · ')+(unknown?`${owners.length?' · ':''}차례 확인 필요 ${unknown}건`:'')):w.owner;
  const latest=active.filter(x=>x.round===round);
  const stage=closed?(active.length?'종료 후 미종료 실행 · 확인 필요':workState[w.status]):w.status==='hold'?'보류':!executions.length?'실행 준비':!active.length?'감독 최종 확인':(latest.length?latest:active).map(x=>workPhases[x.phase]).filter((x,i,a)=>a.indexOf(x)===i).join(' · ');
  const letters=workLetters(w,entries,cards);
  return {...w,...workHealth(w,executions),key:`work:${w.key}`,workKey:w.key,kind:'work',workType:'business',originalTitle:w.title,state:closed?w.status:w.status==='hold'?'hold':'running',stateLabel:workState[w.status],stored:w.status,
   purpose:w.goal,flowLabel:round?`${round}라운드 · ${stage}`:stage,flowPhase:`실행 ${ended.length}/${executions.length}건 종료${active.length>1?' · '+active.length+'건 병행':''}${!closed?' · 업무는 미완료':''}`,flowTitle:w.title,
   turnLabel:turn,turnReason:explicit?'업무에 명시한 현재 차례':active.length?'각 실행의 차례 기록·전달·진행 보고 기준':'책임 감독이 결과를 확인할 차례',turnSource:closed?'업무 종료':explicit?'차례 기록':!active.length?'책임 감독':owners.length>1?'병렬 진행':'실행별 근거',
   next:w.nextAction||(!active.length&&executions.length?'약속한 결과와 완료 조건을 감독이 확인':'다음 행동 미기록'),summary:w.progress,reportAt:w.at,reportLabel:short(w.at),
   executions,active,ended,letters,round,at:new Date(Math.max(Date.parse(w.at)||0,lastChild,...letters.map(x=>Date.parse(x.t)||0))).toISOString()};
 });
}

const facts=items=>`<table class="bw-facts"><tbody>${items.map(([label,text])=>`<tr><th scope="row">${e(label)}</th><td>${e(text||'미기록')}</td></tr>`).join('')}</tbody></table>`;
function executionTable(executions){
 if(!executions.length)return '<p class="muted">연결된 실행이 없습니다. 아래에서 실행을 등록하거나 기존 실행을 연결하세요.</p>';
 return `<div class="bw-scroll" tabindex="0" aria-label="업무 안의 실행"><table class="bw-executions"><thead><tr><th>라운드</th><th>단계</th><th>실행 · 맡긴 내용</th><th>상태</th><th>현재 차례</th></tr></thead><tbody>${[...executions].sort((a,b)=>b.round-a.round).map(x=>`<tr><td>${x.round}</td><td>${e(workPhases[x.phase])}</td><td>${anchor(x.key,x.card?.title||x.key)}</td><td>${renderExecutionHealth(x.card?executionHealth(x.card):{})}</td><td>${e(x.card?cardTurn(x.card).label:'확인 필요')}</td></tr>`).join('')}</tbody></table></div>`;
}

export function renderWorkDetail(w,{token,center,models,home,url}){
 const closed=['done','cancelled'].includes(w.status),hidden=`<input type="hidden" name="token" value="${e(token)}"><input type="hidden" name="key" value="${e(w.key)}"><input type="hidden" name="revision" value="${w.revision}">`;
 const form=(action,body)=>`<form method="post" action="/works/${action}" class="edit bw-form">${hidden}${body}</form>`;
 const input=(name,label,value='',required=false)=>`<label>${label}<input name="${name}" value="${e(value)}"${required?' required':''}></label>`;
 const area=(name,label,value='',required=false)=>`<label>${label}<textarea name="${name}" rows="2"${required?' required':''}>${e(value)}</textarea></label>`;
 const note=area('note','변경 이유','',true);
 const used=new Set(models.flatMap(x=>x.executions.map(x=>x.key))),unlinked=(center?.cards||[]).filter(c=>!used.has(c.key));
 const phaseRound=`<div class="bw-form-pair"><label>실행 단계<select name="phase">${Object.entries(workPhases).map(([k,v])=>option(k,v,'implementation')).join('')}</select></label><label>라운드<input type="number" name="round" min="1" max="999" value="${w.round||1}" required></label></div>`;
 const createExecution=closed?'':`<details><summary>새 실행 등록</summary>${form('execute',phaseRound+input('title','이번에 맡길 내용','',true)+area('body','실행 지시 · 허용 범위 · 결과물','',true)+note+'<button>실행 초안 등록</button><p class="muted">업무 안에 실행을 기록합니다. 담당 배정·발령은 실행 상세와 기존 명령에서 이어갑니다.</p>')}</details>`;
 const linking=closed?'':`<details><summary>기존 실행 연결 · 연결 정정</summary>${form('link',`<label>실행<select name="execution" required>${[...w.executions.map(x=>x.card).filter(Boolean),...unlinked].map(c=>option(c.key,`${c.title||c.id} · ${c.key}`,'')).join('')}</select></label>`+phaseRound+note+'<button>실행 연결 저장</button>')}${w.executions.length?form('unlink',`<label>잘못 연결한 실행<select name="execution">${w.executions.map(x=>option(x.key,x.card?.title||x.key,'')).join('')}</select></label>`+note+'<button class="ds-button--quiet">연결 정정 기록</button><p class="muted">실행 원본과 이전 연결 이력은 보존합니다.</p>'):''}</details>`;
 const update=closed?form('reopen',note+'<button>업무 다시 열기</button>'):form('update',area('progress','진척 · 처리 수 / 남은 대상 / 재개 위치',w.progress)+input('turnOwner','현재 차례 (여럿이면 함께 기재)',w.turnOwner)+area('nextAction','다음 행동 · 대기 이유',w.nextAction)+note+`<details><summary>업무 약속 · 책임 · 보류 변경</summary>${input('title','업무 제목',w.title,true)}${area('goal','약속한 결과',w.goal,true)}${area('scope','전체 대상 범위',w.scope,true)}${area('acceptance','완료 조건',w.acceptance,true)}${input('owner','책임 감독',w.owner,true)}${input('board','판',w.board)}<label>업무 상태<select name="status">${option('open','진행 중',w.status)}${option('hold','보류',w.status)}</select></label></details><button>업무 기록 저장</button>`);
 const complete=closed?'':`<details><summary>업무 최종 완료 · 취소</summary><p class="muted">실행 종료 ${w.ended.length}/${w.executions.length}건. 책임 감독이 약속한 결과를 확인한 뒤 업무를 끝냅니다.</p>${form('complete',area('result','확인한 최종 결과 · 검수 근거','',true)+note+`<button${w.active.length?' disabled':''}>업무 최종 완료 확인</button>${w.active.length?'<p>미종료 실행을 먼저 마치거나 취소하세요.</p>':''}`)}${form('cancel',area('result','취소 근거 · 남은 내용','',true)+note+`<button class="ds-button--quiet"${w.active.length?' disabled':''}>업무 취소 기록</button>`)}</details>`;
 const panels={
  summary:facts([['약속한 결과',w.goal],['지금',w.flowLabel],['실행 흐름',w.healthLabel+' · '+w.healthReason],['최근 실행 신호',w.signalLabel+' · '+short(w.signalAt)],['현재 차례',w.turnLabel],['다음 행동',w.next],...(w.progress?[['진척',w.progress]]:[])])+renderInbox(w,home,url),
  instructions:facts([['전체 대상',w.scope],['완료 조건',w.acceptance],...(w.result?[['최종 결과·근거',w.result]]:[])]),
  manage:update+complete,
  technical:facts([['업무 ID',w.workKey],['책임 감독',w.owner],['차례 근거',w.turnReason],['실행 종료',w.flowPhase]])+renderDetailSections('',[
   ['work',`실행 기록 ${w.executions.length}건`,executionTable(w.executions)+createExecution+linking],
   ['history','업무 변경 기록',renderDetailHistory([...w.history].reverse().map(h=>({at:h.at,by:h.by,kind:actionNames[h.action]||h.action,note:[h.note,h.progress,h.nextAction,h.result].filter(Boolean).join('\n'),transition:workState[h.status]})))],
   ...(!closed?[['mail-link','기존 편지 연결',form('mail',input('mail','우편 ID (기존 우편함에서 확인)','',true)+note+'<button>이 업무에 연결</button>')]]:[])
  ])
 };
 return `<article class="card-detail dw-reader bw-reader" id="detail" data-detail-view="table" data-key="${e(w.key)}" data-revision="${w.revision}"><header><div class="dd-reader-top"><p class="dd-eyebrow">업무 카드 <span>${e(w.board||w.repo)}</span><span class="state ${closed?w.status:'running'}">${e(w.stateLabel)}</span></p><div class="dd-layout" role="group" aria-label="상세 보기 방식"><button type="button" data-detail-view="table" aria-pressed="true">표형</button><button type="button" data-detail-view="document" aria-pressed="false">문서형</button></div></div><h2 tabindex="-1" id="dw-card-heading">${e(w.title)}</h2></header>${renderDetailSections(panels.summary,[['instructions','업무 내용·완료 조건',panels.instructions],['manage','진척·완료 기록 남기기',panels.manage],['technical','기술 정보',panels.technical]])}</article>`;

}

export function renderWorkCreate(token){return `<section class="panel" data-view="work-create" id="work-create"><h2>새 업무 카드</h2><p class="muted">사용자에게 약속한 결과 한 가지를 적습니다. 구현·검수·수정은 이 업무 안에 실행으로 이어집니다.</p><form method="post" action="/works/create" class="edit bw-create"><input type="hidden" name="token" value="${e(token)}">${[['key','업무 주소 (저장소/업무ID)'],['title','업무 제목'],['owner','책임 감독'],['repoPath','저장소 절대경로']].map(([name,label])=>`<label>${label}<input name="${name}" required></label>`).join('')}<label>판<input name="board"></label>${[['goal','약속한 결과'],['scope','전체 대상 범위'],['acceptance','완료 조건']].map(([name,label])=>`<label>${label}<textarea name="${name}" rows="2" required></textarea></label>`).join('')}<button>업무 카드 만들기</button><p id="bw-create-status" role="status"></p><p class="muted">등록은 실행을 시작하거나 메시지를 보내지 않습니다.</p></form></section>`;}

export const workDashboardStyle=`
.dw-reader .dw-detail-fold{border-top:1px solid #dce3de;margin:0;padding:0}.dw-detail-fold>summary{padding:10px 0;font-size:12px;font-weight:550}.dw-detail-fold .dw-tab-panel{padding:5px 0 14px}.dw-detail-fold .dw-detail-fold>summary{font-weight:400}.dw-reader .di-people span{display:block;overflow:hidden;text-overflow:ellipsis;line-height:16px}.dw-reader .di-people span+span{color:#627069}.dw-reader .bw-mail{min-width:500px}.dw-reader .bw-facts{margin-bottom:16px}.dw-reader #dw-panel-summary{padding-bottom:12px}.dw-reader .df-turn details{display:inline-block;margin:0 0 0 10px}.dw-reader .df-turn details[open]{display:block;margin:4px 0}.dw-reader .dd-help{font-size:11px}

.bw-collections{display:flex;gap:4px;align-items:center;margin-bottom:10px;flex-wrap:wrap}.bw-collections button[aria-pressed=true]{background:#e6f1ea;color:#155e43;border-color:#9fbfac}.bw-collections small{margin-left:12px}.bw-facts{font-size:12px}.dw-tab-panel .bw-facts th{width:105px;white-space:normal;min-width:0;color:#5b6d61}.dw-tab-panel .bw-facts td,.dw-tab-panel .bw-facts th{padding:7px 9px;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;vertical-align:top}.bw-facts tr:nth-child(2n){background:#f6f8f6}.bw-head-flow{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12px;color:#28684e}.bw-scroll{overflow:auto;max-height:52dvh;border:1px solid #dce3de;border-radius:5px;overscroll-behavior:contain}.bw-executions{min-width:620px;font-size:12px;table-layout:fixed}.bw-executions th{position:sticky;top:0;background:#f0f4f1;z-index:1}.bw-executions th:nth-child(1){width:58px}.bw-executions th:nth-child(2){width:76px}.bw-executions th:nth-child(4){width:96px}.bw-executions th:nth-child(5){width:145px}.dw-tab-panel .bw-executions td,.dw-tab-panel .bw-executions th{padding:6px 8px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bw-executions small{display:block;font-size:10px}.bw-executions tr:nth-child(2n){background:#f8faf8}.bw-form-pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}.bw-form input,.bw-form select{max-width:100%;min-width:0}.bw-mail-pages{display:flex;gap:16px}.bw-create{max-width:760px}.bw-create label{margin:10px 0}.dw-reader[data-detail-view=document] .bw-facts th,.dw-reader[data-detail-view=document] .bw-facts td{padding-block:13px;font-size:14px}.dw-reader[data-detail-view=document] .bw-executions td{white-space:normal}.bw-parent-link{font-size:12px;padding:7px 10px;background:#eef5f0;border-radius:4px;margin-bottom:10px}@media(max-width:799px){#dashboard-workspace:has(.dw-detail-open)>:is(.bw-collections,.bw-empty-help,.dw-controls,.dw-heading){display:none}.bw-collections{padding:8px 14px;margin:0}.bw-collections small,.bw-empty-help{display:none}}
.bw-empty-help{font-size:12px;color:#5e6b62;margin:0 0 8px}
`;
