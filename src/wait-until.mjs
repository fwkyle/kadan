// 업무 대기 시각(--wait-until): 열린 업무가 그 시각까지 감독의 할 일이 아니게 한다. 보류(hold)와 별개의 칸이다.
// 쓸 때와 읽을 때 같은 규칙을 쓴다. 틀리는 방향은 "조용함"이라 모르면 대기 중이 아니다.
export const WAIT_UNTIL_MAX_MS = 24 * 60 * 60 * 1000;
export const WAIT_UNTIL_FORMAT = '형식: 2026-11-11T09:00+09:00 또는 2026-11-11T00:00Z (지금부터 24시간 이내의 미래 시각). 지우기: --wait-until none';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

// 값이 지금 기준으로 쓸 수 있는 대기 시각인지. ok면 정규화한 ISO(UTC)를 돌려준다.
export function parseWaitUntil(value, now) {
  if (typeof value !== 'string' || !ISO.test(value.trim())) return { ok: false, reason: '시각 형식을 알 수 없습니다' };
  const at = Date.parse(value.trim());
  if (!Number.isFinite(at)) return { ok: false, reason: '시각을 해석할 수 없습니다' };
  if (at <= now) return { ok: false, reason: '이미 지난 시각입니다' };
  if (at - now > WAIT_UNTIL_MAX_MS) return { ok: false, reason: '24시간보다 먼 시각입니다' };
  return { ok: true, at, iso: new Date(at).toISOString() };
}

// 읽을 때: 대기 기록이 앞뒤가 맞는가(상태 open, 두 시각 해석 가능, 적은 시각 < 대기 시각, 적은 시각부터 24시간 이내).
// 적은 시각이 대기 시각과 같거나 뒤인 기록은 정상 명령으로는 만들 수 없는 모순이라 대기가 아니다(손으로 고친 기록이 침묵을 만들지 못한다).
function waitRecord(work) {
  if (work?.status !== 'open' || typeof work.waitUntil !== 'string' || typeof work.waitUntilSetAt !== 'string') return null;
  const until = Date.parse(work.waitUntil), setAt = Date.parse(work.waitUntilSetAt);
  if (!Number.isFinite(until) || !Number.isFinite(setAt) || setAt >= until || until - setAt > WAIT_UNTIL_MAX_MS) return null;
  return { until, setAt };
}

// 지금 대기 중인가. 대기 중이 아닌 경우: 업무가 open이 아님·값 없음·해석 불가·모순된 기록·적은 시각이 지금보다 미래(시계가 뒤로 간 경우 포함)·
// 이미 지남·지금부터 24시간 초과. 모르면 대기 중이 아니다(알리는 쪽).
export function activeWaitUntil(work, now) {
  const rec = waitRecord(work);
  if (!rec || !Number.isFinite(now) || rec.setAt > now) return null;
  if (rec.until <= now || rec.until - now > WAIT_UNTIL_MAX_MS) return null;
  return rec.until;
}

// 앞뒤가 맞는 대기 기록이 지금 막 끝난 경우의 종료 시각(ms). 놀고 있음 계산은 이 시각부터 멈춘 것으로 센다(대기한 시간은 멈춘 시간이 아니다).
export function expiredWaitUntil(work, now) {
  const rec = waitRecord(work);
  return rec && Number.isFinite(now) && rec.setAt <= now && rec.until <= now ? rec.until : null;
}

// 감시 목록 항목: userTurnWaitList와 같은 꼴({work, tag})에 waitUntil(ISO)을 더한다.
export const WAIT_UNTIL_TAG = '시각 대기(대기 시각)';
export function waitUntilList(works, now) {
  return (works ?? []).flatMap(w => {
    const until = activeWaitUntil(w, now);
    return until === null ? [] : [{ work: w.key, waitUntil: new Date(until).toISOString(), tag: WAIT_UNTIL_TAG }];
  });
}

// 화면 글: 'HH:MM까지 대기'(서버 지역 시각). 대기 중이 아니면 빈 글.
const hhmm = ms => new Date(ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
export function waitUntilLabel(work, now = Date.now()) {
  const until = activeWaitUntil(work, now);
  return until === null ? '' : `${hhmm(until)}까지 대기`;
}

// 주기 기록(settings.userTurnWaits)을 화면 자료로: 대기 시각 항목은 지났으면 빼고(기록은 한 주기 늦을 수 있다) 'HH:MM까지 대기'를 더한다.
export function showCycleWaits(list, now = Date.now()) {
  return (list ?? []).flatMap(w => {
    if (typeof w?.waitUntil !== 'string') return [w];
    const until = Date.parse(w.waitUntil);
    return Number.isFinite(until) && until > now && until - now <= WAIT_UNTIL_MAX_MS ? [{ ...w, waitLabel: `${hhmm(until)}까지 대기` }] : [];
  });
}
