import test from 'node:test';
import assert from 'node:assert/strict';
import {describeEvent, eventSlots, planRevert, revertReason, sameValue, type SettingsEvent} from '../src/revert.ts';
import type {Choice, Settings} from '../src/pages/Runners';

// 최근 변경의 '되돌리기': 그 변경이 바꾼 칸만, 지금 값 위에, 변경안(저장 전)에 채운다.
const c = (model: string, effort?: string): Choice => ({runner: 'codex', model, ...(effort ? {effort} : {})});
const catalog = {
  codex: {spawn: 'codex -m {model} -c effort={effort}', needsEffort: true,
    models: ['sol', 'astra', 'old', 'flash'].map(model => ({model, efforts: ['low', 'medium', 'high']}))},
  agy: {spawn: 'agy --model {model}', needsEffort: false, models: [{model: 'gemini', efforts: []}]},
};
const roles = {worker: '작업자', reviewer: '검수자', super: '슈퍼감독', senior: '시니어', 'worker-hard': '어려운 일 작업자'};
const data = {catalog, roles};
const base = (over: Partial<Settings['presets'][string]> = {}, rest: Partial<Settings> = {}): Settings => ({
  revision: 9, activePreset: 'B', blocked: [],
  presets: {B: {roles: {worker: c('sol', 'high'), reviewer: c('astra', 'high'), super: c('sol', 'low')},
    fallback: {reviewer: [c('flash', 'low'), c('old', 'low')]}, ...over}},
  ...rest,
});
const planOf = (event: SettingsEvent, saved: Settings, draft = saved) => planRevert(event, saved, draft, data);
const ready = (plan: ReturnType<typeof planOf>) => {
  assert.equal(plan.state, 'ready', JSON.stringify(plan));
  return plan as Extract<typeof plan, {state: 'ready'}>;
};
const reason = (plan: ReturnType<typeof planOf>) => (plan as {reason: string}).reason;

test('역할 값 변경(set): 그 칸만 이전 값으로 채우고 다른 칸·대체 후보·다른 역할은 그대로', () => {
  const saved = base();
  const event: SettingsEvent = {action: 'set', preset: 'B', role: 'worker', revision: 9, before: c('old', 'low'), after: c('sol', 'high')};
  const plan = ready(planOf(event, saved));
  assert.deepEqual(plan.roles, ['worker']);
  const next = plan.apply(saved);
  assert.deepEqual(next.presets.B.roles, {...saved.presets.B.roles, worker: c('old', 'low')});
  assert.deepEqual(next.presets.B.fallback, saved.presets.B.fallback);
  assert.equal(next.revision, saved.revision, '저장 전 변경안일 뿐 버전은 그대로');
  assert.deepEqual(saved.presets.B.roles.worker, c('sol', 'high'), '원본은 바뀌지 않는다');
});

test('프리셋 통째 before/after(화면 저장): 둘의 차이로 바뀐 칸만 쓴다 — 그 뒤의 무관한 변경은 사라지지 않는다', () => {
  const before = {label: 'B', roles: {worker: c('old', 'low'), reviewer: c('astra', 'high'), super: c('sol', 'low')}};
  const after = {label: 'B', roles: {worker: c('sol', 'high'), reviewer: c('astra', 'high'), super: c('sol', 'low')}};
  const event: SettingsEvent = {action: 'preset-import', preset: 'B', revision: 7, before, after};
  assert.deepEqual((eventSlots(event) as {slots: unknown[]}).slots.length, 1, '바뀐 칸은 작업자 하나');
  // 그 사건 뒤에 검수자가 또 바뀌었다(무관한 변경): 지금 저장 값은 worker는 after 그대로, reviewer는 달라졌다.
  const saved = base({roles: {worker: c('sol', 'high'), reviewer: c('flash', 'medium'), super: c('sol', 'low')}, fallback: undefined});
  const plan = ready(planOf(event, saved));
  const next = plan.apply(saved);
  assert.deepEqual(next.presets.B.roles.worker, c('old', 'low'));
  assert.deepEqual(next.presets.B.roles.reviewer, c('flash', 'medium'), '옛 통째 값으로 덮지 않는다');
});

