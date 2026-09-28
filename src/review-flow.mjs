import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {buildRallies} from './rallies.mjs';

const outcomes={implemented:'구현 결과 등록',pass:'통과',changes:'수정 필요',exception:'검수 중단',ok:'실행 완료',failed:'실행 실패'};
const states={draft:'초안',ready:'실행 전',assigned:'배정됨',running:'작업 중',waiting:'결과 대기',unconfirmed:'시작 확인 전',orphaned:'연결 끊김',hold:'보류',done:'실행 완료',failed:'실행 실패',cancelled:'취소',superseded:'대체됨',archived:'보관'};
const ended=new Set(['cancelled','superseded']);
const date=value=>Date.parse(value)||0;

// 결과 판정과 실행 종료는 별개다. 새 발령 뒤에는 이전 결과를 현재 검수로 세지 않는다.
function stage(card){
 const result=card.result,latestSend=Math.max(0,...(card.runs||[]).map(r=>date(r.sentAt)));
 const history=card.history||[],registered=history.find(h=>h.result);
 const changed=registered&&['scope','role','repoPath'].some(key=>registered[key]!==card[key]);
 const reopened=history.some((h,i)=>i>0&&h.status!==history[i-1].status&&['draft','ready','assigned'].includes(h.status)&&date(h.at)>date(result?.at));
 const stale=!!result&&(!date(result.at)||latestSend>date(result.at)||changed||reopened);
 const current=!!result&&!stale&&!ended.has(card.displayState);
 return {key:card.key,title:card.title,role:card.role,step:card.rallyStep,
  state:card.displayState,stateLabel:states[card.displayState]||'상태 모름',
  recordedOutcome:result?.outcome||null,
  outcome:current?result.outcome:null,outcomeLabel:current?(outcomes[result.outcome]||'판정 모름'):result?'이전 판정 · '+(outcomes[result.outcome]||'모름'):'결과 미등록',
  resultAt:result?.at||null,resultBy:result?.by||null,hasResult:!!result,stale};
}

export function buildReviewFlows(cards=[]){
 return buildRallies(cards).map(group=>{
  const rounds=group.rounds.map(number=>{
   const own=group.cards.filter(c=>Number(c.rallyRound)===number);
   return {number,work:own.filter(c=>['implementation','fix'].includes(c.rallyStep)).map(stage),review:own.filter(c=>c.rallyStep==='review').map(stage)};
  });
  const warnings=[];
  if(new Set(group.cards.map(c=>c.rallyTitle)).size>1)warnings.push('같은 묶음의 제목이 서로 다릅니다.');
  if(rounds.some((r,i)=>r.number!==i+1))warnings.push('중간 라운드 연결이 빠져 있습니다.');
  for(const round of rounds){
   if(!round.work.length)warnings.push(`${round.number}라운드의 구현·수정 카드가 연결되지 않았습니다.`);
   if(round.work.length>1||round.review.length>1)warnings.push(`${round.number}라운드에 같은 단계가 여러 장입니다. 연결을 확인하세요.`);
   if(!round.review.length&&round.number<group.round)warnings.push(`${round.number}라운드의 검수 카드가 연결되지 않았습니다.`);
  }
  const reviews=rounds.flatMap(r=>r.review),work=rounds.flatMap(r=>r.work);
  const reviewCount=reviews.filter(c=>['pass','changes'].includes(c.recordedOutcome)).length;
  const fixCount=rounds.flatMap(r=>r.work.filter(c=>(c.step==='fix'||r.number>1)&&c.recordedOutcome==='implemented')).length;
  const latest=rounds.at(-1),review=latest?.review[0];
  let verdict='pending',label='검수 대기';
  if(review?.outcome==='pass'){verdict='pass';label='최종 검수 통과';}
  else if(review?.outcome==='changes'){verdict='changes';label='수정 필요';}
  else if(review?.outcome==='exception'||review?.state==='failed'){verdict='exception';label='검수 중단';}
  else if(review){label=review.outcome==='ok'||review.state==='done'?'검수 판정 미기록':review.state==='running'?'검수 중':'검수 대기';}
  if(review?.outcome==='pass'&&latest.work.some(c=>c.stale||date(c.resultAt)>date(review.resultAt))){verdict='pending';label='구현 변경 뒤 재검수 필요';}
  if(warnings.length){verdict='unconfirmed';label='연결 확인 필요';}
  else if(!latest){verdict='unconfirmed';label='검수 연결 전';}
  // 뒤의 구현 결과가 아직 없으면 앞선 라운드의 PASS를 최종 판정으로 쓰지 않는다.
  else if(latest.work.some(c=>!c.outcome)&&verdict==='pending'&&label==='검수 대기')label=latest.number>1?'수정 진행 중':'구현 진행 중';
  const summary=`검수 ${reviewCount}회 · 수정 ${fixCount}회 · ${label}`;
  return {id:group.key,title:group.title||group.id,cardKeys:group.cards.map(c=>c.key),reviewCount,fixCount,verdict,label,summary,rounds,warnings,
   pendingResults:[...work,...reviews].filter(c=>c.hasResult&&c.stale).length};
 });
}

// 경로는 요청값을 받지 않는다. 등록 당시 지문과 일치하는 결과만 원문으로 보여준다.
export function readReviewResult(card){
 const result=card.result;
 if(!result)return {error:'등록된 결과가 없습니다.'};
 try{
  const stat=fs.lstatSync(result.path);
  if(!stat.isFile()||stat.size>1024*1024)return {error:'결과 파일을 표시할 수 없습니다 (일반 파일·1MB 이하만 지원).'};
  const bytes=fs.readFileSync(result.path);
  if(bytes.length!==result.bytes||createHash('sha256').update(bytes).digest('hex')!==result.sha256)return {error:'등록 뒤 결과 파일이 바뀌었습니다. 현재 파일을 당시 검수 근거로 표시하지 않습니다.'};
  return {body:bytes.toString('utf8'),outcome:result.outcome,outcomeLabel:outcomes[result.outcome]||'판정 모름',at:result.at,by:result.by};
 }catch{return {error:'등록된 결과 파일을 읽을 수 없습니다.'};}
}
