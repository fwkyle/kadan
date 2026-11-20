import type {Choice} from './pages/Runners';

// 바꾸기 창에서 모델·실행기를 바꿀 때 강도를 어떻게 이어 가는가.
// 옛 규칙은 모델을 바꾸면 그 모델의 첫 강도(보통 low)로 조용히 떨어졌다(2026-11-18: 검수자가 high에서 low로 저장됨).
// 이제는 지금 강도를 그 모델이 지원할 때만 유지하고, 아니면 비워 두어 사람이 고르게 한다.
type Spec = {needsEffort: boolean; table?: Record<string, string>; models: {model: string; efforts: string[]}[]} | undefined;

// 이 역할에서 강도가 필요한가 — 서버 checkChoice와 같다: 설명 AI는 한 번 호출(exec) 틀, 그 밖은 실행 틀(spawn)에 {effort}가 있으면 필요하다.
export const effortNeeded = (spec: Spec, role: string) =>
  role === 'explain' ? Boolean(spec?.table?.exec?.includes('{effort}')) : Boolean(spec?.needsEffort);

// 그 역할 기준으로 needsEffort를 맞춘 실행기 정보. 아래 판정 함수에 이것을 넘긴다.
export const forRole = <T extends NonNullable<Spec>>(spec: T | undefined, role: string): T | undefined =>
  spec && {...spec, needsEffort: effortNeeded(spec, role)};

export const effortsOf = (spec: Spec, model: string) => spec?.models.find(m => m.model === model)?.efforts ?? [];

// 강도를 받는 실행기에서 그 모델이 지원하는 강도일 때만 유지한다.
export const keepEffort = (spec: Spec, model: string, effort: string | undefined) =>
  spec?.needsEffort && effort && effortsOf(spec, model).includes(effort) ? effort : '';

// 같은 실행기 안에서 모델만 바꿨을 때.
export const afterModelChange = (spec: Spec, choice: Choice, model: string): Choice =>
  ({...choice, model, effort: keepEffort(spec, model, choice.effort)});

// 실행기를 바꿨을 때: 새 실행기에 같은 모델이 있으면 모델을 유지하고, 강도도 지원할 때만 유지한다. 없으면 비운다.
export const afterRunnerChange = (catalog: Record<string, NonNullable<Spec>>, choice: Choice, runner: string): Choice => {
  const spec = catalog[runner];
  const model = spec?.models.some(m => m.model === choice.model) ? choice.model : '';
  return {runner, model, effort: model ? keepEffort(spec, model, choice.effort) : ''};
};

// 강도를 받는 실행기에서 고른 모델이 강도 목록을 갖는데 고르지 않았다 — 저장·추가 전에 막는다.
export const needsEffortPick = (spec: Spec, choice: Choice) =>
  Boolean(spec?.needsEffort && choice.model && effortsOf(spec, choice.model).length > 0 && !choice.effort);

// 강도가 필요한 실행기인데 고른 모델의 강도 목록이 비어 있다 — 서버가 어떤 값으로도 거절하므로 화면에서 고칠 수 없고,
// 고급 설정의 실행기 표에서 강도를 등록해야 한다. 목록에 없는 모델은 따로 다룬다(서버: 고를 수 없는 모델).
export const emptyEffortList = (spec: Spec, choice: Choice) =>
  Boolean(spec?.needsEffort && choice.model && spec.models.some(m => m.model === choice.model) && effortsOf(spec, choice.model).length === 0);

export const effortProblem = (spec: Spec, choice: Choice): 'empty' | 'pick' | null =>
  emptyEffortList(spec, choice) ? 'empty' : needsEffortPick(spec, choice) ? 'pick' : null;

export const EMPTY_EFFORT_NOTE =
  '이 모델은 강도 목록이 비어 있어 이 실행기에서 저장할 수 없습니다 — 고급 설정의 실행기 표에서 강도를 등록하세요';

// 강도를 받지 않는 실행기(agy 등)에서 강도 칸 자리에 보이는 안내. 강도는 모델 이름이 정하고 카단은 이름에서 강도를 뽑아내지 않는다
// (2026-11-19 [kyle], 서버 EFFORT_FROM_MODEL_LABEL '강도 모델 이름 따름'과 같은 뜻). 강도가 없는 모델에도 거짓이 되지 않게 적는다.
export const NO_EFFORT_NOTE =
  '추론 강도 칸 없음 — 이 실행기는 강도를 따로 받지 않습니다. 강도는 모델 이름에 포함됩니다(강도가 나뉘는 모델은 이름 끝의 -low · -high 등으로 고릅니다)';

// 대체 후보·시니어 목록에 넣거나 N번 줄을 고칠 때 막을 이유(없으면 null). 서버 검사와 같은 기준이다:
// 대체 후보는 실행기·모델·강도가 모두 같은 줄(setFallback·가져오기), 시니어는 강도가 달라도 실행기·모델이 같은 줄(assertSeniorShape).
// editing은 고치는 줄의 자리(0부터)다. 그 줄 자신은 중복으로 세지 않고, 값이 그대로면 바뀐 것이 없다고 알린다.
export function listProblem(list: Choice[], choice: Choice, {senior = false, editing = null, current = null}:
  {senior?: boolean; editing?: number | null; current?: Choice | null} = {}) {
  if (!choice.model) return null;
  if (editing !== null && list[editing] && sameChoice(list[editing], choice)) return '이 줄의 지금 값과 같습니다. 바꿀 값을 고르세요.';
  const others = list.filter((_, i) => i !== editing);
  if (senior) return others.some(item => item.runner === choice.runner && item.model === choice.model)
    ? '이미 등록된 시니어입니다(실행기와 모델이 같으면 강도가 달라도 함께 둘 수 없습니다).' : null;
  if (others.some(item => sameChoice(item, choice))) return '이미 대체 후보에 있는 값입니다.';
  return current && sameChoice(current, choice) ? '지금 값과 같아 대체 후보로 둘 수 없습니다.' : null;
}

export const sameChoice = (a: Choice, b: Choice) =>
  a.runner === b.runner && a.model === b.model && (a.effort || '') === (b.effort || '');