test('한 번 저장으로 여러 칸을 바꿨으면 그 칸들만 함께 채운다(값 칸과 대체 후보 칸)', () => {
  const before = {roles: {worker: c('old', 'low'), reviewer: c('astra', 'high')}, fallback: {reviewer: [c('flash', 'low')]}};
  const after = {roles: {worker: c('sol', 'high'), reviewer: c('astra', 'high')}, fallback: {reviewer: [c('flash', 'low'), c('old', 'low')]}};
  const saved = base({roles: after.roles, fallback: after.fallback});
  const plan = ready(planOf({action: 'preset-import', preset: 'B', revision: 5, before, after}, saved));
  assert.deepEqual(plan.roles.sort(), ['reviewer', 'worker']);
  const next = plan.apply(saved);
  assert.deepEqual(next.presets.B.roles.worker, c('old', 'low'));
  assert.deepEqual(next.presets.B.fallback, {reviewer: [c('flash', 'low')]});
});

test('그 칸이 그 변경 뒤에 또 바뀌었으면 끄고 이유를 보인다', () => {
  const event: SettingsEvent = {action: 'set', preset: 'B', role: 'worker', revision: 4, before: c('old', 'low'), after: c('astra', 'high')};
  const plan = planOf(event, base());
  assert.equal(plan.state, 'blocked');
  assert.match(reason(plan), /작업자.*또 바뀌어/);
});

test('대체 후보 목록의 길이나 순서가 달라졌으면 옛 변경은 끈다', () => {
  const event: SettingsEvent = {action: 'fallback', preset: 'B', role: 'reviewer', revision: 3,
    before: [c('flash', 'low')], after: [c('flash', 'low'), c('old', 'low')]};
  ready(planOf(event, base()));
  const reordered = base({fallback: {reviewer: [c('old', 'low'), c('flash', 'low')]}});
  assert.match(reason(planOf(event, reordered)), /대체 후보.*또 바뀌어/);
  const shorter = base({fallback: {reviewer: [c('flash', 'low')]}});
  assert.equal(planOf(event, shorter).state, 'blocked');
});

test('이전 값이 지금 차단된 모델이거나 이 기계에 없거나 강도를 못 받으면 끈다', () => {
  const event: SettingsEvent = {action: 'set', preset: 'B', role: 'worker', revision: 4, before: c('old', 'low'), after: c('sol', 'high')};
  const blockedAll = base({}, {blocked: [{model: 'old', reason: '정책 차단'}]});
  assert.match(reason(planOf(event, blockedAll)), /차단/);
  const blockedOther = base({}, {blocked: [{model: 'old', roles: ['reviewer'], reason: '검수자만 차단'}]});
  ready(planOf(event, blockedOther));
  const missing: SettingsEvent = {...event, before: c('gone', 'low')};
  assert.match(reason(planOf(missing, base())), /고를 수 없습니다/);
  const badEffort: SettingsEvent = {...event, before: {runner: 'codex', model: 'old'}};
  assert.match(reason(planOf(badEffort, base())), /강도/);
});

test('다른 프리셋의 변경과 역할 값이 아닌 변경(즐겨찾기·프리셋 전환)은 끈다', () => {
  const other: SettingsEvent = {action: 'set', preset: 'C', role: 'worker', revision: 4, before: c('old', 'low'), after: c('sol', 'high')};
  assert.match(reason(planOf(other, base())), /다른 프리셋\(C\)/);
  for (const action of ['favorite', 'preset', 'block', 'init', 'preset-rename'])
    assert.match(reason(planOf({action, revision: 2, before: [], after: []}, base())), /역할 값·대체 후보가 아닌 변경/);
  const labelOnly: SettingsEvent = {action: 'preset-import', preset: 'B', revision: 6, before: {label: 'a', roles: {}}, after: {label: 'b', roles: {}}};
  assert.match(reason(planOf(labelOnly, base())), /되돌릴 역할 칸이 없습니다/);
  assert.match(reason(planOf({action: 'preset-import', preset: 'B', revision: 6, before: null, after: {roles: {}}}, base())), /새로 만든/);
});

