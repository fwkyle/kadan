// 사용자에게는 결정·확인이 필요한 것만 알린다. 색상(RED)만으로 사람의 개입을 추측하지 않는다.
const routine = new Set(['시작보고누락', '완료후보', '놀고 있음', '정체', '모름', '진행조정', '조정']);
const blocked = new Set(['죽음', '설정', '한도', '끊김', '감시AI오류', '응답장애']);

export function userAlertRequired(alert) {
  const kind = alert.kind === 'alert' ? alert.alertKind : alert.kind;
  if (['hierarchy:unreadable', 'ledger:unreadable'].includes(alert.id)) return true;
  if (routine.has(kind)) return false;
  if (kind === '전달실패') return blocked.has(alert.sourceKind);
  return blocked.has(kind) || ['hierarchy:unreadable', 'ledger:unreadable'].includes(alert.id);
}

export function userMailRequired(mail) {
  if (mail.notificationOnly || mail.systemGenerated || ['watch', 'watch-ai'].includes(mail.by)) return false;
  return ['request', 'decision'].includes(mail.mailKind ?? mail.category) ||
    mail.expectReply === true || mail.replyFinal === true;
}
