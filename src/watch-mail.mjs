import {mailboxLetters} from './mailbox-state.mjs';
import {isUserActor,DISCORD_BY} from './actors.mjs';
import {taskIdentity} from './task-identity.mjs';
import {shellQuote} from './mail-instructions.mjs';
import {isNotificationHold} from './notification-guard.mjs';
import {isPeerSuperMail} from './peer-mail.mjs';
import {SECRETARY} from './mailbox.mjs';
import {isSimplifiedMail,deliveredAt,firstReminderSent,reminderKey} from './mail-rule.mjs';

const recipient = mail => mail.currentRecipient || mail.role;

// 새 규칙 우편의 알림 기록: 우편·수신자별로 단계(initial=한 번도 못 넣음, followup=넣은 뒤 5분)의 마지막 사건을 본다.
// result 없이 reserved만 있으면(재시작 전에 죽음) 예약으로 보지 않고 다시 시도한다. held는 not-sent와 같다.
function reminderHistory(entries) {
  const history = new Map();
  for (const e of entries) {
    if (e.kind !== 'watch-mail-reminder' || !e.mailId || !e.role) continue;
    const key = reminderKey(e.mailId, e.role);
    const stages = history.get(key) ?? {};
    history.set(key, stages);
    const stage = e.stage ?? 'initial';
    if (e.action === 'reserved') stages[stage] = {result: null};
    else if (e.action === 'result') stages[stage] = {result: e.held === true ? 'not-sent' : e.delivery, t: e.t, reason: e.reason, held: e.held === true};
  }
  return history;
}

// 새 규칙 우편의 지금 단계. null이면 알리지 않는다. 넣은 시각은 mail-rule의 deliveredAt 하나만 쓴다.
//  - 한 번도 못 넣음: 매 순회(유예 0). 결과가 unknown이면 영구 예약(재시도 금지, 확인 필요).
//  - 넣음: 넣은 시각 + graceMs에 1회, 그 뒤 영구 예약.
function simplifiedStage(stages, delivered, now, graceMs) {
  if (delivered == null) return stages?.initial?.result === 'unknown' ? null : 'initial';
  if (['sent', 'unknown'].includes(stages?.followup?.result)) return null;
  return Number.isFinite(delivered) && now - delivered >= graceMs ? 'followup' : null;
}

