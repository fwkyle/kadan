import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {isUserActor} from './actors.mjs';
import * as ledger from './ledger.mjs';
import {assertWritable,storageTransaction} from './storage.mjs';
import {resolveWorkMail} from './work-mail.mjs';
import {composeRoleInstructions,readRoleInstructionsConfig} from './role-instructions.mjs';
import {composeMailInstructions} from './mail-instructions.mjs';

export const SECRETARY='비서';
const idPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const categories=new Set(['request','decision','report']);
const views=new Set(['received','sent','to-reply','waiting']);
const canAct=(by,role)=>by===role||isUserActor(by);
export const readMailboxEntries=home=>ledger.readMailLedger(home);
export {mailboxLetters} from './mailbox-state.mjs';
import {mailboxLetters} from './mailbox-state.mjs';

export class Mailbox {
 constructor(home,role=SECRETARY){
  if(typeof role!=='string'||!role.trim()||/\s/.test(role))throw new Error('올바른 수신 역할 필요');
  this.home=home;this.role=role;
 }
 send(options){return storageTransaction(this.home,()=>this.#store(options));}
 #store({by,message,category='report',replyTo,workKey,executionKey,expectReply=false,replyFinal=false}){
  assertWritable(this.home);
  if(!categories.has(category))throw new Error('공식 우편 종류는 request/decision/report만 지원합니다');
  if(typeof by!=='string'||!by.trim())throw new Error('보낸 역할 필요');
  if(typeof message!=='string'||!message.trim())throw new Error('우편 내용 필요');
  if(Buffer.byteLength(message)>64*1024)throw new Error('우편은 64KiB 이내로 작성하세요');
  const entries=readMailboxEntries(this.home);mailboxLetters(entries,this.role);
  const context=resolveWorkMail(this.home,{workKey,executionKey,replyTo,by,role:this.role,expectReply,replyFinal});
  readRoleInstructionsConfig(this.home);
  const digest=createHash('sha256').update(message).digest('hex'),mailId=randomUUID(),dir=path.join(this.home,'mail');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const file=path.join(dir,`${digest}.txt`);
  if(fs.existsSync(file)){if(fs.readFileSync(file,'utf8')!==message)throw new Error('우편 본문 지문 충돌');}
  else fs.writeFileSync(file,message,{mode:0o600,flag:'wx'});
  const {currentRecipient,...connection}=context;
  ledger.appendLedger({kind:'send',transport:'mailbox',role:this.role,by,mailId,mailKind:category,digest,bytes:Buffer.byteLength(message),...connection},this.home);
  return {mailId,recipient:currentRecipient||this.role,currentRecipient:currentRecipient||this.role,status:'stored',wake:'not-connected'};
 }
 list({all=false,view='received',unread=false}={}){
  return mailboxLetters(readMailboxEntries(this.home),this.role,{all:view==='sent'||all,view,unread}).reverse();
 }
 read(id){
  if(!idPattern.test(id))throw new Error('올바른 우편 ID 필요');
  const letter=[...this.list({all:true}),...this.list({view:'sent'})].find(e=>e.mailId===id);
  if(!letter)throw new Error(`${this.role} 우편 없음`);
  const body=ledger.readMailBody(letter.digest,this.home);if(body===null)throw new Error('본문 없음 또는 읽기 실패: 읽음 처리하지 않습니다');
  const recipient=letter.currentRecipient||letter.role;
  const receiver=composeRoleInstructions({home:this.home,role:recipient,...(recipient===SECRETARY?{profile:'secretary'}:{}),mailContext:letter});
  const instructions=composeMailInstructions({mailId:letter.mailId,recipient,sender:letter.currentSender||letter.by,
   expectReply:letter.replyStatus==='waiting',notificationOnly:letter.notificationOnly===true||letter.systemGenerated==='task-completion'});
  const receiverInstructions=[receiver.instructions,instructions].filter(Boolean).join('\n\n');
  return {...letter,body,receiverInstructions,receiverInstructionsProfile:receiver.metadata.profile,
   receiverInstructionsDigest:createHash('sha256').update(receiverInstructions).digest('hex'),roleInstructions:receiver.metadata};
 }
 acknowledge(id,by){return storageTransaction(this.home,()=>this.#recordRead(id,by));}
 #recordRead(id,by){
  if(!canAct(by,this.role))throw new Error(`${this.role} 또는 사용자만 읽음 기록 가능`);
  const letter=this.read(id);
  if(letter.currentRecipient!==this.role)throw new Error('수신한 우편만 읽음 기록 가능');
  if(!letter.read)ledger.appendLedger({kind:'mail-read',role:this.role,transport:letter.transport,mailId:id,by},this.home);
  return {mailId:id,read:true};
 }
 cancel(id,by){return storageTransaction(this.home,()=>this.#recordCancel(id,by));}
 #recordCancel(id,by){
  const letter=this.read(id);
  if(letter.currentSender!==this.role||!canAct(by,letter.currentSender))throw new Error('보낸 역할 또는 사용자만 답변 대기 취소 가능');
  if(letter.expectReply!==true)throw new Error('답변을 요청한 우편이 아닙니다');
  if(letter.replyStatus==='answered')throw new Error('이미 최종 답변이 도착한 우편입니다');
  if(!letter.cancelled)ledger.appendLedger({kind:'mail-cancel',role:letter.currentRecipient,mailId:id,by},this.home);
  return {mailId:id,replyStatus:'cancelled'};
 }
}

export function inboxCommand(args,flags,{home,by,env=process.env}){
 const [op='list',id]=args,role=flags.role||env.KADAN_ROLE||by||'사람',m=new Mailbox(home,role);
 if(flags.help)return 'kadan inbox [list|received|sent|to-reply|waiting] [--role 역할] [--all] [--view 보기] | read <우편ID> | ack <우편ID> | cancel <우편ID>. 기본 역할은 --role, KADAN_ROLE, 현재 발신자, 사람 순서. 비서는 --role 비서로 조회합니다. 조회는 읽음 처리하지 않습니다. ack는 읽음만, cancel은 자신이 보낸 질문의 답변 대기만 취소합니다.';
 if(op==='list'||views.has(op))return m.list({all:flags.all===true||flags.all==='1',unread:flags.unread===true,view:op==='list'?(flags.view||'received'):op});
 if(op==='read')return m.read(id);
 if(op==='ack')return m.acknowledge(id,by);
 if(op==='cancel')return m.cancel(id,by);
 throw new Error('알 수 없는 inbox 명령');
}
