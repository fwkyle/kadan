import test from 'node:test';
import assert from 'node:assert/strict';
import {clearPreset, pickCopySource, presetSaveFields, presetStamp, reasonFor, stagePreset} from '../src/preset-draft.ts';
import {changedRoles} from '../src/runner-draft.ts';

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

test('표에서 고친 줄만 바뀐 줄로 센다. 건드리지 않은 역할과 없던 worker-hard 키는 글자 그대로다', () => {
  const settings = {revision: 3, activePreset: 'A', presets: {A: {roles: {
    worker: {runner: 'codex', model: 'gpt-test'}, reviewer: {runner: 'codex', model: 'gpt-r', effort: 'high'},
    senior: [{runner: 'codex', model: 'gpt-s'}],
  }, fallback: {reviewer: [{runner: 'codex', model: 'fb'}]}}}};
  const roles = ['worker', 'worker-hard', 'reviewer', 'senior'];
  assert.deepEqual(changedRoles(settings, settings, roles), [], '열기만 한 것(초안 그대로)은 바뀐 줄이 없다');
  const draft = stagePreset(settings, 'worker', false, {runner: 'codex', model: 'gpt-test2', effort: 'low'}, 'add');
  assert.deepEqual(changedRoles(settings, draft, roles), ['worker']);
  const value = JSON.parse(presetSaveFields(draft, 'x').value);
  assert.equal(Object.hasOwn(value.roles, 'worker-hard'), false, '없던 어려운 일 키가 생기지 않는다');
  assert.equal(JSON.stringify(value.roles.reviewer), JSON.stringify(settings.presets.A.roles.reviewer));
  assert.equal(JSON.stringify(value.fallback), JSON.stringify(settings.presets.A.fallback));
  const more = stagePreset(stagePreset(draft, 'reviewer', true, {runner: 'codex', model: 'fb2'}, 'add'), 'senior', true, {runner: 'codex', model: 's2'}, 'add');
  assert.deepEqual(changedRoles(settings, more, roles), ['worker', 'reviewer', 'senior']);
  const hard = stagePreset(settings, 'worker-hard', false, {runner: 'codex', model: 'h'}, 'add');
  assert.deepEqual(changedRoles(settings, hard, roles), ['worker-hard']);
  assert.deepEqual(changedRoles(hard, clearPreset(hard, 'worker-hard'), roles), ['worker-hard']);
  assert.deepEqual(changedRoles(settings, clearPreset(settings, 'worker-hard'), roles), [], '이미 빈 자리를 비워도 바뀐 줄이 아니다');
  assert.equal(presetStamp(clearPreset(settings, 'worker-hard')), presetStamp(settings));
});

test('바꾸는 이유: 비우면 바꾼 역할 이름으로 채우고, 적으면 그 글 그대로 보낸다', () => {
  assert.equal(reasonFor('', ['작업자', '검수자']), '대시보드 표에서 변경: 작업자, 검수자');
  assert.equal(reasonFor('   ', ['작업자']), '대시보드 표에서 변경: 작업자');
  assert.equal(reasonFor('한도 때문에', ['작업자']), '한도 때문에');
  assert.equal(reasonFor('', []), '대시보드 표에서 변경: 실행 모델');
});
