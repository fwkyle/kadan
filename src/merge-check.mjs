// 머지 직전 표시: 독립 검수가 본 커밋(검수 SHA)과 PR head를 나란히 보인다. 표시만 한다 — 머지를 막는 관문이 아니다.
// PR head는 입력이다(슈퍼감독이 `gh pr view --json headRefOid`로 갖고 있는 값). 카단은 GitHub를 부르지 않는다.
// 판정: 같음 / 같은 커밋 검수 changes / 다름 / 모호 / 검수 SHA 없음 / 검수 pass 없음.
// 10배 점검: 한 번 치고 끝나는 명령이다. 카드 목록을 한 번 읽는다(work close와 같은 비용). 상주 경로 아님.
import {CardStore} from './card-store.mjs';
import {WorkStore} from './work-store.mjs';
import {buildCardCenter} from './card-center.mjs';
import {readLedger} from './ledger.mjs';
import {stage} from './review-flow.mjs';
import {normalizeSha,sameCommit} from './review-sha.mjs';

const date=value=>Date.parse(value)||0;

// 업무에 연결된 review 단계 실행 중 낡지 않은 pass·changes 판정. 최근 것부터(같은 시각이면 나중에 연결된 것이 앞).
function currentReviews(home,work){
 const center=buildCardCenter({cards:new CardStore(home).list(),entries:readLedger(home),tree:[],runtimeKnown:false});
 const picks=[];
 work.executions.forEach((link,index)=>{
  const card=center.cards.find(c=>c.key===link.key);
  if(!card||(link.phase!=='review'&&card.rallyStep!=='review'))return;
  const s=stage(card);
  if(s.outcome==='pass'||s.outcome==='changes')picks.push({key:card.key,at:s.resultAt,outcome:s.outcome,index,sha:normalizeSha(card.result?.reviewedSha),source:card.result?.reviewedShaSource??null});
 });
 return picks.sort((a,b)=>date(b.at)-date(a.at)||b.index-a.index);
}

// 업무에 연결된 review 단계 실행 중 낡지 않은 pass 가운데 가장 최근 것. 없으면 null.
export function latestPassReview(home,work){
 return currentReviews(home,work).find(r=>r.outcome==='pass')??null;
}

// PR head와 같은 커밋(SHA)을 본 검수를 골라 판정한다. 다른 PR의 검수가 나중에 있어도 덮이지 않는다.
export function mergeCheck(workKey,{head}={},{home}){
 if(typeof workKey!=='string'||!workKey.includes('/'))throw usage('업무 키(저장소/업무ID)가 필요합니다');
 const headSha=normalizeSha(head);
 if(!headSha)throw usage('--head에는 PR head 커밋(7~40자리 16진)이 필요합니다');
 const reviews=currentReviews(home,new WorkStore(home).get(workKey));
 const passes=reviews.filter(r=>r.outcome==='pass');
 const base={workKey,head:headSha,reviewSha:null,review:null,passShas:[]};
 if(!passes.length)return {...base,result:'검수 pass 없음'};
 const passShas=passes.filter(r=>r.sha).slice(0,5).map(r=>({sha:r.sha,key:r.key}));
 if(!passShas.length)return {...base,result:'검수 SHA 없음',review:passes[0]};
 const same=reviews.filter(r=>r.sha&&sameCommit(r.sha,headSha));
 if(!same.length)return {...base,result:'다름',review:passes.find(r=>r.sha),reviewSha:passShas[0].sha,passShas};
 const ambiguous=same.some(x=>same.some(y=>!sameCommit(x.sha,y.sha)));
 if(ambiguous)return {...base,result:'모호',passShas:same.map(r=>({sha:r.sha,key:r.key}))};
 return {...base,result:same[0].outcome==='pass'?'같음':'같은 커밋 검수 changes',review:same[0],reviewSha:same[0].sha};
}
const usage=message=>Object.assign(new Error(message),{exitCode:2});

const warnings={'다름':'!! 다름 — 이 PR head를 본 검수가 없습니다(다른 커밋의 pass만 있음)','같은 커밋 검수 changes':'!! 같은 커밋 검수 changes — 이 PR head를 본 가장 최근 검수가 changes입니다','모호':'!! 모호 — 짧은 head가 서로 다른 검수 커밋 둘 이상과 맞습니다. 더 긴 head를 주세요'};

export function formatMergeCheck(r){
 const lines=[];
 if(warnings[r.result])lines.push(warnings[r.result]);
 lines.push(`결과: ${r.result}`,`검수 SHA: ${r.reviewSha??'-'}`,`PR head: ${r.head}`);
 if(r.review)lines.push(`검수 실행: ${r.review.key} (SHA 출처: ${r.review.source??'없음'})`);
 if(r.passShas?.length)lines.push(r.result==='모호'?'맞는 검수 SHA:':'pass 검수 SHA(최근 것부터):',...r.passShas.map(p=>`  ${p.sha}  ${p.key}`));
 lines.push('표시만 합니다. 머지를 막지 않습니다.');
 return lines.join('\n');
}
