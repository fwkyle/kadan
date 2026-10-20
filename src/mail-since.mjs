// Why: 우편 단순화(2026-10-21)의 새 알림 규칙을 배포 전 옛 우편에는 적용하지 않는다.
// 2026-10-01 실측으로 미확인 우편이 남은 수신자가 128명이었다. 옛 우편까지 세대 필터를 면제하고 매 순회 재시도하면
// 머지 뒤 역할이 뜰 때마다 옛 우편 알림이 쏟아진다. 새 동작은 이 시각 이후에 보낸 우편에만 걸린다.
// 머지가 이 시각보다 많이 늦어지면 머지 직전에 이 날짜를 올린다.
export const MAIL_SIMPLIFY_SINCE = '2026-10-21T00:00:00Z';
const SINCE_MS = Date.parse(MAIL_SIMPLIFY_SINCE);

export const isSimplifiedMail = mail => Date.parse(mail?.t) >= SINCE_MS;

// 새 규칙 우편 중 키로 한 번도 못 넣고 저장만 된 우편. 비서·사람 앞 우편은 저장 전용 계약이라 옛 규칙을 그대로 둔다.
export const isNeverDeliveredMail = (mail, recipient, isUser) => mail.transport === 'mailbox'
  && mail.keyDelivery == null && isSimplifiedMail(mail) && recipient !== '비서' && !isUser(recipient);
