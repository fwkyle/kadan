import {buildCardCenter, liveSessionTree} from './card-center.mjs';
import {isNotificationHold} from './notification-guard.mjs';

// 오래된 미확정 재안내(2026-10-19). 역할이 다음 일로 넘어갔거나 같은 업무에 뒤 라운드가 생겼는데
// 결과가 확정되지 않은 실행을, 발령한 감독에게 실행당 평생 1회 알려 판정을 받는다.
// 감시기는 실행 상태를 바꾸지 않는다. 판정(done·대체·취소)은 받은 감독이 한다.
export const STALE_NOTICE_KIND = '오래된미확정';
export const STALE_NOTICE_LIMIT = 20;
export const STALE_NOTICE_EVERY_MS = 10 * 60_000;

// 결과가 확정되지 않았거나(unconfirmed·orphaned) 실패로 남아 확인 필요인 실행만 본다. 끝난 실행·보류는 제 칸에 둔다.
const PENDING = new Set(['unconfirmed', 'orphaned', 'failed']);

// 이미 안내한 실행 키. 원장에 남은 안내 기록이 원본이라 감시기를 다시 켜도 다시 보내지 않는다.
// 보내기 전에 시도(attempt)를 먼저 남기므로, 전송 뒤 기록이 실패해도 다시 보내지 않는다.
// 사람 입력 때문에 아예 안 보낸 것만 held 기록으로 시도를 거둬 다음 훑기에 다시 시도한다.
export function noticedKeys(entries) {
  const keys = new Set();
  for (const e of entries || []) {
    if (e?.kind === 'alert' && e.alertKind === STALE_NOTICE_KIND && Array.isArray(e.executionKeys)) {
      for (const key of e.executionKeys) e.held ? keys.delete(key) : keys.add(key);
    }
  }
  return keys;
}

// 받는 쪽: 그 실행을 발령한 감독(마지막 발령 사건의 by). 모르면 업무 owner. 그래도 모르면 null.
export function noticeRecipient(card, works) {
  const run = (card.runs ?? []).filter(r => r.role === card.role).at(-1);
  const by = typeof run?.by === 'string' ? run.by.trim() : '';
  if (by && by !== '모름') return by;
  const owner = (works ?? []).find(w => (w.executions ?? []).some(x => x.key === card.key))?.owner;
  return owner || null;
}

// liveSessions: 감시기가 이번 훑기에 관찰한 살아 있는 역할 세션(kadan-<역할>). 대시보드와 같은 생존 근거다.
// null이면 생존을 모르는 것으로 보고 세션 소실(orphaned)은 판정하지 않는다(확실하지 않으면 보내지 않는다).
export function planStaleNotices({cards, entries, works = [], now = Date.now(), liveSessions = null}) {
  const known = liveSessions != null;
  const tree = liveSessionTree(cards, liveSessions);
  const center = buildCardCenter({
    cards: cards.map(c => ({...c, history: c.history ?? []})), entries, tree, runtimeKnown: known, now,
  }).cards;
  const done = noticedKeys(entries);
  const groups = new Map();
  for (const card of center) {
    if (card.workType === 'coordination' || !card.movedOn || !PENDING.has(card.displayState) || done.has(card.key)) continue;
    const recipient = noticeRecipient(card, works);
    if (!groups.has(recipient)) groups.set(recipient, []);
    groups.get(recipient).push(card);
  }
  return [...groups].map(([recipient, list]) => ({
    recipient,
    keys: list.map(c => c.key),
    message: recipient ? noticeMessage(list, now) : null,
  }));
}

const signalOf = card => (card.runs ?? []).filter(r => r.role === card.role).map(r => r.sentAt).filter(Boolean).sort().at(-1) ?? '없음';
const reasonOf = card => card.movedOn === 'role' ? '담당이 다음 일로 넘어감' : '같은 업무에 더 뒤 라운드 있음';

// 완성된 DONE 마커는 넣지 않는다. 판정 명령의 뼈대만 준다.
export function noticeMessage(list, now = Date.now()) {
  const shown = list.slice(0, STALE_NOTICE_LIMIT);
  const lines = shown.map(c =>
    `- ${c.key} (담당 ${c.role || '미배정'} · 마지막 발령 ${signalOf(c)} · ${reasonOf(c)})\n` +
    (c.displayState === 'failed' ? '' : `  결과 확정: kadan done ${c.role || '<역할>'} ${c.key} <ok|failed>\n`) +
    `  대체: kadan card update ${c.key} --revision ${c.revision} --status superseded --replaced-by <저장소/후속카드> --note "<이유>"\n` +
    `  취소: kadan card update ${c.key} --revision ${c.revision} --status cancelled --note "<이유>"`);
  const rest = list.length - shown.length;
  return [
    `[감시sh ${new Date(now).toISOString().slice(11, 16)}Z] 오래된 미확정 실행 ${list.length}개 — 판정해 주세요(실행당 1회만 안내).`,
    '담당이 다음 일로 넘어갔거나 같은 업무에 더 뒤 라운드가 생겼는데 결과가 확정되지 않았거나 실패로 남은 실행입니다. 대시보드 지금 막힘에서는 뺐습니다. 감시기는 실행 상태를 바꾸지 않습니다.',
    ...lines,
    ...(rest > 0 ? [`- 외 ${rest}개는 대시보드 '오래된 미확정'에서 확인`] : []),
  ].join('\n');
}

// 한 번 훑는다. 보내기 전에 시도를 원장에 남기고(남기지 못하면 보내지 않는다), 보낸 뒤 결과를 덧붙인다.
// 사람이 입력 중이라 미룬 것(알림 보류)은 시도를 거두는 held 기록을 남겨 다음 훑기에 다시 보낸다.
// 보낸 뒤 결과 기록이 실패해도 시도 기록이 있어 다시 보내지 않는다.
// held 기록이 실패하면 실제로는 안 보냈는데 시도만 남는다. 그 기록은 pendingHeld에 쥐고 다음 훑기 첫머리에 다시 쓴다.
// 감시기를 다시 켜면 pendingHeld가 사라진다(한계). 그 경우 그 실행은 평생 제외로 남는다.
export function runStaleNotices({cards, entries, works, now = Date.now(), send, record, liveSessions = null, pendingHeld = []}) {
  const result = {sent: 0, unknownRecipient: 0, failed: 0, held: 0};
  let current = entries;
  for (const rec of pendingHeld.splice(0)) {
    try { record(rec); current = [...current, rec]; } catch { pendingHeld.push(rec); }
  }
  for (const plan of planStaleNotices({cards, entries: current, works, now, liveSessions})) {
    const base = {
      kind: 'alert', by: 'watch', source: 'stale-notice', alertKind: STALE_NOTICE_KIND, level: 'INFO',
      recipient: plan.recipient, executionKeys: plan.keys, resolved: true,
    };
    if (!plan.recipient) {
      result.unknownRecipient++;
      record({...base, delivered: false, reason: '받는 쪽 모름'});
      continue;
    }
    try { record({...base, delivered: false, attempt: true, reason: '전달 시도'}); }
    catch { result.failed++; continue; }
    try { send(plan.recipient, plan.message); result.sent++; }
    catch (error) {
      if (isNotificationHold(error)) {
        const rec = {...base, delivered: false, held: true, reason: '알림 보류'};
        try { record(rec); result.held++; }
        catch { pendingHeld.push(rec); result.failed++; }
        continue;
      }
      result.failed++;
      try { record({...base, delivered: false, reason: `전달 실패(${error.message})`}); } catch {}
      continue;
    }
    try { record({...base, delivered: true}); } catch {}
  }
  return result;
}
