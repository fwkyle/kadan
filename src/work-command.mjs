import {operationsFlowSummaries} from './operations-flow.mjs';
import fs from 'node:fs';
import {WorkStore} from './work-store.mjs';
import {refreshWorkStatus} from './user-notify.mjs';
import {CardStore,readFirstPaths} from './card-store.mjs';
import {appendLedger,readLedger} from './ledger.mjs';
import {taskIdentity} from './task-identity.mjs';
import {automaticReviewCommand} from './automatic-review-command.mjs';
import {DecisionStore} from './decisions.mjs';
import {isUserActor} from './actors.mjs';
import {latestPassReview} from './merge-check.mjs';
import {closeWorkRoles} from './work-role-cleanup.mjs';
import {cardCloseLines} from './work-card-close.mjs';
import {backfillCloseCards,backfillLines} from './work-card-backfill.mjs';

const RALLY_STEPS=new Set(['implementation','fix','review','research']);

// 하위 명령이 아는 플래그. 모르는 플래그는 조용히 무시하면 `--next`처럼 틀린 이름이 성공으로 끝나 값이 안 적힌 채 남으므로
// 이름을 적어 거절한다(종료 코드 2, work list가 먼저 쓰던 방식). 목록은 각 동작의 코드가 실제로 읽는 플래그다.
// --help는 모든 동작이 받는다. 자동 왕복(auto-*)도 같은 표를 쓴다. 표에 없는 동작은 기존 오류('알 수 없는 업무 변경')를 그대로 낸다.
const REVISION_NOTE=['revision','note'];
export const WORK_FLAGS={
 create:['title','goal','scope','acceptance','owner','repo-path','board'],
 list:['repo','status','open'],
 show:[],
 update:[...REVISION_NOTE,'title','goal','scope','acceptance','owner','board','progress','next-action','turn-owner','status','wait-until'],
 execute:[...REVISION_NOTE,'phase','round','title','body-file','difficulty','assign','dispatch'],
 // unlink는 --phase·--round를 읽지 않지만 문서가 link와 묶어 적었다(docs 쪽 정리는 감독 판단) — 거절하지 않는다.
 link:[...REVISION_NOTE,'execution','phase','round'],
 unlink:[...REVISION_NOTE,'execution','phase','round'],
 mail:[...REVISION_NOTE,'mail'],
 complete:[...REVISION_NOTE,'result','keep-roles'],
 cancel:[...REVISION_NOTE,'result'],
 reopen:[...REVISION_NOTE],
 'backfill-close':['apply'],
 'auto-configure':['revision','implementation','review','worker','reviewer','notify','deadline','next-block'],
 'auto-show':[],
 'auto-report':['execution','outcome','result-file'],
 'auto-step':[],
 'auto-run':['interval'],
};
function rejectUnknownFlags(action,flags){
 const allowed=Object.hasOwn(WORK_FLAGS,action)?WORK_FLAGS[action]:null;
 if(!allowed||flags.help)return;
 const unknown=Object.keys(flags).filter(name=>name!=='help'&&!allowed.includes(name));
 if(!unknown.length)return;
 const usable=allowed.length?allowed.map(name=>`--${name}`).join(', '):'없음';
 throw Object.assign(new Error(`work ${action}가 모르는 플래그: ${unknown.map(name=>`--${name}`).join(', ')} (쓸 수 있는 것: ${usable})`),{exitCode:2});
}

