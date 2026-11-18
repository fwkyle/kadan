import test from 'node:test';
import assert from 'node:assert/strict';
import {afterModelChange, afterRunnerChange, keepEffort, needsEffortPick, sameChoice} from '../src/effort-keep.ts';
import {modelAddFields, registerModel, registeredChoice} from '../src/model-register.ts';
import {presetSaveFields, presetStamp, stagePreset, withRegistered} from '../src/preset-draft.ts';
import {changedRoles, missingEffortRoles} from '../src/runner-draft.ts';

const levels = ['low', 'medium', 'high'];
const catalog = {
  agy: {needsEffort: true, models: [
    {model: 'm-old', efforts: levels}, {model: 'm-hi', efforts: ['medium', 'high']}, {model: 'm-lo', efforts: ['low']},
    {model: 'm-none', efforts: []},
  ]},
  claude: {needsEffort: true, models: [{model: 'm-old', efforts: ['low', 'high']}, {model: 'c-x', efforts: ['max']}]},
  plain: {needsEffort: false, models: [{model: 'p-1', efforts: []}]},
};

test('재현: 옛 규칙은 모델을 바꾸면 지금 강도(high)를 버리고 첫 강도(low)로 떨어졌다', () => {
  // 옛 RunnerForm: effort = spec.needsEffort ? spec.models.find(m => m.model === 고른모델)?.efforts[0] || '' : ''
  const old = (model: string) => catalog.agy.needsEffort ? catalog.agy.models.find(m => m.model === model)?.efforts[0] || '' : '';
  assert.equal(old('m-old'), 'low', '지금 값이 high여도 low로 저장되던 원인');
  // 새 규칙: 같은 입력에서 high를 유지한다.
  assert.equal(afterModelChange(catalog.agy, {runner: 'agy', model: 'm-lo', effort: 'high'}, 'm-old').effort, 'high');
});

test('모델만 바꿔도 지금 강도를 유지하고, 지원하지 않으면 비운다(첫 값으로 떨어지지 않음)', () => {
  const now = {runner: 'agy', model: 'm-old', effort: 'high'};
  assert.deepEqual(afterModelChange(catalog.agy, now, 'm-hi'), {runner: 'agy', model: 'm-hi', effort: 'high'});
  assert.deepEqual(afterModelChange(catalog.agy, now, 'm-lo'), {runner: 'agy', model: 'm-lo', effort: ''});
  assert.equal(afterModelChange(catalog.agy, {...now, effort: ''}, 'm-hi').effort, '', '지금 강도가 없으면 첫 값으로 채우지 않는다');
  assert.equal(afterModelChange(catalog.plain, {runner: 'plain', model: 'p-1', effort: 'high'}, 'p-1').effort, '', '강도를 안 받는 실행기');
  assert.equal(keepEffort(undefined, 'x', 'high'), '');
});

test('실행기를 바꿀 때도 같은 원칙: 같은 모델·강도가 있으면 유지, 없으면 비우고 고르게', () => {
  const now = {runner: 'agy', model: 'm-old', effort: 'high'};
  assert.deepEqual(afterRunnerChange(catalog, now, 'claude'), {runner: 'claude', model: 'm-old', effort: 'high'});
  assert.deepEqual(afterRunnerChange(catalog, {...now, model: 'm-hi'}, 'claude'), {runner: 'claude', model: '', effort: ''});
  assert.deepEqual(afterRunnerChange(catalog, {...now, effort: 'medium'}, 'claude'), {runner: 'claude', model: 'm-old', effort: ''});
  assert.deepEqual(afterRunnerChange(catalog, now, 'plain'), {runner: 'plain', model: '', effort: ''});
});

test('강도를 비운 채 저장·후보 추가를 막는 조건과 같은 값 판정', () => {
  assert.equal(needsEffortPick(catalog.agy, {runner: 'agy', model: 'm-lo', effort: ''}), true);
  assert.equal(needsEffortPick(catalog.agy, {runner: 'agy', model: 'm-lo', effort: 'low'}), false);
  assert.equal(needsEffortPick(catalog.agy, {runner: 'agy', model: 'm-none', effort: ''}), false, '강도 목록이 없는 모델은 고를 것이 없다');
  assert.equal(needsEffortPick(catalog.plain, {runner: 'plain', model: 'p-1', effort: ''}), false);
  assert.equal(needsEffortPick(catalog.agy, {runner: 'agy', model: '', effort: ''}), false, '모델 미선택은 따로 막는다');
  assert.equal(sameChoice({runner: 'a', model: 'm'}, {runner: 'a', model: 'm', effort: ''}), true);
  assert.equal(sameChoice({runner: 'a', model: 'm', effort: 'high'}, {runner: 'a', model: 'm'}), false);
});

const settings = {revision: 5, activePreset: 'A', presets: {A: {roles: {
  worker: {runner: 'agy', model: 'm-old', effort: 'high'}, reviewer: {runner: 'agy', model: 'm-old', effort: 'high'},
}}}};
const roles = ['worker', 'reviewer'];

