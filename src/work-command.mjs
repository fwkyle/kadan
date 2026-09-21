import fs from 'node:fs';
import {WorkStore} from './work-store.mjs';
import {automaticReviewCommand} from './automatic-review-command.mjs';
export function workCommand(args,flags,context){
 const {home,by}=context;
 const [action='list',key]=args,store=new WorkStore(home);
 if(flags.help&&action.startsWith('auto-'))return 'kadan work auto-configure <업무키> --revision N --implementation 원본카드키 --review 검수원본키 --worker 작업자 --reviewer 검수자 [--notify 감독 --deadline 기존시한 --next-block] | auto-show <업무키> | auto-report <업무키> --execution 현재실행키 --outcome implemented|pass|changes|exception [--result-file 기존절대경로] | auto-step <업무키> | auto-run <업무키> [--interval 초]. 상세: docs/automatic-review.md';
 if(action.startsWith('auto-'))return automaticReviewCommand(args,flags,context);
 if(flags.help)return 'kadan work create <저장소/업무ID> --title 제목 --goal 결과 --scope 전체범위 --acceptance 완료조건 --owner 책임감독 --repo-path 절대경로 [--board 판] | list | show <키> | update <키> --revision N --note 이유 [--progress 처리수·남은항목·재개위치] [--next-action 다음행동] [--turn-owner 현재차례] | execute <키> --revision N --phase implementation|review|fix|release|research|other --round N --title 실행제목 --body-file 지시문 --note 이유 | link/unlink <키> --execution 저장소/실행ID --revision N --note 이유 [--phase 단계 --round N] | mail <키> --mail 우편ID --revision N --note 이유 | complete/cancel <키> --revision N --result 결과와근거 --note 이유 | reopen <키> --revision N --note 이유. 실행은 별도 ID로 발령하며 업무 완료로 세지 않습니다.';
 if(action==='list')return store.list().filter(w=>(!flags.repo||w.repo===flags.repo)&&(!flags.status||w.status===flags.status)).map(({key,title,owner,status,revision,executions})=>({key,title,owner,status,revision,executions:executions.length}));
 if(action==='show')return store.get(key);
 if(action==='create')return store.create({key,title:flags.title,goal:flags.goal,scope:flags.scope,acceptance:flags.acceptance,owner:flags.owner,repoPath:flags['repo-path'],board:flags.board,by});
 const fields={};
 for(const [flag,field] of [['title','title'],['goal','goal'],['scope','scope'],['acceptance','acceptance'],['owner','owner'],['board','board'],['progress','progress'],['next-action','nextAction'],['turn-owner','turnOwner'],['status','status'],['execution','execution'],['phase','phase'],['round','round'],['mail','mail'],['result','result']])if(flags[flag]!==undefined)fields[field]=flags[flag];
 if(flags['body-file'])fields.body=fs.readFileSync(flags['body-file'],'utf8');
 return store.change(key,action,fields,{revision:flags.revision,by,note:flags.note});
}
