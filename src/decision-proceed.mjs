// 완전자율(--level full)의 "답 없는 결정은 추천대로 진행" 자격 판정. 순수 함수다: 파일·원장을 읽지 않는다.
// 명령(`kadan decision proceed`)·감시기(답 대기에서 뺄지)·화면이 이 판정 하나를 같이 쓴다. 자격은 지침 문장이 아니라 여기서 검사한다.
// 값을 읽지 못하면 "아직 대기 중"이다(조용한 쪽이지만 권한이 늘지 않는 쪽).
import {atLeast, LEVEL_FULL, LEVEL_LABEL} from './autopilot-terms.mjs';
import {isSupervisorActor, isUserActor} from './actors.mjs';
import {normalizePrKey} from './autopilot-note.mjs';

// 세 겹으로 막고 모두 "기다리는 쪽"으로 틀린다(검수 2라운드):
//  (가) 기록 대조(주 방어선, 명령 경로에서만 원장을 읽는다): 결정의 업무에 풀리지 않은 보류·관문 거절 기록이 있으면 자격이 없다(holdBlocks).
//  (나) 요청 때의 선언: --reversible은 --not-prohibited(금지 목록에 닿지 않는다는 요청자 선언)와 함께만 저장된다. 코드는 진위를 검증하지 못한다.
//  (다) 낱말 거름(보조 방어선): 금지 목록 요지의 낱말이 질문·이유·추천·선택지에 있으면 요청도 진행도 거절한다. 의미를 아는 것이 아니라서
//       무관한 결정이 걸릴 수 있고, 걸리면 기다릴 뿐이다(kyle 답을 기다린다).
export const PROHIBITED_SUMMARY = '운영 배포·운영 데이터·영구 삭제·강제 push·비밀값·결제·카단 밖 글·설정·권한·머지·관문';
export const WORD_HINT = '낱말 때문에 막혔으면 kyle 답을 기다립니다';
const GATED = new RegExp([
  'https?://github\\.com/\\S+/pull/\\d+', '(?:^|[^\\w])#\\d+', 'merge-gate', 'night-merge', 'deploy-branch', '--allow',
  '관문', '머지', '금지 목록', '정책', '보류', '배포', '운영', '삭제', '영구', '강제', '비밀', '결제', '권한', '설정', '인증', '계정', '유료', '증액', '초기화',
  '\\b(?:merge|deploy\\w*|prod\\w*|force|push|secret\\w*|token|credential\\w*|password|billing|payment|rm|drop|delete|truncate|DB|sudo|chmod|schema|migration)\\b',
].join('|'), 'i');
// 확인 경로 줄의 주소(가장 좁은 예외): 이유(reason) 안에서 줄 전체가 `- <라벨>: <PR 주소 하나>` 꼴일 때 그 PR 주소 토큰만 거름에서 뺀다.
// 결정 요청은 확인 경로 줄을 요구하므로(src/decisions.mjs assertVerifyPath) PR을 확인 경로로 적은 결정이 통째로 막히던 것을 푼다.
// 라벨과 그 줄의 나머지(주소 뒤에 글이 더 있는 줄 포함), 질문·추천·선택지, 이유의 다른 줄은 모두 그대로 거른다. `#숫자`와 낱말 목록은 풀지 않는다.
// 이 예외는 주소 모양만 본다: 선언의 진위와 결정의 의미는 여전히 코드가 검증하지 못한다.
// 판정 근거: 소유자·저장소는 GitHub 이름 글자(영문·숫자·-·_·.)만 허용해, `?`·`#`·`;`·`%`·`@`·`:`가 든 꼴은 PR 경로가 아니라 쿼리·조각으로 읽히므로 풀지 않는다. 주소 끝에도 쿼리·조각·추가 경로를 허용하지 않는다.
const VERIFY_LINE_PR = /^([ \t]*-[ \t]*[^:\n]+:[ \t]*)https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+[ \t]*$/gm;
const withoutVerifyLinks = reason => reason.replace(VERIFY_LINE_PR, '$1');
export const gatedDecisionText = d => [d?.question, typeof d?.reason === 'string' ? withoutVerifyLinks(d.reason) : d?.reason, d?.recommendation, ...(Array.isArray(d?.options) ? d.options : [])]
  .filter(x => typeof x === 'string').some(x => GATED.test(x));

// (가) 기록 대조. entries는 원장(못 읽었으면 null → 막는다). 반환: 풀리지 않은 보류·거절 기록 목록, 읽지 못했으면 null.
// 보류(hold, 모든 종류)와 관문 거절(gate reject)은 같은 업무의 같은 PR(PR 없으면 PR 없는 칸)에 대한 관문 통과 또는 머지 기록으로만 풀린다.
const bareWork = w => String(w ?? '').replace(/^work:/, '');
export function holdBlocks(entries, work) {
  if (!Array.isArray(entries) || !work) return null;
  const key = bareWork(work), blocked = new Map();
  for (const e of entries) {
    if (e?.kind !== 'autopilot-note' || bareWork(e.work) !== key) continue;
    const pr = e.pr ? normalizePrKey(e.pr) : '';
    if (e.noteKind === 'hold' || (e.noteKind === 'gate' && e.verdict === 'reject')) blocked.set(pr, e);
    else if ((e.noteKind === 'gate' && e.verdict === 'pass') || e.noteKind === 'merge') blocked.delete(pr);
  }
  return [...blocked.values()];
}
export const holdReason = list => (list === null
  ? '기록을 읽지 못했거나 업무가 없어 보류·관문 거절 기록을 대조할 수 없습니다(진행하지 않음)'
  : list.length ? `이 업무에 풀리지 않은 보류·관문 거절 기록이 ${list.length}건 있습니다(${list.slice(0, 2).map(n => n.pr || n.holdKind || n.noteKind).join(', ')})` : null);

