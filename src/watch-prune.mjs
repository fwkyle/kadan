// Why: 끝난 역할 줄이 관계표에 쌓이지 않게, 감시기가 하루 한 번 안전하게 정리한다.
export const HIERARCHY_PRUNE_EVERY_MS = 24 * 60 * 60_000;

// 하루 한 번 판단은 메모리가 아니라 원장의 마지막 hierarchy-prune 기록으로 한다(감시기 재시작 대비).
export function hierarchyPruneDue(entries, now) {
  const last = entries.findLast(entry => entry?.kind === 'hierarchy-prune');
  const at = Date.parse(last?.t);
  return !Number.isFinite(at) || now - at >= HIERARCHY_PRUNE_EVERY_MS;
}

// 정리 규칙은 pruneHierarchy 그대로다. 거절·오류도 기록으로 남겨 24시간 시계를 시작하고, 감시는 멈추지 않는다.
export function runDailyHierarchyPrune({entries, now, file, prune, record}) {
  if (!hierarchyPruneDue(entries, now)) return null;
  const entry = {kind: 'hierarchy-prune', by: 'watch', file};
  try {
    const result = prune({file, now});
    Object.assign(entry, {file: result.file, applied: result.applied, removeCount: result.removeCount,
      retainCount: result.retainCount, backup: result.backup ?? null, error: null});
  } catch (error) {
    Object.assign(entry, {applied: false, removeCount: null, retainCount: null, backup: null,
      error: error?.message ?? String(error)});
  }
  record(entry);
  return entry;
}
