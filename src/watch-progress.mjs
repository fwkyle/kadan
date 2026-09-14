import {taskIdentity} from './task-identity.mjs';
import {effectiveCardRole,openTaskIds} from './handover-state.mjs';

export const WORKER_RECHECK_MS=30*60_000;
const INTERVAL=WORKER_RECHECK_MS;
const superRole=role=>role==='슈퍼감독'||/^[^-]+-슈퍼감독(?:-|$)/u.test(role);
// 시간과 대상만 고른다. 판정·기록·상신은 감시AI의 watch-report가 맡는다.
export class ProgressWatch {
  states=new Map();
  lastJudged=new Map();
  started(session,screen,now) {
    this.lastJudged.set(session,now);
    for(const s of this.states.values())if(s.session===session){s.at=now;s.screen=screen.slice(-8000);}
  }
  select({cards,entries,observations,now,enabled,blockedSessions=new Set()}) {
    const identity=taskIdentity(cards);entries=identity.project(entries);
    const active=new Set();let selected=null;
    for(const card of cards){
      const role=effectiveCardRole(card,entries,identity),session='kadan-'+role,seen=observations.get(session);
      if(card.status!=='assigned'||card.workType==='coordination'||card.activity!=='running'||!role||superRole(role)||!seen?.alive||!seen.screen||seen.expectedPid!=null&&String(seen.pid)!==String(seen.expectedPid)||!openTaskIds(entries,role).includes(identity.taskIdFor(card)))continue;
      const key=card.key+'\0'+role+'\0'+seen.pid;active.add(key);
      let s=this.states.get(key);
      if(!s){s={at:now,screen:seen.screen.slice(-8000),session};this.states.set(key,s);}
      if(enabled&&!selected&&!blockedSessions.has(session)&&now-s.at>=INTERVAL&&now-(this.lastJudged.get(session)??-Infinity)>=INTERVAL){
        selected={source:'progress',role,session,taskId:identity.taskIdFor(card),input:{title:card.title,scope:card.scope,goal:card.body?.slice(0,6000),
          minutes:Math.floor((now-s.at)/60000),previous:s.screen,current:seen.screen.slice(-8000)}};
      }
    }
    for(const key of this.states.keys())if(!active.has(key))this.states.delete(key);
    return selected;
  }
}
