// 감시기가 역할 창에 넣는 알림 본문의 틀. 항목 이름을 붙여 받는 쪽이 누가·누구에게·무엇을 한눈에 읽게 한다(2026-10-21 [kyle]).
// 값은 호출한 쪽이 이미 만든 글이고, 여기서는 이름과 줄만 붙인다. 원장 기록에는 쓰지 않는다.
export const WATCH_SENDER = '감시기(watch)';

export function labeledNotice({ role, content, todo, sender = WATCH_SENDER }) {
  return [`보낸이: ${sender}`, `받는이: ${role}`, `내용: ${content}`, ...(todo ? [`할 일: ${todo}`] : [])].join('\n');
}