// 수동 발령 1명령화(2026-10-05 점검 보고서 1-H2): 자동 경로의 prepare가 하던 "실행 생성 → 배정·묶음 → plan"을
// 감독이 손으로 4명령에 나눠 치던 것을 `work execute … --assign <역할> [--dispatch "<지시>"]` 하나로 묶는다.
// 전송은 자동 경로의 deliver와 같이 기존 send 검사(생존·PID·배정·범위·실행기)를 그대로 거친다.
function assignAndDispatch(store,work,before,flags,{home,by,send}){
 const role=String(flags.assign||'').trim();
 if(!role)throw new Error('--dispatch는 --assign <역할>과 함께 쓴다');
 if(!RALLY_STEPS.has(flags.phase))throw new Error(`--assign은 implementation|fix|review|research 실행에만 쓴다 (${flags.phase}는 묶음에 들어가지 않는다)`);
 const link=work.executions.find(x=>!before.has(x.key));
 if(!link)throw new Error('새 실행을 찾지 못했다');
 const cards=new CardStore(home),created=cards.get(link.key);
 const card=cards.update(link.key,{status:'assigned',scope:work.scope,board:work.board,role,rallyId:work.id,rallyTitle:work.title.slice(0,160),
  rallyRound:flags.phase==='research'?'0':String(link.round),rallyStep:flags.phase},{revision:created.revision,by,note:flags.note,manual:true});
 const identity=taskIdentity(cards.list());
 appendLedger({kind:'plan',board:work.board,...identity.write(card.key),by},home);
 let dispatch=null;
 if(flags.dispatch!=null){
  const message=String(flags.dispatch);
  if(!message.trim())throw new Error('--dispatch 지시문이 비어 있다');
  if(typeof send!=='function')throw new Error('이 환경에서는 --dispatch 전송을 할 수 없다');
  const session=`kadan-${role}`,start=readLedger(home).filter(e=>e.kind==='start'&&e.session===session).at(-1);
  dispatch=send({role,pid:start?.panePid??start?.rottiePid??null,message,taskId:identity.taskIdFor(card),workKey:work.key,executionKey:card.key,
   roleProfile:flags.phase==='review'?'reviewer':'worker',transmit:fn=>fn()});
 }
 return {work:store.get(work.key),card,plan:{board:work.board,taskId:identity.taskIdFor(card)},dispatch};
}

// 업무 글 상태 메시지를 맞추는 사건: 실행 등록, 진행·차례 수정, 완료·취소·다시 열기. 실패(예: 발령 실패)해도 업무 기록은 이미
// 바뀌었을 수 있어 finally에서 맞춘다. 맞추기는 실패해도 던지지 않고, 글이 없거나 디코 설정이 없으면 요청 0건이다.
const STATUS_ACTIONS=new Set(['update','execute','complete','cancel','reopen']);
export function workCommand(args,flags,context){
 rejectUnknownFlags(args[0]??'list',flags); // 업무를 읽거나 쓰기 전에 거절한다(거절된 명령이 revision을 올리면 안 된다)
 let result,failure;
 const revisionBefore=revisionOf(args,flags,context);
 try{result=workCommandInner(args,flags,context);}
 catch(error){failure=error;}
 finally{if(STATUS_ACTIONS.has(args[0])&&args[1]&&!flags.help)refreshWorkStatus(context.home,args[1]);}
 chatDecisionsAfter(args,flags,context,revisionBefore,failure);
 if(failure)throw failure;
 for(const line of cardCloseLines(result?.cardClose))process.stderr.write(`${line}\n`);
 if(args[0]==='backfill-close'&&!flags.help)for(const line of backfillLines(result))process.stderr.write(`${line}\n`);
 return closeRolesAfterComplete(args,flags,context,result);
}

// 마감이 기록된 뒤에만 그 업무의 작업자·검수자를 끈다(CLI가 closeRoles를 넘길 때만 — 대시보드 마감은 거치지 않는다).
// 끄기가 어떻게 되든 마감 결과는 그대로이고, 끄기 결과는 roleCleanup 칸으로 더하기만 한다. 사람이 읽는 줄은 stderr.
function closeRolesAfterComplete([action],flags,context,result){
 if(action!=='complete'||flags.help||typeof context.closeRoles!=='function'||result?.status!=='done')return result;
 try{
  const cleanup=context.closeRoles({home:context.home,work:result,keep:flags['keep-roles']===true});
  for(const line of cleanup.lines)process.stderr.write(`${line}\n`);
  return {...result,roleCleanup:cleanup};
 }catch(error){
  process.stderr.write(`역할 끄기 실패(업무 마감은 기록됨): ${error.message}\n`);
  return {...result,roleCleanup:{error:error.message}};
 }
}