// 요청한 역할 본인, 또는 관계표에서 그 역할의 가장 가까운 슈퍼감독 하나(요청자가 슈퍼감독이면 본인뿐). 사용자 행위자는 제외한다.
// parents는 Map|객체|null(못 읽음 → 요청자 본인만).
export function mayProceed(by, d, parents) {
  if (typeof by !== 'string' || !by || isUserActor(by)) return false;
  if (by === d?.requestedBy) return true;
  if (isSupervisorActor(d?.requestedBy) || !parents) return false;
  const table = parents instanceof Map ? parents : new Map(Object.entries(parents));
  let role = d?.requestedBy;
  for (let i = 0; i < 64 && typeof role === 'string'; i++) {
    role = table.get(role);
    if (isSupervisorActor(role)) return role === by;
  }
  return false;
}

const minutes = ms => Math.max(1, Math.ceil(ms / 60_000));

// 결정 d가 지금 추천대로 진행할 수 있는 자격인지. ap = autopilotWingmanSnapshot 꼴 {on, level, startedAt, decideAfterMs}.
// 반환: {ok, already, reasons[]}. already면(진행 기록이 이미 있음) ok는 false이고 reasons는 비어 있다.
// 시계는 max(결정 요청 시각, 지금 켜짐 구간의 시작 시각)부터다: 완전자율을 켜는 순간 묵은 결정이 한꺼번에 넘어가지 않는다.
export function proceedEligibility(d, ap, now) {
  if (d?.proceeded) return {ok: false, already: true, reasons: []};
  const reasons = [];
  if (!ap?.on) reasons.push('Autopilot이 꺼져 있습니다');
  else if (!atLeast(ap.level, LEVEL_FULL)) reasons.push(`단계가 ${LEVEL_LABEL[LEVEL_FULL]}이 아닙니다(지금 ${LEVEL_LABEL[ap.level] ?? ap.level ?? '모름'})`);
  if (!Number.isFinite(ap?.decideAfterMs)) reasons.push('켤 때 저장한 대기 시간을 읽을 수 없습니다(넘어가지 않음)');
  if (d?.status !== 'open') reasons.push('이미 닫힌 결정입니다(답·취소 뒤)');
  if (typeof d?.recommendation !== 'string' || !d.recommendation.trim()) reasons.push('요청할 때 추천안이 없었습니다');
  if (typeof d?.reversible !== 'string' || !d.reversible.trim()) reasons.push('요청할 때 되돌릴 수 있음 표시(--reversible)가 없었습니다');
  if (typeof d?.notProhibited?.by !== 'string' || typeof d.notProhibited.at !== 'string') reasons.push('요청할 때 금지 목록에 닿지 않는다는 선언(--not-prohibited)이 없었습니다');
  if (gatedDecisionText(d)) reasons.push(`금지 목록·관문·정책에 닿을 수 있는 낱말이 있어 넘어가지 않습니다(${WORD_HINT})`);
  const requestedAt = Date.parse(d?.at), startedAt = Date.parse(ap?.startedAt);
  if (!Number.isFinite(requestedAt) || !Number.isFinite(startedAt) || !Number.isFinite(now)) reasons.push('시각을 읽을 수 없습니다(아직 대기 중으로 봅니다)');
  else if (Number.isFinite(ap?.decideAfterMs)) {
    const waited = now - Math.max(requestedAt, startedAt);
    if (waited < ap.decideAfterMs) reasons.push(`대기 시간 전입니다(${minutes(ap.decideAfterMs - waited)}분 남음)`);
  }
  return {ok: reasons.length === 0, already: false, reasons};
}

// 답 대기에서 풀린 시각(ms): 진행 기록이 있으면 그 시각, 아니면 자격이 생긴 시각 max(요청 시각, 켜짐 구간 시작) + 대기 시간. 계산할 수 없으면 null.
// 놀고 있음 계산은 이 시각부터 멈춤을 센다(대기한 시간은 멈춘 시간이 아니다: 업무 대기 시각 --wait-until과 같은 방식).
export function releaseTime(d, ap) {
  if (d?.proceeded) { const at = Date.parse(d.proceeded.at); return Number.isFinite(at) ? at : null; }
  const at = Math.max(Date.parse(d?.at), Date.parse(ap?.startedAt)) + ap?.decideAfterMs;
  return Number.isFinite(at) ? at : null;
}

// 감시기용: 이 결정을 더 이상 "답 대기"로 세지 않을지. 진행 기록이 붙었거나 대기 시간이 지나 진행할 자격이 생긴 열린 결정이다.
export const releasedFromWait = (d, ap, now) => d?.status === 'open' && (Boolean(d.proceeded) || proceedEligibility(d, ap, now).ok);

// 감시기가 이미 읽은 결정 목록에서 대기 시간이 지난 것(진행 기록 전)만 골라 안내 한 줄 재료로 준다.
export const proceedableNow = (decisions, ap, now) => (decisions ?? []).filter(d => d?.status === 'open' && !d.proceeded && proceedEligibility(d, ap, now).ok);

export const proceedHint = d => `대기 시간이 지났습니다. 진행할 수 있는지 확인: \`kadan decision proceed ${d.id} --revision ${d.revision}\``;
