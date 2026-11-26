// Why: '마감하면 실행 카드도 닫는다'(#495) 전에 마감한 업무의 실행 카드가 assigned 등으로 남아, 대시보드가 끝난 일을
// '오래된 미확정'·'꺼짐·인계 필요'로 띄운다. 그 카드를 같은 규칙으로 한 번에 닫는다. 기본은 미리보기이고 apply일 때만 쓴다.
// #495의 닫기 계획은 마감 관문을 통과한 카드만 받으므로, 여기서는 카드마다 그 관문을 다시 걸고 못 닫는 이유를 센다.
//
// 비용: 사람이 부르는 단발 명령이고 주기 경로에 없다. 업무·카드·원장 전체를 한 번 읽는다(원장·카드가 10배면 시간·메모리도
// 약 10배). 닫는 카드마다 그 카드 이력만 읽고 한 줄을 쓴다(card-store.mjs closeDone). 도는 동안 원장에 새 줄이 붙으면 그 줄을
// 닫을 카드 ID 전부와 대조하므로, 그 비용은 새 줄 수 × 닫을 장수에 비례한다.
import {CardStore} from './card-store.mjs';
import {WorkStore,closableExecution} from './work-store.mjs';
import {buildCardCenter} from './card-center.mjs';
import {readLedger} from './ledger.mjs';
import {storageSnapshot,storageVersion} from './storage.mjs';
import {isEnded} from './status-labels.mjs';
import {planCardClose,stillClosedAndLinked,cardCloseLines,cardCloseReasonCode} from './work-card-close.mjs';
import {CLOSE_WORDS,closeNoteHead} from './work-close-note.mjs';

// 끝난 업무는 메모 낱말이 있는 상태(done·cancelled)다. 그 밖(open·hold·모르는 값)은 끝나지 않은 업무로 본다.
const isClosedWork=work=>Object.hasOwn(CLOSE_WORDS,work.status);
export const BACKFILL_SKIP_LABELS={
  'open-work':'끝나지 않은 업무에도 연결됨',
  missing:'카드 없음',
  ambiguous:'실행 연결 모호',
  unfinished:'끝나지 않은 실행(미완료 발령·발령 기록 없음·완료 뒤 상태를 다시 바꿈)',
};
const SAMPLE_MAX=5;

const countBy=(items,key)=>items.reduce((out,item)=>{const name=key(item);out[name]=(out[name]??0)+1;return out;},{});

// 판정에 쓰는 값은 모두 읽기 트랜잭션 하나에서 읽는다. version이 이 읽기와 같은 시점이어야 closeDone의
// '판정 뒤 새 기록' 보호가 성립한다(나중에 따로 재면 그 사이에 붙은 발령을 못 본다).
function readSnapshot(home){
  return storageSnapshot(home,()=>({
    version:storageVersion(home),
    works:new WorkStore(home).listLatest(),
    cards:new CardStore(home).list(),
    entries:readLedger(home),
  }));
}

// 실행 키마다 연결한 업무 전부(열린 업무 포함). 한 실행을 두 업무가 가리키는 옛 기록을 여기서 가려낸다.
function linksByExecution(works){
  const links=new Map();
  for(const work of works)for(const key of new Set(work.executions.map(x=>x.key))){
    if(!links.has(key))links.set(key,[]);
    links.get(key).push(work);
  }
  return links;
}

function judge(works,cards){
  const links=linksByExecution(works),byKey=new Map(cards.map(card=>[card.key,card]));
  const passed=[],skipped=[],workKeys=new Map();
  const counts={closedWorks:works.filter(isClosedWork).length,linkedExecutions:0,alreadyEnded:0,multiLinked:0,multiLinkedWithOpen:0};
  for(const [key,linked] of links){
    const closed=linked.filter(isClosedWork),hasOpen=closed.length<linked.length;
    if(linked.length>1){counts.multiLinked++;if(hasOpen)counts.multiLinkedWithOpen++;}
    if(!closed.length)continue;
    counts.linkedExecutions++;
    const card=byKey.get(key);
    if(card&&isEnded(card.status)){counts.alreadyEnded++;continue;}
    // 마감 관문(work-store.mjs #change)과 같은 세 조건에, 끝나지 않은 업무가 아직 쓰는 카드를 더한다.
    const reason=hasOpen?'open-work':!card?'missing':card.ambiguous?'ambiguous':!closableExecution(card)?'unfinished':null;
    if(reason)skipped.push({key,reason,from:card?.status??null,state:card?.displayState??null,works:linked.map(w=>w.key)});
    else{passed.push({key});workKeys.set(key,closed);}
  }
  const plan=planCardClose(passed,cards).map(item=>({...item,works:workKeys.get(item.key).map(({key,status})=>({key,status}))}));
  return {counts,plan,skipped,assigned:assignedBreakdown(cards,links,plan,skipped)};
}