// 업무를 쓴 명령 뒤에 그 업무에 열린 채팅 결정(decision request --chat)이 남아 있으면 stderr로 알린다(언제나). 그 가운데 규칙이 허락한
// 것만 닫는다. 업무 쓰기가 끝난 뒤 별도 트랜잭션이고, 닫기·읽기가 실패해도 업무 명령의 결과(stdout·종료 코드)는 그대로다.
// 규칙(차례 변경은 kyle이 답했다는 근거가 아니다): execute는 부른 역할이 요청한 결정만, complete·cancel은 모두, 그 밖은 닫지 않는다.
// 명령이 실패해도 업무에 쓴 것이 있으면(revision이 달라짐) 알리되 닫지는 않는다. 읽기 명령은 내지 않는다.
const CHAT_CLOSE={execute:['후속 발령으로 자동 닫힘','requester'],complete:['업무 완료로 자동 닫힘','all'],cancel:['업무 취소로 자동 닫힘','all']};
// 안내·닫기 대상이 아닌 명령: 읽기(list·show)와 create, 업무를 쓰지 않는 backfill-close, 그리고 자동 왕복(auto-*). auto-*는 프로그램·작업자가 부르고 결과가 비동기라 안내를 읽는 감독이 없다.
const READ_ACTIONS=new Set(['list','show']);
const skipsChat=action=>READ_ACTIONS.has(action)||action==='create'||action==='backfill-close'||String(action).startsWith('auto-');
const NOTICE_MAX=5;
function revisionOf([action='list',key],flags,{home}){
 if(skipsChat(action)||!key||flags.help)return null;
 try{return new WorkStore(home).get(key)?.revision??null;}catch{return null;}
}
function chatNotice(d,via,by){
 const q=String(d.question).replace(/\s+/g,' ').slice(0,40);
 const command=`kadan decision cancel ${d.id} --revision ${d.revision} --reason "kyle 채팅 답: <원문>"`;
 const head=`열린 채팅 결정 유지(${via}): ${d.id.slice(0,8)} · 요청자 ${d.requestedBy} · ${q}`;
 return d.requestedBy===by||isUserActor(by)
  ?`${head} · 답을 받았으면 ${command}`
  :`${head} · 요청자(${d.requestedBy}) 또는 kyle만 닫을 수 있습니다 — kyle 답을 받았으면 ${d.requestedBy}가 닫습니다: ${command}`;
}
function chatDecisionsAfter([action='list',key],flags,{home,by},revisionBefore,failure){
 if(skipsChat(action)||!key||flags.help)return;
 if(failure){ // 실패한 명령은 업무에 쓴 것이 있을 때만 알린다
  let after=null;try{after=new WorkStore(home).get(key)?.revision??null;}catch{}
  if(after===null||after===revisionBefore)return;
 }
 try{
  const [reason,rule]=failure?[null,'none']:(CHAT_CLOSE[action]??[null,'none']),via=`work ${action}`;
  const {kept}=new DecisionStore(home).closeChatForWork(key,reason??'',via,{rule,by});
  for(const d of kept.slice(0,NOTICE_MAX))process.stderr.write(`${chatNotice(d,via,by)}\n`);
  if(kept.length>NOTICE_MAX)process.stderr.write(`열린 채팅 결정 외 ${kept.length-NOTICE_MAX}건: kadan decision list --status open\n`);
 }catch(error){process.stderr.write(`열린 채팅 결정을 확인하지 못했습니다(${error.message}): \`kadan decision list --status open\`으로 확인\n`);}
}

