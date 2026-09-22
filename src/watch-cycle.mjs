// 감시 주기 기록과 감시기 상태 한 줄 판정.
// 프로세스 생존만으로는 "감시가 되고 있다"를 말할 수 없어서(2026-09-12 사용자 지적), 감시기가
// 주기마다 원장에 남긴 watch-cycle 사건으로 마지막 주기·설정·공백을 계산한다.
export const CYCLE_RECORD_MS = 5 * 60_000;
// 이 간격보다 오래 기록이 없으면 주기 지연, 기록 사이 간격이 이보다 크면 공백으로 센다.
export const CYCLE_STALE_MS = CYCLE_RECORD_MS * 3;
export const PROFILE_FILE = 'watch-profile.json';

export function cycleRecordDue(lastRecordedAt, now) {
 return lastRecordedAt == null || now - lastRecordedAt >= CYCLE_RECORD_MS;
}

export function buildCycleEntry({runtime = null,pid, hierarchyPath = null, hierarchyHash = null, judge = false, profile = null, intervalMs = null, sessions = null, supervisorSessions = null, ok = true}) {
 return {kind: 'watch-cycle', by: 'watch', pid,...(runtime?{runtime}:{}), hierarchy: hierarchyPath, hierarchyHash, judge: Boolean(judge), profile,
  intervalMs, sessions: sessions == null ? null : sessions.length, supervisorSessions: supervisorSessions == null ? null : supervisorSessions.length, ok};
}

const ms = value => {const t = Date.parse(value); return Number.isFinite(t) ? t : null;};

// 현재 감시기(worker) 기준 마지막 주기와 최근 24시간 공백. 기록이 하나도 없으면 unknown이며 0으로 꾸미지 않는다.
export function cycleStatus(entries, worker, now, {windowMs = 24 * 60 * 60_000} = {}) {
 const known = Array.isArray(entries) && !entries.some(e => e?.broken);
 if (!known) return {state: 'unknown', reason: '원장을 읽을 수 없습니다', lastAt: null, settings: null, gaps: null, gapMinutes: null};
 const cycles = entries.filter(e => e?.kind === 'watch-cycle' && ms(e.t) != null && ms(e.t) <= now);
 const mine = worker ? cycles.filter(e => Number(e.pid) === worker.pid && ms(e.t) >= (ms(worker.startedAt) ?? 0)) : [];
 const last = mine.at(-1) ?? null;
 const settings = last ? {...(last.runtime?{runtime:last.runtime}:{}),hierarchy: last.hierarchy ?? null, judge: last.judge === true, profile: last.profile ?? null, intervalMs: last.intervalMs ?? null} : null;
 const gaps = [];
 const first = cycles[0];
 let gapMinutes = null;
 if (first) {
  const start = Math.max(now - windowMs, ms(first.t));
  const points = cycles.filter(e => ms(e.t) >= start).map(e => ms(e.t));
  let previous = start;
  for (const t of [...points, now]) {
   if (t - previous > CYCLE_STALE_MS) gaps.push({from: new Date(previous).toISOString(), to: new Date(t).toISOString(), minutes: Math.round((t - previous) / 60_000)});
   previous = Math.max(previous, t);
  }
  gapMinutes = gaps.reduce((sum, g) => sum + g.minutes, 0);
 }
 if (!worker) return {state: cycles.length ? 'absent' : 'unknown', reason: cycles.length ? '감시기 없음' : '감시 주기 기록 없음', lastAt: cycles.at(-1)?.t ?? null, settings: null, gaps: first ? gaps : null, gapMinutes};
 if (!last) {
  const startedAgo = now - (ms(worker.startedAt) ?? now);
  return {state: startedAgo < CYCLE_RECORD_MS ? 'starting' : 'unknown', reason: startedAgo < CYCLE_RECORD_MS ? '첫 주기 기록 대기' : '이 감시기의 주기 기록 없음 — 구버전이거나 기록 실패', lastAt: null, settings: null, gaps: first ? gaps : null, gapMinutes};
 }
 const age = now - ms(last.t);
 return {state: age > CYCLE_STALE_MS ? 'stale' : last.ok === false ? 'error' : 'ok', reason: age > CYCLE_STALE_MS ? '마지막 주기 기록이 오래됐습니다' : last.ok === false ? '마지막 주기에 관측 오류' : '주기 기록 정상', lastAt: last.t, ageMs: age, settings, gaps: first ? gaps : null, gapMinutes};
}

