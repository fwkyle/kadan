import {WorkStore} from './work-store.mjs';
import {CardStore} from './card-store.mjs';
import {readLedger} from './ledger.mjs';
import {effectiveCardRole} from './handover-state.mjs';

// --task는 발령, --work/--execution은 우편의 연결 주소다. 원문에서 대상을 추측하지 않는다.
// --execution만 썼는데 그 주소가 수신 역할에 발령된 중앙 카드이면 카드 없는 발령이 되어
// 감시에서 빠진다 (card-send-execution-card-link-guard). 카드 실재·assigned 상태·
// 실제 담당이 모두 확인될 때만 발령으로 추론하고, 답장·다른 담당의 실행 연결은 건드리지 않는다.
export function inferDispatchTask(home,{executionKey,role,replyTo}={}){
 if(!executionKey||typeof role!=='string'||!role.trim()||replyTo)return null;
 const card=new CardStore(home).list().find(c=>c.key===executionKey);
 if(!card||card.status!=='assigned')return null;
 if(effectiveCardRole(card,readLedger(home))!==role)return null;
 return card.id;
}

export function resolveWorkMail(home,{workKey,executionKey,replyTo,taskId}={}){
 if(!workKey&&!executionKey&&!replyTo&&!taskId)return {};
 const works=new WorkStore(home).list(),cards=new CardStore(home).list(),entries=readLedger(home);
 if(entries.some(x=>x.broken))throw new Error('원장 손상: 우편 연결 확인 불가');
 if(taskId){const found=cards.filter(c=>c.id===taskId);if(!found.length&&works.some(w=>w.id===taskId))throw new Error('업무 ID는 실행 발령에 쓰지 않습니다. 업무 안에 새 실행을 등록하세요');if(found.length===1){if(executionKey&&executionKey!==found[0].key)throw new Error('발령 대상과 실행 연결이 다릅니다');executionKey=found[0].key;}}
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
 const ids=new Set(cards.filter(c=>executionKeys.has(c.key)&&cards.filter(x=>x.id===c.id).length===1).map(c=>c.id));
 const selected=new Set(sends.filter(x=>x.workKey===work.key||executionKeys.has(x.executionKey)||(!x.workKey&&ids.has(x.taskId))||work.mailRefs.some(ref=>x.mailId===ref||x.digest===ref)));
 // 답장 연결은 유일한 우편 ID/지문에 대해서만 따른다. 같은 내용 여러 통은 합치지 않는다.
 const byRef=new Map();for(const x of sends)for(const ref of [x.mailId,x.digest].filter(Boolean)){if(!byRef.has(ref))byRef.set(ref,[]);byRef.get(ref).push(x);}
 let changed=true;while(changed){changed=false;for(const x of sends){if(selected.has(x)||x.workKey&&x.workKey!==work.key)continue;const parents=byRef.get(x.replyTo);if(parents?.length===1&&selected.has(parents[0])){selected.add(x);changed=true;}}}
 const read=new Set(entries.filter(x=>x.kind==='mail-read').map(x=>x.mailId));
 return [...selected].map(x=>({...x,read:x.transport==='mailbox'?read.has(x.mailId):null})).reverse();
}
