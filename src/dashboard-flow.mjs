import {buildRallies} from './rallies.mjs';
import {cardTurn} from './card-turn.mjs';
import {stateText,cleanTitle} from './human-brief.mjs';
import {instructionSections} from './dashboard-detail.mjs';
import {escapeHtml as e} from './card-content.mjs';
import {statusContext} from './card-status-context.mjs';

const steps={implementation:'구현',fix:'수정',review:'독립검수',research:'관련 조사'};
const terminal=c=>['done','cancelled','superseded','archived'].includes(c.displayState);
const groupKey=c=>JSON.stringify([c.repo,c.board,c.rallyId]);
const stamp=at=>Number.isFinite(Date.parse(at))?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(at)):'시각 미기록';
const short=(value,n=220)=>value.length>n?value.slice(0,n)+'…':value;

// 목적은 지시문의 명시된 항목에서만 읽는다. 여러 Why와 추가 목적을 함께 보존한다.
export function cardPurpose(c,brief) {
 if(brief?.goal)return {text:brief.goal,source:'카드 설명의 목적'};
 const sections=instructionSections(c.body).sections.filter(s=>/^(why|작업 목적|목적)$/i.test(s.title));
 const values=sections.map(s=>s.content.replace(/^\s*[-*+]\s+/gm,'').replace(/\s+/g,' ').trim()).filter(Boolean);
 return {text:[...new Set(values)].join(' / 추가 목적: '),source:values.length?'작업 지시의 목적':''};
}

function groupFlow(g) {
 const current=g.cards.filter(c=>Number(c.rallyRound)===g.round&&c.rallyStep!=='research');
 const work=current.filter(c=>['implementation','fix'].includes(c.rallyStep)),review=current.filter(c=>c.rallyStep==='review');
 const warnings=[...g.warnings];
 // 이전 검수 실패는 다음 수정 라운드의 이유다. 다시 진행 중인 카드와 구분한다.
 if(g.cards.some(c=>c.rallyStep!=='research'&&Number(c.rallyRound)<g.round&&!terminal(c)&&c.displayState!=='failed'))warnings.push('이전 라운드에 미완료 카드가 있습니다.');
 const working=work.filter(c=>!terminal(c)),reviewing=review.filter(c=>!terminal(c));
 let phase='흐름 확인 필요',next='연결된 카드의 상태를 확인하세요.',tone='unknown';
 if(warnings.length){next=warnings.join(' · ');}
 else if(g.done){phase='구현·검수 완료 기록';next='결과·검수 탭에서 실제 완료 범위를 확인하세요.';tone='done';}
 else if(g.closed){phase='묶음 종료';next='취소·대체·보류된 카드의 기록을 확인하세요.';}
 else if(!g.round){phase='관련 조사';next='구현·독립검수 라운드는 아직 연결되지 않았습니다.';}
 else if(work.length===1&&review.length===1&&current.every(c=>c.displayState==='done')){phase='구현·검수 끝 · 관련 조사 남음';next='함께 연결된 조사 카드의 결과 확인';tone='waiting';}
 else if(working.some(c=>c.displayState==='running')&&reviewing.some(c=>c.displayState==='running')){phase='구현·검수 병행';next='각 카드의 현재 차례를 확인하세요.';tone='running';}
 else if(working.length){
  const c=working[0],step=steps[c.rallyStep];
  phase=step+' · '+(stateText[c.displayState]||'상태 확인 필요');tone=c.displayState;
  next=c.displayState==='hold'?'보류 이유와 재개 조건 확인':c.displayState==='failed'?'실패 내용과 수정 범위 확인':c.displayState==='waiting'?'담당자가 기다리는 결과와 다음 차례 확인':review.length?'구현 결과가 나온 뒤 독립검수 카드 확인':'구현 결과가 나온 뒤 독립검수 연결 확인';
 }
 else if(reviewing.length&&work.length===1&&work[0].displayState==='done'){
  const c=reviewing[0];phase='독립검수 · '+(stateText[c.displayState]||'상태 확인 필요');tone=c.displayState;
  next=c.displayState==='failed'?'검수 지적을 확인하고 다음 수정 라운드 연결':c.displayState==='hold'?'검수 보류 이유와 재개 조건 확인':'검수 결과와 수정 필요 여부 확인';
 }
 else if(work.length===1&&work[0].displayState==='done'&&!review.length){phase='구현 완료 · 검수 미연결';next='독립검수 카드 연결 확인';tone='waiting';}
 if(g.round&&!review.length)warnings.push('독립검수 카드가 연결되지 않았습니다.');
 const actors=[...working,...reviewing,...g.cards.filter(c=>c.rallyStep==='research'&&!terminal(c))];
 return {group:g,phase,next,tone,warnings,actors};
}

