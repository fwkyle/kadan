// 실행 모델 설정 화면 역할 줄의 '값의 출처'(2026-11-20 kyle 최소안 A).
// 뜻: 지금 살아 있는 그 프로필 세션들이 어떻게 떴는지의 요약이다. 설정값 자체의 출처가 아니다.
// 재료는 현황(status)의 살아 있는 세션 목록이 이미 싣는 start 사건 칸(서버 launchOrigin)뿐이고, 원장을 새로 읽지 않는다.
export type LaunchOrigin = {
  source: 'settings' | 'fallback' | 'override' | 'review-for' | 'resume' | 'unknown';
  fallbackIndex?: number;
  hard?: boolean;
};
export type OriginSession = {
  role: string; profile?: string | null; launch?: LaunchOrigin | null; pidState?: string | null;
};

// 설정 줄 이름 → 세션 프로필. 세션을 띄우지 않는 자리(감시·시니어·설명 AI·비서)는 null이다.
// 어려운 일 작업자 줄은 작업자 프로필 중 어려운 일 자리로 뜬 것(start의 difficulty: hard)만, 작업자 줄은 나머지를 센다.
const PROFILE_OF: Record<string, string> = {worker: 'worker', 'worker-hard': 'worker', reviewer: 'reviewer', conductor: 'conductor', super: 'super'};

const LABEL: Record<Exclude<LaunchOrigin['source'], 'fallback'>, string> = {
  settings: '설정', 'review-for': '검수 지정', override: '덮어쓰기', resume: '다시 띄움', unknown: '기록 없음',
};
const ORDER = ['settings', 'fallback', 'review-for', 'override', 'resume', 'unknown'];

// 세션 하나가 센 칸. 떠 있는 프로세스가 start 기록과 달라졌을 수 있으면(pidState가 match가 아님) 출처를 믿지 않고 '기록 없음'이다.
function bucket(session: OriginSession): {key: string; label: string; index: number} {
  const launch = session.launch;
  if (!launch || session.pidState !== 'match' || !(launch.source in LABEL || launch.source === 'fallback'))
    return {key: 'unknown', label: LABEL.unknown, index: 0};
  if (launch.source === 'fallback' && launch.fallbackIndex)
    return {key: `fallback:${launch.fallbackIndex}`, label: `대체 ${launch.fallbackIndex}번`, index: launch.fallbackIndex};
  if (launch.source === 'fallback') return {key: 'unknown', label: LABEL.unknown, index: 0};
  return {key: launch.source, label: LABEL[launch.source], index: 0};
}

// 한 줄 요약. 세션 상태를 모르거나(live가 없음) 그 줄의 살아 있는 세션이 없으면 null(표시 없음).
export function originLine(live: OriginSession[] | null | undefined, row: string): string | null {
  const profile = PROFILE_OF[row];
  if (!profile || !live) return null;
  const mine = live.filter(session => session.profile === profile && Boolean(session.launch?.hard) === (row === 'worker-hard'));
  if (!mine.length) return null;
  const counts = new Map<string, {label: string; order: number; index: number; n: number}>();
  for (const session of mine) {
    const {key, label, index} = bucket(session);
    const base = key.startsWith('fallback') ? 'fallback' : key;
    const hit = counts.get(key) ?? {label, order: ORDER.indexOf(base), index, n: 0};
    hit.n++;
    counts.set(key, hit);
  }
  const parts = [...counts.values()].sort((a, b) => a.order - b.order || a.index - b.index).map(c => `${c.label} ${c.n}`);
  return [`떠 있는 ${mine.length}개`, ...parts].join(' · ');
}