test('지금 값과 같은 선택은 변경안이 아니다(저장 줄이 안 생긴다), 모델만 바꿔 강도가 비면 저장이 막힌다', () => {
  const same = stagePreset(settings, 'reviewer', false, {runner: 'agy', model: 'm-old', effort: 'high'}, 'add');
  assert.equal(presetStamp(same), presetStamp(settings));
  assert.deepEqual(changedRoles(settings, same, roles), []);
  const lo = stagePreset(settings, 'reviewer', false, afterModelChange(catalog.agy, settings.presets.A.roles.reviewer, 'm-lo'), 'add');
  assert.deepEqual(changedRoles(settings, lo, roles), ['reviewer']);
  assert.deepEqual(missingEffortRoles(lo, changedRoles(settings, lo, roles), catalog), ['reviewer']);
  const hi = stagePreset(settings, 'reviewer', false, afterModelChange(catalog.agy, settings.presets.A.roles.reviewer, 'm-hi'), 'add');
  assert.deepEqual(missingEffortRoles(hi, changedRoles(settings, hi, roles), catalog), [], '지원하는 강도는 그대로 저장된다');
  assert.equal(JSON.parse(presetSaveFields(hi, '시험').value).roles.reviewer.effort, 'high');
});

test('새 모델 등록: 지금 강도를 새 모델이 지원하면 유지, 아니면 비운다', () => {
  assert.deepEqual(registeredChoice('agy', ' m-new ', 'low, high', true, 'high'), {runner: 'agy', model: 'm-new', effort: 'high'});
  assert.equal(registeredChoice('agy', 'm-new', 'low,medium', true, 'high').effort, '');
  assert.equal(registeredChoice('agy', 'm-new', '', true, 'high').effort, '');
  assert.equal(registeredChoice('plain', 'p-2', 'low', false, 'low').effort, '');
  const fields = modelAddFields('agy', ' m-new ', ' low,high ', 7);
  assert.deepEqual([fields.runner, fields.model, fields.efforts, fields.revision], ['agy', 'm-new', 'low,high', '7']);
  assert.match(fields.reason, /새 모델 등록/);
});

test('등록 성공: 새 버전과 고른 선택을 알린다. 등록 실패: 알리지 않으므로 변경안은 그대로다', async () => {
  const calls: unknown[][] = [], seen: unknown[][] = [];
  const ok = async (action: string, fields: Record<string, string>) => { calls.push([action, fields.revision]); return {result: {revision: 8}}; };
  const choice = await registerModel(ok, 't', {runner: 'agy', model: 'm-new', efforts: 'low,high', revision: 7, needsEffort: true, currentEffort: 'high'},
    (c, r) => seen.push([c, r]));
  assert.deepEqual(calls, [['/runners/model-add', '7']]);
  assert.deepEqual(seen, [[choice, 8]]);
  assert.equal(choice.effort, 'high');
  const failing = async () => { throw new Error('정책으로 막은 모델: m-bad'); };
  seen.length = 0;
  await assert.rejects(registerModel(failing, 't', {runner: 'agy', model: 'm-bad', efforts: '', revision: 8, needsEffort: true}, (c, r) => seen.push([c, r])),
    /정책으로 막은 모델/);
  assert.deepEqual(seen, []);
});

test('등록 뒤에도 이미 고친 다른 줄·대체 후보가 남고, 저장 요청은 새 버전으로 간다', () => {
  let draft = stagePreset(settings, 'worker', false, {runner: 'agy', model: 'm-hi', effort: 'high'}, 'add');
  draft = stagePreset(draft, 'worker', true, {runner: 'agy', model: 'm-lo', effort: 'low'}, 'add');
  const added = withRegistered(draft, 'reviewer', false, {runner: 'agy', model: 'm-new', effort: 'high'}, 6);
  assert.equal(added.revision, 6);
  const value = JSON.parse(presetSaveFields(added, '시험').value);
  assert.equal(value.roles.worker.model, 'm-hi', '앞서 고친 다른 줄이 남는다');
  assert.equal(value.fallback.worker[0].model, 'm-lo', '앞서 추가한 대체 후보가 남는다');
  assert.equal(value.roles.reviewer.model, 'm-new', '등록한 모델이 선택돼 있다');
  assert.equal(presetSaveFields(added, '시험').revision, '6');
  assert.equal(draft.revision, 5, '원래 변경안은 바뀌지 않는다');
  // 대체 후보 칸에서 등록하면 버전만 올리고 후보 목록은 '추가'를 눌러야 반영된다.
  const fb = withRegistered(draft, 'reviewer', true, {runner: 'agy', model: 'm-new'}, 6);
  assert.equal(fb.revision, 6);
  assert.equal(fb.presets.A.fallback?.reviewer, undefined);
  assert.equal(presetStamp(fb), presetStamp(draft), '버전만 바뀌면 변경안 지문은 같다');
});
