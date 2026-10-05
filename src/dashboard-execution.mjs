import {currentProgressReport,stateText} from './human-brief.mjs';
import {escapeHtml as e} from './card-content.mjs';
import {isEnded} from './status-labels.mjs';

// 첫 화면 분류 기준(2026-09-12). 오래된 미정리는 담당 세션이 없고 신호가 이 시간보다 오래된 확인 필요 카드다.
export const STALE_MS=24*60*60_000;
export const RECENT_MS=24*60*60_000;

// 카드 편집 시각은 실행 신호로 쓰지 않는다. 기존 발령·보고·결과와 세션 조회만 읽는다.
export function executionHealth(card,now=Date.now()) {
 const state=card.displayState||card.status,report=currentProgressReport(card,now);
 const runs=(card.runs||[]).filter(r=>r.role===card.role);
 const run=runs.at(-1);
 const signals=runs.flatMap(r=>[
  {at:r.sentAt,label:'지시 전달'},
  ...(['done','failed'].includes(r.state)?[{at:r.at,label:r.state==='done'?'실행 완료':'실행 실패'}]:[])
 ]);
 if(report.state==='reported')signals.push({at:report.at,label:'진행 보고'});
 const signal=signals.filter(s=>Number.isFinite(Date.parse(s.at))&&Date.parse(s.at)<=now).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at))[0];
 const result=(kind,label,reason)=>({healthKind:kind,healthLabel:label,healthReason:String(reason||'').slice(0,280),signalAt:signal?.at||null,signalLabel:signal?.label||'실행 신호 없음'});
 if(isEnded(state))return result('closed',stateText[state]||'종료','실행을 마친 카드입니다.');
 // 보류(archived)는 시작 전에 미뤄 둔 카드다. 끝으로 세지 않고, 막힘·오래된 미정리 경보에도 넣지 않는다(2026-10-05 [kyle]).
 if(state==='archived')return result('planned',stateText.archived,card.statusReason||'시작 전에 미뤄 둔 카드입니다. 나중에 할 수도 있습니다.');
 if(state==='hold')return result('hold',stateText.hold,card.statusReason||'시작 뒤 잠시 멈춘 카드라 작업중 집계에서 제외합니다.');
 if(card.connectionErrors?.length||card.ambiguous)return result('attention','기록 연결 실패',card.connectionErrors?.map(x=>`${x.taskId}: ${x.reason}`).join(' · ')||'같은 카드 ID가 겹쳐 실행을 구분할 수 없습니다.');
 if(state==='failed')return result('attention','실패 확인 필요','실패 기록과 후속 조치를 확인하세요.');
 if(state==='orphaned'||run?.sessionState==='absent')return result('attention','세션 확인 필요','미완료 실행의 담당 세션이 확인되지 않습니다.');
 if(['draft','ready'].includes(state))return result('planned',stateText[state],'아직 실행 전입니다.');
 if(run?.sessionState!=='alive')return result('attention','실행 확인 필요',run?.sessionState==='changed'?'담당 세션의 PID가 달라 현재 실행을 확인해야 합니다.':run?'현재 담당 세션의 생존을 확인할 수 없습니다.':'현재 담당의 발령 기록이 없습니다.');
 if(report.state==='unknown')return result('attention','보고 확인 필요','현재 발령과 보고의 작성자·시각을 확인할 수 없습니다.');
 if(state==='running'&&report.state==='reported')return result('running',stateText.running,report.note||'현재 담당의 진행 보고가 있고 수집 시점에 같은 세션이 열려 있습니다.');
 // 결과 대기는 화면에서 작업중으로 부른다. 멈춤 판정을 위해 healthKind는 waiting으로 남긴다(2026-10-05 [kyle]).
 if(state==='waiting'&&report.state==='reported')return result('waiting',stateText.waiting,report.note||'현재 담당이 결과 대기를 보고했습니다. 작업 중단으로 판정하지 않습니다.');
 if(report.state==='reported')return result('attention','활동 보고 확인','진행 메모는 있지만 작업중 활동 보고(kadan card progress --activity running|waiting)가 없어 상태를 확정하지 않습니다.');
 return result('attention','시작 확인 필요','지시 전달 이후 현재 작업 중인지 확인할 진행 보고가 없습니다.');
}
// 첫 화면 묶음. 확인 필요를 '지금 막힌 것'(세션이 살아 있거나 신호가 최근)과 '오래된 미정리'(세션 없음·신호 오래됨)로 나눈다.
export function executionBucket(card,now=Date.now()){
 const h=card.healthKind?card:{...card,...executionHealth(card,now)};
 // 결과 대기도 요약 묶음에서는 작업중으로 센다. 멈춘 것으로 보지 않는 판정은 그대로다(2026-10-05 [kyle]).
 if(h.healthKind==='waiting')return 'running';
 if(h.healthKind!=='attention')return h.healthKind;
 const run=(card.runs||[]).filter(r=>r.role===card.role).at(-1);
 const sessionAlive=run?.sessionState==='alive';
 const signal=Date.parse(h.signalAt);
 const fresh=Number.isFinite(signal)&&now-signal<STALE_MS;
 return sessionAlive||fresh?'stuck':'stale';
}

