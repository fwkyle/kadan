// Why: 업무를 마감해도 실행 카드의 저장 상태가 assigned 등으로 남아, 대시보드가 이미 끝난 작업자·감독을 '꺼짐·인계 필요'·
// '오래된 미확정'으로 띄웠다(2026-11-26). 마감이 저장된 뒤 그 업무에 연결된 열린 실행 카드만 done으로 닫는다.
// 카드 상태에는 failed가 없어 실패한 실행도 done이고, 원장 결과는 메모(상태 이유)와 실행 기록에 남는다.
//
// 비용: 계획과 담당은 마감 관문이 이미 읽은 원장·카드로 만들고, 닫기는 원장 전체를 다시 읽지 않는다(card-store.mjs closeDone).
// 카드 한 장마다 그 카드 이력만 읽고 한 줄을 쓴다. 판정 뒤 원장에 줄이 붙었으면 그 새 줄만 읽는다.
// 마감 명령 한 번에만 돌고 주기 경로에는 없다.
import {CardStore} from './card-store.mjs';
import {streamHeads} from './storage.mjs';
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
    return [{key,from:card.status,revision:card.revision,role:card.role,result:card.displayState==='failed'?'failed':'ok',
      runs:card.runs.map(run=>`${run.role} ${run.state==='failed'?'failed':'ok'}`)}];
  });
}

// 마감 저장과 닫기 사이에는 업무가 다시 열리거나 카드가 다른 업무로 옮겨 갈 수 있다. 업무 기록만 바뀌어 카드 revision과
// 원장은 그대로이므로, 카드마다 쓰기 직전(쓰기 잠금 안)에 이 업무의 최신 기록 한 줄만 읽어 확인한다(이력·원장은 읽지 않는다).
// 한 실행은 한 업무에만 연결된다(work-store의 link·execute가 같은 잠금 안에서 거절한다). 이 업무에 남아 있으면 다른 업무에는 없다.
function stillClosedAndLinked(home,workKey){
  const stream=`works/${workKey}/events.jsonl`;
  return key=>{
    const head=streamHeads(home,[stream]).get(stream);
    if(!head)throw new Error('업무 기록을 읽지 못해 닫지 않음');
    const work=JSON.parse(head.payload);
    if(!['done','cancelled'].includes(work.status))throw new Error('마감 뒤 업무가 다시 열려 닫지 않음');
    if(!work.executions.some(x=>x.key===key))throw new Error('마감 뒤 이 업무에서 연결이 빠져 닫지 않음');
  };
}

// 폼 응답(303)은 이동 주소에만 실을 수 있어 이유를 짧은 구분값으로 바꾼다. 주소에는 자유 문구를 넣지 않는다.
const REASON_CODES=[['record',/새 원장 기록/],['reopened',/업무가 다시 열려/],['unlinked',/연결이 빠져/],
  ['changed',/카드가 변경됨/],['busy',/새 기록이 계속 붙어/]];
export const cardCloseReasonCode=reason=>REASON_CODES.find(([,pattern])=>pattern.test(reason))?.[0]??'error';
// 이동 주소가 지나치게 길어지지 않게 앞의 것만 싣고 나머지는 수로 알린다.
const QUERY_MAX=50;
export function cardCloseQuery(failed=[]){
  if(!failed.length)return '';
  const listed=failed.slice(0,QUERY_MAX).map(f=>`${f.key}:${cardCloseReasonCode(f.reason)}`).join(',');
  const more=failed.length>QUERY_MAX?`&closeFailedMore=${failed.length-QUERY_MAX}`:'';
  return `&closeFailed=${encodeURIComponent(listed)}${more}`;
}

// 던지지 않는다. 업무 마감은 이미 저장됐으므로 닫지 못한 카드는 이유와 함께 돌려준다.
// 계획 때의 revision과 원장 버전으로만 닫는다: 그 사이 카드가 바뀌었거나 그 카드의 새 원장 기록이 생겼으면 닫지 않는다.
// 이미 닫힌 카드는 기록 없이 넘어간다.
export function closeWorkCards(home,plan,{workKey,action,by,version}){
  const items=plan.map(({key,revision,role,result,runs})=>({key,revision,role,
    note:`업무 ${workKey} ${ACTION_LABEL[action]} 마감으로 자동 닫음 · 원장 결과 ${result} (${runs.join(' · ')})`}));
  const {closed,failed}=new CardStore(home).closeDone(items,{version,by,guard:stillClosedAndLinked(home,workKey)});
  const written=new Set(closed);
  return {closed:plan.filter(p=>written.has(p.key)).map(({key,from,result})=>({key,from,result})),failed};
}

// CLI가 stderr에 보이는 줄. 전체 목록은 JSON의 cardClose에 있다.
export function cardCloseLines(cardClose){
  const {closed=[],failed=[]}=cardClose??{},lines=[];
  const listed=(items,text)=>`${items.slice(0,LIST_MAX).map(text).join(', ')}${items.length>LIST_MAX?` 외 ${items.length-LIST_MAX}장`:''}`;
  if(closed.length)lines.push(`실행 카드 ${closed.length}장 닫음: ${listed(closed,c=>`${c.key}(${c.result})`)}`);
  if(failed.length){
    lines.push(`실행 카드 닫기 실패 ${failed.length}장(업무 마감은 기록됨): ${listed(failed,f=>`${f.key} — ${f.reason}`)}`);
    lines.push('  닫지 않은 이유부터 확인하세요(새 실행·다시 열린 업무·옮긴 카드는 아직 쓰는 카드일 수 있음). 닫아도 되면 직접: '
      +'kadan card update <카드키> --revision <최신> --status done --note <이유>');
  }
  return lines;
}
