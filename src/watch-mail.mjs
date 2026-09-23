import {mailboxLetters} from './mailbox-state.mjs';
import {isUserActor} from './actors.mjs';
import {taskIdentity} from './task-identity.mjs';
import {shellQuote} from './mail-instructions.mjs';

const recipient = mail => mail.currentRecipient || mail.role;
// 사람 입력·대화 중이라 붙여넣기 전에 멈춘 알림. 전달하지 않았으므로 다음 순회에 다시 시도한다.
const HOLD_CODES = new Set(['KADAN_HUMAN_ACTIVE','KADAN_HUMAN_ACTIVITY_UNKNOWN','KADAN_PANE_INPUT_PENDING','KADAN_PANE_INPUT_UNKNOWN','KADAN_PANE_STATE_UNKNOWN']);
const reminderKey = (mailId, role) => JSON.stringify([mailId, role]);

// 판의 독립적인 활성 상태는 없다. 명시적으로 연결된 업무의 보류/종료만 따른다.
function eligibleLetters(entries, cards, works, now, graceMs) {
  const identity = taskIdentity(cards);
  return mailboxLetters(entries).filter(mail => {
    if (!mail.mailId || mail.read !== false || mail.notificationOnly === true
      || ['task-completion','watch-mail-reminder'].includes(mail.systemGenerated)
      || !recipient(mail) || isUserActor(recipient(mail))) return false;
    const at = Date.parse(mail.t);
    if (!Number.isFinite(at) || now - at < graceMs) return false;
    const execution = identity.resolve(mail.taskId, mail.executionKey);
    const executionKey = execution.key || mail.executionKey;
    const related = works.filter(work => (mail.workKey && work.key === mail.workKey)
      || (executionKey && work.executions?.some(e => e.key === executionKey)));
    return !related.some(work => work.status !== 'open');
  });
}

function currentPid(role, entries, live) {
  const session = `kadan-${role}`;
  const event = entries.findLast(e => ['start','stop'].includes(e.kind)
    && (e.session === session || e.role === role));
  if (event?.kind !== 'start') return null;
  const expected = event.panePid ?? event.rottiePid;
  const seen = live.find(e => e.session === session && e.alive !== false);
  return expected != null && seen?.pid != null && String(expected) === String(seen.pid) ? expected : null;
}

export class MailWatch {
  constructor({record, send, hold = null, graceMs = 300_000}) {
    if (!Number.isFinite(graceMs) || graceMs < 0) throw new Error('우편 유예 시간은 0 이상이어야 합니다');
    Object.assign(this, {record, send, hold, graceMs});
    this.reserved = new Set();
    this.heldLogged = new Map();
  }

  tick({entries, cards, works, now, floor, readEntries, readCards, readWorks, signal}) {
    this.failed = false;
    for (const e of entries) if (e.kind === 'watch-mail-reminder' && e.mailId && e.role) {
      if (e.action === 'result' && e.held === true) this.reserved.delete(reminderKey(e.mailId, e.role));
      else this.reserved.add(reminderKey(e.mailId, e.role));
    }
    const groups = new Map();
    for (const mail of eligibleLetters(entries,cards,works,now,this.graceMs)) {
      const role = recipient(mail);
      if (this.reserved.has(reminderKey(mail.mailId,role))) continue;
      if (!groups.has(role)) groups.set(role, []);
      groups.get(role).push(mail.mailId);
    }
    const delivered = new Set();
    for (const [role, ids] of groups) {
      if (signal?.aborted) break;
      const expectedPid = currentPid(role,entries,floor.list());
      if (expectedPid == null) continue;
      // 예약 기록 전에 사람 입력·대화 여부를 본다. 같은 보류는 한 번만 기록한다.
      const held = this.hold?.(role);
      if (held) {
        const key = JSON.stringify([held.code, ids]);
        if (this.heldLogged.get(role) !== key) {
          this.heldLogged.set(role, key);
          this.record({kind:'watch-mail-held',by:'watch',role,mailIds:ids,expectedPid,code:held.code,reason:held.message,t:new Date(now).toISOString()});
        }
        continue;
      }
      this.heldLogged.delete(role);
      const emit = (mailId, action, details = {}) => this.record({kind:'watch-mail-reminder',by:'watch',
        role,mailId,expectedPid,action,t:new Date(now).toISOString(),...details});
      // 예약 실패/중단/전달 불명확은 재전송하지 않는다. 후임 수신자는 별도 예약이다.
      for (const id of ids) {
        this.reserved.add(reminderKey(id,role));
        emit(id,'reserved');
      }
      let pending = [], attempted = false;
      let delivery = 'not-sent', reason = 'state-changed';
      try {
        const currentCards = readCards(), currentWorks = readWorks(), live = floor.list();
        // 마지막 전달 직전 원장을 다시 읽는다. 예약 중 들어온 ack도 여기서 제외한다.
        const fresh = readEntries();
        const unread = new Set(eligibleLetters(fresh,currentCards,currentWorks,now,this.graceMs)
          .filter(mail => recipient(mail) === role).map(mail => mail.mailId));
        pending = ids.filter(id => unread.has(id));
        if (!signal?.aborted && String(currentPid(role,fresh,live)) === String(expectedPid) && pending.length) {
          attempted = true;
          this.send(role,`[미확인 우편] ${pending.length}건이 남아 있습니다. kadan inbox --role ${shellQuote(role)} --unread로 확인하고 내용을 읽은 우편만 직접 ack하세요. 질문의 최종 답변은 읽음 확인과 별개입니다.`,expectedPid);
          delivery = 'sent'; reason = null; delivered.add(role);
        }
      } catch (error) {
        // 확인과 붙여넣기 사이에 사람이 입력을 시작한 경우. 붙여넣기 전 멈췄으므로 예약을 풀고 다음 순회에 다시 본다.
        if (error.delivery === 'not-sent' && HOLD_CODES.has(error.code)) {
          for (const id of ids) {
            this.reserved.delete(reminderKey(id,role));
            emit(id,'result',{delivery:'not-sent',reason:error.message,held:true});
          }
          continue;
        }
        this.failed = true;
        delivery = !attempted || error.delivery === 'not-sent' ? 'not-sent'
          : error.delivery === 'sent' ? 'sent' : 'unknown';
        if (delivery === 'sent') delivered.add(role);
        reason = error.message;
        if (!pending.length) pending = ids;
      }
      for (const id of ids) emit(id,'result',pending.includes(id)
        ? {delivery,reason} : {delivery:'not-sent',reason:'state-changed'});
    }
    return delivered;
  }
}
