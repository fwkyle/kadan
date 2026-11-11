// 완전자율(--level full)의 "답 없는 결정은 추천대로 진행" 자격 판정. 순수 함수다: 파일·원장을 읽지 않는다.
// 명령(`kadan decision proceed`)·감시기(답 대기에서 뺄지)·화면이 이 판정 하나를 같이 쓴다. 자격은 지침 문장이 아니라 여기서 검사한다.
// 값을 읽지 못하면 "아직 대기 중"이다(조용한 쪽이지만 권한이 늘지 않는 쪽).
import {atLeast, LEVEL_FULL, LEVEL_LABEL} from './autopilot-terms.mjs';
import {isSupervisorActor} from './actors.mjs';

// 머지 승인·관문·정책 보류·금지 목록을 묻는 결정은 --reversible을 받지 않고 영영 넘어가지 않는다(요청할 때와 판정할 때 같은 검사).
// 코드가 의미를 알 수는 없으므로 글자로 거른다: 넓게 걸리는 쪽이 안전하다(걸리면 기다릴 뿐 진행하지 않는다).
const GATED = /https?:\/\/github\.com\/[^\s)]+\/pull\/\d+|merge-gate|night-merge|deploy-branch|--allow|관문|머지|금지 목록|\bmerge\b/i;
export const gatedDecisionText = d => [d?.question, d?.reason, d?.recommendation, ...(Array.isArray(d?.options) ? d.options : [])]
  .filter(x => typeof x === 'string').some(x => GATED.test(x));

const minutes = ms => Math.max(1, Math.ceil(ms / 60_000));

// 요청자 본인이거나 그 요청자 위로 관계표를 따라 올라가 만나는 슈퍼감독이면 true. parents는 Map|객체|null(못 읽음 → 요청자 본인만).
export function mayProceed(by, d, parents) {
  if (typeof by !== 'string' || !by) return false;
  if (by === d?.requestedBy) return true;
  if (!isSupervisorActor(by) || !parents) return false;
  const table = parents instanceof Map ? parents : new Map(Object.entries(parents));
  let role = d?.requestedBy;
  for (let i = 0; i < 64 && typeof role === 'string'; i++) {
    role = table.get(role);
    if (role === by) return true;
  }
  return false;
}

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
  if (gatedDecisionText(d)) reasons.push('머지·관문·정책 보류·금지 목록을 묻는 결정은 넘어가지 않습니다');
  const requestedAt = Date.parse(d?.at), startedAt = Date.parse(ap?.startedAt);
  if (!Number.isFinite(requestedAt) || !Number.isFinite(startedAt) || !Number.isFinite(now)) reasons.push('시각을 읽을 수 없습니다(아직 대기 중으로 봅니다)');
  else if (Number.isFinite(ap?.decideAfterMs)) {
    const waited = now - Math.max(requestedAt, startedAt);
    if (waited < ap.decideAfterMs) reasons.push(`대기 시간 전입니다(${minutes(ap.decideAfterMs - waited)}분 남음)`);
  }
  return {ok: reasons.length === 0, already: false, reasons};
}

// 감시기용: 이 결정을 더 이상 "답 대기"로 세지 않을지. 진행 기록이 붙었거나 대기 시간이 지나 진행할 자격이 생긴 열린 결정이다.
export const releasedFromWait = (d, ap, now) => d?.status === 'open' && (Boolean(d.proceeded) || proceedEligibility(d, ap, now).ok);

// 감시기가 이미 읽은 결정 목록에서 대기 시간이 지난 것(진행 기록 전)만 골라 안내 한 줄 재료로 준다.
export const proceedableNow = (decisions, ap, now) => (decisions ?? []).filter(d => d?.status === 'open' && !d.proceeded && proceedEligibility(d, ap, now).ok);

export const proceedHint = d => `대기 시간이 지나 추천대로 진행할 수 있습니다: \`kadan decision proceed ${d.id} --revision ${d.revision}\``;
