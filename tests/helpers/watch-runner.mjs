import {setImmediate} from 'node:timers/promises';
import {runWatch as run} from '../../src/watch-runner.mjs';

// 수신자는 살아 있는 세션이어야 알림이 간다(HW-7-impl). liveRecipients에 적은 역할은
// 시작 기록과 살아 있는 화면('healthy')을 가진 것으로 덧붙여, 수신자 선택 시험이 죽은 이름 건너뛰기에 걸리지 않게 한다.
function withLiveRecipients({liveRecipients,...options}) {
  if (!liveRecipients?.length) return options;
  const sessions=liveRecipients.map(role=>`kadan-${role}`);
  const startEntry=(role,session)=>({kind:'start',role,session,panePid:1,t:'2000-01-01T00:00:00.000Z'});
  return {...options,
    floor:{...options.floor,
      list:()=>[...options.floor.list(),...sessions.map(session=>({session,pid:1}))],
      read:name=>sessions.includes(name)?'healthy':options.floor.read(name)},
    readEntries:()=>[...options.readEntries(),...liveRecipients.map((role,i)=>startEntry(role,sessions[i]))]};
}

// 기존 가짜 시계 시험은 sleep 명령에서 회차를 넘긴다. AI 완료도 회차 사이에 처리한다.
export function runWatch(options) {
  const resolved=withLiveRecipients(options);
  return run({...resolved,sleep:async ms=>{
    await setImmediate();
    options.spawn('sleep',[String(ms/1000)]);
  }});
}
