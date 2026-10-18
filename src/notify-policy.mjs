// 디코에 '새 글'을 올릴지 정하는 게시 단계 정책. 원장·대시보드·경보 목록은 건드리지 않고, 디코 호출만 막는다.
// 새 글로 가는 것은 둘뿐이다: (a) kyle만 정할 결정, (b) kyle이 조치하지 않으면 풀리지 않는 장애(최상위까지 올라간 경보·되살리기 멈춤).
// 그 밖의 소식(우편·인계·조용한 되살리기·겹알림)은 새 글을 만들지 않고, 업무 글이 있으면 상태 메시지 하나만 고쳐 쓴다.
// 정하지 못한 종류는 '안 보냄'이 기본이다 — 새 알림 종류가 생겨도 kyle의 디코가 먼저 시끄러워지지 않는다.
// 표(전수)는 docs/user-notify.md "새 글 정책".

// 결정 요청·해결 고치기(decision-request|answer|cancel)는 항상 (a)다.
const DECISION = /^decision-(request|answer|cancel)$/;
// 되살리기(revive)에서 kyle 조치가 필요한 멈춤. 키는 revive.mjs가 붙인다. 조용한 '다시 띄움'(ring false, 키 없음)은 소식이라 뺀다.
const REVIVE_STOP = /^revive-(corrupt|stuck|capped)(:|$)/;
// 알림밀림(alertKind) 중 새 글을 만들지 않는 사유(holdCode). 사람이 그 창에서 입력 중이거나 복사 모드라서 밀린 것이고,
// 5번 밀리면 입력 보호를 건너뛰어 스스로 풀린다. 그 밖의 사유(신뢰 승인 화면·herdr 준비 안 됨·스크롤·상태 모름)와
// 사유를 모르는 밀림은 사람 조치가 필요할 수 있어 새 글로 유지한다(PR #192 검수 F1).
const SELF_RESOLVING_HOLDS = new Set([
  'KADAN_HUMAN_ACTIVE', 'KADAN_HUMAN_ACTIVITY_UNKNOWN', 'KADAN_PANE_INPUT_PENDING', 'KADAN_PANE_INPUT_UNKNOWN', 'KADAN_PANE_IN_MODE',
]);

// notifyUser를 부르는 모든 종류(kind). 새 종류를 쓰면 여기와 docs/user-notify.md 표에 올려야 한다(tests/notify-policy.test.mjs가 소스와 대조한다).
export const KNOWN_KINDS = ['alert', 'alert-resolved', 'decision-request', 'decision-answer', 'decision-cancel', 'revive', 'mail', 'handover'];

// 반환 {post:true} 또는 {post:false, reason}. opts: notifyUser의 opts(kind, key, alertKind, holdCode).
export function postPolicy(opts = {}) {
  const kind = opts.kind ?? null;
  if (kind && DECISION.test(kind)) return {post: true};
  // 경보 해결 표시는 올렸던 글을 고치는 일이다. 고칠 글(hasPost)이 없으면 새 글을 만들지 않는다.
  if (kind === 'alert-resolved') return opts.hasPost === true ? {post: true} : {post: false, reason: '고칠 경보 글 없음'};
  if (kind === 'alert') {
    // 겹알림은 감독에게 간 같은 경보의 사본이다(최상위로 올라간 경보가 아니다). alertKind는 알림밀림처럼 스스로 풀리는 종류를 가린다.
    if (opts.overlap === true) return {post: false, reason: '감독에게 간 경보의 겹알림'};
    if (opts.alertKind === '알림밀림' && SELF_RESOLVING_HOLDS.has(opts.holdCode)) return {post: false, reason: `알림밀림(${opts.holdCode})은 5번 뒤 스스로 풀리는 입력 보호`};
    return {post: true};
  }
  if (kind === 'revive') return REVIVE_STOP.test(opts.key ?? '') ? {post: true} : {post: false, reason: '되살리기 소식(조치 필요 없음)'};
  return {post: false, reason: kind ? `${kind}는 새 글 대상이 아님` : '종류 없음(기본 안 보냄)'};
}
