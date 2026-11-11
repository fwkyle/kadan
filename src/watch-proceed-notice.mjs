import {isNotificationHold} from './notification-guard.mjs';
import {proceedHint} from './decision-proceed.mjs';

// 자격이 생긴 순간의 본인 안내(완전자율). 대기 시간이 지나 추천대로 진행할 수 있게 된 결정을, 그 결정을 요청한 역할에게
// 켜짐 구간당 한 번만 따로 알린다. '놀고 있음'과 분리된 안내라 화면이 변하는 중이어도, 업무 차례 칸이 사용자여도 나간다.
// 답 대기 가림 규칙(waitingExcluder)은 건드리지 않는다. 감시기는 결정·결정 기록을 쓰지 않는다(진행은 요청한 역할이 명령으로 한다).
export const PROCEED_NOTICE_KIND = '진행자격';

// 중복 방지 키 = 결정 ID + 켜짐 구간 시작 시각. 껐다 켜면 구간 시작이 달라져 다시 간다.
export const proceedNoticeKey = (decision, ap) => `${decision.id}@${ap?.startedAt}`;

// 이미 안내한 키. 원장에 남은 안내 기록이 원본이라 감시기를 다시 켜도 다시 보내지 않는다.
// 보내기 전에 시도(attempt)를 먼저 남기므로 전송 뒤 기록이 실패해도 다시 보내지 않는다. 사람 입력으로 미룬 것(held)만 시도를 거둔다.
export function proceedNoticedKeys(entries) {
  const keys = new Set();
  for (const e of entries || []) {
    if (e?.kind === 'alert' && e.alertKind === PROCEED_NOTICE_KIND && Array.isArray(e.noticeKeys)) {
      for (const key of e.noticeKeys) e.held ? keys.delete(key) : keys.add(key);
    }
  }
  return keys;
}

const cut = (text, n) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export const proceedNoticeMessage = (decision, clock) =>
  [`[감시sh ${clock}] 답 없는 결정의 대기 시간이 지났습니다. 진행할 수 있는지 확인하세요(안내 1회).`,
    `질문: ${cut(decision.question, 100)}`, `추천: ${cut(decision.recommendation, 100)}`, proceedHint(decision)].join('\n');

// 상태는 감시기가 쥔다: state = {seeded, keys:Set}. 처음 후보가 생길 때 한 번만 이미 읽은 원장(entries)에서 채우고,
// 그 뒤에는 메모리 집합만 본다(주기마다 원장을 훑지 않는다). 후보가 없으면 아무것도 하지 않는다.
// proceedable은 주기가 이미 만든 목록(열린·진행 기록 전·자격 있음)이고 ap는 이번 주기의 Autopilot 스냅샷이다.
// 받는 쪽은 요청한 역할 하나. 관계표에 없거나 세션이 죽어 있거나 생존을 모르면 보내지 않고 기록도 남기지 않는다(다음 주기에 다시 본다).
export function runProceedNotices({proceedable, ap, parents, liveSessions, entries, state, send, record, clock, pendingHeld = []}) {
  const result = {sent: 0, held: 0, failed: 0, skipped: 0};
  if (!proceedable?.length || !ap?.startedAt || !liveSessions) return result;
  if (!state.seeded) { state.seeded = true; state.keys = proceedNoticedKeys(entries); }
  for (const rec of pendingHeld.splice(0)) {
    try { record(rec); } catch { pendingHeld.push(rec); }
  }
  for (const decision of proceedable) {
    const key = proceedNoticeKey(decision, ap), role = decision.requestedBy;
    if (state.keys.has(key)) continue;
    if (typeof role !== 'string' || !parents?.has(role) || !liveSessions.has(`kadan-${role}`)) { result.skipped++; continue; }
    const base = {
      kind: 'alert', by: 'watch', source: 'proceed-notice', alertKind: PROCEED_NOTICE_KIND, level: 'INFO',
      recipient: role, noticeKeys: [key], decisionId: decision.id, resolved: true,
    };
    try { record({...base, delivered: false, attempt: true, reason: '전달 시도'}); }
    catch { result.failed++; continue; }
    state.keys.add(key);
    try { send(role, proceedNoticeMessage(decision, clock)); result.sent++; }
    catch (error) {
      if (isNotificationHold(error)) {
        state.keys.delete(key);
        const rec = {...base, delivered: false, held: true, reason: '알림 보류'};
        try { record(rec); result.held++; } catch { pendingHeld.push(rec); result.failed++; }
        continue;
      }
      result.failed++;
      try { record({...base, delivered: false, reason: `전달 실패(${cut(error.message, 120)})`}); } catch { /* 시도 기록이 있어 다시 보내지 않는다 */ }
      continue;
    }
    try { record({...base, delivered: true}); } catch { /* 시도 기록이 있어 다시 보내지 않는다 */ }
  }
  return result;
}
