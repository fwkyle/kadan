import {taskIdentity} from './task-identity.mjs';
import {WorkStore} from './work-store.mjs';
import {CardStore} from './card-store.mjs';
import {readMailboxLedger,readLedger} from './ledger.mjs';
import {mailboxLetters} from './mailbox-state.mjs';
import {isUserActor} from './actors.mjs';
import {effectiveCardRole} from './handover-state.mjs';

// --task는 발령, --work/--execution은 우편의 연결 주소다. 원문에서 대상을 추측하지 않는다.
// --execution만 썼는데 그 주소가 수신 역할에 발령된 중앙 카드이면 카드 없는 발령이 되어
// 감시에서 빠진다 (card-send-execution-card-link-guard). 카드 실재·assigned 상태·
// 실제 담당이 모두 확인될 때만 발령으로 추론하고, 답장·질문(--expect-reply)·다른 담당의 실행 연결은 건드리지 않는다.
export function inferDispatchTask(home,{executionKey,role,replyTo,expectReply}={}){
 if(!executionKey||typeof role!=='string'||!role.trim()||replyTo||expectReply)return null;
 const card=new CardStore(home).listSummaries().find(c=>c.key===executionKey);
 if(!card||card.status!=='assigned')return null;
 if(effectiveCardRole(card,readLedger(home))!==role)return null;
 return card.id;
}

export function resolveWorkMail(home,{workKey,executionKey,replyTo,taskId,by,role,expectReply=false,replyFinal=false}={},snapshot={}){
 if(typeof expectReply!=='boolean'||typeof replyFinal!=='boolean')throw new Error('답변 옵션은 true/false여야 합니다');
 if(replyFinal&&!replyTo)throw new Error('최종 답변에는 원본 우편 ID가 필요합니다');
 if(replyFinal&&expectReply)throw new Error('최종 답변은 다시 답변을 요청하지 않습니다');
 const replyFlags={...(expectReply?{expectReply:true}:{}),...(replyFinal?{replyFinal:true}:{})};
 if(!workKey&&!executionKey&&!replyTo&&!taskId)return replyFlags;
 const works=new WorkStore(home).list(),cards=snapshot.cards??new CardStore(home).listSummaries(),entries=snapshot.entries??readMailboxLedger(home);
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

// 업무마다 전체 우편 투영·카드 주소 해석·답장 연결표를 다시 만들면 업무 수×우편 수가 든다(2026-10-22 실측: 원장 6.9만 건,
// 업무 목록 계산 CPU 31초 중 대부분). 같은 entries·cards 배열이면 업무와 무관한 부분을 한 번만 만들고 업무별로는 고르기만 한다.
const lettersContexts=new WeakMap();
function lettersContext(entries,cards){
 const hit=lettersContexts.get(entries);
 if(hit&&hit.cards===cards&&hit.length===entries.length)return hit;
 const sends=entries.filter(x=>x.kind==='send'),identity=taskIdentity(cards);
 // 업무 연결이 없는 우편은 실행 주소로 업무를 찾는다. 해석은 우편마다 한 번이면 된다.
 const execKey=sends.map(x=>x.workKey?null:identity.resolve(x.taskId,x.executionKey).key);
 // 답장 연결은 유일한 우편 ID/지문에 대해서만 따른다. 같은 내용 여러 통은 합치지 않는다.
 const byRef=new Map();for(const x of sends)for(const ref of [x.mailId,x.digest].filter(Boolean)){if(!byRef.has(ref))byRef.set(ref,[]);byRef.get(ref).push(x);}
 const children=new Map();for(const x of sends){const parents=byRef.get(x.replyTo);if(parents?.length!==1)continue;const parent=parents[0];if(!children.has(parent))children.set(parent,[]);children.get(parent).push(x);}
 const projected=mailboxLetters(entries),byEntry=new Map(sends.map((entry,index)=>[entry,projected[index]]));
 const byWork=new Map(),byExecution=new Map(),position=new Map(),seedRefs=new Map();
 const add=(map,key,value)=>{if(!map.has(key))map.set(key,[]);map.get(key).push(value);};
 sends.forEach((entry,i)=>{position.set(entry,i);add(byWork,entry.workKey,entry);
  if(!entry.workKey)add(byExecution,execKey[i],entry);
  add(seedRefs,entry.mailId,entry);add(seedRefs,entry.digest,entry);});
 const value={cards,length:entries.length,children,byEntry,seedRefs,byWork,byExecution,position};
 lettersContexts.set(entries,value);return value;
}

export function workLetters(work,entries,cards){
 return createWorkLettersReader(entries,cards)(work);
}
// 같은 불변 snapshot의 여러 업무를 읽을 때 원장 손상 검사는 한 번만 한다.
export function createWorkLettersReader(entries,cards){
 if(entries.some(x=>x.broken))throw new Error('원장 손상: 업무 인박스 모름');
 const context=lettersContext(entries,cards);
 return work=>selectWorkLetters(work,context);
}
function selectWorkLetters(work,{children,byEntry,seedRefs,byWork,byExecution,position}){
 const seeds=new Set(byWork.get(work.key)??[]);
 for(const {key} of work.executions)for(const entry of byExecution.get(key)??[])seeds.add(entry);
 for(const ref of work.mailRefs)for(const entry of seedRefs.get(ref)??[])seeds.add(entry);
 // 원래 전체 filter의 순서와 이후 답장 너비 우선 순서를 유지한다.
 const selected=new Set([...seeds].sort((a,b)=>position.get(a)-position.get(b)));
 const queue=[...selected];for(let i=0;i<queue.length;i++)for(const child of children.get(queue[i])||[]){if(child.workKey&&child.workKey!==work.key)continue;if(!selected.has(child)){selected.add(child);queue.push(child);}}
 // 부르는 쪽이 고쳐도 다른 호출에 번지지 않게 고른 우편만 새 객체로 돌려준다(mailboxLetters가 하던 복제와 같다).
 return [...selected].map(x=>{const l=byEntry.get(x);return {...l,replyRecipients:[...l.replyRecipients]};}).reverse();
}
