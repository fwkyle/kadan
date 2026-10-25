import type { Choice, Settings } from './pages/Runners';

// 여러 칸을 고쳐도 서버에는 보내지 않는다. 프리셋 저장 때 한 요청으로 보낸다.
export function stagePreset(settings: Settings, role: string, fallback: boolean, value: Choice, op: string) {
  const next = structuredClone(settings);
  const preset = next.presets[next.activePreset];
  const choice: Choice = {runner: value.runner, model: value.model,
    ...(value.effort ? {effort: value.effort} : {})};
  if (!fallback) preset.roles[role] = choice;
  else {
    const old = role === 'senior' ? preset.roles.senior : preset.fallback?.[role];
    const list = Array.isArray(old) ? [...old] : old ? [old] : [];
    const [action, index] = op.split(':');
    const i = Number(index) - 1;
    if (action === 'add') list.push(choice);
    else {
      if (!Number.isInteger(i) || i < 0 || i >= list.length) throw new Error('없는 후보 번호입니다.');
      if (action === 'remove') list.splice(i, 1);
      else if (action === 'up' || action === 'down') {
        const j = i + (action === 'up' ? -1 : 1);
        if (j < 0 || j >= list.length) throw new Error('더 옮길 수 없습니다.');
        [list[i], list[j]] = [list[j], list[i]];
      } else throw new Error('알 수 없는 후보 조작입니다.');
    }
    if (role === 'senior') preset.roles.senior = list;
    else preset.fallback = {...preset.fallback, [role]: list};
  }
  return next;
}

export const presetStamp = (settings: Settings) => JSON.stringify({
  name: settings.activePreset, value: settings.presets[settings.activePreset],
});

export const presetSaveFields = (settings: Settings, reason: string) => ({
  preset: settings.activePreset,
  value: JSON.stringify(settings.presets[settings.activePreset]),
  revision: String(settings.revision), reason,
});
