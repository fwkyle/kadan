// Why: 실행 종료 뒤 다음 행동을 기존 기록에서 읽는다. 저장 상태·발령·승인을 바꾸지 않는다.
const time=value=>Date.parse(value)||0;
const closed=c=>['cancelled','superseded','archived'].includes(c.status);
const item=(state,label,owner,next,at=null)=>({state,label,owner:owner||null,next,at});
export const elapsed=(from,to)=>time(from)&&time(to)&&time(to)>=time(from)?time(to)-time(from):null;

function executionFollowup(work,c,decisions){
 const owner=c.resolutionOwner||work.owner;
 const open=decisions.find(d=>d.card===c.key&&d.status==='open');
 if(open)return item('decision','사용자 결정 대기','@user',`${open.question}${c.status!=='hold'&&!c.waiting?' · 해당 실행의 보류·대기 연결 확인 필요':''}`,open.at);
 const answer=decisions.filter(d=>d.card===c.key&&d.status==='answered').at(-1);
 if(answer&&time(answer.answer?.at)>=Math.max(time(c.sentAt),time(c.completedAt),time(c.running||c.waiting?c.activityAt:null)))
  return item('answer','결정 답변 후 재개 확인',owner,answer.delivery?.status==='sent'?'답변 범위와 해당 실행의 재개를 확인하세요.':'결정 답변 전달 실패·미확인: 전달 근거를 확인하세요.',answer.answer.at);
 if(closed(c))return item('closed','실행 종료',null,'',c.at);
 if(c.error||c.reportState==='unknown')return item('unknown','실행 근거 확인 필요',owner,c.error||'발령·완료의 연결 근거를 확인하세요.');
 if(c.status==='hold')return item('hold','실행 보류',owner,c.nextAction||'보류 이유와 재개 조건을 기록하세요.',c.at);
 if(c.reportState==='failed'||c.quality==='exception'||c.quality==='failed')return item('exception','예외 확인 필요',owner,c.nextAction||'실패 근거를 확인하고 복구·보류·취소를 판단하세요.',c.completedAt||c.resultAt);
 if(c.waiting)return item('waiting','외부 결과 대기',c.role,c.nextAction||'대기 대상과 재개 조건을 확인하세요.',c.activityAt);
 if(c.running)return item('running',c.phase==='review'?'검수 중':c.phase==='fix'?'수정 중':'실행 중',c.role,c.nextAction||'배정된 실행을 진행합니다.',c.activityAt);
 if(c.reportState==='ok'){
  if(c.quality==='pass'&&c.phase==='review')return item('confirm','감독 최종 확인 대기',owner,'빠진 적용·후속과 전체 완료 조건을 확인하세요.',c.completedAt);
  if(c.quality==='changes'&&c.phase==='review')return item('fix','수정 연결 대기',owner,'승인 범위·라운드·시간 상한을 확인하고 수정을 연결하세요.',c.completedAt);
  if(['implementation','fix'].includes(c.phase))return item('review','검수 연결 확인',owner,'필요한 독립검수와 연결된 후속 실행을 확인하세요.',c.completedAt);
  return item('confirm','감독 최종 확인 대기',owner,'실행은 종료됐습니다. 품질 근거와 전체 완료 조건을 확인하세요.',c.completedAt);
 }
 if(['ready','draft'].includes(c.status))return item('ready',c.phase==='review'?'검수 연결 대기':c.phase==='fix'?'수정 연결 대기':'실행 준비',owner,c.nextAction||'담당과 승인 범위를 확인하고 발령하세요.',c.at);
 return item('unspecified','다음 행동 미지정',owner,c.nextAction||'발령·현재 진행·다음 담당을 확인하세요.',c.sentAt);
}

