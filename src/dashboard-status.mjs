import fs from 'node:fs';
import {escapeHtml as e} from './card-content.mjs';
import {executionHealth,renderExecutionHealth,executionBucket,STALE_MS,RECENT_MS} from './dashboard-execution.mjs';
import {renderWatchVerdict} from './watch-overview-wall.mjs';
import {renderSecretaryQuestions,renderUpcoming,mailboxUnread} from './dashboard-home.mjs';
import {renderBoardProgress} from './board-progress.mjs';
import {splitQuestion} from './decision-wall.mjs';

const stamp=x=>Number.isFinite(Date.parse(x))?new Date(x).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'모름';
const ago=(x,now)=>{const t=Date.parse(x);if(!Number.isFinite(t))return '시각 모름';const m=Math.max(0,Math.round((now-t)/60_000));return m<60?m+'분 전':m<48*60?Math.floor(m/60)+'시간 전':Math.floor(m/1440)+'일 전';};
const link=c=>`<a data-card-key="${e(c.key)}" href="?card=${encodeURIComponent(c.key)}#detail">${e(c.title||c.id)}</a>`;
// 막힌 실행의 이유 한 줄: 결과 파일의 '한 줄 요약' → '원인' → 실패·오류 말이 든 첫 줄, 없으면 카드 마지막 메모.
// 2026-09-24 UX 검토: 막힌 카드 6장이 모두 같은 문장이라 무엇이 막혔는지 알 수 없었다.
const plainLine=line=>line.replace(/^\s*(?:[-*]\s+|\|)/,'').replace(/\|\s*$/,'').replace(/\*\*|`/g,'').replace(/\s*\|\s*/g,' · ').replace(/\s+/g,' ').trim();
export function failureReason(c){
 let text='';
 try{if(c.resultPath&&fs.existsSync(c.resultPath))text=fs.readFileSync(c.resultPath,'utf8');}catch{text='';}
 const lines=text.split('\n').filter(line=>line.trim()&&!/^\s*#/.test(line));
 const pick=lines.map(line=>line.match(/한 줄 요약\s*[:：]\s*(.+)/)?.[1]).find(Boolean)
  ||lines.map(line=>line.match(/원인\s*[:：]\s*(.+)/)?.[1]).find(Boolean)
  ||lines.find(line=>/실패|failed|막힘|막힌|중단|오류|error|blocked/i.test(line));
 const reason=plainLine(pick||c.history?.at?.(-1)?.note||c.statusReason||'');
 return reason.length>150?reason.slice(0,150)+'…':reason;
}
const askSupervisor=(c,reason)=>`[대시보드 확인 요청] 카드 ${c.key} 실행이 '${c.healthLabel||'확인 필요'}'로 멈춰 있고 카드는 아직 ${c.status||'열린'} 상태입니다.${reason?` 이유(결과 파일): ${reason}`:''} 다시 시도·후속 카드로 대체·취소·보류 중 어떻게 정리할지 정해 주세요.`;
function executionCard(c){
 const attention=c.healthKind==='attention',reason=attention?failureReason(c):'';
 return `<article class="${attention?'st-attn-card':'st-work'}"><div class="st-attn-head">${renderExecutionHealth(c)}<strong>${link(c)}</strong></div><p>${e(c.healthReason)}</p>${reason?`<p class="st-attn-reason"><strong>이유</strong> ${e(reason)}</p>`:''}<p class="st-attn-meta">담당 ${e(c.role||'미배정')} · ${e(c.board||'판 미지정')} · ${e(c.signalLabel)} ${e(c.signalAt?stamp(c.signalAt):'')}</p>${c.replacedBy?`<p>후속 카드: <a href="?card=${encodeURIComponent(c.replacedBy)}#detail">${e(c.replacedBy)}</a></p>`:''}${c.nextAction?`<p>다음 행동: ${e(c.nextAction)}</p>`:''}${attention?`<p><button type="button" class="copy-question" data-copy-label="확인 요청" data-question="${e(askSupervisor(c,reason))}">감독에게 물어볼 문장 복사</button></p>`:''}</article>`;
}
function workCard(w){
 return `<article class="st-work"><div class="st-work-top">${renderExecutionHealth(w)}<span class="st-work-board">${e(w.board||w.repo)} · ${e(w.flowLabel)}</span><span class="st-work-prog">${e(w.flowPhase)}</span></div><h3 class="st-work-title">${link(w)}</h3>${w.purpose?`<p class="st-work-purpose">${e(w.purpose)}</p>`:''}<p>${e(w.healthReason)}</p><dl class="st-work-grid"><dt>지금 차례</dt><dd class="st-turn">${e(w.turnLabel)}</dd><dt>다음 행동</dt><dd>${e(w.next)}</dd></dl><div class="st-work-foot"><span>최근 실행 신호 ${e(w.signalLabel||'없음')} ${e(w.signalAt?stamp(w.signalAt):'')}</span><span class="st-when">업무 기록 ${e(w.reportLabel)}</span>${w.summary?`<span class="st-sum">${e(w.summary)}</span>`:''}</div></article>`;
}
// 최근 24시간에 실제로 일어난 발령·완료·실패. 카드 편집이 아니라 실행 원장(runs)의 시각만 쓴다.
export function recentExecutionEvents(executions,now=Date.now(),windowMs=RECENT_MS){
 const events=[];
 for(const c of executions)for(const r of c.runs||[]){
  const sent=Date.parse(r.sentAt),at=Date.parse(r.at);
  if(Number.isFinite(sent)&&now-sent<=windowMs&&sent<=now)events.push({at:r.sentAt,kind:'send',label:'발령',card:c,role:r.role});
  if(['done','failed'].includes(r.state)&&Number.isFinite(at)&&now-at<=windowMs&&at<=now)events.push({at:r.at,kind:r.state,label:r.state==='done'?'완료':'실패',card:c,role:r.role});
 }
 return events.sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
}
// 감독에게 붙여 넣을 정리 요청. 카드마다 대체·취소·보류 중 하나를 고르게 하고 명령 뼈대를 준다.
export function staleCleanupRequest(stale,now=Date.now()){
 const head=`[대시보드 정리 요청 ${stamp(new Date(now).toISOString())}] 오래된 미정리 실행 ${stale.length}장 — 담당 세션이 없고 마지막 신호가 ${Math.round(STALE_MS/3600_000)}시간 이상 지났습니다. 각 카드를 대체(superseded · --replaced-by 후속카드), 취소(cancelled), 보류(hold) 중 하나로 정리해 주세요. 후속 카드를 새로 만들 때는 kadan card create ... --supersedes <옛카드>로 옛 카드를 함께 정리할 수 있습니다.`;
 const rows=stale.map(c=>`- ${c.key} (담당 ${c.role||'미배정'} · 마지막 신호 ${c.signalAt?stamp(c.signalAt)+' · '+ago(c.signalAt,now):'없음'}) → kadan card update ${c.key} --revision ${c.revision} --status superseded --replaced-by <저장소/후속카드> --note "<이유>"`);
 return [head,...rows].join('\n');
}
export function renderDashboardStatus({runtime=null,center,works,workError=null,decisions=[],decisionError=null,collectedAt=null,briefs=null,entries=[],ledgerLines=0,now=Date.now()}){
 const executions=(center?.cards||[]).filter(c=>c.workType!=='coordination').map(c=>({...c,...executionHealth(c,now),bucket:null})).map(c=>({...c,bucket:executionBucket(c,now)}));
 const byBucket=bucket=>executions.filter(c=>c.bucket===bucket);
 const stuck=byBucket('stuck'),stale=byBucket('stale'),running=byBucket('running'),waiting=byBucket('waiting');
 const attention=[...stuck,...stale];
 const recent=center?recentExecutionEvents(executions,now):[];
 const recentCount=kind=>recent.filter(x=>x.kind===kind).length;
 const open=(works||[]).filter(w=>w.state==='running'),held=(works||[]).filter(w=>w.state==='hold'),closed=(works||[]).filter(w=>['done','cancelled'].includes(w.state));
 const openBoards=(center?.boards||[]).filter(b=>b.state!=='done'),closedBoards=(center?.boards||[]).filter(b=>b.state==='done');
 let unread=null;try{unread=mailboxUnread(entries,ledgerLines);}catch{unread=null;}
 const mini=(href,num,label)=>`<a class="st-mini" href="${href}"><span class="st-num">${num}</span><span class="st-lbl">${label}</span></a>`;
 // 현황에서 바로 결정으로 간다. 제목 규칙은 결정 화면과 같다(2026-09-24 UX 검토: 결정 화면만 보게 되는 구조).
 const openDecisions=decisionError?null:decisions.filter(d=>d.status==='open');
 const decisionRow=d=>`<li class="st-dec-row"><span class="st-dec-title">${e(splitQuestion(d.question)[0])}</span><small>${e(d.requestedBy)} · 추천 ${e(d.recommendation)}</small><a class="st-dec-answer" href="#decision-${encodeURIComponent(d.id)}">답하기</a></li>`;
 const decisionSection=`<section id="status-decisions" class="st-section"><header class="st-sec-head"><h2>내 결정 대기</h2><span class="st-cnt st-cnt-attn">${openDecisions===null?'모름':openDecisions.length+'건'}</span><span class="st-hint">슈퍼감독이 요청한 결정입니다. 답하기를 누르면 결정 화면에서 바로 답합니다.</span></header>${openDecisions===null?`<p class="st-error" role="alert">결정 기록을 읽지 못했습니다${decisionError?': '+e(decisionError):'.'}</p>`:openDecisions.length?`<ul class="st-decisions">${openDecisions.map(decisionRow).join('')}</ul>`:'<p class="st-empty">기다리는 결정이 없습니다.</p>'}</section>`;
 const chip=(kind,href,num,label)=>`<a class="st-chip st-c-${kind}" href="${href}"><span class="st-num">${num}</span><span class="st-lbl">${label}</span></a>`;
 const list=items=>items.length<=8?items.map(executionCard).join(''):items.slice(0,8).map(executionCard).join('')+`<details class="st-fold"><summary>나머지 ${items.length-8}장</summary>${items.slice(8).map(executionCard).join('')}</details>`;
 const section=(id,title,items,hint)=>`<section id="${id}" class="st-section"><header class="st-sec-head"><h2>${title}</h2><span class="st-cnt${id==='status-attention'?' st-cnt-attn':''}">${center?items.length+'건':'모름'}</span><span class="st-hint">${hint}</span></header>${!center?'<p class="st-error">카드 기록을 읽지 못해 확인 필요 수를 계산하지 않았습니다.</p>':items.length?list(items):'<p class="st-empty">해당 실행이 없습니다.</p>'}</section>`;
 const recentRow=x=>`<li class="st-recent-row st-recent-${x.kind}"><span class="st-recent-time">${e(stamp(x.at))}</span><span class="st-recent-kind">${e(x.label)}</span>${link(x.card)}<small>${e(x.role||'')} · ${e(x.card.board||'판 미지정')}</small></li>`;
 const recentSection=!center?'':`<details id="status-recent" class="st-fold st-recent-fold"><summary class="st-sec-head"><h2>최근 24시간에 일어난 일</h2><span class="st-cnt">완료 ${recentCount('done')} · 실패 ${recentCount('failed')} · 발령 ${recentCount('send')}</span><span class="st-hint">실행 원장의 발령·완료·실패 시각입니다. 카드 편집은 세지 않습니다.</span></summary>${recent.length?`<ul class="st-recent">${recent.slice(0,12).map(recentRow).join('')}</ul>${recent.length>12?`<details class="st-fold"><summary>나머지 ${recent.length-12}건</summary><ul class="st-recent">${recent.slice(12).map(recentRow).join('')}</ul></details>`:''}`:'<p class="st-empty">최근 24시간에 기록된 발령·완료·실패가 없습니다.</p>'}</details>`;
 const staleRow=c=>`<li class="st-stale-row">${link(c)}<small>담당 ${e(c.role||'미배정')} · ${e(c.board||'판 미지정')} · ${e(c.healthLabel)} · 마지막 신호 ${c.signalAt?e(stamp(c.signalAt))+' ('+e(ago(c.signalAt,now))+')':'없음'} · 저장 상태 ${e(c.status)}</small></li>`;
 const staleSection=!center||!stale.length?'':`<details id="status-stale" class="st-fold st-stale"><summary>오래된 미정리 ${stale.length}장 · ${Math.round(STALE_MS/3600_000)}시간 이상 신호 없음 · 정리 대상</summary><p class="st-hint">담당 세션이 없고 신호가 오래된 실행입니다. 지금 막힌 것과 구분하며, 감독이 대체·취소·보류로 정리해야 목록에서 빠집니다. <button type="button" class="copy-question" data-copy-label="정리 요청" data-question="${e(staleCleanupRequest(stale,now))}">정리 요청 복사</button></p><ul class="st-stale-list">${stale.map(staleRow).join('')}</ul></details>`;
 const boardsSection=!center?'':`<details id="boards" class="st-fold" data-view-anchor="boards"><summary>판별 진행 막대 ${openBoards.length}개 판</summary><p class="st-hint">실행 카드 한 장을 한 번씩 셉니다. 관리·조율 카드는 제외하며 위 요약 수치와 같은 카드 집합입니다.</p>${renderBoardProgress({...center,boards:openBoards},{briefs,showWatch:true,showCards:true,buckets:true,now})}</details>`;
 const upcomingSection=center?renderUpcoming(center,briefs,{fold:true}):'';
 const questionsSection=center?renderSecretaryQuestions(center,briefs,{fold:true}):'';
 const historySection=!center||(!closedBoards.length&&!closed.length)?'':`<details id="overview" class="st-fold" data-view-anchor="overview"><summary>끝난 판 ${closedBoards.length}개 · 끝난 업무 ${closed.length}장</summary>${closed.map(w=>`<p>${link(w)} · ${e(w.stateLabel)}</p>`).join('')}${closedBoards.length?renderBoardProgress({...center,boards:closedBoards},{briefs,showWatch:false,buckets:true,now}):''}</details>`;
 return `<div data-view="status" class="st-view">
 <header class="st-lead"><h1>지금 작업이 어떻게 진행되고 있나요?</h1><p>발령·진행 보고·결과와 담당 세션을 함께 봅니다. 카드 수정 시각은 실행 신호가 아닙니다.</p><small>수집 ${e(stamp(collectedAt))}</small></header>
 ${renderWatchVerdict(center,{runtime})}
 <div class="st-band" role="group" aria-label="지금 내가 볼 것">${chip('decision','#status-decisions',openDecisions===null?'모름':openDecisions.length,'내 결정 대기')}${chip('attn','#status-attention',center?stuck.length:'모름','지금 막힌 것')}</div>
 <p class="st-band-more" role="group" aria-label="나머지 요약">${mini('#status-executing',center?running.length:'모름','작업 중')}${mini('#status-waiting',center?waiting.length:'모름','결과 대기')}${mini('#status-stale',center?stale.length:'모름','오래된 미정리')}${mini('#status-running',works===null?'모름':open.length,'열린 업무')}${mini('?mailUnread=1#mailbox',unread===null?'모름':unread,'전체 역할 미확인 우편')}${mini('?collection=executions&state=all#dashboard',center?executions.length:'모름','전체 실행 카드')}</p>
 ${decisionSection}
 ${section('status-attention','지금 막힌 것',stuck,'담당 세션이 살아 있거나 신호가 최근인데 시작 보고·실패·PID 근거를 확인할 실행입니다. 오래된 미정리는 아래에 따로 묶습니다. <a href="?collection=executions&amp;state=all&amp;health=stuck#dashboard">작업 표에서 보기</a>')}
 ${section('status-executing','작업 중인 실행',running,'현재 담당의 진행 보고와 같은 세션이 확인됩니다. 업무 연결 여부와 관계없이 표시합니다.')}
 ${section('status-waiting','결과를 기다리는 실행',waiting,'담당자가 결과 대기를 보고했습니다. 보고가 오래됐다는 이유만으로 중단으로 보지 않습니다.')}
 <p class="st-hint">${center?`실행 전 ${byBucket('planned').length}건 · 보류 ${byBucket('hold').length}건`:'실행 전·보류 모름'} · 보고 시각은 실시간 작업 감지가 아닙니다.</p>
 <section id="status-running" class="st-section"><header class="st-sec-head"><h2>열린 업무</h2><span class="st-cnt">${works===null?'모름':open.length+'장'}</span><span class="st-hint">열린 업무도 실행 준비·결과 대기·감독 확인 단계일 수 있습니다.</span></header>${works===null?`<p class="st-error" role="alert">업무 기록을 읽을 수 없습니다${workError?': '+e(workError):'.'}</p>`:open.length?open.map(workCard).join(''):'<p class="st-empty">열린 업무가 없습니다. 위의 실행 목록에서 개별 작업을 확인하세요.</p>'}</section>
 ${held.length?`<section class="st-section"><h2>보류 중인 업무</h2>${held.map(workCard).join('')}</section>`:''}
 ${staleSection}
 ${recentSection}
 ${boardsSection}
 ${upcomingSection}
 ${questionsSection}
 ${center&&!closedBoards.length&&closed.length?`<details class="st-fold"><summary>끝난 업무 ${closed.length}장</summary>${closed.map(w=>`<p>${link(w)} · ${e(w.stateLabel)}</p>`).join('')}</details>`:historySection}
 <p class="copy-feedback" role="status" aria-live="polite"></p>
 <p class="st-footnote">모든 수치는 실행 카드 한 장을 한 번씩 센 값이며 관리·조율 카드는 제외합니다. 제품 완성률이 아닙니다. 상세 비교·정렬은 <a href="?collection=executions#dashboard">작업 표</a>에서 확인하세요.</p></div>`;
}

export const dashboardStatusStyle=[
'.st-view{padding:4px 0 0}.st-band{display:flex;gap:10px;flex-wrap:wrap;margin:8px 0 26px}.st-chip{display:flex;align-items:center;gap:10px;background:#fff;border:1px solid #dfe6e0;border-radius:9px;padding:10px 16px;text-decoration:none;color:#202724;min-width:118px}.st-chip:hover{border-color:#9bb5a6;background:#fbfdfc}.st-chip .st-num{font-size:22px;font-weight:750;line-height:1.1}.st-chip .st-lbl{font-size:12px;color:#536159}.st-chip::before{content:"";width:8px;height:8px;border-radius:50%;background:#cbd2cd;flex-shrink:0}.st-c-attn{background:#fff0d0;border-color:#b68625}.st-c-attn::before{background:#b68625}.st-c-attn .st-num{color:#794e00}.st-c-run::before{background:#e68a27}.st-c-decision::before{background:#158064}',
'.st-section{margin-bottom:28px}.st-sec-head{display:flex;align-items:baseline;gap:12px;margin-bottom:12px;flex-wrap:wrap}.st-sec-head h2{font-size:16px;margin:0;font-weight:750}.st-cnt{font-size:13px;font-weight:700}.st-cnt-attn{color:#794e00}.st-cnt-run{color:#814600}.st-hint{font-size:12px;color:#536159;margin-left:auto}',
'.st-attn-reason{font-size:13px;margin:4px 0 0;overflow-wrap:anywhere}.st-attn-reason strong{color:#794e00;margin-right:6px}',
'.st-attn-card{background:#fff;border:1px solid #dfe6e0;border-left:4px solid #b68625;border-radius:8px;padding:12px 18px;margin-bottom:10px}.st-attn-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.st-attn-title{font-weight:700;font-size:14px}.st-attn-meta{font-size:12.5px;color:#536159;margin:4px 0 0}',
'.st-work{background:#fff;border:1px solid #dfe6e0;border-radius:10px;padding:18px 22px;margin-bottom:14px}.st-work-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12.5px}.st-work-board{color:#536159}.st-work-prog{margin-left:auto;font-weight:700;font-size:12.5px}.st-work-title{margin:8px 0 2px;font-size:16.5px;font-weight:750;line-height:1.35}.st-work-title a{color:#202724;text-decoration:none}.st-work-title a:hover{text-decoration:underline}.st-work-purpose{font-size:13px;color:#536159;margin:0 0 12px}.st-work-grid{display:grid;grid-template-columns:120px minmax(0,1fr);gap:4px 18px;border-top:1px solid #dfe6e0;padding-top:12px;margin:0}.st-work-grid dt{font-size:11px;font-weight:700;letter-spacing:.04em;color:#536159;padding-top:2px}.st-work-grid dd{font-size:13.5px;margin:0;overflow-wrap:anywhere}.st-work-grid dd.st-turn{font-weight:700}.st-work-foot{margin-top:12px;padding-top:10px;border-top:1px solid #dfe6e0;font-size:12.5px;color:#536159;display:flex;gap:14px;flex-wrap:wrap}.st-work-foot .st-when{font-weight:700;color:#202724;white-space:nowrap}.st-work-foot .st-sum{overflow-wrap:anywhere}',
'.st-fold{border:1px solid #dfe6e0;border-radius:8px;background:#fff;padding:12px 18px;margin-bottom:10px;font-size:13.5px}.st-fold>summary{cursor:pointer;font-weight:600;color:#245c44}.st-hold-row{margin:8px 0;overflow-wrap:anywhere}.st-hold-row small{color:#536159}.st-empty{color:#536159}.st-error{color:#8f251e}.st-footnote{font-size:12px;color:#536159}',
'@media (max-width:800px){.st-band{flex-wrap:nowrap;overflow-x:auto;padding-bottom:6px}.st-chip{flex:0 0 auto}.st-work{padding:14px 16px}.st-work-grid{grid-template-columns:1fr;gap:2px}.st-work-grid dt{margin-top:8px}.st-work-prog{margin-left:0;width:100%}.st-hint{margin-left:0;width:100%}}'
].join('\n')+`.st-band .st-chip{min-width:190px;padding:14px 20px}.st-band .st-chip .st-num{font-size:26px}.st-c-decision{background:#e6f1ea;border-color:#9fbfac}.st-c-decision::before{background:#21684e}
.st-band-more{display:flex;flex-wrap:wrap;gap:6px 18px;margin:-16px 0 24px;font-size:12px}.st-mini{display:inline-flex;gap:4px;align-items:baseline;text-decoration:none;color:#536159}.st-mini:hover{color:#21684e}.st-mini .st-num{font-weight:700;color:#202724;font-size:13px}
.st-decisions{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}.st-dec-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 14px;align-items:center;background:#fff;border:1px solid #dfe6e0;border-left:4px solid #21684e;border-radius:8px;padding:10px 16px}.st-dec-title{font-weight:700;font-size:14px;line-height:1.4}.st-dec-row small{grid-column:1;color:#536159;font-size:12px}.st-dec-answer{grid-column:2;grid-row:1/span 2;font-weight:700;white-space:nowrap}
.st-recent-fold>summary.st-sec-head{margin:0;display:flex}.st-recent-fold>summary h2{font-size:14px}
@media (max-width:800px){.st-band .st-chip{min-width:0;flex:1 1 0;padding:12px 14px}.st-band .st-chip .st-num{font-size:22px}}
.st-lead{margin-bottom:16px}.st-lead h1{font-size:22px}.st-lead p,.st-lead small{font-size:12px;color:#536159}.st-c-wait::before{background:#246a99}.st-c-run::before{background:#22694d}.st-c-stale::before{background:#a58a5c}.st-c-mail::before{background:#477c9e}
.st-recent{list-style:none;margin:0;padding:0;background:#fff;border:1px solid #dfe6e0;border-radius:8px}.st-recent-row{display:flex;align-items:baseline;gap:12px;padding:8px 14px;border-bottom:1px solid #e9eeea;font-size:13.5px;flex-wrap:wrap}.st-recent-row:last-child{border-bottom:0}.st-recent-time{font-variant-numeric:tabular-nums;color:#536159;font-size:12.5px;min-width:88px}.st-recent-kind{font-weight:700;min-width:32px}.st-recent-done .st-recent-kind{color:#158064}.st-recent-failed .st-recent-kind{color:#bc3737}.st-recent-send .st-recent-kind{color:#536159}.st-recent-row small{color:#536159;font-size:12px}
.st-stale>summary{color:#6f5a2c}.st-stale-list{list-style:none;margin:8px 0 0;padding:0}.st-stale-row{padding:8px 0;border-bottom:1px solid #e9eeea}.st-stale-row:last-child{border-bottom:0}.st-stale-row small{display:block;color:#536159;font-size:12px;margin-top:2px}.st-fold .board-progress{padding:14px 0}.st-fold .task-table-wrap{margin-top:8px}`;