const fmtAgo = agoMs => {const m = Math.round(agoMs / 60_000); return m < 1 ? '방금' : m < 60 ? m + '분 전' : Math.floor(m / 60) + '시간 ' + (m % 60) + '분 전';};
const fmtMinutes = m => m < 60 ? m + '분' : Math.floor(m / 60) + '시간 ' + (m % 60) + '분';
const clock = iso => new Date(iso).toLocaleTimeString('ko-KR', {timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false});

// 사람이 첫 화면에서 읽을 한 줄. level: ok | warn | bad | unknown
export function watchVerdict({process: proc, configuration, cycle, profilePath = null}, now = Date.now()) {
 const parts = [], hints = [];
 let level = 'unknown', headline = '감시기 생존 모름';
 const gap = cycle?.gapMinutes >= Math.round(CYCLE_STALE_MS / 60_000) && cycle.gaps?.length
  ? `최근 24시간 공백 ${fmtMinutes(cycle.gapMinutes)} (${cycle.gaps.map(g => clock(g.from) + '~' + clock(g.to)).join(', ')})` : null;
 if (proc.state === 'absent') {
  level = 'bad'; headline = '감시기 없음';
  if (cycle?.lastAt) parts.push(`마지막 주기 ${clock(cycle.lastAt)} (${fmtAgo(now - Date.parse(cycle.lastAt))})`);
  if (profilePath) hints.push(`다시 띄우기: kadan watch --profile ${profilePath}`);
 } else if (proc.state === 'duplicate') {
  level = 'bad'; headline = `감시기 중복 실행 ${proc.instances.length}개`; parts.push('하나만 남기고 종료해야 합니다');
 } else if (proc.state === 'running') {
  const s = cycle?.settings;
  const missing = s ? [...(s.hierarchy ? [] : ['관계 파일 없음']), ...(s.judge ? [] : ['AI 판정 꺼짐'])] : [];
  if (missing.length) {
   level = 'warn'; headline = '감시 설정 빠짐'; parts.push(...missing);
   hints.push(profilePath ? `정식 명령: kadan watch --profile ${profilePath}` : '정식 명령에 --hierarchy와 --judge-cmd를 붙여 다시 띄우세요');
  } else if (cycle?.state === 'stale') {
   level = 'warn'; headline = '감시 주기 지연'; parts.push(`마지막 주기 ${fmtAgo(cycle.ageMs)} · 프로세스는 살아 있음`);
  } else if (configuration.state === 'changed') {
   level = 'warn'; headline = '관계 파일 변경 후 반영 확인 전'; parts.push('다음 주기의 hierarchy-loaded 기록을 기다립니다');
  } else if (configuration.state === 'matched' && s?.judge && cycle.state === 'ok') {
   level = 'ok'; headline = '감시 정상'; parts.push('관계 파일 반영', 'AI 판정 켜짐', `마지막 주기 ${fmtAgo(cycle.ageMs)}`);
  } else if (!s && (cycle?.state === 'starting')) {
   level = 'warn'; headline = '감시기 시작 직후'; parts.push('첫 주기 기록 대기');
  } else if (!s) {
   level = 'warn'; headline = '감시기 설정 확인 불가'; parts.push('주기 기록 없음 — 구버전 감시기이거나 기록 실패', configuration.reason || '');
   if (profilePath) hints.push(`정식 명령: kadan watch --profile ${profilePath}`);
  } else {
   level = 'warn'; headline = '감시 설정 확인 필요'; parts.push(configuration.reason || '관계 파일 반영 미확인');
  }
 } else {
  parts.push(proc.error || '프로세스 목록 조회 실패');
 }
 if (gap) parts.push(gap);
 const runtime=cycle?.settings?.runtime;
 parts.push(`실행 코드 ${runtime?.commit||'모름'}${runtime?.dirty?' · 시작 시 미커밋 변경 있음':''}`);
 const text = [headline, ...parts.filter(Boolean)].join(' · ');
 return {level, headline, text, hints};
}
