import {mailboxLetters} from './mailbox-state.mjs';
import {isUserActor,DISCORD_BY} from './actors.mjs';
import {taskIdentity} from './task-identity.mjs';
import {shellQuote} from './mail-instructions.mjs';
import {isNotificationHold} from './notification-guard.mjs';
import {isPeerSuperMail} from './peer-mail.mjs';
import {SECRETARY} from './mailbox.mjs';

const recipient = mail => mail.currentRecipient || mail.role;
// 사람 입력·대화 중이라 붙여넣기 전에 멈춘 알림. 전달하지 않았으므로 다음 순회에 다시 시도한다.
const reminderKey = (mailId, role) => JSON.stringify([mailId, role]);

// 판의 독립적인 활성 상태는 없다. 명시적으로 연결된 업무의 보류/종료만 따른다.
function eligibleLetters(entries, cards, works, now, graceMs, parents) {
  const identity = taskIdentity(cards);
  return mailboxLetters(entries).filter(mail => {
    // 발령 우편(taskId, 질문 아님)은 읽음 확인 안내가 없으니 재알림하지 않는다 — 미착수는 시작보고누락 경보가 잡는다(2026-10-05).
    // 이전 세대 앞으로 온 미확인은 같은 이름의 새 세션에게 다시 알리지 않는다(mail-generation.mjs).
    if (!mail.mailId || mail.read !== false || mail.previousGeneration === true || mail.notificationOnly === true || (mail.taskId != null && mail.expectReply !== true)
      || ['task-completion','watch-mail-reminder'].includes(mail.systemGenerated)
      || !recipient(mail) || isUserActor(recipient(mail))) return false;
    const at = Date.parse(mail.t);
    const deferredPeer = mail.transport === 'mailbox'
      && isPeerSuperMail(entries, parents, mail.currentSender, recipient(mail));
    // 디코 우편(보낸이 디코, 받는이는 비서 또는 레포 슈퍼)도 유예 0: 사람이 디코로 기다리는 질문이다. 입력 보호·우편당 1회는 그대로.
    const discordMail = mail.by === DISCORD_BY;
    // 저장만 된 우편(창에 키로 전달된 적 없음, keyDelivery 없음)은 아무도 못 본 채 5분 묻히지 않게 유예 0. 비서는 제외.
    const storedOnly = mail.transport === 'mailbox' && mail.keyDelivery == null && recipient(mail) !== SECRETARY;
    if (!Number.isFinite(at) || now - at < (deferredPeer || discordMail || storedOnly ? 0 : graceMs)) return false;
    const execution = identity.resolve(mail.taskId, mail.executionKey);
    const executionKey = execution.key || mail.executionKey;
    const related = works.filter(work => (mail.workKey && work.key === mail.workKey)
      || (executionKey && work.executions?.some(e => e.key === executionKey)));
    // 저장 전용 우편은 받는 쪽이 아직 못 본 편지다. 보낸 직후 업무가 done/cancelled로 닫혀도(완료 알림이 흔한 경우:
    // 2026-10-20 retire_ooo 246c6a15·fefff233이 닫힘 7~12초 전에 저장됐다) 알림은 한 번 나가야 한다. 일시정지(hold)만 따른다.
    return !related.some(work => work.status !== 'open' && !(storedOnly && work.status !== 'hold'));
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

  tick({entries, cards, works, now, floor, readEntries, readCards, readWorks, signal, parents}) {
    this.failed = false;
    for (const e of entries) if (e.kind === 'watch-mail-reminder' && e.mailId && e.role) {
      if (e.action === 'result' && e.held === true) this.reserved.delete(reminderKey(e.mailId, e.role));
      else this.reserved.add(reminderKey(e.mailId, e.role));
    }
    const groups = new Map();
    for (const mail of eligibleLetters(entries,cards,works,now,this.graceMs,parents)) {
      const role = recipient(mail);
      if (this.reserved.has(reminderKey(mail.mailId,role))) continue;
      if (!groups.has(role)) groups.set(role, []);
      groups.get(role).push(mail.mailId);
    }
    const delivered = new Set();
    // 대상 고르기용 세션 목록은 주기당 한 번만 읽는다. 2026-10-01 실측: 미확인 우편이 남은 수신자 128명(살아 있는
    // 세션 0명)마다 tmux 목록을 다시 읽어 우편 단계가 4~6초 걸렸다. 전송 직전 확인은 아래에서 계속 새로 읽는다.
    const live = groups.size ? floor.list() : [];
    for (const [role, ids] of groups) {
      if (signal?.aborted) break;
      const expectedPid = currentPid(role,entries,live);
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
        const unread = new Set(eligibleLetters(fresh,currentCards,currentWorks,now,this.graceMs,parents)
          .filter(mail => recipient(mail) === role).map(mail => mail.mailId));
        pending = ids.filter(id => unread.has(id));
        if (!signal?.aborted && String(currentPid(role,fresh,live)) === String(expectedPid) && pending.length) {
          attempted = true;
          this.send(role,`[미확인 우편] ${pending.length}건이 남아 있습니다. kadan inbox --role ${shellQuote(role)} --unread로 확인하고 내용을 읽은 우편만 직접 ack하세요. 질문의 최종 답변은 읽음 확인과 별개입니다.`,expectedPid);
          delivery = 'sent'; reason = null; delivered.add(role);
        }
      } catch (error) {
        // 확인과 붙여넣기 사이에 사람이 입력을 시작한 경우. 붙여넣기 전 멈췄으므로 예약을 풀고 다음 순회에 다시 본다.
        if (isNotificationHold(error)) {
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
