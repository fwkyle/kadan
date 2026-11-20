import test from 'node:test';
import assert from 'node:assert/strict';
import {clearPreset, pickCopySource, presetSaveFields, presetStamp, reasonFor, stagePreset} from '../src/preset-draft.ts';
import {changedRoles, emptyModelRoles} from '../src/runner-draft.ts';

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

test('모델을 안 고른 초안: 실행기만 바꾼 역할을 짚고, 모델을 고르면 풀린다. 목록 역할·비어 있는 자리는 해당 없음', () => {
  const settings = {revision: 1, activePreset: 'A', presets: {A: {roles: {
    worker: {runner: 'codex', model: 'gpt-test'}, senior: [{runner: 'codex', model: 'gpt-s'}],
  }}}};
  const roles = ['worker', 'worker-hard', 'reviewer', 'senior'];
  assert.deepEqual(emptyModelRoles(settings, roles), [], '저장된 값은 모두 모델이 있다');
  const unpicked = stagePreset(settings, 'worker', false, {runner: 'claude', model: '', effort: ''}, 'add');
  assert.deepEqual(emptyModelRoles(unpicked, roles), ['worker']);
  const newRole = stagePreset(settings, 'reviewer', false, {runner: 'claude', model: ''}, 'add');
  assert.deepEqual(emptyModelRoles(newRole, roles), ['reviewer'], '없던 자리에 실행기만 고른 것도 막는다');
  const picked = stagePreset(unpicked, 'worker', false, {runner: 'claude', model: 'claude-test', effort: 'low'}, 'add');
  assert.deepEqual(emptyModelRoles(picked, roles), []);
  assert.deepEqual(emptyModelRoles(clearPreset({...settings, presets: {A: {roles: {'worker-hard': {runner: 'codex', model: 'x'}}}}}, 'worker-hard'), roles), [], '비운 자리는 모델 빈 값이 아니다');
});

// 줄 고치기(2026-11-20): 대체 후보 번호는 `kadan start --fallback N`이 가리킨다. 고친 줄은 같은 번호 자리에 남아야 한다.
const three = () => ({revision: 3, activePreset: 'A', presets: {A: {
  roles: {reviewer: {runner: 'codex', model: 'r'}, senior: [{runner: 'codex', model: 's1', effort: 'high'}, {runner: 'agy', model: 's2'}]},
  fallback: {reviewer: [{runner: 'codex', model: 'a', effort: 'high'}, {runner: 'codex', model: 'b', effort: 'high'}, {runner: 'codex', model: 'c'}]},
}}});

test('재현: 고치기를 삭제+추가로 하면 고친 줄이 맨 뒤로 밀려 2·3번이 가리키는 값이 바뀐다', () => {
  let draft = stagePreset(three(), 'reviewer', true, {runner: 'codex', model: 'b'}, 'remove:2');
  draft = stagePreset(draft, 'reviewer', true, {runner: 'codex', model: 'b2', effort: 'low'}, 'add');
  assert.deepEqual(draft.presets.A.fallback.reviewer.map(item => item.model), ['a', 'c', 'b2'], '2번이 c로 바뀌었다');
});

test('줄 고치기(replace:N): 같은 번호 자리의 값만 바뀌고 앞뒤 줄·순서·다른 역할은 그대로다', () => {
  const settings = three(), before = JSON.stringify(settings);
  const draft = stagePreset(settings, 'reviewer', true, {runner: 'codex', model: 'b2', effort: 'low'}, 'replace:2');
  assert.equal(JSON.stringify(settings), before, '원본은 건드리지 않는다');
  assert.deepEqual(draft.presets.A.fallback.reviewer, [
    {runner: 'codex', model: 'a', effort: 'high'}, {runner: 'codex', model: 'b2', effort: 'low'}, {runner: 'codex', model: 'c'}]);
  assert.deepEqual(draft.presets.A.roles, settings.presets.A.roles);
  assert.deepEqual(changedRoles(settings, draft, ['reviewer', 'senior']), ['reviewer']);
  // 강도를 받지 않는 값으로 바꾸면 빈 강도 칸을 남기지 않는다.
  const noEffort = stagePreset(settings, 'reviewer', true, {runner: 'agy', model: 'g', effort: ''}, 'replace:1');
  assert.deepEqual(noEffort.presets.A.fallback.reviewer[0], {runner: 'agy', model: 'g'});
  // 저장 요청은 프리셋 한 벌 하나다(쓰기 한 번).
  assert.deepEqual(JSON.parse(presetSaveFields(draft, '시험').value).fallback.reviewer.map((item: {model: string}) => item.model), ['a', 'b2', 'c']);
});

test('줄 고치기: 시니어 목록도 같은 조작으로 고치고(가득 찬 2명에서도), 없는 번호는 거절한다', () => {
  const draft = stagePreset(three(), 'senior', true, {runner: 'agy', model: 's2b', effort: ''}, 'replace:2');
  assert.deepEqual(draft.presets.A.roles.senior, [{runner: 'codex', model: 's1', effort: 'high'}, {runner: 'agy', model: 's2b'}]);
  for (const op of ['replace:0', 'replace:3', 'replace:x', 'replace'])
    assert.throws(() => stagePreset(three(), 'senior', true, {runner: 'agy', model: 'z'}, op), /없는 후보 번호/);
  assert.throws(() => stagePreset(three(), 'reviewer', true, {runner: 'agy', model: 'z'}, 'replace:4'), /없는 후보 번호/);
});
