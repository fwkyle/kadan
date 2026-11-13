// Why: 전체 재생의 원인과 관측 메모리 최대를 기존 주기 기록에 고정 크기로 남긴다.
// 원장이 10배여도 숫자 슬롯과 관측 횟수는 순회·재생 횟수에만 비례하고 행마다 관측하지 않는다.
export const WATCH_METRIC_COUNT_MAX = 999_999;
export const WATCH_METRIC_MEMORY_MAX = 999_999.9;
export const WATCH_METRIC_DURATION_MAX = 999_999.9;
const fields = {
  raw: ['full', 'generation', 'retreat', 'reset'],
  projection: ['full', 'address', 'generation', 'invalid', 'count'],
  mail: ['full', 'generation', 'actors', 'invalid', 'count'],
  role: ['full', 'generation', 'invalid', 'count'],
  work: ['full', 'generation', 'invalid', 'count'],
  stores: ['cards', 'works'],
  sweep: ['full', 'replace', 'moved', 'error'],
};
const emptyReplay = () => ({...Object.fromEntries(Object.entries(fields)
  .map(([key, names]) => [key, Object.fromEntries(names.map(name => [name, 0]))])), initial: 0});
const emptyMemory = () => ({last: null, max: null, samples: 0, failures: 0});
const increment = (target, key) => { target[key] = Math.min(WATCH_METRIC_COUNT_MAX, target[key] + 1); };

// 선택 계수기를 주지 않은 공유 뷰는 아무 관측도 하지 않는다. 계측 실패는 판정 경계를 넘지 않는다.
export function watchMetric(metrics, method, ...args) {
  if (!metrics) return;
  try { return metrics[method](...args); }
  catch {
    try { metrics.failure(); } catch { /* 계측 오류로 감시 동작을 바꾸지 않는다. */ }
  }
}

export function beginWatchReplay(metrics, component, reason) {
  if (!metrics) return null;
  watchMetric(metrics, 'replay', component, reason);
  return () => watchMetric(metrics, 'sample');
}

export function beginWatchInitial(metrics) {
  if (!metrics) return null;
  watchMetric(metrics, 'beginInitial');
  return () => watchMetric(metrics, 'endInitial');
}

export function createWatchReplayMetrics({memoryUsage = () => process.memoryUsage()} = {}) {
  let replay = emptyReplay(), processMemory = emptyMemory();
  let initializing = false, initialSeen = false;
  const failure = () => increment(processMemory, 'failures');
  const initial = () => {
    if (!initialSeen) { increment(replay, 'initial'); initialSeen = true; }
  };
  return {
    failure,
    beginInitial() { initial(); initializing = true; },
    endInitial() { initializing = false; },
    replay(component, reason) {
      if (initializing || reason === 'initial') { initial(); return; }
      const names = fields[component];
      if (!names?.includes(reason)) { failure(); return; }
      if (['raw', 'projection', 'mail', 'role', 'work'].includes(component)) {
        increment(replay[component], 'full');
      }
      increment(replay[component], reason);
    },
    count(component, name) {
      if (!fields[component]?.includes(name)) { failure(); return; }
      increment(replay[component], name);
    },
    sweepSlice(ms) {
      if (!Number.isFinite(ms) || ms < 0) { failure();return; }
      const sweep = replay.sweep;
      sweep.slices ??= 0;
      increment(sweep, 'slices');
      sweep.maxSliceMs = Math.max(sweep.maxSliceMs ?? 0,
        Math.min(WATCH_METRIC_DURATION_MAX, Math.round(ms * 10) / 10));
    },
    sample() {
      increment(processMemory, 'samples');
      try {
        const memory = memoryUsage();
        const last = Object.fromEntries(['rss', 'heapUsed', 'heapTotal'].map(key => {
          const value = memory[key];
          return [key, Number.isFinite(value) && value >= 0
            ? Math.min(WATCH_METRIC_MEMORY_MAX, Math.round(value / 1048576 * 10) / 10) : null];
        }));
        if (Object.values(last).some(value => value === null)) failure();
        processMemory.last = Object.values(last).some(value => value !== null) ? last : null;
        if (processMemory.last) {
          processMemory.max = Object.fromEntries(Object.entries(last).map(([key, value]) =>
            [key, value === null ? processMemory.max?.[key] ?? null
              : Math.max(processMemory.max?.[key] ?? value, value)]));
        }
      } catch { processMemory.last = null; failure(); }
    },
    snapshot: () => ({replay: structuredClone(replay), processMemory: structuredClone(processMemory)}),
    clear() { replay = emptyReplay(); processMemory = emptyMemory(); },
  };
}