// 저장 상태 assigned 전체가 어디에 속하는지. '남은 assigned'가 왜 이 명령의 대상보다 많은지 설명한다.
function assignedBreakdown(cards,links,plan,skipped){
  const assigned=cards.filter(card=>card.status==='assigned');
  const toClose=new Set(plan.map(p=>p.key)),held=new Set(skipped.map(s=>s.key));
  return {total:assigned.length,...countBy(assigned,({key})=>toClose.has(key)?'toClose':held.has(key)?'skipped':
    links.has(key)?'openWorkOnly':'noWork')};
}

function summarize({counts,plan,skipped,assigned}){
  const byReason={};
  for(const [reason,label] of Object.entries(BACKFILL_SKIP_LABELS)){
    const items=skipped.filter(s=>s.reason===reason);
    if(items.length)byReason[reason]={label,count:items.length,byFrom:countBy(items,s=>s.from??'모름'),
      sample:items.slice(0,SAMPLE_MAX).map(s=>s.key)};
  }
  return {counts,assigned,
    total:plan.length,
    byRepo:countBy(plan,p=>p.key.split('/')[0]),
    byFrom:countBy(plan,p=>p.from),
    byResult:{ok:0,failed:0,...countBy(plan,p=>p.result)},
    skipped:{total:skipped.length,byReason,cards:skipped},
    cards:plan.map(({key,from,result,works})=>({key,from,result,works:works.map(w=>w.key)}))};
}

// 원래 마감의 자동 닫기와 카드 이력에서 구분되도록 '소급'을 적는다.
function noteFor({works,result,runs}){
  const [first,...others]=works,rest=others.map(w=>`업무 ${w.key} ${CLOSE_WORDS[w.status]}`);
  return `${closeNoteHead('backfill',first.key,first.status)}${result} (${runs.join(' · ')})`
    +(rest.length?` · 함께 연결된 끝난 업무: ${rest.join(', ')}`:'');
}

export function backfillCloseCards(home,{apply=false,by='사람'}={}){
  const {version,works,cards,entries}=readSnapshot(home);
  const judged=judge(works,buildCardCenter({cards,entries,tree:[],runtimeKnown:false}).cards);
  const summary=summarize(judged);
  if(apply!==true)return {apply:false,...summary};
  // 카드를 연결한 끝난 업무가 모두 지금도 끝나 있고 연결이 남아 있을 때만 닫는다(카드마다 쓰기 직전, 쓰기 잠금 안).
  const guards=new Map(judged.plan.map(p=>[p.key,p.works.map(w=>stillClosedAndLinked(home,w.key))]));
  const items=judged.plan.map(p=>({key:p.key,revision:p.revision,role:p.role,note:noteFor(p)}));
  const {closed,failed}=new CardStore(home).closeDone(items,{version,by,guard:key=>{for(const check of guards.get(key))check(key);}});
  const written=new Set(closed);
  return {apply:true,...summary,
    closed:judged.plan.filter(p=>written.has(p.key)).map(({key,from,result})=>({key,from,result})),
    failed,failedByReason:countBy(failed,f=>cardCloseReasonCode(f.reason))};
}

// CLI가 stderr에 보이는 줄. 전체 목록은 JSON(stdout)에 있다.
export function backfillLines(result){
  const pairs=counts=>Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([name,n])=>`${name} ${n}`).join(' · ');
  const keys=(sample,count)=>`${sample.join(', ')}${count>sample.length?` 외 ${count-sample.length}장`:''}`;
  const {total,byRepo,byFrom,byResult,skipped}=result;
  const lines=[`끝난 업무의 실행 카드 소급 닫기${result.apply?'':' 미리보기'}: 닫을 대상 ${total}장 (원장 ok ${byResult.ok} · failed ${byResult.failed})`];
  if(total)lines.push(`  저장소별: ${pairs(byRepo)}`,`  원래 상태: ${pairs(byFrom)}`);
  if(skipped.total){
    lines.push(`  닫지 않는 카드 ${skipped.total}장:`);
    for(const {label,count,sample} of Object.values(skipped.byReason))lines.push(`    ${label} ${count}장: ${keys(sample,count)}`);
  }
  if(!result.apply){
    lines.push(total?'아무것도 쓰지 않았습니다. 닫으려면: kadan work backfill-close --apply':'아무것도 쓰지 않았습니다. 닫을 카드가 없습니다.');
    return lines;
  }
  lines.push(...cardCloseLines({closed:result.closed}));
  if(result.failed.length){
    const sample=result.failed.slice(0,SAMPLE_MAX).map(f=>`${f.key} — ${f.reason}`);
    lines.push(`실행 카드 닫기 실패 ${result.failed.length}장: ${keys(sample,result.failed.length)}`,
      '  이유를 확인한 뒤 미리보기부터 다시 실행하세요. 새 기록이 생긴 카드는 아직 쓰는 카드일 수 있습니다.');
  }else if(!result.closed.length)lines.push('새로 닫은 카드가 없습니다.');
  return lines;
}
