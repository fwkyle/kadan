import {taskIdentity} from './task-identity.mjs';
import {WorkStore} from './work-store.mjs';
import {CardStore} from './card-store.mjs';
import {readMailLedger,readLedger} from './ledger.mjs';
import {mailboxLetters} from './mailbox-state.mjs';
import {isUserActor} from './actors.mjs';
import {effectiveCardRole} from './handover-state.mjs';

// --task는 발령, --work/--execution은 우편의 연결 주소다. 원문에서 대상을 추측하지 않는다.
// --execution만 썼는데 그 주소가 수신 역할에 발령된 중앙 카드이면 카드 없는 발령이 되어
// 감시에서 빠진다 (card-send-execution-card-link-guard). 카드 실재·assigned 상태·
// 실제 담당이 모두 확인될 때만 발령으로 추론하고, 답장·질문(--expect-reply)·다른 담당의 실행 연결은 건드리지 않는다.
export function inferDispatchTask(home,{executionKey,role,replyTo,expectReply}={}){
 if(!executionKey||typeof role!=='string'||!role.trim()||replyTo||expectReply)return null;
 const card=new CardStore(home).list().find(c=>c.key===executionKey);
 if(!card||card.status!=='assigned')return null;
 if(effectiveCardRole(card,readLedger(home))!==role)return null;
 return card.id;
}

export function resolveWorkMail(home,{workKey,executionKey,replyTo,taskId,by,role,expectReply=false,replyFinal=false}={}){
 if(typeof expectReply!=='boolean'||typeof replyFinal!=='boolean')throw new Error('답변 옵션은 true/false여야 합니다');
 if(replyFinal&&!replyTo)throw new Error('최종 답변에는 원본 우편 ID가 필요합니다');
 if(replyFinal&&expectReply)throw new Error('최종 답변은 다시 답변을 요청하지 않습니다');
 const replyFlags={...(expectReply?{expectReply:true}:{}),...(replyFinal?{replyFinal:true}:{})};
 if(!workKey&&!executionKey&&!replyTo&&!taskId)return replyFlags;
 const works=new WorkStore(home).list(),cards=new CardStore(home).list(),entries=readMailLedger(home);
 if(entries.some(x=>x.broken))throw new Error('원장 손상: 우편 연결 확인 불가');
 if(taskId){const identity=taskIdentity(cards);identity.write(taskId,executionKey);const found=identity.resolve(taskId,executionKey);if(!found.card&&works.some(w=>w.id===taskId||w.key===taskId))throw new Error('업무 ID는 실행 발령에 쓰지 않습니다. 업무 안에 새 실행을 등록하세요');if(found.card){executionKey=found.key;}}
 let parent;
 if(replyTo){
  const matches=mailboxLetters(entries).filter(x=>x.mailId===replyTo||x.digest===replyTo);
  if(matches.length!==1)throw new Error('고유한 원본 우편 ID 필요');
  parent=matches[0];
  if(typeof parent.by!=='string'||!parent.by.trim()||typeof parent.role!=='string'||!parent.role.trim())throw new Error('원본 우편 참가자 정보 손상');
  if(workKey&&workKey!==parent.workKey)throw new Error('답장과 원본의 업무가 다릅니다');
  if(executionKey&&executionKey!==parent.executionKey)throw new Error('답장과 원본의 실행이 다릅니다');
  if(role!==undefined&&!parent.replyRecipients.includes(role))throw new Error(`답장 받는 역할은 원본 발신자의 현재 책임자 ${parent.currentSender}여야 합니다`);
  if(by!==undefined&&by!==parent.currentRecipient&&!isUserActor(by))throw new Error(`원본 수신자의 현재 책임자 ${parent.currentRecipient} 또는 사용자만 답장할 수 있습니다`);
  if(replyFinal&&parent.expectReply!==true)throw new Error('답변을 요청한 원본 우편이 아닙니다');
  if(replyFinal&&parent.replyStatus==='cancelled')throw new Error('답변 대기가 취소된 우편입니다');
  if(replyFinal&&parent.replyStatus==='answered')throw new Error('이미 최종 답변이 도착한 우편입니다');
  workKey??=parent.workKey;executionKey??=parent.executionKey;
 }
 if(executionKey){
  if(!cards.some(c=>c.key===executionKey))throw new Error('연결할 실행 없음');
  const linked=works.find(w=>w.executions.some(x=>x.key===executionKey));
  if(workKey&&(!linked||linked.key!==workKey))throw new Error('해당 업무에 연결된 실행이 아닙니다');
  workKey??=linked?.key;
 }
 if(workKey&&!works.some(w=>w.key===workKey))throw new Error('연결할 업무 없음');
 if(parent&&(workKey!==parent.workKey||executionKey!==parent.executionKey))throw new Error('답장과 원본의 업무 또는 실행이 다릅니다');
 if(taskId&&workKey&&['done','cancelled'].includes(works.find(w=>w.key===workKey).status))throw new Error('종료한 업무입니다. 업무를 다시 열고 새 실행을 등록하세요');
 return {...replyFlags,...(workKey?{workKey}:{}),...(executionKey?{executionKey}:{}),...(replyTo?{replyTo,currentRecipient:parent.currentSender}:{})};
}

export function workLetters(work,entries,cards){
 if(entries.some(x=>x.broken))throw new Error('원장 손상: 업무 인박스 모름');
 const sends=entries.filter(x=>x.kind==='send'),executionKeys=new Set(work.executions.map(x=>x.key));
 const identity=taskIdentity(cards);
 const selected=new Set(sends.filter(x=>x.workKey===work.key||(!x.workKey&&executionKeys.has(identity.resolve(x.taskId,x.executionKey).key))||work.mailRefs.some(ref=>x.mailId===ref||x.digest===ref)));
 // 답장 연결은 유일한 우편 ID/지문에 대해서만 따른다. 같은 내용 여러 통은 합치지 않는다.
 const byRef=new Map();for(const x of sends)for(const ref of [x.mailId,x.digest].filter(Boolean)){if(!byRef.has(ref))byRef.set(ref,[]);byRef.get(ref).push(x);}
 const children=new Map();for(const x of sends){const parents=byRef.get(x.replyTo);if(parents?.length!==1||x.workKey&&x.workKey!==work.key)continue;const parent=parents[0];if(!children.has(parent))children.set(parent,[]);children.get(parent).push(x);}
 const queue=[...selected];for(let i=0;i<queue.length;i++)for(const child of children.get(queue[i])||[]){if(!selected.has(child)){selected.add(child);queue.push(child);}}
 const projected=mailboxLetters(entries),byEntry=new Map(sends.map((entry,index)=>[entry,projected[index]]));
 return [...selected].map(x=>byEntry.get(x)).reverse();
}
