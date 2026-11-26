// Why: 업무를 마감해도 실행 카드의 저장 상태가 assigned 등으로 남아, 대시보드가 이미 끝난 작업자·감독을 '꺼짐·인계 필요'·
// '오래된 미확정'으로 띄웠다(2026-11-26). 마감이 저장된 뒤 그 업무에 연결된 열린 실행 카드만 done으로 닫는다.
// 카드 상태에는 failed가 없어 실패한 실행도 done이고, 원장 결과는 메모(상태 이유)와 실행 기록에 남는다.
//
// 비용: 계획은 마감 관문이 이미 계산한 카드 센터를 써서 추가 읽기가 없다. 닫기는 카드 한 장마다 card update 한 번이고,
// card update는 담당 확인용으로 원장 전체와 카드 요약 목록을 읽는다(원장·카드가 10배면 장당 시간도 약 10배).
// 마감 명령 한 번에만 돌고 주기 경로에는 없다.
import {CardStore} from './card-store.mjs';
import {isEnded} from './status-labels.mjs';

const LIST_MAX=10;
const ACTION_LABEL={complete:'완료',cancel:'취소'};

// executions: 업무에 연결된 실행. cards: 마감 관문을 통과한 카드 센터의 카드(연결 실행이 모두 있고 끝나 있다).
// 저장 상태가 끝 묶음(done·cancelled·superseded)인 카드는 이미 정리된 것이라 뺀다. 그 밖(draft·ready·assigned·hold·archived)은
// 실행 기록이 모두 끝났기 때문에 관문을 통과한 것이라, 표시 상태는 done 또는 failed다.
export function planCardClose(executions,cards){
  const byKey=new Map(cards.map(card=>[card.key,card]));
  return executions.flatMap(({key})=>{
    const card=byKey.get(key);
    if(isEnded(card.status))return [];
    return [{key,from:card.status,revision:card.revision,result:card.displayState==='failed'?'failed':'ok',
      runs:card.runs.map(run=>`${run.role} ${run.state==='failed'?'failed':'ok'}`)}];
  });
}

// 던지지 않는다. 업무 마감은 이미 저장됐으므로 닫지 못한 카드는 이유와 함께 돌려준다.
// 계획 때의 revision으로만 쓴다: 그 사이 바뀐 카드는 덮어쓰지 않는다. 이미 닫힌 카드는 기록 없이 넘어간다.
export function closeWorkCards(home,plan,{workKey,action,by}){
  const store=new CardStore(home),out={closed:[],failed:[]};
  for(const {key,from,revision,result,runs} of plan){
    try{
      if(isEnded(store.get(key,{body:false}).status))continue;
      store.update(key,{status:'done'},{revision,by,
        note:`업무 ${workKey} ${ACTION_LABEL[action]} 마감으로 자동 닫음 · 원장 결과 ${result} (${runs.join(' · ')})`});
      out.closed.push({key,from,result});
    }catch(error){out.failed.push({key,reason:error.message});}
  }
  return out;
}

// CLI가 stderr에 보이는 줄. 전체 목록은 JSON의 cardClose에 있다.
export function cardCloseLines(cardClose){
  const {closed=[],failed=[]}=cardClose??{},lines=[];
  const listed=(items,text)=>`${items.slice(0,LIST_MAX).map(text).join(', ')}${items.length>LIST_MAX?` 외 ${items.length-LIST_MAX}장`:''}`;
  if(closed.length)lines.push(`실행 카드 ${closed.length}장 닫음: ${listed(closed,c=>`${c.key}(${c.result})`)}`);
  if(failed.length){
    lines.push(`실행 카드 닫기 실패 ${failed.length}장(업무 마감은 기록됨): ${listed(failed,f=>`${f.key} — ${f.reason}`)}`);
    lines.push('  카드 상태를 확인한 뒤 직접 닫기: kadan card update <카드키> --revision <최신> --status done --note <이유>');
  }
  return lines;
}
