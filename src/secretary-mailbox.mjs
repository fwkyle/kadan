import fs from 'node:fs';
import path from 'node:path';
import {isUserActor} from './actors.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {appendLedger,readLedger,readMailBody} from './ledger.mjs';
import {resolveWorkMail} from './work-mail.mjs';
import {composeRoleInstructions,readRoleInstructionsConfig} from './role-instructions.mjs';
export const SECRETARY='비서';
const idPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const categories=new Set(['request','decision','report']);
export function secretaryLetters(entries){
 if(entries.some(e=>e?.broken))throw new Error('원장 손상: 비서 우편 상태 확인 불가');
 const acknowledgements=new Set(entries.filter(e=>e.kind==='mail-read'&&e.role===SECRETARY).map(e=>e.mailId));
 return entries.filter(e=>e.kind==='send'&&e.role===SECRETARY&&e.transport==='mailbox').map(e=>({...e,read:acknowledgements.has(e.mailId)}));
}
export class SecretaryMailbox {
 constructor(home){this.home=home;}
 send({by,message,category='report',replyTo,workKey,executionKey}){
  if(!categories.has(category))throw new Error('공식 우편 종류는 request/decision/report만 지원합니다');
  if(typeof message!=='string'||!message.trim())throw new Error('우편 내용 필요');
  if(Buffer.byteLength(message)>64*1024)throw new Error('우편은 64KiB 이내로 작성하세요');
  const entries=readLedger(this.home);secretaryLetters(entries);
  if(replyTo&&!entries.some(e=>e.kind==='send'&&(e.mailId===replyTo||e.digest===replyTo)))throw new Error('연결할 원본 우편 없음');
  const context=resolveWorkMail(this.home,{workKey,executionKey,replyTo});
  readRoleInstructionsConfig(this.home);
  const digest=createHash('sha256').update(message).digest('hex'),mailId=randomUUID(),dir=path.join(this.home,'mail');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const file=path.join(dir,`${digest}.txt`);
  if(fs.existsSync(file)){if(fs.readFileSync(file,'utf8')!==message)throw new Error('우편 본문 지문 충돌');}
  else fs.writeFileSync(file,message,{mode:0o600,flag:'wx'});
  const entry={kind:'send',transport:'mailbox',role:SECRETARY,by,mailId,mailKind:category,digest,bytes:Buffer.byteLength(message),...context};
  // 원장에는 대화 본문/미리보기를 넣지 않는다. 본문은 우편 파일에만 둔다.
  appendLedger(entry,this.home);
  return {mailId,recipient:SECRETARY,status:'stored',wake:'not-connected'};
 }
 list({all=false}={}){return secretaryLetters(readLedger(this.home)).filter(e=>all||!e.read).reverse();}
 read(id){
  if(!idPattern.test(id))throw new Error('올바른 우편 ID 필요');
  const letter=this.list({all:true}).find(e=>e.mailId===id);if(!letter)throw new Error('비서 우편 없음');
  const body=readMailBody(letter.digest,this.home);if(body===null)throw new Error('본문 없음 또는 읽기 실패: 읽음 처리하지 않습니다');
  const receiver=composeRoleInstructions({home:this.home,role:SECRETARY,profile:'secretary',mailContext:letter});
  return {...letter,body,receiverInstructions:receiver.instructions,receiverInstructionsProfile:receiver.metadata.profile,
    receiverInstructionsDigest:receiver.metadata.digest,roleInstructions:receiver.metadata};
 }
 acknowledge(id,by){
  if(!(by==='비서'||isUserActor(by)))throw new Error('비서 또는 사용자만 읽음 기록 가능');
  const letter=this.read(id);if(letter.read)return {mailId:id,read:true};
  appendLedger({kind:'mail-read',role:SECRETARY,transport:'mailbox',mailId:id,by},this.home);
  return {mailId:id,read:true};
 }
}
export function inboxCommand(args,flags,{home,by}){
 const [op='list',id]=args,m=new SecretaryMailbox(home);
 if(flags.help)return 'kadan inbox list [--all] | read <우편ID> | ack <우편ID>. 비서 공식 우편함. 조회는 읽음 처리/대화 깨움을 하지 않습니다.';
 if(op==='list')return m.list({all:flags.all===true||flags.all==='1'});
 if(op==='read')return m.read(id);
 if(op==='ack')return m.acknowledge(id,by);
 throw new Error('알 수 없는 inbox 명령');
}
