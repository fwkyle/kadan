// 비교 회차의 프리셋 이름과 역할 값을 고정한다. 설정의 모든 저장 입구가 함께 쓴다.
export const COMPARE_OFF_HINT = '먼저 `kadan runners compare off`';

export function assertComparePresetMutable(settings, name) {
  if (settings.compare?.enabled && settings.compare.presets.includes(name)) {
    throw new Error(`비교 중인 프리셋 ${name}은 바꿀 수 없다 — ${COMPARE_OFF_HINT}`);
  }
}

export function assertCompareShape(compare) {
  if (compare === undefined) return;
  if (!compare || typeof compare.enabled !== 'boolean' || !Array.isArray(compare.presets)
    || compare.presets.some(name => typeof name !== 'string' || !name.trim())
    || new Set(compare.presets).size !== compare.presets.length
    || (compare.enabled && (!compare.presets.length || !Number.isFinite(Date.parse(compare.enabledAt))))) {
    throw new Error(`비교 설정 손상 — ${COMPARE_OFF_HINT}`);
  }
}

export function assertCompareUnchanged(current, next, action, detail) {
  if (!current.compare?.enabled) return;
  for (const name of current.compare.presets) {
    const before = current.presets[name], after = next.presets[name];
    const targeted = ['set', 'preset-import', 'preset-remove'].includes(action) && detail?.preset === name;
    const renamed = action === 'preset-rename' && detail?.before === name;
    if (targeted || renamed || JSON.stringify(before?.roles) !== JSON.stringify(after?.roles)) {
      throw new Error(`비교 중인 프리셋 ${name}은 바꿀 수 없다 — ${COMPARE_OFF_HINT}`);
    }
    if (action === 'block') {
      const values = [...Object.values(before?.roles ?? {}).flat(),
        ...Object.values(before?.fallback ?? {}).flat()];
      if (values.some(value => value?.model === detail?.after?.model)) {
        throw new Error(`비교 중인 프리셋 ${name}의 모델은 차단할 수 없다 — ${COMPARE_OFF_HINT}`);
      }
    }
  }
}
