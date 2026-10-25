import test from 'node:test';
import assert from 'node:assert/strict';
import {pickCopySource, presetSaveFields, presetStamp, stagePreset} from '../src/preset-draft.ts';

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

test('복사 원본: 이름 바꾸기·삭제로 고른 이름이 사라지면 표시와 제출이 같은 유효한 이름으로 맞춰진다', () => {
  assert.equal(pickCopySource(['A', 'B'], 'A', 'A'), 'A');
  // 검수 재현: 활성 A를 AA로 바꾸면 처음 고른 A가 사라지고 활성 AA가 원본이 된다(옛 값 A를 보내면 409였다).
  assert.equal(pickCopySource(['AA', 'B'], 'AA', 'A'), 'AA');
  // 고른 B를 삭제한 뒤에도 활성 프리셋으로 맞춘다.
  assert.equal(pickCopySource(['AA'], 'AA', 'B'), 'AA');
  // 사용자가 목록에 남은 다른 이름을 고른 것은 존중한다.
  assert.equal(pickCopySource(['AA', 'B'], 'AA', 'B'), 'B');
  assert.equal(pickCopySource(['X', 'Y'], 'gone', 'gone2'), 'X');
});
