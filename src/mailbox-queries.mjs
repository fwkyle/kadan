// Why: 감시의 답변 대기/최근 우편은 같은 수집에서 준비한 현재 상태만 읽는다.
// 과거 10배에도 보관량은 답변 대기 수와 현재 역할당 12개다. 미등록 수집은 기존 해석을 유지한다.
import {mailboxLetters} from './mailbox-state.mjs';

const snapshots = new WeakMap();
const copy = letters => letters.map(letter => ({...letter, replyRecipients:[...letter.replyRecipients]}));

export function rememberMailboxQueries(entries, queries) {
  snapshots.set(entries, {length:entries.length, ...queries});
}

function snapshot(entries) {
  const value = snapshots.get(entries);
  return value?.length === entries.length ? value : null;
}

export function waitingLetters(entries, role) {
  const value = snapshot(entries);
  return value ? copy(value.waiting.filter(letter => role === undefined || letter.currentSender === role))
    : mailboxLetters(entries, role, {view:'waiting'});
}

export function recentLetters(entries, role) {
  const value = snapshot(entries)?.recent.get(role);
  return value ? copy(value) : mailboxLetters(entries)
    .filter(letter => (letter.currentRecipient || letter.role) === role ||
      (letter.currentSender || letter.by) === role).slice(-12);
}
