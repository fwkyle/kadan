import {workEntries,effectiveCardRole} from './handover-state.mjs';
// 같은 발령(카드·담당·전달 시각)의 시작보고누락 경보가 한 번 울리고 해소(또는 감시제외)됐으면 다시 만들지 않는다.
// 아직 해소되지 않은 경보는 seedAlertState가 복원하므로 여기서 막지 않는다(막으면 즉시 해소 편지가 나간다).
// 감시기를 다시 띄울 때마다 며칠 지난 발령으로 같은 경보를 또 보내던 잡음(2026-09-12 실측)을 막는다.
export function alertedStartReports(entries){
 const latest=new Map();
 for(const e of entries||[])if(e?.kind==='alert'&&typeof e.id==='string'&&e.id.startsWith('start-report:'))latest.set(e.id,e);
 return new Set([...latest.values()].filter(e=>e.resolved===true).map(e=>e.id));
}
// states: 감시기가 이번 실행에서 관찰한 세션 상태(unchangedMs). 새 경보는 화면이 유예 시간만큼 멈춰 있을 때만 만든다.
// active: 이미 울려서 살아 있는 경보 id. 재시작 뒤 복원된 경보는 화면 관찰이 다시 쌓이기 전이라도 조건이 남아 있으면 유지한다.
// 발령 후 경과 시간만으로는 알리지 않는다 — 검수자가 한창 작업 중인데 시작 보고가 없다고 알리던 오경보(2026-09-12)를 막는다.
export function assessMissingStartReports(cards,entries,observations,now,graceMs,{states=null,alerted=null,active=null}={}){
 cards=cards.map(c=>({...c,role:effectiveCardRole(c,entries)}));
 const pending=new Map();for(const e of workEntries(entries)){if(!e.role||!e.taskId)continue;const k=e.role+'\0'+e.taskId;if(e.kind==='send')pending.set(k,e);if(e.kind==='done')pending.delete(k);}
 const counts=new Map();for(const c of cards)counts.set(c.id,(counts.get(c.id)||0)+1);
 const alerts=[];
 for(const c of cards){
  if(c.status!=='assigned'||!c.role||counts.get(c.id)!==1)continue;
  const sent=pending.get(c.role+'\0'+c.id),at=Date.parse(sent?.t);if(!Number.isFinite(at)||now-at<graceMs)continue;
  if(['running','waiting'].includes(c.activity)&&c.activityRole===c.role&&Date.parse(c.activityAt)>=at&&Date.parse(c.activityAt)<=now)continue;
  const seen=observations.get('kadan-'+c.role);
  if(!seen?.alive||seen.digest==null||seen.expectedPid!=null&&String(seen.pid)!==String(seen.expectedPid))continue;
  const done=(seen.screen||'').trimEnd().split('\n').slice(-6).some(line=>{const m=line.trim().match(/^KADAN:DONE (\S+) (ok|failed)$/);return m?.[1]===c.id;});if(done)continue;
  const id=`start-report:${c.key}:${c.role}:${sent.t}`;
  if(!active?.has(id)){
   if(states&&(states.get('kadan-'+c.role)?.unchangedMs??0)<graceMs)continue;
   if(alerted?.has(id))continue;
  }
  alerts.push({id,kind:'시작보고누락',role:c.role,session:'kadan-'+c.role,taskId:c.id,level:'AMBER',sentAt:sent.t,waitMinutes:Math.floor((now-at)/60000)});
 }
 return alerts;
}
