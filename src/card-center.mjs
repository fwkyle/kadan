import {taskIdentity,taskEventKey} from './task-identity.mjs';
import {buildRallies} from './rallies.mjs';
import { workEntries, effectiveCardRole } from './handover-state.mjs';

// 카드 한 장과 그 카드에 대한 여러 역할의 실행을 분리한다.
export function buildCardCenter({cards,entries,tree,runtimeKnown=true,now=Date.now()}) {
  if(entries.some(e=>e?.broken))throw new Error('원장 손상: 카드 실행 상태 모름');
  const identity=taskIdentity(cards);
  entries=identity.project(entries);
  const roles=new Map(tree.flatMap(b=>b.roles).map(r=>[r.role,r]));
  const plans=new Map(),runs=new Map();
  for(const e of workEntries(entries,identity)) {
    if(!e?.taskId)continue;
    if(e.kind==='plan') {
      if(!plans.has(e.taskId))plans.set(e.taskId,new Set());
      plans.get(e.taskId).add(e.board);continue;
    }
    if(!['send','done'].includes(e.kind)||!e.role)continue;
    const key=`${e.role}\0${taskEventKey(e)}`;
    const old=runs.get(key);
    if(e.kind==='send')runs.set(key,{role:e.role,taskId:e.taskId,by:e.by??'모름',sentAt:e.t,at:e.t,state:'unconfirmed',board:e.board??null,executionKey:e.executionKey,rawTaskId:e.rawTaskId,taskConnection:e.taskConnection});
    else runs.set(key,{...old,role:e.role,taskId:e.taskId,at:e.t,state:e.result==='ok'?'done':'failed',result:e.result,doneBy:e.by??'모름',executionKey:e.executionKey,rawTaskId:e.rawTaskId,taskConnection:e.taskConnection});
  }
  // 역할별 가장 최근 시작 기록의 실행기·모델. 카단은 판단에 쓰지 않고 화면 답변용으로만 옮긴다(2026-09-06 결정).
  const models={};
  for(const e of entries) {
    if(e?.kind!=='start'||!e.role||!e.model)continue;
    const stamp=Date.parse(e.t)||0;
    // 실행기마다 강도 플래그가 다르다: codex는 model_reasoning_effort, claude는 --effort, omo는 --thinking.
    // 하나만 읽으면 다른 실행기의 강도가 화면에서 빈칸이 된다(2026-09-12 fable 발령에서 실제로 빔).
    // 따옴표는 셸을 거치며 '"max"' 처럼 겹쳐 들어온다. 한 겹만 벗기면 강도가 빈칸이 된다(2026-09-12 kimi 발령에서 실제로 빔).
    const effort=typeof e.cmd==='string'?(e.cmd.match(/model_reasoning_effort\s*=\s*["']*([A-Za-z]+)["']*|--(?:effort|thinking)[=\s]+["']*([A-Za-z]+)["']*/)?.slice(1).find(Boolean)||''):'';
    if(!models[e.role]||stamp>=(Date.parse(models[e.role].at)||0))models[e.role]={harness:e.harness||'',model:String(e.model),at:e.t||'',effort};
  }
  const classify=run=>{
    const role=roles.get(run.role);
    const life=!runtimeKnown?'unknown':role?.life?.state==='alive'?(role.life.pidState==='match'?'alive':'changed'):'absent';
    return {...run,sessionState:life,state:run.state==='unconfirmed'&&life==='absent'?'orphaned':run.state};
  };
  const result=cards.map(source=>{
    const card={...source,role:effectiveCardRole(source,entries,identity)};
    const own=[...runs.values()].filter(r=>r.taskConnection?.state==='resolved'&&r.executionKey===card.key).map(classify);
    const connectionErrors=[...runs.values()].filter(r=>r.taskConnection?.state==='ambiguous'&&r.taskConnection.candidates.includes(card.key)).map(r=>({taskId:r.rawTaskId,reason:r.taskConnection.reason}));
    const possible=plans.get(identity.taskIdFor(card));
    const board=card.board||(possible?.size===1?[...possible][0]:null);
    const lastEdit=Date.parse(card.at)||0;
    const lastRun=Math.max(0,...own.map(r=>Date.parse(r.at)||0));
    let state=card.status;
    // 완료/보류 결정은 과거 발송으로 지우지 않는다. 이후 새 발령은 다시 표시한다.
    if(own.length&&state!=='superseded'&&(!['done','hold','cancelled','superseded'].includes(state)||lastRun>lastEdit)) {
      state=own.every(r=>r.state==='done')?'done':own.some(r=>r.state==='failed')?'failed':own.some(r=>r.state==='orphaned')?'orphaned':'unconfirmed';
    }
    const transition=card.history.filter((h,i)=>i>0&&h.status!==card.history[i-1].status).at(-1);
    if(transition&&Date.parse(transition.at)>lastRun&&['ready','draft'].includes(card.status))state=card.status;
    if(transition&&Date.parse(transition.at)>lastRun&&card.status==='assigned'&&own.every(r=>r.state==='done'))state='assigned';
    const activityAt=Date.parse(card.activityAt)||0;
    if(state==='unconfirmed'&&['running','waiting'].includes(card.activity)&&Number.isFinite(Date.parse(card.activityAt))&&now>=activityAt&&
       own.some(r=>r.role===card.activityRole&&r.role===card.role&&r.state==='unconfirmed'&&r.sessionState==='alive'&&activityAt>=(Date.parse(r.sentAt)||0)))state=card.activity;
    const question=card.history.filter(h=>h.noteKind==='question').at(-1);
    const answer=card.history.filter(h=>h.noteKind==='answer').at(-1);
    return {...card,board,runs:own,displayState:state,ambiguous:connectionErrors.length>0,connectionErrors,pendingQuestion:!!question&&(!answer||question.revision>answer.revision)};
  });
  const order=['running','waiting','unconfirmed','orphaned','failed','ready','assigned','draft','hold','done','cancelled','superseded','archived'];
  result.sort((a,b)=>order.indexOf(a.displayState)-order.indexOf(b.displayState)||(Date.parse(b.at)-Date.parse(a.at))||a.key.localeCompare(b.key));
  const unregistered=[...runs.values()].filter(r=>r.taskConnection?.state!=='resolved').map(r=>({...classify(r),connectionLabel:r.taskConnection?.state==='unregistered'?'중앙 카드 미등록':'기록 연결 실패',connectionReason:r.taskConnection?.reason,board:plans.get(r.taskId)?.size===1?[...plans.get(r.taskId)][0]:null}));
  const boards=new Map();
  const ensure=name=>{if(!boards.has(name))boards.set(name,{name,cards:[],runs:[],state:'done'});return boards.get(name);};
  for(const c of result)if(c.board)ensure(c.board).cards.push(c);
  for(const r of unregistered)if(r.board)ensure(r.board).runs.push(r);
  for(const b of boards.values()) {
    const states=[...b.cards.map(c=>c.displayState),...b.runs.map(r=>r.state)];
    b.state=states.includes('running')?'running':states.includes('waiting')&&!states.some(s=>['unconfirmed','orphaned','failed'].includes(s))?'waiting':states.every(s=>['done','cancelled','superseded','archived'].includes(s))?'done':states.some(s=>['unconfirmed','orphaned','failed'].includes(s))?'needs-check':states.every(s=>['done','cancelled','superseded','archived','hold'].includes(s))?'hold':'planned';
  }
  // 실행은 ok로 확정됐는데 카드가 열린 채 남은 것. 카드 완료는 감독 판단이라 목록만 보인다(2026-09-24).
  // 실행이 여럿이면 가장 최근에 발령한 실행만 본다. 완료 확정 뒤 감독이 상태·담당을 바꿨으면 다시 연 것으로 보고 뺀다.
  const doneButOpen=result.filter(c=>['assigned','ready'].includes(c.status)).flatMap(c=>{
    const last=[...c.runs].sort((a,b)=>(Date.parse(a.sentAt??a.at)||0)-(Date.parse(b.sentAt??b.at)||0)).at(-1);
    if(last?.state!=='done')return [];
    const doneAt=Date.parse(last.at)||0;
    if(c.history.some((h,i)=>i>0&&(Date.parse(h.at)||0)>doneAt&&(h.status!==c.history[i-1].status||h.role!==c.history[i-1].role)))return [];
    return [{key:c.key,title:c.title,status:c.status,role:last.role,doneAt:last.at,doneBy:last.doneBy??'모름',revision:c.revision}];
  });
  const execution=result.filter(c=>c.workType!=='coordination');
  const executionSummary={cards:execution.length,remaining:execution.filter(c=>!['done','cancelled','superseded','archived'].includes(c.displayState)).length,running:execution.filter(c=>c.displayState==='running').length,coordinationCards:result.length-execution.length};
  return {rallies:buildRallies(result),executionSummary,cards:result,doneButOpen,boards:[...boards.values()],unregistered,roles:[...roles.values()],runtimeKnown,models,
    summary:{cards:result.length,running:result.filter(c=>c.displayState==='running').length,ready:result.filter(c=>c.displayState==='ready').length,
      attention:result.filter(c=>['unconfirmed','orphaned','failed'].includes(c.displayState)).length,
      openBoards:[...boards.values()].filter(b=>b.state!=='done').length}};
}
