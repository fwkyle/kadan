// 실행 모델 설정 화면 '최근 변경'의 되돌리기(2026-11-20 kyle 최소안 B).
// 뜻: 그 변경이 바꾼 칸만 그 변경의 이전 값(before)으로 지금 변경안(저장 전)에 채운다. 저장은 하지 않는다 — 사용자가 기존 '저장'을 눌러야 한다.
// 새 서버 쓰기 경로는 없다: 채운 변경안은 기존 /runners/preset-save 한 번으로 저장된다(리비전 확인·409·중복·차단·비교 모드 잠금 그대로).
// 프리셋 통째 before/after(화면 저장·가져오기)는 둘의 차이로 바뀐 칸을 계산해 그 칸만 쓴다 — 옛 통째 값으로 덮으면 그 뒤의 무관한 변경이 사라진다.
import {effortProblems} from './runner-draft.ts';
import {HARD_ROLE, OPTIONAL_ROLES} from './preset-draft.ts';
import type {Choice, RunnersData, Settings} from './pages/Runners';

export type SettingsEvent = {
  t?: string; by?: string; kind?: string; action?: string; revision?: number; reason?: string;
  preset?: string; role?: string; before?: unknown; after?: unknown; fallbackBefore?: unknown;
};
type Value = Choice | Choice[] | null;
// 값 칸(roles[role]) 또는 대체 후보 목록 칸(fallback[role])
export type Slot = {role: string; list: boolean; before: Value; after: Value};

// 키 순서·빈 강도 표기가 달라도 같은 값은 같게 본다.
const norm = (value: unknown): unknown => Array.isArray(value) ? value.map(norm)
  : value && typeof value === 'object'
    ? (({runner, model, effort}: Choice) => ({runner, model, ...(effort ? {effort} : {})}))(value as Choice) : (value ?? null);
export const sameValue = (a: unknown, b: unknown) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const emptyList = (value: Value) => Array.isArray(value) && !value.length;

type PresetPart = {roles?: Record<string, unknown>; fallback?: Record<string, unknown>};
// 프리셋 통째 before/after에서 바뀐 칸만 뽑는다. 이름·설명(label)은 되돌리기 대상이 아니다.
function importedSlots(before: PresetPart, after: PresetPart): Slot[] {
  const out: Slot[] = [];
  for (const role of new Set([...Object.keys(before.roles ?? {}), ...Object.keys(after.roles ?? {})])) {
    const a = (before.roles?.[role] ?? null) as Value, b = (after.roles?.[role] ?? null) as Value;
    if (!sameValue(a, b)) out.push({role, list: false, before: a, after: b});
  }
  for (const role of new Set([...Object.keys(before.fallback ?? {}), ...Object.keys(after.fallback ?? {})])) {
    const a = (before.fallback?.[role] ?? []) as Choice[], b = (after.fallback?.[role] ?? []) as Choice[];
    if (!sameValue(a, b)) out.push({role, list: true, before: a, after: b});
  }
  return out;
}

// 사건이 바꾼 칸. 역할 값·대체 후보·시니어 목록이 아닌 변경(즐겨찾기·프리셋 전환·차단 등)은 이유와 함께 거절한다.
export function eventSlots(event: SettingsEvent): {slots: Slot[]} | {reason: string} {
  const {action} = event;
  if (action === 'preset-import') {
    const {before, after} = event as {before?: PresetPart | null; after?: PresetPart | null};
    if (!before || !after) return {reason: '프리셋을 새로 만든 변경은 되돌리지 않습니다'};
    const slots = importedSlots(before, after);
    return slots.length ? {slots} : {reason: '되돌릴 역할 칸이 없습니다(이름·설명만 바뀐 변경)'};
  }
  if (action === 'set' && event.role) {
    const slots: Slot[] = [{role: event.role, list: false, before: (event.before ?? null) as Value, after: (event.after ?? null) as Value}];
    if (event.fallbackBefore) slots.push({role: event.role, list: true, before: event.fallbackBefore as Choice[], after: []});
    return {slots};
  }
  if (action === 'fallback' && event.role)
    return {slots: [{role: event.role, list: true, before: (event.before ?? []) as Choice[], after: (event.after ?? []) as Choice[]}]};
  return {reason: '역할 값·대체 후보가 아닌 변경은 되돌리지 않습니다'};
}

export type RevertPlan =
  | {state: 'ready'; roles: string[]; apply: (draft: Settings) => Settings}
  | {state: 'filled'; roles: string[]}
  | {state: 'blocked'; reason: string};

const current = (settings: Settings, slot: Slot): Value => {
  const preset = settings.presets[settings.activePreset];
  return (slot.list ? (preset?.fallback?.[slot.role] ?? []) : (preset?.roles[slot.role] ?? null)) as Value;
};

