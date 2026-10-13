import { isUserActor } from './actors.mjs';
import { mailboxLetters } from './mailbox-state.mjs';
import { readLedger, readMailBody } from './ledger.mjs';
import { Mailbox } from './mailbox.mjs';
import { userAlertRequired, userMailRequired } from './user-notification-policy.mjs';

// 결정과 별개의 사용자 확인 항목. 기존 원장·우편을 읽고, 새 승인/할 일을 만들지 않는다.
export function userAttention(entries, home) {
  if (!Array.isArray(entries) || entries.some(e => e?.broken)) throw new Error('사용자 확인 기록을 읽을 수 없습니다');
  const mail = mailboxLetters(entries).filter(m => isUserActor(m.currentRecipient) &&
    !isUserActor(m.currentSender) && userMailRequired(m) &&
    (m.replyStatus === 'waiting' || (m.read === false && !['answered', 'cancelled'].includes(m.replyStatus))))
    .map(m => ({
      id:m.mailId, type:'mail', title:m.replyStatus === 'waiting' ? '답변 필요' : '확인 필요',
      from:m.currentSender, at:m.t, waiting:m.replyStatus === 'waiting',
      body:home ? readMailBody(m.digest, home) : null,
    })).filter(m => m.id);
  const latest = new Map(), starts = new Map();
  for (const e of entries) {
    if (e.kind === 'start') starts.set(e.role, e.t);
    if (e.kind === 'alert') {
      const key = e.id || (e.source === 'watch-ai' ? `ai:${e.role}:${e.taskId || ''}:${e.alertKind}` : null);
      if (key) latest.set(key, e);
    }
  }
  const alerts = [...latest].filter(([,e]) => !e.resolved && !e.userSuppressed &&
    isUserActor(e.recipient) && userAlertRequired(e) &&
    !(starts.has(e.role) && Date.parse(starts.get(e.role)) > Date.parse(e.t)))
    .map(([id,e]) => ({id, type:'alert', title:e.alertKind, from:e.role || '감시기', at:e.t,
      body:e.reason || '자동으로 처리하지 못해 사용자 확인이 필요합니다. 관련 역할의 현재 상태를 확인하세요.'}));
  return [...mail, ...alerts].sort((a,b) => (Date.parse(a.at)||0) - (Date.parse(b.at)||0));
}

// 대상 역할은 요청에서 받지 않는다. 현재 원장의 사용자 수신 우편만 조작한다.
export function actOnUserMail(home, id, {text, reply = false} = {}) {
  const letter = mailboxLetters(readLedger(home)).find(m => m.mailId === id &&
    isUserActor(m.currentRecipient) && userMailRequired(m));
  if (!letter) throw new Error('사용자 확인 대상 우편이 아닙니다');
  if (reply) {
    if (letter.replyStatus !== 'waiting') throw new Error('이미 답했거나 답을 기다리지 않는 우편입니다');
    if (typeof text !== 'string' || !text.trim()) throw new Error('답변을 적어 주세요');
    return new Mailbox(home, letter.currentSender).send({
      by:letter.currentRecipient, message:text.trim(), replyTo:letter.mailId, replyFinal:true,
      workKey:letter.workKey, executionKey:letter.executionKey,
    });
  }
  if (letter.replyStatus === 'waiting') throw new Error('답변이 필요한 우편입니다. 확인으로 답변을 대신할 수 없습니다');
  return new Mailbox(home, letter.currentRecipient).acknowledge(letter.mailId, '사람');
}
