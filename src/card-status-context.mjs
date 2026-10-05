import {currentProgressReport} from './human-brief.mjs';
import {statusLabel,exactStatusLabel} from './status-labels.mjs';
const e=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const state=h=>h.status==='assigned'&&h.noteKind==='progress'&&h.activity?h.activity:h.status;
export function statusChanges(card){
 const result=[];let activity=null;
 for(const [i,h] of (card.history||[]).entries()){
  const previous=card.history[i-1];
  const changed=!previous||previous.status!==h.status;
  const reported=h.noteKind==='progress'&&h.activityAt===h.at;
  if(changed||reported)result.push({from:changed?previous?.status:activity||h.status,to:state(h),reason:h.note||null,by:h.by||'모름',at:h.at,revision:h.revision});
  if(changed)activity=null;
  if(reported)activity=h.activity;
 }
 return result;
}
export function statusContext(card){
 const changes=statusChanges(card),latest=changes.at(-1);
 const reason=card.statusReason||latest?.reason||null;
 // 전체 상태가 매 이력에 복사되므로 이유를 실제로 기록한 버전만 찾는다.
 const reasonRecord=card.statusReason?(card.history??[]).filter((h,i)=>h.statusReason===card.statusReason&&
  (!i||h.statusReason!==card.history[i-1].statusReason||h.status!==card.history[i-1].status||
   h.noteKind==='progress'&&h.activityAt===h.at&&h.activity!==card.history[i-1].activity)).at(-1):latest;
 const reasonEvidence={text:reason,source:reasonRecord?'card-history':reason?'card-state':null,at:validTime(reasonRecord?.at),by:reasonRecord?.by||null};
 return {latest,reason,resolutionOwner:card.resolutionOwner||null,nextAction:card.nextAction||null,
  displayEvidence:displayEvidence(card),reasonEvidence};
}
const validTime=at=>typeof at==='string'&&Number.isFinite(Date.parse(at))?at:null;
function displayEvidence(card){
 const shown=card.displayState||card.status,runs=card.runs??[];
 const evidence=(text,source,at=null,by=null)=>({text,source,at:validTime(at),by:by||null});
 if(shown==='failed'){
  const failed=runs.filter(r=>r.state==='failed').sort((a,b)=>(Date.parse(a.at)||0)-(Date.parse(b.at)||0)).at(-1);
  // runs.by는 발령자다. 원장의 done 확인자 정보는 현재 합성 결과에 없으므로 추측하지 않는다.
  return evidence(failed?'실행 원장에 실패 결과 기록 · 실패 원인은 별도 확인':'실패 표시의 실행 근거 미확인',failed?'ledger':null,failed?.at);
 }
 if(shown==='orphaned')return evidence('미완료 발령의 담당 세션 없음 · 조회 시각 미기록','session');
 if(['running','waiting'].includes(shown)){
  // 현재 상태를 만든 활동 보고와 이후의 일반 진행 보고 시각을 구분한다.
  const report=currentProgressReport({...card,history:(card.history??[]).filter(h=>h.noteKind!=='progress'||
   h.at===card.activityAt&&h.activityAt===h.at&&h.activity===card.activity)});
  return card.activity===shown&&report.state==='reported'?
   evidence(shown==='running'?'담당자의 작업 시작 보고 확인':'담당자의 결과 대기 보고 확인',report.source,report.at,report.by):
   evidence('현재 활동 보고의 근거 확인 불가',null);
 }
 if(shown==='unconfirmed'){
  const run=runs.find(r=>r.role===card.role&&r.state==='unconfirmed');
  return evidence(run?'발령 기록 있음 · 현재 진행 확인 전':'현재 발령 근거 확인 불가',run?'ledger':null,run?.sentAt,run?.by);
 }
 if(shown==='done'&&card.status!=='done'){
  const done=runs.filter(r=>r.state==='done').sort((a,b)=>(Date.parse(a.at)||0)-(Date.parse(b.at)||0)).at(-1);
  return evidence(done?'실행 원장에 완료 결과 기록':'완료 표시의 실행 근거 미확인',done?'ledger':null,done?.at);
 }
 const changed=(card.history??[]).filter((h,i)=>h.status===card.status&&(!i||h.status!==card.history[i-1].status)).at(-1);
 return evidence('카드 저장 상태: '+(card.status?statusLabel(card.status):'모름'),changed?'card-history':'card-state',changed?.at,changed?.by);
}
const reasonHtml=text=>text.length>180?`${e(text.slice(0,180))}…<details><summary>이유 전체 보기</summary><p>${e(text)}</p></details>`:e(text);
const evidenceMeta=proof=>`<small>출처: ${e(({'card-history':'카드 변경 이력','card-state':'카드 저장 상태',ledger:'실행 원장',session:'세션 조회',progress:'진행 보고 이력',activity:'활동 보고 기록'})[proof.source]||'근거 미확인')} · ${e(proof.by||'기록자 모름')} · ${e(proof.at?new Date(proof.at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false}):proof.source==='session'?'조회 시각 미기록':'시각 미기록')}</small>`;
export function renderStatusContext(card,{decisions=[],decisionError=false}={}){
 const c=statusContext(card),hold=card.status==='hold';
 const open=decisions.some(d=>d.card===card.key&&d.status==='open');
 return `<div class="status-context"><p><strong>현재 표시 근거:</strong> ${e(c.displayEvidence.text)}</p>${evidenceMeta(c.displayEvidence)}<p><strong>사람이 남긴 상태 이유:</strong> ${reasonHtml(c.reason||(hold?'보류 이유 미기록 · 감독 확인 필요':'변경 이유 미기록'))}</p>${evidenceMeta(c.reasonEvidence)}${c.resolutionOwner||hold?`<p>후속 담당: ${e(c.resolutionOwner||'미기록 · 감독 확인 필요')}</p>`:''}${c.nextAction||hold?`<p>다음 행동·해소 조건: ${e(c.nextAction||'미기록 · 감독 확인 필요')}</p>`:''}${hold||open?`<small>${decisionError?'사용자 결정 요청 확인 불가':open?'사용자 결정 필요 · 내 결정 필요에서 확인':'요청된 사용자 결정 없음'}</small>`:''}</div>`;
}
export function renderStatusHistory(card){
 return `<h3>상태 변경 · 진행 보고 이력</h3><ol class="history status-history">${statusChanges(card).map(h=>`<li><strong>${e(h.from?exactStatusLabel(h.from):'등록')} → ${e(exactStatusLabel(h.to))}</strong><small> ${e(h.by)} · ${e(h.at?new Date(h.at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false}):'시각 미기록')}</small><p>${e(h.reason||'변경 이유 미기록')}</p></li>`).join('')}</ol>`;
}