// 이 변경을 지금 되돌릴 수 있는가. saved는 서버가 준 저장된 설정, draft는 지금 변경안이다.
export function planRevert(event: SettingsEvent, saved: Settings, draft: Settings, data: Pick<RunnersData, 'catalog' | 'roles'>): RevertPlan {
  const found = eventSlots(event);
  if ('reason' in found) return {state: 'blocked', reason: found.reason};
  const {slots} = found, name = (role: string) => data.roles[role] ?? role;
  if (event.preset !== undefined && event.preset !== saved.activePreset)
    return {state: 'blocked', reason: `다른 프리셋(${event.preset})의 변경입니다. 지금 쓰는 프리셋은 ${saved.activePreset}입니다`};
  const roles = [...new Set(slots.map(slot => slot.role))];
  // 이미 채웠다: 저장된 값은 그 변경 직후 그대로이고 변경안이 이전 값이다.
  if (slots.every(slot => sameValue(current(saved, slot), slot.after) && sameValue(current(draft, slot), slot.before)))
    return {state: 'filled', roles};
  for (const slot of slots) {
    const where = `${name(slot.role)}${slot.list ? (slot.role === 'senior' ? ' 시니어 목록' : ' 대체 후보') : ''}`;
    if (!sameValue(current(saved, slot), slot.after))
      return {state: 'blocked', reason: `그 뒤에 ${where} 칸이 또 바뀌어 이전 값으로 돌릴 수 없습니다`};
    if (!sameValue(current(draft, slot), current(saved, slot)))
      return {state: 'blocked', reason: `${where} 칸을 이미 고치는 중입니다(저장 전)`};
    if (!slot.list && slot.before === null && !OPTIONAL_ROLES.includes(slot.role))
      return {state: 'blocked', reason: `${name(slot.role)} 자리는 비울 수 없습니다`};
    const items = (Array.isArray(slot.before) ? slot.before : slot.before ? [slot.before] : []) as Choice[];
    for (const item of items) {
      const spec = data.catalog[item.runner];
      if (!spec || !spec.models.some(m => m.model === item.model))
        return {state: 'blocked', reason: `${where}의 이전 값(${item.runner} / ${item.model})은 지금 이 기계에서 고를 수 없습니다`};
      const hit = (saved.blocked ?? []).find(b => b.model === item.model && (!b.roles || b.roles.includes(slot.role)));
      if (hit) return {state: 'blocked', reason: `이전 값의 모델 ${item.model}은(는) 지금 차단돼 되돌릴 수 없습니다(${hit.reason})`};
    }
  }
  const apply = (base: Settings): Settings => {
    const next = structuredClone(base), preset = next.presets[next.activePreset];
    for (const slot of slots) {
      if (slot.list) {
        const list = (slot.before ?? []) as Choice[];
        const rest = {...preset.fallback};
        if (emptyList(slot.before) || !list.length) delete rest[slot.role]; else rest[slot.role] = structuredClone(list);
        if (Object.keys(rest).length) preset.fallback = rest; else delete preset.fallback;
      } else if (slot.before === null) delete preset.roles[slot.role];
      else preset.roles[slot.role] = structuredClone(slot.before) as Choice | Choice[];
    }
    return next;
  };
  const after = apply(draft), preset = after.presets[after.activePreset];
  if (preset.fallback?.[HARD_ROLE]?.length && !(preset.roles[HARD_ROLE] as Choice | undefined)?.model)
    return {state: 'blocked', reason: '어려운 일 작업자 자리가 비어 있어 대체 후보를 둘 수 없습니다'};
  const problem = effortProblems(after, roles, data.catalog)[0];
  if (problem) return {state: 'blocked', reason: `${name(problem.role)}의 이전 값은 지금 이 모델의 강도 목록으로 저장할 수 없습니다`};
  return {state: 'ready', roles, apply};
}

// 되돌리기 뒤 저장 줄의 기본 이유 문구: 'N번 변경 되돌리기'(N = 그 변경이 만든 설정 버전. 여러 개를 채웠으면 'N·M번').
export const revertReason = (events: SettingsEvent[]) => `${events.map(event => event.revision ?? '?').join('·')}번 변경 되돌리기`;

const ACTION_LABEL: Record<string, string> = {
  init: '처음 설정', set: '역할 값', fallback: '대체 후보', favorite: '즐겨찾기', preset: '프리셋 전환', 'preset-add': '프리셋 추가',
  'preset-rename': '프리셋 이름 바꾸기', 'preset-remove': '프리셋 삭제', 'preset-import': '프리셋 저장', block: '차단 모델',
  compare: '비교 모드', runner: '실행기 표', 'model-add': '모델 등록', 'model-remove': '모델 삭제',
};
const choiceText = (c: Choice) => [c.runner, c.model, c.effort].filter(Boolean).join(' / ');
const valueText = (value: Value, empty: string) => Array.isArray(value)
  ? (value.length ? value.map((c, i) => `${i + 1}. ${choiceText(c)}`).join('; ') : empty)
  : value ? choiceText(value) : empty;

// 표 한 줄의 글: 무엇을(프리셋 · 바뀐 칸) · 전 → 후. 역할 값·대체 후보가 아닌 변경은 종류 이름만 보이고 원문은 줄의 '원문'에서 본다.
export function describeEvent(event: SettingsEvent, roles: Record<string, string>) {
  const kind = ACTION_LABEL[event.action ?? ''] ?? event.action ?? '변경';
  const found = eventSlots(event);
  const prefix = event.preset ? `프리셋 ${event.preset} · ` : '';
  if (!('slots' in found)) return {what: `${prefix}${kind}`, change: ''};
  const label = (slot: Slot) => `${roles[slot.role] ?? slot.role}${slot.list ? (slot.role === 'senior' ? ' 목록' : ' 대체 후보') : ''}`;
  return {
    what: prefix + found.slots.map(label).join(', '),
    change: found.slots.map(slot => (found.slots.length > 1 ? `${label(slot)}: ` : '')
      + `${valueText(slot.before, '없음')} → ${valueText(slot.after, '없음')}`).join(' / '),
  };
}