// 라운드는 명시된 묶음 정보만 사용한다. r12 같은 본문 번호나 전달 횟수는 세지 않는다.
export function buildCardFlows(cards=[]) {
 const groups=new Map(buildRallies(cards).map(g=>[g.key,groupFlow(g)]));
 return new Map(cards.map(c=>{
  const flow=c.workType==='coordination'?null:groups.get(groupKey(c));
  if(!flow)return [c.key,{linked:false,label:c.workType==='coordination'?'관리·조율':'라운드 미기록',phase:c.workType==='coordination'?'구현·검수 라운드 대상 아님':'카드 사이의 연결 정보 없음',next:'',tone:'unknown',warnings:[],actors:[]}];
  const round=Number(c.rallyRound),step=steps[c.rallyStep]||'단계 확인 필요';
  const label=c.rallyStep==='research'?'관련 조사':`${Number.isInteger(round)&&round>0?round:'?'}라운드 · ${step}`;
  return [c.key,{...flow,linked:true,label,older:c.rallyStep!=='research'&&round<flow.group.round}];
 }));
}

const cardLink=(c,label)=>`<a data-card-key="${e(c.key)}" href="?card=${encodeURIComponent(c.key)}#detail">${e(label||c.title||c.id)}</a>`;
function stageCell(cards,selected) {
 if(!cards.length)return '<span class="df-missing">연결 없음</span>';
 return cards.map(c=>`<div class="df-stage${c.key===selected?' df-selected':''}">${cardLink(c,steps[c.rallyStep]+' · '+(stateText[c.displayState]||'상태 모름'))}<span class="df-stage-title" title="${e(c.title||c.id)}">${e(cleanTitle(c))}</span><small>${e(c.role||'담당 미배정')}${c.key===selected?' · 보고 있는 카드':''}</small></div>`).join('');
}

export function renderRallyFlow(c,flow) {
 if(!flow.linked)return `<div class="df-unlinked"><h3>${e(flow.label)}</h3><p>${c.workType==='coordination'?'이 카드는 여러 실행 작업을 관리·조율합니다.':'현재 카드는 어떤 구현·검수 카드와 이어지는지 기록되어 있지 않습니다.'}</p><p class="muted">${c.workType==='coordination'?'구현·독립검수 왕복은 연결된 실행 카드에서 확인합니다.':'몇 번째 주고받는 중인지는 아직 알 수 없습니다. 기록을 많이 남겼다고 라운드가 늘어나는 것은 아닙니다.'}</p></div>`;
 const g=flow.group;
 const rows=[...g.rounds].reverse().map(n=>{const cards=g.cards.filter(x=>Number(x.rallyRound)===n&&x.rallyStep!=='research');return `<tr${n===g.round?' class="df-latest"':''}><th scope="row">${n}라운드${n===g.round?'<small>최신 연결</small>':''}</th><td>${stageCell(cards.filter(x=>['implementation','fix'].includes(x.rallyStep)),c.key)}</td><td>${stageCell(cards.filter(x=>x.rallyStep==='review'),c.key)}</td></tr>`;}).join('');
 const research=g.cards.filter(x=>x.rallyStep==='research');
 return `<div class="df-rally-heading"><h3>${e(g.title||g.id)}</h3><span>${g.cards.length}장 · ${g.round?g.round+'라운드까지 연결':'라운드 연결 전'}</span></div><p class="dd-help">구현·수정 → 독립검수가 1라운드입니다. 수정이 필요하면 다음 라운드로 이어집니다.</p><div class="df-round-scroll" tabindex="0" aria-label="라운드별 구현과 독립검수"><table class="df-rounds"><caption class="dw-sr">최신 라운드부터, 구현과 검수 카드를 나란히 확인합니다.</caption><colgroup><col style="width:78px"><col><col></colgroup><thead><tr><th scope="col">라운드</th><th scope="col">구현·수정</th><th scope="col">독립검수</th></tr></thead><tbody>${rows||'<tr><td colspan="3">구현·검수 라운드 연결 없음</td></tr>'}</tbody></table></div>${research.length?`<div class="df-research"><h3>관련 조사 · 라운드 횟수에서 제외</h3>${stageCell(research,c.key)}</div>`:''}${flow.warnings.length?`<p class="df-warning">${e(flow.warnings.join(' · '))}</p>`:''}<p class="dd-help">각 칸의 상태는 해당 카드의 기록입니다. 완료 기록만으로 배포 성공을 뜻하지는 않습니다.</p>`;
}

