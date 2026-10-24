// Why: 설명 AI가 밀려도 카드별 최신 입력만 제한된 공간에 보관한다.
// 이력이 10배여도 대기열은 32개·직렬화한 UTF-8 4MiB를 넘지 않는다(실행 중 1개는 별도).
export const EXPLAIN_QUEUE_MAX_ENTRIES = 32;
export const EXPLAIN_QUEUE_MAX_BYTES = 4 * 1024 * 1024;

export function createExplainQueue() {
  const jobs = new Map();
  let bytes = 0, coalesced = 0, deferred = 0, oversized = 0;
  const remove = key => {
    const old = jobs.get(key);
    if (old) { bytes -= old.bytes; jobs.delete(key); }
  };
  return {
    get length() { return jobs.size; },
    enqueue(job) {
      const old = jobs.get(job.key);
      if (old?.job.hash === job.hash) return false;
      const size = Buffer.byteLength(JSON.stringify(job));
      if (size > EXPLAIN_QUEUE_MAX_BYTES) {
        remove(job.key);oversized++;return false;
      }
      if ((!old && jobs.size >= EXPLAIN_QUEUE_MAX_ENTRIES) ||
          bytes - (old?.bytes ?? 0) + size > EXPLAIN_QUEUE_MAX_BYTES) {
        remove(job.key);deferred++;return false;
      }
      bytes += size - (old?.bytes ?? 0);
      if (old) coalesced++;
      jobs.set(job.key, {job, bytes: size}); // 갱신해도 기존 대기 순서는 보존한다.
      return true;
    },
    take() {
      const key = jobs.keys().next().value;
      const job = jobs.get(key)?.job;
      remove(key);return job;
    },
    clear() { jobs.clear();bytes = 0; },
    info: () => ({entries: jobs.size, bytes, coalesced, deferred, oversized}),
  };
}
