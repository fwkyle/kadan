import {readStream,appendStream} from './storage.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {CardStore} from './card-store.mjs';
import {statusLabel,isEnded} from './status-labels.mjs';

export const isExecution=c=>c.workType!=='coordination';
// 보류(archived)는 시작 전에 미뤄 둔 카드라 남은 일로 센다. 끝은 완료·취소·대체뿐이다(2026-10-05 [kyle]).
export const finished=c=>isEnded(c.displayState);
export const executionUnknown=c=>['unconfirmed','orphaned','failed'].includes(c.displayState);
// 같은 상태는 화면마다 같은 낱말을 쓴다. 이름은 status-labels 한 곳에서 가져오고, 카드 상태 필터가 이 열쇠 목록을 쓰므로 열쇠는 그대로 둔다(2026-10-05 [kyle]).
export const stateText=Object.fromEntries(['running','waiting','unconfirmed','orphaned','failed','hold','draft','ready','assigned','done','cancelled','superseded','archived'].map(key=>[key,statusLabel(key)]));
export function cleanTitle(card){
 const title=String(card.title||card.id||'제목 없음').replace(/^#+\s*/,'').replace(/\*\*/g,'');
 const stripped=title.startsWith(card.id)?title.slice(card.id.length).replace(/^\s*[—–:·-]\s*/,''):title;
 return stripped.trim()||title;
}
const contentHash=card=>createHash('sha256').update(JSON.stringify([card.title,card.body])).digest('hex');
const sourceHash=card=>createHash('sha256').update(JSON.stringify([card.revision,card.body])).digest('hex');
export class BriefStore {
 constructor(home){this.cards=new CardStore(home);}
 file(key){return path.join(this.cards.dir(key),'briefs.jsonl');}
 read(key){const rows=readStream(this.cards.home,`cards/${key}/briefs.jsonl`,{optional:true});if(!rows.length)return null;if(rows.some(r=>r.key!==key||!r.sourceHash))throw new Error('설명 기록 손상');return rows.at(-1);}
 write(key,flags,by){return this.cards.locked(()=>{
  const card=this.cards.get(key);if(Number(flags.revision)!==card.revision)throw new Error('카드 변경됨: 최신 원본을 읽고 설명을 작성하세요');
  this.read(key);
  const fields=['title','workstream','stage','goal','summary','next','blocker'];const values={};
  for(const k of fields)if(flags[k]!==undefined){if(typeof flags[k]!=='string'||flags[k].length>1000)throw new Error('설명은 항목당 1000자 이내');values[k]=flags[k].trim();}
  if(!values.title||!values.workstream)throw new Error('쉬운 제목과 작업 묶음이 필요합니다');
  if(values.stage&&!['구현','검수','통합','프리뷰 확인','조율','조사','기타'].includes(values.stage))throw new Error('지원하지 않는 작업 단계');
  const row={key,sourceRevision:card.revision,sourceHash:sourceHash(card),contentHash:contentHash(card),by,at:new Date().toISOString(),...values};
  appendStream(this.cards.home,`cards/${key}/briefs.jsonl`,row);return row;
 });}
}

// 마지막 보고는 현재 담당의 최신 발령에 연결한다. 카드 수정 시각은 보고가 아니다.
// activityAt은 메모마다 복사되는 원래 활동 보고 시각이며, 새 메모의 at으로 대체하지 않는다.
export function currentProgressReport(card,now=Date.now()){
 const empty=(state,reason)=>({state,at:null,by:null,note:'',source:null,reason});
 const history=card.history??[],reports=history.filter(h=>h.noteKind==='progress');
 const activity=['running','waiting','unknown'].includes(card.activity)&&card.activityAt!=null;
 if(!card.role)return empty(reports.length||activity?'unknown':'none',reports.length||activity?'role-unknown':'no-report');
 const run=(card.runs??[]).filter(r=>r.role===card.role).at(-1);
 if(!run)return empty('none','no-dispatch');
 const sent=Date.parse(run.sentAt);
 if(!Number.isFinite(sent))return empty('unknown','dispatch-time');
 if(sent>now)return empty('unknown','future-time');
 const assignment=history.filter((h,i)=>h.role===card.role&&h.status==='assigned'&&
  (history[i-1]?.role!==h.role||history[i-1]?.status!=='assigned')).at(-1);
 let since=sent;
 if(assignment){
  const at=Date.parse(assignment.at);
  if(!Number.isFinite(at))return empty('unknown','assignment-time');
  // 과거 발령을 중앙 카드로 이관할 수 있다. 발령·현재 배정 이후의 보고는 인정한다.
  since=Math.max(sent,at);
 }
 const owned=reports.filter(h=>h.by===card.role&&(!h.role||h.role===card.role));
 // 시각이 잘못된 최신 보고를 옛 정상 보고나 복사된 activityAt으로 숨기지 않는다.
 const report=owned.filter(h=>!Number.isFinite(Date.parse(h.at))||Date.parse(h.at)>=since).at(-1);
 const ownActivity=activity&&card.activityRole===card.role;
 const fallback=ownActivity&&(!Number.isFinite(Date.parse(card.activityAt))||Date.parse(card.activityAt)>=since)?{at:card.activityAt,by:card.activityRole,note:'',source:'activity'}:null;
 let selected=report?{at:report.at,by:report.by,note:report.note||'',source:'progress'}:null;
 if(fallback&&(!selected||Number.isFinite(Date.parse(selected.at))&&Date.parse(fallback.at)>Date.parse(selected.at)))selected=fallback;
 if(!selected){
  if(reports.some(h=>(!h.by||h.by==='모름')&&(!h.role||h.role===card.role)&&(!Number.isFinite(Date.parse(h.at))||Date.parse(h.at)>=since)))return empty('unknown','author-unknown');
  if(owned.some(h=>Date.parse(h.at)<since)||ownActivity&&Date.parse(card.activityAt)<since)return empty('none',since>sent?'before-assignment':'before-dispatch');
  return empty('none','no-report');
 }
 const at=Date.parse(selected.at);
 if(!Number.isFinite(at))return empty('unknown','invalid-time');
 if(at>now)return empty('unknown','future-time');
 if(at<since)return empty('none',since>sent?'before-assignment':'before-dispatch');
 return {state:'reported',...selected,reason:null};
}
// 원본 변경 때만 문장을 다시 만든다. 화면 갱신으로 AI를 실행하지 않는다.
export class Scribe {
 constructor(){this.cache=new Map();}
 summarize(card,brief,now=Date.now()){
  const report=currentProgressReport(card,now);
  const fingerprint=createHash('sha256').update(JSON.stringify([sourceHash(card),card.title,card.displayState,card.activityAt,card.runs,report,brief])).digest('hex');
  const old=this.cache.get(card.key);if(old?.fingerprint===fingerprint)return old.value;
  const fresh=!!brief&&brief.sourceHash===sourceHash(card);
  const namesFresh=!!brief&&brief.contentHash===contentHash(card);
  // 이름은 원문 제목/본문이 같을 때 유지하고, 진행 서술은 새 보고마다 무효화한다.
  const value={key:card.key,title:namesFresh?brief.title:cleanTitle(card),workstream:namesFresh?brief.workstream:'분류할 작업',stage:namesFresh?brief.stage||'기타':'기타',goal:namesFresh?brief.goal||'':'',
   summary:fresh?brief.summary||'':'',next:fresh?brief.next||'':'',blocker:fresh?brief.blocker||'':'',
   state:stateText[card.displayState]||'상태 모름',status:card.displayState,storedStatus:card.status,
   evidenceAt:report.at,report:report.note,reportState:report.state,reportReason:report.reason,sourceRevision:card.revision,
   explanationAt:brief?.at||null,stale:!!brief&&(!namesFresh||(!fresh&&!!(brief.summary||brief.next||brief.blocker))),finished:finished(card),unknown:executionUnknown(card)};
  this.cache.set(card.key,{fingerprint,value});return value;
 }
 retain(keys){const keep=new Set(keys);for(const key of this.cache.keys())if(!keep.has(key))this.cache.delete(key);}
}
const scribe=new Scribe();
export function buildHumanBrief(center,home){
 if(!center)return null;
 const store=home?new BriefStore(home):null;
 const cards=new Map();
 for(const c of center.cards){let brief=null,error=null;try{brief=store?.read(c.key)}catch{error='설명 기록을 읽을 수 없습니다';}cards.set(c.key,{...scribe.summarize(c,brief),error});}
 scribe.retain(cards.keys());return cards;
}

// 작업중 · <이유> 기다림. 결과 대기 보고(card progress --activity waiting --note)에 남긴 이유를 상세에서만 붙인다.
// 지금 활동을 만든 보고 한 줄만 읽는다. 뒤에 붙은 일반 메모를 기다리는 이유로 쓰지 않는다(2026-10-05 [kyle]).
export function waitingText(card){
 if(card.displayState!=='waiting')return stateText[card.displayState]||'상태 모름';
 const report=(card.history??[]).filter(h=>h.noteKind==='progress'&&h.activity==='waiting'&&h.activityAt===h.at&&h.at===card.activityAt).at(-1);
 const reason=String(report?.note||'').replace(/\s+/g,' ').trim();
 return reason?`${stateText.waiting} · ${reason.length>120?reason.slice(0,120)+'…':reason} 기다림`:stateText.waiting;
}
// 경과 시간은 캐시된 요약이 아니라 화면을 그리는 시각에 계산한다. detail이면 결과 대기의 이유를 붙인다.
export function progressLabel(card,now=Date.now(),{detail=false}={}){
 if(!['unconfirmed','running','waiting'].includes(card.displayState))return stateText[card.displayState]||'상태 모름';
 const prefix=detail?waitingText(card):stateText[card.displayState];
 const report=currentProgressReport(card,now);
 if(report.state!=='reported')return prefix+' · '+(report.state==='unknown'?
  ({'role-unknown':'보고 담당 모름','author-unknown':'보고자 모름','dispatch-time':'발령 시각 모름','assignment-time':'배정 시각 모름','future-time':'보고 시각 확인 필요'}[report.reason]||'보고 시각 모름'):
  report.reason==='before-dispatch'?'재발령 후 보고 없음':report.reason==='before-assignment'?'재배정 후 보고 없음':'진행 보고 없음');
 const elapsed=now-Date.parse(report.at);
 if(!Number.isFinite(elapsed)||elapsed<0)return prefix+' · 보고 시각 확인 필요';
 const minutes=Math.floor(elapsed/60000);
 const age=minutes<1?'방금':minutes<60?`${minutes}분 전`:minutes<1440?`${Math.floor(minutes/60)}시간 ${minutes%60}분 전`:`${Math.floor(minutes/1440)}일 전`;
 return `${prefix} · 마지막 보고 ${age}`;
}
export function queueLabel(card){
 return ({unconfirmed:'순서 대기 여부: 기록 없음',ready:'설계완료 · 순서 미정',assigned:'작업대기 · 순서 미정',draft:'초안',waiting:'기다림 보고 있음'})[card.displayState]||'';
}
