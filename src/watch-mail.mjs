import {mailboxLetters} from './mailbox-state.mjs';
import {isUserActor,DISCORD_BY} from './actors.mjs';
import {taskIdentity} from './task-identity.mjs';
import {unreadMailMessage,escalationNotice} from './watch-notice-format.mjs';
import {readMailBody,ledgerHome} from './ledger.mjs';
import {isNotificationHold} from './notification-guard.mjs';
import {isPeerSuperMail} from './peer-mail.mjs';
import {SECRETARY} from './mailbox.mjs';
import {isSimplifiedMail,deliveredAt,firstReminderSent,reminderKey} from './mail-rule.mjs';
import {createProcessCollections} from './process-collections.mjs';
import {stripStoredHeader} from './mail-header.mjs';

const recipient = mail => mail.currentRecipient || mail.role;

// 세 번째 단계 escalate: 수신자에게 두 번 알린 뒤에도 안 읽힌 우편을 수신자의 직속 상위에게 한 번 알린다(2026-10-21 [kyle] 승인).
// 기록의 role은 우편 수신자이고 알림을 받는 상위는 to 칸에 쓴다. 평생 1회·재시작 복원·압축은 initial·followup과 같은 장치를 쓴다.
export const ESCALATE_AFTER_MS = 15 * 60_000;
export const ESCALATE_LIST_MAX = 5;
export const PARENT_UNAVAILABLE = 'PARENT_UNAVAILABLE';
const escalateTarget = (parents, role) => {
  const to = parents?.get(role);
  return !to || isUserActor(to) || to === SECRETARY ? null : to;
};
// 'unread': followup sent 뒤 15분 동안 ack 없음. 'unknown': 재알림 결과 불명(다음 순회에 바로). 이미 sent·unknown이면 영구 예약이다.
function escalateKind(stages, now) {
  if (['sent', 'unknown'].includes(stages?.escalate?.result)) return null;
  if (stages?.initial?.result === 'unknown' || stages?.followup?.result === 'unknown') return 'unknown';
  const sentAt = stages?.followup?.result === 'sent' ? Date.parse(stages.followup.t) : NaN;
  return Number.isFinite(sentAt) && now - sentAt >= ESCALATE_AFTER_MS ? 'unread' : null;
}

// 상위 한 명에게 가는 한 통. 우편마다 항목 이름을 붙인 블록이고 값은 모두 원장에서 온다(watch-notice-format.mjs).
export const escalationMessage = items => escalationNotice(items, previewOf);
// 첫 줄 글감: 일반 전송은 원장 preview가 있고, 우편함(mailbox) 우편은 preview 없이 본문 파일(digest)이 있다. 못 읽으면 빈 글(= 미리보기 없음).
function previewOf(mail) {
  if (mail.preview) return mail.preview;
  try {
    return mail.digest ? stripStoredHeader(readMailBody(mail.digest, ledgerHome()), mail) ?? '' : '';
  } catch { return ''; }
}

