// 이력 전체 배열을 읽던 옛 구현(ba6ab2b)의 복사본. 사실(listFacts) 기반 새 구현과 출력이 같은지 비교하는 기준이다.
// 새 코드에서 쓰지 않는다.
import {statusLabel} from '../../../src/status-labels.mjs';
const stateText=Object.fromEntries(['running','waiting','unconfirmed','orphaned','failed','hold','draft','ready','assigned','done','cancelled','superseded','archived'].map(key=>[key,statusLabel(key)]));
export function legacyCurrentProgressReport(card,now=Date.now()){
 const empty=(state,reason)=>({state,at:null,by:null,note:'',source:null,reason});
 const history=card.history??[],reports=history.filter(h=>h.noteKind==='progress');
 const activity=['running','waiting','unknown'].includes(card.activity)&&card.activityAt!=null;
 if(!card.role)return empty(reports.length||activity?'unknown':'none',reports.length||activity?'role-unknown':'no-report');
 const run=(card.runs??[]).filter(r=>r.role===card.role).at(-1);
 if(!run)return empty('none','no-dispatch');
 const sent=Date.parse(run.sentAt);
 if(!Number.isFinite(sent))return empty('unknown','dispatch-time');
 if(sent>now)return empty('unknown','future-time');
 const assignment=history.filter((h,i)=>h.role===card.role&&h.status==='assigned'&&
  (history[i-1]?.role!==h.role||history[i-1]?.status!=='assigned')).at(-1);
 let since=sent;
 if(assignment){
  const at=Date.parse(assignment.at);
  if(!Number.isFinite(at))return empty('unknown','assignment-time');
  // 과거 발령을 중앙 카드로 이관할 수 있다. 발령·현재 배정 이후의 보고는 인정한다.
  since=Math.max(sent,at);
 }
 const owned=reports.filter(h=>h.by===card.role&&(!h.role||h.role===card.role));
 // 시각이 잘못된 최신 보고를 옛 정상 보고나 복사된 activityAt으로 숨기지 않는다.
 const report=owned.filter(h=>!Number.isFinite(Date.parse(h.at))||Date.parse(h.at)>=since).at(-1);
 const ownActivity=activity&&card.activityRole===card.role;
 const fallback=ownActivity&&(!Number.isFinite(Date.parse(card.activityAt))||Date.parse(card.activityAt)>=since)?{at:card.activityAt,by:card.activityRole,note:'',source:'activity'}:null;
 let selected=report?{at:report.at,by:report.by,note:report.note||'',source:'progress'}:null;
 if(fallback&&(!selected||Number.isFinite(Date.parse(selected.at))&&Date.parse(fallback.at)>Date.parse(selected.at)))selected=fallback;
 if(!selected){
  if(reports.some(h=>(!h.by||h.by==='모름')&&(!h.role||h.role===card.role)&&(!Number.isFinite(Date.parse(h.at))||Date.parse(h.at)>=since)))return empty('unknown','author-unknown');
  if(owned.some(h=>Date.parse(h.at)<since)||ownActivity&&Date.parse(card.activityAt)<since)return empty('none',since>sent?'before-assignment':'before-dispatch');
  return empty('none','no-report');
 }
 const at=Date.parse(selected.at);
 if(!Number.isFinite(at))return empty('unknown','invalid-time');
 if(at>now)return empty('unknown','future-time');
 if(at<since)return empty('none',since>sent?'before-assignment':'before-dispatch');
 return {state:'reported',...selected,reason:null};
}
export function legacyWaitingText(card){
 if(card.displayState!=='waiting')return stateText[card.displayState]||'상태 모름';
 const report=(card.history??[]).filter(h=>h.noteKind==='progress'&&h.activity==='waiting'&&h.activityAt===h.at&&h.at===card.activityAt).at(-1);
 const reason=String(report?.note||'').replace(/\s+/g,' ').trim();
 return reason?`${stateText.waiting} · ${reason.length>120?reason.slice(0,120)+'…':reason} 기다림`:stateText.waiting;
}
