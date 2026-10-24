import {WorkStore} from './work-store.mjs';
import {readLedger} from './ledger.mjs';
import {effectiveWorkOwner} from './handover-state.mjs';
import {isUserActor} from './actors.mjs';

// 놀고 있음 PR-3: 위임받은 쪽이 결과 우편을 업무 owner에게 보내면 업무 차례(turnOwner)를 owner로 돌려준다.
// 규칙(셋이 모두 참일 때만): (a) 보낸 역할 == 저장된 turnOwner, (b) 보낸 역할 != 현재 책임 owner(인계 반영),
// (c) 받는 역할 == 현재 책임 owner. turnState(current/stale)는 보지 않는다 — stale이면 감시는 이미 owner로 읽으므로
// 저장값만 맞춰질 뿐이다.
// 순서(2026-10-23 검수 F1·F2 수정): 보내기 전에 업무 잠금 안에서 다시 판정하고 쓴다(claimTurnReturn) →
// 쓰기가 성공했을 때만 실제 revision으로 만든 꼬리를 붙여 보낸다 → 전송이 실패하면 되돌린다(revertTurnReturn).
// 잠금은 겹치지 않는다: claim·revert는 업무 잠금을 쥐었다 놓고 끝나며, 우편(guardedSend)은 그 잠금을 놓은 뒤에만 시작한다.
// 이 잠금 안에서 우편을 부르는 일은 없다(판정은 업무·원장 읽기만 한다).
// 2026-10-23 수정 2였던 'JSONL이면 자동 반환 안 함' 건너뛰기는 JSONL 백엔드와 함께 지웠다(쓰기는 항상 SQLite 트랜잭션). 되돌림은 claim이 남긴 revision 그대로일 때만 한다(같은 이름 재지정·A→B→A를 덮어쓰지 않는다).
const quote=s=>`'${String(s).replaceAll("'","'\\''")}'`;

export const undoCommand=(workKey,revision,sender)=>
 `kadan work update ${quote(workKey)} --revision ${revision} --turn-owner ${quote(sender)} --note '차례 되돌림'`;

// 잠금 안 재판정이 "더는 맞지 않음"으로 끝난 경우. 쓰기 실패와 구분한다.
class TurnReturnSkip extends Error {}

// 보내기 전 가벼운 사전 걸러냄(잠금 없음). 우편 종류가 대상이 아니거나 읽기에 실패하면 null이다.
// 사람 명의, watch·알림 전용·시스템 생성 우편, --task 발령, --raw, --keep-turn, 저장만 되는 수신자는 대상이 아니다.
// 이 결과는 쓰기 결정이 아니다. 실제 판정은 claimTurnReturn이 잠금 안에서 다시 한다.
export function planTurnReturn(home,{sender,recipient,workKey,taskId,raw=false,keepTurn=false,notificationOnly=false,systemGenerated=false,by=sender,storeOnly=false},{readEntries=readLedger}={}){
 if(keepTurn||raw||storeOnly||notificationOnly||systemGenerated||taskId!=null||!workKey)return null;
 if(!sender||sender!==by||by==='watch'||isUserActor(sender)||!recipient)return null;
 try{
  const work=new WorkStore(home).get(workKey);
  if(work.status!=='open'||!work.turnOwner||work.turnOwner!==sender)return null;
  const owner=effectiveWorkOwner(work,readEntries(home));
  if(!owner||owner===sender||owner!==recipient)return null;
  return {workKey,sender,owner};
 }catch{return null;}
}

const manualMove=(plan)=>`kadan work update ${quote(plan.workKey)} --revision <현재 revision> --turn-owner ${quote(plan.owner)} --note '결과 우편 차례 반환'`;

// 업무 잠금 안에서 최신 업무·원장으로 세 조건을 다시 확인하고 차례를 owner로 쓴다. 판정과 쓰기가 한 순간이다.
// 성공하면 {workKey,sender,owner,revision,undo}(undo는 새 revision 기준, 꼬리·영수증이 같은 명령을 쓴다), 실패·불일치면 null이며
// 던지지 않고 stderr 한 줄만 낸다 — 이때 호출한 쪽은 꼬리 없이 보통 우편을 보낸다.
export function claimTurnReturn(home,plan,{store=new WorkStore(home),readEntries=readLedger,warn=line=>console.error(line)}={}){
 if(!plan)return null;
 let undo=null;
 try{
  const work=store.changeTurnOwner(plan.workKey,current=>{
   const owner=effectiveWorkOwner(current,readEntries(home));
   if(current.status!=='open'||current.turnOwner!==plan.sender||!owner||owner===plan.sender||owner!==plan.owner)throw new TurnReturnSkip('업무·차례·책임자가 보내는 사이 바뀜');
   undo=undoCommand(plan.workKey,current.revision+1,plan.sender);
   return {turnOwner:plan.owner,by:plan.sender,note:`우편으로 owner에게 차례 반환(되돌리기: ${undo})`};
  });
  return {workKey:plan.workKey,sender:plan.sender,owner:plan.owner,revision:work.revision,undo};
 }catch(error){
  warn(error instanceof TurnReturnSkip
   ?`차례 반환 건너뜀(우편은 꼬리 없이 보냄): ${error.message}. 확인: kadan work show ${quote(plan.workKey)}`
   :`차례 반환 실패(우편은 꼬리 없이 보냄): ${error.message}. 필요하면 직접: ${manualMove(plan)}`);
  return null;
 }
}

// 받는 owner가 읽는 본문 꼬리. claim이 성공한 뒤에만 만든다. 영수증의 되돌리기 명령과 같은 문자열이다.
export function turnReturnTail(claim){
 return `\n\n차례를 ${claim.owner}에게 돌렸습니다. 되돌리려면 \`${claim.undo}\`.`;
}

// 보낸 쪽 출력 {"turnReturn":{…}}에 쓰는 영수증.
export function turnReturnReceipt(claim,mailId){
 return {workKey:claim.workKey,from:claim.sender,to:claim.owner,revision:claim.revision,mailId,undoCommand:claim.undo};
}

// 쓰기는 성공했는데 전송이 실패했을 때(not-sent·send-failed·unknown) 되돌린다. best-effort이며 던지지 않는다.
// claim이 남긴 revision 그대로일 때만 쓴다. 그 사이 어떤 변경이든 있었으면(이름이 같아도) 되돌리지 않고 알린다.
export function revertTurnReturn(home,claim,{store=new WorkStore(home),warn=line=>console.error(line)}={}){
 if(!claim)return false;
 try{
  store.change(claim.workKey,'update',{turnOwner:claim.sender},{revision:claim.revision,by:claim.sender,note:'우편 전송 실패로 차례 반환 취소'});
  return true;
 }catch(error){
  warn(String(error.message).startsWith('업무가 변경됨')
   ?`차례 되돌리기 건너뜀(우편 전송 실패): 그 사이 업무가 바뀜(revision ${claim.revision} 아님). 확인: kadan work show ${quote(claim.workKey)} — 아직 ${claim.owner}가 차례면 직접: kadan work update ${quote(claim.workKey)} --revision <현재 revision> --turn-owner ${quote(claim.sender)} --note '차례 되돌림'`
   :`!!! 우편 전송 실패 + 차례 되돌리기 실패: ${error.message}. 차례가 ${claim.owner}에게 남아 있을 수 있습니다. 직접 되돌리세요: ${claim.undo}`);
  return false;
 }
}
