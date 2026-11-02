// 머지 직전 표시: 독립 검수가 본 커밋(검수 SHA)과 PR head를 나란히 보인다. 표시만 한다 — 머지를 막는 관문이 아니다.
// PR head는 입력이다(슈퍼감독이 `gh pr view --json headRefOid`로 갖고 있는 값). 카단은 GitHub를 부르지 않는다.
// 10배 점검: 한 번 치고 끝나는 명령이다. 카드 목록을 한 번 읽는다(work close와 같은 비용). 상주 경로 아님.
import {CardStore} from './card-store.mjs';
import {WorkStore} from './work-store.mjs';
import {buildCardCenter} from './card-center.mjs';
import {readLedger} from './ledger.mjs';
import {stage} from './review-flow.mjs';
import {normalizeSha,sameCommit} from './review-sha.mjs';

const date=value=>Date.parse(value)||0;

// 업무에 연결된 review 단계 실행 중 낡지 않은 pass 가운데 가장 최근 것. 없으면 null.
export function latestPassReview(home,work){
 const center=buildCardCenter({cards:new CardStore(home).list(),entries:readLedger(home),tree:[],runtimeKnown:false});
 const picks=[];
 for(const link of work.executions){
  const card=center.cards.find(c=>c.key===link.key);
  if(!card||(link.phase!=='review'&&card.rallyStep!=='review'))continue;
  const s=stage(card);
  if(s.outcome==='pass')picks.push({key:card.key,at:s.resultAt,sha:normalizeSha(card.result?.reviewedSha),source:card.result?.reviewedShaSource??null});
 }
 picks.sort((a,b)=>date(b.at)-date(a.at));
 return picks[0]??null;
}

export function mergeCheck(workKey,{head}={},{home}){
 if(typeof workKey!=='string'||!workKey.includes('/'))throw usage('업무 키(저장소/업무ID)가 필요합니다');
 const headSha=normalizeSha(head);
 if(!headSha)throw usage('--head에는 PR head 커밋(7~40자리 16진)이 필요합니다');
 const review=latestPassReview(home,new WorkStore(home).get(workKey));
 if(!review)return {workKey,result:'검수 pass 없음',reviewSha:null,head:headSha,review:null};
 if(!review.sha)return {workKey,result:'검수 SHA 없음',reviewSha:null,head:headSha,review};
 return {workKey,result:sameCommit(review.sha,headSha)?'같음':'다름',reviewSha:review.sha,head:headSha,review};
}
const usage=message=>Object.assign(new Error(message),{exitCode:2});

export function formatMergeCheck(r){
 const lines=[];
 if(r.result==='다름')lines.push('!! 다름 — 검수한 커밋과 PR head가 다릅니다');
 lines.push(`결과: ${r.result}`,`검수 SHA: ${r.reviewSha??'-'}`,`PR head: ${r.head}`);
 if(r.review)lines.push(`검수 실행: ${r.review.key} (SHA 출처: ${r.review.source??'없음'})`);
 lines.push('표시만 합니다. 머지를 막지 않습니다.');
 return lines.join('\n');
}
