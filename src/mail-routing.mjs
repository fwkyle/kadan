// Why: 원문 참가자는 보존하고 확정 인계 이후의 우편 처리 책임만 계산한다.
export const isMailTransfer = entry => entry?.kind === 'handover' && entry.phase === 'transferred';

export function createMailRouting() {
 const letters=new Map(),transfers=new Map();
 const add=(entry,parent)=>{
  const source=letters.get(parent);
  // 늦게 저장된 답장은 원본 우편의 발신 책임만 이어받는다. 독립 새 우편은 그대로 둔다.
  const currentRecipient=source?.senderRoles.has(entry.role)?source.currentSender:entry.role;
  const state={currentRecipient,currentSender:entry.by,senderRoles:new Set([entry.by])};
  letters.set(entry,state);
  return state;
 };
 const apply=entry=>{
  if(!isMailTransfer(entry))return;
  const {from,to}=entry;
  if(typeof from!=='string'||!from.trim()||typeof to!=='string'||!to.trim()||from===to)
   throw new Error('우편 인계 역할 손상');
  const key=entry.handoverId||JSON.stringify([from,to]),previous=transfers.get(key);
  if(previous){
   if(previous.from!==from||previous.to!==to)throw new Error('우편 인계 책임 충돌');
   return; // 같은 확정 사건 재등장은 새 역할의 우편을 다시 가져가지 않는다.
  }
  transfers.set(key,{from,to});
  for(const state of letters.values()){
   if(state.currentRecipient===from)state.currentRecipient=to;
   if(state.currentSender===from){state.currentSender=to;state.senderRoles.add(to);}
  }
 };
 return {add,get:entry=>letters.get(entry),apply};
}
