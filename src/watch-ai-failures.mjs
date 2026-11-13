// Why: 점검 AI 호출이 한 번 실패한 것은 점검 도구의 문제이고 사람이 할 일이 없다. 한 번 실패로 사람을 부르지 않고,
// 같은 대상에서 이어지거나 여러 대상이 잇달아 실패할 때만 올린다. 횟수는 새 저장 상태 없이 원장의 호출 기록(watch-ai-call)에서 센다.
// 데이터가 10배여도: 주기마다 세지 않는다. 실패 결과가 도착한 주기에만, 이미 읽은 원장 배열을 뒤에서부터 최근 구간만 훑는다.

// 같은 대상: 점검이 연속 2번 실패하고 첫 실패부터 30분이 지났을 때. 감독 응답 점검은 빨라야 1시간에 한 번이라 두 번째 실패는
// 1시간 이상 뒤다(감독이 일하는 중이면 점검이 미뤄져 더 늦다). 그동안 그 대상의 점검 결과는 없는 채로 지나간다.
// 화면이 바뀔 때마다 5분 간격으로 다시 불리는 작업 점검은 짧은 장애 한 번에 여러 번 실패해도 30분 전에는 올라가지 않는다.
export const TARGET_FAILS = 2, TARGET_SPAN_MS = 30 * 60_000;
// 도구 전체: 성공 없이 점검이 연속 3번, 서로 다른 대상 2개 이상에서 실패하고 첫 실패부터 15분이 지났을 때.
// 대상마다 한 번씩만 실패해 아무 대상도 기준에 닿지 않는 경우를 잡는다.
export const ALL_FAILS = 3, ALL_TARGETS = 2, ALL_SPAN_MS = 15 * 60_000;
// 이보다 오래된 기록은 보지 않는다(뒤에서부터 훑다가 여기서 멈춘다).
export const LOOKBACK_MS = 24 * 60 * 60_000;

// 실패로도 성공으로도 세지 않는 사유: 취소, 맥북 잠자기, 인터넷 없음(인터넷 없음은 러너의 기존 3번 규칙이 따로 본다).
const NEUTRAL = new Set(['cancelled', 'slept', 'network']);
export const aiTargetKey = call => `${call.source}:${call.role}:${call.taskId || ''}`;

// entries: 이번 주기에 이미 읽은 원장(시간 순). extra: 아직 그 배열에 없는 이번 호출 기록(있으면 맨 뒤에 붙여 센다).
// 점검 하나는 대체 후보 시도까지 묶어 한 번으로 센다: 뒤 시도의 previousRequestId가 가리키는 앞 시도는 세지 않는다.
// 돌려주는 값: target(key) → {count, since} (그 대상의 끝에서부터 연속 실패), all → {count, targets, since} (대상 무관 연속 실패).
export function aiFailureRuns(entries, now, extra = []) {
  const targets = new Map(), closed = new Set(), continued = new Set();
  const all = {count: 0, targets: new Set(), since: null};
  let allOpen = true;
  const visit = call => {
    if (call.previousRequestId) continued.add(call.previousRequestId);
    if (call.requestId && continued.has(call.requestId)) return; // 같은 점검의 앞 시도
    if (NEUTRAL.has(call.reason)) return;
    const key = aiTargetKey(call), at = Date.parse(call.t), failed = call.reason !== 'reported';
    if (!failed) { allOpen = false; closed.add(key); return; }
    if (allOpen) { all.count += 1; all.targets.add(key); if (Number.isFinite(at)) all.since = at; }
    if (!closed.has(key)) {
      const run = targets.get(key) ?? {count: 0, since: null};
      run.count += 1; if (Number.isFinite(at)) run.since = at;
      targets.set(key, run);
    }
  };
  for (let i = extra.length - 1; i >= 0; i--) visit(extra[i]);
  for (let i = (entries?.length ?? 0) - 1; i >= 0; i--) {
    const entry = entries[i];
    // 구간 끝은 호출 기록의 시각으로만 안다. 다른 사건은 옛 시각을 달고 뒤쪽에 섞여 있을 수 있다.
    if (entry?.kind !== 'watch-ai-call') continue;
    if (now - Date.parse(entry.t) > LOOKBACK_MS) break;
    visit(entry);
  }
  return {target: key => targets.get(key) ?? {count: 0, since: null}, all};
}

// 올릴 때가 됐는가. since를 모르면(시각 없는 기록) 시간 조건을 채우지 못한 것으로 본다.
export const targetFailureDue = (run, now) => run.count >= TARGET_FAILS && run.since !== null && now - run.since >= TARGET_SPAN_MS;
export const allFailureDue = (all, now) => all.count >= ALL_FAILS && all.targets.size >= ALL_TARGETS && all.since !== null && now - all.since >= ALL_SPAN_MS;
