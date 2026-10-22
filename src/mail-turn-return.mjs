import {WorkStore} from './work-store.mjs';
import {readLedger} from './ledger.mjs';
import {effectiveWorkOwner} from './handover-state.mjs';
import {isUserActor} from './actors.mjs';

// 놀고 있음 PR-3: 위임받은 쪽이 결과 우편을 업무 owner에게 보내면 업무 차례(turnOwner)를 owner로 돌려준다.
// 규칙(셋이 모두 참일 때만): (a) 보낸 역할 == 저장된 turnOwner, (b) 보낸 역할 != 현재 책임 owner(인계 반영),
// (c) 받는 역할 == 현재 책임 owner. turnState(current/stale)는 보지 않는다 — stale이면 감시는 이미 owner로 읽으므로
// 저장값만 맞춰질 뿐이다. 우편이 성공한 뒤 별도 트랜잭션으로 best-effort 하며, 실패해도 우편은 실패시키지 않는다.
// 잠금은 '우편 → 업무' 한 방향이다: 이 함수는 우편 쓰기 뒤에만 불리고, WorkStore는 우편을 쓰지 않는다.
const quote=s=>`'${String(s).replaceAll("'","'\\''")}'`;

export const undoCommand=(workKey,revision,sender)=>
 `kadan work update ${quote(workKey)} --revision ${revision} --turn-owner ${quote(sender)} --note '차례 되돌림'`;

// 보내기 전에 판정한다(본문 꼬리를 붙일지 정하려고). 우편 종류가 대상이 아니거나 읽기에 실패하면 null이다.
// 사람 명의, watch·알림 전용·시스템 생성 우편, --task 발령, --raw, --keep-turn, 저장만 되는 수신자는 대상이 아니다.
export function planTurnReturn(home,{sender,recipient,workKey,taskId,raw=false,keepTurn=false,notificationOnly=false,systemGenerated=false,by=sender,storeOnly=false},{readEntries=readLedger}={}){
 if(keepTurn||raw||storeOnly||notificationOnly||systemGenerated||taskId!=null||!workKey)return null;
 if(!sender||sender!==by||by==='watch'||isUserActor(sender)||!recipient)return null;
 try{
  const work=new WorkStore(home).get(workKey);
  if(work.status!=='open'||!work.turnOwner||work.turnOwner!==sender)return null;
  const owner=effectiveWorkOwner(work,readEntries(home));
  if(!owner||owner===sender||owner!==recipient)return null;
  return {workKey,sender,owner,revision:work.revision};
 }catch{return null;}
}

// 받는 owner가 읽는 본문 꼬리. 새 revision은 전송 뒤에야 정해지므로 일반 안내만 쓴다.
export function turnReturnTail(plan){
 return `\n\n차례를 ${plan.owner}에게 돌렸습니다. 되돌리려면 \`kadan work show ${quote(plan.workKey)}\`로 revision을 보고 \`kadan work update ${quote(plan.workKey)} --revision N --turn-owner ${quote(plan.sender)} --note '차례 되돌림'\`.`;
}

// 우편 전송과 영수증 기록이 끝난 뒤에만 부른다. 업무 쓰기 실패(revision 충돌 포함)는 던지지 않고 stderr 한 줄과 수동 명령만 낸다.
export function applyTurnReturn(home,plan,mailId,{store=new WorkStore(home),warn=line=>console.error(line)}={}){
 if(!plan)return null;
 const next=plan.revision+1,undo=undoCommand(plan.workKey,next,plan.sender);
 try{
  const work=store.change(plan.workKey,'update',{turnOwner:plan.owner},
   {revision:plan.revision,by:plan.sender,note:`우편 ${mailId}로 owner에게 차례 반환 — 되돌리기: ${undo}`});
  return {workKey:plan.workKey,from:plan.sender,to:plan.owner,revision:work.revision,mailId,undoCommand:undoCommand(plan.workKey,work.revision,plan.sender)};
 }catch(error){
  warn(`차례 반환 실패(우편은 전달됨): ${error.message}. 필요하면 직접: kadan work update ${quote(plan.workKey)} --revision <현재 revision> --turn-owner ${quote(plan.owner)} --note '우편 ${mailId} 결과 반환'`);
  return null;
 }
}