// 새 규칙 우편의 실패 사유는 원장에 고정 값만 쓴다. 오류 문장에는 tmux 버퍼 이름(PID·시각)·명령 인자처럼 매번 달라지는 말이 섞여
// 같은 원인이 '사유 변경'으로 보여 압축이 새고 원장이 순회 수만큼 는다(2026-10-21 재검수 R2-F1). 코드가 없으면 'send-failed' 하나다.
export const FAILURE_FALLBACK = 'send-failed';
const failureCode = error => /^[A-Z][A-Z0-9_]*$/.test(String(error?.code ?? '')) ? error.code : FAILURE_FALLBACK;

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
function eligibleLetters(entries, cards, works, now, graceMs, parents, letters = mailboxLetters(entries)) {
  const identity = taskIdentity(cards);
  const history = reminderHistory(entries);
  const firstSent = firstReminderSent(entries);
  const out = [];
  for (const mail of letters) {
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
      const stages = history.get(reminderKey(mail.mailId, recipient(mail)));
      const delivered = deliveredAt(mail, recipient(mail), firstSent);
      const stage = simplifiedStage(stages, delivered, now, graceMs);
      if (!stage) {
        // 상위 알림도 연결 업무가 open일 때만(done·cancelled·hold 제외). 연결 업무가 없으면 알린다.
        const to = escalateTarget(parents, recipient(mail)), kind = to && escalateKind(stages, now);
        if (kind && !related.some(work => work.status !== 'open')) {
          out.push({mail, stage: 'escalate', to, kind, minutes: Number.isFinite(delivered) ? Math.floor((now - delivered) / 60_000) : null});
        }
        continue;
      }
      // 첫 알림은 연결 업무 상태(hold·done·cancelled)와 무관하게 낸다. 받는 쪽이 아직 못 본 편지이고 hold는 보낸 쪽 업무의
      // 상태다(2026-10-27: hold 아래 승인 질문이 3시간 묻힘). 안내는 우편당 1번뿐이라 소음이 작다.
      // 넣은 뒤 5분 알림은 open이 아닌 업무면 생략한다.
      const blocked = stage === 'initial' ? false : related.some(work => work.status !== 'open');
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
  constructor({record, send, hold = null, graceMs = 300_000, collections = null, readLetters = null}) {
    if (!Number.isFinite(graceMs) || graceMs < 0) throw new Error('우편 유예 시간은 0 이상이어야 합니다');
    Object.assign(this, {record, send, hold, graceMs, readLetters});
    this.collections = collections ?? createProcessCollections();
    this.ownsCollections = !collections;
    this.reserved = this.collections.set();
    // 새 규칙 우편 중 이 프로세스가 실제로 보낸(sent·unknown) 단계. 결과 기록이 실패해도 같은 프로세스가 다시 보내지 않게 한다.
    this.attempted = this.collections.set();
    this.heldLogged = this.collections.map();
    // 새 규칙 우편은 원장에 상태가 바뀔 때만 쓴다(원장은 지울 수 없어 같은 사유 재시도를 매 순회 쌓으면 100통·8시간에 96,000줄).
    // written: 이 프로세스가 마지막으로 쓴 상태(우편·역할·단계별), 없으면 원장 기록을 쓴다. suppressed: 쓰지 않고 센 같은 사유 재시도 수.
    // 프로세스 수명만 보관한다: 재시작하면 원장의 첫 실패·미전달 판정으로 이어가고 같은 사유는 다시 쓰지 않는다.
    this.written = this.collections.map();
    this.suppressed = this.collections.map();
  }

  close() {if (this.ownsCollections) this.collections.close();}

  tick({entries, cards, works, now, floor, readEntries, readCards, readWorks, signal, parents}) {
    this.failed = false;
    for (const e of entries) if (e.kind === 'watch-mail-reminder' && e.mailId && e.role && e.stage !== 'escalate') {
      if (e.action === 'result' && e.held === true) this.reserved.delete(reminderKey(e.mailId, e.role));
      else this.reserved.add(reminderKey(e.mailId, e.role));
    }
    const stageKey = (mailId, role, stage) => `${reminderKey(mailId, role)}|${stage}`;
    const ledgerState = reminderHistory(entries);
    const lastState = (mailId, role, stage) => this.written.get(stageKey(mailId, role, stage)) ?? ledgerState.get(reminderKey(mailId, role))?.[stage];
    // 받는 쪽(target)별 묶음. 수신자 앞 알림은 수신자별, escalate는 수신자의 직속 상위별이다(같은 상위에게 가는 것은 한 통).
    const groups = new Map(), escalations = new Map();
    for (const {mail, stage, to} of eligibleLetters(entries,cards,works,now,this.graceMs,parents,
      this.readLetters?.(entries))) {
      const role = recipient(mail), escalate = stage === 'escalate';
      if (stage === 'legacy' ? this.reserved.has(reminderKey(mail.mailId,role)) : this.attempted.has(stageKey(mail.mailId,role,stage))) continue;
      const bucket = escalate ? escalations : groups, target = escalate ? to : role;
      if (!bucket.has(target)) bucket.set(target, []);
      bucket.get(target).push({id: mail.mailId, stage, role});
    }
    const delivered = new Set();
    // 대상 고르기용 세션 목록은 주기당 한 번만 읽는다. 2026-10-01 실측: 미확인 우편이 남은 수신자 128명(살아 있는
    // 세션 0명)마다 tmux 목록을 다시 읽어 우편 단계가 4~6초 걸렸다. 전송 직전 확인은 아래에서 계속 새로 읽는다.
    const live = groups.size || escalations.size ? floor.list() : [];
    const targets = [...groups].map(([target, items]) => ({target, items, escalate: false}))
      .concat([...escalations].map(([target, items]) => ({target, items, escalate: true})));
    for (const {target, items, escalate} of targets) {
      if (signal?.aborted) break;
      const expectedPid = currentPid(target,entries,live);
      // 수신자는 세션이 없으면 조용히 건너뛴다. 상위는 알려야 할 일이 있으니 not-sent로 남기고(압축된 재시도) 살아나면 보낸다.
      const parentGone = escalate && expectedPid == null;
      if (expectedPid == null && !escalate) continue;
      const ids = items.map(item => item.id), stageOf = new Map(items.map(item => [item.id, item.stage])), roleOf = new Map(items.map(item => [item.id, item.role]));
      // 예약 기록 전에 사람 입력·대화 여부를 본다(escalate는 상위의 입력 보호). 같은 보류는 한 번만 기록한다.
      const held = parentGone ? null : this.hold?.(target), heldKey = escalate ? `escalate:${target}` : target;
      if (held) {
        const key = JSON.stringify([held.code, ids]);
        if (this.heldLogged.get(heldKey) !== key) {
          this.heldLogged.set(heldKey, key);
          this.record({kind:'watch-mail-held',by:'watch',role:target,mailIds:ids,expectedPid,code:held.code,reason:held.message,t:new Date(now).toISOString()});
        }
        continue;
      }
      this.heldLogged.delete(heldKey);
      const emit = (mailId, action, details = {}) => this.record({kind:'watch-mail-reminder',by:'watch',
        role:roleOf.get(mailId),mailId,expectedPid,action,t:new Date(now).toISOString(),
        ...(stageOf.get(mailId) !== 'legacy' ? {stage: stageOf.get(mailId)} : {}),...(escalate ? {to: target} : {}),...details});
      // 옛 규칙 우편: 예약 실패/중단/전달 불명확은 재전송하지 않는다. 후임 수신자는 별도 예약이다.
      // 새 규칙 우편: 못 넣은 결과(not-sent)와 result 없는 예약은 다음 순회에 다시 시도하고, sent·unknown만 영구 예약이다.
      // 새 규칙 우편은 그 단계의 첫 시도 때만 예약을 쓴다. 중간에 죽어 결과가 없으면 다음 순회에 다시 시도한다(알림은 inbox 확인 안내뿐).
      for (const id of ids) {
        const stage = stageOf.get(id), role = roleOf.get(id);
        if (stage === 'legacy') { this.reserved.add(reminderKey(id,role)); emit(id,'reserved'); continue; }
        if (lastState(id,role,stage) !== undefined) continue;
        emit(id,'reserved');
        this.written.set(stageKey(id,role,stage),{result:null});
      }
      let pending = [], attempted = false;
      let delivery = 'not-sent', reason = 'state-changed', code = 'state-changed', heldHit = false;
      if (parentGone) { pending = ids; reason = code = PARENT_UNAVAILABLE; }
      else try {
        const currentCards = readCards(), currentWorks = readWorks(), live = floor.list();
        // 마지막 전달 직전 원장을 다시 읽는다. 예약 중 들어온 ack도 여기서 제외한다.
        const fresh = readEntries();
        const unreadItems = eligibleLetters(fresh,currentCards,currentWorks,now,this.graceMs,parents,
          this.readLetters?.(fresh))
          .filter(({mail, stage, to}) => roleOf.get(mail.mailId) === recipient(mail) && stageOf.get(mail.mailId) === stage && (!escalate || to === target));
        const unread = new Set(unreadItems.map(({mail}) => mail.mailId));
        pending = ids.filter(id => unread.has(id));
        if (!signal?.aborted && String(currentPid(target,fresh,live)) === String(expectedPid) && pending.length) {
          attempted = true;
          const pendingIds = new Set(pending);
          this.send(target,escalate ? escalationMessage(unreadItems)
            : unreadMailMessage(unreadItems.filter(({mail}) => pendingIds.has(mail.mailId)).map(({mail}) => mail),target,previewOf),expectedPid);
          delivery = 'sent'; reason = null; code = null; delivered.add(target);
        }
      } catch (error) {
        // 확인과 붙여넣기 사이에 사람이 입력을 시작한 경우. 붙여넣기 전 멈췄으므로 예약을 풀고 다음 순회에 다시 본다.
        // 결과 기록은 아래 공통 압축을 지난다(같은 고정 코드면 다시 쓰지 않는다).
        heldHit = isNotificationHold(error);
        if (heldHit && !escalate) for (const id of ids) this.reserved.delete(reminderKey(id,target));
        else if (!heldHit) this.failed = true;
        delivery = heldHit || !attempted || error.delivery === 'not-sent' ? 'not-sent'
          : error.delivery === 'sent' ? 'sent' : 'unknown';
        if (delivery === 'sent') delivered.add(target);
        reason = error.message; code = failureCode(error);
        if (heldHit || !pending.length) pending = ids;
      }
      if (['sent','unknown'].includes(delivery)) for (const id of pending) {
        if (stageOf.get(id) !== 'legacy') this.attempted.add(stageKey(id,roleOf.get(id),stageOf.get(id)));
      }
      for (const id of ids) {
        const stage = stageOf.get(id), role = roleOf.get(id), key = stageKey(id,role,stage);
        // 옛 규칙 우편의 기록 모양은 그대로(오류 문장), 새 규칙 우편만 고정 코드를 쓴다.
        const outcome = pending.includes(id)
          ? {delivery,reason:stage === 'legacy' ? reason : code,...(heldHit ? {held:true} : {}),
            ...(delivery === 'unknown' ? {needsCheck:true} : {})} : {delivery:'not-sent',reason:'state-changed'};
        if (stage !== 'legacy') {
          // 같은 우편·역할·단계에서 같은 고정 사유의 not-sent 재시도는 쓰지 않고 센다(입력 보호 held 포함). 첫 실패·사유 변경·sent·unknown만 쓴다.
          const prior = lastState(id,role,stage);
          if (outcome.delivery === 'not-sent' && prior?.result === 'not-sent' && prior.reason === outcome.reason && (prior.held === true) === (outcome.held === true)) {
            this.suppressed.set(key,(this.suppressed.get(key) ?? 0) + 1);
            continue;
          }
          if (this.suppressed.has(key)) { outcome.suppressedRetries = this.suppressed.get(key); this.suppressed.delete(key); }
          this.written.set(key,{result:outcome.delivery,reason:outcome.reason,held:outcome.held === true});
        }
        emit(id,'result',outcome);
      }
    }
    return delivered;
  }
}