// 판의 독립적인 활성 상태는 없다. 명시적으로 연결된 업무의 보류/종료만 따른다.
function eligibleLetters(entries, cards, works, now, graceMs, parents) {
  const identity = taskIdentity(cards);
  const history = reminderHistory(entries);
  const firstSent = firstReminderSent(entries);
  const out = [];
  for (const mail of mailboxLetters(entries)) {
    // 발령 우편(taskId, 질문 아님)은 읽음 확인 안내가 없으니 재알림하지 않는다 — 미착수는 시작보고누락 경보가 잡는다(2026-10-05).
    // 이전 세대 앞으로 온 미확인은 같은 이름의 새 세션에게 다시 알리지 않는다(mail-generation.mjs).
    // 단, 키로 한 번도 못 넣고 저장된 새 우편은 mailbox-state가 이전 세대로 세지 않는다.
    if (!mail.mailId || mail.read !== false || mail.previousGeneration === true || mail.notificationOnly === true || (mail.taskId != null && mail.expectReply !== true)
      || ['task-completion','watch-mail-reminder'].includes(mail.systemGenerated)
      || !recipient(mail) || isUserActor(recipient(mail))) continue;
    const at = Date.parse(mail.t);
    if (!Number.isFinite(at)) continue;
    const execution = identity.resolve(mail.taskId, mail.executionKey);
    const executionKey = execution.key || mail.executionKey;
    const related = works.filter(work => (mail.workKey && work.key === mail.workKey)
      || (executionKey && work.executions?.some(e => e.key === executionKey)));
    // 새 규칙(우편 표지 mailRule이 있는 우편, 비서 앞 제외): 출처별 유예 분기 없이 상태표 하나로 간다.
    if (isSimplifiedMail(mail) && recipient(mail) !== SECRETARY) {
      const stage = simplifiedStage(history.get(reminderKey(mail.mailId, recipient(mail))),
        deliveredAt(mail, recipient(mail), firstSent), now, graceMs);
      if (!stage) continue;
      // 첫 알림은 업무가 done/cancelled여도 낸다(받는 쪽이 아직 못 본 편지). 일시정지(hold)는 제외한다.
      // 넣은 뒤 5분 알림은 닫힌 업무면 생략한다.
      const blocked = stage === 'initial' ? related.some(work => work.status === 'hold') : related.some(work => work.status !== 'open');
      if (!blocked) out.push({mail, stage});
      continue;
    }
    // 옛 규칙(표지 없는 옛 우편, 비서 앞 우편): 지금 동작 그대로.
    const deferredPeer = mail.transport === 'mailbox'
      && isPeerSuperMail(entries, parents, mail.currentSender, recipient(mail));
    // 디코 우편(보낸이 디코, 받는이는 비서 또는 레포 슈퍼)도 유예 0: 사람이 디코로 기다리는 질문이다. 입력 보호·우편당 1회는 그대로.
    const discordMail = mail.by === DISCORD_BY;
    // 저장만 된 우편(창에 키로 전달된 적 없음, keyDelivery 없음)은 아무도 못 본 채 5분 묻히지 않게 유예 0. 비서는 제외.
    const storedOnly = mail.transport === 'mailbox' && mail.keyDelivery == null && recipient(mail) !== SECRETARY;
    if (now - at < (deferredPeer || discordMail || storedOnly ? 0 : graceMs)) continue;
    // 저장 전용 우편은 받는 쪽이 아직 못 본 편지다. 보낸 직후 업무가 done/cancelled로 닫혀도(완료 알림이 흔한 경우:
    // 2026-10-20 retire_ooo 246c6a15·fefff233이 닫힘 7~12초 전에 저장됐다) 알림은 한 번 나가야 한다. 일시정지(hold)와 슈퍼끼리 peer 우편은 기존대로 닫힌 업무를 따른다.
    if (!related.some(work => work.status !== 'open' && !(storedOnly && !deferredPeer && work.status !== 'hold'))) out.push({mail, stage: 'legacy'});
  }
  return out;
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
    // 새 규칙 우편 중 이 프로세스가 실제로 보낸(sent·unknown) 단계. 결과 기록이 실패해도 같은 프로세스가 다시 보내지 않게 한다.
    this.attempted = new Set();
    this.heldLogged = new Map();
    // 새 규칙 우편은 원장에 상태가 바뀔 때만 쓴다(원장은 지울 수 없어 같은 사유 재시도를 매 순회 쌓으면 100통·8시간에 96,000줄).
    // written: 이 프로세스가 마지막으로 쓴 상태(우편·역할·단계별), 없으면 원장 기록을 쓴다. suppressed: 쓰지 않고 센 같은 사유 재시도 수.
    // 상태 파일은 두지 않는다: 재시작하면 원장의 첫 실패·미전달 판정만으로 재시도가 이어지고, 같은 사유는 다시 쓰지 않는다.
    this.written = new Map();
    this.suppressed = new Map();
  }

  tick({entries, cards, works, now, floor, readEntries, readCards, readWorks, signal, parents}) {
    this.failed = false;
    for (const e of entries) if (e.kind === 'watch-mail-reminder' && e.mailId && e.role) {
      if (e.action === 'result' && e.held === true) this.reserved.delete(reminderKey(e.mailId, e.role));
      else this.reserved.add(reminderKey(e.mailId, e.role));
    }
    const stageKey = (mailId, role, stage) => `${reminderKey(mailId, role)}|${stage}`;
    const ledgerState = reminderHistory(entries);
    const lastState = (mailId, role, stage) => this.written.get(stageKey(mailId, role, stage)) ?? ledgerState.get(reminderKey(mailId, role))?.[stage];
    const groups = new Map();
    for (const {mail, stage} of eligibleLetters(entries,cards,works,now,this.graceMs,parents)) {
      const role = recipient(mail);
      if (stage === 'legacy' ? this.reserved.has(reminderKey(mail.mailId,role)) : this.attempted.has(stageKey(mail.mailId,role,stage))) continue;
      if (!groups.has(role)) groups.set(role, []);
      groups.get(role).push({id: mail.mailId, stage});
    }
    const delivered = new Set();
    // 대상 고르기용 세션 목록은 주기당 한 번만 읽는다. 2026-10-01 실측: 미확인 우편이 남은 수신자 128명(살아 있는
    // 세션 0명)마다 tmux 목록을 다시 읽어 우편 단계가 4~6초 걸렸다. 전송 직전 확인은 아래에서 계속 새로 읽는다.
    const live = groups.size ? floor.list() : [];
    for (const [role, items] of groups) {
      if (signal?.aborted) break;
      const expectedPid = currentPid(role,entries,live);
      if (expectedPid == null) continue;
      const ids = items.map(item => item.id), stageOf = new Map(items.map(item => [item.id, item.stage]));
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
        role,mailId,expectedPid,action,t:new Date(now).toISOString(),
        ...(stageOf.get(mailId) !== 'legacy' ? {stage: stageOf.get(mailId)} : {}),...details});
      // 옛 규칙 우편: 예약 실패/중단/전달 불명확은 재전송하지 않는다. 후임 수신자는 별도 예약이다.
      // 새 규칙 우편: 못 넣은 결과(not-sent)와 result 없는 예약은 다음 순회에 다시 시도하고, sent·unknown만 영구 예약이다.
      // 새 규칙 우편은 그 단계의 첫 시도 때만 예약을 쓴다. 중간에 죽어 결과가 없으면 다음 순회에 다시 시도한다(알림은 inbox 확인 안내뿐).
      for (const id of ids) {
        const stage = stageOf.get(id);
        if (stage === 'legacy') { this.reserved.add(reminderKey(id,role)); emit(id,'reserved'); continue; }
        if (lastState(id,role,stage) !== undefined) continue;
        emit(id,'reserved');
        this.written.set(stageKey(id,role,stage),{result:null});
      }
      let pending = [], attempted = false;
      let delivery = 'not-sent', reason = 'state-changed';
      try {
        const currentCards = readCards(), currentWorks = readWorks(), live = floor.list();
        // 마지막 전달 직전 원장을 다시 읽는다. 예약 중 들어온 ack도 여기서 제외한다.
        const fresh = readEntries();
        const unread = new Set(eligibleLetters(fresh,currentCards,currentWorks,now,this.graceMs,parents)
          .filter(({mail, stage}) => recipient(mail) === role && stageOf.get(mail.mailId) === stage).map(({mail}) => mail.mailId));
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
            if (stageOf.get(id) !== 'legacy') this.written.set(stageKey(id,role,stageOf.get(id)),{result:'not-sent',reason:error.message,held:true});
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
      if (['sent','unknown'].includes(delivery)) for (const id of pending) {
        if (stageOf.get(id) !== 'legacy') this.attempted.add(stageKey(id,role,stageOf.get(id)));
      }
      for (const id of ids) {
        const outcome = pending.includes(id)
          ? {delivery,reason,...(delivery === 'unknown' ? {needsCheck:true} : {})} : {delivery:'not-sent',reason:'state-changed'};
        const stage = stageOf.get(id), key = stageKey(id,role,stage);
        if (stage !== 'legacy') {
          // 같은 우편·역할·단계에서 같은 사유의 not-sent 재시도는 쓰지 않고 센다. 첫 실패·사유 변경·sent·unknown만 쓴다.
          const prior = lastState(id,role,stage);
          if (outcome.delivery === 'not-sent' && prior?.result === 'not-sent' && prior.held !== true && prior.reason === outcome.reason) {
            this.suppressed.set(key,(this.suppressed.get(key) ?? 0) + 1);
            continue;
          }
          if (this.suppressed.has(key)) { outcome.suppressedRetries = this.suppressed.get(key); this.suppressed.delete(key); }
          this.written.set(key,{result:outcome.delivery,reason:outcome.reason,held:false});
        }
        emit(id,'result',outcome);
      }
    }
    return delivered;
  }
}
