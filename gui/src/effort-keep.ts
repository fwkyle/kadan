import type {Choice} from './pages/Runners';

// 바꾸기 창에서 모델·실행기를 바꿀 때 강도를 어떻게 이어 가는가.
// 옛 규칙은 모델을 바꾸면 그 모델의 첫 강도(보통 low)로 조용히 떨어졌다(2026-11-18: 검수자가 high에서 low로 저장됨).
// 이제는 지금 강도를 그 모델이 지원할 때만 유지하고, 아니면 비워 두어 사람이 고르게 한다.
type Spec = {needsEffort: boolean; models: {model: string; efforts: string[]}[]} | undefined;

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

// 강도를 받는 실행기에서 그 모델이 강도 목록을 갖는데 고르지 않았다 — 저장·추가 전에 막는다.
export const needsEffortPick = (spec: Spec, choice: Choice) =>
  Boolean(spec?.needsEffort && choice.model && effortsOf(spec, choice.model).length > 0 && !choice.effort);

export const sameChoice = (a: Choice, b: Choice) =>
  a.runner === b.runner && a.model === b.model && (a.effort || '') === (b.effort || '');
