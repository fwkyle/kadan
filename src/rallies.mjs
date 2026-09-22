import {progressGroup,progressGroups} from './board-progress.mjs';
const end=c=>['done','cancelled','superseded','archived'].includes(c.displayState);
const e=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const steps={implementation:'구현',fix:'수정',review:'검수',research:'관련 조사'};
const stateName={done:'완료',running:'작업 중',waiting:'결과 대기',hold:'보류',failed:'실패',check:'확인 필요',planned:'발령 전',closed:'취소·보관'};
export function buildRallies(cards){
 const map=new Map();
 for(const c of cards){if(!c.rallyId||c.workType==='coordination')continue;const key=JSON.stringify([c.repo,c.board,c.rallyId]);if(!map.has(key))map.set(key,{key,id:c.rallyId,title:c.rallyTitle,cards:[]});map.get(key).cards.push(c);}
 return [...map.values()].map(g=>{
  const rounds=[...new Set(g.cards.filter(c=>c.rallyStep!=='research').map(c=>Number(c.rallyRound)))].sort((a,b)=>a-b),round=rounds.at(-1)||0;
  const current=g.cards.filter(c=>Number(c.rallyRound)===round&&c.rallyStep!=='research');
  const work=current.filter(c=>['implementation','fix'].includes(c.rallyStep)),review=current.filter(c=>c.rallyStep==='review');
  const research=g.cards.filter(c=>c.rallyStep==='research'),warnings=[];
  if(new Set(g.cards.map(c=>c.rallyTitle)).size!==1)warnings.push('묶음 제목 확인 필요');
  if(rounds.some((n,i)=>n!==i+1))warnings.push('라운드 연결 누락');
  if(work.length>1||review.length>1)warnings.push('동일 라운드 카드 중복 확인');
  if(round&&!work.length)warnings.push('구현 카드 연결 필요');
  const retired=g.cards.every(c=>['cancelled','superseded','archived'].includes(c.displayState));
  const done=work.length===1&&review.length===1&&[...current,...research].every(c=>c.displayState==='done')&&!warnings.length;
  const primary=review.some(c=>!end(c))&&work.every(c=>end(c))?review:work.some(c=>!end(c))?work:[];
  const focus=[...primary,...research.filter(c=>!end(c))];
  let state=done?'done':retired?'closed':g.cards.every(end)?'check':focus.some(c=>c.displayState==='running')?'running':focus.some(c=>c.displayState==='hold')?'hold':focus.some(c=>c.displayState==='failed')?'failed':focus.some(c=>c.displayState==='waiting')?'waiting':'check';
  const next=!review.length&&round?'검수 카드 연결 필요':warnings[0]||(!round?'구현·검수 연결 전':'');
  if(warnings.length)state='check';
  return {...g,round,rounds,focus,state,next,warnings,done,closed:done||retired};
 });
}
export function renderRallies(cards,{now=Date.now()}={}){
 const groups=buildRallies(cards);if(!groups.length)return '';
 const counts={};for(const g of groups)counts[g.state]=(counts[g.state]||0)+1;
 const timeline=g=>g.rounds.map(n=>`<li><strong>${n}라운드</strong> ${g.cards.filter(c=>Number(c.rallyRound)===n&&c.rallyStep!=='research').sort((a,b)=>Number(a.rallyStep==='review')-Number(b.rallyStep==='review')).map(c=>cardLink(c)).join(' → ')}</li>`).join('');
 const cardLink=c=>`<a href="?card=${encodeURIComponent(c.key)}#detail">${e(steps[c.rallyStep])}: ${e(stateName[progressGroup(c.displayState)])}</a>`;
 return `<section class="rally-section"><h3>작업별 티키타카 · ${groups.filter(g=>!g.closed).length}개 남음</h3><p class="muted">완료 ${counts.done||0}/${groups.length}묶음 · 연결 카드 ${groups.reduce((n,g)=>n+g.cards.length,0)}장. 구현·검수 각각이 한 턴이며, 1라운드는 두 턴의 왕복입니다.</p><div class="progress-track" role="img" aria-label="티키타카 ${groups.length}묶음 중 ${counts.done||0}개 완료">${progressGroups.filter(([k])=>counts[k]).map(([k,label,color])=>`<span style="width:${counts[k]/groups.length*100}%;background:${color}" title="${label} ${counts[k]}묶음"></span>`).join('')}</div><div class="rally-table-wrap"><table class="rally-table"><thead><tr><th scope="col">작업 · 카드 이력</th><th scope="col">라운드</th><th scope="col">상태</th><th scope="col">현재 담당 · 진행</th></tr></thead><tbody>${groups.sort((a,b)=>Number(a.done)-Number(b.done)||a.title.localeCompare(b.title)).map(g=>{
 const actors=g.focus.filter(c=>!end(c));const latest=g.cards.flatMap(c=>(c.history||[]).filter((h,i)=>!['rallyId','rallyTitle','rallyRound','rallyStep'].some(k=>h[k]!==c.history[i-1]?.[k]))).filter(h=>h.noteKind==='decision'&&h.note).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at))[0];
 return `<tr class="rally-group"><td><strong>${e(g.title)}</strong><details><summary>관련 카드 ${g.cards.length}장 · 이력</summary><ol>${timeline(g)}</ol>${g.cards.filter(c=>c.rallyStep==='research').map(c=>`<p>${cardLink(c)} · ${e(c.title)}</p>`).join('')}<p class="muted">담당 이력: ${e([...new Set(g.cards.map(c=>c.role).filter(Boolean))].join(' · '))}</p>${latest?`<p>최근 판단: ${e(latest.note.slice(0,240))}</p>`:''}</details></td><td>${g.round?`<strong>${g.round}라운드</strong><br><small>${Math.ceil(g.round/3)}번째 3회 묶음</small>`:'관련 조사'}<br><small title="18회는 진행률이 아닌 상한입니다">상한 18라운드</small></td><td><span class="state ${g.state==='check'?'unconfirmed':g.state}">${e(stateName[g.state])}</span>${g.next?`<p>${e(g.next)}</p>`:''}</td><td>${actors.length?actors.map(c=>{const t=Date.parse(c.runs?.filter(r=>r.role===c.role).at(-1)?.sentAt);return `<p>${e(steps[c.rallyStep])} 담당: ${e(c.role||'미배정')}<br>${cardLink(c)}<br><small>${Number.isFinite(t)?`발령 후 ${Math.max(0,Math.floor((now-t)/60000))}분 경과`:'발령 시각 확인 전'} · 마지막 보고 ${e(c.activityAt?new Date(c.activityAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'없음')}</small></p>`;}).join(''):'<span class="muted">'+(g.done?'검수 완료':'현재 담당 확인 필요')+'</span>'}</td></tr>`;
 }).join('')}</tbody></table></div></section>`;
}
