// Why: 우편 단순화(2026-10-21)의 새 규칙은 날짜가 아니라 우편마다 붙는 표지로 가른다.
// 발신(자동 보관)은 코드가 바뀌는 순간 켜지는데 감시 쪽 적용을 날짜로 하면 두 경계가 어긋나 '보관 성공 → 알림 0회'가 생긴다
// (2026-10-21 독립검수 C1). 새 코드가 쓰는 우편 기록에는 mailRule을 달고, 표지 없는 옛 기록은 옛 규칙으로 남는다(원장은 append-only).
export const MAIL_RULE = 1;
export const mailRuleField = () => ({mailRule: MAIL_RULE});
export const isSimplifiedMail = mail => Number(mail?.mailRule) >= MAIL_RULE;

export const reminderKey = (mailId, role) => JSON.stringify([mailId, role]);

// 감시 알림 사건에서 우편·받는 역할별로 처음 sent된 시각(ms). 보류(held)·not-sent·unknown은 넣은 것이 아니다.
export function firstReminderSent(entries) {
  const sent = new Map();
  for (const e of entries) {
    if (e?.kind !== 'watch-mail-reminder' || e.action !== 'result' || e.held === true || e.delivery !== 'sent'
      || !e.mailId || !e.role) continue;
    const key = reminderKey(e.mailId, e.role), at = Date.parse(e.t);
    if (Number.isFinite(at) && !sent.has(key)) sent.set(key, at);
  }
  return sent;
}

// '넣은 시각'의 유일한 정의: 창에 키로 전달됐으면(send의 keyDelivery) 그 우편 시각, 아니면 그 우편·받는 역할에게
// 감시 알림이 처음 sent된 시각. 못 넣었으면 null. 5분 시계(watch-mail)와 세대 면제(mailbox-state)가 같이 쓴다.
export function deliveredAt(mail, recipient, firstSent) {
  if (mail.keyDelivery != null) return Date.parse(mail.t);
  return firstSent?.get(reminderKey(mail.mailId, recipient)) ?? null;
}

// 세대 필터 면제: 새 규칙의 보관 우편 중 (a) 한 번도 못 넣었거나 (b) 받는 역할의 가장 최근 새 대화가 시작된 뒤에 처음 넣은 우편.
// (b)는 새 대화에 알림이 이미 나갔다는 뜻이라 그 대화의 우편으로 남긴다. 새 대화 앞에서 이미 넣은 우편(F2)은 면제가 아니다.
// 비서·사람 앞 우편은 저장 전용 계약이라 옛 규칙 그대로다.
export function isGenerationExempt(mail, recipient, isUser, firstSent, isPreviousAt) {
  if (mail.transport !== 'mailbox' || !isSimplifiedMail(mail) || recipient === '비서' || isUser(recipient)) return false;
  const at = deliveredAt(mail, recipient, firstSent);
  return at == null || !isPreviousAt(recipient, at);
}
