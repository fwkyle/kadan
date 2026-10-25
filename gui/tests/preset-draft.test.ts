import test from 'node:test';
import assert from 'node:assert/strict';
import {presetSaveFields, presetStamp, stagePreset} from '../src/preset-draft.ts';

test('여러 역할·폴백 편집은 로컬 변경안이고 저장 요청 하나에 전부 담긴다', () => {
  const settings = {revision: 7, activePreset: 'A', presets: {A: {roles: {
    worker: {runner: 'codex', model: 'gpt-test'}, reviewer: {runner: 'claude', model: 'claude-test'},
  }}}};
  const before = JSON.stringify(settings);
  let draft = stagePreset(settings, 'worker', false, {runner: 'claude', model: 'claude-test'}, 'add');
  draft = stagePreset(draft, 'reviewer', false, {runner: 'codex', model: 'gpt-test'}, 'add');
  draft = stagePreset(draft, 'reviewer', true, {runner: 'codex', model: 'deepseek-test'}, 'add');
  assert.equal(JSON.stringify(settings), before);
  assert.equal(draft.revision, 7);
  const request = presetSaveFields(draft, '한 번 저장');
  assert.equal(request.revision, '7');
  const payload = JSON.parse(request.value);
  assert.equal(payload.roles.worker.model, 'claude-test');
  assert.equal(payload.roles.reviewer.model, 'gpt-test');
  assert.equal(payload.fallback.reviewer[0].model, 'deepseek-test');
  assert.notEqual(presetStamp(draft), presetStamp(settings));
  assert.equal(presetStamp({...settings, revision: 8}), presetStamp(settings));
  assert.notEqual(presetStamp({...settings, activePreset: 'B'}), presetStamp(settings));
});

test('후보 추가·순서·삭제는 서버 저장 없이 같은 변경안에서 처리한다', () => {
  let draft = {revision: 1, activePreset: 'A', presets: {A: {roles: {}}}};
  const a = {runner: 'codex', model: 'a'}, b = {runner: 'codex', model: 'b'};
  draft = stagePreset(draft, 'worker', true, a, 'add');
  draft = stagePreset(draft, 'worker', true, b, 'add');
  draft = stagePreset(draft, 'worker', true, b, 'up:2');
  draft = stagePreset(draft, 'worker', true, b, 'remove:2');
  const value = JSON.parse(presetSaveFields(draft, '시험').value);
  assert.deepEqual(value.fallback.worker, [b]);
});