export function workHealth(work,executions,now=Date.now()) {
 const all=executions.map(x=>x.card?executionHealth(x.card,now):{healthKind:'attention',healthLabel:'실행 기록 모름',healthReason:'연결된 실행 카드를 읽을 수 없습니다.',signalAt:null,signalLabel:'실행 신호 모름'});
 const signal=all.filter(h=>h.signalAt).sort((a,b)=>Date.parse(b.signalAt)-Date.parse(a.signalAt))[0];
 const result=(kind,label,reason)=>({healthKind:kind,healthLabel:label,healthReason:String(reason||'').slice(0,280),signalAt:signal?.signalAt||null,signalLabel:signal?.signalLabel||'실행 신호 없음'});
 if(['done','cancelled'].includes(work.status)){
  if(all.some(h=>h.healthKind!=='closed'))return result('attention','종료 후 실행 확인','업무는 닫혔지만 미종료 또는 미확인 실행이 남아 있습니다.');
  return result('closed',work.status==='done'?'업무 완료':'취소','업무 종료 기록 기준입니다.');
 }
 if(work.status==='hold')return result('hold','업무 보류',work.nextAction||'업무가 보류되어 있습니다.');
 const round=Math.max(0,...executions.map(x=>x.round||0));
 const relevant=all.filter((h,i)=>h.healthKind!=='closed'&&(executions[i].round===round||!executions[i].card||!['done','failed'].includes(executions[i].card.displayState)));
 const counts=kind=>relevant.filter(h=>h.healthKind===kind).length;
 // 결과 대기는 작업중과 한 묶음으로 센다(2026-10-05 [kyle]).
 const reason=[['확인 필요',counts('attention')],['작업중',counts('running')+counts('waiting')],['진행 전',counts('planned')],['일시정지',counts('hold')]].filter(([,n])=>n).map(([name,n])=>name+' '+n+'건').join(' · ');
 if(counts('attention'))return result('attention','실행 확인 필요',reason);
 if(counts('running'))return result('running','작업중',reason);
 if(counts('waiting'))return result('waiting','작업중',reason);
 if(counts('hold'))return result('hold','실행 일시정지',reason);
 if(counts('planned')||!executions.length)return result('planned','실행 준비',reason||'열린 업무지만 아직 연결된 실행이 없습니다.');
 return result('attention','감독 확인 차례','실행은 종료됐고 업무 결과의 최종 확인이 남아 있습니다.');
}

export function renderExecutionHealth(row){
 return `<span class="execution-health eh-${e(row.healthKind||'attention')}" title="${e(row.healthReason||'실행 근거 확인 필요')}">${e(row.healthLabel||'실행 확인 필요')}</span>`;
}
export const executionHealthStyle=`.execution-health{display:inline-block;font-size:12px;font-weight:650;white-space:nowrap}.execution-health::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;background:currentColor}.eh-running{color:#22694d}.eh-waiting{color:#246a99}.eh-attention{color:#94600e}.eh-planned,.eh-closed{color:#626e66}.eh-hold{color:#80578f}.execution-evidence{padding:10px 12px;border-left:3px solid #cbd5ce;background:#f5f8f6;font-size:13px;margin:10px 0}.execution-evidence p{overflow-wrap:anywhere}.dw-health-cell strong,.dw-health-cell small{display:block;overflow:hidden;text-overflow:ellipsis;line-height:17px}.dw-health-cell small{font-size:10px;color:#606b65}`;
