// 기존 비서 우편 API는 모든 역할 우편함의 호환 진입점으로 유지한다.
import {Mailbox,mailboxLetters,SECRETARY} from './mailbox.mjs';
export {SECRETARY,inboxCommand} from './mailbox.mjs';
export function secretaryLetters(entries){
 return mailboxLetters(entries,SECRETARY).filter(e=>e.transport==='mailbox');
}
export class SecretaryMailbox extends Mailbox {
 constructor(home){super(home,SECRETARY);}
 list(options={}){return super.list(options).filter(e=>e.transport==='mailbox');}
}