export function workFollowup(work,executions,{automatic=null,decisions=[],error=null}={}){
 const steps=executions.map(c=>({...executionFollowup(work,c,decisions),key:c.key}));
 const result=({state,label,owner,next,at})=>({state,label,owner,next,at,executions:steps});
 if(['done','cancelled'].includes(work.status))return result(item('closed',work.status==='done'?'업무 완료':'업무 취소',null,'',work.at));
 if(error||executions.some(c=>c.error||c.reportState==='unknown'))return result(item('unknown','후속 근거 확인 필요',work.owner,error||'일부 실행의 연결 근거를 확인하지 못했습니다.'));
 if(work.status==='hold')return result(item('hold','업무 보류',work.turnOwner||work.owner,work.nextAction||'보류 이유와 재개 조건을 기록하세요.',work.at));
 // 옛 자동 종료가 이후 수동 실행·새 연결을 덮지 않는다.
 const auto=automatic&&JSON.stringify(automatic.links)===JSON.stringify(work.executions)&&executions.find(c=>c.key===automatic.current?.key);
 const autoState=automatic?.status==='notifying'?automatic.terminal:automatic?.status;
 const reasons={pass:['confirm','감독 최종 확인 대기','검수 합격 근거와 전체 완료 조건을 확인하세요.'],boundary:['boundary','다음 블록 판단 대기','3라운드가 끝났습니다. 교대·계속·보류를 판단하세요.'],limit:['limit','사용자 결정 요청 필요','전체 라운드 상한에 도달했습니다. 기존 결정 요청 경로로 판단을 요청하세요.'],exception:['exception','예외 확인 필요','자동 전달의 실패·불명확 근거를 확인하세요.']};
 const pending=steps.filter((s,i)=>!closed(executions[i])&&!['ok','failed'].includes(executions[i].reportState));
 let next;
 if(pending.length){
  next=pending.length===1?pending[0]:item('parallel','여러 실행의 후속 처리',[...new Set(pending.map(s=>s.owner).filter(Boolean))].join(' · '),pending.map(s=>`${s.label}: ${s.key}`).join(' / '));
 }else{
  const round=Math.max(0,...executions.filter(c=>!closed(c)).map(c=>Number(c.round)||0));
  const latest=steps.filter((s,i)=>!closed(executions[i])&&Number(executions[i].round)===round);
  next=latest.find(s=>['decision','answer','exception','fix'].includes(s.state))||latest.find(s=>executions.find(c=>c.key===s.key)?.phase==='review')||latest[0];
 }
 if(auto&&autoState==='pass'&&(auto.reportState!=='ok'||auto.quality!=='pass'))return result(item('unknown','자동 합격 근거 확인 필요',work.owner,'자동 상태와 현재 실행의 완료·품질 판정이 일치하지 않습니다.'));
 if(auto&&reasons[autoState]&&!steps.some(s=>['decision','answer'].includes(s.state))){
  const [state,label,action]=reasons[autoState];
  next=item(state,label,work.owner,action+(automatic.notification?.status==='unknown'?' · 최종 통지 전달 미확인':''),automatic.at);
 }
 next||=item('unspecified','다음 행동 미지정',work.owner,'다음 실행과 담당자를 기록하세요.');
 // 기존 업무 입력이 새 결과보다 앞서면 옛 다음 행동으로 덮지 않는다.
 const changed=(work.history||[]).filter((h,i,a)=>h.nextAction&&(!i||h.nextAction!==a[i-1].nextAction||h.turnOwner!==a[i-1].turnOwner)).at(-1);
 const newest=Math.max(0,...executions.map(c=>Math.max(time(c.sentAt),time(c.completedAt),time(c.resultAt),time(c.activityAt))),time(auto?automatic.at:null),...decisions.map(d=>time(d.answer?.at||d.at)));
 if(changed&&time(changed.at)>=newest&&!['decision','answer','unknown'].includes(next.state))next=item('assigned','기록된 다음 행동',work.turnOwner||work.owner,work.nextAction,changed.at);
 return result(next);
}