test('이미 그 칸을 고치는 중(저장 전)이면 끄고, 채운 뒤에는 채움 상태가 된다', () => {
  const saved = base();
  const event: SettingsEvent = {action: 'set', preset: 'B', role: 'worker', revision: 9, before: c('old', 'low'), after: c('sol', 'high')};
  const editing = base({roles: {...saved.presets.B.roles, worker: c('astra', 'low')}});
  assert.match(reason(planOf(event, saved, editing)), /이미 고치는 중/);
  const filled = ready(planOf(event, saved)).apply(saved);
  assert.equal(planOf(event, saved, filled).state, 'filled');
  // 채운 뒤에도 다른 칸의 변경은 따로 되돌릴 수 있다
  const second: SettingsEvent = {action: 'set', preset: 'B', role: 'super', revision: 8, before: c('astra', 'medium'), after: c('sol', 'low')};
  assert.equal(planOf(second, saved, filled).state, 'ready');
});

test('시니어 목록과 어려운 일 작업자 비우기도 칸 단위로 되돌린다', () => {
  const seniorSaved = base({roles: {worker: c('sol', 'high'), senior: [c('sol'), c('astra')]}});
  const seniorEvent: SettingsEvent = {action: 'set', preset: 'B', role: 'senior', revision: 8, before: [c('sol')], after: [c('sol'), c('astra')]};
  const seniors = ready(planOf(seniorEvent, seniorSaved)).apply(seniorSaved);
  assert.deepEqual(seniors.presets.B.roles.senior, [c('sol')]);
  // 어려운 일 작업자를 비운 변경(대체 후보도 함께 지웠다)을 되돌리면 값과 대체 후보가 함께 돌아온다
  const hardSaved = base({roles: {worker: c('sol', 'high')}, fallback: undefined});
  const clearEvent: SettingsEvent = {action: 'set', preset: 'B', role: 'worker-hard', revision: 8,
    before: c('astra', 'high'), after: null, fallbackBefore: [c('flash', 'low')]};
  const hard = ready(planOf(clearEvent, hardSaved)).apply(hardSaved);
  assert.deepEqual(hard.presets.B.roles['worker-hard'], c('astra', 'high'));
  assert.deepEqual(hard.presets.B.fallback, {'worker-hard': [c('flash', 'low')]});
  // 값이 비어 있어서 대체 후보만 돌아오는 경우는 서버가 거절하므로 막는다
  const fbOnly: SettingsEvent = {action: 'fallback', preset: 'B', role: 'worker-hard', revision: 7, before: [c('flash', 'low')], after: []};
  assert.match(reason(planOf(fbOnly, hardSaved)), /어려운 일 작업자 자리가 비어/);
});

test('줄 글과 기본 저장 이유', () => {
  const event: SettingsEvent = {action: 'set', preset: 'B', role: 'reviewer', revision: 11, before: c('astra', 'high'), after: c('sol', 'high')};
  assert.deepEqual(describeEvent(event, roles), {what: '프리셋 B · 검수자', change: 'codex / astra / high → codex / sol / high'});
  const list: SettingsEvent = {action: 'fallback', preset: 'B', role: 'reviewer', revision: 12, before: [], after: [c('flash', 'low')]};
  assert.deepEqual(describeEvent(list, roles), {what: '프리셋 B · 검수자 대체 후보', change: '없음 → 1. codex / flash / low'});
  assert.deepEqual(describeEvent({action: 'favorite', revision: 3}, roles), {what: '즐겨찾기', change: ''});
  assert.deepEqual(describeEvent({action: 'compare', revision: 4}, roles), {what: '비교 모드', change: ''});
  assert.equal(revertReason([event]), '11번 변경 되돌리기');
  assert.equal(revertReason([event, list]), '11·12번 변경 되돌리기');
  assert.ok(sameValue(c('a', ''), {runner: 'codex', model: 'a'}));
});