export function renderCardFlow(c,flow,{purpose,turn,brief,running}={}) {
 const g=flow.group;
 const current=flow.linked?`${g.round?g.round+'라운드 · ':''}${flow.phase}`:flow.phase;
 const actors=flow.actors.filter(x=>x.key!==c.key).map(x=>{const t=cardTurn(x);return `${cardLink(x,steps[x.rallyStep])} <strong>${e(t.label)}</strong>${t.source?` <small>${e(t.source)} · ${e(stamp(t.at))}</small>`:''}`;});
 const next=brief?.next||c.nextAction;
 const stopped=['hold','waiting','failed','orphaned'].includes(c.displayState)?statusContext(c).reason:null;
 return `${purpose.text?`<div class="df-purpose"><p class="dd-clamp">${e(short(purpose.text,600))}</p><button type="button" data-read-tab="work">목적·지시 원문 →</button></div>`:'<p class="df-no-purpose">작업 목적 미기록 · 작업 지시에서 내용 확인</p>'}<div class="df-overview"><dl><dt>티키타카</dt><dd><strong>${e(flow.linked?current:flow.label)}</strong> <button type="button" data-read-tab="group">흐름 보기 →</button>${flow.older?`<small class="df-warning">보고 있는 카드는 ${e(flow.label)}입니다. 위 진행은 묶음의 최신 라운드입니다.</small>`:flow.linked?`<small>이 카드: ${e(flow.label)}${flow.warnings.length?' · '+e(flow.warnings.join(' · ')):''}</small>`:`<small>${e(flow.phase)}${c.workType==='coordination'?'':' · 몇 번째 왕복인지 알 수 없습니다.'}</small>`}</dd><dt>현재 차례</dt><dd class="df-turn"><strong>${e(turn.label)}</strong><details><summary>차례 근거</summary><p>${e(turn.reason)}</p>${turn.source?`<small>${e(turn.source)} · ${e(stamp(turn.at))} · 기록 ${e(turn.by||'모름')}</small>`:''}</details></dd>${running?.short?`<dt>실행 도구</dt><dd><strong>${e(running.short)}${running.effort?' · 강도 '+e(running.effort):''}</strong><small>${e(running.title)}</small></dd>`:''}${actors.length?`<dt>연결 카드</dt><dd class="df-other-turns">${actors.map(a=>'<p>'+a+'</p>').join('')}</dd>`:''}${flow.next?`<dt>다음 단계</dt><dd>${e(flow.next)}</dd>`:''}${stopped?`<dt>멈춘 이유</dt><dd><details class="df-next-original"><summary><span>${e(short(String(stopped).replace(/\s+/g,' '),95))}</span></summary><p>${e(stopped)}</p></details></dd>`:''}${next?`<dt>다음 행동</dt><dd><details class="df-next-original"><summary><span>${e(short(String(next).replace(/\s+/g,' '),95))}</span></summary><p>${e(next)}</p></details></dd>`:''}</dl></div>`;
}

