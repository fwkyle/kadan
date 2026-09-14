import {taskIdentity} from './task-identity.mjs';
import {WorkStore} from './work-store.mjs';
import {CardStore} from './card-store.mjs';
import {readLedger} from './ledger.mjs';

// --task는 발령, --work/--execution은 우편의 연결 주소다. 원문에서 대상을 추측하지 않는다.
export function resolveWorkMail(home,{workKey,executionKey,replyTo,taskId}={}){
 if(!workKey&&!executionKey&&!replyTo&&!taskId)return {};
 const works=new WorkStore(home).list(),cards=new CardStore(home).list(),entries=readLedger(home);
 if(entries.some(x=>x.broken))throw new Error('원장 손상: 우편 연결 확인 불가');
 if(taskId){const identity=taskIdentity(cards);identity.write(taskId,executionKey);const found=identity.resolve(taskId,executionKey);if(!found.card&&works.some(w=>w.id===taskId||w.key===taskId))throw new Error('업무 ID는 실행 발령에 쓰지 않습니다. 업무 안에 새 실행을 등록하세요');if(found.card){executionKey=found.key;}}
 let parent;
 if(replyTo){
  const matches=entries.filter(x=>x.kind==='send'&&(x.mailId===replyTo||x.digest===replyTo));
  if(matches.length!==1)throw new Error('고유한 원본 우편 ID 필요');
  parent=matches[0];
  if(workKey&&parent.workKey&&workKey!==parent.workKey)throw new Error('답장과 원본의 업무가 다릅니다');
  if(executionKey&&parent.executionKey&&executionKey!==parent.executionKey)throw new Error('답장과 원본의 실행이 다릅니다');
  workKey??=parent.workKey;executionKey??=parent.executionKey;
 }
 if(executionKey){
  if(!cards.some(c=>c.key===executionKey))throw new Error('연결할 실행 없음');
  const linked=works.find(w=>w.executions.some(x=>x.key===executionKey));
  if(workKey&&(!linked||linked.key!==workKey))throw new Error('해당 업무에 연결된 실행이 아닙니다');
  workKey??=linked?.key;
 }
 if(workKey&&!works.some(w=>w.key===workKey))throw new Error('연결할 업무 없음');
 if(taskId&&workKey&&['done','cancelled'].includes(works.find(w=>w.key===workKey).status))throw new Error('종료한 업무입니다. 업무를 다시 열고 새 실행을 등록하세요');
 return {...(workKey?{workKey}:{}),...(executionKey?{executionKey}:{}),...(replyTo?{replyTo}:{})};
}

export function workLetters(work,entries,cards){
 if(entries.some(x=>x.broken))throw new Error('원장 손상: 업무 인박스 모름');
 const sends=entries.filter(x=>x.kind==='send'),executionKeys=new Set(work.executions.map(x=>x.key));
 const identity=taskIdentity(cards);
 const selected=new Set(sends.filter(x=>x.workKey===work.key||(!x.workKey&&executionKeys.has(identity.resolve(x.taskId,x.executionKey).key))||work.mailRefs.some(ref=>x.mailId===ref||x.digest===ref)));
 // 답장 연결은 유일한 우편 ID/지문에 대해서만 따른다. 같은 내용 여러 통은 합치지 않는다.
 const byRef=new Map();for(const x of sends)for(const ref of [x.mailId,x.digest].filter(Boolean)){if(!byRef.has(ref))byRef.set(ref,[]);byRef.get(ref).push(x);}
 let changed=true;while(changed){changed=false;for(const x of sends){if(selected.has(x)||x.workKey&&x.workKey!==work.key)continue;const parents=byRef.get(x.replyTo);if(parents?.length===1&&selected.has(parents[0])){selected.add(x);changed=true;}}}
 const read=new Set(entries.filter(x=>x.kind==='mail-read').map(x=>x.mailId));
 return [...selected].map(x=>({...x,read:x.transport==='mailbox'?read.has(x.mailId):null})).reverse();
}
