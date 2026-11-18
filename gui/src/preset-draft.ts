import type { Choice, Settings } from './pages/Runners';

// 어려운 일 작업자 자리: 선택 칸이라 비울 수 있다(서버 SETTINGS_ROLES의 worker-hard).
// 대체 후보 목록은 작업자와 같이 두되, 자리가 비어 있으면 둘 수 없고 자리를 비우면 목록도 함께 지운다.
export const HARD_ROLE = 'worker-hard';

// 여러 칸을 고쳐도 서버에는 보내지 않는다. 프리셋 저장 때 한 요청으로 보낸다.
export function stagePreset(settings: Settings, role: string, fallback: boolean, value: Choice, op: string) {
  const next = structuredClone(settings);
  const preset = next.presets[next.activePreset];
  if (fallback && role === HARD_ROLE && !(preset.roles[HARD_ROLE] as Choice | undefined)?.model)
    throw new Error('어려운 일 작업자 값이 비어 있어 대체 후보를 둘 수 없습니다. 먼저 값을 고르세요.');
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

// 비우기: 칸 자체를 지운다(빈 값·빈 객체를 남기지 않는다). 그 자리의 대체 후보 목록도 함께 지운다(1순위 없이 후보만 남지 않게).
// 저장 전까지는 변경안일 뿐이다.
export function clearPreset(settings: Settings, role: string) {
  if (role !== HARD_ROLE) throw new Error('비울 수 없는 역할입니다.');
  const next = structuredClone(settings);
  const preset = next.presets[next.activePreset];
  delete preset.roles[role];
  if (preset.fallback && Object.hasOwn(preset.fallback, role)) {
    delete preset.fallback[role];
    if (!Object.keys(preset.fallback).length) delete preset.fallback;
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

// 복사 원본 선택: 고른 이름이 최신 목록에 없으면(이름 바꾸기·삭제 뒤) 활성 프리셋, 그것도 없으면 첫 이름으로 맞춘다.
export const pickCopySource = (names: string[], active: string, chosen: string) =>
  names.includes(chosen) ? chosen : names.includes(active) ? active : (names[0] ?? '');

// 바꾸는 이유를 비워 두면 화면이 채워 보낸다(서버는 이유가 필수다). 적었으면 그 글을 그대로 쓴다.
export const reasonFor = (typed: string, labels: string[]) =>
  typed.trim() || `대시보드 표에서 변경: ${labels.join(', ') || '실행 모델'}`;

// 바꾸기 창에서 새 모델을 등록한 뒤의 변경안. 등록은 설정 버전만 올리므로 고친 다른 줄·대체 후보는 그대로 두고 버전만 이어 쓴다.
// 역할 줄은 등록한 모델을 고른 변경안으로 만들고, 대체 후보 칸은 '추가'를 눌러야 반영되므로 버전만 올린다.
export const withRegistered = (draft: Settings, role: string, fallback: boolean, choice: Choice, revision: number) =>
  fallback ? {...draft, revision} : stagePreset({...draft, revision}, role, false, choice, 'add');