// --open은 끝나지 않은 업무(open·hold). open만 보려면 --status open.
const UNFINISHED=new Set(['open','hold']);
function listWorks(store,flags){
 if(flags.open!==undefined&&flags.open!==true)throw Object.assign(new Error('--open은 값 없이 씁니다(끝나지 않은 업무 = open·hold)'),{exitCode:2});
 if(flags.open&&flags.status!==undefined)throw Object.assign(new Error('--open과 --status는 함께 쓸 수 없습니다(--open = open·hold, 한 상태만 보려면 --status)'),{exitCode:2});
 return store.list().filter(w=>(!flags.repo||w.repo===flags.repo)&&(!flags.status||w.status===flags.status)&&(!flags.open||UNFINISHED.has(w.status)));
}

// 되돌릴 수 없는 줄을 한꺼번에 쓰는 명령이라 인자를 엄격히 받는다. --apply는 값 없는 옵션이라 `--apply false`는
// "적용 + 남는 인자 false"로 풀리고, 업무 키를 붙이면 그 업무만 닫는 줄 알고 전체를 닫게 된다. 둘 다 거절한다.
function backfillClose(args,flags,{home,by}){
 const usage='kadan work backfill-close [--apply] (--apply가 없으면 미리보기)';
 if(args.length>1)throw Object.assign(new Error(`work backfill-close는 업무 키나 다른 인자를 받지 않습니다(남는 인자: ${args.slice(1).join(' ')}). 끝난 업무 전체가 대상입니다: ${usage}`),{exitCode:2});
 if(flags.apply!==undefined&&flags.apply!==true)throw Object.assign(new Error(`--apply는 값 없이 씁니다: ${usage}`),{exitCode:2});
 return backfillCloseCards(home,{apply:flags.apply===true,by});
}

