// 이력 전체 배열을 읽던 옛 구현(ba6ab2b)의 복사본. 사실(listFacts) 기반 새 구현과 출력이 같은지 비교하는 기준이다.
// 새 코드에서 쓰지 않는다.
import {legacyCurrentProgressReport as currentProgressReport} from './human-brief.mjs';

// 현재 차례는 작성자와 별개다. 자유 형식 메모에서 받는 사람을 추측하지 않는다.
export function legacyCardTurn(card,now=Date.now()) {
 const result=(owner,label,reason,source=null,at=null,by=null)=>({owner,label,reason,source,at,by});
 const unknown=reason=>result(null,'차례 확인 필요',reason);
 const time=value=>Date.parse(value);
 const valid=value=>Number.isFinite(time(value))&&time(value)<=now;
 const terminal=['done','cancelled','superseded','archived'];
 if(terminal.includes(card.status)&&terminal.includes(card.displayState||card.status))return result(null,'종료','카드가 종료되어 현재 차례가 없습니다.');
 if(card.ambiguous)return unknown('같은 카드 ID가 여러 저장소에 있어 전달 대상을 구분할 수 없습니다.');
 const history=card.history||[],runs=card.runs||[];
 const boundary=history.filter((h,i)=>!i||h.status!==history[i-1].status||h.role!==history[i-1].role).at(-1);
 if(boundary&&!valid(boundary.at))return unknown('배정·상태 변경 시각을 확인할 수 없습니다.');
 if(runs.some(r=>!valid(r.sentAt)||!valid(r.at)))return unknown('전달·실행 시각을 확인할 수 없습니다.');
 if(card.activityAt&&!valid(card.activityAt))return unknown('진행 보고 시각을 확인할 수 없습니다.');
 const dialogue=history.filter(h=>['question','answer'].includes(h.noteKind)).at(-1);
 if(dialogue&&!valid(dialogue.at))return unknown('질문·답변 시각을 확인할 수 없습니다.');
 const actionAt=Math.max(0,time(boundary?.at)||0,...runs.map(r=>time(r.at)),time(card.activityAt)||0);
 const latest=Math.max(actionAt,time(dialogue?.at)||0);
 // 명시 기록은 이후의 발령·진행 전환·질문보다 최신일 때만 사용한다.
 const explicit=history.findLast(h=>Number.isInteger(h.turnRevision)&&h.turnRevision===h.revision&&h.turnRevision===card.turnRevision&&h.turnAt===h.at&&h.turnOwner===card.turnOwner&&h.turnAt===card.turnAt&&h.turnBy===h.by);
 if(card.turnOwner&&explicit&&valid(explicit.at)&&time(explicit.at)>=latest&&
   explicit.role===card.role&&explicit.status===card.status&&(!dialogue||explicit.revision>=dialogue.revision)) {
  return result(card.turnOwner,card.turnOwner,'현재 차례로 지정됨','차례 기록',explicit.at,explicit.by);
 }
 if(dialogue&&time(dialogue.at)>=actionAt)return unknown(dialogue.noteKind==='question'?'답변을 기다리는 질문이 있습니다. 다음에 답할 사람은 명시되지 않았습니다.':'답변 이후 이어서 행동할 사람을 기록하지 않았습니다.');
 if(['hold','draft','ready'].includes(card.displayState||card.status))return unknown('다음에 행동할 사람을 아직 기록하지 않았습니다.');
 const current=runs.filter(r=>['unconfirmed','orphaned'].includes(r.state));
 if(current.length>1)return unknown('여러 역할에 미완료 전달 기록이 있어 한 사람의 차례로 정할 수 없습니다.');
 const run=current[0];
 if(!run)return unknown(runs.length?'실행 결과 이후 이어받을 사람을 기록하지 않았습니다.':'현재 차례를 확인할 전달 기록이 없습니다.');
 if(run.role!==card.role)return unknown('카드의 실행 담당과 미완료 전달 대상이 다릅니다.');
 if(run.state==='orphaned'||run.sessionState!=='alive')return unknown('전달받은 역할의 현재 세션을 확인해야 합니다.');
 const report=currentProgressReport(card,now);
 if(report.state==='unknown'||card.activity==='unknown'&&report.state==='reported')return unknown('현재 진행 보고의 근거를 확인해야 합니다.');
 if(card.displayState==='waiting'||card.activity==='waiting'&&report.state==='reported')return unknown('대기 보고가 있지만 다음에 행동할 사람은 기록되지 않았습니다.');
 if(card.displayState==='running'&&report.state==='reported')return result(card.role,card.role,'작업 진행 보고 기준','진행 보고',report.at,report.by);
 if(!boundary||time(run.sentAt)>=time(boundary.at))return result(run.role,run.role,'마지막 지시를 전달받음','지시 전달',run.sentAt,run.by||null);
 return unknown('현재 배정 이후 차례를 확인할 전달·진행 보고가 없습니다.');
}
