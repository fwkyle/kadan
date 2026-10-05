import {operationsFlowSummaries} from './operations-flow.mjs';
import fs from 'node:fs';
import {WorkStore} from './work-store.mjs';
import {CardStore} from './card-store.mjs';
import {appendLedger,readLedger} from './ledger.mjs';
import {taskIdentity} from './task-identity.mjs';
import {automaticReviewCommand} from './automatic-review-command.mjs';

const RALLY_STEPS=new Set(['implementation','fix','review','research']);

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

export function workCommand(args,flags,context){
 const {home,by}=context;
 const [action='list',key]=args,store=new WorkStore(home);
 if(flags.help&&action.startsWith('auto-'))return 'kadan work auto-configure <업무키> --revision N --implementation 원본카드키 --review 검수원본키 --worker 작업자 --reviewer 검수자 [--notify 감독 --deadline 기존시한 --next-block] | auto-show <업무키> | auto-report <업무키> --execution 현재실행키 --outcome implemented|pass|changes|exception [--result-file 기존절대경로] | auto-step <업무키> | auto-run <업무키> [--interval 초]. 상세: docs/automatic-review.md';
 if(action.startsWith('auto-'))return automaticReviewCommand(args,flags,context);
 if(flags.help)return 'kadan work create <저장소/업무ID> --title 제목 --goal 결과 --scope 전체범위 --acceptance 완료조건 --owner 책임감독 --repo-path 절대경로 [--board 판] | list | show <키> | update <키> --revision N --note 이유 [--progress 처리수·남은항목·재개위치] [--next-action 다음행동] [--turn-owner 현재차례] | execute <키> --revision N --phase implementation|review|fix|release|research|other --round N --title 실행제목 --body-file 지시문 --note 이유 [--assign <역할> [--dispatch "<지시>"]] | link/unlink <키> --execution 저장소/실행ID --revision N --note 이유 [--phase 단계 --round N] | mail <키> --mail 우편ID --revision N --note 이유 | complete/cancel <키> --revision N --result 결과와근거 --note 이유 | reopen <키> --revision N --note 이유. 실행은 별도 ID로 발령하며 업무 완료로 세지 않습니다.';
 if(action==='list'){const works=store.list().filter(w=>(!flags.repo||w.repo===flags.repo)&&(!flags.status||w.status===flags.status)),summaries=operationsFlowSummaries(home,works);return works.map(({key,title,owner,status,revision,executions})=>({key,title,owner,status,revision,executions:executions.length,followup:(({executions,...summary})=>summary)(summaries.get(key).followup),timing:summaries.get(key).timing}));}
 if(action==='show'){const work=store.get(key);return {...work,...operationsFlowSummaries(home,[work]).get(key)};}
 if(action==='create')return store.create({key,title:flags.title,goal:flags.goal,scope:flags.scope,acceptance:flags.acceptance,owner:flags.owner,repoPath:flags['repo-path'],board:flags.board,by});
 const fields={};
 for(const [flag,field] of [['title','title'],['goal','goal'],['scope','scope'],['acceptance','acceptance'],['owner','owner'],['board','board'],['progress','progress'],['next-action','nextAction'],['turn-owner','turnOwner'],['status','status'],['execution','execution'],['phase','phase'],['round','round'],['mail','mail'],['result','result']])if(flags[flag]!==undefined)fields[field]=flags[flag];
 if(flags['body-file'])fields.body=fs.readFileSync(flags['body-file'],'utf8');
 if(action==='execute'&&(flags.assign!=null||flags.dispatch!=null)){
  if(flags.assign==null)throw new Error('--dispatch는 --assign <역할>과 함께 쓴다');
  if(!RALLY_STEPS.has(flags.phase))throw new Error(`--assign은 implementation|fix|review|research 실행에만 쓴다 (${flags.phase}는 묶음에 들어가지 않는다)`);
  const before=new Set(store.get(key).executions.map(x=>x.key));
  const work=store.change(key,action,fields,{revision:flags.revision,by,note:flags.note});
  return assignAndDispatch(store,work,before,flags,context);
 }
 return store.change(key,action,fields,{revision:flags.revision,by,note:flags.note});
}