function workCommandInner(args,flags,context){
 const {home,by}=context;
 const [action='list',key]=args,store=new WorkStore(home);
 if(flags.help&&action.startsWith('auto-'))return 'kadan work auto-configure <업무키> --revision N --implementation 원본카드키 --review 검수원본키 --worker 작업자 --reviewer 검수자 [--notify 감독 --deadline 기존시한 --next-block] | auto-show <업무키> | auto-report <업무키> --execution 현재실행키 --outcome implemented|pass|changes|exception [--result-file 기존절대경로] | auto-step <업무키> | auto-run <업무키> [--interval 초]. 상세: docs/automatic-review.md';
 if(action.startsWith('auto-'))return automaticReviewCommand(args,flags,context);
 if(flags.help)return 'kadan work create <저장소/업무ID> --title 제목 --goal 결과 --scope 전체범위 --acceptance 완료조건 --owner 책임감독 --repo-path 절대경로 [--board 판] | list [--repo 저장소] [--status open|hold|done|cancelled | --open (끝나지 않은 업무 = open·hold, --status와 함께 쓰지 않음)] | show <키> | update <키> --revision N --note 이유 [--progress 처리수·남은항목·재개위치] [--next-action 다음행동] [--turn-owner 현재차례] [--wait-until 24시간 안의 ISO 시각|none (그 시각까지 이 업무를 감독의 할 일로 세지 않음)] | execute <키> --revision N --phase implementation|review|fix|release|research|other --round N --title 실행제목 --body-file 지시문 --note 이유 [--difficulty hard (작업자 단계 실행만)] [--assign <역할> [--dispatch "<지시>"]] | link/unlink <키> --execution 저장소/실행ID --revision N --note 이유 [--phase 단계 --round N] | mail <키> --mail 우편ID --revision N --note 이유 | complete <키> --revision N --result 결과와근거 --note 이유 [--keep-roles] | cancel <키> --revision N --result 결과와근거 --note 이유 | reopen <키> --revision N --note 이유 | backfill-close [--apply] (끝난 업무에 남은 실행 카드 소급 닫기. 업무 키를 받지 않고, --apply가 없으면 미리보기만). 실행은 별도 ID로 발령하며 업무 완료로 세지 않습니다.';
 if(action==='list'){const works=listWorks(store,flags),summaries=operationsFlowSummaries(home,works);return works.map(({key,title,owner,status,revision,executions})=>({key,title,owner,status,revision,executions:executions.length,followup:(({executions,...summary})=>summary)(summaries.get(key).followup),timing:summaries.get(key).timing}));}
 if(action==='show'){const work=store.get(key);return {...work,...operationsFlowSummaries(home,[work]).get(key),latestPassReviewSha:latestPassReview(home,work)};}
 if(action==='backfill-close')return backfillClose(args,flags,context);
 if(action==='create'){
  const work=store.create({key,title:flags.title,goal:flags.goal,scope:flags.scope,acceptance:flags.acceptance,owner:flags.owner,repoPath:flags['repo-path'],board:flags.board,by});
  // 책임 감독에게 쌓인 열린 업무 수(방금 만든 업무 포함). 새 업무를 이 감독에게 줄지 고를 때 본다. JSON은 필드만 더한다.
  return {...work,ownerOpenWorks:store.list().filter(w=>w.status==='open'&&w.owner===work.owner).length};
 }
 const fields={};
 for(const [flag,field] of [['title','title'],['goal','goal'],['scope','scope'],['acceptance','acceptance'],['owner','owner'],['board','board'],['progress','progress'],['next-action','nextAction'],['turn-owner','turnOwner'],['status','status'],['wait-until','waitUntil'],['execution','execution'],['phase','phase'],['round','round'],['mail','mail'],['result','result'],['difficulty','difficulty']])if(flags[flag]!==undefined)fields[field]=flags[flag];
 if(flags['body-file'])fields.body=fs.readFileSync(flags['body-file'],'utf8');
 if(action==='execute'&&(flags.assign!=null||flags.dispatch!=null)){
  if(flags.assign==null)throw new Error('--dispatch는 --assign <역할>과 함께 쓴다');
  if(!RALLY_STEPS.has(flags.phase))throw new Error(`--assign은 implementation|fix|review|research 실행에만 쓴다 (${flags.phase}는 묶음에 들어가지 않는다)`);
  // 배정에서 거절될 본문이면 실행을 만들기 전에 막는다. 만든 뒤 실패하면 초안이 남고, 같은 명령을 고쳐 다시 치면
  // 초안이 하나 더 생겼다(2026-10-05 실측).
  if(readFirstPaths(fields.body).length===0)throw new Error("--assign 발령에는 지시문 본문 '읽고 시작할 것'에 읽을 문서를 절대경로로 최소 1개 적어야 한다(실행은 만들지 않았다). 예: '## 읽고 시작할 것' 아래에 '- /절대경로/저장소/AGENTS.md — 저장소 공통 규칙'.");
  const before=new Set(store.get(key).executions.map(x=>x.key));
  const work=store.change(key,action,fields,{revision:flags.revision,by,note:flags.note});
  try{return assignAndDispatch(store,work,before,flags,context);}
  catch(error){
   // 실행은 이미 등록됐다. 주소와 현재 상태를 알려 같은 명령의 재실행(실행 중복) 대신 이어서 처리하게 한다.
   const created=work.executions.find(x=>!before.has(x.key));
   if(created){
    const card=new CardStore(home).get(created.key);
    error.message+=` — 새 실행 ${created.key}는 이미 등록됐다(상태 ${card?.status??'모름'}). 같은 명령을 다시 치면 실행이 하나 더 생긴다. 이 실행을 card update/send --task로 이어가거나 card update --status cancelled로 정리하라.`;
   }
   throw error;
  }
 }
 return store.change(key,action,fields,{revision:flags.revision,by,note:flags.note});
}