export const cardFlowStyle=`
.dw-flow-cell strong,.dw-flow-cell small,.dw-model-cell strong,.dw-model-cell small{display:block;overflow:hidden;text-overflow:ellipsis;line-height:16px}.dw-flow-cell strong,.dw-model-cell strong{font-size:12px;font-weight:600}.dw-flow-cell small,.dw-model-cell small{font-size:10px;color:#627069}.dw-flow-line{font-size:12px;color:#40594a}.dw-card-title small.dw-card-purpose{font-family:inherit;font-size:10px;line-height:12px;color:#627069}.dw-reader .df-purpose{margin:2px 0 9px}.dw-reader .df-purpose p{font-size:12px;line-height:1.6;color:#526358;margin:0;overflow-wrap:anywhere;word-break:keep-all;-webkit-line-clamp:2}.df-no-purpose{font-size:11px;color:#627069;margin:4px 0 8px}.df-overview{border-block:1px solid #dce3de;background:#f7f9f7;margin:0 0 8px;padding:2px 10px}.df-overview dl{display:grid;grid-template-columns:67px minmax(0,1fr);margin:0;gap:0 10px;font-size:12px;line-height:1.6}.df-overview dt,.df-overview dd{margin:0;padding:6px 0;border-bottom:1px solid #e3e9e5;overflow-wrap:anywhere;min-width:0}.df-overview dt{font-size:11px;color:#627069}.df-overview dt:last-of-type,.df-overview dd:last-of-type{border-bottom:0}.df-overview dd>strong{font-weight:650}.df-overview dd>small{display:block;color:#627069;font-size:10px}.df-turn>strong{color:#21684e}.df-turn>span{margin-left:7px;font-size:11px;color:#627069}.df-turn details{font-size:11px;margin-top:3px}.df-other-turns p{font-size:11px;margin:4px 0}.df-other-turns small{display:block;color:#627069}.df-next-original summary{display:flex;align-items:center;gap:5px;color:#40594a;min-height:22px}.df-next-original summary::before{content:'›';font-size:16px}.df-next-original[open] summary::before{transform:rotate(90deg)}.df-next-original summary span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.df-next-original>p{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.8;margin:7px 0}.df-rally-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}.df-rally-heading>span{font-size:11px;color:#627069}.df-round-scroll{overflow:auto;border:1px solid #dce3de;border-radius:4px;max-height:52dvh}.df-rounds{border-collapse:separate;border-spacing:0;min-width:360px;font-size:12px;line-height:1.6}.dw-reader .df-rounds th,.dw-reader .df-rounds td{padding:7px 9px;border-bottom:1px solid #e3e9e5;text-align:left;vertical-align:top}.df-rounds thead th{position:sticky;top:0;background:#eff4f0;color:#627069;font-size:11px;z-index:2}.df-rounds th>small{display:block;color:#627069;font-size:10px;font-weight:400}.df-rounds .df-latest{background:#f5f9f6}.df-stage{padding:2px 0}.df-stage+.df-stage{margin-top:6px}.df-stage a{font-size:12px;font-weight:550;text-decoration:none}.df-stage a:hover{text-decoration:underline}.df-stage-title{display:block;font-size:11px;color:#526358;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.df-stage small{display:block;overflow-wrap:anywhere;font-size:10px;color:#627069}.df-stage.df-selected{border-left:2px solid #21684e;padding-left:6px}.df-missing{font-size:11px;color:#7b857f}.df-warning{color:#896222!important;font-size:11px}.df-research{margin-top:12px}.df-unlinked{padding:6px 0}.df-unlinked p{font-size:12px}.dw-reader[data-detail-view=document] .df-purpose p{display:block;overflow:visible;font-size:14px}.dw-reader[data-detail-view=document] .df-overview dt,.dw-reader[data-detail-view=document] .df-overview dd{padding-block:10px}
`;
